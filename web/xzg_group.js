/**
 * 小珠光编组功能 - DOM 覆盖层版（固定框体 + 可拖拽调整大小）
 * 选中节点 → Ctrl+Q → 创建固定大小编组框
 */

import { app } from "../../scripts/app.js";

const MODE_ALWAYS = 0;
const MODE_BYPASS = 4;

const XZGGroup = {
    initialized: false,
    groups: {},       // groupId → {id, title, nodeIds, bypassed, bounds, fontSize}
    groupEls: {},
    overlay: null,

    init() {
        if (this.initialized) return;
        this.initialized = true;
        this.shortcutKey = localStorage.getItem('xzg_shortcut') || 'g';
        console.log('[小珠光编组] 初始化 ✓');

        this.createOverlay();
        this.setupKeyboardShortcut();
        this.setupCanvasMenu();
        this.setupSerializationHooks();
        this.setupBodyBypass();
        this.startSyncLoop();
        this.waitForGraph();
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

    /* ── 覆盖层 ── */
    createOverlay() {
        const o = document.createElement('div');
        o.id = 'xzg-group-overlay';
        o.style.cssText = 'position:fixed;pointer-events:none;z-index:10;overflow:visible;';
        document.body.appendChild(o);
        this.overlay = o;
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

    /* ── 快捷键 ── */
    setupKeyboardShortcut() {
        const self = this;
        document.addEventListener('keydown', function h(e) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            // Ctrl+? 新建编组
            const k = self.shortcutKey || 'g';
            if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === k.toLowerCase()) {
                e.preventDefault();
                e.stopPropagation(); e.stopImmediatePropagation();
                self.createGroupFromSelection();
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
                    content: '<span style="color:#FFD700;">📦 小珠光编组 <span style="color:#4CAF50;font-size:10px;">快捷键Ctrl+' + (self.shortcutKey || 'g').toUpperCase() + '</span></span>',
                    callback: () => self.createGroupFromSelection()
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
            for (const gid of Object.keys(this.groups)) {
                const el = this.groupEls[gid];
                if (!el) continue;
                const r = el.getBoundingClientRect();
                if (r.width === 0) continue;
                if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
                    e.preventDefault(); e.stopPropagation();
                    this.toggleBypass(gid);
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

        // 节流：避免短时间内重复更新
        let _syncPending = false;
        const scheduleSync = () => {
            if (_syncPending) return;
            _syncPending = true;
            requestAnimationFrame(() => {
                _syncPending = false;
                self.updatePositions();
            });
        };

        const tryHook = () => {
            const ds = app?.canvas?.ds;
            if (!ds) { setTimeout(tryHook, 100); return; }

            // Hook changeScale：缩放时立即更新位置
            const origCS = ds.changeScale;
            ds.changeScale = function() {
                origCS.apply(this, arguments);
                scheduleSync();
            };

            // Hook changeOffset：平移时立即更新位置
            const origCO = ds.changeOffset;
            ds.changeOffset = function() {
                origCO.apply(this, arguments);
                scheduleSync();
            };

            // Hook 鼠标拖拽平移（中键/空格拖拽）
            const origM = ds.onMouseMove;
            if (origM) {
                ds.onMouseMove = function() {
                    origM.apply(this, arguments);
                    scheduleSync();
                };
            }

            // 监听 canvas 上的 wheel 事件（缩放）
            const cv = app?.canvas?.canvas;
            if (cv) {
                cv.addEventListener('wheel', () => scheduleSync(), { passive: true });
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
                rpath: el.querySelector('.xzg-resize-handle svg path')
            };
        }
        return el._xzgRefs;
    },

    updatePositions() {
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
            el.style.left = ((b.x + ox) * scale) + 'px';
            el.style.top = ((b.y + oy) * scale) + 'px';
            el.style.width = (b.w * scale) + 'px';
            el.style.height = (b.h * scale) + 'px';

            // 标题文字/栏高度跟随画布缩放（无标题时保留最小操作区域）
            const fs = (g.fontSize || 14) * scale;
            const showTitle = (g.title || '').trim() !== '';
            const headerHeight = Math.max(18 * scale, fs + 4 * scale);
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
                span.style.color = g.titleColor || '#FFD700';
                span.style.display = showTitle ? '' : 'none';
            }
            const delBtn = el.querySelector('.xzg-delete-btn');
            if (delBtn) {
                delBtn.style.fontSize = (18 * scale) + 'px';
                delBtn.style.marginLeft = (4 * scale) + 'px';
            }
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
            const spd = (g.effectSpeed || 3) / 3;
            const bw = (g.borderWidth || 2) * scale;
            const bo = g.borderOpacity ?? 0.65;

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
                break;
            }
            case 'glow': {
                const t = (Date.now() / 2500) * spd;
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
                break;
            }
            default:
                el.style.boxShadow = 'none';
                el.style.borderImage = 'none';
                el.style.background = 'transparent';
            }
        }
    },

    /* ── 清理节点上的冗余编组数据 ── */
    _clearNodeGroupData(n) {
        if (!n) return;
        n._xzgGroupId = null;
        n._xzgGroupData = null;
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
            if (!n?.pos || typeof n.pos[0] !== 'number' || typeof n.pos[1] !== 'number') return;
            const nw = n.size?.[0] || 200, nh = n.size?.[1] || 100;
            if (typeof nw !== 'number' || typeof nh !== 'number') return;
            // 完全位于框体边界内才归入编组
            if (n.pos[0] >= bounds.x && n.pos[0] + nw <= bounds.x + bounds.w &&
                n.pos[1] >= bounds.y && n.pos[1] + nh <= bounds.y + bounds.h) {
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
        this.groups[gid] = {
            id: gid,
            title: '右键标题栏设置',
            nodeIds: directNodeIds,
            bypassed: false,
            bounds: bounds,
            fontSize: 14,
            colorHue: 48, colorSat: 100, colorLit: 55,
            effect: 'none', effectSpeed: 3,
            borderWidth: 2, borderOpacity: 0.65,
            headerBgColor: 'rgba(0,0,0,0.4)',
            titleColor: '#FFD700'
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
        const bo = group.borderOpacity ?? 0.65;
        el.style.cssText = `position:absolute;pointer-events:none;border:${bw}px solid hsla(48,100%,55%,${bo});border-radius:8px;background:transparent;box-sizing:border-box;z-index:5;`;
        const fs = group.fontSize || 14;
        const showTitle = (group.title || '').trim() !== '';
        const headerHeight = Math.max(18, fs + 4);
        el.innerHTML = `
            <div class="xzg-group-header" style="display:flex;align-items:center;justify-content:space-between;padding:0 6px;background:${showTitle ? (group.headerBgColor || 'rgba(0,0,0,0.4)') : 'transparent'};border-radius:7px 7px 0 0;cursor:pointer;user-select:none;pointer-events:auto;height:${headerHeight}px;box-sizing:border-box;overflow:hidden;z-index:4;">
                <div style="flex:1 1 auto;min-width:0;overflow:hidden;">
                    <span class="xzg-group-title-text" style="color:${group.titleColor || '#FFD700'};font-size:${fs}px;font-weight:400;white-space:nowrap;line-height:1;${showTitle ? '' : 'display:none;'}">${showTitle ? group.title : ''}</span>
                </div>
                <button class="xzg-delete-btn" title="删除编组" style="border:none;background:none;cursor:pointer;padding:0;flex-shrink:0;font-size:18px;color:hsla(48,100%,55%,0.5);line-height:1;margin-left:4px;">×</button>
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
                self.startDrag(group.id, e);
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

        // 标题栏操作：左键单击=绕过/选中，左键按住拖动=移动组，右键任意位置=设置
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
            const onMove = ev => {
                if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) {
                    dragged = true;
                    document.removeEventListener('mousemove', onMove);
                    self.startDrag(group.id, downE);
                }
            };
            document.addEventListener('mousemove', onMove);
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (!dragged) self.toggleBypass(group.id);
            };
            document.addEventListener('mouseup', onUp, { once: true });
        });

        // 右键标题栏任意位置 → 设置（排除删除按钮）
        headerEl.addEventListener('contextmenu', e => {
            if (e.target.closest('.xzg-delete-btn')) return;
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

    /* ── 设置弹窗 ── */
    openSettings(group) {
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
                    <span style="color:#fff;font-size:12px;">新建快捷键</span>
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
                    <input class="xzg-set-fontsize" type="range" min="6" max="48" value="${group.fontSize || 14}" style="flex:1;height:28px;margin:0;">
                    <div style="width:72px;flex-shrink:0;display:flex;align-items:center;justify-content:flex-start;gap:6px;height:28px;">
                        <span class="xzg-set-fs-val" style="color:#fff;font-size:12px;width:28px;text-align:left;">${group.fontSize || 14}</span>
                        <div class="xzg-title-color-swatch" style="width:22px;height:22px;border-radius:4px;cursor:pointer;background:${group.titleColor || '#FFD700'};border:1px solid rgba(255,255,255,0.2);flex-shrink:0;"></div>
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
                    <input class="xzg-set-borderopacity" type="range" min="5" max="100" value="${Math.round((group.borderOpacity??0.65)*100)}" style="flex:1;height:28px;margin:0;">
                    <div style="width:72px;flex-shrink:0;display:flex;align-items:center;justify-content:flex-start;height:28px;">
                        <span class="xzg-set-bo-val" style="color:#fff;font-size:12px;text-align:left;">${Math.round((group.borderOpacity??0.65)*100)}%</span>
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
            </div>
            <div style="display:flex;gap:8px;justify-content:space-between;padding-top:4px;">
                <button class="xzg-set-apply-all" type="button" style="height:28px;padding:0 12px;background:#665500;border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:#FFD700;cursor:pointer;font-size:12px;" title="将颜色和动画应用到所有编组">应用到全部</button>
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
            group.borderOpacity = (parseInt(boR.value) || 65) / 100;
            self.updateGroupStyle(group.id);
        });

        // 标题大小滑块
        const fsR = modal.querySelector('.xzg-set-fontsize');
        const fsV = modal.querySelector('.xzg-set-fs-val');
        fsR.addEventListener('input', () => {
            const v = parseInt(fsR.value) || 14;
            fsV.textContent = v;
            group.fontSize = v;
            const span = self.groupEls[group.id]?.querySelector('.xzg-group-title-text');
            if (span) span.style.fontSize = v + 'px';
        });

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
            targetGroup.fontSize = parseInt(modal.querySelector('.xzg-set-fontsize').value) || 14;
            targetGroup.colorHue = sel.h; targetGroup.colorSat = sel.s; targetGroup.colorLit = sel.l;
            targetGroup.effect = modal.querySelector('.xzg-set-effect').value;
            targetGroup.effectSpeed = parseInt(modal.querySelector('.xzg-set-speed').value) || 3;
            targetGroup.borderWidth = parseInt(modal.querySelector('.xzg-set-borderwidth').value) || 2;
            targetGroup.borderOpacity = (parseInt(modal.querySelector('.xzg-set-borderopacity').value) || 65) / 100;
            targetGroup.headerBgColor = (() => {
                const hex = headerColorPicker.value;
                const r = parseInt(hex.slice(1,3),16);
                const g = parseInt(hex.slice(3,5),16);
                const b = parseInt(hex.slice(5,7),16);
                return `rgba(${r},${g},${b},${headerAlpha})`;
            })();
            targetGroup.titleColor = titleColorPicker.value || '#FFD700';

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
                    const span = el.querySelector('.xzg-group-title-text');
                    if (span) {
                        span.textContent = targetGroup.title;
                        span.style.fontSize = targetGroup.fontSize + 'px';
                        span.style.color = targetGroup.titleColor;
                        span.style.display = '';
                    }
                    const header = el.querySelector('.xzg-group-header');
                    if (header) {
                        header.style.height = Math.max(18, targetGroup.fontSize + 4) + 'px';
                        header.style.background = targetGroup.headerBgColor || 'rgba(0,0,0,0.4)';
                    }
                    this.updateGroupStyle(targetGroup.id);
                }
            }

            // 标记工作流已修改，触发保存
            app.graph?.setDirtyCanvas?.(true, true);
            app.graph?.change?.();
            this.syncGroupsToExtra();
        };

        const cleanupModal = () => { if (hiddenPicker && hiddenPicker.parentNode) hiddenPicker.remove(); if (titleColorPicker && titleColorPicker.parentNode) titleColorPicker.remove(); if (modal.parentNode) modal.remove(); };
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
            const fontSize = parseInt(modal.querySelector('.xzg-set-fontsize').value) || 14;
            const bw = parseInt(modal.querySelector('.xzg-set-borderwidth').value) || 2;
            const bo = (parseInt(modal.querySelector('.xzg-set-borderopacity').value) || 65) / 100;
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
                this.updateGroupStyle(g2.id);
                const span = this.groupEls[g2.id]?.querySelector('.xzg-group-title-text');
                if (span) {
                    span.style.fontSize = fontSize + 'px';
                    span.style.color = titleColorPicker.value || '#FFD700';
                }
                const header = this.groupEls[g2.id]?.querySelector('.xzg-group-header');
                if (header) header.style.background = headerBgColor;
            }
            // 标记工作流已修改
            app.graph?.setDirtyCanvas?.(true, true);
            app.graph?.change?.();
            this.syncGroupsToExtra();
            cleanupModal();
        });

        // 点击外部关闭
        modal.addEventListener('mousedown', e => e.stopPropagation());
        const closeOut = e => { if (!modal.contains(e.target)) { revertSnapshot(); cleanupModal(); document.removeEventListener('mousedown', closeOut); } };
        setTimeout(() => document.addEventListener('mousedown', closeOut), 50);

        // 聚焦标题输入
        setTimeout(() => modal.querySelector('.xzg-set-title').focus(), 100);
    },

    /* ── 重命名 ── */
    startRename(gid, span) {
        const group = this.groups[gid];
        if (!group) return;
        const input = document.createElement('input');
        input.value = group.title;
        input.style.cssText = `color:${group.titleColor || '#FFD700'};font-size:${group.fontSize||14}px;font-weight:400;background:rgba(0,0,0,0.8);border:1px solid rgba(255,215,0,0.5);border-radius:3px;padding:1px 4px;outline:none;width:120px;`;
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
            ns.style.cssText = `color:${group.titleColor || '#FFD700'};font-size:${group.fontSize||14}px;font-weight:400;`;
            ns.textContent = group.title;
            input.replaceWith(ns);
        };
        input.addEventListener('blur', done);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = group.title; input.blur(); } });
    },

    /* ── 拖动框体（节点跟随，自动收纳框内节点） ── */
    startDrag(gid, downEv) {
        const group = this.groups[gid];
        if (!group?.bounds) return;
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

        // 收集所有完全位于当前框体内的节点（多个框体能同时控制同一节点）
        const nodeStarts = [];
        const self = this;
        graph._nodes.forEach(n => {
            if (!n?.pos) return;
            const nw = n.size?.[0] || 200, nh = n.size?.[1] || 100;
            if (n.pos[0] >= b.x && n.pos[0] + nw <= b.x + b.w &&
                n.pos[1] >= b.y && n.pos[1] + nh <= b.y + b.h) {
                nodeStarts.push({ node: n, x: n.pos[0], y: n.pos[1] });
            }
        });

        // 子编组：收集完全落在当前框体内的节点（大框体外部的节点不受大框体控制）
        const childGroupData = childGroups.map(cg => ({
            group: cg,
            startX: cg.bounds.x,
            startY: cg.bounds.y,
            nodeStarts: cg.nodeIds.map(nid => {
                const n = graph._nodes.find(x => x.id === nid || x.id == nid);
                if (!n?.pos) return null;
                const nw = n.size?.[0] || 200, nh = n.size?.[1] || 100;
                // 只移动完全落在大框体内的节点
                if (n.pos[0] >= b.x && n.pos[0] + nw <= b.x + b.w &&
                    n.pos[1] >= b.y && n.pos[1] + nh <= b.y + b.h) {
                    return { node: n, x: n.pos[0], y: n.pos[1] };
                }
                return null;
            }).filter(Boolean)
        }));

        // 部分重叠编组（有重叠但未完全位于内部）：不移动编组框，只移动完全落在当前编组内的节点
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
                    const nw = n.size?.[0] || 200, nh = n.size?.[1] || 100;
                    // 节点完全落在当前编组内
                    if (n.pos[0] >= b.x && n.pos[0] + nw <= b.x + b.w &&
                        n.pos[1] >= b.y && n.pos[1] + nh <= b.y + b.h) {
                        partialOverlapNodes.push({ node: n, x: n.pos[0], y: n.pos[1] });
                    }
                });
            }
        }

        const onMove = e => {
            const dx = (e.clientX - startX) / scale;
            const dy = (e.clientY - startY) / scale;
            group.bounds.x = startBX + dx;
            group.bounds.y = startBY + dy;
            nodeStarts.forEach(s => { s.node.pos[0] = s.x + dx; s.node.pos[1] = s.y + dy; });
            // 子编组 bounds 及其所有节点一起跟随移动
            childGroupData.forEach(cg => {
                cg.group.bounds.x = cg.startX + dx;
                cg.group.bounds.y = cg.startY + dy;
                cg.nodeStarts.forEach(s => { s.node.pos[0] = s.x + dx; s.node.pos[1] = s.y + dy; });
            });
            // 部分重叠编组中完全落在大边框内的节点也跟随移动
            partialOverlapNodes.forEach(s => { s.node.pos[0] = s.x + dx; s.node.pos[1] = s.y + dy; });
            graph.setDirtyCanvas?.(true, true);
        };
        const onUp = () => {
            graph.change?.();
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            self.syncGroupsToExtra();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    },

    /* ── 调整大小 ── */
    startResize(gid, downEv) {
        const group = this.groups[gid];
        if (!group?.bounds) return;

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
            app.graph?.change?.();
            self.syncGroupsToExtra();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
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
        const bo = g.borderOpacity ?? 0.65;

        if (g.bypassed) {
            el.style.border = `${bw}px solid hsla(280,60%,55%,${bo})`;
            el.style.boxShadow = 'none';
            el.style.borderImage = 'none';
            el.style.background = 'transparent';
            if (refs.title) refs.title.style.color = 'hsla(280,60%,65%,0.85)';
            if (refs.delBtn) refs.delBtn.style.color = `hsla(280,60%,65%,${bo * 0.8})`;
            if (refs.rpath) refs.rpath.setAttribute('stroke', `hsla(280,60%,55%,${bo})`);
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
            if (refs.delBtn) refs.delBtn.style.color = `hsla(${h},${s}%,${l}%,${Math.min(bo + 0.1, 1)})`;
            if (refs.rpath) refs.rpath.setAttribute('stroke', `hsla(${h},${s}%,${l}%,${bo})`);
        }
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

    /* ── 旁路 ── */
    toggleBypass(gid) {
        const g = this.groups[gid];
        if (!g) return;
        const graph = app?.graph;
        if (!graph) return;

        const willBypass = !g.bypassed;
        const mode = willBypass ? MODE_BYPASS : MODE_ALWAYS;
        const b = g.bounds;

        // 1. 完全子编组（完全位于内部）：切换编组状态，只切换完全落在当前框体内的节点
        const fullChildGroupIds = this._collectChildGroups(gid);
        fullChildGroupIds.forEach(id => {
            const grp = this.groups[id];
            if (!grp) return;
            grp.bypassed = willBypass;
            grp.nodeIds.forEach(nid => {
                const n = graph._nodes.find(x => x.id === nid || x.id == nid);
                if (!n?.pos) return;
                const nw = n.size?.[0] || 200, nh = n.size?.[1] || 100;
                // 只切换完全落在大框体内的节点（大框体外部的节点不受大框体控制）
                if (n.pos[0] >= b.x && n.pos[0] + nw <= b.x + b.w &&
                    n.pos[1] >= b.y && n.pos[1] + nh <= b.y + b.h) {
                    n.mode = mode;
                }
            });
            this.updateGroupStyle(id);
        });

        // 2. 部分重叠编组（有重叠但未完全位于内部）：不切换编组状态，只切换完全落在当前编组内的节点
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
                    const nw = n.size?.[0] || 200, nh = n.size?.[1] || 100;
                    // 节点完全落在当前编组内
                    if (n.pos[0] >= b.x && n.pos[0] + nw <= b.x + b.w &&
                        n.pos[1] >= b.y && n.pos[1] + nh <= b.y + b.h) {
                        n.mode = mode;
                    }
                });
            }
        }

        graph.setDirtyCanvas?.(true, true); graph.change?.();
        this.syncGroupsToExtra();
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
        this.killGroup(gid);
        graph?.setDirtyCanvas?.(true, true); graph?.change?.();
        this.syncGroupsToExtra();
    },

    /* ── 持久化：同步到 app.graph.extra + localStorage ── */
    syncGroupsToExtra() {
        if (!app?.graph) return;
        const gd = {};
        for (const [id, g] of Object.entries(this.groups)) {
            gd[id] = { id: g.id, title: g.title, nodeIds: [...g.nodeIds], bypassed: g.bypassed, bounds: { ...g.bounds }, fontSize: g.fontSize, colorHue: g.colorHue, colorSat: g.colorSat, colorLit: g.colorLit, effect: g.effect, effectSpeed: g.effectSpeed, borderWidth: g.borderWidth, borderOpacity: g.borderOpacity, headerBgColor: g.headerBgColor, titleColor: g.titleColor };
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
        const LG = window.LiteGraph;
        if (!LG) {
            if (retryCount < 60) {
                setTimeout(() => self.setupSerializationHooks(retryCount + 1), 100);
                return;
            }
            console.warn('[小珠光编组] 序列化 Hook 安装失败：LiteGraph 超时未就绪，将使用 extra 备份');
            // 即使 LiteGraph 不可用，也尝试用 extra 做持久化
            window._xzg_srl = true;
            this._setupExtraBasedPersistence();
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
                        if (this._xzgGroupId) {
                            d._xzgGroupId = this._xzgGroupId;
                            if (this._xzgGroupData) d._xzgGroup = JSON.parse(JSON.stringify(this._xzgGroupData));
                        }
                        return d;
                    };
                }
            } catch(e) {}
            try {
                const c = LG.LGraphNode.prototype.configure;
                if (c) {
                    LG.LGraphNode.prototype.configure = function(d) {
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
                        const gd = {};
                        for (const [id, g] of Object.entries(self.groups)) {
                            gd[id] = { id: g.id, title: g.title, nodeIds: [...g.nodeIds], bypassed: g.bypassed, bounds: { ...g.bounds }, fontSize: g.fontSize, colorHue: g.colorHue, colorSat: g.colorSat, colorLit: g.colorLit, effect: g.effect, effectSpeed: g.effectSpeed, borderWidth: g.borderWidth, borderOpacity: g.borderOpacity, headerBgColor: g.headerBgColor, titleColor: g.titleColor };
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
                        const pendingFromTop = d?._xzgGroups || d?.extra?.xzgGroups || null;
                        if (pendingFromTop) console.log('[小珠光编组] LGraph.configure检测到编组数据:', Object.keys(pendingFromTop).length, '个');
                        c.apply(this, arguments);
                        if (app?.graph !== this) return;
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
        }

        // 额外保障：基于 extra 的持久化（新版 ComfyUI 前端兼容）
        this._setupExtraBasedPersistence();
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
                gd[id] = { id: g.id, title: g.title, nodeIds: [...g.nodeIds], bypassed: g.bypassed, bounds: { ...g.bounds }, fontSize: g.fontSize, colorHue: g.colorHue, colorSat: g.colorSat, colorLit: g.colorLit, effect: g.effect, effectSpeed: g.effectSpeed, borderWidth: g.borderWidth, borderOpacity: g.borderOpacity, headerBgColor: g.headerBgColor, titleColor: g.titleColor };
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

        console.log('[小珠光编组] 恢复编组...', this._pendingGroups ? Object.keys(this._pendingGroups).length + '个编组数据待恢复' : '无待恢复数据');

        // 优先从工作流保存的完整编组数据恢复（包含动画、颜色、标题等）
        if (this._pendingGroups) {
            for (const [id, g] of Object.entries(this._pendingGroups)) {
                this.groups[id] = { ...g };
            }
            this._pendingGroups = null;
        }

        // 额外：从 app.graph.extra 恢复（兼容新版 ComfyUI 前端）
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
            if (!this.groups[gid]) {
                const bounds = this.calcBounds(nids) || { x: 0, y: 0, w: 300, h: 200 };
                this.groups[gid] = { id: gid, title: '右键标题栏设置', nodeIds: nids, bypassed: false, bounds, fontSize: 14, colorHue: 48, colorSat: 100, colorLit: 55, effect: 'none', effectSpeed: 3, borderWidth: 2, borderOpacity: 0.65, headerBgColor: 'rgba(0,0,0,0.4)', titleColor: '#FFD700' };
            } else {
                this.groups[gid].nodeIds = nids;
                // 确保bounds存在
                if (!this.groups[gid].bounds) {
                    this.groups[gid].bounds = this.calcBounds(nids) || { x: 0, y: 0, w: 300, h: 200 };
                }
            }
        }
        for (const gid of Object.keys(this.groups)) if (!this.groups[gid].nodeIds || !this.groups[gid].nodeIds.length) delete this.groups[gid];
        this.rebuildAllEls();
        this.applyBypassStates();
        console.log('[小珠光编组] 恢复完成，编组数量:', Object.keys(this.groups).length);
    },

    applyBypassStates() {
        const g = app?.graph;
        if (!g?._nodes) return;
        for (const grp of Object.values(this.groups)) {
            const m = grp.bypassed ? MODE_BYPASS : MODE_ALWAYS;
            grp.nodeIds.forEach(nid => { const n = g._nodes.find(x => x.id === nid || x.id == nid); if (n) n.mode = m; });
        }
        g.setDirtyCanvas?.(true, true);
    }
};

app.registerExtension({ name: 'ComfyUI.xiaozhuguang.group', setup() { XZGGroup.init(); } });
