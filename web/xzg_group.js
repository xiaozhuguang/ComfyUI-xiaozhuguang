/**
 * 小珠光编组功能 - DOM 覆盖层版（固定框体 + 可拖拽调整大小）
 * 选中节点 → Ctrl+G → 创建固定大小编组框
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { xzgT } from "./xzg_i18n.js";

const MODE_ALWAYS = 0;
const MODE_BYPASS = 4;

/** 节点拖动→编组跟随会话：一旦某编组开始跟随，本次鼠标按下到松开期间
 *  不再因自动收纳新节点 / 碰到外部节点 而中途停止跟随。
 *  会话在全局 mousedown 捕获（非编组按钮/锁按钮/面板）开始准备，
 *  任一编组首次满足"完全选中+有位移增量"时锁定，全局 mouseup/touchend 释放。
 */
const _XZG_NODE_DRAG_SESSION = {
    active: false,
    lockedGids: new Set(),
    startSelSnapshot: null, // Set<selIdStr>  锁定瞬间的选中集合快照
    startTs: 0,
    lastMovedTs: 0,
};

const XZGGroup = {
    initialized: false,
    groups: {},       // groupId → {id, title, nodeIds, bypassed, bounds, fontSize}
    groupEls: {},
    overlay: null,
    canvasMoveHideActive: false,
    fadeOutDuration: 0,
    fadeInDuration: 1000,
    _lastOffsetX: null,
    _lastOffsetY: null,
    _lastScale: null,
    _canvasMoving: false,
    _moveStopTimer: null,

    init() {
        if (this.initialized) return;
        this.initialized = true;
        this.shortcutKey = localStorage.getItem('xzg_shortcut') || 'g';
        // 编组开关面板快捷键（默认 B）
        this.toggleShortcut = this.getToggleShortcut();
        // 加载画布移动隐藏设置
        try {
            if (localStorage.getItem('xzg_group_move_hide') === 'true') {
                this.canvasMoveHideActive = true;
            }
        } catch(e) {}
        console.log('[小珠光编组] 初始化 ✓');

        this.injectStyles();
        this.createOverlay();
        this.setupKeyboardShortcut();
        this.setupCanvasMenu();

        // 节点拖动→编组跟随会话：全局 mouseup/touchend 统一结束锁定
        const resetDragSession = () => {
            const s = _XZG_NODE_DRAG_SESSION;
            if (s.active) {
                s.active = false;
                s.lockedGids.clear();
                s.startSelSnapshot = null;
                s.startTs = 0;
                s.lastMovedTs = 0;
            }
        };
        document.addEventListener('mouseup', resetDragSession, true);
        document.addEventListener('touchend', resetDragSession, true);
        document.addEventListener('touchcancel', resetDragSession, true);
        // 键盘 Esc 也结束（用户可能按 Esc 取消拖动）
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') resetDragSession();
        }, true);

        // ── 运行时注入补丁（优先执行，绕过 ES module 编译缓存导致方法丢失的问题）
        // 即便对象字面量里方法被正确加载，也安全（注入前检查 typeof === 'function'）
        this._ensureRuntimePatches();
        this.setupSerializationHooks();
        this.startSyncLoop();
        this.waitForGraph();

        // ── 实例方法 hook（防跨工作流窜流的关键） ──
        // 视角锁定功能在 app.graph 实例上覆盖了 configure 和 clear，
        // 导致原型 hook 不被调用。用 tryInjectLoop 在 app.graph 就绪后
        // 包装实例方法，确保我们的逻辑在最外层执行。
        const self = this;
        const tryHookInstance = (retry = 0) => {
            if (!app?.graph) {
                if (retry < 60) setTimeout(() => tryHookInstance(retry + 1), 100);
                return;
            }
            if (app.graph._xzgInstanceHooked) return;

            // 包装实例的 clear
            const origInstClear = app.graph.clear;
            if (origInstClear) {
                app.graph.clear = function() {
                    self._loadingNewWorkflow = true;
                    for (const gid of Object.keys(self.groups)) self.killGroup(gid);
                    self.groups = {};
                    try { localStorage.removeItem('xzg_groups_backup'); } catch(e) {}
                    try { localStorage.removeItem('xzg_deleted_groups'); } catch(e) {}
                    self._needRestore = true;
                    if (!self._pendingGroups) self._pendingGroups = {};
                    return origInstClear.apply(this, arguments);
                };
            }

            // 包装实例的 configure
            const origInstConfigure = app.graph.configure;
            if (origInstConfigure) {
                app.graph.configure = function(d) {
                    if (self._isPasting || self._isCopying) {
                        return origInstConfigure.apply(this, arguments);
                    }
                    const pendingFromTop = d?._xzgGroups || d?.extra?.xzgGroups || null;
                    const isCrossWorkflow = !!self._loadingNewWorkflow;
                    const result = origInstConfigure.apply(this, arguments);
                    self._loadingNewWorkflow = false;
                    if (app?.graph !== this) return result;
                    if (self._isPasting) return result;

                    // 跨工作流切换时清空旧编组，用新工作流数据恢复
                    if (isCrossWorkflow && pendingFromTop) {
                        for (const gid of Object.keys(self.groups)) self.killGroup(gid);
                        self.groups = {};
                        self._needRestore = true;
                        self._pendingGroups = pendingFromTop;
                        if (app.graph._nodes?.length) {
                            self.restoreGroups();
                        }
                    }
                    return result;
                };
            }

            app.graph._xzgInstanceHooked = true;
            console.log('[小珠光编组] app.graph 实例 clear/configure 钩子已安装');
        };
        tryHookInstance();

        // 额外保障：基于 extra 的持久化（新版 ComfyUI 前端兼容）
        this._setupExtraBasedPersistence();

        // LiteGraph 就绪后安装剪贴板钩子（必须在此处调用，因为需要 LG.LGraphCanvas.prototype）
        this.setupClipboardHook();

        // 注册全局钩子：供箭头工具切换编组边框的 pointer-events
        // 箭头模式激活时，编组边框穿透事件，避免拖动箭头经过编组时被拦截导致"停止"
        window.__xzg_setArrowModeActive = (active) => this.setArrowModeActive(active);
    },

    // 箭头模式切换：动态调整编组框交互元素的 pointer-events
    // 激活时设为 none 让事件穿透，避免拖动箭头经过编组时被边框/标题栏/手柄拦截导致"停止"
    // 关闭时恢复 auto，编组框可正常拖动移动/调整大小
    setArrowModeActive(active) {
        const pe = active ? 'none' : 'auto';
        for (const el of Object.values(this.groupEls)) {
            if (!el) continue;
            el.querySelectorAll('.xzg-border-left, .xzg-border-right, .xzg-border-bottom, .xzg-resize-handle, .xzg-group-header')
               .forEach(b => { b.style.pointerEvents = pe; });
        }
    },

    /* ── 运行时注入：确保功能1/2 所需的方法存在，并包装 updatePositions
     * 这是唯一绕过 ES module 浏览器编译缓存的方法 —— 无论磁盘文件和缓存 module
     * 版本是否一致，只要 init() 被调用，补丁就会被保证应用到当前 XZGGroup 实例。
     */
    _ensureRuntimePatches() {
        const self = this;
        // 1) 注入 _collectAllNodeIdsInGroup
        if (typeof self._collectAllNodeIdsInGroup !== 'function') {
            self._collectAllNodeIdsInGroup = function(gid, visitedGroups) {
                if (!self.groups[gid]) return [];
                visitedGroups = visitedGroups || new Set();
                if (visitedGroups.has(gid)) return [];
                visitedGroups.add(gid);
                const nodeIds = [];
                const pushId = (id) => {
                    if (id == null) return;
                    if (!nodeIds.some(x => self._idEq(x, id))) nodeIds.push(id);
                };
                for (const id of (self.groups[gid].nodeIds || [])) pushId(id);
                const g = self.groups[gid];
                const gArea = g.bounds ? g.bounds.w * g.bounds.h : 0;
                for (const [childGid, childG] of Object.entries(self.groups)) {
                    if (childGid === gid || !childG.bounds) continue;
                    const childArea = childG.bounds.w * childG.bounds.h;
                    if (gArea > 0 && childArea < gArea && g.bounds && self._isFullyContained(g.bounds, childG.bounds)) {
                        for (const id of self._collectAllNodeIdsInGroup(childGid, visitedGroups)) pushId(id);
                    }
                }
                return nodeIds;
            };
        }
        // 2) 注入 _syncSelectedGroupsFollowNodes，并包装 updatePositions
        if (typeof self._syncSelectedGroupsFollowNodes !== 'function') {
            self._syncSelectedGroupsFollowNodes = function() {
                // 已禁用：编组不再跟随节点移动。重置会话状态避免残留。
                self._nodePosCache = null;
                const s = typeof _XZG_NODE_DRAG_SESSION !== 'undefined' ? _XZG_NODE_DRAG_SESSION : null;
                if (s && s.active) { s.active=false; s.lockedGids.clear(); s.startSelSnapshot=null; s.startTs=0; s.lastMovedTs=0; }
                return;
            };
            // 兜底注入已改为空操作，下方为原逻辑（已禁用，保留备查）
            self._syncSelectedGroupsFollowNodes_DISABLED_ORIGINAL_FALLBACK = function() {
                const c = app?.canvas;
                const graph = app?.graph;
                if (!c?.selected_nodes || !graph?._nodes) return;
                const selMap = c.selected_nodes;
                if (!selMap || typeof selMap !== 'object') return;
                const selIdSet = new Set();
                for (const n of Object.values(selMap)) {
                    if (n && n.id != null) selIdSet.add(String(n.id));
                }
                if (selIdSet.size === 0) {
                    self._nodePosCache = null;
                    const s = _XZG_NODE_DRAG_SESSION;
                    if (s.active) { s.active=false; s.lockedGids.clear(); s.startSelSnapshot=null; s.startTs=0; s.lastMovedTs=0; }
                    return;
                }

                const nowPos = new Map();
                for (const idStr of selIdSet) {
                    const n = graph._nodes.find(x => String(x.id) === idStr);
                    if (n && n.pos && n.pos.length >= 2) {
                        nowPos.set(idStr, [Number(n.pos[0]) || 0, Number(n.pos[1]) || 0]);
                    }
                }
                const prev = self._nodePosCache;
                if (!prev) { self._nodePosCache = nowPos; return; }

                // 跟随会话锁定（同主方法实现：首次移动→锁定，后续帧直接复用 lockedGids）
                const session = _XZG_NODE_DRAG_SESSION;
                let fullySelectedGids;
                if (session.active && session.lockedGids.size > 0) {
                    // 选中集合变更时兜底解除锁定
                    let selChanged = false;
                    if (session.startSelSnapshot) {
                        if (session.startSelSnapshot.size !== selIdSet.size) selChanged = true;
                        else for (const v of session.startSelSnapshot) { if (!selIdSet.has(v)) { selChanged = true; break; } }
                    }
                    if (selChanged) {
                        session.active = false; session.lockedGids.clear();
                        session.startSelSnapshot = null; session.startTs = 0; session.lastMovedTs = 0;
                    } else {
                        fullySelectedGids = [...session.lockedGids].filter(gid => self.groups[gid]?.bounds);
                    }
                }
                if (!fullySelectedGids) {
                    fullySelectedGids = [];
                    for (const [gid, g] of Object.entries(self.groups)) {
                        if (!g.bounds) continue;
                        const allNodeIds = self._collectAllNodeIdsInGroup(gid);
                        if (allNodeIds.length <= 1) continue;
                        const baseSel = session.startSelSnapshot || selIdSet;
                        if (allNodeIds.every(id => baseSel.has(String(id)))) fullySelectedGids.push(gid);
                    }
                }
                if (fullySelectedGids.length === 0) { self._nodePosCache = nowPos; return; }

                const movedGids = new Set();
                let anyChanged = false;
                const nowTs = Date.now();
                for (const gid of fullySelectedGids) {
                    const g = self.groups[gid];
                    if (movedGids.has(gid) || !g?.bounds) continue;
                    const allNodeIds = self._collectAllNodeIdsInGroup(gid);
                    let sumDx = 0, sumDy = 0, count = 0;
                    for (const id of allNodeIds) {
                        const idStr = String(id);
                        const now = nowPos.get(idStr);
                        const old = prev.get(idStr);
                        if (now && old) { sumDx += now[0] - old[0]; sumDy += now[1] - old[1]; count++; }
                    }
                    if (count > 0) {
                        const dx = sumDx / count, dy = sumDy / count;
                        if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001) {
                            g.bounds.x += dx; g.bounds.y += dy; anyChanged = true;
                            if (!session.active) { session.active = true; session.startTs = nowTs; session.startSelSnapshot = new Set(selIdSet); }
                            if (!session.lockedGids.has(gid)) session.lockedGids.add(gid);
                            session.lastMovedTs = nowTs;
                        }
                    }
                    movedGids.add(gid);
                }
                if (session.active && session.lastMovedTs > 0 && nowTs - session.lastMovedTs > 600) {
                    session.active = false; session.lockedGids.clear();
                    session.startSelSnapshot = null; session.startTs = 0; session.lastMovedTs = 0;
                }
                self._nodePosCache = anyChanged ? null : nowPos;
            };
        }
        // 3) 把 updatePositions 包一层：在开头调用新同步方法（确保每帧被调用）
        if (!self._updatePositionsPatched) {
            const origUpdatePositions = self.updatePositions.bind(self);
            self.updatePositions = function() {
                self._syncSelectedGroupsFollowNodes();
                return origUpdatePositions.apply(self, arguments);
            };
            self._updatePositionsPatched = true;
        }
    },

    /* ── 鼠标中键事件转发：设置 pointer-events: none 后向画布派发事件 ── */
    _dispatchMiddleDown(clientX, clientY) {
        const targets = [];
        // 1) elementFromPoint 找到的实际下方元素（跳过已设 pointer-events: none 的编组元素）
        const under = document.elementFromPoint(clientX, clientY);
        if (under) targets.push(under);
        // 2) app.canvas.canvas（画布 DOM 元素）
        const cvs = app?.canvas?.canvas;
        if (cvs && !targets.includes(cvs)) targets.push(cvs);
        // 3) app.canvas 的 container/父元素
        const container = app?.canvas?.graphcanvas?.parentElement || app?.canvas?.canvas?.parentElement;
        if (container && !targets.includes(container)) targets.push(container);

        const opts = { clientX, clientY, button: 1, buttons: 4, bubbles: true, cancelable: true };
        for (const t of targets) {
            t.dispatchEvent(new MouseEvent('mousedown', opts));
            t.dispatchEvent(new PointerEvent('pointerdown', {
                ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true
            }));
        }
    },

    /* ── 注入样式 ── */
    injectStyles() {
        if (document.getElementById('xzg-group-styles')) return;
        const style = document.createElement('style');
        style.id = 'xzg-group-styles';
        style.textContent = `
@keyframes xzgPanelFadeIn { from { opacity:0; transform:translateY(-8px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
.xzg-group-toggle-switch {
    position: relative;
    width: 52px;
    height: 20px;
    border: none;
    border-radius: 10px;
    background: #555;
    cursor: pointer;
    padding: 0;
    transition: background 0.2s;
    flex-shrink: 0;
}
.xzg-group-toggle-switch[data-checked="true"] {
    background: #353535;
}
.xzg-group-toggle-switch .xzg-group-toggle-slider {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    background: #fff;
    border-radius: 50%;
    transition: left 0.2s;
    pointer-events: none;
}
.xzg-group-toggle-switch[data-checked="true"] .xzg-group-toggle-slider {
    left: 35px;
}
.xzg-group-toggle-switch .xzg-group-toggle-label {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-size: 11px;
    color: #fff;
    pointer-events: none;
    font-weight: bold;
    user-select: none;
}
.xzg-group-toggle-switch[data-checked="false"] .xzg-group-toggle-label {
    right: 8px;
}
.xzg-group-toggle-switch[data-checked="true"] .xzg-group-toggle-label {
    left: 8px;
}
`;
        document.head.appendChild(style);
    },

    /* ── 覆盖层 ── */
    createOverlay() {
        const o = document.createElement('div');
        o.id = 'xzg-group-overlay';
        const fadeDur = this.fadeOutDuration / 1000;
        o.style.cssText = `position:fixed;pointer-events:none;z-index:10;overflow:visible;transition:opacity ${fadeDur}s ease;clip-path:inset(0 0 0 0);`;
        document.body.appendChild(o);
        this.overlay = o;
    },

    _updateOverlayTransition(type) {
        if (!this.overlay) return;
        const fadeDur = type === 'in' ? this.fadeInDuration : this.fadeOutDuration;
        this.overlay.style.transition = `opacity ${fadeDur / 1000}s ease`;
    },

    syncOverlayPosition() {
        const c = app?.canvas?.canvas;
        if (!c || !this.overlay) return;
        const r = c.getBoundingClientRect();
        this.overlay.style.left = r.left + 'px';
        this.overlay.style.top = r.top + 'px';
        this.overlay.style.width = r.width + 'px';
        this.overlay.style.height = r.height + 'px';
    },

    _lastMouseX: 0,
    _lastMouseY: 0,

    _setupMouseTracker() {
        const self = this;
        document.addEventListener('mousemove', e => {
            self._lastMouseX = e.clientX;
            self._lastMouseY = e.clientY;
        }, true);
    },

    getGroupAtMouse() {
        const cx = this._lastMouseX, cy = this._lastMouseY;
        const sortedGids = Object.keys(this.groups).sort((a, b) => {
            const ga = this.groups[a]?.bounds, gb = this.groups[b]?.bounds;
            if (!ga || !gb) return 0;
            return (ga.w * ga.h) - (gb.w * gb.h);
        });
        for (const gid of sortedGids) {
            const el = this.groupEls[gid];
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
                return gid;
            }
        }
        return null;
    },

    _collectChildGroupIds(gid) {
        const result = new Set([gid]);
        const group = this.groups[gid];
        if (!group?.bounds) return result;
        const bounds = group.bounds;
        for (const [otherGid, otherGroup] of Object.entries(this.groups)) {
            if (otherGid === gid) continue;
            const ob = otherGroup.bounds;
            if (!ob) continue;
            if (ob.x >= bounds.x && ob.x + ob.w <= bounds.x + bounds.w &&
                ob.y >= bounds.y && ob.y + ob.h <= bounds.y + bounds.h) {
                result.add(otherGid);
            }
        }
        return result;
    },

    getGroupNodes(gid) {
        const g = this.groups[gid];
        if (!g?.bounds) return [];
        const bounds = g.bounds;
        const graph = app?.graph;
        if (!graph?._nodes) return [];
        const nodes = [];
        for (const n of graph._nodes) {
            const center = this._getNodeCenter(n);
            if (!center) continue;
            if (center.x >= bounds.x && center.x <= bounds.x + bounds.w &&
                center.y >= bounds.y && center.y <= bounds.y + bounds.h) {
                nodes.push(n);
            }
        }
        return nodes;
    },

    getOutputNodes(nodes) {
        if (!nodes || !nodes.length) return [];
        return nodes.filter((n) => {
            return n.mode != LiteGraph.NEVER && n.constructor?.nodeData?.output_node;
        });
    },

    _recursiveAddQueueNodes(nodeId, oldOutput, newOutput) {
        let currentId = String(nodeId);
        let currentNode = oldOutput[currentId];
        if (newOutput[currentId] == null && currentNode) {
            newOutput[currentId] = currentNode;
            for (const inputValue of Object.values(currentNode.inputs || [])) {
                if (Array.isArray(inputValue)) {
                    this._recursiveAddQueueNodes(inputValue[0], oldOutput, newOutput);
                }
            }
        }
        return newOutput;
    },

    async queueGroupOutputNodes(gid) {
        const nodes = this.getGroupNodes(gid);
        const outputNodes = this.getOutputNodes(nodes);
        if (!outputNodes.length) return false;

        const rgthree = window.rgthree;
        if (rgthree && typeof rgthree.queueOutputNodes === "function") {
            rgthree.queueOutputNodes(outputNodes);
            return true;
        }

        const nodeIds = outputNodes.map((n) => n.id);
        const origApiQueuePrompt = api.queuePrompt;
        let hookInstalled = false;

        const self = this;
        const hook = async function (index, prompt, ...args) {
            if (prompt.output) {
                const oldOutput = prompt.output;
                let newOutput = {};
                for (const queueNodeId of nodeIds) {
                    self._recursiveAddQueueNodes(queueNodeId, oldOutput, newOutput);
                }
                prompt.output = newOutput;
            }
            api.queuePrompt = origApiQueuePrompt;
            return origApiQueuePrompt.call(api, index, prompt, ...args);
        };

        try {
            api.queuePrompt = hook;
            hookInstalled = true;
            await app.queuePrompt(0);
            return true;
        } catch (e) {
            console.error("[小珠光编组] 执行编组内节点失败:", e);
            return false;
        } finally {
            if (hookInstalled) {
                api.queuePrompt = origApiQueuePrompt;
            }
        }
    },

    /* ── 快捷键 ── */
    setupKeyboardShortcut() {
        const self = this;
        this._setupMouseTracker();

        document.addEventListener('keydown', function h(e) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

            // F 键：执行鼠标所在编组的输出节点
            if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'f') {
                const gid = self.getGroupAtMouse();
                if (gid) {
                    e.preventDefault();
                    e.stopPropagation(); e.stopImmediatePropagation();
                    self.queueGroupOutputNodes(gid);
                    return;
                }
            }

            // Ctrl+? 新建编组
            const k = self.shortcutKey || 'g';
            if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === k.toLowerCase()) {
                e.preventDefault();
                e.stopPropagation(); e.stopImmediatePropagation();
                self.createGroupFromSelection();
                return;
            }

            // 编组开关面板快捷键（可自定义，默认 B）
            const ts = self.toggleShortcut || { key: 'b', ctrl: false, alt: false, shift: false, meta: false };
            if (e.key.toLowerCase() === ts.key.toLowerCase() &&
                !!e.ctrlKey === !!ts.ctrl && !!e.altKey === !!ts.alt &&
                !!e.shiftKey === !!ts.shift && !!e.metaKey === !!ts.meta) {
                e.preventDefault();
                e.stopPropagation(); e.stopImmediatePropagation();
                self.showTogglePanel();
                return;
            }
        }, true);
    },

    /* ── 右键菜单 ── */
    setupCanvasMenu() {
        if (window._xzg_group_menu_extended) return;
        window._xzg_group_menu_extended = true;
        const self = this;
        try {
            const LG = window.LiteGraph || (app.canvas?.constructor);
            if (!LG?.LGraphCanvas?.prototype?.getCanvasMenuOptions) return;
            const orig = LG.LGraphCanvas.prototype.getCanvasMenuOptions;
            LG.LGraphCanvas.prototype.getCanvasMenuOptions = function() {
                const opts = orig.apply(this, arguments);
                if (!opts?.length) return opts;
                opts.splice(0, 0, {
                    content: '<span style="color:#FFD700;">📦 ' + xzgT('小珠光编组','Xiaozhuguang Group') + ' <span style="color:#4CAF50;font-size:10px;">' + xzgT('快捷键','Shortcut') + 'Ctrl+' + (self.shortcutKey || 'g').toUpperCase() + '</span></span>',
                    callback: () => self.createGroupFromSelection()
                });
                // 编组开关面板快捷键文本（动态读取自定义值）
                const ts = self.toggleShortcut || { key: 'b', ctrl: false, alt: false, shift: false, meta: false };
                const tsParts = [];
                if (ts.ctrl) tsParts.push('Ctrl');
                if (ts.alt) tsParts.push('Alt');
                if (ts.shift) tsParts.push('Shift');
                if (ts.meta) tsParts.push('Meta');
                tsParts.push(ts.key.toUpperCase());
                opts.splice(1, 0, {
                    content: '<span style="color:#FFD700;">🔧 ' + xzgT('编组开关面板','Group Toggle Panel') + ' <span style="color:#4CAF50;font-size:10px;">' + xzgT('快捷键','Shortcut') + ' ' + tsParts.join('+') + '</span></span>',
                    callback: () => self.showTogglePanel()
                });
                return opts;
            };
        } catch (e) {}
    },

    /* ── Ctrl+单击框体=绕过 ── */
    setupBodyBypass() {
        const self = this;
        document.addEventListener('mousedown', e => {
            if (!e.ctrlKey || e.button !== 0) return;
            const cx = e.clientX, cy = e.clientY;
            // 按面积从小到大排序，确保小框优先检测（大框内的小框先被识别）
            const sortedGids = Object.keys(this.groups).sort((a, b) => {
                const ga = this.groups[a]?.bounds, gb = this.groups[b]?.bounds;
                if (!ga || !gb) return 0;
                return (ga.w * ga.h) - (gb.w * gb.h);
            });
            for (const gid of sortedGids) {
                const el = this.groupEls[gid];
                if (!el) continue;
                const r = el.getBoundingClientRect();
                if (r.width === 0) continue;
                if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
                    e.preventDefault(); e.stopPropagation();
                    e.stopImmediatePropagation();
                    this.toggleBypassUnified(gid);
                    return;
                }
            }
        }, true);
    },

    /* ── 同步循环 ── */
    startSyncLoop() {
        const self = this;
        const loop = () => {
            self.syncOverlayPosition();
            // 有未恢复的编组数据且 graph 有节点时立即恢复（不依赖 canvas）
            if (self._needRestore && self._pendingGroups && app?.graph?._nodes?.length) {
                self.restoreGroups();
            }
            self.updatePositions();
            // 画布移动隐藏/渐入检测
            self._checkCanvasMovement();
            self._raf = requestAnimationFrame(loop);
        };
        this._raf = requestAnimationFrame(loop);
        this._syncLoopStarted = true;

        // 立即响应画布缩放/平移，消除渲染延迟
        this._setupImmediateSync();
    },

    /* ── 立即同步：消除画布缩放时编组框的渲染延迟 ── */
    _setupImmediateSync() {
        if (this._immediateSyncReady) return;
        this._immediateSyncReady = true;
        const self = this;

        // 同步更新，不再用 RAF 延迟，避免拖拽时编组框滞后
        const syncNow = () => self.updatePositions();

        const tryHook = () => {
            const canvas = app?.canvas;
            const ds = canvas?.ds;
            if (!ds) { setTimeout(tryHook, 100); return; }

            // Hook changeScale：缩放时立即更新位置
            const origCS = ds.changeScale;
            ds.changeScale = function() {
                origCS.apply(this, arguments);
                syncNow();
            };

            // Hook changeOffset：平移时立即更新位置
            const origCO = ds.changeOffset;
            ds.changeOffset = function() {
                origCO.apply(this, arguments);
                syncNow();
            };

            // Hook processMouseMove：画布拖拽平移时同步更新
            // LiteGraph 在 processMouseMove 中直接修改 ds.offset，不走 changeOffset
            if (canvas && typeof canvas.processMouseMove === 'function') {
                const origPMM = canvas.processMouseMove;
                canvas.processMouseMove = function() {
                    const r = origPMM.apply(this, arguments);
                    if (this.dragging_canvas) syncNow();
                    return r;
                };
            }

            // 监听 canvas 上的 wheel 事件（缩放）
            const cv = canvas?.canvas;
            if (cv) {
                cv.addEventListener('wheel', () => syncNow(), { passive: true });
            }

            console.log('[小珠光编组] 即时同步钩子已安装');
        };
        tryHook();
    },

    /** 缓存每个编组框的DOM子元素引用，避免每帧 querySelector */
    _ensureRefs(el) {
        if (!el._xzgRefs) {
            el._xzgRefs = {
                title: el.querySelector('.xzg-group-title-text'),
                delBtn: el.querySelector('.xzg-delete-btn'),
                lockBtn: el.querySelector('.xzg-lock-btn'),
                rpath: el.querySelector('.xzg-resize-handle svg path'),
                leftFifth: el.querySelector('.xzg-left-fifth'),
                leftFifthIcon: el.querySelector('.xzg-left-fifth-icon'),
                rightFifth: el.querySelector('.xzg-right-fifth'),
                rightFifthIcon: el.querySelector('.xzg-right-fifth-icon')
            };
        }
        return el._xzgRefs;
    },

    updatePositions() {
        // 功能1：编组内所有节点被选中并拖动 → bounds 跟随节点平移（增量更新）
        // 放在所有编组 bounds 计算之前，先让编组位移更新
        this._syncSelectedGroupsFollowNodes();

        const c = app?.canvas;
        if (!c?.ds) return;
        const scale = c.ds.scale || 1;
        const ox = c.ds.offset[0] || 0;
        const oy = c.ds.offset[1] || 0;

        if (Object.keys(this.groups).length === 0) {
            const graph = app?.graph;
            if (graph?._nodes?.length) {
                let hasGroupData = false;
                for (const n of graph._nodes) {
                    if (n._xzgGroupId || n._xzgGroupData || n.properties?._xzgGroup) {
                        hasGroupData = true;
                        break;
                    }
                }
                if (hasGroupData) {
                    console.log('[小珠光编组] 检测到编组数据丢失，自动恢复');
                    this._needRestore = true;
                    this.restoreGroups();
                }
            }
        }

        for (const [gid, g] of Object.entries(this.groups)) {
            const el = this.groupEls[gid];
            if (!el) continue;
            const b = g.bounds;
            if (!b) { el.style.display = 'none'; continue; }
            el.style.display = 'block';
            // 标题文字/栏高度跟随画布缩放（无标题时保留最小操作区域）
            // 超出基准高度部分编组框整体向外（向上）扩展，避免向内遮挡节点
            const fs = (g.fontSize || 20) * scale;
            const showTitle = (g.title || '').trim() !== '';
            const baseHeaderHeight = 18 * scale;
            const headerHeight = Math.max(baseHeaderHeight, fs + 4 * scale);
            const extraTop = headerHeight - baseHeaderHeight;

            // 编组框整体上移并增高，使 CSS 边框也跟随扩展
            // 注意：canvas 坐标转屏幕坐标为 screenX = canvasRect.left + (canvasX + ds.offset[0]) * ds.scale
            // ds.offset 的单位是画布逻辑坐标（与 node.pos 一致），不是屏幕像素
            // 相对于 overlay（位于 canvasRect）的 CSS 位置为 (b.x + ox) * scale
            el.style.left = ((b.x + ox) * scale) + 'px';
            el.style.top = ((b.y + oy) * scale - extraTop) + 'px';
            el.style.width = (b.w * scale) + 'px';
            el.style.height = (b.h * scale + extraTop) + 'px';

            const header = el.querySelector('.xzg-group-header');
            if (header) {
                const padV = 2 * scale;
                header.style.height = headerHeight + 'px';
                header.style.paddingLeft = (6 * scale) + 'px';
                header.style.paddingRight = (6 * scale) + 'px';
                header.style.paddingTop = padV + 'px';
                header.style.paddingBottom = padV + 'px';
                header.style.background = showTitle ? (g.headerBgColor || 'rgba(0,0,0,0.4)') : 'transparent';
            }
            const span = el.querySelector('.xzg-group-title-text');
            if (span) {
                span.style.fontSize = fs + 'px';
                span.style.lineHeight = (g.lineHeight ?? 1);
                span.style.color = g.titleColor || '#FFD700';
                span.style.display = showTitle ? '' : 'none';
            }
            const delBtn = el.querySelector('.xzg-delete-btn');
            if (delBtn) {
                delBtn.style.fontSize = (18 * scale) + 'px';
                delBtn.style.marginLeft = (4 * scale) + 'px';
            }
            const lockBtn = el.querySelector('.xzg-lock-btn');
            if (lockBtn) {
                const lockSvg = lockBtn.querySelector('svg');
                if (lockSvg) {
                    const sz = Math.round(headerHeight * 0.55);
                    lockSvg.style.width = sz + 'px';
                    lockSvg.style.height = sz + 'px';
                }
                lockBtn.style.marginLeft = (4 * scale) + 'px';
            }
            ['xzg-left-fifth-icon', 'xzg-right-fifth-icon'].forEach(cls => {
                const icon = el.querySelector('.' + cls);
                if (icon) icon.style.fontSize = (12 * scale) + 'px';
            });
            ['xzg-border-left', 'xzg-border-right'].forEach(cls => {
                const be = el.querySelector('.' + cls);
                if (be) be.style.top = headerHeight + 'px';
            });

            // 自动收纳/释放节点（降低频率：每10帧检测一次）
            if (!el._xzgSyncFrame || el._xzgSyncFrame <= 0) {
                this.syncNodeMembership(g, b);
                el._xzgSyncFrame = 10;
            }
            el._xzgSyncFrame--;

            // 每帧同步样式 + 动画效果
            this.updateGroupStyle(gid);
            if (g.bypassed) continue;

            const e = g.effect;
            if (!e || e === 'none') {
                el.style.boxShadow = 'none';
                el.style.borderImage = 'none';
                el.style.background = 'transparent';
                continue;
            }

            const refs = this._ensureRefs(el);
            const spd = (g.effectSpeed || 3) * 5 / 9;
            const bw = (g.borderWidth || 2) * scale;
            const bo = g.borderOpacity ?? 1;

            // 非marquee效果重置文字样式
            if (e !== 'marquee' && e !== 'marqueebreathe') {
                el.style.overflow = '';
                el.style.background = 'transparent';
                if (refs.title) {
                    refs.title.style.background = '';
                    refs.title.style.webkitBackgroundClip = '';
                    refs.title.style.webkitTextFillColor = '';
                    refs.title.style.backgroundClip = '';
                }
            }

            // 给效果帧更新左/右箭头和竖线颜色的辅助函数
            const updateIndicators = (hue, sat, lit, op) => {
                if (refs.leftFifth) refs.leftFifth.style.borderRightColor = `hsla(${hue},${sat}%,${lit}%,${op*0.3})`;
                if (refs.leftFifthIcon) refs.leftFifthIcon.style.color = `hsla(${hue},${sat}%,${lit}%,${op*0.55})`;
                if (refs.rightFifth) refs.rightFifth.style.borderLeftColor = `hsla(${hue},${sat}%,${lit}%,${op*0.3})`;
                if (refs.rightFifthIcon) refs.rightFifthIcon.style.color = `hsla(${hue},${sat}%,${lit}%,${op*0.55})`;
            };

            switch (e) {
            case 'rainbow': {
                const t = (Date.now() / 4500) * spd;
                const h = (t * 360) % 360;
                el.style.borderImage = 'none';
                el.style.border = `${bw}px solid hsla(${h},80%,55%,${bo})`;
                el.style.boxShadow = 'none';
                if (refs.delBtn) refs.delBtn.style.color = `hsla(${h},80%,55%,${Math.min(bo + 0.1, 1)})`;
                if (refs.rpath) refs.rpath.setAttribute('stroke', `hsla(${h},80%,55%,${bo})`);
                if (refs.title) refs.title.style.color = `hsla(${h},80%,55%,0.85)`;
                updateIndicators(h, 80, 55, bo);
                break;
            }
            case 'pulse': {
                const t = (Date.now() / 2000) * spd;
                const a = Math.abs(Math.sin(t));
                const h = g.colorHue ?? 48;
                el.style.borderImage = 'none';
                el.style.border = `${bw}px solid hsla(${h},${g.colorSat||100}%,${g.colorLit||55}%,${a.toFixed(2)})`;
                el.style.boxShadow = 'none';
                if (refs.delBtn) refs.delBtn.style.color = `hsla(${h},${g.colorSat||100}%,${g.colorLit||55}%,${a.toFixed(2)})`;
                if (refs.rpath) refs.rpath.setAttribute('stroke', `hsla(${h},${g.colorSat||100}%,${g.colorLit||55}%,${(0.3+a*0.7).toFixed(2)})`);
                if (refs.title) refs.title.style.color = `hsla(${h},${g.colorSat||100}%,${g.colorLit||55}%,${a.toFixed(2)})`;
                updateIndicators(h, g.colorSat||100, g.colorLit||55, a);
                break;
            }
            case 'marquee': {
                const t = (Date.now() / 2500) * spd;
                const angle = (t * 360) % 360;
                const h0 = (t * 360) % 360;
                el.style.border = `${Math.max(1, bw)}px solid transparent`;
                el.style.borderRadius = '8px';
                el.style.overflow = 'hidden';
                el.style.borderImage = `conic-gradient(from ${angle}deg, hsl(0,100%,65%), hsl(30,100%,65%), hsl(60,100%,65%), hsl(90,100%,65%), hsl(120,100%,65%), hsl(150,100%,65%), hsl(180,100%,65%), hsl(210,100%,65%), hsl(240,100%,65%), hsl(270,100%,65%), hsl(300,100%,65%), hsl(330,100%,65%), hsl(360,100%,65%)) 1`;
                el.style.boxShadow = 'none';
                if (refs.delBtn) refs.delBtn.style.color = `hsla(${h0},100%,65%,0.6)`;
                if (refs.rpath) refs.rpath.setAttribute('stroke', `hsla(${h0},100%,65%,0.7)`);
                if (refs.title) {
                    refs.title.style.background = `linear-gradient(90deg, hsl(${h0},100%,65%), hsl(${(h0+60)%360},100%,65%), hsl(${(h0+120)%360},100%,65%), hsl(${(h0+180)%360},100%,65%), hsl(${(h0+240)%360},100%,65%), hsl(${(h0+300)%360},100%,65%), hsl(${h0},100%,65%))`;
                    refs.title.style.webkitBackgroundClip = 'text';
                    refs.title.style.webkitTextFillColor = 'transparent';
                    refs.title.style.backgroundClip = 'text';
                    refs.title.style.color = 'transparent';
                }
                updateIndicators(h0, 100, 65, 1);
                break;
            }
            case 'marqueebreathe': {
                const t = (Date.now() / 2500) * spd;
                const wave = Math.abs(Math.sin(t * 2));
                const angle = (t * 360) % 360;
                const h0 = (t * 360) % 360;
                el.style.overflow = 'hidden';
                el.style.border = `${Math.max(1, bw)}px solid transparent`;
                el.style.borderRadius = '8px';
                el.style.borderImage = `conic-gradient(from ${angle}deg, hsl(0,100%,${5+wave*60}%), hsl(30,100%,${5+wave*60}%), hsl(60,100%,${5+wave*60}%), hsl(90,100%,${5+wave*60}%), hsl(120,100%,${5+wave*60}%), hsl(150,100%,${5+wave*60}%), hsl(180,100%,${5+wave*60}%), hsl(210,100%,${5+wave*60}%), hsl(240,100%,${5+wave*60}%), hsl(270,100%,${5+wave*60}%), hsl(300,100%,${5+wave*60}%), hsl(330,100%,${5+wave*60}%), hsl(360,100%,${5+wave*60}%)) 1`;
                el.style.boxShadow = 'none';
                const lv = 5 + wave * 60;
                if (refs.delBtn) refs.delBtn.style.color = `hsla(${h0},100%,${lv}%,0.6)`;
                if (refs.rpath) refs.rpath.setAttribute('stroke', `hsla(${h0},100%,${lv}%,0.7)`);
                if (refs.title) {
                    refs.title.style.background = `linear-gradient(90deg, hsl(${h0},100%,${lv}%), hsl(${(h0+60)%360},100%,${lv}%), hsl(${(h0+120)%360},100%,${lv}%), hsl(${(h0+180)%360},100%,${lv}%), hsl(${(h0+240)%360},100%,${lv}%), hsl(${(h0+300)%360},100%,${lv}%), hsl(${h0},100%,${lv}%))`;
                    refs.title.style.webkitBackgroundClip = 'text';
                    refs.title.style.webkitTextFillColor = 'transparent';
                    refs.title.style.backgroundClip = 'text';
                    refs.title.style.color = 'transparent';
                }
                updateIndicators(h0, 100, lv, 1);
                break;
            }
            case 'glow': {
                const t = (Date.now() / 1250) * spd;
                const a = 0.4 + Math.abs(Math.sin(t)) * 0.6;
                const h = g.colorHue ?? 48;
                const s = g.colorSat ?? 100;
                const l = g.colorLit ?? 55;
                el.style.borderImage = 'none';
                el.style.border = `${bw}px solid hsla(${h},${s}%,${l}%,${bo})`;
                el.style.boxShadow = `0 0 3px hsla(${h},${s}%,${l}%,1), 0 0 12px hsla(${h},${s}%,${l}%,${a.toFixed(2)}), 0 0 35px hsla(${h},${s}%,${l}%,${(a*0.5).toFixed(2)})`;
                if (refs.delBtn) refs.delBtn.style.color = `hsla(${h},${s}%,${l}%,${Math.min(bo + 0.1, 1)})`;
                if (refs.rpath) refs.rpath.setAttribute('stroke', `hsla(${h},${s}%,${l}%,${bo})`);
                if (refs.title) refs.title.style.color = `hsla(${h},${s}%,${l}%,0.85)`;
                updateIndicators(h, s, l, bo);
                break;
            }
            default:
                el.style.boxShadow = 'none';
                el.style.borderImage = 'none';
                el.style.background = 'transparent';
            }
        }
    },

    /* ── 画布移动检测：移动时隐藏编组，停止后渐入（按编组独立控制） ── */
    _checkCanvasMovement() {
        if (!this.overlay) return;
        const c = app?.canvas;
        if (!c?.ds) return;
        const scale = c.ds.scale || 1;
        const ox = c.ds.offset[0] || 0;
        const oy = c.ds.offset[1] || 0;

        const moved = this._lastOffsetX !== null && (
            Math.abs(ox - this._lastOffsetX) > 0.5 ||
            Math.abs(oy - this._lastOffsetY) > 0.5 ||
            Math.abs(scale - this._lastScale) > 0.001
        );

        this._lastOffsetX = ox;
        this._lastOffsetY = oy;
        this._lastScale = scale;

        const hasAnyEnabled = Object.values(this.groups).some(g => g.fadeEnabled);
        if (!hasAnyEnabled) return;

        if (moved) {
            if (!this._canvasMoving) {
                this._canvasMoving = true;
                for (const [gid, g] of Object.entries(this.groups)) {
                    if (!g.fadeEnabled) continue;
                    const el = this.groupEls[gid];
                    if (!el) continue;
                    const fadeDur = (g.fadeOutDuration || 0) / 1000;
                    el.style.transition = `opacity ${fadeDur}s ease`;
                    el.style.opacity = '0';
                }
            }
            if (this._moveStopTimer) {
                clearTimeout(this._moveStopTimer);
                this._moveStopTimer = null;
            }
        } else if (this._canvasMoving) {
            this._canvasMoving = false;
            const useFastFade = !!this._flashGroupActive;
            const fadeDurMs = useFastFade ? 100 : null;
            for (const [gid, g] of Object.entries(this.groups)) {
                if (!g.fadeEnabled) continue;
                const el = this.groupEls[gid];
                if (!el) continue;
                const fadeDur = (fadeDurMs ?? g.fadeInDuration ?? 1000) / 1000;
                el.style.transition = `opacity ${fadeDur}s ease`;
                el.style.opacity = '1';
            }
        }
    },

    /* ── 清理节点上的冗余编组数据 ── */
    _clearNodeGroupData(n) {
        if (!n) return;
        n._xzgGroupId = null;
        n._xzgGroupData = null;
        delete n._xzgGroup; // 清除 configure 时从数据批量拷贝的残留字段
        if (n.properties) {
            delete n.properties._xzgGroup;
        }
    },

    _idEq(a, b) {
        return a === b || a == b;
    },

    _idInArray(arr, id) {
        return arr.some(x => this._idEq(x, id));
    },

    _idInSet(set, id) {
        for (const v of set) {
            if (this._idEq(v, id)) return true;
        }
        return false;
    },

    /* ── 自动收纳/释放节点 ── */
    syncNodeMembership(group, bounds) {
        const graph = app?.graph;
        if (!graph?._nodes) return;
        if (!bounds) return;

        const inBounds = new Set();
        const inBoundsNodes = [];

        graph._nodes.forEach(n => {
            const center = this._getNodeCenter(n);
            if (!center) return;
            if (center.x >= bounds.x && center.x <= bounds.x + bounds.w &&
                center.y >= bounds.y && center.y <= bounds.y + bounds.h) {
                inBounds.add(n.id);
                inBoundsNodes.push(n);
                if (!this._idInArray(group.nodeIds, n.id)) {
                    group.nodeIds.push(n.id);
                }
            }
        });

        const prevCount = group.nodeIds.length;
        const newCount = inBounds.size;

        if (prevCount > 0 && newCount === 0) {
            group.nodeIds = [];
            return;
        }

        if (prevCount > 0 && newCount < prevCount * 0.3) {
            return;
        }

        group.nodeIds = group.nodeIds.filter(nid => this._idInSet(inBounds, nid));
    },

    /* ── 计算包围盒 ── */
    calcBounds(nodeIds) {
        const g = app?.graph;
        if (!g?._nodes) return null;
        let minX = 1/0, minY = 1/0, maxX = -1/0, maxY = -1/0, f = false;
        for (const nid of nodeIds) {
            const n = g._nodes.find(x => x.id === nid || x.id == nid);
            if (!n?.pos) continue;
            const w = n.size?.[0] || 200, h = n.size?.[1] || 100;
            minX = Math.min(minX, n.pos[0]); minY = Math.min(minY, n.pos[1]);
            maxX = Math.max(maxX, n.pos[0] + w); maxY = Math.max(maxY, n.pos[1] + h);
            f = true;
        }
        if (!f) return null;
        const p = 20;
        const topPad = 58;
        return { x: minX - p, y: minY - topPad, w: maxX - minX + p * 2, h: maxY - minY + topPad + p };
    },

    /* ── 创建编组 ── */
    createGroupFromSelection() {
        const c = app?.canvas;
        if (!c?.selected_nodes) { alert('[小珠光编组] 请框选节点'); return; }
        const sel = Object.values(c.selected_nodes).filter(n => n?.pos && typeof n.pos[0] === 'number');
        if (sel.length < 1) { alert('[小珠光编组] 请至少选1个节点'); return; }

        const nids = sel.map(n => n.id);
        const bounds = this.calcBounds(nids) || { x: 0, y: 0, w: 300, h: 200 };

        // 找出完全位于新编组内部的旧编组（它们将成为子编组，大控制小）
        const childGroupIds = new Set();
        const newGroupArea = bounds.w * bounds.h;
        for (const [otherGid, otherG] of Object.entries(this.groups)) {
            const ob = otherG.bounds;
            if (!ob) continue;
            const otherArea = ob.w * ob.h;
            if (otherArea >= newGroupArea) continue; // 小不控制大
            if (this._isFullyContained(bounds, ob)) {
                childGroupIds.add(otherGid);
            }
        }

        // 新编组只收纳未被任何子编组包含的选中节点
        const self = this;
        const directNodeIds = nids.filter(nid => {
            const n = sel.find(x => self._idEq(x.id, nid));
            return !(n._xzgGroupId && self._idInSet(childGroupIds, n._xzgGroupId));
        });

        // 计算新编组将控制的所有节点（直接节点 + 子编组节点）
        const controlledNodeIds = new Set(directNodeIds);
        childGroupIds.forEach(cgId => this.groups[cgId]?.nodeIds.forEach(id => controlledNodeIds.add(id)));

        if (controlledNodeIds.size === 0) {
            console.log('[小珠光编组] 没有可控制节点，跳过创建');
            return;
        }

        // 收集某个编组控制的所有节点（自身 + 完全位于内部的子编组，仅限面积更小的编组）
        const collectControlled = (gid) => {
            const g = this.groups[gid];
            if (!g) return new Set();
            const ids = new Set(g.nodeIds);
            const gArea = g.bounds.w * g.bounds.h;
            for (const [otherGid, otherG] of Object.entries(this.groups)) {
                if (otherGid === gid) continue;
                if (!otherG.bounds) continue;
                const otherArea = otherG.bounds.w * otherG.bounds.h;
                if (otherArea >= gArea) continue; // 小不控制大
                if (this._isFullyContained(g.bounds, otherG.bounds)) otherG.nodeIds.forEach(id => ids.add(id));
            }
            return ids;
        };

        // 防重复：已有编组控制相同节点集合且 bounds 高度重叠，则不再创建
        for (const [otherGid, otherG] of Object.entries(this.groups)) {
            const otherControlled = collectControlled(otherGid);
            if (otherControlled.size !== controlledNodeIds.size) continue;
            let allMatch = true;
            for (const id of controlledNodeIds) if (!otherControlled.has(id)) { allMatch = false; break; }
            if (!allMatch) continue;
            if (this._getIoU(bounds, otherG.bounds) > 0.9) {
                console.log('[小珠光编组] 选中区域已存在等效编组，跳过创建:', otherGid);
                return;
            }
        }

        const gid = 'g_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
        // 继承上次使用的标题配置（颜色/大小/炫彩/背景/辉光等）
        const last = this.getLastTitleConfig();
        this.groups[gid] = {
            id: gid,
            title: '右键标题栏设置',
            nodeIds: directNodeIds,
            bypassed: false,
            locked: false,
            hidden: false,
            bounds: bounds,
            fontSize: last.fontSize,
            colorHue: last.colorHue, colorSat: last.colorSat, colorLit: last.colorLit,
            effect: last.effect, effectSpeed: last.effectSpeed,
            borderWidth: last.borderWidth, borderOpacity: last.borderOpacity,
            headerBgColor: last.headerBgColor,
            titleColor: last.titleColor,
            lineHeight: 1,
            fadeEnabled: last.fadeEnabled,
            fadeOutDuration: 0,
            fadeInDuration: last.fadeInDuration
        };

        // 标记节点归入新编组（同时保留节点在其他编组中的归属）
        directNodeIds.forEach(nid => {
            const n = sel.find(x => x.id === nid || x.id == nid);
            if (n) {
                n._xzgGroupId = gid;
            }
        });

        this.renderGroup(gid);
        app.graph?.setDirtyCanvas?.(true, true);
        app.graph?.change?.();
        this.syncGroupsToExtra();
        console.log('[小珠光编组] 创建:', gid, directNodeIds.length, '直接节点', childGroupIds.size, '子编组');
    },

    killGroup(gid) {
        const el = this.groupEls[gid];
        if (el) {
            delete el._xzgRefs; // 清空缓存引用
            el.parentElement?.removeChild(el);
        }
        delete this.groupEls[gid];
        delete this.groups[gid];
    },

    /* ── 渲染 ── */
    renderGroup(gid) {
        const g = this.groups[gid];
        if (!g) return;
        let el = this.groupEls[gid];
        if (!el) {
            el = this.buildGroupEl(g);
            this.groupEls[gid] = el;
            this.overlay.appendChild(el);
        }
        this.updateGroupStyle(gid);
    },

    buildGroupEl(group) {
        const self = this;
        const el = document.createElement('div');
        el.className = 'xzg-group-box';
        el.dataset.groupId = group.id;
        const bw = group.borderWidth || 2;
        const bo = group.borderOpacity ?? 1;
        el.style.cssText = `position:absolute;pointer-events:none;border:${bw}px solid hsla(48,100%,55%,${bo});border-radius:8px;background:transparent;box-sizing:border-box;z-index:5;`;
        const scale = app?.canvas?.ds?.scale || 1;
        const fs = (group.fontSize || 20) * scale;
        const showTitle = (group.title || '').trim() !== '';
        const headerHeight = Math.max(18 * scale, fs + 4 * scale);
        el.innerHTML = `
            <div class="xzg-group-header" style="display:flex;align-items:center;padding:0;background:${showTitle ? (group.headerBgColor || 'rgba(0,0,0,0.4)') : 'transparent'};border-radius:7px 7px 0 0;cursor:pointer;user-select:none;pointer-events:auto;height:${headerHeight}px;box-sizing:border-box;overflow:visible;z-index:4;">
                <div class="xzg-left-fifth" title="点击此区域：该编组开启，同级其他全部绕过" style="display:flex;align-items:center;justify-content:center;width:20%;height:100%;flex-shrink:0;background:rgba(255,255,255,0.04);border-right:1px solid rgba(255,255,255,0.1);position:relative;">
                    <span class="xzg-left-fifth-icon" style="font-size:9px;color:rgba(255,215,0,0.35);line-height:1;pointer-events:none;">◀</span>
                </div>
                <div style="flex:1 1 auto;min-width:0;overflow:hidden;padding:0;display:flex;align-items:center;justify-content:center;height:100%;">
                    <span class="xzg-group-title-text" style="color:${group.titleColor || '#FFD700'};font-size:${fs}px;font-weight:400;white-space:nowrap;line-height:${(group.lineHeight ?? 1)};overflow:hidden;text-overflow:ellipsis;${showTitle ? '' : 'display:none;'}">${showTitle ? group.title : ''}</span>
                </div>
                <div class="xzg-right-fifth" title="点击此区域：该编组绕过，同级其他全部开启" style="display:flex;align-items:center;justify-content:center;width:20%;height:100%;flex-shrink:0;background:rgba(255,255,255,0.04);border-left:1px solid rgba(255,255,255,0.1);position:relative;">
                    <span class="xzg-right-fifth-icon" style="font-size:9px;color:rgba(255,215,0,0.35);line-height:1;pointer-events:none;">▶</span>
                </div>
                <button class="xzg-lock-btn" title="锁定/解锁编组，Ctrl+鼠标左键锁定/解锁所有编组" style="border:none;background:none;cursor:pointer;padding:0 2px;flex-shrink:0;line-height:1;display:flex;align-items:center;"><svg viewBox="0 0 16 16" width="${Math.round(headerHeight * 0.55)}" height="${Math.round(headerHeight * 0.55)}"><path d="M4 7V5a4 4 0 018 0v2h1v7H3V7h1zm2 0h4V5a2 2 0 00-4 0v2z" fill="currentColor"/></svg></button>
                <button class="xzg-delete-btn" title="删除编组" style="border:none;background:none;cursor:pointer;padding:0 2px;flex-shrink:0;font-size:${headerHeight * 0.7}px;color:hsla(48,100%,55%,0.5);line-height:1;display:flex;align-items:center;">×</button>
            </div>
            <div class="xzg-border-left" style="position:absolute;left:-3px;top:${headerHeight}px;width:10px;bottom:-3px;pointer-events:auto;cursor:move;z-index:2;"></div>
            <div class="xzg-border-right" style="position:absolute;right:-3px;top:${headerHeight}px;width:10px;bottom:-3px;pointer-events:auto;cursor:move;z-index:2;"></div>
            <div class="xzg-border-bottom" style="position:absolute;left:7px;right:7px;bottom:-3px;height:10px;pointer-events:auto;cursor:move;z-index:2;"></div>
            <div class="xzg-resize-handle" title="拖动调整大小" style="position:absolute;right:2px;bottom:2px;width:14px;height:14px;cursor:nwse-resize;pointer-events:auto;opacity:0.6;z-index:3;">
                <svg viewBox="0 0 14 14" width="14" height="14"><path d="M12 2L2 12 M8 12h4v-4" stroke="#FFD700" stroke-width="1.5" fill="none"/></svg>
            </div>
        `;

        // 删除按钮
        el.querySelector('.xzg-delete-btn').addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
        el.querySelector('.xzg-delete-btn').addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); self.removeGroup(group.id); });
        // 锁定按钮
        el.querySelector('.xzg-lock-btn').addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
        el.querySelector('.xzg-lock-btn').addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); if (e.ctrlKey) { self.toggleLockAll(group.id); } else { self.toggleLock(group.id); } });

        // 将当前编组框提升到 overlay 最前面
        const bringToFront = () => { el.parentElement?.appendChild(el); };

        // 边框点击：提升层级并启动拖动（便于选中重叠在下层的编组框）
        ['xzg-border-left', 'xzg-border-right', 'xzg-border-bottom'].forEach(cls => {
            const borderEl = el.querySelector('.' + cls);
            if (!borderEl) return;
            borderEl.addEventListener('mousedown', e => {
                // 鼠标中键 → 透传到画布以支持画布平移
                if (e.button === 1) {
                    e.preventDefault();
                    e.stopPropagation();
                    const el2 = e.currentTarget;
                    el2.style.pointerEvents = 'none';
                    self._dispatchMiddleDown(e.clientX, e.clientY);
                    const restore = () => {
                        el2.style.pointerEvents = 'auto';
                        document.removeEventListener('mouseup', restore);
                    };
                    document.addEventListener('mouseup', restore);
                    return;
                }
                if (e.button !== 0) return;
                e.preventDefault(); e.stopPropagation();
                bringToFront();
                // Ctrl+拖动边框：仅移动框体，节点不跟随
                self.startDrag(group.id, e, !!e.ctrlKey);
            });
            // 边框区域拦截了滚轮事件，需转发到画布以支持缩放
            borderEl.addEventListener('wheel', e => {
                e.preventDefault();
                const cv = app?.canvas;
                if (!cv?.ds) return;
                const d = e.deltaY > 0 ? -1 : 1;
                const ns = cv.ds.scale * (1 + d * 0.1);
                if (ns < 0.1 || ns > 10) return;
                const rc = cv.canvas.getBoundingClientRect();
                cv.ds.changeScale(ns, [e.clientX - rc.left, e.clientY - rc.top]);
                cv.setDirty(true, true);
            }, { passive: false });
        });

        // 标题栏操作：左键单击=绕过/选中，左键按住拖动=移动组（Ctrl+拖动=仅移动框体），右键任意位置=设置
        const headerEl = el.querySelector('.xzg-group-header');
        let startX, startY, dragged;
        headerEl.addEventListener('mousedown', e => {
            // 鼠标中键 → 透传到画布以支持画布平移
            if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                const el2 = e.currentTarget;
                el2.style.pointerEvents = 'none';
                self._dispatchMiddleDown(e.clientX, e.clientY);
                const restore = () => {
                    el2.style.pointerEvents = 'auto';
                    document.removeEventListener('mouseup', restore);
                };
                document.addEventListener('mouseup', restore);
                return;
            }
            if (e.target.tagName === 'BUTTON') return;
            if (e.button === 2) return; // 右键不处理绕过
            if (e.target === el.querySelector('.xzg-group-title-text') && e.detail !== 1) return;
            e.preventDefault();
            bringToFront();
            startX = e.clientX; startY = e.clientY; dragged = false;
            const downE = e;
            // 判断点击区域：左1/5=聚焦开启，右1/5=绕过静音，中间=简单切换
            const headerRect = headerEl.getBoundingClientRect();
            const relX = e.clientX - headerRect.left;
            const isLeftFifth = relX < (headerRect.width / 5);
            const isRightFifth = relX > (headerRect.width * 4 / 5);
            const onMove = ev => {
                if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) {
                    if (group.locked) return;
                    dragged = true;
                    document.removeEventListener('mousemove', onMove);
                    // Ctrl+拖动标题栏：仅移动框体，节点不跟随
                    self.startDrag(group.id, downE, !!downE.ctrlKey);
                }
            };
            document.addEventListener('mousemove', onMove);
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                // Ctrl 留给「仅拖框体」，不触发绕过；普通点击才绕过/开启
                if (!dragged && !downE.ctrlKey) {
                    if (isLeftFifth) {
                        self.toggleBypassUnified(group.id);
                    } else if (isRightFifth) {
                        self.toggleBypassMute(group.id);
                    } else {
                        self.toggleBypass(group.id);
                    }
                }
            };
            document.addEventListener('mouseup', onUp, { once: true });
        });

        // 右键标题栏任意位置 → 设置（排除删除按钮）
        headerEl.addEventListener('contextmenu', e => {
            if (e.target.closest('.xzg-delete-btn') || e.target.closest('.xzg-lock-btn')) return;
            e.preventDefault(); e.stopPropagation();
            self.openSettings(group);
        });
        // 滚轮缩放
        headerEl.addEventListener('wheel', e => {
            e.preventDefault(); e.stopPropagation();
            const cv = app?.canvas;
            if (!cv?.ds) return;
            const d = e.deltaY > 0 ? -1 : 1;
            const ns = cv.ds.scale * (1 + d * 0.1);
            if (ns < 0.1 || ns > 10) return;
            const rc = cv.canvas.getBoundingClientRect();
            cv.ds.changeScale(ns, [e.clientX - rc.left, e.clientY - rc.top]);
            cv.setDirty(true, true);
        });

        // 调整大小手柄
        const resizeHandle = el.querySelector('.xzg-resize-handle');
        resizeHandle.addEventListener('mousedown', e => {
            // 鼠标中键 → 透传到画布以支持画布平移
            if (e.button === 1) {
                e.preventDefault();
                e.stopPropagation();
                const el2 = e.currentTarget;
                el2.style.pointerEvents = 'none';
                self._dispatchMiddleDown(e.clientX, e.clientY);
                const restore = () => {
                    el2.style.pointerEvents = 'auto';
                    document.removeEventListener('mouseup', restore);
                };
                document.addEventListener('mouseup', restore);
                return;
            }
            e.stopPropagation(); e.preventDefault();
            self.startResize(group.id, e);
        });
        resizeHandle.addEventListener('wheel', e => {
            e.preventDefault();
            const cv = app?.canvas;
            if (!cv?.ds) return;
            const d = e.deltaY > 0 ? -1 : 1;
            const ns = cv.ds.scale * (1 + d * 0.1);
            if (ns < 0.1 || ns > 10) return;
            const rc = cv.canvas.getBoundingClientRect();
            cv.ds.changeScale(ns, [e.clientX - rc.left, e.clientY - rc.top]);
            cv.setDirty(true, true);
        }, { passive: false });

        return el;
    },

    // HSL ↔ Hex 转换
    hslToHex(h, s, l) {
        s /= 100; l /= 100;
        const a = s * Math.min(l, 1 - l);
        const f = n => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1))); };
        return '#' + [0,8,4].map(n => f(n).toString(16).padStart(2,'0')).join('');
    },
    hexToHsl(hex) {
        let r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
        const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
        let h = 0, s = 0, l = (mx + mn) / 2;
        if (mx !== mn) {
            const d = mx - mn;
            s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
            if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (mx === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h = Math.round(h * 60);
        }
        return { h, s: Math.round(s * 100), l: Math.round(l * 100) };
    },

    /* ── 上次标题配置存取（颜色/大小/炫彩/背景/辉光等继承） ── */
    getLastTitleConfig() {
        const defaults = {
            fontSize: 20,
            colorHue: 48, colorSat: 100, colorLit: 55,
            effect: 'none', effectSpeed: 3,
            borderWidth: 2, borderOpacity: 1,
            headerBgColor: 'rgba(0,0,0,0.4)',
            titleColor: '#FFD700',
            fadeEnabled: true,
            fadeInDuration: 1000
        };
        try {
            const saved = localStorage.getItem('xzg_last_title_config');
            if (saved) return Object.assign({}, defaults, JSON.parse(saved));
        } catch (e) {}
        return defaults;
    },

    saveLastTitleConfig(group) {
        try {
            const cfg = {
                fontSize: group.fontSize,
                colorHue: group.colorHue, colorSat: group.colorSat, colorLit: group.colorLit,
                effect: group.effect, effectSpeed: group.effectSpeed,
                borderWidth: group.borderWidth, borderOpacity: group.borderOpacity,
                headerBgColor: group.headerBgColor,
                titleColor: group.titleColor,
                fadeEnabled: group.fadeEnabled,
                fadeInDuration: group.fadeInDuration
            };
            localStorage.setItem('xzg_last_title_config', JSON.stringify(cfg));
        } catch (e) {}
    },

    /* ── 设置弹窗 ── */
    openSettings(group) {
        const self = this;
        const gid = group.id;

        // 保存快照，防止取消后仍未还原
        const _snapshot = {
            title: group.title,
            fontSize: group.fontSize,
            titleColor: group.titleColor,
            headerBgColor: group.headerBgColor,
            colorHue: group.colorHue, colorSat: group.colorSat, colorLit: group.colorLit,
            effect: group.effect, effectSpeed: group.effectSpeed,
            borderWidth: group.borderWidth, borderOpacity: group.borderOpacity
        };
        const revertSnapshot = () => {
            Object.assign(group, {
                title: _snapshot.title,
                fontSize: _snapshot.fontSize,
                titleColor: _snapshot.titleColor,
                headerBgColor: _snapshot.headerBgColor,
                colorHue: _snapshot.colorHue, colorSat: _snapshot.colorSat, colorLit: _snapshot.colorLit,
                effect: _snapshot.effect, effectSpeed: _snapshot.effectSpeed,
                borderWidth: _snapshot.borderWidth, borderOpacity: _snapshot.borderOpacity
            });
            // 重建 DOM 恢复视觉状态
            this.rebuildGroupEl(group);
            app.graph?.setDirtyCanvas?.(true, true);
        };

        // 移除已有弹窗
        const old = document.querySelector('.xzg-settings-modal');
        if (old) old.remove();

        const modal = document.createElement('div');
        modal.className = 'xzg-settings-modal';
        modal.style.cssText = `position:fixed;left:0;top:0;background:#1e1e1e;border:1px solid rgba(255,255,255,0.15);border-radius:10px;padding:0 16px 16px 16px;z-index:9999;min-width:300px;max-width:calc(100vw - 20px);max-height:calc(100vh - 20px);overflow-y:auto;box-shadow:0 0 20px rgba(0,0,0,0.8);visibility:hidden;`;
        const curH = group.colorHue || 48, curS = group.colorSat ?? 100, curL = group.colorLit ?? 55;

        const curKey = this.shortcutKey || 'g';
        const initRgba = group.headerBgColor || 'rgba(0,0,0,0.4)';
        const initAlpha = parseFloat(initRgba.replace(/^rgba?\([\d,.\s]+,\s*([\d.]+)\)$/,'$1')) || 0.4;
        const initHex = (() => {
            const m = initRgba.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
            if (m) return '#' + [m[1],m[2],m[3]].map(x => parseInt(x).toString(16).padStart(2,'0')).join('');
            return '#000000';
        })();
        modal.innerHTML = `
            <div class="xzg-modal-drag-handle" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0 8px 0;margin-bottom:12px;cursor:move;user-select:none;">
                <span style="color:#fff;font-size:16px;font-weight:600;">编组设置</span>
                <div style="display:flex;align-items:center;gap:6px;cursor:default;">
                    <span style="color:#fff;font-size:12px;">快捷键</span>
                    <span style="color:#aaa;font-size:12px;">Ctrl +</span>
                    <input class="xzg-set-shortcut" value="${curKey}" maxlength="1" style="width:40px;height:24px;padding:0 4px;background:#2a2a2a;border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#fff;font-size:12px;text-align:center;text-transform:uppercase;box-sizing:border-box;cursor:text;">
                </div>
            </div>
            <div style="margin-bottom:12px;">
                <label style="color:#ff8c00;font-size:14px;display:block;margin-bottom:8px;font-weight:600;">标题栏设置</label>
                <div style="display:flex;align-items:center;gap:8px;height:28px;margin-bottom:8px;">
                    <label style="color:#fff;font-size:12px;flex-shrink:0;white-space:nowrap;width:72px;">名称</label>
                    <input class="xzg-set-title" value="${group.title}" style="flex:1;height:28px;padding:0 8px;background:#2a2a2a;border:1px solid rgba(255,255,255,0.08);border-radius:4px;color:#fff;font-size:12px;box-sizing:border-box;">
                    <div style="width:72px;flex-shrink:0;"></div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;height:28px;margin-bottom:8px;">
                    <label style="color:#fff;font-size:12px;flex-shrink:0;white-space:nowrap;width:72px;">文字大小</label>
                    <input class="xzg-set-fontsize" type="range" min="6" max="48" value="${group.fontSize || 20}" style="flex:1;height:28px;margin:0;">
                    <div style="width:72px;flex-shrink:0;display:flex;align-items:center;justify-content:flex-start;gap:6px;height:28px;">
                        <span class="xzg-set-fs-val" style="color:#fff;font-size:12px;width:28px;text-align:left;">${group.fontSize || 20}</span>
                        <div class="xzg-title-color-swatch" style="width:22px;height:22px;border-radius:4px;cursor:pointer;background:${group.titleColor || '#FFD700'};border:1px solid rgba(255,255,255,0.2);flex-shrink:0;"></div>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;height:28px;margin-bottom:8px;">
                    <label style="color:#fff;font-size:12px;flex-shrink:0;white-space:nowrap;width:72px;">行距</label>
                    <input class="xzg-set-lineheight" type="range" min="1" max="3" step="0.1" value="${group.lineHeight ?? 1}" style="flex:1;height:28px;margin:0;">
                    <div style="width:72px;flex-shrink:0;display:flex;align-items:center;justify-content:flex-start;gap:6px;height:28px;">
                        <span class="xzg-set-lh-val" style="color:#fff;font-size:12px;width:28px;text-align:left;">${(group.lineHeight ?? 1).toFixed(1)}</span>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;height:28px;margin-bottom:8px;">
                    <label style="color:#fff;font-size:12px;flex-shrink:0;white-space:nowrap;width:72px;">背景色</label>
                    <div class="xzg-header-color-bar" style="flex:1;height:28px;border-radius:4px;cursor:pointer;background:linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f);border:1px solid rgba(255,255,255,0.2);position:relative;">
                        <input class="xzg-set-headerbgcolor" type="color" value="${initHex}" style="position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;cursor:pointer;">
                    </div>
                    <div style="width:72px;flex-shrink:0;display:flex;align-items:center;justify-content:flex-end;height:28px;">
                        <button class="xzg-reset-headerbg" type="button" style="height:26px;padding:0 10px;background:#3a3a3a;border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#fff;font-size:12px;cursor:pointer;white-space:nowrap;line-height:1;">重置</button>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;height:28px;">
                    <span style="color:#fff;font-size:12px;flex-shrink:0;width:72px;">透明度</span>
                    <input class="xzg-set-headeropacity" type="range" min="0" max="100" value="${Math.round((group.headerBgColor || 'rgba(0,0,0,0.4)').replace(/^rgba?\([\d,.\s]+,\s*([\d.]+)\)$/,'$1') * 100)}" style="flex:1;height:28px;margin:0;">
                    <div style="width:72px;flex-shrink:0;display:flex;align-items:center;justify-content:flex-start;height:28px;">
                        <span class="xzg-header-opacity-val" style="color:#fff;font-size:12px;width:36px;text-align:left;">${Math.round((group.headerBgColor || 'rgba(0,0,0,0.4)').replace(/^rgba?\([\d,.\s]+,\s*([\d.]+)\)$/,'$1') * 100)}%</span>
                    </div>
                </div>
            </div>
            <div style="border-top:1px solid rgba(255,255,255,0.1);margin-bottom:12px;padding-top:0;"></div>
            <div style="margin-bottom:12px;">
                <label style="color:#ff8c00;font-size:14px;display:block;margin-bottom:8px;font-weight:600;">边框设置</label>
                <div style="display:flex;align-items:center;gap:8px;height:28px;margin-bottom:8px;">
                    <label style="color:#fff;font-size:12px;flex-shrink:0;white-space:nowrap;width:72px;">边框颜色</label>
                    <div class="xzg-custom-color-trigger" style="flex:1;height:28px;border-radius:4px;cursor:pointer;background:linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f);border:1px solid rgba(255,255,255,0.2);"></div>
                    <div style="width:72px;flex-shrink:0;"></div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;height:28px;margin-bottom:8px;">
                    <label style="color:#fff;font-size:12px;flex-shrink:0;white-space:nowrap;width:72px;">边框粗细</label>
                    <input class="xzg-set-borderwidth" type="range" min="1" max="10" value="${group.borderWidth||2}" style="flex:1;height:28px;margin:0;">
                    <div style="width:72px;flex-shrink:0;display:flex;align-items:center;justify-content:flex-start;height:28px;">
                        <span class="xzg-set-bw-val" style="color:#fff;font-size:12px;text-align:left;">${group.borderWidth||2}px</span>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;height:28px;margin-bottom:8px;">
                    <label style="color:#fff;font-size:12px;flex-shrink:0;white-space:nowrap;width:72px;">边框透明度</label>
                    <input class="xzg-set-borderopacity" type="range" min="5" max="100" value="${Math.round((group.borderOpacity??1)*100)}" style="flex:1;height:28px;margin:0;">
                    <div style="width:72px;flex-shrink:0;display:flex;align-items:center;justify-content:flex-start;height:28px;">
                        <span class="xzg-set-bo-val" style="color:#fff;font-size:12px;text-align:left;">${Math.round((group.borderOpacity??1)*100)}%</span>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;height:28px;margin-bottom:8px;">
                    <label style="color:#fff;font-size:12px;flex-shrink:0;white-space:nowrap;width:72px;">边框动画</label>
                    <select class="xzg-set-effect" style="flex:1;height:28px;padding:0 8px;background:#2a2a2a;border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#fff;font-size:12px;box-sizing:border-box;">
                        <option value="none" ${!group.effect||group.effect==='none'?'selected':''}>无</option>
                        <option value="rainbow" ${group.effect==='rainbow'?'selected':''}>渐变彩虹</option>
                        <option value="pulse" ${group.effect==='pulse'?'selected':''}>明暗呼吸</option>
                        <option value="glow" ${group.effect==='glow'?'selected':''}>辉光</option>
                        <option value="marquee" ${group.effect==='marquee'?'selected':''}>流光溢彩</option>
                        <option value="marqueebreathe" ${group.effect==='marqueebreathe'?'selected':''}>流光溢彩+明暗呼吸</option>
                    </select>
                    <div style="width:72px;flex-shrink:0;"></div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;height:28px;">
                    <label style="color:#fff;font-size:12px;flex-shrink:0;white-space:nowrap;width:72px;">动画速度</label>
                    <input class="xzg-set-speed" type="range" min="1" max="10" value="${group.effectSpeed||3}" style="flex:1;height:28px;margin:0;">
                    <div style="width:72px;flex-shrink:0;display:flex;align-items:center;justify-content:flex-start;height:28px;">
                        <span class="xzg-set-spd-val" style="color:#fff;font-size:12px;text-align:left;">${group.effectSpeed||3}</span>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;height:28px;margin-top:8px;">
                    <label style="color:#fff;font-size:12px;flex-shrink:0;white-space:nowrap;width:72px;">边框渐入</label>
                    <button type="button" class="xzg-set-fade-toggle" data-checked="${group.fadeEnabled !== false ? 'true' : 'false'}" style="flex-shrink:0;display:flex;align-items:center;gap:6px;height:20px;padding:0 8px;background:transparent;border:none;cursor:pointer;">
                        <span class="xzg-fade-toggle-track" style="width:32px;height:20px;border-radius:10px;background:${group.fadeEnabled !== false ? '#dcc85b' : '#a855f7'};position:relative;transition:background 0.2s;">
                            <span class="xzg-fade-toggle-thumb" style="position:absolute;left:${group.fadeEnabled !== false ? '14px' : '2px'};top:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left 0.2s;"></span>
                        </span>
                        <span class="xzg-fade-toggle-label" style="font-size:12px;font-weight:bold;color:${group.fadeEnabled !== false ? '#FFD700' : '#777'};min-width:20px;">${group.fadeEnabled !== false ? '开' : '关'}</span>
                    </button>
                    <div class="xzg-fade-duration-row" style="display:${group.fadeEnabled !== false ? 'flex' : 'none'};flex:1;align-items:center;gap:8px;height:28px;">
                        <input class="xzg-set-fade-duration" type="range" min="100" max="8000" step="100" value="${group.fadeInDuration ?? 1000}" style="flex:1;height:28px;margin:0;">
                        <div style="width:72px;flex-shrink:0;display:flex;align-items:center;justify-content:flex-start;height:28px;">
                            <span class="xzg-set-fade-val" style="color:#fff;font-size:12px;text-align:left;">${(group.fadeInDuration ?? 1000) / 1000}s</span>
                        </div>
                    </div>
                </div>
            </div>
            <div style="display:flex;gap:8px;justify-content:space-between;padding-top:4px;">
                <div style="display:flex;gap:8px;">
                    <button class="xzg-set-help" type="button" style="height:28px;padding:0 12px;background:transparent;border:none;color:#FFD700;cursor:pointer;font-size:12px;font-weight:bold;">使用说明</button>
                    <button class="xzg-set-apply-all" type="button" style="height:28px;padding:0 12px;background:#665500;border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#FFD700;cursor:pointer;font-size:12px;" title="将颜色和动画应用到所有编组">应用到全部</button>
                </div>
                <div style="display:flex;gap:8px;">
                    <button class="xzg-set-cancel" type="button" style="height:28px;padding:0 16px;background:#333;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">取消</button>
                    <button class="xzg-set-apply" type="button" style="height:28px;padding:0 16px;background:#444;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">应用</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const clampPosition = () => {
            const r = modal.getBoundingClientRect();
            const maxLeft = window.innerWidth - r.width - 10;
            const maxTop = window.innerHeight - r.height - 10;
            let left = parseFloat(modal.style.left) || 0;
            let top = parseFloat(modal.style.top) || 0;
            left = Math.max(10, Math.min(left, maxLeft));
            top = Math.max(10, Math.min(top, maxTop));
            modal.style.left = left + 'px';
            modal.style.top = top + 'px';
        };

        (function makeDraggable(el, handle) {
            let ox, oy, moving = false;
            handle.addEventListener('mousedown', e => {
                if (e.button !== 0) return;
                if (e.target.closest('input, button, select')) return;
                e.preventDefault();
                const r = el.getBoundingClientRect();
                ox = e.clientX - r.left;
                oy = e.clientY - r.top;
                moving = true;
                const onMove = ev => {
                    if (!moving) return;
                    const maxLeft = window.innerWidth - r.width - 10;
                    const maxTop = window.innerHeight - r.height - 10;
                    let nx = ev.clientX - ox;
                    let ny = ev.clientY - oy;
                    nx = Math.max(10, Math.min(nx, maxLeft));
                    ny = Math.max(10, Math.min(ny, maxTop));
                    el.style.left = nx + 'px';
                    el.style.top = ny + 'px';
                };
                const onUp = () => {
                    moving = false;
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        })(modal, modal.querySelector('.xzg-modal-drag-handle'));

        const initLeft = Math.max(10, window.innerWidth - modal.offsetWidth - 20);
        const initTop = Math.max(10, (window.innerHeight - modal.offsetHeight) / 2);
        modal.style.left = initLeft + 'px';
        modal.style.top = initTop + 'px';
        modal.style.visibility = 'visible';
        clampPosition();

        // 边框动画下拉（实时预览）
        const effectSel = modal.querySelector('.xzg-set-effect');
        effectSel.addEventListener('change', () => {
            group.effect = effectSel.value;
            self.updateGroupStyle(group.id);
        });

        // 速度滑块
        const spdR = modal.querySelector('.xzg-set-speed');
        const spdV = modal.querySelector('.xzg-set-spd-val');
        spdR.addEventListener('input', () => {
            spdV.textContent = spdR.value;
            group.effectSpeed = parseInt(spdR.value) || 3;
        });

        // 边框粗细滑块（实时预览）
        const bwR = modal.querySelector('.xzg-set-borderwidth');
        const bwV = modal.querySelector('.xzg-set-bw-val');
        bwR.addEventListener('input', () => {
            bwV.textContent = bwR.value;
            group.borderWidth = parseInt(bwR.value) || 2;
            self.updateGroupStyle(group.id);
        });

        // 边框透明度滑块（实时预览）
        const boR = modal.querySelector('.xzg-set-borderopacity');
        const boV = modal.querySelector('.xzg-set-bo-val');
        boR.addEventListener('input', () => {
            boV.textContent = boR.value;
            group.borderOpacity = (parseInt(boR.value) || 100) / 100;
            self.updateGroupStyle(group.id);
        });

        // 边框渐入开关
        const fadeToggle = modal.querySelector('.xzg-set-fade-toggle');
        const fadeDurationRow = modal.querySelector('.xzg-fade-duration-row');
        const updateFadeToggle = (enabled) => {
            fadeToggle.dataset.checked = enabled ? 'true' : 'false';
            const track = fadeToggle.querySelector('.xzg-fade-toggle-track');
            const thumb = fadeToggle.querySelector('.xzg-fade-toggle-thumb');
            const label = fadeToggle.querySelector('.xzg-fade-toggle-label');
            if (track) track.style.background = enabled ? '#dcc85b' : '#a855f7';
            if (thumb) thumb.style.left = enabled ? '14px' : '2px';
            if (label) {
                label.textContent = enabled ? '开' : '关';
                label.style.color = enabled ? '#FFD700' : '#777';
            }
            if (fadeDurationRow) fadeDurationRow.style.display = enabled ? 'flex' : 'none';
            group.fadeEnabled = enabled;
        };
        fadeToggle.addEventListener('click', () => {
            const isOn = fadeToggle.dataset.checked === 'true';
            updateFadeToggle(!isOn);
        });

        // 渐入时间滑块
        const fadeDurR = modal.querySelector('.xzg-set-fade-duration');
        const fadeDurV = modal.querySelector('.xzg-set-fade-val');
        fadeDurR.addEventListener('input', () => {
            const v = parseInt(fadeDurR.value) || 1000;
            fadeDurV.textContent = (v / 1000).toFixed(1) + 's';
            group.fadeInDuration = v;
        });

        // 标题大小滑块
        const fsR = modal.querySelector('.xzg-set-fontsize');
        const fsV = modal.querySelector('.xzg-set-fs-val');
        fsR.addEventListener('input', () => {
            const v = parseInt(fsR.value) || 20;
            fsV.textContent = v;
            group.fontSize = v;
            const span = self.groupEls[group.id]?.querySelector('.xzg-group-title-text');
            const sc = app?.canvas?.ds?.scale || 1;
            if (span) span.style.fontSize = (v * sc) + 'px';
        });

        // 行距滑块
        const lhR = modal.querySelector('.xzg-set-lineheight');
        const lhV = modal.querySelector('.xzg-set-lh-val');
        if (lhR && lhV) {
            lhR.addEventListener('input', function() {
                const v = parseFloat(this.value) || 1;
                lhV.textContent = v.toFixed(1);
                group.lineHeight = v;
                const span = self.groupEls[group.id]?.querySelector('.xzg-group-title-text');
                if (span) span.style.lineHeight = v;
            });
        }

        // 文字颜色 - 隐藏颜色选择器
        const titleColorPicker = document.createElement('input');
        titleColorPicker.type = 'color';
        titleColorPicker.value = group.titleColor || '#FFD700';
        titleColorPicker.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;padding:0;border:0;opacity:0;';
        modal.appendChild(titleColorPicker);
        const titleColorSwatch = modal.querySelector('.xzg-title-color-swatch');
        if (titleColorSwatch) {
            titleColorSwatch.addEventListener('click', () => titleColorPicker.click());
        }
        titleColorPicker.addEventListener('input', () => {
            const c = titleColorPicker.value;
            titleColorSwatch.style.background = c;
            group.titleColor = c;
            const span = self.groupEls[group.id]?.querySelector('.xzg-group-title-text');
            if (span) span.style.color = c;
        });

        // 隐藏颜色选择器（边框自定义颜色）
        let sel = { h: curH, s: curS, l: curL };
        const hiddenPicker = document.createElement('input');
        hiddenPicker.type = 'color';
        hiddenPicker.value = this.hslToHex(curH, curS, curL);
        hiddenPicker.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;padding:0;border:0;opacity:0;';
        modal.appendChild(hiddenPicker);

        const syncColorFromHSL = (h, s, l) => {
            sel = { h, s, l };
            hiddenPicker.value = this.hslToHex(h, s, l);
            // 实时预览到编组框体
            group.colorHue = h;
            group.colorSat = s;
            group.colorLit = l;
            this.updateGroupStyle(group.id);
        };
        syncColorFromHSL(curH, curS, curL);

        // 七彩条点击→弹出系统颜色选择器
        const colorTrigger = modal.querySelector('.xzg-custom-color-trigger');
        if (colorTrigger) {
            colorTrigger.addEventListener('click', () => hiddenPicker.click());
        }

        // 选色后更新
        hiddenPicker.addEventListener('input', () => {
            const hsl = this.hexToHsl(hiddenPicker.value);
            syncColorFromHSL(hsl.h, hsl.s, hsl.l);
        });

        // 标题栏背景色 - 颜色选择器已在 HTML 中
        const headerColorPicker = modal.querySelector('.xzg-set-headerbgcolor');
        const headerOpacitySlider = modal.querySelector('.xzg-set-headeropacity');
        const headerOpacityVal = modal.querySelector('.xzg-header-opacity-val');
        let headerAlpha = initAlpha;

        // 缓存 header 元素引用
        const groupEl = this.groupEls[group.id];
        const headerEl = groupEl ? groupEl.querySelector('.xzg-group-header') : null;

        const updateHeaderBg = () => {
            const hex = headerColorPicker.value;
            const r = parseInt(hex.slice(1,3),16);
            const g = parseInt(hex.slice(3,5),16);
            const b = parseInt(hex.slice(5,7),16);
            const rgba = `rgba(${r},${g},${b},${headerAlpha})`;
            group.headerBgColor = rgba;
            if (headerEl) headerEl.style.background = rgba;
        };

        headerColorPicker.addEventListener('input', updateHeaderBg);
        headerColorPicker.addEventListener('change', updateHeaderBg);

        // 透明度滑块
        headerOpacitySlider.addEventListener('input', () => {
            headerAlpha = parseInt(headerOpacitySlider.value) / 100;
            headerOpacityVal.textContent = headerOpacitySlider.value + '%';
            updateHeaderBg();
        });

        // 重置按钮
        const resetHeaderBgBtn = modal.querySelector('.xzg-reset-headerbg');
        if (resetHeaderBgBtn) {
            resetHeaderBgBtn.addEventListener('click', () => {
                headerColorPicker.value = '#000000';
                headerAlpha = 0.4;
                headerOpacitySlider.value = 40;
                headerOpacityVal.textContent = '40%';
                updateHeaderBg();
            });
        }

        const applySettings = (targetGroup) => {
            const newTitle = modal.querySelector('.xzg-set-title').value.trim();
            targetGroup.title = newTitle;
            targetGroup.fontSize = parseInt(modal.querySelector('.xzg-set-fontsize').value) || 20;
            targetGroup.colorHue = sel.h; targetGroup.colorSat = sel.s; targetGroup.colorLit = sel.l;
            targetGroup.effect = modal.querySelector('.xzg-set-effect').value;
            targetGroup.effectSpeed = parseInt(modal.querySelector('.xzg-set-speed').value) || 3;
            targetGroup.borderWidth = parseInt(modal.querySelector('.xzg-set-borderwidth').value) || 2;
            targetGroup.borderOpacity = (parseInt(modal.querySelector('.xzg-set-borderopacity').value) || 100) / 100;
            targetGroup.headerBgColor = (() => {
                const hex = headerColorPicker.value;
                const r = parseInt(hex.slice(1,3),16);
                const g = parseInt(hex.slice(3,5),16);
                const b = parseInt(hex.slice(5,7),16);
                return `rgba(${r},${g},${b},${headerAlpha})`;
            })();
            targetGroup.titleColor = titleColorPicker.value || '#FFD700';
            targetGroup.lineHeight = parseFloat(modal.querySelector('.xzg-set-lineheight').value) || 1;
            targetGroup.fadeEnabled = fadeToggle.dataset.checked === 'true';
            targetGroup.fadeInDuration = parseInt(fadeDurR.value) || 1000;
            if (targetGroup.fadeOutDuration === undefined) targetGroup.fadeOutDuration = 0;

            // 快捷键自定义
            const sk = modal.querySelector('.xzg-set-shortcut').value.trim().toLowerCase();
            if (sk && sk.length === 1 && /[a-z]/.test(sk)) {
                this.shortcutKey = sk;
                localStorage.setItem('xzg_shortcut', sk);
            }

            // 标题为空时：重建 header 以隐藏文字；否则只更新文本
            const el = this.groupEls[targetGroup.id];
            if (el) {
                if (!newTitle) {
                    this.rebuildGroupEl(targetGroup);
                } else {
                    delete el._xzgRefs;
                    const sc = app?.canvas?.ds?.scale || 1;
                    const span = el.querySelector('.xzg-group-title-text');
                    if (span) {
                        span.textContent = targetGroup.title;
                        span.style.fontSize = (targetGroup.fontSize * sc) + 'px';
                        span.style.color = targetGroup.titleColor;
                        span.style.display = '';
                    }
                    const header = el.querySelector('.xzg-group-header');
                    if (header) {
                        header.style.height = Math.max(18 * sc, targetGroup.fontSize * sc + 4 * sc) + 'px';
                        header.style.background = targetGroup.headerBgColor || 'rgba(0,0,0,0.4)';
                    }
                    this.updateGroupStyle(targetGroup.id);
                }
            }

            // 标记工作流已修改，触发保存
            app.graph?.setDirtyCanvas?.(true, true);
            app.graph?.change?.();
            this.syncGroupsToExtra();
            // 保存为上次使用的标题配置（供新建编组继承）
            this.saveLastTitleConfig(targetGroup);
        };

        // 点击外部关闭（定义在按钮处理之前，确保 cleanupModal 捕获最新版本）
        modal.addEventListener('mousedown', e => e.stopPropagation());
        let closeOutFn = null;
        const cleanupModal = () => {
            if (closeOutFn) document.removeEventListener('mousedown', closeOutFn);
            if (hiddenPicker && hiddenPicker.parentNode) hiddenPicker.remove();
            if (titleColorPicker && titleColorPicker.parentNode) titleColorPicker.remove();
            if (modal.parentNode) modal.remove();
        };
        closeOutFn = e => { if (!modal.contains(e.target)) { revertSnapshot(); cleanupModal(); } };
        setTimeout(() => document.addEventListener('mousedown', closeOutFn), 50);

        modal.querySelector('.xzg-set-cancel').addEventListener('click', () => {
            revertSnapshot();
            cleanupModal();
        });
        modal.querySelector('.xzg-set-apply').addEventListener('click', () => {
            applySettings(group);
            cleanupModal();
        });

        // 应用到全部
        modal.querySelector('.xzg-set-apply-all').addEventListener('click', () => {
            const effect = modal.querySelector('.xzg-set-effect').value;
            const speed = parseInt(modal.querySelector('.xzg-set-speed').value) || 3;
            const fontSize = parseInt(modal.querySelector('.xzg-set-fontsize').value) || 20;
            const bw = parseInt(modal.querySelector('.xzg-set-borderwidth').value) || 2;
            const bo = (parseInt(modal.querySelector('.xzg-set-borderopacity').value) || 100) / 100;
            const fadeEnabled = fadeToggle.dataset.checked === 'true';
            const fadeInDuration = parseInt(fadeDurR.value) || 1000;
            const headerBgColor = (() => {
                const hex = headerColorPicker.value;
                const r = parseInt(hex.slice(1,3),16);
                const g = parseInt(hex.slice(3,5),16);
                const b = parseInt(hex.slice(5,7),16);
                return `rgba(${r},${g},${b},${headerAlpha})`;
            })();
            for (const [, g2] of Object.entries(this.groups)) {
                if (g2.id === gid) continue;
                g2.colorHue = sel.h; g2.colorSat = sel.s; g2.colorLit = sel.l;
                g2.effect = effect; g2.effectSpeed = speed; g2.fontSize = fontSize;
                g2.borderWidth = bw; g2.borderOpacity = bo;
                g2.headerBgColor = headerBgColor;
                g2.titleColor = titleColorPicker.value || '#FFD700';
                g2.fadeEnabled = fadeEnabled;
                g2.fadeInDuration = fadeInDuration;
                if (g2.fadeOutDuration === undefined) g2.fadeOutDuration = 0;
                this.updateGroupStyle(g2.id);
                const sc = app?.canvas?.ds?.scale || 1;
                const span = this.groupEls[g2.id]?.querySelector('.xzg-group-title-text');
                if (span) {
                    span.style.fontSize = (fontSize * sc) + 'px';
                    span.style.color = titleColorPicker.value || '#FFD700';
                }
                const header = this.groupEls[g2.id]?.querySelector('.xzg-group-header');
                if (header) header.style.background = headerBgColor;
                // 同步渐隐状态：如果关闭了，确保编组可见
                if (!fadeEnabled) {
                    const el = self.groupEls[g2.id];
                    if (el) {
                        el.style.transition = 'none';
                        el.style.opacity = '1';
                    }
                }
            }
            // 标记工作流已修改
            app.graph?.setDirtyCanvas?.(true, true);
            app.graph?.change?.();
            this.syncGroupsToExtra();
            cleanupModal();
        });

        // 使用说明
        modal.querySelector('.xzg-set-help').addEventListener('click', (e) => {
            e.stopPropagation();
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:100001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';
            const box = document.createElement('div');
            box.style.cssText = 'background:#2a2a2a;border:1px solid #555;border-radius:10px;padding:24px 32px;max-width:1000px;box-shadow:0 8px 32px rgba(0,0,0,0.6);color:#ddd;font-size:14px;line-height:2;font-family:Arial,sans-serif;';
            box.innerHTML = `<div style="font-size:16px;font-weight:bold;color:#FFD700;margin-bottom:12px;">小珠光编组功能使用说明</div>
<div style="color:#FFD700;font-weight:bold;">1、基本操作</div>
选中节点 → Ctrl+G：创建编组框，包含所选节点<br>
拖拽编组标题栏或边框：移动编组位置（框体与框内节点一起移动）<br>
Ctrl+拖拽编组标题栏或边框：仅移动框体，框内节点不跟随<br>
拖拽边框右下角：调整编组大小<br>
编组可嵌套：编组框可以包含其他更小的编组框<br>
<div style="color:#FFD700;font-weight:bold;margin-top:8px;">2、同级别反选模式</div>
2.1 点击标题栏左侧 1/5 区域，被点击的编组 开启，同一级别的其他编组全部 绕过<br>
2.2 点击标题栏右侧 1/5 区域，被点击的编组 绕过，同一级别的其他编组全部 开启<br>
2.3 普通点击标题栏：切换当前编组的绕过/开启状态；Ctrl 专用于「仅拖框体」，不触发绕过<br>
<div style="color:#FFD700;font-weight:bold;margin-top:8px;">3、锁定/解锁编组</div>
点击标题栏 🔒 锁图标：锁定/解锁当前编组（锁定后无法拖动和调整大小）<br>
Ctrl+鼠标左键 点击锁图标：一键锁定/解锁所有编组<br>
<div style="color:#FFD700;font-weight:bold;margin-top:8px;">4、执行框内节点</div>
按键盘 F 键：执行当前编组框内的所有节点`;
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            overlay.addEventListener('click', () => overlay.remove());
            box.addEventListener('click', (ev) => ev.stopPropagation());
        });


        // （closeOut 监听已在上面 cleanupModal 中统一管理）

        // 聚焦标题输入
        setTimeout(() => modal.querySelector('.xzg-set-title').focus(), 100);
    },

    /* ── 重命名 ── */
    startRename(gid, span) {
        const group = this.groups[gid];
        if (!group) return;
        const input = document.createElement('input');
        input.value = group.title;
        const sc = app?.canvas?.ds?.scale || 1;
        input.style.cssText = `color:${group.titleColor || '#FFD700'};font-size:${(group.fontSize||20)*sc}px;font-weight:400;background:rgba(0,0,0,0.8);border:1px solid rgba(255,215,0,0.5);border-radius:3px;padding:1px 4px;outline:none;width:120px;`;
        span.replaceWith(input);
        input.focus(); input.select();
        const done = () => {
            const newTitle = input.value.trim();
            group.title = newTitle;
            this.syncGroupsToExtra();
            if (!newTitle) {
                input.replaceWith(span);
                this.rebuildGroupEl(group);
                return;
            }
            const ns = document.createElement('span');
            ns.className = 'xzg-group-title-text';
            ns.style.cssText = `color:${group.titleColor || '#FFD700'};font-size:${(group.fontSize||20)*sc}px;font-weight:400;`;
            ns.textContent = group.title;
            input.replaceWith(ns);
        };
        input.addEventListener('blur', done);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = group.title; input.blur(); } });
    },

    /* ── 拖动框体（节点跟随，自动收纳框内节点）；frameOnly=true 时仅移动框体 ── */
    startDrag(gid, downEv, frameOnly = false) {
        const group = this.groups[gid];
        if (!group?.bounds) return;
        if (group.locked) return;
        const canvas = app?.canvas;
        const graph = app?.graph;
        if (!canvas?.ds || !graph?._nodes) return;

        const scale = canvas.ds.scale || 1;
        const startX = downEv.clientX;
        const startY = downEv.clientY;
        const startBX = group.bounds.x;
        const startBY = group.bounds.y;
        const b = group.bounds;

        // 找到完全位于当前框体内部的子编组（仅限面积更小的编组，大控制小）
        const childGroups = [];
        const groupArea = b.w * b.h;
        for (const [otherGid, otherG] of Object.entries(this.groups)) {
            if (otherGid === gid) continue;
            const ob = otherG.bounds;
            if (!ob) continue;
            const otherArea = ob.w * ob.h;
            if (otherArea >= groupArea) continue; // 小不控制大
            if (this._isFullyContained(b, ob)) {
                childGroups.push(otherG);
            }
        }
        const childGroupIds = new Set(childGroups.map(g => g.id));

        // 收集所有中心点位于当前框体内的节点（多个框体能同时控制同一节点）
        const nodeStarts = [];
        const self = this;
        graph._nodes.forEach(n => {
            if (!n?.pos) return;
            if (self._isNodeCenterInBounds(n, b)) {
                nodeStarts.push({ node: n, x: n.pos[0], y: n.pos[1] });
            }
        });

        // 子编组：收集中心点落在当前框体内的节点（大框体外部的节点不受大框体控制）
        const childGroupData = childGroups.map(cg => ({
            group: cg,
            startX: cg.bounds.x,
            startY: cg.bounds.y,
            nodeStarts: cg.nodeIds.map(nid => {
                const n = graph._nodes.find(x => x.id === nid || x.id == nid);
                if (!n?.pos) return null;
                if (self._isNodeCenterInBounds(n, b)) {
                    return { node: n, x: n.pos[0], y: n.pos[1] };
                }
                return null;
            }).filter(Boolean)
        }));

        // 部分重叠编组（有重叠但未完全位于内部）：不移动编组框，只移动中心点落在当前编组内的节点
        // 只对面积比当前编组小的编组生效（大控制小，小不控制大）
        const partialOverlapNodes = [];
        const childSet = new Set(childGroupIds);
        for (const [otherGid, otherG] of Object.entries(this.groups)) {
            if (childSet.has(otherGid)) continue;
            const ob = otherG.bounds;
            if (!ob) continue;
            const otherArea = ob.w * ob.h;
            if (otherArea >= groupArea) continue;
            if (this._getOverlapRatio(b, ob) > 0 && !this._isFullyContained(b, ob)) {
                otherG.nodeIds.forEach(nid => {
                    const n = graph._nodes.find(x => x.id === nid || x.id == nid);
                    if (!n?.pos) return;
                    if (self._isNodeCenterInBounds(n, b)) {
                        partialOverlapNodes.push({ node: n, x: n.pos[0], y: n.pos[1] });
                    }
                });
            }
        }

        // 捕获编组框内箭头的初始位置快照，拖动时一起移动
        const arrowStarts = window.__xzg_getArrowStartsInBounds?.(b) || [];

        const onMove = e => {
            const dx = (e.clientX - startX) / scale;
            const dy = (e.clientY - startY) / scale;
            group.bounds.x = startBX + dx;
            group.bounds.y = startBY + dy;
            if (frameOnly) {
                // Ctrl+拖动：仅移动编组框，节点/子编组/箭头不跟随
                graph.setDirtyCanvas?.(true, true);
                return;
            }
            nodeStarts.forEach(s => { s.node.pos[0] = s.x + dx; s.node.pos[1] = s.y + dy; });
            // 子编组 bounds 及其所有节点一起跟随移动
            childGroupData.forEach(cg => {
                cg.group.bounds.x = cg.startX + dx;
                cg.group.bounds.y = cg.startY + dy;
                cg.nodeStarts.forEach(s => { s.node.pos[0] = s.x + dx; s.node.pos[1] = s.y + dy; });
            });
            // 部分重叠编组中完全落在大边框内的节点也跟随移动
            partialOverlapNodes.forEach(s => { s.node.pos[0] = s.x + dx; s.node.pos[1] = s.y + dy; });
            // 编组框内的箭头跟随移动
            if (arrowStarts.length > 0) {
                window.__xzg_applyArrowStarts?.(arrowStarts, dx, dy);
            }
            graph.setDirtyCanvas?.(true, true);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            self.syncGroupsToExtra();
            graph.change?.();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    },

    /* ── 调整大小 ── */
    startResize(gid, downEv) {
        const group = this.groups[gid];
        if (!group?.bounds) return;
        if (group.locked) return;

        const canvas = app?.canvas;
        if (!canvas?.ds) return;

        const scale = canvas.ds.scale || 1;
        const startX = downEv.clientX;
        const startY = downEv.clientY;
        const startW = group.bounds.w;
        const startH = group.bounds.h;

        const self = this;
        const onMove = e => {
            const dx = (e.clientX - startX) / scale;
            const dy = (e.clientY - startY) / scale;
            group.bounds.w = Math.max(120, startW + dx);
            group.bounds.h = Math.max(44, startH + dy);
            app.graph?.setDirtyCanvas?.(true, true);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            self.syncGroupsToExtra();
            app.graph?.change?.();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    },

    /* ── 锁定/解锁 ── */
    toggleLock(gid) {
        const g = this.groups[gid];
        if (!g) return;
        g.locked = !g.locked;
        this.updateGroupStyle(gid);
        this.syncGroupsToExtra();
    },

    /* ── 全部锁定/解锁（Ctrl+点击锁图标）── */
    toggleLockAll(gid) {
        const g = this.groups[gid];
        if (!g) return;
        const targetLocked = !g.locked; // 以当前编组状态的反值作为目标
        for (const id of Object.keys(this.groups)) {
            this.groups[id].locked = targetLocked;
            this.updateGroupStyle(id);
        }
        this.syncGroupsToExtra();
    },

    /* ── 样式更新 ── */
    updateGroupStyle(gid) {
        const el = this.groupEls[gid];
        const g = this.groups[gid];
        if (!el || !g) return;
        const scale = app?.canvas?.ds?.scale || 1;
        const hasEffect = g.effect && g.effect !== 'none';
        const refs = this._ensureRefs(el);
        const bw = (g.borderWidth || 2) * scale;
        const bo = g.borderOpacity ?? 1;

        if (g.bypassed) {
            el.style.border = `${bw}px solid hsla(280,60%,55%,${bo})`;
            el.style.boxShadow = 'none';
            el.style.borderImage = 'none';
            el.style.background = 'transparent';
            if (refs.title) refs.title.style.color = 'hsla(280,60%,65%,0.85)';
            if (refs.delBtn) refs.delBtn.style.color = `hsla(280,60%,65%,${bo * 0.8})`;
            if (refs.rpath) refs.rpath.setAttribute('stroke', `hsla(280,60%,55%,${bo})`);
            if (refs.leftFifth) refs.leftFifth.style.borderRightColor = 'hsla(280,60%,65%,0.2)';
            if (refs.leftFifthIcon) refs.leftFifthIcon.style.color = 'hsla(280,60%,65%,0.35)';
            if (refs.rightFifth) refs.rightFifth.style.borderLeftColor = 'hsla(280,60%,65%,0.2)';
            if (refs.rightFifthIcon) refs.rightFifthIcon.style.color = 'hsla(280,60%,65%,0.35)';
            if (refs.lockBtn) refs.lockBtn.style.color = g.locked ? '#f44336' : 'hsla(280,60%,65%,0.35)';
        } else {
            const h = g.colorHue ?? 48;
            const s = g.colorSat ?? 100;
            const l = g.colorLit ?? 55;
            if (!hasEffect) el.style.border = `${bw}px solid hsla(${h},${s}%,${l}%,${bo})`;
            el.style.background = 'transparent';
            if (refs.title) {
                if (!hasEffect) {
                    refs.title.style.color = g.titleColor || '#FFD700';
                }
            }
            if (refs.leftFifth) refs.leftFifth.style.borderRightColor = `hsla(${h},${s}%,${l}%,0.2)`;
            if (refs.leftFifthIcon) refs.leftFifthIcon.style.color = `hsla(${h},${s}%,${l}%,0.45)`;
            if (refs.rightFifth) refs.rightFifth.style.borderLeftColor = `hsla(${h},${s}%,${l}%,0.2)`;
            if (refs.rightFifthIcon) refs.rightFifthIcon.style.color = `hsla(${h},${s}%,${l}%,0.45)`;
            if (refs.delBtn) refs.delBtn.style.color = `hsla(${h},${s}%,${l}%,${Math.min(bo + 0.1, 1)})`;
            if (refs.rpath) refs.rpath.setAttribute('stroke', `hsla(${h},${s}%,${l}%,${bo})`);
            if (refs.lockBtn) refs.lockBtn.style.color = g.locked ? '#f44336' : `hsla(${h},${s}%,${l}%,0.35)`;
        }
        // 锁定状态：边框和调整手柄光标变化
        const cursorVal = g.locked ? 'default' : 'move';
        el.querySelectorAll('.xzg-border-left, .xzg-border-right, .xzg-border-bottom').forEach(b => b.style.cursor = cursorVal);
        const rh = el.querySelector('.xzg-resize-handle');
        if (rh) { rh.style.cursor = g.locked ? 'default' : 'nwse-resize'; rh.style.opacity = g.locked ? '0.2' : '0.6'; }
    },

    rebuildAllEls() {
        for (const el of Object.values(this.groupEls)) {
            delete el._xzgRefs;
            el?.parentElement?.removeChild(el);
        }
        this.groupEls = {};
        for (const id of Object.keys(this.groups)) this.renderGroup(id);
    },

    rebuildGroupEl(group) {
        const el = this.groupEls[group.id];
        if (el) {
            delete el._xzgRefs;
            el?.parentElement?.removeChild(el);
            delete this.groupEls[group.id];
        }
        this.renderGroup(group.id);
    },

    /* ── 编组开关面板 ── */
    showTogglePanel() {
        const self = this;
        // 已存在则关闭
        if (this._togglePanel) {
            this._closeTogglePanel();
            return;
        }

        // 如果恢复动画正在运行，立即完成（防止快速重新打开导致保存中途位置）
        if (this._canvasMoveAnim) {
            cancelAnimationFrame(this._canvasMoveAnim);
            this._canvasMoveAnim = null;
            if (this._restoreTarget && canvas?.ds) {
                canvas.ds.offset[0] = this._restoreTarget[0];
                canvas.ds.offset[1] = this._restoreTarget[1];
                canvas.setDirty?.(true, true);
                if (typeof canvas.draw === "function") canvas.draw();
            }
        }

        // 保存打开前的画布位置，用于关闭时恢复
        const canvas = app?.canvas;
        if (canvas?.ds) {
            this._savedCanvasOffset = [canvas.ds.offset[0], canvas.ds.offset[1]];
            this._savedCanvasScale = canvas.ds.scale;
        } else {
            this._savedCanvasOffset = null;
        }

        // 树形排序：父组紧跟其子组（DFS 顺序，父在前子在后）
        const allEntries = Object.entries(this.groups)
            .filter(([_, g]) => g.nodeIds && g.nodeIds.length > 0);
        if (allEntries.length === 0) return;

        // 缓存每个编组的子编组列表
        const childrenMap = {};
        const topLevelGids = [];
        for (const [gid] of allEntries) {
            const pid = this._findParentGroup(gid);
            if (pid) {
                if (!childrenMap[pid]) childrenMap[pid] = [];
                childrenMap[pid].push(gid);
            } else {
                topLevelGids.push(gid);
            }
        }
        // 顶层编组按标题排序
        topLevelGids.sort((a, b) => (this.groups[a].title || '').localeCompare(this.groups[b].title || '', 'zh-CN'));
        // 子编组也按标题排序
        for (const k of Object.keys(childrenMap)) {
            childrenMap[k].sort((a, b) => (this.groups[a].title || '').localeCompare(this.groups[b].title || '', 'zh-CN'));
        }
        // DFS 遍历，父组紧跟其子组
        const orderedGids = [];
        const visited = new Set();
        const walk = (gid) => {
            if (visited.has(gid)) return;
            visited.add(gid);
            orderedGids.push(gid);
            const kids = childrenMap[gid] || [];
            kids.forEach(walk);
        };
        topLevelGids.forEach(walk);
        // 处理孤儿（理论上不会有，兜底）
        for (const [gid] of allEntries) {
            if (!visited.has(gid)) orderedGids.push(gid);
        }
        const groupList = orderedGids.map(gid => [gid, this.groups[gid]]);

        const panel = document.createElement("div");
        panel.id = "xzg-group-toggle-panel";
        // 读取上次拖动位置，无记录则默认屏幕中间
        let savedPos = null;
        try { savedPos = JSON.parse(localStorage.getItem('xzg_toggle_panel_pos') || 'null'); } catch(e) {}
        const PANEL_W = 285; // 面板预估宽度，用于居中计算
        const PANEL_H = 420; // 面板预估高度，用于居中计算
        const posLeft = savedPos?.left ?? Math.round(window.innerWidth / 2 - PANEL_W / 2);
        const posTop = savedPos?.top ?? Math.round(window.innerHeight / 2 - PANEL_H / 2);
        panel.style.cssText = `
            position: fixed; left:${posLeft}px; top:${posTop}px; z-index: 100001;
            background: var(--comfy-menu-bg, #1e1e1e);
            border: 1px solid var(--border-color, #333);
            border-radius: 10px; padding: 10px 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            font-size: 14px; color: var(--input-text, #ddd);
            min-width: 240px; max-width: 375px; max-height: 80vh;
            display: flex; flex-direction: column; gap: 8px;
            user-select: none; -webkit-user-select: none;
            animation: xzgPanelFadeIn 0.2s ease-out;
        `;

        // 标题栏 + 快捷按钮（合并为一行，更紧凑）
        const header = document.createElement("div");
        header.style.cssText = "display:flex;align-items:center;gap:10px;padding:2px 4px;";
        header.innerHTML = `<span style="font-weight:bold;color:#dcc85b;font-size:15px;white-space:nowrap;">📦 ${xzgT('编组开关','Group Toggles')}</span>`;
        // 快捷键显示与设置按钮（点击可自定义快捷键），放在标题栏最右侧
        const shortcutTip = document.createElement("span");
        shortcutTip.style.cssText = "font-size:11px;opacity:0.6;cursor:pointer;text-decoration:underline dotted;margin-left:auto;";
        const updateShortcutTip = () => {
            const ts = self.toggleShortcut || { key: 'b', ctrl: false, alt: false, shift: false, meta: false };
            const parts = [];
            if (ts.ctrl) parts.push('Ctrl');
            if (ts.alt) parts.push('Alt');
            if (ts.shift) parts.push('Shift');
            if (ts.meta) parts.push('Meta');
            parts.push(ts.key.toUpperCase());
            shortcutTip.textContent = xzgT('快捷键','Shortcut') + ': ' + parts.join('+');
        };
        updateShortcutTip();
        shortcutTip.title = xzgT('点击设置快捷键','Click to set shortcut');
        shortcutTip.addEventListener('click', () => self.showToggleShortcutDialog());
        header.appendChild(shortcutTip);

        // 全部开启、全部绕过：金色边框 + 金色文字（无底色）
        const btnStyle = "padding:4px 10px;border:1px solid #dcc85b;border-radius:6px;cursor:pointer;font-size:12px;text-align:center;background:transparent;color:#dcc85b;line-height:1.4;box-sizing:border-box;";
        const allOnBtn = document.createElement("div");
        allOnBtn.textContent = xzgT('全部开启','All Active');
        allOnBtn.style.cssText = btnStyle;
        const allOffBtn = document.createElement("div");
        allOffBtn.textContent = xzgT('全部绕过','All Bypass');
        allOffBtn.style.cssText = btnStyle;

        // ── Tab 切换：「编组列表」（主）|「隐藏组」：无边框，白色文字，无底色 ──
        let currentTab = 'main'; // 'main' 或 'hidden'
        // 基础 tab 样式：无边框、无背景、白色文字
        const tabBtnStyle = "padding:4px 10px;border:none;border-radius:0;cursor:pointer;font-size:13px;text-align:center;line-height:1.4;box-sizing:border-box;white-space:nowrap;background:transparent;color:#ffffff;letter-spacing:0.5px;";
        // 激活态：当前选中 tab 下划线/加粗高亮（无边框无底色前提下的视觉区分）
        const tabActiveStyle = ";font-weight:bold;border-bottom:2px solid #dcc85b;color:#ffffff;padding-bottom:2px;";
        // 未激活态：降半透明，纯文本样式
        const tabInactiveStyle = ";opacity:0.75;";
        const tabMain = document.createElement("div");
        tabMain.textContent = xzgT('编组列表','Groups');
        tabMain.style.cssText = tabBtnStyle + tabActiveStyle;
        const tabHidden = document.createElement("div");
        const countHidden = () => Object.values(self.groups).filter(g => g && g.nodeIds && g.nodeIds.length > 0 && !!g.hidden).length;
        const syncTabLabels = () => {
            const hc = countHidden();
            tabMain.textContent = xzgT('编组列表','Groups');
            tabHidden.textContent = xzgT('隐藏组','Hidden') + (hc > 0 ? ` (${hc})` : '');
            tabMain.style.cssText = tabBtnStyle + (currentTab === 'main' ? tabActiveStyle : tabInactiveStyle);
            tabHidden.style.cssText = tabBtnStyle + (currentTab === 'hidden' ? tabActiveStyle : tabInactiveStyle);
        };
        syncTabLabels();
        tabMain.addEventListener('click', () => { currentTab = 'main'; syncTabLabels(); rebuildList(); });
        tabHidden.addEventListener('click', () => { currentTab = 'hidden'; syncTabLabels(); rebuildList(); });

        // 第 1 行：Tab 切换（编组列表 | 隐藏组）居中显示，独立一行
        const tabRow = document.createElement("div");
        tabRow.style.cssText = "display:flex;align-items:center;justify-content:center;gap:10px;padding:0 4px 2px 4px;";
        tabRow.appendChild(tabMain);
        tabRow.appendChild(tabHidden);

        // 分割线：Tab 行 与 按钮行 之间加横向分割线（全宽 1px，半透明金色）
        const divider = document.createElement("div");
        divider.style.cssText = "height:1px;flex-shrink:0;background:linear-gradient(90deg, transparent, rgba(220,200,91,0.35), transparent);margin:2px 0 4px 0;";

        // 第 2 行：操作按钮（全部开启 | 全部绕过）另起一行，靠左，紧凑
        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;align-items:center;gap:8px;padding:0 4px;";
        btnRow.appendChild(allOnBtn);
        btnRow.appendChild(allOffBtn);

        panel.appendChild(header);
        panel.appendChild(tabRow);
        panel.appendChild(divider);
        panel.appendChild(btnRow);

        // 编组列表
        const listContainer = document.createElement("div");
        listContainer.style.cssText = "display:flex;flex-direction:column;gap:4px;overflow-y:auto;max-height:50vh;";
        panel.appendChild(listContainer);

        // 辅助：根据当前 tab 筛选 + 重新排序（重走 DFS，保持父子顺序）
        const getFilteredOrderedGids = () => {
            const allEntries = Object.entries(self.groups)
                .filter(([_, g]) => g.nodeIds && g.nodeIds.length > 0);
            const childrenMap = {};
            const topLevelGids = [];
            for (const [gid] of allEntries) {
                const pid = self._findParentGroup(gid);
                if (pid) {
                    if (!childrenMap[pid]) childrenMap[pid] = [];
                    childrenMap[pid].push(gid);
                } else {
                    topLevelGids.push(gid);
                }
            }
            topLevelGids.sort((a, b) => (self.groups[a].title || '').localeCompare(self.groups[b].title || '', 'zh-CN'));
            for (const k of Object.keys(childrenMap)) {
                childrenMap[k].sort((a, b) => (self.groups[a].title || '').localeCompare(self.groups[b].title || '', 'zh-CN'));
            }
            const orderedGids = [];
            const visited = new Set();
            const walk = (gid) => {
                if (visited.has(gid)) return;
                visited.add(gid);
                orderedGids.push(gid);
                const kids = childrenMap[gid] || [];
                kids.forEach(walk);
            };
            topLevelGids.forEach(walk);
            for (const [gid] of allEntries) if (!visited.has(gid)) orderedGids.push(gid);
            // 按 tab 过滤：
            //   main tab：显示所有 hidden===false 的组（父隐藏时，子在主列表也显示？用户要求隐藏后不在列表里显示
            //   —— 按标题要求："该组不在编组列表里显示"，所以严格按单组 g.hidden 判断）
            return orderedGids.filter(gid => currentTab === 'main' ? !self.groups[gid].hidden : !!self.groups[gid].hidden);
        };

        const rebuildList = () => {
            while (listContainer.firstChild) listContainer.removeChild(listContainer.firstChild);
            toggleItems.length = 0;

            const filteredGids = getFilteredOrderedGids();
            if (filteredGids.length === 0) {
                const empty = document.createElement("div");
                empty.style.cssText = "padding:16px;text-align:center;font-size:12px;opacity:0.55;";
                empty.textContent = currentTab === 'main'
                    ? xzgT('暂无编组，或全部已隐藏', 'No groups visible')
                    : xzgT('暂无隐藏编组', 'No hidden groups');
                listContainer.appendChild(empty);
                return;
            }

            for (let idx = 0; idx < filteredGids.length; idx++) {
                const gid = filteredGids[idx];
                const g = self.groups[gid];
                if (!g) continue;
                const depth = self._getGroupDepth(gid);
                const isBypassed = g.bypassed;
                const hhue = g.colorHue ?? 48;
                const ssat = g.colorSat ?? 100;
                const llit = g.colorLit ?? 55;

                const item = document.createElement("div");
                item.style.cssText = `
                    display:flex;align-items:center;gap:8px;padding:8px 10px;
                    border-radius:6px;cursor:pointer;
                    padding-left:${10 + depth * 16}px;
                    transition: background 0.15s;
                `;
                item.addEventListener("mouseenter", () => {
                    item.style.background = 'rgba(255,255,255,0.06)';
                    self._flashGroup(gid, item);
                });
                item.addEventListener("mouseleave", () => { item.style.background = ''; self._stopFlashGroup(); });

                // 竖杠组（层级指示，数量=depth+1）
                const bars = document.createElement("div");
                bars.style.cssText = "display:flex;align-items:center;gap:3px;height:14px;flex-shrink:0;";
                const barCount = depth + 1;
                for (let i = 0; i < barCount; i++) {
                    const bar = document.createElement("div");
                    bar.style.cssText = `width:4px;height:100%;border-radius:1px;background:#dcc85b;`;
                    bars.appendChild(bar);
                }

                // 👁️ 图标（主 tab）：点击把当前组移到隐藏 tab
                //     ↩️ 恢复图标（隐藏 tab）：点击移回主 tab
                const iconBtn = document.createElement("div");
                iconBtn.style.cssText = `
                    width:22px;height:22px;flex-shrink:0;
                    display:flex;align-items:center;justify-content:center;
                    font-size:14px;border-radius:5px;
                    border:1px solid transparent;
                    transition:all 0.15s;cursor:pointer;
                    user-select:none;
                `;
                const syncIcon = () => {
                    if (currentTab === 'main') {
                        iconBtn.textContent = '👁️';
                        iconBtn.title = xzgT('隐藏该编组', 'Hide this group');
                        iconBtn.style.color = '';
                    } else {
                        iconBtn.textContent = '↩️';
                        iconBtn.title = xzgT('恢复编组到主列表', 'Restore group to main list');
                    }
                };
                syncIcon();
                iconBtn.addEventListener("mouseenter", () => {
                    iconBtn.style.background = 'rgba(220,200,91,0.18)';
                    iconBtn.style.borderColor = 'rgba(220,200,91,0.5)';
                });
                iconBtn.addEventListener("mouseleave", () => {
                    iconBtn.style.background = '';
                    iconBtn.style.borderColor = 'transparent';
                });
                iconBtn.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    // 切换 hidden
                    g.hidden = !g.hidden;
                    self.syncGroupsToExtra();
                    app?.graph?.setDirtyCanvas?.(true, true);
                    app?.graph?.change?.();
                    // 若主 tab 父被隐藏且 currentTab 仍为 main，子组是否仍隐藏也跟随父？
                    //   —— 用户要求是「该组不在主列表显示」，所以只动当前组的 hidden。
                    syncTabLabels();
                    rebuildList();
                });

                // 标题
                const label = document.createElement("div");
                label.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;";
                label.textContent = g.title || xzgT('未命名','Untitled');
                label.title = g.title || '';

                // 开关（仅在主 tab 可操作；隐藏 tab 也保留显示，方便预览，但点击不生效，用视觉弱化）
                const toggle = document.createElement("div");
                const updateToggle = (bypassed) => {
                    const on = !bypassed;
                    toggle.style.cssText = `
                        width:36px;height:20px;border-radius:10px;flex-shrink:0;
                        background:#353535;
                        position:relative;transition:background 0.2s;
                    `;
                    toggle.innerHTML = `<div style="
                        position:absolute;top:3px;left:${on ? '19px' : '3px'};
                        width:14px;height:14px;border-radius:50%;background:${bypassed ? '#a855f7' : '#dcc85b'};
                        transition:left 0.2s;
                    "></div>`;
                    bars.querySelectorAll(':scope > div').forEach(b => b.style.background = '#dcc85b');
                    label.style.color = bypassed ? 'hsla(280,60%,65%,0.9)' : '';
                    label.style.textDecoration = bypassed ? 'line-through' : '';
                    label.style.textDecorationColor = bypassed ? '#FF4444' : '';
                    label.style.textDecorationThickness = bypassed ? '1px' : '';
                    if (currentTab === 'hidden') {
                        // 隐藏 tab 下，开关禁用视觉（降透明度），并阻止点击冒泡的 bypass 切换
                        toggle.style.opacity = '0.45';
                        toggle.style.pointerEvents = 'none';
                    }
                };
                updateToggle(isBypassed);

                item.addEventListener("click", (ev) => {
                    if (currentTab === 'hidden') return; // 隐藏 tab 不触发 bypass 切换
                    self.toggleBypass(gid);
                    // 更新所有子编组的开关状态（层级联动）
                    const childIds = self._collectChildGroups(gid).filter(id => id !== gid);
                    const allIds = [gid, ...childIds];
                    toggleItems.forEach(({ gid: tgid, updateToggle: ut }) => {
                        if (allIds.includes(tgid)) {
                            ut(self.groups[tgid]?.bypassed);
                        }
                    });
                });

                // 防止用户直接点 toggle 时又触发外层（保持与之前一致）
                toggle.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    item.dispatchEvent(new MouseEvent("click", { bubbles: false }));
                });

                item.appendChild(bars);
                item.appendChild(iconBtn);
                item.appendChild(label);
                item.appendChild(toggle);
                listContainer.appendChild(item);
                toggleItems.push({ gid, updateToggle });
            }
        };

        const toggleItems = [];
        rebuildList();

        // 全部开启 / 全部绕过：作用范围 = 当前 tab 里的编组
        allOnBtn.addEventListener("click", () => {
            const filteredGids = getFilteredOrderedGids();
            filteredGids.forEach(gid => {
                const g = self.groups[gid];
                if (g && g.bypassed) self.toggleBypass(gid);
            });
            toggleItems.forEach(({ gid, updateToggle }) => {
                updateToggle(self.groups[gid]?.bypassed);
            });
        });

        allOffBtn.addEventListener("click", () => {
            const filteredGids = getFilteredOrderedGids();
            filteredGids.forEach(gid => {
                const g = self.groups[gid];
                if (g && !g.bypassed) self.toggleBypass(gid);
            });
            toggleItems.forEach(({ gid, updateToggle }) => {
                updateToggle(self.groups[gid]?.bypassed);
            });
        });

        // 面板可拖拽（整个标题栏区域含面板顶部 padding 均可拖动）
        let dragging = false, dragOX = 0, dragOY = 0;
        header.style.cursor = 'move';
        const onMove = (e) => {
            if (!dragging) return;
            let newLeft = e.clientX - dragOX;
            let newTop = e.clientY - dragOY;
            // 限制面板不被拖出屏幕
            newLeft = Math.max(0, Math.min(window.innerWidth - 80, newLeft));
            newTop = Math.max(0, Math.min(window.innerHeight - 40, newTop));
            panel.style.left = `${newLeft}px`;
            panel.style.top = `${newTop}px`;
            panel.style.right = 'auto';
        };
        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            // 保存拖动位置到 localStorage，下次弹出时使用
            try {
                localStorage.setItem('xzg_toggle_panel_pos', JSON.stringify({
                    left: parseInt(panel.style.left),
                    top: parseInt(panel.style.top)
                }));
            } catch(e) {}
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
        // 拖动区域：面板本身（排除快捷按钮、Tab、分割线、编组列表区域）
        panel.addEventListener("mousedown", (e) => {
            if (allOnBtn.contains(e.target) || allOffBtn.contains(e.target)
             || tabMain.contains(e.target) || tabHidden.contains(e.target)
             || divider.contains(e.target)
             || listContainer.contains(e.target)
             || shortcutTip.contains(e.target)) return;
            dragging = true;
            dragOX = e.clientX - panel.offsetLeft;
            dragOY = e.clientY - panel.offsetTop;
            e.preventDefault();
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });

        // 恢复上次保存的宽度
        const savedWidth = localStorage.getItem('xzg_toggle_panel_width');
        if (savedWidth) {
            panel.style.width = `${savedWidth}px`;
            panel.style.minWidth = 'unset';
            panel.style.maxWidth = 'unset';
        }

        document.body.appendChild(panel);

        // 添加宽度拖动手柄
        const resizer = document.createElement("div");
        resizer.style.cssText = "width:6px;height:100%;position:absolute;right:0;top:0;cursor:ew-resize;z-index:100002;";
        panel.appendChild(resizer);

        let isResizing = false;
        resizer.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            isResizing = true;
            const startX = e.clientX;
            const startWidth = panel.offsetWidth;
            const onMove = (e) => {
                if (!isResizing) return;
                const delta = e.clientX - startX;
                const newWidth = Math.max(200, startWidth + delta);
                panel.style.width = `${newWidth}px`;
                panel.style.minWidth = "unset";
                panel.style.maxWidth = "unset";
            };
            const onUp = () => {
                isResizing = false;
                document.removeEventListener("pointermove", onMove);
                document.removeEventListener("pointerup", onUp);
                localStorage.setItem('xzg_toggle_panel_width', panel.offsetWidth);
            };
            document.addEventListener("pointermove", onMove);
            document.addEventListener("pointerup", onUp);
        });

        // 鼠标离开面板时恢复画布位置
        panel.addEventListener("mouseleave", () => {
            self._stopFlashGroup();
            self._restoreCanvasPosition();
        });

        this._togglePanel = panel;

        // 点击画布空白关闭面板
        const closeHandler = (e) => {
            if (panel.contains(e.target)) return;
            if (e.target.closest(".comfy-node")) return;
            if (e.target.closest(".xzg-menu")) return;
            // 点击画布空白区域（包括 canvas、litegraph 背景等）关闭
            self._closeTogglePanel();
        };
        this._togglePanelCloseHandler = closeHandler;
        setTimeout(() => {
            document.addEventListener("pointerdown", closeHandler, true);
        }, 100);

        // Escape 关闭
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                self._closeTogglePanel();
            }
        };
        this._togglePanelEscHandler = escHandler;
        document.addEventListener("keydown", escHandler);
    },

    _getGroupDepth(gid) {
        let depth = 0;
        let current = gid;
        const visited = new Set();
        while (current && !visited.has(current)) {
            visited.add(current);
            const parent = this._findParentGroup(current);
            if (!parent) break;
            depth++;
            current = parent;
        }
        return depth;
    },

    _restoreCanvasPosition() {
        if (!this._savedCanvasOffset) return;
        const canvas = app?.canvas;
        if (!canvas?.ds) return;
        const targetOX = this._savedCanvasOffset[0];
        const targetOY = this._savedCanvasOffset[1];
        this._restoreTarget = [targetOX, targetOY];
        const startOX = canvas.ds.offset[0];
        const startOY = canvas.ds.offset[1];
        if (Math.abs(startOX - targetOX) > 0.5 || Math.abs(startOY - targetOY) > 0.5) {
            if (this._canvasMoveAnim) { cancelAnimationFrame(this._canvasMoveAnim); this._canvasMoveAnim = null; }
            const animDuration = 700;
            const animStart = performance.now();
            const animateMove = (now) => {
                const t = Math.min((now - animStart) / animDuration, 1);
                const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
                canvas.ds.offset[0] = startOX + (targetOX - startOX) * ease;
                canvas.ds.offset[1] = startOY + (targetOY - startOY) * ease;
                canvas.setDirty?.(true, true);
                if (typeof canvas.draw === "function") canvas.draw();
                if (t < 1) {
                    this._canvasMoveAnim = requestAnimationFrame(animateMove);
                } else {
                    this._canvasMoveAnim = null;
                }
            };
            this._canvasMoveAnim = requestAnimationFrame(animateMove);
        }
        },

    _closeTogglePanel() {
        if (this._togglePanel) {
            this._togglePanel.remove();
            this._togglePanel = null;
        }
        if (this._togglePanelCloseHandler) {
            document.removeEventListener("pointerdown", this._togglePanelCloseHandler, true);
            this._togglePanelCloseHandler = null;
        }
        if (this._togglePanelEscHandler) {
            document.removeEventListener("keydown", this._togglePanelEscHandler);
            this._togglePanelEscHandler = null;
        }
        this._stopFlashGroup();
        this._restoreCanvasPosition();
        this._savedCanvasOffset = null;
    },

    /* ── 编组开关面板快捷键 ── */
    getToggleShortcut() {
        try {
            const stored = localStorage.getItem('xzg_toggle_shortcut');
            if (stored) {
                const sc = JSON.parse(stored);
                if (sc && sc.key) return sc;
            }
        } catch (e) {}
        return { key: 'b', ctrl: false, alt: false, shift: false, meta: false };
    },

    saveToggleShortcut(shortcut) {
        localStorage.setItem('xzg_toggle_shortcut', JSON.stringify(shortcut));
        this.toggleShortcut = shortcut;
    },

    showToggleShortcutDialog() {
        const self = this;
        let pendingShortcut = null;
        const dialog = document.createElement("div");
        dialog.className = "xzg-dialog-overlay";
        // 无遮罩底色，与编组开关面板风格一致
        dialog.style.cssText = "background:transparent;";
        dialog.innerHTML = `
            <div class="xzg-dialog" style="
                background:var(--comfy-menu-bg,#1e1e1e);
                border:1px solid var(--border-color,#333);
                border-radius:10px;
                box-shadow:0 8px 32px rgba(0,0,0,0.5);
                animation:xzgPanelFadeIn 0.2s ease-out;
                min-width:320px;
            ">
                <div class="xzg-dialog-title" style="
                    background:transparent;
                    border-bottom:1px solid rgba(255,255,255,0.1);
                    color:#FFD700;
                    font-size:15px;
                    font-weight:bold;
                    padding:12px 16px;
                    border-radius:10px 10px 0 0;
                ">${xzgT('设置快捷键','Set Shortcut')}</div>
                <div class="xzg-dialog-body">
                    <p style="margin-bottom: 16px; color: #888; font-size: 12px; text-align: center;">${xzgT('请按下你想要的快捷键','Press the shortcut keys you want')}</p>
                    <div style="text-align: center; margin-bottom: 16px;">
                        <div id="xzg-toggle-listen-display" style="
                            padding: 16px 24px;
                            background: #2a2a2a;
                            border: 2px solid #555;
                            border-radius: 6px;
                            color: #FFD700;
                            font-size: 16px;
                            font-weight: bold;
                            min-width: 180px;
                            display: inline-block;
                        ">${xzgT('请按快捷键...','Press keys...')}</div>
                    </div>
                </div>
                <div class="xzg-dialog-footer">
                    <button class="xzg-btn xzg-btn-cancel" id="xzg-toggle-dialog-cancel" type="button">${xzgT('取消','Cancel')}</button>
                    <button class="xzg-btn xzg-btn-ok" id="xzg-toggle-dialog-ok" type="button" disabled>${xzgT('确定','OK')}</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);

        const display = dialog.querySelector("#xzg-toggle-listen-display");
        const okBtn = dialog.querySelector("#xzg-toggle-dialog-ok");
        let isListening = true;
        let keydownHandler = null;

        const cleanup = () => {
            isListening = false;
            document.removeEventListener("keydown", keydownHandler, true);
            dialog.remove();
        };

        const showPreview = (shortcut) => {
            const parts = [];
            if (shortcut.ctrl) parts.push("Ctrl");
            if (shortcut.alt) parts.push("Alt");
            if (shortcut.shift) parts.push("Shift");
            if (shortcut.meta) parts.push("Meta");
            parts.push(shortcut.key.toUpperCase());
            display.textContent = parts.join(" + ");
            display.style.background = "#333";
            display.style.color = "#FFD700";
            display.style.borderColor = "#FFD700";
            okBtn.disabled = false;
        };

        keydownHandler = (e) => {
            if (!isListening) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") return;
            const key = e.key.toLowerCase();
            if (key === "control" || key === "alt" || key === "shift" || key === "meta") return;
            pendingShortcut = {
                key: key,
                ctrl: e.ctrlKey,
                alt: e.altKey,
                shift: e.shiftKey,
                meta: e.metaKey
            };
            showPreview(pendingShortcut);
        };

        document.addEventListener("keydown", keydownHandler, true);

        dialog.querySelector("#xzg-toggle-dialog-cancel").addEventListener("click", () => cleanup());
        okBtn.addEventListener("click", () => {
            if (!pendingShortcut) return;
            self.saveToggleShortcut(pendingShortcut);
            cleanup();
        });
    },

    /* ── 悬停激光连线：从开关项指向画布中的编组 ── */
    _flashGroup(gid, fromEl) {
        this._stopFlashGroup();
        this._flashGroupActive = true;
        const g = this.groups[gid];
        if (!g?.bounds) return;
        const canvas = app?.canvas;
        if (!canvas) return;

        // 检查编组是否在画布可见区域内，不在则平移画布使其居中
        const b = g.bounds;
        const scale = canvas.ds?.scale || 1;
        const canvasEl = canvas.canvas;
        const viewW = canvasEl?.clientWidth || window.innerWidth;
        const viewH = canvasEl?.clientHeight || window.innerHeight;

        // 计算标题栏中心（与 updatePositions 保持一致）
        // 标题栏在编组顶部，中心水平居中
        const fs = (g.fontSize || 20) * scale;
        const headerHeight = Math.max(18 * scale, fs + 4 * scale);
        const extraTop = headerHeight - 18 * scale;
        const cx = b.x + b.w / 2;
        // 标题栏中心Y：b.y + 标题栏可视高度的一半（考虑 extraTop 偏移）
        // 标题栏顶部在屏幕：cRect.top + oy + b.y * scale - extraTop
        // 标题栏中心在屏幕：cRect.top + oy + b.y * scale - extraTop + headerHeight / 2
        // 转为画布坐标：b.y + 18 - headerHeight / (2 * scale)
        const cy = b.y + 18 - headerHeight / (2 * scale);
        // 编组在画布视口中的屏幕位置（用于可见性检测）
        // screenX = (b.x + ds.offset[0]) * scale
        const sx = (b.x + canvas.ds.offset[0]) * scale;
        const sy = (b.y + canvas.ds.offset[1]) * scale;
        const sw = b.w * scale;
        const sh = b.h * scale;
        const margin = 40;
        const outOfView = (sx < margin || sy < margin || sx + sw > viewW - margin || sy + sh > viewH - margin || sw <= 0 || sh <= 0);
        if (outOfView) {
            // 平滑移动画布到目标位置（缓动动画，便于观察位置变化）
            // 居中公式：screenCenter = (cx + ds.offset[0]) * scale = viewW / 2  →  ds.offset[0] = viewW / 2 / scale - cx
            const targetOX = viewW / 2 / scale - cx;
            const targetOY = viewH / 2 / scale - cy;
            const startOX = canvas.ds.offset[0];
            const startOY = canvas.ds.offset[1];
            const animDuration = 700; // ms
            const animStart = performance.now();
            // 取消之前的移动动画
            if (this._canvasMoveAnim) { cancelAnimationFrame(this._canvasMoveAnim); this._canvasMoveAnim = null; }
            const animateMove = (now) => {
                const t = Math.min((now - animStart) / animDuration, 1);
                // ease-in-out cubic
                const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
                canvas.ds.offset[0] = startOX + (targetOX - startOX) * ease;
                canvas.ds.offset[1] = startOY + (targetOY - startOY) * ease;
                canvas.setDirty?.(true, true);
                if (typeof canvas.draw === "function") canvas.draw();
                if (t < 1) {
                    this._canvasMoveAnim = requestAnimationFrame(animateMove);
                } else {
                    this._canvasMoveAnim = null;
                }
            };
            this._canvasMoveAnim = requestAnimationFrame(animateMove);
        }

        // 创建 SVG 覆盖层，绘制激光连线
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:100000;";
        svg.id = "xzg-laser-guide";

        const drawLine = () => {
            // 计算当前编组颜色（与 updateGroupStyle 保持一致）
            const spd = (g.effectSpeed || 3) * 5 / 9;
            const effect = g.effect || 'none';
            let hue, sat, lit;
            if (effect === 'rainbow' || effect === 'marquee' || effect === 'marqueebreathe') {
                const t = (Date.now() / (effect === 'rainbow' ? 4500 : 2500)) * spd;
                hue = (t * 360) % 360;
                sat = effect === 'rainbow' ? 80 : 100;
                lit = effect === 'rainbow' ? 55 : 65;
            } else {
                hue = g.colorHue ?? 48;
                sat = g.colorSat ?? 100;
                lit = g.colorLit ?? 55;
            }
            const color = `hsl(${hue},${sat}%,${lit}%)`;
            const glowFilter = `drop-shadow(0 0 4px hsla(${hue},${sat}%,${lit}%,0.8)) drop-shadow(0 0 12px hsla(${hue},${sat}%,${lit}%,0.4))`;

            // 判断面板位置：左侧还是右侧
            const panel = document.getElementById("xzg-group-toggle-panel");
            const panelRect = panel?.getBoundingClientRect();
            const isLeftSide = panelRect ? (panelRect.left + panelRect.width / 2 < window.innerWidth / 2) : true;

            // 起点：根据面板位置决定
            // 面板在左侧 → 从开关处（右侧）引出
            // 面板在右侧 → 从竖杠处（左侧）引出
            const fromRect = fromEl.getBoundingClientRect();
            const x1 = isLeftSide ? fromRect.right : fromRect.left;
            const y1 = fromRect.top + fromRect.height / 2;
            // 终点：编组标题栏中心（屏幕坐标）
            // screenX = cRect.left + (cx + ds.offset[0]) * scale
            const cRect = canvasEl.getBoundingClientRect();
            const tx = cRect.left + (cx + canvas.ds.offset[0]) * scale;
            const ty = cRect.top + (cy + canvas.ds.offset[1]) * scale;
            // 清空 svg
            while (svg.firstChild) svg.removeChild(svg.firstChild);
            // 激光主线
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", x1);
            line.setAttribute("y1", y1);
            line.setAttribute("x2", tx);
            line.setAttribute("y2", ty);
            line.setAttribute("stroke", color);
            line.setAttribute("stroke-width", "2");
            line.setAttribute("stroke-dasharray", "6 4");
            line.style.filter = glowFilter;
            // 脉冲动画
            const anim = document.createElementNS("http://www.w3.org/2000/svg", "animate");
            anim.setAttribute("attributeName", "stroke-dashoffset");
            anim.setAttribute("from", "0");
            anim.setAttribute("to", "20");
            anim.setAttribute("dur", "0.5s");
            anim.setAttribute("repeatCount", "indefinite");
            line.appendChild(anim);
            svg.appendChild(line);
            // 终点圆环（目标编组指示）
            const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            ring.setAttribute("cx", tx);
            ring.setAttribute("cy", ty);
            ring.setAttribute("r", "8");
            ring.setAttribute("fill", "none");
            ring.setAttribute("stroke", color);
            ring.setAttribute("stroke-width", "2");
            ring.style.filter = glowFilter;
            const ringAnim = document.createElementNS("http://www.w3.org/2000/svg", "animate");
            ringAnim.setAttribute("attributeName", "r");
            ringAnim.setAttribute("values", "6;14;6");
            ringAnim.setAttribute("dur", "1s");
            ringAnim.setAttribute("repeatCount", "indefinite");
            ring.appendChild(ringAnim);
            const ringOpacity = document.createElementNS("http://www.w3.org/2000/svg", "animate");
            ringOpacity.setAttribute("attributeName", "opacity");
            ringOpacity.setAttribute("values", "1;0.3;1");
            ringOpacity.setAttribute("dur", "1s");
            ringOpacity.setAttribute("repeatCount", "indefinite");
            ring.appendChild(ringOpacity);
            svg.appendChild(ring);
            // 只保留终点圆环，无额外小圆点
        };

        drawLine();
        document.body.appendChild(svg);
        // 持续更新（画布可能滚动，连线需跟随）
        this._laserRaf = () => { drawLine(); this._laserTimer = requestAnimationFrame(this._laserRaf); };
        this._laserTimer = requestAnimationFrame(this._laserRaf);
    },

    _stopFlashGroup() {
        this._flashGroupActive = false;
        if (this._laserTimer) {
            cancelAnimationFrame(this._laserTimer);
            this._laserTimer = null;
        }
        // 取消画布移动动画
        if (this._canvasMoveAnim) {
            cancelAnimationFrame(this._canvasMoveAnim);
            this._canvasMoveAnim = null;
        }
        const svg = document.getElementById("xzg-laser-guide");
        if (svg) svg.remove();
    },

    /* ── 旁路 ── */
    toggleBypass(gid) {
        const g = this.groups[gid];
        if (!g) return;
        const graph = app?.graph;
        if (!graph) return;

        const willBypass = !g.bypassed;
        const mode = willBypass ? MODE_BYPASS : MODE_ALWAYS;
        const b = g.bounds;
        const self = this;

        // 1. 完全子编组（完全位于内部）：切换编组状态，只切换中心点落在当前框体内的节点
        const fullChildGroupIds = this._collectChildGroups(gid);
        fullChildGroupIds.forEach(id => {
            const grp = this.groups[id];
            if (!grp) return;
            grp.bypassed = willBypass;
            grp.nodeIds.forEach(nid => {
                const n = graph._nodes.find(x => x.id === nid || x.id == nid);
                if (!n?.pos) return;
                // 只切换中心点落在大框体内的节点（大框体外部的节点不受大框体控制）
                if (self._isNodeCenterInBounds(n, b)) {
                    n.mode = mode;
                }
            });
            this.updateGroupStyle(id);
        });

        // 2. 部分重叠编组（有重叠但未完全位于内部）：不切换编组状态，只切换中心点落在当前编组内的节点
        // 只对面积比当前编组小的编组生效（大控制小，小不控制大）
        const fullSet = new Set(fullChildGroupIds);
        const groupArea = b.w * b.h;
        for (const [otherGid, otherG] of Object.entries(this.groups)) {
            if (fullSet.has(otherGid)) continue;
            const ob = otherG.bounds;
            if (!ob) continue;
            const otherArea = ob.w * ob.h;
            if (otherArea >= groupArea) continue;
            // 有重叠但未完全位于内部
            if (this._getOverlapRatio(b, ob) > 0 && !this._isFullyContained(b, ob)) {
                otherG.nodeIds.forEach(nid => {
                    const n = graph._nodes.find(x => x.id === nid || x.id == nid);
                    if (!n?.pos) return;
                    if (self._isNodeCenterInBounds(n, b)) {
                        n.mode = mode;
                    }
                });
            }
        }

        // 先保存当前状态到 extra，再触发 graph.change（防止 configure 钩子读取旧数据）
        this.syncGroupsToExtra();
        graph.setDirtyCanvas?.(true, true); graph.change?.();
    },

    /* ── 查找指定编组的直接父编组（面积最小且完全包含它的编组） ── */
    _findParentGroup(gid) {
        const g = this.groups[gid];
        if (!g?.bounds) return null;
        const childArea = g.bounds.w * g.bounds.h;

        let parentId = null;
        let parentArea = Infinity;

        for (const [otherGid, otherG] of Object.entries(this.groups)) {
            if (otherGid === gid || !otherG.bounds) continue;
            const otherArea = otherG.bounds.w * otherG.bounds.h;
            if (otherArea <= childArea) continue; // 只找面积更大的
            if (this._isFullyContained(otherG.bounds, g.bounds)) {
                if (otherArea < parentArea) {
                    parentArea = otherArea;
                    parentId = otherGid;
                }
            }
        }
        return parentId;
    },

    /* ── 聚焦模式：点击编组开启，同级其他全部绕过 ── */
    toggleBypassUnified(gid) {
        const graph = app?.graph;
        if (!graph || !this.groups[gid]) return;

        // 被点击的决定开启，同级的全部绕过
        const parentId = this._findParentGroup(gid);

        for (const [otherGid] of Object.entries(this.groups)) {
            // 跳过非同级编组（父编组不同就不是同级）
            if (otherGid !== gid) {
                const otherParent = this._findParentGroup(otherGid);
                if (otherParent !== parentId) continue;
            }

            const isSelf = otherGid === gid;
            const willBypass = !isSelf; // 自身开启，其他绕过
            this._applyBypassRecursive(otherGid, willBypass, graph);
        }

        this.syncGroupsToExtra();
        graph.setDirtyCanvas?.(true, true); graph.change?.();
    },

    /* ── 静音模式：点击编组绕过，同级其他全部开启 ── */
    toggleBypassMute(gid) {
        const graph = app?.graph;
        if (!graph || !this.groups[gid]) return;

        // 被点击的绕过，同级的全部开启
        const parentId = this._findParentGroup(gid);

        for (const [otherGid] of Object.entries(this.groups)) {
            if (otherGid !== gid) {
                const otherParent = this._findParentGroup(otherGid);
                if (otherParent !== parentId) continue;
            }

            const isSelf = otherGid === gid;
            const willBypass = isSelf; // 自身绕过，其他开启
            this._applyBypassRecursive(otherGid, willBypass, graph);
        }

        this.syncGroupsToExtra();
        graph.setDirtyCanvas?.(true, true); graph.change?.();
    },

    /* 递归应用绕过状态到编组及所有子编组 */
    _applyBypassRecursive(gid, willBypass, graph) {
        // _collectChildGroups 返回编组自身 + 所有完全包含的子编组
        const allIds = this._collectChildGroups(gid);
        const mode = willBypass ? MODE_BYPASS : MODE_ALWAYS;
        allIds.forEach(id => {
            const grp = this.groups[id];
            if (!grp) return;
            grp.bypassed = willBypass;
            grp.nodeIds.forEach(nid => {
                const n = graph._nodes.find(x => x.id === nid || x.id == nid);
                if (n) n.mode = mode;
            });
            this.updateGroupStyle(id);
        });
    },

    /* 计算子编组被父编组覆盖的面积比例 (0~1) */
    _getOverlapRatio(parentBounds, childBounds) {
        const x1 = Math.max(parentBounds.x, childBounds.x);
        const y1 = Math.max(parentBounds.y, childBounds.y);
        const x2 = Math.min(parentBounds.x + parentBounds.w, childBounds.x + childBounds.w);
        const y2 = Math.min(parentBounds.y + parentBounds.h, childBounds.y + childBounds.h);
        if (x2 <= x1 || y2 <= y1) return 0;
        const overlap = (x2 - x1) * (y2 - y1);
        const childArea = childBounds.w * childBounds.h;
        return childArea > 0 ? overlap / childArea : 0;
    },

    /* 判断 childBounds 是否完全位于 parentBounds 内部 */
    _isFullyContained(parentBounds, childBounds) {
        return childBounds.x >= parentBounds.x &&
               childBounds.y >= parentBounds.y &&
               childBounds.x + childBounds.w <= parentBounds.x + parentBounds.w &&
               childBounds.y + childBounds.h <= parentBounds.y + parentBounds.h;
    },

    /* 获取节点中心点坐标，直接使用 node.boundingRect 与官方 LiteGraph 逻辑一致 */
    _getNodeCenter(node) {
        if (!node) return null;
        const br = node.boundingRect;
        if (!br || typeof br[0] !== 'number' || typeof br[1] !== 'number' ||
            typeof br[2] !== 'number' || typeof br[3] !== 'number') return null;
        return { x: br[0] + br[2] / 2, y: br[1] + br[3] / 2 };
    },

    _isNodeCenterInBounds(node, bounds) {
        const center = this._getNodeCenter(node);
        if (!center) return false;
        return center.x >= bounds.x && center.x <= bounds.x + bounds.w &&
               center.y >= bounds.y && center.y <= bounds.y + bounds.h;
    },

    /* 计算两个编组框的 IoU（交并比） */
    _getIoU(a, b) {
        const x1 = Math.max(a.x, b.x);
        const y1 = Math.max(a.y, b.y);
        const x2 = Math.min(a.x + a.w, b.x + b.w);
        const y2 = Math.min(a.y + a.h, b.y + b.h);
        if (x2 <= x1 || y2 <= y1) return 0;
        const inter = (x2 - x1) * (y2 - y1);
        const areaA = a.w * a.h;
        const areaB = b.w * b.h;
        const union = areaA + areaB - inter;
        return union > 0 ? inter / union : 0;
    },

    /* ── 辅助：计算编组控制的所有节点（自身节点 + 子编组节点，递归） */
    _collectAllNodeIdsInGroup(gid, visitedGroups = null) {
        if (!this.groups[gid]) return [];
        visitedGroups = visitedGroups || new Set();
        if (visitedGroups.has(gid)) return [];
        visitedGroups.add(gid);

        const nodeIds = [];
        const pushId = (id) => {
            if (id == null) return;
            if (!nodeIds.some(x => this._idEq(x, id))) nodeIds.push(id);
        };
        // 自身 nodeIds
        for (const id of (this.groups[gid].nodeIds || [])) pushId(id);
        // 递归：完全包含在内部的子编组（小不控制大）
        const g = this.groups[gid];
        const gArea = g.bounds ? g.bounds.w * g.bounds.h : 0;
        for (const [childGid, childG] of Object.entries(this.groups)) {
            if (childGid === gid || !childG.bounds) continue;
            const childArea = childG.bounds.w * childG.bounds.h;
            if (gArea > 0 && childArea < gArea && g.bounds && this._isFullyContained(g.bounds, childG.bounds)) {
                for (const id of this._collectAllNodeIdsInGroup(childGid, visitedGroups)) pushId(id);
            }
        }
        return nodeIds;
    },

    /* ── 功能1：所有节点被选中时，编组跟随节点一起移动（增量平移 bounds）
       已禁用：编组不再跟随节点移动。方法保留为空操作以维持调用结构稳定。 */
    _syncSelectedGroupsFollowNodes() {
        // 重置缓存的拖动会话状态，避免残留锁定
        this._nodePosCache = null;
        const s = typeof _XZG_NODE_DRAG_SESSION !== 'undefined' ? _XZG_NODE_DRAG_SESSION : null;
        if (s && s.active) { s.active=false; s.lockedGids.clear(); s.startSelSnapshot=null; s.startTs=0; s.lastMovedTs=0; }
        return;
    },

    _syncSelectedGroupsFollowNodes_DISABLED_ORIGINAL() {
        const c = app?.canvas;
        const graph = app?.graph;
        if (!c?.selected_nodes || !graph?._nodes) return;
        const selMap = c.selected_nodes;
        if (!selMap || typeof selMap !== 'object') return;
        const selIdSet = new Set();
        for (const n of Object.values(selMap)) {
            if (n && n.id != null) selIdSet.add(String(n.id));
        }
        if (selIdSet.size === 0) {
            // 没有选中节点时，缓存+锁定会话一起重置
            this._nodePosCache = null;
            const s = _XZG_NODE_DRAG_SESSION;
            if (s.active) { s.active=false; s.lockedGids.clear(); s.startSelSnapshot=null; s.startTs=0; s.lastMovedTs=0; }
            return;
        }

        // 构建节点位置缓存（第一次建立时不移动，之后帧检测增量）
        const nowPos = new Map();
        for (const idStr of selIdSet) {
            const n = graph._nodes.find(x => String(x.id) === idStr);
            // 兼容 LiteGraph 类数组 pos 对象（不是标准 Array）
            if (n && n.pos && n.pos.length >= 2) {
                nowPos.set(idStr, [Number(n.pos[0]) || 0, Number(n.pos[1]) || 0]);
            }
        }

        const prev = this._nodePosCache;
        if (!prev) {
            this._nodePosCache = nowPos;
            return;
        }

        // ═══════════════════════════════════════════════════════════════
        //  跟随会话锁定：解决"碰到其他节点编组框立即停止跟随"缺陷
        // ═══════════════════════════════════════════════════════════════
        // 1) 未锁定时，按原逻辑重新计算 fullySelectedGids
        // 2) 一旦某个编组"确实发生了位移移动"，把它锁进 lockedGids
        // 3) 后续帧只要会话 active，直接使用 lockedGids 作为 fullySelectedGids，
        //    不再每帧重新判定（从而不受 syncNodeMembership 自动收纳的影响）
        const session = _XZG_NODE_DRAG_SESSION;
        let fullySelectedGids;
        if (session.active && session.lockedGids.size > 0) {
            // 安全兜底：如果选中集合发生了本质变化（用户中途点了别的），解除锁定
            let selChanged = false;
            if (session.startSelSnapshot) {
                if (session.startSelSnapshot.size !== selIdSet.size) selChanged = true;
                else for (const v of session.startSelSnapshot) { if (!selIdSet.has(v)) { selChanged = true; break; } }
            }
            if (selChanged) {
                session.active = false;
                session.lockedGids.clear();
                session.startSelSnapshot = null;
                session.startTs = 0;
                session.lastMovedTs = 0;
            } else {
                fullySelectedGids = [...session.lockedGids].filter(gid => this.groups[gid]?.bounds);
            }
        }
        if (!fullySelectedGids) {
            fullySelectedGids = [];
            for (const [gid, g] of Object.entries(this.groups)) {
                if (!g.bounds) continue;
                const allNodeIds = this._collectAllNodeIdsInGroup(gid);
                if (allNodeIds.length <= 1) continue;
                // 完整性判定基准：使用锁定瞬间的选中快照（若存在），否则当前选中
                const baseSel = session.startSelSnapshot || selIdSet;
                const allSelected = allNodeIds.every(id => baseSel.has(String(id)));
                if (allSelected) fullySelectedGids.push(gid);
            }
        }
        if (fullySelectedGids.length === 0) {
            this._nodePosCache = nowPos;
            return;
        }

        // 计算每个被选中节点的位移增量（dx, dy），选最大范围的那个作为整体位移
        // 实际上：选中的节点整体移动，位移应该是同一个方向。取位移中位数或者第一个被选中节点的位移即可。
        // 为简单稳定：对于每个选中的且同时「属于某个 fullySelected 编组」的节点，计算其 dx/dy，
        // 并对该编组平移相同的 dx/dy（保证嵌套编组正确叠加也可用）
        //
        // 但如果每个编组的节点位移都一样（整体拖动），那每个编组平移一次足够。
        // 用 Map 避免同一个 gid 被多次平移
        const movedGids = new Set();
        let anyChanged = false;
        const nowTs = Date.now();
        for (const [gid, g] of Object.entries(this.groups)) {
            if (!movedGids.has(gid) && fullySelectedGids.includes(gid) && g.bounds) {
                // 计算该编组节点的平均位移
                const allNodeIds = this._collectAllNodeIdsInGroup(gid);
                let sumDx = 0, sumDy = 0, count = 0;
                for (const id of allNodeIds) {
                    const idStr = String(id);
                    const now = nowPos.get(idStr);
                    const old = prev.get(idStr);
                    if (now && old) {
                        sumDx += now[0] - old[0];
                        sumDy += now[1] - old[1];
                        count++;
                    }
                }
                if (count > 0) {
                    const dx = sumDx / count;
                    const dy = sumDy / count;
                    if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001) {
                        // 平移 bounds
                        g.bounds.x += dx;
                        g.bounds.y += dy;
                        anyChanged = true;
                        // ── 首次移动 → 锁定会话跟随 ──
                        if (!session.active) {
                            session.active = true;
                            session.startTs = nowTs;
                            session.startSelSnapshot = new Set(selIdSet);
                        }
                        if (!session.lockedGids.has(gid)) session.lockedGids.add(gid);
                        session.lastMovedTs = nowTs;
                    }
                }
                movedGids.add(gid);
            }
        }
        // 兜底：锁定会话后 600ms 没有任何位移更新，视为用户已停止拖动（即使 mouseup 没触发）
        if (session.active && session.lastMovedTs > 0 && nowTs - session.lastMovedTs > 600) {
            session.active = false;
            session.lockedGids.clear();
            session.startSelSnapshot = null;
            session.startTs = 0;
            session.lastMovedTs = 0;
        }
        if (anyChanged) {
            // 强制下一次迭代重新基准，防止浮点累积误差
            this._nodePosCache = null; // 下一帧重新建立
        } else {
            this._nodePosCache = nowPos;
        }
    },

    /* 收集指定编组及其所有完全位于内部的子编组（仅限面积更小的编组，大控制小） */
    _collectChildGroups(gid, visited = new Set()) {
        if (visited.has(gid)) return [];
        visited.add(gid);
        const result = [gid];
        const group = this.groups[gid];
        if (!group?.bounds) return result;
        const groupArea = group.bounds.w * group.bounds.h;

        for (const [otherGid, otherG] of Object.entries(this.groups)) {
            if (otherGid === gid) continue;
            const ob = otherG.bounds;
            if (!ob) continue;
            const otherArea = ob.w * ob.h;
            if (otherArea >= groupArea) continue; // 小不控制大
            if (this._isFullyContained(group.bounds, ob)) {
                result.push(...this._collectChildGroups(otherGid, visited));
            }
        }
        return result;
    },

    /* 收集所有被当前编组包含或有重叠且面积更小的编组（递归传递）
     * 用于绕过/开启的联动控制：大编组切换绕过时，所有有重叠的小编组都跟着切换
     * 注意：小编组切换绕过时不影响大编组（单向控制）
     * 注意：移动编组时仍使用 _collectChildGroups（>50% 覆盖才一起移动）
     */
    _collectLinkedGroups(gid, visited = new Set()) {
        if (visited.has(gid)) return [];
        visited.add(gid);
        const result = [gid];
        const group = this.groups[gid];
        if (!group?.bounds) return result;
        const groupArea = group.bounds.w * group.bounds.h;

        for (const [otherGid, otherG] of Object.entries(this.groups)) {
            if (otherGid === gid) continue;
            const ob = otherG.bounds;
            if (!ob) continue;
            const otherArea = ob.w * ob.h;
            // 只收集面积比当前编组小且有重叠的编组（大控制小，小不控制大）
            if (otherArea < groupArea && this._getOverlapRatio(group.bounds, ob) > 0) {
                result.push(...this._collectLinkedGroups(otherGid, visited));
            }
        }
        return result;
    },

    /* ── 删除 ── */
    removeGroup(gid) {
        const g = this.groups[gid];
        if (!g) return;
        const graph = app?.graph;
        if (graph && g.bypassed) g.nodeIds.forEach(nid => { const n = graph._nodes.find(x => x.id === nid || x.id == nid); if (n) n.mode = MODE_ALWAYS; });
        // 清除节点上的编组残留数据，防止自动恢复
        g.nodeIds.forEach(nid => {
            const n = graph?._nodes?.find(x => x.id === nid || x.id == nid);
            if (n) this._clearNodeGroupData(n);
        });
        // 从 extra 中移除该编组
        if (graph?.extra?.xzgGroups) delete graph.extra.xzgGroups[gid];
        this.killGroup(gid);
        // 记录已删除的编组 ID 到 localStorage，防止自动保存未触发时刷新恢复
        try {
            const deleted = JSON.parse(localStorage.getItem('xzg_deleted_groups') || '[]');
            if (!deleted.includes(gid)) deleted.push(gid);
            localStorage.setItem('xzg_deleted_groups', JSON.stringify(deleted));
        } catch(e) {}
        graph?.setDirtyCanvas?.(true, true);
        graph?.change?.();
        this.syncGroupsToExtra();
    },

    /* ── 持久化：同步到 app.graph.extra + localStorage ── */
    syncGroupsToExtra() {
        if (!app?.graph) return;
        const gd = {};
        for (const [id, g] of Object.entries(this.groups)) {
            gd[id] = { id: g.id, title: g.title, nodeIds: [...g.nodeIds], bypassed: g.bypassed, locked: g.locked || false, hidden: !!g.hidden, bounds: { ...g.bounds }, fontSize: g.fontSize, colorHue: g.colorHue, colorSat: g.colorSat, colorLit: g.colorLit, effect: g.effect, effectSpeed: g.effectSpeed, borderWidth: g.borderWidth, borderOpacity: g.borderOpacity, headerBgColor: g.headerBgColor, titleColor: g.titleColor, lineHeight: g.lineHeight ?? 1, fadeEnabled: g.fadeEnabled || false, fadeOutDuration: g.fadeOutDuration ?? 0, fadeInDuration: g.fadeInDuration ?? 1000 };
        }
        app.graph.extra = app.graph.extra || {};
        app.graph.extra.xzgGroups = gd;
        // 立即写入 localStorage 兜底
        try {
            if (Object.keys(gd).length) {
                localStorage.setItem('xzg_groups_backup', JSON.stringify(gd));
            } else {
                localStorage.removeItem('xzg_groups_backup');
            }
        } catch(e) {}
    },

    setupSerializationHooks(retryCount = 0) {
        if (window._xzg_srl) return;
        
        const self = this;

        // ── 运行时补丁：确保新增方法存在（兼容 ES module 浏览器缓存导致对象字面量方法未挂载）
        // 如果当前 XZGGroup 对象中缺少 _collectAllNodeIdsInGroup / _syncSelectedGroupsFollowNodes，
        // 直接在此注入实现（与文件中定义的方法逻辑一致）。
        // 这两个方法是实现「编组跟随节点移动」与「复制粘贴严格完整性」的关键。
        if (typeof self._collectAllNodeIdsInGroup !== 'function') {
            self._collectAllNodeIdsInGroup = function(gid, visitedGroups) {
                if (!self.groups[gid]) return [];
                visitedGroups = visitedGroups || new Set();
                if (visitedGroups.has(gid)) return [];
                visitedGroups.add(gid);
                const nodeIds = [];
                const pushId = (id) => {
                    if (id == null) return;
                    if (!nodeIds.some(x => self._idEq(x, id))) nodeIds.push(id);
                };
                for (const id of (self.groups[gid].nodeIds || [])) pushId(id);
                const g = self.groups[gid];
                const gArea = g.bounds ? g.bounds.w * g.bounds.h : 0;
                for (const [childGid, childG] of Object.entries(self.groups)) {
                    if (childGid === gid || !childG.bounds) continue;
                    const childArea = childG.bounds.w * childG.bounds.h;
                    if (gArea > 0 && childArea < gArea && g.bounds && self._isFullyContained(g.bounds, childG.bounds)) {
                        for (const id of self._collectAllNodeIdsInGroup(childGid, visitedGroups)) pushId(id);
                    }
                }
                return nodeIds;
            };
        }
        if (typeof self._syncSelectedGroupsFollowNodes !== 'function') {
            self._syncSelectedGroupsFollowNodes = function() {
                // 已禁用：编组不再跟随节点移动。重置会话状态避免残留。
                self._nodePosCache = null;
                const s = typeof _XZG_NODE_DRAG_SESSION !== 'undefined' ? _XZG_NODE_DRAG_SESSION : null;
                if (s && s.active) { s.active=false; s.lockedGids.clear(); s.startSelSnapshot=null; s.startTs=0; s.lastMovedTs=0; }
                return;
            };
            // 兜底注入已改为空操作，下方为原逻辑（已禁用，保留备查）
            self._syncSelectedGroupsFollowNodes_DISABLED_ORIGINAL_FALLBACK = function() {
                const c = app?.canvas;
                const graph = app?.graph;
                if (!c?.selected_nodes || !graph?._nodes) return;
                const selMap = c.selected_nodes;
                if (!selMap || typeof selMap !== 'object') return;
                const selIdSet = new Set();
                for (const n of Object.values(selMap)) {
                    if (n && n.id != null) selIdSet.add(String(n.id));
                }
                if (selIdSet.size === 0) {
                    self._nodePosCache = null;
                    const s = _XZG_NODE_DRAG_SESSION;
                    if (s.active) { s.active=false; s.lockedGids.clear(); s.startSelSnapshot=null; s.startTs=0; s.lastMovedTs=0; }
                    return;
                }

                const nowPos = new Map();
                for (const idStr of selIdSet) {
                    const n = graph._nodes.find(x => String(x.id) === idStr);
                    if (n && n.pos && n.pos.length >= 2) {
                        nowPos.set(idStr, [Number(n.pos[0]) || 0, Number(n.pos[1]) || 0]);
                    }
                }
                const prev = self._nodePosCache;
                if (!prev) { self._nodePosCache = nowPos; return; }

                // 跟随会话锁定（同主方法实现：首次移动→锁定，后续帧直接复用 lockedGids）
                const session = _XZG_NODE_DRAG_SESSION;
                let fullySelectedGids;
                if (session.active && session.lockedGids.size > 0) {
                    // 选中集合变更时兜底解除锁定
                    let selChanged = false;
                    if (session.startSelSnapshot) {
                        if (session.startSelSnapshot.size !== selIdSet.size) selChanged = true;
                        else for (const v of session.startSelSnapshot) { if (!selIdSet.has(v)) { selChanged = true; break; } }
                    }
                    if (selChanged) {
                        session.active = false; session.lockedGids.clear();
                        session.startSelSnapshot = null; session.startTs = 0; session.lastMovedTs = 0;
                    } else {
                        fullySelectedGids = [...session.lockedGids].filter(gid => self.groups[gid]?.bounds);
                    }
                }
                if (!fullySelectedGids) {
                    fullySelectedGids = [];
                    for (const [gid, g] of Object.entries(self.groups)) {
                        if (!g.bounds) continue;
                        const allNodeIds = self._collectAllNodeIdsInGroup(gid);
                        if (allNodeIds.length <= 1) continue;
                        const baseSel = session.startSelSnapshot || selIdSet;
                        if (allNodeIds.every(id => baseSel.has(String(id)))) fullySelectedGids.push(gid);
                    }
                }
                if (fullySelectedGids.length === 0) { self._nodePosCache = nowPos; return; }

                const movedGids = new Set();
                let anyChanged = false;
                const nowTs = Date.now();
                for (const gid of fullySelectedGids) {
                    const g = self.groups[gid];
                    if (movedGids.has(gid) || !g?.bounds) continue;
                    const allNodeIds = self._collectAllNodeIdsInGroup(gid);
                    let sumDx = 0, sumDy = 0, count = 0;
                    for (const id of allNodeIds) {
                        const idStr = String(id);
                        const now = nowPos.get(idStr);
                        const old = prev.get(idStr);
                        if (now && old) { sumDx += now[0] - old[0]; sumDy += now[1] - old[1]; count++; }
                    }
                    if (count > 0) {
                        const dx = sumDx / count, dy = sumDy / count;
                        if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001) {
                            g.bounds.x += dx; g.bounds.y += dy; anyChanged = true;
                            if (!session.active) { session.active = true; session.startTs = nowTs; session.startSelSnapshot = new Set(selIdSet); }
                            if (!session.lockedGids.has(gid)) session.lockedGids.add(gid);
                            session.lastMovedTs = nowTs;
                        }
                    }
                    movedGids.add(gid);
                }
                if (session.active && session.lastMovedTs > 0 && nowTs - session.lastMovedTs > 600) {
                    session.active = false; session.lockedGids.clear();
                    session.startSelSnapshot = null; session.startTs = 0; session.lastMovedTs = 0;
                }
                self._nodePosCache = anyChanged ? null : nowPos;
            };
            // 将 updatePositions 包一层：开头调用新同步方法（只包一次）
            if (!self._updatePositionsPatched) {
                const origUpdatePositions = self.updatePositions.bind(self);
                self.updatePositions = function() {
                    self._syncSelectedGroupsFollowNodes();
                    return origUpdatePositions.apply(self, arguments);
                };
                self._updatePositionsPatched = true;
            }
        }

        const LG = window.LiteGraph;
        if (!LG) {
            if (retryCount < 60) {
                setTimeout(() => self.setupSerializationHooks(retryCount + 1), 100);
                return;
            }
            console.warn('[小珠光编组] 序列化 Hook 安装失败：LiteGraph 超时未就绪，将使用 extra 备份');
            // 即使 LiteGraph 不可用，也尝试用 extra 做持久化 + 安装剪贴板钩子
            window._xzg_srl = true;
            this._setupExtraBasedPersistence();
            this.setupClipboardHook();
            return;
        }
        window._xzg_srl = true;

        // 尝试通过 LiteGraph 钩子持久化（兼容旧版）
        if (LG.LGraphNode) {
            try {
                const s = LG.LGraphNode.prototype.serialize;
                if (s) {
                    LG.LGraphNode.prototype.serialize = function() {
                        const d = s.apply(this, arguments);
                        // ── 复制/粘贴期间：禁止把编组标记写进节点序列化数据（避免污染剪贴板导致重复编组） ──
                        if (self._isCopying || self._isPasting) {
                            delete d._xzgGroupId;
                            delete d._xzgGroup;
                            return d;
                        }
                        if (this._xzgGroupId) {
                            d._xzgGroupId = this._xzgGroupId;
                            if (this._xzgGroupData) d._xzgGroup = JSON.parse(JSON.stringify(this._xzgGroupData));
                        } else {
                            // 节点不在任何编组中，清除序列化数据中可能残留的编组字段
                            delete d._xzgGroupId;
                            delete d._xzgGroup;
                        }
                        return d;
                    };
                }
            } catch(e) {}
            try {
                const c = LG.LGraphNode.prototype.configure;
                if (c) {
                    LG.LGraphNode.prototype.configure = function(d) {
                        // ── 粘贴期间：禁止恢复节点上的旧编组标记（避免旧标记被当成「属于哪个编组」的依据，引发重复编组） ──
                        if (self._isPasting || self._isCopying) {
                            c.apply(this, arguments);
                            return;
                        }
                        c.apply(this, arguments);
                        if (d?._xzgGroupId !== undefined) {
                            if (d._xzgGroupId) {
                                this._xzgGroupId = d._xzgGroupId;
                                this._xzgGroupData = d._xzgGroup || null;
                            } else {
                                this._xzgGroupId = null;
                                this._xzgGroupData = null;
                            }
                            self._needRestore = true;
                        }
                    };
                }
            } catch(e) {}
        }
        if (LG.LGraph) {
            try {
                const s = LG.LGraph.prototype.serialize;
                if (s) {
                    LG.LGraph.prototype.serialize = function() {
                        const d = s.apply(this, arguments);
                        // ── 复制/粘贴期间：彻底不写编组到剪贴板（d._xzgGroups / d.extra.xzgGroups / d.nodes[i]._xzgGroupId）
                        //    防止 LGraph.configure 钩子读到编组数据后触发 restore，造成粘贴后产生死标记 ──
                        if (self._isCopying || self._isPasting) {
                            delete d._xzgGroups;
                            if (d.extra) delete d.extra.xzgGroups;
                            if (d.nodes && d.nodes.length) {
                                for (const nd of d.nodes) {
                                    delete nd._xzgGroupId;
                                    delete nd._xzgGroup;
                                }
                            }
                            return d;
                        }
                        const gd = {};
                        for (const [id, g] of Object.entries(self.groups)) {
                            gd[id] = { id: g.id, title: g.title, nodeIds: [...g.nodeIds], bypassed: g.bypassed, locked: g.locked || false, hidden: !!g.hidden, bounds: { ...g.bounds }, fontSize: g.fontSize, colorHue: g.colorHue, colorSat: g.colorSat, colorLit: g.colorLit, effect: g.effect, effectSpeed: g.effectSpeed, borderWidth: g.borderWidth, borderOpacity: g.borderOpacity, headerBgColor: g.headerBgColor, titleColor: g.titleColor, lineHeight: g.lineHeight ?? 1, fadeEnabled: g.fadeEnabled || false, fadeOutDuration: g.fadeOutDuration ?? 0, fadeInDuration: g.fadeInDuration ?? 1000 };
                        }
                        if (Object.keys(gd).length) {
                            console.log('[小珠光编组] LGraph.serialize写入编组数据:', Object.keys(gd).length, '个');
                            d._xzgGroups = gd;
                        }
                        d.extra = d.extra || {};
                        d.extra.xzgGroups = gd;

                        if (d.nodes && d.nodes.length) {
                            const nodeGroupMap = {};
                            for (const [gid, g] of Object.entries(self.groups)) {
                                const groupData = gd[gid];
                                for (const nid of g.nodeIds) {
                                    nodeGroupMap[nid] = { groupId: gid, groupData: groupData };
                                }
                            }
                            for (const nd of d.nodes) {
                                const nid = nd.id;
                                const match = nodeGroupMap[nid] || Object.entries(nodeGroupMap).find(([k]) => k == nid)?.[1];
                                if (match) {
                                    nd._xzgGroupId = match.groupId;
                                    nd._xzgGroup = JSON.parse(JSON.stringify(match.groupData));
                                } else {
                                    // 节点不在任何编组中，清除残留的编组字段（防止已删除编组通过节点数据复活）
                                    delete nd._xzgGroupId;
                                    delete nd._xzgGroup;
                                }
                            }
                        }
                        return d;
                    };
                }
            } catch(e) {}
            try {
                const c = LG.LGraph.prototype.configure;
                if (c) {
                    LG.LGraph.prototype.configure = function(d) {
                        // ── 粘贴/复制期间：最开头就拦截，避免 configure 钩子读到剪贴板残留数据触发 restore ──
                        if (self._isPasting || self._isCopying) {
                            c.apply(this, arguments);
                            return;
                        }
                        const pendingFromTop = d?._xzgGroups || d?.extra?.xzgGroups || null;
                        if (pendingFromTop) console.log('[小珠光编组] LGraph.configure检测到编组数据:', Object.keys(pendingFromTop).length, '个');
                        // 加载新工作流时清空跨会话删除标记：xzg_deleted_groups 是全局的，
                        // 不应跨工作流生效。加载新工作流时完全信任工作流 JSON 数据，
                        // 防止「在工作流A删除编组 → 切换到工作流B → B中相同gid的编组被跳过 → 永久丢失」
                        try { localStorage.removeItem('xzg_deleted_groups'); } catch(e) {}
                        // 判断是否跨工作流切换（两条检测路径，任一命中即认为是跨工作流）：
                        // 1. loadGraphData 钩子设置 _loadingNewWorkflow 标志（官方加载路径）
                        // 2. graph.clear() 在 configure 之前被调用 → this._nodes 已空
                        //    （小珠光工作流切换走 graph.clear()+graph.configure()，不走 loadGraphData）
                        // 同工作流 reconfigure（auto-save/undo）时 _nodes 非空且不经过 loadGraphData
                        const oldNodeIds = new Set();
                        if (this._nodes) for (const n of this._nodes) oldNodeIds.add(n.id);
                        const isCrossWorkflow = !!self._loadingNewWorkflow || oldNodeIds.size === 0;
                        c.apply(this, arguments);
                        // 消费标志：configure 完成后清除，后续的 reconfigure 不会误判
                        self._loadingNewWorkflow = false;
                        if (app?.graph !== this) return;

                        // 粘贴期间跳过编组恢复，避免破坏粘贴钩子的处理
                        if (self._isPasting) {
                            console.log('[小珠光编组] 粘贴期间跳过configure编组恢复');
                            return;
                        }

                        // 保存当前用户自定义属性（颜色、标题、效果等）
                        const savedCustomProps = {};
                        for (const [gid, g] of Object.entries(self.groups)) {
                            savedCustomProps[gid] = {
                                title: g.title,
                                fontSize: g.fontSize,
                                colorHue: g.colorHue,
                                colorSat: g.colorSat,
                                colorLit: g.colorLit,
                                effect: g.effect,
                                effectSpeed: g.effectSpeed,
                                borderWidth: g.borderWidth,
                                borderOpacity: g.borderOpacity,
                                headerBgColor: g.headerBgColor,
                                titleColor: g.titleColor,
                                lineHeight: g.lineHeight,
                            };
                        }

                        // 将自定义属性合并到序列化数据中，确保 restoreGroups 读取正确值
                        // ⚠️ 仅在同工作流 reconfigure 时合并（保留用户未保存的视觉编辑）
                        //    跨工作流切换时完全信任新工作流 JSON 数据，防止旧工作流的
                        //    标题/颜色/特效窜入新工作流相同 gid 的编组（窜流根因）
                        if (!isCrossWorkflow && pendingFromTop) {
                            for (const [gid, props] of Object.entries(savedCustomProps)) {
                                if (pendingFromTop[gid]) {
                                    Object.assign(pendingFromTop[gid], props);
                                }
                            }
                        } else if (isCrossWorkflow) {
                            console.log('[小珠光编组] 检测到跨工作流切换，跳过旧工作流视觉属性合并（防窜流）');
                            // 调试：打印 pendingFromTop 的实际内容，确认是否纯净
                            if (pendingFromTop) {
                                for (const [gid, g] of Object.entries(pendingFromTop)) {
                                    console.log(`[小珠光编组][调试] pendingFromTop gid=${gid} title="${g.title}" hue=${g.colorHue}`);
                                }
                            }
                        }

                        for (const gid of Object.keys(self.groups)) self.killGroup(gid);
                        self.groups = {};
                        self._needRestore = true;
                        self._pendingGroups = pendingFromTop;
                        if (app.graph._nodes?.length) {
                            console.log('[小珠光编组] LGraph.configure立即恢复');
                            self.restoreGroups();
                        }
                    };
                }
            } catch(e) {}

            // ── hook LGraph.prototype.clear（防跨工作流窜流的关键） ──
            // 视角锁定功能在 app.graph 实例上覆盖了 configure，导致上面的原型 configure hook 不被调用。
            // 但视角锁定没有 hook clear，所以 hook clear 来清空旧编组：
            // 1. 工作流切换走 graph.clear() + graph.configure()
            // 2. clear 时清空 self.groups，防止旧编组残留
            // 3. 设置 _pendingGroups = {} 满足 syncLoop 的 _needRestore && _pendingGroups 条件
            // 4. configure 后 graph.extra 有新数据，restoreGroups 从 graph.extra 补充（因 groups 已清空）
            try {
                const origClear = LG.LGraph.prototype.clear;
                if (origClear) {
                    LG.LGraph.prototype.clear = function() {
                        // 工作流切换/新建：清空旧编组，防止跨工作流窜流
                        self._loadingNewWorkflow = true;
                        for (const gid of Object.keys(self.groups)) self.killGroup(gid);
                        self.groups = {};
                        try { localStorage.removeItem('xzg_groups_backup'); } catch(e) {}
                        try { localStorage.removeItem('xzg_deleted_groups'); } catch(e) {}
                        // 设空对象满足 syncLoop 条件；若 configure hook 也执行会覆盖为真实数据
                        self._needRestore = true;
                        if (!self._pendingGroups) self._pendingGroups = {};
                        return origClear.apply(this, arguments);
                    };
                    console.log('[小珠光编组] LGraph.clear 钩子已安装（防跨工作流窜流）');
                }
            } catch(e) { console.warn('[小珠光编组] LGraph.clear 钩子安装失败:', e); }
        }
    },

    /* ── 复制/粘贴：仅维护 _isCopying/_isPasting 标志，不再复制编组框 ──
     * 粘贴后的节点是"干净的孤儿节点"（_xzgGroupId 已在序列化阶段被擦除）。
     * 编组框需要用户手动 Ctrl+G 重建。
     * 保留标志是为了在 LGraph.serialize / LGraphNode.serialize 中阻止 _xzgGroupId
     * 残留标记污染剪贴板 JSON，避免粘贴后产生死标记。 */
    setupClipboardHook() {
        if (this._clipboardHooked) return;
        const self = this;
        let LGraphCanvas = null;
        if (window.LiteGraph?.LGraphCanvas?.prototype) {
            LGraphCanvas = window.LiteGraph.LGraphCanvas;
        } else {
            LGraphCanvas = app.canvas?.constructor;
            if (!LGraphCanvas?.prototype) {
                console.warn('[小珠光编组] setupClipboardHook: LiteGraph未就绪，延迟安装');
                setTimeout(() => self.setupClipboardHook(), 200);
                return;
            }
        }
        this._clipboardHooked = true;

        const P = LGraphCanvas.prototype;
        const origCopy = P.copyToClipboard;
        if (origCopy) {
            P.copyToClipboard = function() {
                self._isCopying = true;
                try {
                    return origCopy.apply(this, arguments);
                } finally {
                    self._isCopying = false;
                }
            };
        }
        const origPaste = P.pasteFromClipboard;
        if (origPaste) {
            P.pasteFromClipboard = function() {
                self._isPasting = true;
                try {
                    return origPaste.apply(this, arguments);
                } finally {
                    self._isPasting = false;
                }
            };
        }
        console.log('[小珠光编组] 剪贴板钩子已安装（精简版：仅维护标志，不复制编组框）');
    },

    /* ── 基于 extra 的持久化（兼容新版 ComfyUI 前端） ── */
    _setupExtraBasedPersistence() {
        if (this._extraPersistenceReady) return;
        this._extraPersistenceReady = true;
        const self = this;

        // ── 辅助：序列化所有编组数据 ──
        const serializeGroups = () => {
            const gd = {};
            for (const [id, g] of Object.entries(self.groups)) {
                gd[id] = { id: g.id, title: g.title, nodeIds: [...g.nodeIds], bypassed: g.bypassed, locked: g.locked || false, hidden: !!g.hidden, bounds: { ...g.bounds }, fontSize: g.fontSize, colorHue: g.colorHue, colorSat: g.colorSat, colorLit: g.colorLit, effect: g.effect, effectSpeed: g.effectSpeed, borderWidth: g.borderWidth, borderOpacity: g.borderOpacity, headerBgColor: g.headerBgColor, titleColor: g.titleColor, lineHeight: g.lineHeight ?? 1, fadeEnabled: g.fadeEnabled || false, fadeOutDuration: g.fadeOutDuration ?? 0, fadeInDuration: g.fadeInDuration ?? 1000 };
            }
            return gd;
        };

        // ── 方案1：Hook graphToPrompt（保存时注入编组数据） ──
        const tryHookGraphToPrompt = () => {
            if (!app?.graphToPrompt) {
                setTimeout(tryHookGraphToPrompt, 200);
                return;
            }
            const orig = app.graphToPrompt;
            app.graphToPrompt = async function() {
                const result = await orig.apply(this, arguments);
                // 直接修改序列化输出，确保编组数据被写入工作流 JSON
                if (result?.workflow) {
                    const gd = serializeGroups();
                    console.log('[小珠光编组] graphToPrompt写入编组数据:', Object.keys(gd).length, '个');
                    result.workflow.extra = result.workflow.extra || {};
                    result.workflow.extra.xzgGroups = gd;
                    // 也同步到 app.graph.extra（用于 loadGraphData 钩子恢复）
                    self.syncGroupsToExtra();
                }
                return result;
            };
            console.log('[小珠光编组] graphToPrompt 钩子已安装');
        };
        tryHookGraphToPrompt();

        // ── 方案2：Hook loadGraphData（加载时恢复编组数据） ──
        const tryHookLoadGraphData = () => {
            if (!app?.loadGraphData) {
                setTimeout(tryHookLoadGraphData, 200);
                return;
            }
            const origLoad = app.loadGraphData;
            app.loadGraphData = async function(data, ...args) {
                // 标记正在加载新工作流（loadGraphData 总是在 configure 之前被调用）
                // 用于 LGraph.configure 钩子区分「跨工作流加载」与「同工作流 reconfigure」
                self._loadingNewWorkflow = true;
                // 清空全局 localStorage backup：xzg_groups_backup 是全局的，
                // 加载新工作流时必须清除，防止 restoreGroups 兜底用旧工作流编组数据污染新工作流
                try { localStorage.removeItem('xzg_groups_backup'); } catch(e) {}
                // 从加载的数据中提取编组信息
                const groups = data?.extra?.xzgGroups || data?._xzgGroups || null;
                if (groups && Object.keys(groups).length) {
                    self._pendingGroups = groups;
                    self._needRestore = true;
                    console.log('[小珠光编组] loadGraphData检测到编组数据:', Object.keys(groups).length, '个');
                }
                const result = await origLoad.apply(this, [data, ...args]);
                return result;
            };
            console.log('[小珠光编组] loadGraphData 钩子已安装');
        };
        tryHookLoadGraphData();

        // ── 方案3：localStorage 兜底（每10秒保存一次） ──
        if (!this._extraSyncInterval) {
            this._extraSyncInterval = setInterval(() => {
                self.syncGroupsToExtra();
                // 同时备份到 localStorage
                try {
                    const gd = serializeGroups();
                    if (Object.keys(gd).length) {
                        localStorage.setItem('xzg_groups_backup', JSON.stringify(gd));
                    } else {
                        localStorage.removeItem('xzg_groups_backup');
                    }
                } catch(e) {}
            }, 5000);
        }

        // ── 方案4：从 localStorage 恢复（兜底） ──
        try {
            const backup = localStorage.getItem('xzg_groups_backup');
            if (backup) {
                const gd = JSON.parse(backup);
                if (gd && Object.keys(gd).length && !this._pendingGroups) {
                    this._pendingGroups = gd;
                    this._needRestore = true;
                }
            }
        } catch(e) {}
    },

    waitForGraph() {
        let n = 0; const self = this;
        const ck = () => {
            n++;
            if (app?.graph?._nodes?.length && self._needRestore && self._pendingGroups) {
                console.log('[小珠光编组] waitForGraph触发恢复');
                self.restoreGroups();
                return;
            }
            if (n < 60) setTimeout(ck, 250);
        };
        setTimeout(ck, 100);
    },

    restoreGroups() {
        if (!app?.graph) return;
        this._needRestore = false;

        // 读取已删除的编组 ID 列表（防止 auto-save 未触发时刷新恢复）
        let _deletedGids = [];
        try { _deletedGids = JSON.parse(localStorage.getItem('xzg_deleted_groups') || '[]'); } catch(e) {}
        // 保存此次恢复中所有数据源里的编组 ID（用于后续清理：auto-save 生效后移除）
        const _allDataGids = new Set([
            ...Object.keys(this._pendingGroups || {}),
            ...Object.keys(app?.graph?.extra?.xzgGroups || {})
        ]);

        console.log('[小珠光编组] 恢复编组...', this._pendingGroups ? Object.keys(this._pendingGroups).length + '个编组数据待恢复' : '无待恢复数据', '已删除:', _deletedGids.length);

        // 优先从工作流保存的完整编组数据恢复（包含动画、颜色、标题等）
        // 注意：_pendingGroups 来自工作流 JSON，是用户明确保存的编组数据，优先级最高，
        // 不受 _deletedGids 影响（防止跨工作流删除标记导致编组永久丢失）
        if (this._pendingGroups) {
            for (const [id, g] of Object.entries(this._pendingGroups)) {
                this.groups[id] = { ...g };
            }
            this._pendingGroups = null;
        }

        // 额外：从 app.graph.extra 恢复（兼容新版 ComfyUI 前端）
        // graph.extra 来自 LiteGraph configure，也是工作流数据，同样不受 _deletedGids 影响
        if (app?.graph?.extra?.xzgGroups && Object.keys(app.graph.extra.xzgGroups).length) {
            for (const [id, g] of Object.entries(app.graph.extra.xzgGroups)) {
                if (!this.groups[id]) {
                    this.groups[id] = { ...g };
                }
            }
        }

        if (!app.graph._nodes?.length) {
            this.rebuildAllEls();
            return;
        }

        // 多重冗余恢复：从节点的多个备份位置恢复编组数据
        const groupDataMap = {};
        app.graph._nodes.forEach(n => {
            // 备份位置1：节点实例上的 _xzgGroupData（最新序列化时写入）
            let pg = n._xzgGroupData;
            // 备份位置2：节点序列化数据直接字段 _xzgGroup（configure时恢复到_xzgGroupData，这里再查一次）
            if (!pg && n._xzgGroup) pg = n._xzgGroup;
            // 备份位置3：节点 properties._xzgGroup
            if (!pg) pg = n.properties?._xzgGroup;
            if (pg && pg.id) {
                // 用最新的数据覆盖（同一编组多个节点，取第一个找到的完整数据）
                if (!groupDataMap[pg.id] || (pg.nodeIds && pg.nodeIds.length)) {
                    groupDataMap[pg.id] = pg;
                }
            }
        });

        // 将从节点收集到的编组数据合并到groups
        for (const [gid, gd] of Object.entries(groupDataMap)) {
            if (_deletedGids.includes(gid)) continue;
            if (!this.groups[gid]) {
                this.groups[gid] = { ...gd };
            } else {
                // 如果已有顶层数据，保留顶层数据，只补充缺失字段
                for (const key of Object.keys(gd)) {
                    if (this.groups[gid][key] === undefined) {
                        this.groups[gid][key] = gd[key];
                    }
                }
            }
        }

        // 根据节点上的 groupId 校正/补充 nodeIds（兼容旧工作流或节点恢复场景）
        const map = {};
        app.graph._nodes.forEach(n => { if (n._xzgGroupId) (map[n._xzgGroupId] ??= []).push(n.id); });
        for (const [gid, nids] of Object.entries(map)) {
            if (_deletedGids.includes(gid)) continue;
            if (!this.groups[gid]) {
                // 优先从 extra 恢复完整数据（含用户自定义颜色等），仅作兜底才用默认值
                const fromExtra = app?.graph?.extra?.xzgGroups?.[gid];
                const bounds = this.calcBounds(nids) || { x: 0, y: 0, w: 300, h: 200 };
                this.groups[gid] = fromExtra ? { ...fromExtra } : {
                    id: gid, title: '右键标题栏设置', nodeIds: nids, bypassed: false, locked: false, bounds,
                    fontSize: 20, colorHue: 48, colorSat: 100, colorLit: 55,
                    effect: 'none', effectSpeed: 3,
                    borderWidth: 2, borderOpacity: 1,
                    headerBgColor: 'rgba(0,0,0,0.4)', titleColor: '#FFD700',
                    lineHeight: 1, fadeEnabled: true, fadeOutDuration: 0, fadeInDuration: 1000
                };
            } else {
                this.groups[gid].nodeIds = nids;
                // 确保bounds存在
                if (!this.groups[gid].bounds) {
                    this.groups[gid].bounds = this.calcBounds(nids) || { x: 0, y: 0, w: 300, h: 200 };
                }
            }
        }
        for (const gid of Object.keys(this.groups)) if (!this.groups[gid].nodeIds || !this.groups[gid].nodeIds.length) delete this.groups[gid];
        // 补全渐隐相关默认值（兼容旧工作流）
        for (const g of Object.values(this.groups)) {
            if (g.fadeEnabled === undefined) g.fadeEnabled = false;
            if (g.fadeOutDuration === undefined) g.fadeOutDuration = 0;
            if (g.fadeInDuration === undefined) g.fadeInDuration = 1000;
            if (g.hidden === undefined) g.hidden = false;
            if (g.lineHeight === undefined) g.lineHeight = 1;
        }
        // 清理已持久化的删除标记：只保留此次恢复中仍然出现在任意数据源里的 ID
        // （如果 auto-save 已生效，group 不再出现于数据中，就可以从列表移除）
        const allDataGids = new Set([..._allDataGids, ...Object.keys(groupDataMap), ...Object.keys(map)]);
        const stillDeleted = _deletedGids.filter(id => allDataGids.has(id));
        try {
            if (stillDeleted.length) {
                localStorage.setItem('xzg_deleted_groups', JSON.stringify(stillDeleted));
            } else {
                localStorage.removeItem('xzg_deleted_groups');
            }
        } catch(e) {}
        this.rebuildAllEls();
        this.applyBypassStates();
        console.log('[小珠光编组] 恢复完成，编组数量:', Object.keys(this.groups).length);
    },

    applyBypassStates() {
        const g = app?.graph;
        if (!g?._nodes) return;
        // 不强制覆盖节点 mode：节点 mode 由 LiteGraph 原生序列化保存/恢复，
        // 保留用户对组内节点的手工绕过/开启状态。编组 bypassed 字段仅用于视觉显示。
        g.setDirtyCanvas?.(true, true);
    }
};

app.registerExtension({ name: 'ComfyUI.xiaozhuguang.group', setup() { XZGGroup.init(); window.XZGGroup = XZGGroup; } });
