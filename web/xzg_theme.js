
import { xzgT } from "./xzg_i18n.js";
import { cloudLoad, cloudSave } from "./xzg_cloud_store.js";
import { api } from "../../scripts/api.js";

// 主题状态云存储键：连线高亮/执行节点高亮/连线动画/壁纸小状态
const THEME_STATE_KEY = "xzg_theme_state";

// 找到当前画布实际解析 drawNode 的最近原型，兼容 LiteGraph 子类覆盖以及实例覆写。
function _xzgGetDrawNodeOwner(canvas = window.app?.canvas) {
    let owner = canvas;
    while (owner && owner !== Object.prototype) {
        if (Object.prototype.hasOwnProperty.call(owner, 'drawNode') && typeof owner.drawNode === 'function') return owner;
        owner = Object.getPrototypeOf(owner);
    }
    const fallback = globalThis.LGraphCanvas?.prototype || globalThis.LiteGraph?.LGraphCanvas?.prototype;
    return fallback && typeof fallback.drawNode === 'function' ? fallback : null;
}

// ===== 运行节点高亮的“按图归属”修复（对齐官方 ComfyUI）=====
// 官方做法：执行/已执行事件（executing/executed）都携带 prompt_id，ComfyUI 把“正在执行/高亮”
// 定位到 *发起该次执行的那个工作流图*（通过 prompt_id→graph 归属解析），而不是在当前激活图里
// 按裸 node_id 去找。下述是官方实现要点：
//   - `executed` 事件：getNodeByExecutionId(this.rootGraph, executionId) 只在当前根图里解析；
//   - 执行态/节点输出按 prompt_id 对应到 queuedJobs[prompt_id].workflow（发起图）做记录。
// 我们之前用全局 _runningNodeId（只存 node_id、不存图）并在“当前激活图”里解析，于是 A 流执行
// 1 号节点时切到 B 流，B 里同 id 的 1 号节点也被画上运行高亮（跨工作流串台）。
// 修复：入队/点 Run 时记录「prompt_id → 发起该次执行的 rootGraph 实例」（下面 _xzgPromptOwnerGraph），
// 收到 executing 事件时把 {ownerGraph, nodeId} 存进 self._runningJob；绘制时动态判定
// ownerGraph 是否等于“当前激活图”，是才画高亮 —— 切图/后台执行都会自然被排除，绝不串台。
const _xzgPromptOwnerGraph = new Map();
let _xzgPromptOwnerWrapped = false;
// 最近一次 Run 的发起图（app.graph）。executing 事件 detail 只带裸节点 id、不带 prompt_id，
// 归属图以此兜底，用于跨工作流防串台（与 xzg_video_combine 的 _xzgRunningGraph 同思路）。
let _xzgRunOwnerGraph = null;
// 运行高亮调试开关（仅用于排查，默认关闭）
window.__xzgHighlightDebug = false;

// 包装 app.queuePrompt：入队后拿到服务端返回的 prompt_id，登记该次执行归属哪个图实例。
// 幂等：只包一次，避免重复包装拉长调用链。
function _xzgWrapQueueForRunningOwner() {
    if (_xzgPromptOwnerWrapped) return;
    const app = window.app;
    if (!app || typeof app.queuePrompt !== 'function') return;
    _xzgPromptOwnerWrapped = true;
    const orig = app.queuePrompt.bind(app);
    app.queuePrompt = function (...args) {
        // 发起时刻的激活图 = 本次执行的归属图（点 Run/Queue 时 app.graph 就是当前图）。
        // 注意用 app.graph 而非 app.rootGraph：节点所在图 node.graph 与 app.graph 同引用
        // （已由 xzg_video_combine 的运行高亮/输出归属验证），而 rootGraph 在该前端可能是
        // 另一包装实例，引用不等会把同一工作流的运行高亮也误判为"他图"而全部吞掉。
        const ownerGraph = app.graph;
        _xzgRunOwnerGraph = ownerGraph;
        const ret = orig(...args);
        if (ret && typeof ret.then === 'function') {
            ret.then((res) => {
                const pid = res && res.prompt_id;
                if (pid != null) _xzgPromptOwnerGraph.set(String(pid), ownerGraph);
            }).catch(() => {});
        }
        return ret;
    };
}
// ===== 运行节点高亮归属修复（结束）=====

window.XZGThemeManager = {
    currentNodes: [],
    styleElement: null,
    panelStyleElement: null,
    canvasHooked: false,
    protoRefs: {},
    linkHighlightActive: false,
    linkHighlightHooked: false,
    linkLaserActive: false,
    laserAnimType: 'flow',
    linkColorActive: false,
    linkColor: '#888888',
    linkAnimActive: false,
    linkAnimType: 'sparkle',
    linkAnimSpeed: 1.0,
    linkAnimRunning: false,
    linkAnimFrameId: null,
    linkHighlightDimAlpha: 0.45,
    // 连线高亮模式下的动画类型（'none' 表示仅金色高亮，无动画）
    linkHighlightAnimType: 'none',
    // 吃豆人动画状态
    _pacCurrentKey: null,
    _pacProgress: 0,
    _pacLastTime: 0,
    _pacLinkSet: null,
    wallpaperActive: false,
    wallpaperType: 'image',
    wallpaperData: null,
    wallpaperOpacity: 0.5,
    wallpaperFit: 'cover',
    _wallpaperEl: null,
    _wallpaperVideoEl: null,
    _wpDB: null,
    _wpDBReady: false,
    _wpPendingSave: null,
    // 节点执行高亮（颜色）
    nodeHighlightActive: false,
    nodeHighlightHooked: false,
    // 高亮钩子"成功装过一次"的标记：用于与 xzg_compose_tool 的 drawNode
    // 轮询钩子（__xzgShadowGuard）共存，防止两个 200/500/750ms 轮询互相
    // 重装包装形成互刷死循环。
    _nodeHighlightHookedOnce: false,
    _runningNodeId: null,
    _runningNodeDOMElements: new Set(),
    _runningNodeDOMKey: null,
    _runningNodeDOMGraph: null,
    nodeHighlightColor: '#22FF22',
    // 多色动画类型（flow 流动 / 连线效果移植系列）+ 流速（1-100，50=默认速度，按比例换算）
    nodeHighlightSpeed: 50,
    nodeHighlightColorAnim: 'flow',
    // 移植连线动画时粒子大小（0-100 刻度，50=默认大小）与数量倍率
    nodeHighlightParticleSize: 50,
    nodeHighlightParticleCount: 1,
    // 主题状态云持久化
    _themeCloudTimer: null,
    _themeCloudRestored: false,

    init() {
        // 从 localStorage 恢复连线高亮状态
        try {
            const saved = localStorage.getItem('xzg-link-highlight');
            if (saved === 'true') {
                this.linkHighlightActive = true;
            }
            // 连线高亮动画类型
            const hlAnimTypeSaved = localStorage.getItem('xzg-link-highlight-anim-type');
            if (hlAnimTypeSaved) {
                this.linkHighlightAnimType = hlAnimTypeSaved;
            }
            // 节点执行高亮，默认关闭
            const nhSaved = localStorage.getItem('xzg-node-highlight');
            if (nhSaved === 'true') {
                this.nodeHighlightActive = true;
            }
            // 节点高亮颜色
            const nhColor = localStorage.getItem('xzg-node-highlight-color');
            if (nhColor) {
                this.nodeHighlightColor = nhColor;
            }
            // 节点高亮多色流动周期 + 多色动画类型
            const nhSpeed = parseInt(localStorage.getItem('xzg-node-highlight-speed'));
            if (!isNaN(nhSpeed) && nhSpeed >= 1) this.nodeHighlightSpeed = Math.min(100, nhSpeed);
            const nhAnim = localStorage.getItem('xzg-node-highlight-anim');
            if (nhAnim && ['flow', 'energy', 'stellar', 'transfer', 'diy1', 'diy2'].includes(nhAnim)) this.nodeHighlightColorAnim = nhAnim;
            // 粒子大小（0-100，50=默认）与数量倍率；旧版本存的是倍率（0.5-3），自动 ×50 换算
            const nhPS = parseFloat(localStorage.getItem('xzg-node-highlight-particle-size'));
            if (!isNaN(nhPS) && nhPS > 0) this.nodeHighlightParticleSize = nhPS <= 3 ? Math.min(100, nhPS * 50) : Math.min(100, nhPS);
            const nhPC = parseFloat(localStorage.getItem('xzg-node-highlight-particle-count'));
            if (!isNaN(nhPC) && nhPC > 0) this.nodeHighlightParticleCount = nhPC;
            // 连线动画（星芒效果），默认关闭
            const animSaved = localStorage.getItem('xzg-link-anim');
            if (animSaved === 'true') {
                this.linkAnimActive = true;
            }
            const animTypeSaved = localStorage.getItem('xzg-link-anim-type');
            if (animTypeSaved) {
                this.linkAnimType = animTypeSaved;
            }
            const animSpeedSaved = localStorage.getItem('xzg-link-anim-speed');
            if (animSpeedSaved) {
                const v = parseFloat(animSpeedSaved);
                if (!isNaN(v) && v > 0) this.linkAnimSpeed = v;
            }
            // 连线动画功能已取消，强制关闭
            // const laserSaved = localStorage.getItem('xzg-link-laser');
            // if (laserSaved === 'true') {
            //     this.linkLaserActive = true;
            // }
            this.linkLaserActive = false;
            const laserColorSaved = localStorage.getItem('xzg-laser-color');
            if (laserColorSaved) {
                // 兼容旧数据：将旧的 laserColor 迁移到 linkColor
                try { localStorage.setItem('xzg-link-color', laserColorSaved); } catch(e) {}
                localStorage.removeItem('xzg-laser-color');
            }
            // const animTypeSaved = localStorage.getItem('xzg-laser-anim-type');
            // if (animTypeSaved) {
            //     this.laserAnimType = animTypeSaved;
            // }
            const lcSaved = localStorage.getItem('xzg-link-color');
            if (lcSaved) {
                this.linkColor = lcSaved;
            }
            // 连线颜色功能已取消，强制关闭
            // const lcActiveSaved = localStorage.getItem('xzg-link-color-active');
            // if (lcActiveSaved === 'true') {
            //     this.linkColorActive = true;
            // }
            this.linkColorActive = false;
        } catch(e) {}

        // 从 localStorage 恢复壁纸设置（小数据）
        try {
            const wpActive = localStorage.getItem('xzg-wallpaper-active');
            if (wpActive === 'true') {
                this.wallpaperActive = true;
            }
            const wpType = localStorage.getItem('xzg-wallpaper-type');
            if (wpType) {
                this.wallpaperType = wpType;
            }
            const wpData = localStorage.getItem('xzg-wallpaper-data');
            if (wpData) {
                this.wallpaperData = wpData;
            }
            const wpOpacity = localStorage.getItem('xzg-wallpaper-opacity');
            if (wpOpacity) {
                this.wallpaperOpacity = parseFloat(wpOpacity);
            }
            const wpFit = localStorage.getItem('xzg-wallpaper-fit');
            if (wpFit) {
                this.wallpaperFit = wpFit;
            }
        } catch(e) {}

        // 各步骤独立容错：任一步抛错只告警不中断，保证高亮钩子与监视器必然安装。
        const safeStep = (name, fn) => {
            try { fn.call(this); } catch (e) {
                console.warn(`[小珠光主题] init步骤 ${name} 失败:`, e);
            }
        };
        safeStep('injectPanelStyles', this.injectPanelStyles);
        safeStep('setupContextMenu', this.setupContextMenu);
        safeStep('ensureCanvasHook', this.ensureCanvasHook);
        safeStep('hookSerialize', this.hookSerialize);
        safeStep('_initWallpaperDB', this._initWallpaperDB);
        safeStep('initWallpaper', this.initWallpaper);
        // 执行事件监听与 LiteGraph 画布绘制钩子分开安装：Nodes 2 可能没有
        // 可用的 LGraphCanvas.drawNode，但仍必须收到 executing 事件来标记 DOM 节点。
        safeStep('_ensureNodeHighlightEvents', this._ensureNodeHighlightEvents);
        safeStep('_ensureNodeHighlightHook', this._ensureNodeHighlightHook);
        if (!this._nodeHighlightHookMonitor) {
            // 独立监视执行描边钩子，避免初始化时处于 Nodes 2 或被其他扩展覆盖后，
            // 切回 Nodes 1 时 drawNode 没有重新挂上高亮绘制。
            this._nodeHighlightHookMonitor = setInterval(() => {
                try { this._ensureNodeHighlightEvents(); } catch (e) { console.warn('[小珠光主题] 执行事件钩子维护失败:', e); }
                try {
                    const drawTarget = _xzgGetDrawNodeOwner();
                    if (!drawTarget?.drawNode) return;
                    // 共存判定：顶层已被 compose_tool 的 ShadowGuard 包装且我们已成功
                    // 装过一次时，我们的包装在其下正常工作，不再重装（防互刷死循环）。
                    if (this._nodeHighlightHookedOnce && drawTarget.drawNode.__xzgShadowGuard) {
                        this.nodeHighlightHooked = true;
                        return;
                    }
                    if (!drawTarget.drawNode._xzgNodeHighlightWrapped) {
                        this.nodeHighlightHooked = false;
                        this._ensureNodeHighlightHook();
                    }
                } catch (e) { console.warn('[小珠光主题] 高亮钩子监视失败:', e); }
            }, 500);
        }
        if (!this._nodeHighlightPoller) {
            // Nodes 2 的 DOM 画布不保证在 executing 事件到达时已经完成节点渲染；
            // 轮询 Comfy 自身的 runningNodeId，确保短执行和事件源差异也能显示。
            this._nodeHighlightPoller = setInterval(() => {
                if (!this.nodeHighlightActive) return;
                const flag = globalThis.LiteGraph?.vueNodesMode;
                const isVue = typeof flag === 'boolean'
                    ? flag
                    : !!document.querySelector('.lg-node[data-node-id], .comfy-node[data-node-id]');
                if (isVue) this.refreshRunningNodeHighlight();
            }, 100);
        }
        // 云持久化：保留上面的同步本地恢复，再异步以服务端为准覆盖
        this._cloudRestoreTheme();
    },

    // ====== 主题状态云持久化（连线高亮/节点高亮/连线动画/壁纸小状态） ======
    _collectThemeState() {
        return {
            linkHighlightActive: !!this.linkHighlightActive,
            linkHighlightAnimType: this.linkHighlightAnimType || 'none',
            nodeHighlightActive: !!this.nodeHighlightActive,
            nodeHighlightColor: this.nodeHighlightColor || '#22FF22',
            nodeHighlightSpeed: this.nodeHighlightSpeed || 50,
            nodeHighlightColorAnim: this.nodeHighlightColorAnim || 'flow',
            nodeHighlightParticleSize: this.nodeHighlightParticleSize || 50,
            nodeHighlightParticleCount: this.nodeHighlightParticleCount || 1,
            linkAnimActive: !!this.linkAnimActive,
            linkAnimType: this.linkAnimType || 'sparkle',
            linkAnimSpeed: this.linkAnimSpeed || 1.0,
            wallpaperActive: !!this.wallpaperActive,
            wallpaperType: this.wallpaperType || 'image',
            wallpaperOpacity: (typeof this.wallpaperOpacity === 'number') ? this.wallpaperOpacity : 0.5,
            wallpaperFit: this.wallpaperFit || 'cover'
        };
    },

    _queueThemeCloudSave() {
        if (this._themeCloudTimer) clearTimeout(this._themeCloudTimer);
        const self = this;
        this._themeCloudTimer = setTimeout(() => {
            this._themeCloudTimer = null;
            cloudSave(THEME_STATE_KEY, self._collectThemeState()).catch(() => {});
        }, 500);
    },

    /** 把内存态写回各 localStorage 键，保证离线/下次同步 init 读取一致 */
    _persistThemeLocalKeys() {
        const set = (k, v) => { try { localStorage.setItem(k, v); } catch(e) {} };
        set('xzg-link-highlight', this.linkHighlightActive ? 'true' : 'false');
        set('xzg-link-highlight-anim-type', this.linkHighlightAnimType || 'none');
        set('xzg-node-highlight', this.nodeHighlightActive ? 'true' : 'false');
        set('xzg-node-highlight-color', this.nodeHighlightColor || '#22FF22');
        set('xzg-node-highlight-speed', String(this.nodeHighlightSpeed || 50));
        set('xzg-node-highlight-anim', this.nodeHighlightColorAnim || 'flow');
        set('xzg-node-highlight-particle-size', String(this.nodeHighlightParticleSize || 50));
        set('xzg-node-highlight-particle-count', String(this.nodeHighlightParticleCount || 1));
        set('xzg-link-anim', this.linkAnimActive ? 'true' : 'false');
        set('xzg-link-anim-type', this.linkAnimType || 'sparkle');
        set('xzg-link-anim-speed', String(this.linkAnimSpeed || 1.0));
        set('xzg-wallpaper-active', this.wallpaperActive ? 'true' : 'false');
        set('xzg-wallpaper-type', this.wallpaperType || 'image');
        set('xzg-wallpaper-opacity', String((typeof this.wallpaperOpacity === 'number') ? this.wallpaperOpacity : 0.5));
        set('xzg-wallpaper-fit', this.wallpaperFit || 'cover');
    },

    async _cloudRestoreTheme() {
        if (this._themeCloudRestored) return;
        this._themeCloudRestored = true;
        try {
            const s = await cloudLoad(THEME_STATE_KEY, { fallbackValue: null });
            if (!s || typeof s !== "object") return;
            const wpWasActive = this.wallpaperActive;
            const wpWasOpacity = this.wallpaperOpacity;
            const wpWasFit = this.wallpaperFit;
            // 本地是即时写入的最近状态；云端同步可能晚于开关操作，不能用旧值覆盖本地。
            const hasLocal = (key) => {
                try { return localStorage.getItem(key) !== null; } catch (_) { return false; }
            };
            if (!hasLocal('xzg-link-highlight') && typeof s.linkHighlightActive === "boolean") this.linkHighlightActive = s.linkHighlightActive;
            if (!hasLocal('xzg-link-highlight-anim-type') && typeof s.linkHighlightAnimType === "string") this.linkHighlightAnimType = s.linkHighlightAnimType;
            if (!hasLocal('xzg-node-highlight') && typeof s.nodeHighlightActive === "boolean") this.nodeHighlightActive = s.nodeHighlightActive;
            if (!hasLocal('xzg-node-highlight-color') && typeof s.nodeHighlightColor === "string") this.nodeHighlightColor = s.nodeHighlightColor;
            if (!hasLocal('xzg-node-highlight-speed') && typeof s.nodeHighlightSpeed === "number" && s.nodeHighlightSpeed >= 1) this.nodeHighlightSpeed = Math.min(100, s.nodeHighlightSpeed);
            if (!hasLocal('xzg-node-highlight-anim') && typeof s.nodeHighlightColorAnim === "string" && ['flow', 'energy', 'stellar', 'transfer', 'diy1', 'diy2'].includes(s.nodeHighlightColorAnim)) this.nodeHighlightColorAnim = s.nodeHighlightColorAnim;
            if (!hasLocal('xzg-node-highlight-particle-size') && typeof s.nodeHighlightParticleSize === "number" && s.nodeHighlightParticleSize > 0) this.nodeHighlightParticleSize = s.nodeHighlightParticleSize <= 3 ? Math.min(100, s.nodeHighlightParticleSize * 50) : Math.min(100, s.nodeHighlightParticleSize);
            if (!hasLocal('xzg-node-highlight-particle-count') && typeof s.nodeHighlightParticleCount === "number" && s.nodeHighlightParticleCount > 0) this.nodeHighlightParticleCount = s.nodeHighlightParticleCount;
            if (!hasLocal('xzg-link-anim') && typeof s.linkAnimActive === "boolean") this.linkAnimActive = s.linkAnimActive;
            if (!hasLocal('xzg-link-anim-type') && typeof s.linkAnimType === "string") this.linkAnimType = s.linkAnimType;
            if (!hasLocal('xzg-link-anim-speed') && typeof s.linkAnimSpeed === "number" && s.linkAnimSpeed > 0) this.linkAnimSpeed = s.linkAnimSpeed;
            if (!hasLocal('xzg-wallpaper-active') && typeof s.wallpaperActive === "boolean") this.wallpaperActive = s.wallpaperActive;
            if (!hasLocal('xzg-wallpaper-type') && typeof s.wallpaperType === "string") this.wallpaperType = s.wallpaperType;
            if (!hasLocal('xzg-wallpaper-opacity') && typeof s.wallpaperOpacity === "number") this.wallpaperOpacity = s.wallpaperOpacity;
            if (!hasLocal('xzg-wallpaper-fit') && typeof s.wallpaperFit === "string") this.wallpaperFit = s.wallpaperFit;
            this._persistThemeLocalKeys();
            // 重新应用壁纸（图片数据不进云，本地有才显示）
            if (this.wallpaperActive && this.wallpaperData && (wpWasActive !== this.wallpaperActive || wpWasOpacity !== this.wallpaperOpacity || wpWasFit !== this.wallpaperFit)) {
                this._wpBgDrawCache = null;
                this._renderWallpaperToBgCanvas();
            }
            if (this.wallpaperActive !== wpWasActive) {
                this._wpBgDrawCache = null;
                if (this.wallpaperActive && this.wallpaperData) {
                    this.initWallpaper();
                } else if (!this.wallpaperActive) {
                    this._setCanvasTransparent(false);
                    if (this._wpBgCanvas && this._wpBgCtx) {
                        this._wpBgCtx.clearRect(0, 0, this._wpBgCanvas.width, this._wpBgCanvas.height);
                    }
                }
            }
            // 强制重绘，drawLink/节点高亮 hook 读取最新字段并自动启动动画循环。
            // 用 window.app 而非裸 app：本模块是 ES module，裸 app 依赖全局绑定 window.app，
            // 若此刻尚未赋值则抛 ReferenceError("app is not defined")，被外层 catch 吞掉导致云状态恢复静默失效。
            this.setupLinkHighlight();
            if (window.app?.canvas?.setDirty) window.app.canvas.setDirty(true, true);
            window.app?.graph?.setDirtyCanvas?.(true, true);
            requestAnimationFrame(() => {
                this.setupLinkHighlight();
                window.app?.canvas?.setDirty?.(true, true);
                window.app?.graph?.setDirtyCanvas?.(true, true);
            });
        } catch (e) {
            console.warn("[小珠光主题] 从云同步主题状态失败:", e);
        }
    },

    injectPanelStyles() {
        if (document.getElementById("xzg-theme-panel-style")) return;
        
        const css = `
.xzg-theme-panel {
    position: fixed;
    z-index: 99999;
    width: 280px;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif;
    color: #ddd;
    display: none;
    overflow: hidden;
}

.xzg-theme-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 7px 12px;
    background: #2a2a2a;
    border-bottom: 1px solid #444;
    color: #ddd;
    font-size: 14px;
    font-weight: bold;
}

.xzg-theme-title {
    font-size: 13px;
}

.xzg-theme-header-btns {
    display: flex;
    align-items: center;
    gap: 5px;
}

.xzg-theme-config-btn,
.xzg-theme-shortcut-btn {
    background: transparent;
    border: 1px solid #555;
    color: #ddd;
    font-size: 10px;
    font-weight: bold;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    text-align: center;
    transition: all 0.2s;
}

.xzg-theme-config-btn:hover,
.xzg-theme-shortcut-btn:hover {
    background: rgba(255, 255, 255, 0.1);
}

.xzg-theme-close {
    background: none;
    border: none;
    color: #999;
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    opacity: 0.8;
    transition: opacity 0.2s;
}

.xzg-theme-close:hover {
    opacity: 1;
}

.xzg-top-tabs {
    display: flex;
    background: #1e1e1e;
    border-bottom: 2px solid #333;
    position: relative;
}

.xzg-top-tab {
    flex: 1;
    padding: 8px 0;
    background: none;
    border: none;
    color: #888;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    position: relative;
    letter-spacing: 1px;
}

.xzg-top-tab:hover {
    color: #ccc;
    background: rgba(255, 255, 255, 0.03);
}

.xzg-top-tab.active {
    color: #FFD700;
    font-weight: bold;
    text-shadow: 0 0 8px rgba(255, 215, 0, 0.4);
}

.xzg-top-tab.active::after {
    content: '';
    position: absolute;
    bottom: -2px;
    left: 15%;
    width: 70%;
    height: 2px;
    background: #FFD700;
    box-shadow: 0 0 6px rgba(255, 215, 0, 0.6);
    border-radius: 2px 2px 0 0;
}

.xzg-tab-content {
    box-sizing: border-box;
}

.xzg-tab-content[data-tab-content="menuhide"] {
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.xzg-theme-content {
    padding: 9px;
    max-height: 500px;
    overflow-y: auto;
}

.xzg-theme-section {
    margin-bottom: 9px;
}

.xzg-theme-section:last-child {
    margin-bottom: 0;
}

.xzg-theme-section-title {
    font-size: 12px;
    color: #888;
    margin-bottom: 5px;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.xzg-theme-preview {
    width: 100%;
    height: 40px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 9px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.xzg-preview-text {
    font-size: 12px;
    font-weight: bold;
    color: #fff;
}

.xzg-theme-color-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    margin-bottom: 5px;
}

.xzg-theme-label {
    font-size: 12px;
    color: #aaa;
    min-width: 60px;
}

.xzg-theme-color-row input[type="color"] {
    width: 50px;
    height: 28px;
    border: 1px solid #555;
    border-radius: 4px;
    cursor: pointer;
    background: #333;
    padding: 0;
}

.xzg-theme-direction-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    margin-bottom: 6px;
    margin-top: 0;
}

.xzg-direction-buttons {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
}

.xzg-dir-btn {
    width: 24px;
    height: 22px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #333;
    color: #aaa;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
}

.xzg-dir-btn:hover {
    background: #444;
    color: #fff;
}

.xzg-dir-btn.active {
    background: #333;
    border-color: #fff;
    color: #fff;
}

.xzg-theme-separator {
    height: 1px;
    background: #444;
    margin: 6px 0;
}

.xzg-theme-font-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    margin-top: 0;
    margin-bottom: 6px;
}

.xzg-font-size-control {
    display: flex;
    align-items: center;
    gap: 3px;
}

.xzg-font-btn {
    width: 28px;
    height: 22px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #333;
    color: #aaa;
    cursor: pointer;
    font-size: 11px;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
}

.xzg-font-btn:hover {
    background: #444;
    color: #fff;
}

.xzg-font-btn:active {
    transform: scale(0.95);
}

.xzg-font-size-value {
    min-width: 30px;
    text-align: center;
    font-size: 12px;
    color: #ccc;
}

.xzg-align-buttons {
    display: flex;
    gap: 4px;
}

.xzg-align-btn {
    width: 32px;
    height: 22px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #333;
    color: #aaa;
    cursor: pointer;
    font-size: 11px;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
}

.xzg-align-btn:hover {
    background: #444;
    color: #fff;
}

.xzg-align-btn.active {
    background: #333;
    border-color: #fff;
    color: #fff;
}

.xzg-apply-btn {
    width: 100%;
    padding: 7px 16px;
    background: transparent;
    color: #FFD700;
    border: 1px solid #555;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: bold;
    text-shadow: 0 0 8px rgba(255, 215, 0, 0.6);
    transition: all 0.2s;
    margin-top: 0;
    margin-bottom: 6px;
}

.xzg-apply-btn:hover {
    background: rgba(255, 215, 0, 0.1);
}

.xzg-apply-btn:active {
    transform: translateY(0);
}

.xzg-reset-btn {
    width: 100%;
    padding: 5px 16px;
    background: transparent;
    color: #ddd;
    border: 1px solid #555;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
    margin-top: 0;
    margin-bottom: 6px;
}

.xzg-reset-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
}

.xzg-theme-content::-webkit-scrollbar {
    width: 6px;
}

.xzg-theme-content::-webkit-scrollbar-track {
    background: #222;
}

.xzg-theme-content::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 3px;
}

.xzg-theme-content::-webkit-scrollbar-thumb:hover {
    background: #666;
}

.xzg-color-swatches {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-bottom: 6px;
}

.xzg-swatch-group {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
}

.xzg-theme-section > .xzg-swatch-group {
    margin-bottom: 6px;
}

.xzg-theme-section > *:last-child {
    margin-bottom: 0;
}

.xzg-swatch-label {
    font-size: 12px;
    color: #aaa;
    min-width: 40px;
}

.xzg-swatch-row {
    display: flex;
    gap: 3px;
}

.xzg-color-swatch {
    width: 50px;
    height: 22px;
    border: 2px solid #555;
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
    transition: all 0.2s;
}

.xzg-color-swatch:hover {
    border-color: #888;
    transform: scale(1.1);
}

.xzg-color-swatch.active {
    border-color: #fff;
    box-shadow: 0 0 0 2px #667eea;
}

.xzg-color-swatch:active {
    transform: scale(0.95);
}

.xzg-text-swatch {
    border-style: solid;
}

.xzg-picker-section {
    padding: 9px;
    background: #222;
    border-bottom: 1px solid #444;
}

.xzg-sv-area {
    position: relative;
    width: 100%;
    height: 120px;
    border-radius: 6px;
    margin-bottom: 7px;
    cursor: crosshair;
    background-color: hsl(240, 100%, 50%);
    border: 1px solid #555;
    overflow: hidden;
}

.xzg-sv-white {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(to right, #fff, transparent);
}

.xzg-sv-black {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(to top, #000, transparent);
}

.xzg-sv-cursor {
    position: absolute;
    width: 18px;
    height: 18px;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 2;
}

.xzg-hue-row {
    margin-bottom: 0;
}

.xzg-hue-bar {
    position: relative;
    width: 100%;
    height: 16px;
    border-radius: 8px;
    background: linear-gradient(to right, 
        #ff0000 0%, #ffff00 17%, #00ff00 33%, 
        #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%);
    cursor: pointer;
    border: 1px solid #555;
}

.xzg-hue-cursor {
    position: absolute;
    top: 50%;
    width: 16px;
    height: 16px;
    border: 2px solid #fff;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.3);
    pointer-events: none;
}

.xzg-title-toggle-row {
    margin-bottom: 0;
}

.xzg-title-gradient-section.xzg-swatch-group {
    justify-content: flex-end;
}

.xzg-theme-direction-row.xzg-title-gradient-section {
    justify-content: flex-end;
}

.xzg-theme-direction-row.xzg-title-gradient-section .xzg-theme-label {
    margin-right: 10px;
}

.xzg-toggle-switch {
    position: relative;
    width: 40px;
    height: 22px;
    border: none;
    border-radius: 11px;
    background: #555;
    cursor: pointer;
    padding: 0;
    transition: background 0.2s;
    flex-shrink: 0;
}

.xzg-toggle-switch[data-checked="true"] {
    background: #4CAF50;
}

.xzg-toggle-switch .xzg-toggle-slider {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    background: #fff;
    border-radius: 50%;
    transition: left 0.2s;
    pointer-events: none;
}

.xzg-toggle-switch[data-checked="true"] .xzg-toggle-slider {
    left: 20px;
}

.xzg-toggle-switch .xzg-toggle-label {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-size: 11px;
    color: #fff;
    pointer-events: none;
    font-weight: bold;
    user-select: none;
}

.xzg-toggle-switch[data-checked="false"] .xzg-toggle-label {
    right: 8px;
}

.xzg-toggle-switch[data-checked="true"] .xzg-toggle-label {
    left: 8px;
}

.xzg-dialog-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
}

.xzg-dialog {
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 8px;
    min-width: 280px;
    max-width: 90vw;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif;
    color: #ddd;
}

.xzg-dialog-title {
    padding: 12px 16px;
    font-size: 14px;
    font-weight: bold;
    border-bottom: 1px solid #444;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #fff;
    border-radius: 8px 8px 0 0;
}

.xzg-dialog-body {
    padding: 16px;
    font-size: 13px;
}

.xzg-dialog-footer {
    padding: 12px 16px;
    border-top: 1px solid #444;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

.xzg-btn {
    padding: 6px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
}

.xzg-btn-cancel {
    background: #444;
    color: #ddd;
}

.xzg-btn-cancel:hover {
    background: #555;
}

.xzg-presets-section {
    margin-top: 0;
    margin-bottom: 6px;
}

.xzg-presets-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
}

.xzg-presets-row {
    display: flex;
    gap: 4px;
    flex: 1;
    max-width: 180px;
}

.xzg-preset-item {
    flex: 1;
    height: 20px;
    border-radius: 3px;
    cursor: pointer;
    border: 1.5px solid #444;
    transition: all 0.2s;
    position: relative;
    overflow: hidden;
}

            .xzg-preset-item:hover {
                background: rgba(255, 255, 255, 0.1);
            }

.xzg-preset-item:active {
    transform: translateY(0);
}

.xzg-presets-tip {
    text-align: center;
    color: #ffffff;
    font-size: 10px;
    margin-top: 5px;
    margin-bottom: 0;
}

.xzg-link-highlight-section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    margin-top: 0;
    margin-bottom: 6px;
}

#xzg-node-highlight-options .xzg-swatch-label {
    display: inline-block;
    width: 60px;
    min-width: 60px;
    flex-shrink: 0;
    white-space: nowrap;
    text-align: left;
}
#xzg-node-highlight-color-text:focus {
    border-color: #555 !important;
    outline: none !important;
    box-shadow: none !important;
}

.xzg-anim-type-btn {
    width: 26px;
    height: 22px;
    border: 1px solid #444;
    border-radius: 3px;
    background: #2a2a2a;
    color: #777;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
}
.xzg-anim-type-btn:hover {
    background: #3a3a3a;
    color: #ccc;
    border-color: #666;
}
.xzg-anim-type-btn.active {
    background: #1a3a2a;
    border-color: #4caf50;
    color: #4caf50;
}

.xzg-wallpaper-section {
    margin-top: 0;
    margin-bottom: 6px;
}

.xzg-wallpaper-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
}

.xzg-wallpaper-controls {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 6px;
    border-top: 1px solid #444;
}

.xzg-wallpaper-upload-row {
    display: flex;
    gap: 6px;
}

.xzg-wallpaper-btn {
    flex: 1;
    height: 28px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #333;
    color: #ddd;
    cursor: pointer;
    font-size: 12px;
    padding: 0 10px;
    transition: all 0.15s;
}
.xzg-wallpaper-btn:hover {
    background: #444;
    border-color: #666;
}
.xzg-wallpaper-clear {
    flex: none;
    width: 60px;
    background: #3a1a1a;
    border-color: #773333;
    color: #e07070;
}
            .xzg-wallpaper-clear:hover {
                background: rgba(255, 255, 255, 0.1);
            }

.xzg-wallpaper-row {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 28px;
}

.xzg-wallpaper-row .xzg-swatch-label {
    min-width: 60px;
    flex-shrink: 0;
}

.xzg-wallpaper-value {
    font-size: 11px;
    color: #aaa;
    min-width: 48px;
    text-align: right;
    flex-shrink: 0;
}

.xzg-wallpaper-fit-btns {
    display: flex;
    gap: 4px;
    flex: 1;
}

.xzg-wallpaper-fit-btn {
    flex: 1;
    height: 24px;
    border: 1px solid #444;
    border-radius: 3px;
    background: #2a2a2a;
    color: #888;
    cursor: pointer;
    font-size: 11px;
    padding: 0;
    transition: all 0.15s;
}
.xzg-wallpaper-fit-btn:hover {
    background: #3a3a3a;
    color: #ccc;
    border-color: #666;
}
.xzg-wallpaper-fit-btn.active {
    background: #1a2a3a;
    border-color: #4a90e2;
    color: #6ab0ff;
}

#xzg-wallpaper-opacity {
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    background: #444;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
}
#xzg-wallpaper-opacity::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    background: #6ab0ff;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}
#xzg-wallpaper-opacity::-moz-range-thumb {
    width: 14px;
    height: 14px;
    background: #6ab0ff;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}

.xzg-menu-hide-full {
    flex: 1;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    box-sizing: border-box;
}

.xzg-menu-hide-tabs {
    display: flex;
    gap: 2px;
    background: #1e1e1e;
    padding: 3px;
    border-radius: 4px;
}

.xzg-menu-tab {
    flex: 1;
    padding: 5px 0;
    background: none;
    border: none;
    color: #888;
    font-size: 12px;
    cursor: pointer;
    border-radius: 3px;
    transition: all 0.15s;
}

.xzg-menu-tab:hover {
    color: #ccc;
    background: rgba(255, 255, 255, 0.05);
}

.xzg-menu-tab.active {
    background: #3a3a3a;
    color: #FFD700;
    font-weight: bold;
}

.xzg-menu-search-box {
    position: relative;
    width: 100%;
    box-sizing: border-box;
}

#xzg-menu-search-input {
    width: 100%;
    height: 28px;
    padding: 0 28px 0 10px;
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #ddd;
    font-size: 12px;
    box-sizing: border-box;
    outline: none;
    transition: border-color 0.15s;
    display: block;
}

#xzg-menu-search-input:focus {
    border-color: #FFD700;
    box-shadow: 0 0 4px rgba(255, 215, 0, 0.3);
}

.xzg-menu-search-clear {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    background: transparent;
    border: none;
    color: #888;
    cursor: pointer;
    font-size: 12px;
    padding: 2px 6px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
}

.xzg-menu-search-clear:hover {
    background: #444;
    color: #fff;
}

.xzg-menu-hide-toolbar {
    display: flex;
    gap: 4px;
}

.xzg-menu-tool-btn {
    flex: 1;
    height: 26px;
    border: 1px solid #444;
    border-radius: 3px;
    background: #333;
    color: #bbb;
    cursor: pointer;
    font-size: 11px;
    padding: 0 6px;
    transition: all 0.15s;
}

.xzg-menu-tool-btn:hover {
    background: #444;
    border-color: #666;
    color: #fff;
}

.xzg-menu-hide-list {
    flex: 1;
    overflow-y: auto;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    background: #1a1a1a;
    padding: 4px;
    min-height: 0;
}

/* 快速连线管理列表：固定最大高度，超长列表在列表内滚动（面板整体不滚动） */
#xzg-quick-nodes-list {
    max-height: 260px;
}

.xzg-menu-hide-list::-webkit-scrollbar {
    width: 6px;
}

.xzg-menu-hide-list::-webkit-scrollbar-track {
    background: #1a1a1a;
}

.xzg-menu-hide-list::-webkit-scrollbar-thumb {
    background: #444;
    border-radius: 3px;
}

.xzg-menu-tab.xzg-menu-tab-help {
    flex: 0 0 auto;
    margin-left: auto;
    padding: 5px 10px;
}
.xzg-menu-hide-help {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 10px 12px;
    color: #ccc;
    font-size: 12px;
    line-height: 1.8;
    min-height: 0;
}
.xzg-menu-help-title {
    color: #FFD700;
    font-weight: bold;
    margin-bottom: 8px;
    font-size: 12px;
}
.xzg-menu-help-block {
    margin-bottom: 10px;
}
.xzg-menu-help-step {
    margin-bottom: 6px;
}
.xzg-menu-help-step b {
    color: #FFD700;
}

.xzg-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 3px;
    transition: background 0.1s;
    font-size: 12px;
    color: #ccc;
    width: 100%;
    box-sizing: border-box;
}

.xzg-menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
}

.xzg-menu-item input[type="checkbox"] {
    width: 14px;
    height: 14px;
    cursor: pointer;
    flex-shrink: 0;
    accent-color: #FFD700;
}

.xzg-menu-item span {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.xzg-menu-empty-tip {
    text-align: center;
    color: #666;
    font-size: 12px;
    padding: 30px 10px;
    line-height: 1.6;
}

.xzg-menu-reset-btn {
    width: 100%;
    height: 28px;
    border: 1px solid #773333;
    border-radius: 4px;
    background: #3a1a1a;
    color: #e07070;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.15s;
}

.xzg-menu-reset-btn:hover {
    background: #4a1a1a;
    border-color: #aa4444;
    color: #ff8080;
}

.xzg-quick-nodes-count {
    font-size: 12px;
    color: #888;
    margin-bottom: 8px;
}

.xzg-quick-nodes-count span {
    color: #FFD700;
    font-weight: bold;
}

.xzg-quick-node-manage-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-bottom: 1px solid #333;
    cursor: move;
    transition: background 0.15s;
    font-size: 12px;
}

.xzg-quick-node-manage-item:last-child {
    border-bottom: none;
}

.xzg-quick-node-manage-item:hover {
    background: rgba(255, 255, 255, 0.06);
}

.xzg-quick-node-manage-item.dragging {
    opacity: 0.5;
    background: #333;
}

.xzg-quick-node-manage-item.drag-over {
    border-top: 2px solid #FFD700;
}

.xzg-quick-drag-handle {
    color: #666;
    font-size: 12px;
    cursor: move;
    flex-shrink: 0;
    line-height: 1;
    user-select: none;
}

.xzg-quick-node-info {
    flex: 1;
    overflow: hidden;
    min-width: 0;
}

.xzg-quick-node-name {
    font-size: 12px;
    color: #ddd;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.3;
}

.xzg-quick-node-type {
    font-size: 10px;
    color: #888;
    margin-top: 1px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.xzg-quick-node-remove-btn {
    background: none;
    border: 1px solid #773333;
    color: #e07070;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    flex-shrink: 0;
    transition: all 0.15s;
}

            .xzg-quick-node-remove-btn:hover {
                background: rgba(255, 255, 255, 0.1);
            }

.xzg-quick-setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0;
    margin-bottom: 6px;
    font-size: 12px;
    color: #ddd;
}

            /* 下拉框：细边框（浅灰不显黑），选中/聚焦时稍亮提示，保留原生下拉箭头 */
            .xzg-theme-panel select,
            #node-favorites-panel select,
            .xzg-wf-dialog-overlay select {
                outline: none !important;
                box-shadow: none !important;
                border: 1px solid rgba(255, 255, 255, 0.18) !important;
            }
            .xzg-theme-panel select:focus,
            .xzg-theme-panel select:active,
            .xzg-theme-panel input:focus,
            .xzg-theme-panel input:active,
            #node-favorites-panel select:focus,
            #node-favorites-panel select:active,
            .xzg-wf-dialog-overlay select:focus,
            .xzg-wf-dialog-overlay select:active {
                outline: none !important;
                box-shadow: none !important;
                border-color: rgba(255, 255, 255, 0.35) !important;
            }
            .xzg-theme-panel select option,
            #node-favorites-panel select option,
            .xzg-wf-dialog-overlay select option {
                background: #2a2a2a;
                color: #ddd;
            }
        `;
        
        this.panelStyleElement = document.createElement("style");
        this.panelStyleElement.id = "xzg-theme-panel-style";
        this.panelStyleElement.textContent = css;
        document.head.appendChild(this.panelStyleElement);
    },

    _serializeHooksInstalled: false,

    hookSerialize(retryCount = 0) {
        // 如果已安装则跳过
        if (this._serializeHooksInstalled) return;

        const self = this;
        
        function hookProto(proto, name, makeWrapper) {
            const orig = proto[name];
            if (orig && orig._xzgThemeSerializeHook) return;
            const wrapped = makeWrapper(orig);
            wrapped._xzgWrapped = true;
            wrapped._xzgThemeSerializeHook = true;
            self.protoRefs[name] = orig;
            proto[name] = wrapped;
        }

        if (window.LiteGraph && LiteGraph.LGraphNode && LiteGraph.LGraphNode.prototype) {
            // 新前端保存图状态直接调用 serializeFromStoreState，绕过 serialize。
            for (const method of ['serialize', 'serializeFromStoreState']) {
                if (typeof LiteGraph.LGraphNode.prototype[method] !== 'function') continue;
                hookProto(LiteGraph.LGraphNode.prototype, method, (orig) => function(...args) {
                    const data = orig.apply(this, args);
                    if (this._xzgGradient) {
                        data._xzgGradient = JSON.parse(JSON.stringify(this._xzgGradient));
                        data.properties = { ...data.properties,
                            _xzgGradient: JSON.parse(JSON.stringify(this._xzgGradient)) };
                    } else {
                        // 前端会从扩展缓存重新合入旧字段，重置后也必须清理序列化结果。
                        delete data._xzgGradient;
                        if (data.properties) delete data.properties._xzgGradient;
                    }
                    if (data.extensions && Object.hasOwn(data.extensions, '_xzgGradient')) {
                        data.extensions = { ...data.extensions };
                        delete data.extensions._xzgGradient;
                        if (!Object.keys(data.extensions).length) delete data.extensions;
                    }
                    return data;
                });
            }

            hookProto(LiteGraph.LGraphNode.prototype, 'configure', (orig) => function(data) {
                if (orig) orig.call(this, data);
                const gradient = data?.properties?._xzgGradient || data?._xzgGradient;
                if (gradient) {
                    this._xzgGradient = JSON.parse(JSON.stringify(gradient));
                    this.properties ||= {};
                    this.properties._xzgGradient = JSON.parse(JSON.stringify(gradient));
                } else {
                    delete this._xzgGradient;
                    if (this.properties) delete this.properties._xzgGradient;
                }
            });

            hookProto(LiteGraph.LGraphNode.prototype, 'onAdded', (orig) => function(graph) {
                if (orig) orig.call(this, graph);
                if (this._xzgGradient) {
                    setTimeout(() => {
                        XZGThemeManager.applyGradientToDOMNode(this);
                    }, 50);
                }
            });

            this._serializeHooksInstalled = true;
            console.log('[小珠光主题] 序列化 Hook 已安装 ✓');
        } else if (retryCount < 60) {
            // LiteGraph 尚未就绪，延迟重试（最多60次=6秒）
            setTimeout(() => self.hookSerialize(retryCount + 1), 100);
        } else {
            console.warn('[小珠光主题] 序列化 Hook 安装失败：LiteGraph 超时未就绪');
        }
    },

    ensureCanvasHook() {
        if (this.canvasHooked) return;
        if (!window.app || !app.canvas) {
            setTimeout(() => this.ensureCanvasHook(), 100);
            return;
        }
        // 三个子钩子独立容错：任一失败不影响其余钩子，canvasHooked 必达，
        // 后续 750ms 监视器才会被创建去持续维护各钩子。
        try { this.ensureLegacyGradientHook(); } catch (e) { console.warn('[小珠光主题] ensureLegacyGradientHook 失败:', e); }
        try { this.setupLinkHighlight(); } catch (e) { console.warn('[小珠光主题] setupLinkHighlight 失败:', e); }
        try { this.hookTitleEditDialog(); } catch (e) { console.warn('[小珠光主题] hookTitleEditDialog 失败:', e); }
        this.canvasHooked = true;

        // Nodes 1 扩展会在启动后继续加载，并可能再次替换背景绘制函数。
        // 只在 Nodes 1 检查原生画布钩子；Nodes 2 使用 DOM 渐变管线。
        if (!this._legacyGradientHookMonitor) {
            this._legacyGradientHookMonitor = setInterval(() => {
                try {
                    this.ensureLegacyGradientHook();
                    const pathRenderer = window.app?.canvas?.linkRenderer?.pathRenderer;
                    const linkDraw = pathRenderer?.drawLink;
                    if (linkDraw && !linkDraw._xzgLinkHighlightWrapped) this.setupLinkHighlight();
                } catch (e) { console.warn('[小珠光主题] 连线钩子维护失败:', e); }
                try { this._ensureNodeHighlightEvents(); } catch (e) { console.warn('[小珠光主题] 执行事件钩子维护失败:', e); }
                try {
                    const drawNode = (globalThis.LGraphCanvas || globalThis.LiteGraph?.LGraphCanvas)?.prototype?.drawNode;
                    // 共存判定：顶层已被 compose_tool 的 ShadowGuard 包装且我们已成功装过
                    // 一次时，我们的包装在其下正常工作，不再重装（防互刷死循环）。
                    if (drawNode && !drawNode._xzgNodeHighlightWrapped
                        && !(this._nodeHighlightHookedOnce && drawNode.__xzgShadowGuard)) {
                        this.nodeHighlightHooked = false;
                        this._ensureNodeHighlightHook();
                    }
                } catch (e) { console.warn('[小珠光主题] 高亮钩子维护失败:', e); }
            }, 750);
        }
        if (!this._linkHighlightLifecycleHooked) {
            this._linkHighlightLifecycleHooked = true;
            const refreshLinks = () => {
                if (!this.linkHighlightActive && !this.linkAnimActive && !this.linkLaserActive && !this.linkColorActive) return;
                this.setupLinkHighlight();
                this.refreshLinkHighlightCanvas();
            };
            window.addEventListener('focus', refreshLinks);
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) refreshLinks();
            });
        }
        app.ui?.settings?.addEventListener?.('Comfy.VueNodes.Enabled.change', () => {
            requestAnimationFrame(() => {
                if (globalThis.LiteGraph?.vueNodesMode) this.refreshDOMGradients();
                else this.ensureLegacyGradientHook();
                this.setupLinkHighlight();
                this.refreshLinkHighlightCanvas();
                this.refreshRunningNodeHighlight();
            });
        });
    },

    refreshLinkHighlightCanvas() {
        const canvas = window.app?.canvas;
        const graph = window.app?.graph;
        if (canvas?.setDirty) canvas.setDirty(true, true);
        graph?.setDirtyCanvas?.(true, true);
    },

    ensureLegacyGradientHook() {
        if (globalThis.LiteGraph?.vueNodesMode || !window.app?.canvas) return;
        const drawShape = window.app.canvas.drawNodeShape;
        if (typeof drawShape === 'function' && !drawShape._xzgThemeGradientHook) {
            this.hookDrawNodeShape(window.app.canvas);
        }
    },

    /* ── 标题编辑框对齐修复 ── */
    /* 小珠光自定义绘制标题（fontSize/字体/对齐/textBaseline）， */
    /* 而 LiteGraph 原生 graphdialog 基于原生参数定位，导致对齐差异。 */
    /* 参考小珠光Noto节点的方案：不修改 graphdialog，而是隐藏它， */
    /* 创建独立的 input 元素，用 position:fixed 精确对齐到 canvas 标题位置。 */
    hookTitleEditDialog() {
        if (this._titleEditObserver) return;
        const self = this;

        const adjust = (dialog) => {
            // 判断是否是标题编辑
            const nameSpan = dialog.querySelector('.name');
            const isTitle = !nameSpan || nameSpan.textContent === 'title' || nameSpan.textContent === 'Title';
            if (!isTitle) return;

            // 防止重复创建：已有编辑中的 input
            if (document.querySelector('[data-xzg-title-edit]')) return;

            // 获取当前节点
            const canvas = window.app?.canvas;
            if (!canvas) return;
            let node = canvas.current_node || canvas.node_over;
            if (!node) {
                const sel = canvas.selected_nodes;
                if (sel) {
                    const ids = Object.keys(sel);
                    if (ids.length === 1) node = sel[ids[0]];
                }
            }
            if (!node || !node._xzgGradient) return;

            const cfg = node._xzgGradient;
            const fontFamily = '"Microsoft YaHei","微软雅黑","PingFang SC","Hiragino Sans GB","SimHei",Arial,sans-serif';
            const align = cfg.textAlign || 'left';
            const LG = typeof LiteGraph !== 'undefined' ? LiteGraph : null;
            const th = LG?.NODE_TITLE_HEIGHT || 30;
            const nodeW = node.size?.[0] || 200;

            // 隐藏 graphdialog（参考Noto节点：不使用ComfyUI原生dialog，创建独立元素）
            dialog.style.setProperty('display', 'none', 'important');

            // 获取原始input的值，用于后续同步
            const origInput = dialog.querySelector('input');
            const origVal = origInput ? origInput.value : (node.getTitle ? node.getTitle() : (node.title || ''));

            // ── 参考小珠光Noto节点：创建独立 input 元素 ──
            const customInput = document.createElement('input');
            customInput.type = 'text';
            customInput.value = origVal;
            customInput.spellcheck = false;
            customInput.autocomplete = 'off';
            customInput.dataset.xzgTitleEdit = String(node.id || '');

            const inputTextAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';

            // 初始位置计算
            const calcPos = () => {
                const c = window.app?.canvas;
                if (!c || !c.ds || !node.pos) return null;
                const s = c.ds.scale || 1;
                const ox = c.ds.offset?.[0] || 0;
                const oy = c.ds.offset?.[1] || 0;
                const ce = c.canvas;
                if (!ce) return null;
                const r = ce.getBoundingClientRect();
                const left = r.left + (node.pos[0] + 10 + ox) * s;
                const top = r.top + (node.pos[1] - th / 2 + oy) * s;
                const fs = (cfg.fontSize || 14) * s;
                const inpHeight = fs + 6;
                let w;
                if (align === 'center' || align === 'right') {
                    w = Math.ceil((nodeW - 20) * s);
                } else {
                    const tt = node.getTitle ? node.getTitle() : (node.title || '');
                    const mc = document.createElement('canvas').getContext('2d');
                    mc.font = (cfg.fontSize || 14) * s + 'px ' + fontFamily;
                    w = Math.max(60, Math.ceil(mc.measureText(tt).width + 8));
                }
                return { left, top, fs, inpHeight, w };
            };

            // 设置 input 样式（参考Noto节点：无padding/border，透明背景，box-sizing:border-box）
            const applyStyle = (pos) => {
                if (!pos) return;
                customInput.style.cssText = [
                    'position:fixed !important',
                    'left:' + pos.left + 'px !important',
                    'top:' + (pos.top - pos.inpHeight / 2) + 'px !important',
                    'width:' + pos.w + 'px !important',
                    'height:' + pos.inpHeight + 'px !important',
                    'min-width:0 !important',
                    'max-width:none !important',
                    'padding:0 !important',
                    'margin:0 !important',
                    'border:none !important',
                    'outline:none !important',
                    'background:transparent !important',
                    'box-sizing:border-box !important',
                    'box-shadow:none !important',
                    'font:' + pos.fs + 'px ' + fontFamily + ' !important',
                    'color:' + (cfg.titleText || '#ffffff') + ' !important',
                    'caret-color:' + (cfg.titleText || '#ffffff') + ' !important',
                    'line-height:' + pos.inpHeight + 'px !important',
                    'text-align:' + inputTextAlign + ' !important',
                    'z-index:100001 !important',
                    'pointer-events:auto !important'
                ].join(';');
            };

            // 初始定位
            const initPos = calcPos();
            if (!initPos) return;
            applyStyle(initPos);
            document.body.appendChild(customInput);
            customInput.focus();
            customInput.select();

            // 参考Noto节点：setInterval 连续更新位置
            const posInterval = setInterval(() => {
                const p = calcPos();
                if (p && customInput.isConnected) {
                    customInput.style.left = p.left + 'px';
                    customInput.style.top = (p.top - p.inpHeight / 2) + 'px';
                    customInput.style.width = p.w + 'px';
                    customInput.style.height = p.inpHeight + 'px';
                    customInput.style.lineHeight = p.inpHeight + 'px';
                    customInput.style.font = p.fs + 'px ' + fontFamily;
                }
            }, 16);

            // 清理函数
            const cleanup = () => {
                clearInterval(posInterval);
                if (customInput.isConnected) customInput.remove();
                // 移除 graphdialog 触发 ComfyUI 的后续处理
                if (dialog.isConnected) dialog.remove();
                if (removalObserver) removalObserver.disconnect();
            };
            let removalObserver = null;

            // 保存标题（参考Noto节点：直接设置 node.title）
            const saveTitle = () => {
                const newTitle = customInput.value;
                const oldTitle = node.getTitle ? node.getTitle() : (node.title || '');
                if (newTitle !== oldTitle) {
                    node.title = newTitle;
                    // 同步到 graphdialog 的 input，让 ComfyUI 也能感知变化
                    if (origInput) origInput.value = newTitle;
                }
                cleanup();
                if (window.app?.canvas) window.app.canvas.setDirty(true);
            };

            // 取消编辑
            const cancelEdit = () => {
                cleanup();
                if (window.app?.canvas) window.app.canvas.setDirty(true);
            };

            // Enter → 保存
            customInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    saveTitle();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelEdit();
                }
            });

            // blur → 保存（点击别处）
            customInput.addEventListener('blur', () => {
                // 延迟一下，让点击事件先处理
                setTimeout(() => {
                    if (customInput.isConnected) {
                        saveTitle();
                    }
                }, 100);
            }, { once: false });

            // 阻止鼠标事件冒泡，防止触发 canvas
            customInput.addEventListener('mousedown', (e) => e.stopPropagation());
            customInput.addEventListener('mouseup', (e) => e.stopPropagation());

            // 监听 dialog 移除，自动清理
            removalObserver = new MutationObserver(() => {
                if (!dialog.isConnected && customInput.isConnected) {
                    clearInterval(posInterval);
                    customInput.remove();
                    removalObserver.disconnect();
                }
            });
            removalObserver.observe(document.body, { childList: true, subtree: true });
        };

        this._titleEditObserver = new MutationObserver((mutations) => {
            for (const mut of mutations) {
                for (const node of mut.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.classList && node.classList.contains('graphdialog')) {
                        adjust(node);
                    } else if (node.querySelectorAll) {
                        const dlg = node.querySelector('.graphdialog');
                        if (dlg) adjust(dlg);
                    }
                }
            }
        });
        this._titleEditObserver.observe(document.body, { childList: true, subtree: true });
    },

    setupLinkHighlight() {
        if (!window.app || !app.canvas) {
            setTimeout(() => this.setupLinkHighlight(), 100);
            return;
        }

        const canvas = app.canvas;
        const self = this;

        // 新版 ComfyUI 前端使用 CanvasPathRenderer.drawLink 逐条绘制连线
        // 通过 canvas.linkRenderer.pathRenderer 访问该实例
        if (!canvas.linkRenderer || !canvas.linkRenderer.pathRenderer) {
            setTimeout(() => this.setupLinkHighlight(), 100);
            return;
        }

        // 钩住实际解析到 drawLink 的最近一层；新版渲染器可能把方法放在实例自身。
        const renderer = canvas.linkRenderer.pathRenderer;
        let owner = Object.prototype.hasOwnProperty.call(renderer, 'drawLink') ? renderer : null;
        let proto = Object.getPrototypeOf(renderer);
        while (!owner && proto && proto !== Object.prototype) {
            if (Object.prototype.hasOwnProperty.call(proto, 'drawLink') && typeof proto.drawLink === 'function') {
                owner = proto;
                break;
            }
            proto = Object.getPrototypeOf(proto);
        }
        if (!owner || typeof owner.drawLink !== 'function') {
            setTimeout(() => this.setupLinkHighlight(), 100);
            return;
        }
        if (owner.drawLink._xzgLinkHighlightWrapped) {
            this._linkHighlightHookProto = owner;
            this.linkHighlightHooked = true;
            // 状态可能在画布首次绘制之后恢复；钩子已存在时也需要主动重绘一次。
            requestAnimationFrame(() => window.app?.canvas?.setDirty?.(true, true));
            return;
        }

        const origDrawLink = owner.drawLink;
        owner.drawLink = function(ctx, link, renderCtx) {
            const hasFeature = self.linkHighlightActive || self.linkLaserActive || self.linkColorActive || self.linkAnimActive;
            if (!hasFeature) {
                return origDrawLink.call(this, ctx, link, renderCtx);
            }

            const nodeIds = self.getHighlightNodeIds();
            const hasSelectedNodes = nodeIds.length > 0;

            // 查找原始 LLink 的 origin_id/target_id
            // 子图视图的 app.canvas.graph 指向当前子图；app.graph 在部分前端仍是根图。
            // 端点 ID 必须从绘制所在的图查询，否则子图节点 ID 会与根图表错配。
            const graph = window.app?.canvas?.graph || window.app?.canvas?.graphCanvas?.graph || window.app?.graph;
            // 不同 ComfyUI/LiteGraph 前端对图连线表的命名不同：
            // 旧版常用 _links，新版/部分托管前端使用 links。绘制器传入的 link
            // 可能只有 id，因此需要从原始图连线表回查端点节点 ID。
            const linksMap = graph?._links || graph?.links;
            let originId = null, targetId = null, linkId = null;

            if (link.origin_id != null) {
                originId = link.origin_id;
                targetId = link.target_id;
                linkId = link.id;
            } else if (linksMap && link.id != null) {
                const origLink = typeof linksMap.get === 'function'
                    ? (linksMap.get(Number(link.id)) || linksMap.get(link.id) || linksMap.get(String(link.id)))
                    : (linksMap[link.id] || linksMap[Number(link.id)] || linksMap[String(link.id)]);
                if (origLink) {
                    originId = origLink.origin_id;
                    targetId = origLink.target_id;
                    linkId = origLink.id;
                }
            }

            // 判断连线是否与选中节点相连
            let isConnected = false;
            if (self.linkHighlightActive && hasSelectedNodes) {
                const idSet = new Set(nodeIds.map(String));
                isConnected = idSet.has(String(originId)) || idSet.has(String(targetId));
            }

            // 连线高亮：选中节点的连线高亮，其他变暗；未选中节点时所有连线变暗变细
            if (self.linkHighlightActive && hasSelectedNodes) {
                const hasHighlightAnim = self.linkHighlightAnimType && self.linkHighlightAnimType !== 'none';
                if (isConnected) {
                    if (hasHighlightAnim) {
                        // 开启高亮动画时：连线本体变暗变细（与非选中连线一致），动画叠加上去
                        const origAlpha = ctx.globalAlpha;
                        ctx.globalAlpha = origAlpha * self.linkHighlightDimAlpha;
                        self._drawThinBaseLine(ctx, link);
                        ctx.globalAlpha = origAlpha;
                        self._drawLinkAnim(ctx, link, self.linkHighlightAnimType);
                        self._ensureAnimLoop();
                    } else {
                        self._drawHighlightGreenLine(ctx, link);
                    }
                } else {
                    const origAlpha = ctx.globalAlpha;
                    ctx.globalAlpha = origAlpha * self.linkHighlightDimAlpha;
                    self._drawThinBaseLine(ctx, link);
                    ctx.globalAlpha = origAlpha;
                }
            } else if (self.linkHighlightActive && !hasSelectedNodes) {
                // 未选中节点时：所有连线变暗变细
                const origAlpha = ctx.globalAlpha;
                ctx.globalAlpha = origAlpha * self.linkHighlightDimAlpha;
                self._drawThinBaseLine(ctx, link);
                ctx.globalAlpha = origAlpha;
            } else if (self.linkAnimActive) {
                // 连线动画开启时，所有连线变细变暗，作为星芒的底
                const origAlpha = ctx.globalAlpha;
                ctx.globalAlpha = origAlpha * 0.5;
                self._drawThinBaseLine(ctx, link);
                ctx.globalAlpha = origAlpha;
            } else {
                origDrawLink.call(this, ctx, link, renderCtx);
            }

            // 连线动画：根据类型作用于所有连线
            if (self.linkAnimActive) {
                self._drawLinkAnim(ctx, link);
                self._ensureAnimLoop();
            }

            // 激光动画
            if (self.linkLaserActive) {
                self._drawLaserOverlay(ctx, link, originId, targetId);
                self._ensureAnimLoop();
            }
        };
        owner.drawLink._xzgLinkHighlightWrapped = true;

        this._linkHighlightHookProto = owner;
        this.linkHighlightHooked = true;
        console.log('[小珠光主题] 连线高亮 Hook 已安装 ✓');
        // 确保初次恢复设置或工作流加载后，效果无需用户切换开关才出现。
        requestAnimationFrame(() => window.app?.canvas?.setDirty?.(true, true));
    },

    getHighlightNodeIds() {
        if (!window.app || !app.canvas) return [];
        const canvas = app.canvas;
        const fromEntries = (entries) => entries.map(([id, item]) => {
            if (item?.node || item?.item) return item.node || item.item;
            if (item && typeof item === 'object') return item;
            // 某些 LiteGraph 版本以 { nodeId: true } 保存选择状态。
            return typeof item === 'boolean' || item == null ? id : item;
        });
        const selected = canvas.selectedItems instanceof Map
            ? fromEntries([...canvas.selectedItems.entries()])
            : canvas.selectedItems instanceof Set || Array.isArray(canvas.selectedItems)
                ? [...canvas.selectedItems]
                : canvas.selected_nodes instanceof Map
                ? fromEntries([...canvas.selected_nodes.entries()])
                : canvas.selected_nodes instanceof Set
                    ? [...canvas.selected_nodes]
                    : fromEntries(Object.entries(canvas.selected_nodes || {}));
        return selected.map(item => item?.node || item?.item || item).map(node => node?.id ?? node)
            .filter(id => id !== null && id !== undefined);
    },

    _saturateColor(color, saturateIncrease) {
        if (!color) return color;
        let r, g, b;
        if (typeof color === 'string') {
            const c = color.replace('#', '');
            if (c.length === 3) {
                r = parseInt(c[0] + c[0], 16);
                g = parseInt(c[1] + c[1], 16);
                b = parseInt(c[2] + c[2], 16);
            } else if (c.length >= 6) {
                r = parseInt(c.substring(0, 2), 16);
                g = parseInt(c.substring(2, 4), 16);
                b = parseInt(c.substring(4, 6), 16);
            } else {
                return color;
            }
        } else if (Array.isArray(color)) {
            r = color[0]; g = color[1]; b = color[2];
        } else {
            return color;
        }

        const rn = r / 255, gn = g / 255, bn = b / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        let h, s, l = (max + min) / 2;

        if (max === min) {
            h = s = 0;
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
                case gn: h = (bn - rn) / d + 2; break;
                case bn: h = (rn - gn) / d + 4; break;
            }
            h /= 6;
        }

        s = Math.min(1, s + saturateIncrease);

        let r2, g2, b2;
        if (s === 0) {
            r2 = g2 = b2 = l;
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r2 = hue2rgb(p, q, h + 1/3);
            g2 = hue2rgb(p, q, h);
            b2 = hue2rgb(p, q, h - 1/3);
        }

        return `rgb(${Math.round(r2 * 255)}, ${Math.round(g2 * 255)}, ${Math.round(b2 * 255)})`;
    },

    toggleLinkHighlight() {
        const newState = !this.linkHighlightActive;
        this.linkHighlightActive = newState;
        this.setupLinkHighlight();
        try {
            localStorage.setItem('xzg-link-highlight', this.linkHighlightActive ? 'true' : 'false');
        } catch(e) {}
        // 互斥：开启连线高亮时关闭连线动画
        if (newState && this.linkAnimActive) {
            this.linkAnimActive = false;
            try { localStorage.setItem('xzg-link-anim', 'false'); } catch(e) {}
        }
        if (!this.linkHighlightActive) {
            this._stopHighlightAnimLoop();
        }
        const hasHighlightAnim = this.linkHighlightActive && this.linkHighlightAnimType && this.linkHighlightAnimType !== 'none';
        if (!hasHighlightAnim && !this.linkLaserActive && !this.linkColorActive && !this.linkAnimActive) {
            this._stopAnimLoop();
        }
        if (window.app) {
            if (app.canvas?.setDirty) {
                app.canvas.setDirty(true, true);
            } else if (app.graph?.setDirtyCanvas) {
                app.graph.setDirtyCanvas(true, true);
            }
        }
        this._queueThemeCloudSave();
        return this.linkHighlightActive;
    },

    toggleNodeHighlight() {
        this.nodeHighlightActive = !this.nodeHighlightActive;
        try {
            localStorage.setItem('xzg-node-highlight', this.nodeHighlightActive ? 'true' : 'false');
        } catch(e) {}
        this.refreshRunningNodeHighlight();
        this._queueThemeCloudSave();
        return this.nodeHighlightActive;
    },

    refreshRunningNodeHighlight() {
        const clearDOM = () => {
            for (const element of this._runningNodeDOMElements || []) {
                element.classList?.remove('xzg-node-executing-highlight');
                element.style?.removeProperty('--xzg-node-exec-color');
            }
            this._runningNodeDOMElements = new Set();
            this._runningNodeDOMKey = null;
            this._runningNodeDOMGraph = null;
        };

        const vueNodesFlag = globalThis.LiteGraph?.vueNodesMode;
        const isVueNodesMode = typeof vueNodesFlag === 'boolean'
            ? vueNodesFlag
            : !!document.querySelector('.lg-node[data-node-id], .comfy-node[data-node-id]');
        if (!isVueNodesMode) {
            clearDOM();
            this.refreshLinkHighlightCanvas();
            return;
        }
        if (!this.nodeHighlightActive) {
            clearDOM();
            return;
        }

        const job = this._runningJob;
        const appGraph = window.app?.graph;
        const canvasGraph = window.app?.canvas?.graph || window.app?.canvas?.graphCanvas?.graph;
        // 根工作流执行时优先使用发起执行的 app.graph 实例，避免 Nodes 2
        // 暴露的画布代理图与节点的 graph 引用不同，导致 ID 匹配被跳过。
        const graph = job?.ownerGraph && appGraph === job.ownerGraph
            ? appGraph
            : canvasGraph || appGraph;
        const runningId = window.app?.runningNodeId || job?.nodeId;
        if (!graph || runningId == null) {
            clearDOM();
            return;
        }

        const path = String(runningId).split(':').filter(Boolean);
        if (!path.length) {
            clearDOM();
            return;
        }

        let targetId = null;
        if (!job?.ownerGraph || graph === job.ownerGraph) {
            // 根图视图高亮子图容器；普通节点路径只有一个 ID。
            targetId = path[0];
        } else {
            // 子图视图只高亮执行路径中属于当前子图的末端节点。
            let currentGraph = job.ownerGraph;
            for (let i = 0; i < path.length - 1 && currentGraph; i++) {
                const container = currentGraph.getNodeById?.(parseInt(path[i], 10));
                const isSubgraph = container && (typeof container.isSubgraphNode === 'function'
                    ? container.isSubgraphNode() : !!container.subgraph);
                currentGraph = isSubgraph ? container.subgraph : null;
            }
            if (currentGraph === graph) targetId = path[path.length - 1];
        }

        if (targetId == null) {
            clearDOM();
            return;
        }

        const color = (this.nodeHighlightColor || '#22FF22').split(',')[0].trim() || '#22FF22';
        const key = `${targetId}|${color}`;
        if (this._runningNodeDOMKey === key && this._runningNodeDOMGraph === graph &&
            this._runningNodeDOMElements.size && [...this._runningNodeDOMElements].every(el => el.isConnected)) return;

        const styleId = 'xzg-node-executing-highlight-style';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `.xzg-node-executing-highlight { outline: 3px solid var(--xzg-node-exec-color, #22FF22) !important; outline-offset: 2px !important; box-shadow: inset 0 0 0 2px var(--xzg-node-exec-color, #22FF22), 0 0 12px var(--xzg-node-exec-color, #22FF22), 0 0 26px var(--xzg-node-exec-color, #22FF22) !important; }`;
            document.head.appendChild(style);
        }

        clearDOM();
        const elements = [...document.querySelectorAll('[data-node-id]')]
            .filter(element => element.getAttribute('data-node-id') === String(targetId));
        for (const element of elements) {
            element.classList.add('xzg-node-executing-highlight');
            element.style.setProperty('--xzg-node-exec-color', color);
            this._runningNodeDOMElements.add(element);
        }
        this._runningNodeDOMKey = key;
        this._runningNodeDOMGraph = graph;
    },

    setNodeHighlightColor(color) {
        this.nodeHighlightColor = color;
        try { localStorage.setItem('xzg-node-highlight-color', color); } catch(e) {}
        this.refreshRunningNodeHighlight();
        this._queueThemeCloudSave();
    },

    setNodeHighlightSpeed(v) {
        const n = Math.round(parseFloat(v));
        if (isNaN(n) || n < 1) return;
        this.nodeHighlightSpeed = Math.min(100, n); // 流速 1-100，50=默认速度，按比例换算
        try { localStorage.setItem('xzg-node-highlight-speed', String(this.nodeHighlightSpeed)); } catch(e) {}
        this.refreshRunningNodeHighlight();
        this._queueThemeCloudSave();
    },

    setNodeHighlightColorAnim(type) {
        if (!['flow', 'energy', 'stellar', 'transfer', 'diy1', 'diy2'].includes(type)) return;
        this.nodeHighlightColorAnim = type;
        try { localStorage.setItem('xzg-node-highlight-anim', type); } catch(e) {}
        this.refreshRunningNodeHighlight();
        this._queueThemeCloudSave();
    },

    setNodeHighlightParticleSize(v) {
        const n = parseFloat(v);
        if (isNaN(n) || n < 1) return;
        this.nodeHighlightParticleSize = Math.min(100, n);
        try { localStorage.setItem('xzg-node-highlight-particle-size', String(this.nodeHighlightParticleSize)); } catch(e) {}
        this.refreshRunningNodeHighlight();
        this._queueThemeCloudSave();
    },

    setNodeHighlightParticleCount(v) {
        const n = parseFloat(v);
        if (isNaN(n) || n <= 0) return;
        this.nodeHighlightParticleCount = n;
        try { localStorage.setItem('xzg-node-highlight-particle-count', String(n)); } catch(e) {}
        this.refreshRunningNodeHighlight();
        this._queueThemeCloudSave();
    },

    _ensureNodeHighlightEvents() {
        // queuePrompt 可能晚于扩展初始化，监视器会在 app 可用后补装包装器。
        _xzgWrapQueueForRunningOwner();
        const self = this;
        const execHandler = (e) => {
            const detail = e?.detail;
            let nodeId = null;
            let promptId = null;
            if (detail == null) {
                nodeId = null;
            } else if (typeof detail === 'object') {
                for (const candidate of [detail.display_node, detail.node, detail.node_id, detail.nodeId]) {
                    if (candidate == null) continue;
                    const candidateId = typeof candidate === 'object'
                        ? (candidate.id ?? candidate.node_id ?? candidate.nodeId)
                        : candidate;
                    if (candidateId != null && candidateId !== '') {
                        nodeId = candidateId;
                        break;
                    }
                }
                promptId = detail.prompt_id ?? detail.promptId ?? null;
            } else {
                nodeId = detail;
            }

            let ownerGraph = promptId != null ? (_xzgPromptOwnerGraph.get(String(promptId)) || null) : null;
            if (ownerGraph == null) ownerGraph = _xzgRunOwnerGraph || window.app?.graph || null;
            self._runningJob = {
                ownerGraph,
                nodeId: nodeId == null ? null : String(nodeId),
            };
            self._runningNodeId = self._runningJob.nodeId;
            self.refreshRunningNodeHighlight();
            window.app?.canvas?.setDirty?.(true, true);
            window.app?.graph?.setDirtyCanvas?.(true, true);
        };
        const resetRunning = () => {
            self._runningJob = null;
            self._runningNodeId = null;
            self.refreshRunningNodeHighlight();
            // 旧版 LiteGraph 依赖 dirty 标记触发 drawNode；状态变化时主动刷新画布。
            window.app?.canvas?.setDirty?.(true, true);
            window.app?.graph?.setDirtyCanvas?.(true, true);
        };
        const startRunning = (e) => {
            const detail = e?.detail;
            const promptId = detail && typeof detail === 'object'
                ? (detail.prompt_id ?? detail.promptId)
                : null;
            _xzgRunOwnerGraph = (promptId != null ? _xzgPromptOwnerGraph.get(String(promptId)) : null)
                || window.app?.graph || _xzgRunOwnerGraph;
            resetRunning();
        };
        const bindEmitter = (emitter) => {
            if (!emitter || typeof emitter.addEventListener !== 'function' || emitter._xzgHLBound) return;
            emitter._xzgHLBound = true;
            emitter.addEventListener('executing', execHandler);
            emitter.addEventListener('execution_start', startRunning);
            emitter.addEventListener('execution_success', resetRunning);
            emitter.addEventListener('execution_error', resetRunning);
            emitter.addEventListener('execution_interrupted', resetRunning);
        };
        bindEmitter(api);
        if (window.app?.api && window.app.api !== api) bindEmitter(window.app.api);
    },

    _ensureNodeHighlightHook() {
        const drawTarget = _xzgGetDrawNodeOwner();
        if (!drawTarget || typeof drawTarget.drawNode !== 'function') {
            this.nodeHighlightHooked = false;
            return;
        }
        const topDrawNode = drawTarget.drawNode;
        if (topDrawNode._xzgNodeHighlightWrapped) {
            this.nodeHighlightHooked = true;
            return;
        }
        // 已成功装过一次后的补装仅限"链顶层连 xzg 系守卫标记都不剩"
        // （被外部整体重置）的情形。xzg_compose_tool 的 200ms 轮询会把
        // 顶层换成带 __xzgShadowGuard 的包装（我们的包装仍在其下正常执行），
        // 此时若再包一层会与它形成互刷死循环，必须共存判定直接跳过。
        if (this._nodeHighlightHookedOnce && topDrawNode.__xzgShadowGuard) {
            this.nodeHighlightHooked = true;
            return;
        }
        this.nodeHighlightHooked = false;
        const self = this;
        const origDrawNode = topDrawNode;
        drawTarget.drawNode = function (node, ctx, ...args) {
            if (!self.nodeHighlightActive || globalThis.LiteGraph?.vueNodesMode === true) {
                return origDrawNode.call(this, node, ctx, ...args);
            }
            // ===== 运行判定（与 V590 老版一致，修复 Nodes 1.0 模式高亮失效）=====
            const job = self._runningJob;
            let isRunning = false;
            if (job && (!job.ownerGraph || node.graph === job.ownerGraph)) {
                const currentRunningId = window.app?.runningNodeId || job.nodeId;
                if (currentRunningId) {
                    const pathParts = String(currentRunningId).split(':').filter(Boolean);
                    // 子图路径遍历：执行 ID 形如 "容器id:内部id"，逐层下钻子图，
                    // 在节点所属的那一层判断 id 是否匹配。
                    let curGraph = window.app?.graph;
                    for (let i = 0; i < pathParts.length; i++) {
                        if (!curGraph) break;
                        if (node.graph === curGraph) {
                            isRunning = node.id.toString() === pathParts[i];
                            break;
                        }
                        const container = curGraph.getNodeById(parseInt(pathParts[i], 10));
                        const isSub = container && (typeof container.isSubgraphNode === 'function'
                            ? container.isSubgraphNode() : !!container.subgraph);
                        if (!container || !isSub || !container.subgraph) break;
                        curGraph = container.subgraph;
                    }
                }
            }
            // [调试·高亮] 记录本次节点是否命中运行高亮判定
            if (window.app && window.__xzgHighlightDebug && job) {
                console.warn("[小珠光高亮] draw", node.type, "id=" + node.id, "isRunning=" + isRunning);
            }
            // 屏蔽原生"运行中"描边（我们用自己的发光边框替代），绘制完恢复。
            const nativeRunningStroke = node?.strokeStyles?.running;
            if (typeof nativeRunningStroke === 'function') {
                node.strokeStyles.running = () => null;
            }
            try {
                origDrawNode.call(this, node, ctx, ...args);
            } finally {
                if (typeof nativeRunningStroke === 'function') node.strokeStyles.running = nativeRunningStroke;
            }
            // ===== 细线发光边框：不改变节点配色/内容，仅沿节点边缘（标题栏+body）画 3px
            // 细光源线 + 模糊发光；无宽色带，模糊光掩盖轮廓偏差，四边四角视觉自然贴合。
            // 不遮挡控件（内容区无覆盖），执行动画仅体现在颜色/亮度随时间变化上。 =====
            if (isRunning) {
                ctx.save();
                try {
                    // ===== 与原生 drawNodeShape 完全同源的轮廓几何 =====
                    // 原生 body 轮廓不是 (0,-titleHeight,w,h+title)，而是 node.boundingRect
                    // 的相对坐标 + renderingShape 形状 + Z.ROUND_RADIUS(=8) 圆角
                    // （CARD 形状为 [r,r,0,0] 四角异形）。照抄才能保证发光带与边缘零偏差。
                    const br = node.boundingRect;
                    const ox = node.pos ? node.pos[0] : 0;
                    const oy = node.pos ? node.pos[1] : 0;
                    const shape = node.renderingShape ?? node._shape ?? LiteGraph.BOX_SHAPE;
                    const RR = LiteGraph.ROUND_RADIUS || 8;
                    const isCard = shape === LiteGraph.CARD_SHAPE;
                    const b = br
                        ? { x: br[0] - ox, y: br[1] - oy, w: br[2], h: br[3] }
                        : { x: 0, y: -(LiteGraph.NODE_TITLE_HEIGHT || 30), w: (node.size && node.size[0]) || 140, h: ((node.size && node.size[1]) || 60) + (LiteGraph.NODE_TITLE_HEIGHT || 30) };
                    // 画节点轮廓子路径（不 beginPath，由调用方控制）
                    const outline = () => {
                        if (shape === LiteGraph.CIRCLE_SHAPE) {
                            ctx.arc(b.x + b.w * 0.5, b.y + b.h * 0.5, Math.max(2, b.w * 0.5), 0, Math.PI * 2);
                        } else if (ctx.roundRect) {
                            ctx.roundRect(b.x, b.y, b.w, b.h, isCard ? [RR, RR, 0, 0] : RR);
                        } else {
                            ctx.rect(b.x, b.y, b.w, b.h);
                        }
                    };
                    const colors = (self.nodeHighlightColor || '#22FF22')
                        .split(',').map(s => s.trim()).filter(Boolean);
                    const solidColor = colors[0] || '#22FF22';
                    // 动画类型：flow 流动 / 连线效果移植系列
                    const anim = self.nodeHighlightColorAnim || 'flow';
                    // 各效果内置钉死参数（不可调，优先于滑条）：speed 1-100（0=静止）/ size 1-100 / count 数量倍率 / glow 光晕倍率
                    const _xzgAnimFixed = {
                        stellar: { speed: 4, size: 20, count: 2.4 },
                        energy: { speed: 0, size: 16, glow: 0.5 },
                        transfer: { speed: 7, size: 22, count: 2.0 },
                        diy1: { speed: 6, size: 18, count: 0.3 },
                        diy2: { speed: 6, size: 48, count: 0.3 },
                    };
                    const _fixed = _xzgAnimFixed[anim];
                    // 流速 1-100 按比例换算：50=默认（2s/圈基准），值越大越快；0=完全静止
                    const _spd = (_fixed && _fixed.speed != null) ? _fixed.speed : (Number(self.nodeHighlightSpeed) || 50);
                    const speedRatio = _spd <= 0 ? 0 : Math.max(0.02, _spd) / 50;
                    const period = speedRatio <= 0 ? Infinity : Math.max(0.1, 2 / speedRatio);
                    const now = performance.now() / 1000;
                    // 颜色工具：hex→rgb（兜底流动分支用）
                    const prs = (h) => {
                        const hh = String(h).replace('#', '');
                        const f = hh.length === 3 ? hh.split('').map(c => c + c).join('') : hh;
                        return [(parseInt(f.slice(0, 2), 16) || 0), (parseInt(f.slice(2, 4), 16) || 0), (parseInt(f.slice(4, 6), 16) || 0)];
                    };
                    ctx.lineJoin = 'round';
                    ctx.lineCap = 'round';
                    ctx.shadowBlur = 0;
                    ctx.globalAlpha = 1;
                    ctx.lineWidth = 3;
                    // 沿节点边框顺时针参数化取点（连线效果移植共用；直角近似，视觉无感）
                    const x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
                    const perim = 2 * (b.w + b.h);
                    const pt = (d) => {
                        if (d < b.w) return [x0 + d, y0];
                        d -= b.w;
                        if (d < b.h) return [x1, y0 + d];
                        d -= b.h;
                        if (d < b.w) return [x1 - d, y1];
                        d -= b.w;
                        return [x0, y1 - d];
                    };
                    if (anim !== 'flow') {
                        // 连线动画效果移植：构造沿节点边框的注入路径，
                        // 直接复用连线动画各效果绘制函数（经 _getPointOnCurve/_xzgBuildPath 注入）
                        const pathAt = (tVal) => {
                            const d = (((tVal % 1) + 1) % 1) * perim;
                            const p = pt(d);
                            const ang = d < b.w ? 0
                                : (d < b.w + b.h ? Math.PI / 2
                                    : (d < 2 * b.w + b.h ? Math.PI : -Math.PI / 2));
                            return { x: p[0], y: p[1], angle: ang };
                        };
                        const fakeCp = [];
                        fakeCp._xzgPathAt = pathAt;
                        fakeCp._xzgBuildPath = () => { ctx.beginPath(); outline(); };
                        fakeCp._xzgSizeK = Math.max(0.1, ((_fixed && _fixed.size != null) ? _fixed.size : (Number(self.nodeHighlightParticleSize) || 50)) / 50); // 0-100 → 倍率（50=1.0x，钉死效果用内置值）
                        fakeCp._xzgCountK = Math.max(0.2, (_fixed && _fixed.count != null) ? _fixed.count : (Number(self.nodeHighlightParticleCount) || 1));
                        fakeCp._xzgGlowK = (_fixed && _fixed.glow != null) ? _fixed.glow : 1;
                        const fakeLink = {
                            startPoint: { x: b.x, y: b.y },
                            endPoint: { x: b.x + b.w, y: b.y },
                            controlPoints: fakeCp,
                            origin_id: node.id, origin_slot: 0,
                            target_id: node.id, target_slot: 0
                        };
                        const savedSpeed = self.linkAnimSpeed;
                        // 各效果内部速度基数 K 不同，按流速滑条换算 linkAnimSpeed，使一圈耗时 = period 秒（与流动语义一致）
                        const _xzgAnimSpeedK = { energy: 0.002, stellar: 0.00035, transfer: 0.0012, diy1: 0.0003, diy2: 0.00035 };
                        self.linkAnimSpeed = 1 / ((_xzgAnimSpeedK[anim] || 0.0003) * 1000 * period);
                        try {
                            self._drawLinkAnim(ctx, fakeLink, anim);
                        } catch (_) {
                        } finally {
                            self.linkAnimSpeed = savedSpeed;
                        }
                    } else if (colors.length > 1 && ctx.createConicGradient) {
                        // 流动：锥形渐变起始角随时间旋转 → 颜色沿边框无缝循环流动
                        const grad = ctx.createConicGradient((now / period) * Math.PI * 2, b.x + b.w * 0.5, b.y + b.h * 0.5);
                        const seq = colors.concat(colors.slice(0, 1));
                        seq.forEach((c, i) => grad.addColorStop(i / seq.length, c));
                        ctx.beginPath();
                        outline();
                        ctx.strokeStyle = grad;
                        ctx.stroke();
                    } else if (colors.length > 1) {
                        // 兜底（无锥形渐变环境）：分段直线近似流动（角部为直角）
                        const phase = (now / period) % 1;
                        const seq = colors.concat(colors.slice(0, 1)); // [A,B,C,A] 首尾同色循环
                        const seqLoop = seq.map(prs);
                        const x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
                        const perim = 2 * (b.w + b.h);
                        const N = Math.max(24, Math.min(72, Math.round(perim / 12)));
                        const pt = (d) => {
                            if (d < b.w) return [x0 + d, y0];
                            d -= b.w;
                            if (d < b.h) return [x1, y0 + d];
                            d -= b.h;
                            if (d < b.w) return [x1 - d, y1];
                            d -= b.w;
                            return [x0, y1 - d];
                        };
                        const L = seqLoop.length;
                        for (let i = 0; i < N; i++) {
                            const t = i / N;
                            const u = ((t + phase) % 1) * L;
                            const i0 = Math.floor(u) % L;
                            const i1 = (i0 + 1) % L;
                            const f = u - Math.floor(u);
                            const ca = seqLoop[i0], cb = seqLoop[i1];
                            const [ax, ay] = pt(t * perim);
                            const [bx2, by2] = pt(((i + 1) / N) * perim);
                            ctx.beginPath();
                            ctx.moveTo(ax, ay);
                            ctx.lineTo(bx2, by2);
                            ctx.strokeStyle = `rgb(${Math.round(ca[0] + (cb[0] - ca[0]) * f)},${Math.round(ca[1] + (cb[1] - ca[1]) * f)},${Math.round(ca[2] + (cb[2] - ca[2]) * f)})`;
                            ctx.stroke();
                        }
                    } else {
                        // 单色：静态描边
                        ctx.beginPath();
                        outline();
                        ctx.strokeStyle = solidColor;
                        ctx.stroke();
                    }
                } catch (e) {
                } finally {
                    ctx.restore();
                }
                // 自持重绘：多色 / 星芒 / 连线效果移植 均需每帧驱动，与 ComfyUI 渲染循环同步
                if ((self.nodeHighlightColor || '').split(',').filter(Boolean).length > 1
                    || anim !== 'flow') {
                    if (app.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
                    else if (app.canvas?.setDirty) app.canvas.setDirty(true, true);
                }
                // 静态发光（无动画）：仅进度条场景需要保底重绘，不做每帧自持重绘
                // 执行进度条保底重绘：在 restore 之后以完全不透明再画一次，
                // 保证视频加载器等耗时节点的加载进度条始终可见。
                try {
                    if (typeof node.drawProgressBar === 'function' && node.progress) {
                        const _barGa = ctx.globalAlpha;
                        ctx.globalAlpha = 1;
                        node.drawProgressBar(ctx);
                        ctx.globalAlpha = _barGa;
                    }
                } catch (_) {}
            }
        };

        drawTarget.drawNode._xzgNodeHighlightWrapped = true;
        // 仅在挂在真实 app.canvas 实例链上时锁定"装过一次"：
        // 缺 canvas 时走 globalThis 兜底原型，后续监视器还要对实例链补装，
        // 不能过早锁定（否则 ShadowGuard 共存判定会阻止补装）。
        if (window.app?.canvas) this._nodeHighlightHookedOnce = true;
        this.nodeHighlightHooked = true;
    },

    toggleLinkAnim() {
        const newState = !this.linkAnimActive;
        this.linkAnimActive = newState;
        this.setupLinkHighlight();
        try {
            localStorage.setItem('xzg-link-anim', this.linkAnimActive ? 'true' : 'false');
        } catch(e) {}
        // 互斥：开启连线动画时关闭连线高亮
        if (newState && this.linkHighlightActive) {
            this.linkHighlightActive = false;
            try { localStorage.setItem('xzg-link-highlight', 'false'); } catch(e) {}
            this._stopHighlightAnimLoop();
        }
        const hasHighlightAnim = this.linkHighlightActive && this.linkHighlightAnimType && this.linkHighlightAnimType !== 'none';
        if (!this.linkAnimActive && !this.linkLaserActive && !hasHighlightAnim) {
            this._stopAnimLoop();
        }
        if (window.app) {
            if (app.canvas?.setDirty) {
                app.canvas.setDirty(true, true);
            } else if (app.graph?.setDirtyCanvas) {
                app.graph.setDirtyCanvas(true, true);
            }
        }
        this._queueThemeCloudSave();
        return this.linkAnimActive;
    },

    setLinkAnimType(type) {
        this.linkAnimType = type;
        try {
            localStorage.setItem('xzg-link-anim-type', type);
        } catch(e) {}
        if (window.app?.canvas?.setDirty) {
            app.canvas.setDirty(true, true);
        }
        this._queueThemeCloudSave();
    },

    setLinkHighlightAnimType(type) {
        this.linkHighlightAnimType = type || 'none';
        try {
            localStorage.setItem('xzg-link-highlight-anim-type', this.linkHighlightAnimType);
        } catch(e) {}
        if (window.app?.canvas?.setDirty) {
            app.canvas.setDirty(true, true);
        }
        this._queueThemeCloudSave();
    },

    setLinkAnimSpeed(speed) {
        const v = parseFloat(speed);
        if (isNaN(v) || v <= 0) return;
        this.linkAnimSpeed = v;
        try {
            localStorage.setItem('xzg-link-anim-speed', String(v));
        } catch(e) {}
        this._queueThemeCloudSave();
    },

    toggleLinkLaser() {
        this.linkLaserActive = !this.linkLaserActive;
        try {
            localStorage.setItem('xzg-link-laser', this.linkLaserActive ? 'true' : 'false');
        } catch(e) {}
        if (!this.linkLaserActive && !this.linkHighlightActive && !this.linkColorActive) {
            this._stopAnimLoop();
        }
        if (window.app) {
            if (app.canvas?.setDirty) {
                app.canvas.setDirty(true, true);
            } else if (app.graph?.setDirtyCanvas) {
                app.graph.setDirtyCanvas(true, true);
            }
        }
        return this.linkLaserActive;
    },

    toggleLinkColor() {
        this.linkColorActive = !this.linkColorActive;
        try {
            localStorage.setItem('xzg-link-color-active', this.linkColorActive ? 'true' : 'false');
        } catch(e) {}
        if (window.app) {
            if (app.canvas?.setDirty) {
                app.canvas.setDirty(true, true);
            } else if (app.graph?.setDirtyCanvas) {
                app.graph.setDirtyCanvas(true, true);
            }
        }
        return this.linkColorActive;
    },

    _drawThinBaseLine(ctx, link) {
        const sp = link.startPoint;
        const ep = link.endPoint;
        if (!sp || !ep) return;

        const sx = sp.x != null ? sp.x : sp[0];
        const sy = sp.y != null ? sp.y : sp[1];
        const ex = ep.x != null ? ep.x : ep[0];
        const ey = ep.y != null ? ep.y : ep[1];
        const cp = link.controlPoints || [];
        const color = link.color || '#888888';

        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        if (cp.length >= 2) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            const c1x = cp[1].x != null ? cp[1].x : cp[1][0];
            const c1y = cp[1].y != null ? cp[1].y : cp[1][1];
            ctx.bezierCurveTo(c0x, c0y, c1x, c1y, ex, ey);
        } else if (cp.length === 1) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            ctx.quadraticCurveTo(c0x, c0y, ex, ey);
        } else {
            ctx.lineTo(ex, ey);
        }
        ctx.stroke();
        ctx.restore();
    },

    _drawHighlightGreenLine(ctx, link) {
        const sp = link.startPoint;
        const ep = link.endPoint;
        if (!sp || !ep) return;

        const sx = sp.x != null ? sp.x : sp[0];
        const sy = sp.y != null ? sp.y : sp[1];
        const ex = ep.x != null ? ep.x : ep[0];
        const ey = ep.y != null ? ep.y : ep[1];
        const cp = link.controlPoints || [];

        ctx.save();
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#FFD700';
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        if (cp.length >= 2) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            const c1x = cp[1].x != null ? cp[1].x : cp[1][0];
            const c1y = cp[1].y != null ? cp[1].y : cp[1][1];
            ctx.bezierCurveTo(c0x, c0y, c1x, c1y, ex, ey);
        } else if (cp.length === 1) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            ctx.quadraticCurveTo(c0x, c0y, ex, ey);
        } else {
            ctx.lineTo(ex, ey);
        }
        ctx.stroke();
        ctx.restore();
    },

    _drawDimWhiteLine(ctx, link) {
        const sp = link.startPoint;
        const ep = link.endPoint;
        if (!sp || !ep) return;

        const sx = sp.x != null ? sp.x : sp[0];
        const sy = sp.y != null ? sp.y : sp[1];
        const ex = ep.x != null ? ep.x : ep[0];
        const ey = ep.y != null ? ep.y : ep[1];
        const cp = link.controlPoints || [];

        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        if (cp.length >= 2) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            const c1x = cp[1].x != null ? cp[1].x : cp[1][0];
            const c1y = cp[1].y != null ? cp[1].y : cp[1][1];
            ctx.bezierCurveTo(c0x, c0y, c1x, c1y, ex, ey);
        } else if (cp.length === 1) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            ctx.quadraticCurveTo(c0x, c0y, ex, ey);
        } else {
            ctx.lineTo(ex, ey);
        }
        ctx.stroke();
        ctx.restore();
    },

    _drawWhiteDashLine(ctx, link) {
        const sp = link.startPoint;
        const ep = link.endPoint;
        if (!sp || !ep) return;

        const sx = sp.x != null ? sp.x : sp[0];
        const sy = sp.y != null ? sp.y : sp[1];
        const ex = ep.x != null ? ep.x : ep[0];
        const ey = ep.y != null ? ep.y : ep[1];
        const cp = link.controlPoints || [];
        const t = performance.now();

        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.setLineDash([8, 5]);
        ctx.lineDashOffset = -(t * 0.03);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        if (cp.length >= 2) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            const c1x = cp[1].x != null ? cp[1].x : cp[1][0];
            const c1y = cp[1].y != null ? cp[1].y : cp[1][1];
            ctx.bezierCurveTo(c0x, c0y, c1x, c1y, ex, ey);
        } else if (cp.length === 1) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            ctx.quadraticCurveTo(c0x, c0y, ex, ey);
        } else {
            ctx.lineTo(ex, ey);
        }
        ctx.stroke();
        ctx.restore();
    },

    _drawLinkAnim(ctx, link, type) {
        type = type || this.linkAnimType || 'sparkle';
        switch (type) {
            case 'sparkle':      this._drawRainbowSparkles(ctx, link); break;
            case 'pulse':        this._drawPacMan(ctx, link); break;
            case 'crystal':      this._drawCrystalStream(ctx, link); break;
            case 'quantum':      this._drawQuantumField(ctx, link); break;
            case 'energy':       this._drawEnergyPulse(ctx, link); break;
            case 'lava':         this._drawLavaFlow(ctx, link); break;
            case 'stellar':      this._drawStellarPlasma(ctx, link); break;
            case 'transfer':     this._drawSimpleTransfer(ctx, link); break;
            case 'randspark':    this._drawRandomSparkle(ctx, link); break;
            case 'diy1':         this._drawCustomDIY1(ctx, link); break;
            case 'diy2':         this._drawCustomDIY2(ctx, link); break;
            default:             this._drawRainbowSparkles(ctx, link);
        }
    },

    _getPointOnCurve(sx, sy, ex, ey, cp, tVal) {
        // 路径注入：节点高亮移植连线动画时，cp 携带 _xzgPathAt 沿节点边框取点
        if (cp && cp._xzgPathAt) return cp._xzgPathAt(tVal);
        let px, py, dx, dy;
        const mt = 1 - tVal;
        if (cp.length >= 2) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            const c1x = cp[1].x != null ? cp[1].x : cp[1][0];
            const c1y = cp[1].y != null ? cp[1].y : cp[1][1];
            const mt2 = mt * mt, mt3 = mt2 * mt;
            const t2 = tVal * tVal, t3 = t2 * tVal;
            px = mt3 * sx + 3 * mt2 * tVal * c0x + 3 * mt * t2 * c1x + t3 * ex;
            py = mt3 * sy + 3 * mt2 * tVal * c0y + 3 * mt * t2 * c1y + t3 * ey;
            dx = 3 * mt2 * (c0x - sx) + 6 * mt * tVal * (c1x - c0x) + 3 * t2 * (ex - c1x);
            dy = 3 * mt2 * (c0y - sy) + 6 * mt * tVal * (c1y - c0y) + 3 * t2 * (ey - c1y);
        } else if (cp.length === 1) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            const mt2 = mt * mt, t2 = tVal * tVal;
            px = mt2 * sx + 2 * mt * tVal * c0x + t2 * ex;
            py = mt2 * sy + 2 * mt * tVal * c0y + t2 * ey;
            dx = 2 * mt * (c0x - sx) + 2 * tVal * (ex - c0x);
            dy = 2 * mt * (c0y - sy) + 2 * tVal * (ey - c0y);
        } else {
            px = sx + (ex - sx) * tVal;
            py = sy + (ey - sy) * tVal;
            dx = ex - sx;
            dy = ey - sy;
        }
        return { x: px, y: py, angle: Math.atan2(dy, dx) };
    },

    // 吃豆人：drawLink 中直接用 link 数据绘制，状态更新在 rAF 中
    _drawPacMan(ctx, link) {
        const sp = link.startPoint;
        const ep = link.endPoint;
        if (!sp || !ep) return;

        const sx = sp.x != null ? sp.x : sp[0];
        const sy = sp.y != null ? sp.y : sp[1];
        const ex = ep.x != null ? ep.x : ep[0];
        const ey = ep.y != null ? ep.y : ep[1];
        const cp = link.controlPoints || [];
        const szK = (cp && cp._xzgSizeK) || 1;
        const cntK = (cp && cp._xzgCountK) || 1;
        const key = `${link.origin_id}_${link.origin_slot}_${link.target_id}_${link.target_slot}`;
        const t = performance.now();

        // 收集当前帧所有连线 key（用于跳转）
        this._pacLinkSet = this._pacLinkSet || new Set();
        this._pacLinkSet.add(key);

        const isCurrent = (key === this._pacCurrentKey);
        const progress = isCurrent ? this._pacProgress : 0;

        ctx.save();

        // 所有线都绘制豆子；当前线隐藏已吃掉的豆子
        const dotCount = Math.max(1, Math.round(8 * cntK));
        for (let i = 0; i < dotCount; i++) {
            const dotT = (i + 0.5) / dotCount;
            if (isCurrent && dotT < progress) continue;
            const dp = this._getPointOnCurve(sx, sy, ex, ey, cp, dotT);
            ctx.beginPath();
            ctx.arc(dp.x, dp.y, 4 * szK, 0, Math.PI * 2);
            ctx.fillStyle = '#FFEE88';
            ctx.shadowBlur = 0;
            ctx.fill();
        }

        // 只有当前线绘制吃豆人
        if (isCurrent) {
            const pacPos = this._getPointOnCurve(sx, sy, ex, ey, cp, progress);
            const pacAngle = pacPos.angle;
            const pacRadius = 14 * szK;
            const mouthOpen = (Math.sin(t * 0.012) * 0.5 + 0.5) * 0.6 + 0.1;

            ctx.translate(pacPos.x, pacPos.y);
            ctx.rotate(pacAngle);

            ctx.beginPath();
            ctx.arc(0, 0, pacRadius, mouthOpen, Math.PI * 2 - mouthOpen);
            ctx.lineTo(0, 0);
            ctx.closePath();
            ctx.fillStyle = '#FFEE00';
            ctx.shadowBlur = 0;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(0, -pacRadius * 0.45, 3, 0, Math.PI * 2);
            ctx.fillStyle = '#222';
            ctx.fill();
        }

        ctx.restore();
    },

    // 辅助：获取连线基础数据
    _getLinkData(link) {
        const sp = link.startPoint, ep = link.endPoint;
        if (!sp || !ep) return null;
        return {
            sx: sp.x != null ? sp.x : sp[0], sy: sp.y != null ? sp.y : sp[1],
            ex: ep.x != null ? ep.x : ep[0], ey: ep.y != null ? ep.y : ep[1],
            cp: link.controlPoints || []
        };
    },

    // 3. Crystal Stream 水晶溪流：透明方块粒子、渐变发光质感
    _drawCrystalStream(ctx, link) {
        const d = this._getLinkData(link); if (!d) return;
        const t = performance.now();
        const speed = (this.linkAnimSpeed || 1) * 0.00025;
        const count = Math.max(1, Math.round(7 * ((d.cp && d.cp._xzgCountK) || 1)));
        const szK = (d.cp && d.cp._xzgSizeK) || 1;
        ctx.save();
        for (let i = 0; i < count; i++) {
            const tVal = ((t * speed) + i / count) % 1;
            const p = this._getPointOnCurve(d.sx, d.sy, d.ex, d.ey, d.cp, tVal);
            const size = 5 * szK;
            const rot = t * 0.001 + i;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(rot);
            // 渐变方块
            const grad = ctx.createLinearGradient(-size, -size, size, size);
            grad.addColorStop(0, 'rgba(100, 200, 255, 0.8)');
            grad.addColorStop(0.5, 'rgba(200, 240, 255, 0.4)');
            grad.addColorStop(1, 'rgba(100, 200, 255, 0.8)');
            ctx.fillStyle = grad;
            ctx.shadowColor = '#74C0FC';
            ctx.shadowBlur = 10;
            ctx.fillRect(-size, -size, size * 2, size * 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.lineWidth = 0.5;
            ctx.shadowBlur = 0;
            ctx.strokeRect(-size, -size, size * 2, size * 2);
            ctx.restore();
        }
        ctx.restore();
    },

    // 4. Quantum Field 量子场：细碎光点随机穿梭
    _drawQuantumField(ctx, link) {
        const d = this._getLinkData(link); if (!d) return;
        const t = performance.now();
        const speed = (this.linkAnimSpeed || 1) * 0.0004;
        const count = Math.max(1, Math.round(14 * ((d.cp && d.cp._xzgCountK) || 1)));
        const szK = (d.cp && d.cp._xzgSizeK) || 1;
        const seed = Math.floor(t / 80);
        const rng = (i) => { const x = Math.sin(seed * 99.7 + i * 31.3) * 43758.5453; return x - Math.floor(x); };
        ctx.save();
        for (let i = 0; i < count; i++) {
            const tVal = ((t * speed * (0.5 + rng(i) * 0.8)) + i / count) % 1;
            const p = this._getPointOnCurve(d.sx, d.sy, d.ex, d.ey, d.cp, tVal);
            const jitter = 4 * szK;
            const jx = (rng(i * 2 + 1) - 0.5) * jitter;
            const jy = (rng(i * 2 + 2) - 0.5) * jitter;
            const size = (1 + rng(i * 3 + 5) * 2) * szK;
            const color = ['#74C0FC', '#A5D8FF', '#E7F5FF', '#4DABF7'][i % 4];
            ctx.beginPath();
            ctx.arc(p.x + jx, p.y + jy, size, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = 6;
            ctx.globalAlpha = 0.4 + rng(i * 7) * 0.6;
            ctx.fill();
        }
        ctx.restore();
    },

    // 6. Energy Pulse 能量脉冲：七彩变色+明暗变化
    _drawEnergyPulse(ctx, link) {
        const d = this._getLinkData(link); if (!d) return;
        const t = performance.now();
        const speed = (this.linkAnimSpeed || 1) * 0.002;
        const pulse = 0.5 + 0.5 * Math.sin(t * speed);
        const hue = (t * 0.05) % 360;
        ctx.save();
        // 构建路径（路径注入时直接用节点边框轮廓）
        const buildPath = () => {
            if (d.cp && d.cp._xzgBuildPath) { d.cp._xzgBuildPath(); return; }
            ctx.beginPath();
            ctx.moveTo(d.sx, d.sy);
            if (d.cp.length >= 2) {
                ctx.bezierCurveTo(
                    d.cp[0].x != null ? d.cp[0].x : d.cp[0][0],
                    d.cp[0].y != null ? d.cp[0].y : d.cp[0][1],
                    d.cp[1].x != null ? d.cp[1].x : d.cp[1][0],
                    d.cp[1].y != null ? d.cp[1].y : d.cp[1][1],
                    d.ex, d.ey
                );
            } else if (d.cp.length === 1) {
                ctx.quadraticCurveTo(
                    d.cp[0].x != null ? d.cp[0].x : d.cp[0][0],
                    d.cp[0].y != null ? d.cp[0].y : d.cp[0][1],
                    d.ex, d.ey
                );
            } else {
                ctx.lineTo(d.ex, d.ey);
            }
        };
        // 外层：七彩变色
        const szK = (d.cp && d.cp._xzgSizeK) || 1;
        const glowK = (d.cp && d.cp._xzgGlowK) || 1; // 光晕扩展倍率（节点模式可钉死减半）
        buildPath();
        ctx.strokeStyle = `hsla(${hue}, 100%, 60%, ${0.2 + pulse * 0.3})`;
        ctx.lineWidth = 6 * szK;
        ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
        ctx.shadowBlur = (15 + pulse * 10) * glowK;
        ctx.stroke();
        // 核心：白色
        buildPath();
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.4 + pulse * 0.5})`;
        ctx.lineWidth = 1.5 * szK;
        ctx.shadowColor = `hsl(${hue}, 100%, 70%)`;
        ctx.shadowBlur = 4 * glowK;
        ctx.stroke();
        ctx.restore();
    },

    // 8. Lava Flow 熔岩流：橙红渐变块状粒子
    _drawLavaFlow(ctx, link) {
        const d = this._getLinkData(link); if (!d) return;
        const t = performance.now();
        const speed = (this.linkAnimSpeed || 1) * 0.0002;
        const count = Math.max(1, Math.round(6 * ((d.cp && d.cp._xzgCountK) || 1)));
        const szK = (d.cp && d.cp._xzgSizeK) || 1;
        ctx.save();
        for (let i = 0; i < count; i++) {
            const tVal = ((t * speed) + i / count) % 1;
            const p = this._getPointOnCurve(d.sx, d.sy, d.ex, d.ey, d.cp, tVal);
            const size = (4 + Math.sin(t * 0.003 + i) * 1.5) * szK;
            const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size * 2);
            grad.addColorStop(0, 'rgba(255, 220, 100, 0.9)');
            grad.addColorStop(0.4, 'rgba(255, 140, 50, 0.6)');
            grad.addColorStop(1, 'rgba(200, 50, 0, 0)');
            ctx.beginPath();
            ctx.arc(p.x, p.y, size * 2, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.shadowColor = '#FF6B35';
            ctx.shadowBlur = 12;
            ctx.fill();
        }
        ctx.restore();
    },

    // 9. Stellar Plasma 恒星等离子：高亮星点拖尾
    _drawStellarPlasma(ctx, link) {
        const d = this._getLinkData(link); if (!d) return;
        const t = performance.now();
        const speed = (this.linkAnimSpeed || 1) * 0.00035;
        const count = Math.max(1, Math.round(5 * ((d.cp && d.cp._xzgCountK) || 1)));
        const szK = (d.cp && d.cp._xzgSizeK) || 1;
        ctx.save();
        for (let i = 0; i < count; i++) {
            const tVal = ((t * speed) + i / count) % 1;
            const p = this._getPointOnCurve(d.sx, d.sy, d.ex, d.ey, d.cp, tVal);
            // 拖尾
            const trailLen = 5;
            for (let j = 0; j < trailLen; j++) {
                const tt = Math.max(0, tVal - j * 0.015);
                const tp = this._getPointOnCurve(d.sx, d.sy, d.ex, d.ey, d.cp, tt);
                const alpha = (1 - j / trailLen) * 0.4;
                const sz = ((1 - j / trailLen) * 3 + 1) * szK;
                ctx.beginPath();
                ctx.arc(tp.x, tp.y, sz, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(180, 220, 255, ${alpha})`;
                ctx.shadowColor = '#A5D8FF';
                ctx.shadowBlur = 8;
                ctx.fill();
            }
            // 头部星点
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3 * szK, 0, Math.PI * 2);
            ctx.fillStyle = '#FFFFFF';
            ctx.shadowColor = '#74C0FC';
            ctx.shadowBlur = 15;
            ctx.fill();
        }
        ctx.restore();
    },

    // A. Simple Transfer 高速穿梭光点
    _drawSimpleTransfer(ctx, link) {
        const d = this._getLinkData(link); if (!d) return;
        const t = performance.now();
        const speed = (this.linkAnimSpeed || 1) * 0.0012;
        const count = Math.max(1, Math.round(3 * ((d.cp && d.cp._xzgCountK) || 1)));
        const szK = (d.cp && d.cp._xzgSizeK) || 1;
        ctx.save();
        for (let i = 0; i < count; i++) {
            const tVal = ((t * speed) + i / count) % 1;
            const p = this._getPointOnCurve(d.sx, d.sy, d.ex, d.ey, d.cp, tVal);
            // 拖尾
            for (let j = 0; j < 8; j++) {
                const tt = Math.max(0, tVal - j * 0.02);
                const tp = this._getPointOnCurve(d.sx, d.sy, d.ex, d.ey, d.cp, tt);
                const alpha = (1 - j / 8) * 0.5;
                const sz = (1 - j / 8) * 4 * szK;
                ctx.beginPath();
                ctx.arc(tp.x, tp.y, Math.max(0.5, sz), 0, Math.PI * 2);
                ctx.fillStyle = `rgba(120, 220, 255, ${alpha})`;
                ctx.shadowColor = '#74C0FC';
                ctx.shadowBlur = 6;
                ctx.fill();
            }
            // 头部
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5 * szK, 0, Math.PI * 2);
            ctx.fillStyle = '#FFFFFF';
            ctx.shadowColor = '#74C0FC';
            ctx.shadowBlur = 20;
            ctx.fill();
        }
        ctx.restore();
    },

    // F. Random Sparkle 随机闪烁星芒
    _drawRandomSparkle(ctx, link) {
        const d = this._getLinkData(link); if (!d) return;
        const t = performance.now();
        const speed = (this.linkAnimSpeed || 1) * 0.001;
        const count = Math.max(1, Math.round(10 * ((d.cp && d.cp._xzgCountK) || 1)));
        const szK = (d.cp && d.cp._xzgSizeK) || 1;
        const seed = Math.floor(t * speed / 5);
        const rng = (i) => { const x = Math.sin(seed * 78.3 + i * 52.7) * 43758.5453; return x - Math.floor(x); };
        const colors = ['#FFD700', '#FF6B6B', '#4DABF7', '#69DB7C', '#FF922B', '#B197FC'];
        ctx.save();
        for (let i = 0; i < count; i++) {
            const tVal = rng(i * 3 + 1);
            const p = this._getPointOnCurve(d.sx, d.sy, d.ex, d.ey, d.cp, tVal);
            const lifePhase = (t * speed * 0.5 + i * 1.7) % 3;
            const alpha = lifePhase < 1 ? lifePhase : (lifePhase < 2 ? 1 : Math.max(0, 2 - lifePhase));
            if (alpha <= 0.01) continue;
            const sz = (4 + rng(i * 5 + 3) * 5) * szK;
            const color = colors[Math.floor(rng(i * 7 + 9) * colors.length)];
            const rotation = rng(i * 11) * Math.PI * 2 + t * 0.001;

            // 星芒：8束光芒 + 径向光晕 + 白色核心
            const rayCount = 8;
            const rayLength = sz;
            const rayHalfWidth = sz * 0.06;
            const coreRadius = sz * 0.18;
            const glowRadius = sz * 0.6;

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.globalAlpha = alpha;

            // 径向光晕
            const glowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, glowRadius);
            glowGrad.addColorStop(0, color + 'CC');
            glowGrad.addColorStop(0.5, color + '66');
            glowGrad.addColorStop(1, color + '00');
            ctx.fillStyle = glowGrad;
            ctx.beginPath();
            ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
            ctx.fill();

            ctx.rotate(rotation);
            ctx.shadowColor = color;
            ctx.shadowBlur = sz * 0.8;

            // 8束三角光芒
            for (let r = 0; r < rayCount; r++) {
                const angle = (r * Math.PI * 2) / rayCount;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);
                const tipX = cos * rayLength;
                const tipY = sin * rayLength;
                const perpX = -sin;
                const perpY = cos;
                const baseInnerX = cos * coreRadius;
                const baseInnerY = sin * coreRadius;
                ctx.beginPath();
                ctx.moveTo(baseInnerX - perpX * rayHalfWidth, baseInnerY - perpY * rayHalfWidth);
                ctx.lineTo(tipX, tipY);
                ctx.lineTo(baseInnerX + perpX * rayHalfWidth, baseInnerY + perpY * rayHalfWidth);
                ctx.closePath();
                ctx.fillStyle = color;
                ctx.fill();
            }

            // 白色核心
            ctx.shadowBlur = sz * 0.5;
            ctx.beginPath();
            ctx.arc(0, 0, coreRadius, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.restore();
        }
        ctx.restore();
    },

    // G. Custom DIY 自定义粒子动画 模板1（金色圆形粒子+长拖尾）
    _drawCustomDIY1(ctx, link) {
        const d = this._getLinkData(link); if (!d) return;
        const t = performance.now();
        const speed = (this.linkAnimSpeed || 1) * 0.0003;
        const count = Math.max(1, Math.round(4 * ((d.cp && d.cp._xzgCountK) || 1)));
        const szK = (d.cp && d.cp._xzgSizeK) || 1;
        ctx.save();
        for (let i = 0; i < count; i++) {
            const tVal = ((t * speed) + i / count) % 1;
            const p = this._getPointOnCurve(d.sx, d.sy, d.ex, d.ey, d.cp, tVal);
            // 长拖尾
            for (let j = 0; j < 12; j++) {
                const tt = Math.max(0, tVal - j * 0.012);
                const tp = this._getPointOnCurve(d.sx, d.sy, d.ex, d.ey, d.cp, tt);
                const alpha = (1 - j / 12) * 0.4;
                const sz = ((1 - j / 12) * 4 + 0.5) * szK;
                ctx.beginPath();
                ctx.arc(tp.x, tp.y, sz, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(255, 215, 0, ${alpha})`;
                ctx.shadowColor = '#FFD700';
                ctx.shadowBlur = 8;
                ctx.fill();
            }
            // 头部
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5 * szK, 0, Math.PI * 2);
            ctx.fillStyle = '#FFF8DC';
            ctx.shadowColor = '#FFD700';
            ctx.shadowBlur = 18;
            ctx.fill();
        }
        ctx.restore();
    },

    // H. Custom DIY 自定义粒子动画 模板2（紫色三角箭头粒子）
    _drawCustomDIY2(ctx, link) {
        const d = this._getLinkData(link); if (!d) return;
        const t = performance.now();
        const speed = (this.linkAnimSpeed || 1) * 0.00035;
        const count = Math.max(1, Math.round(6 * ((d.cp && d.cp._xzgCountK) || 1)));
        const szK = (d.cp && d.cp._xzgSizeK) || 1;
        ctx.save();
        for (let i = 0; i < count; i++) {
            const tVal = ((t * speed) + i / count) % 1;
            const p = this._getPointOnCurve(d.sx, d.sy, d.ex, d.ey, d.cp, tVal);
            const size = (4 + Math.sin(t * 0.004 + i) * 1) * szK;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            // 三角箭头
            ctx.beginPath();
            ctx.moveTo(size, 0);
            ctx.lineTo(-size * 0.6, -size * 0.6);
            ctx.lineTo(-size * 0.3, 0);
            ctx.lineTo(-size * 0.6, size * 0.6);
            ctx.closePath();
            ctx.fillStyle = '#B197FC';
            ctx.shadowColor = '#9775FA';
            ctx.shadowBlur = 10;
            ctx.fill();
            ctx.strokeStyle = '#E5DBFF';
            ctx.lineWidth = 0.5;
            ctx.shadowBlur = 0;
            ctx.stroke();
            ctx.restore();
        }
        ctx.restore();
    },

    _drawRainbowSparkles(ctx, link) {
        const sp = link.startPoint;
        const ep = link.endPoint;
        if (!sp || !ep) return;

        const sx = sp.x != null ? sp.x : sp[0];
        const sy = sp.y != null ? sp.y : sp[1];
        const ex = ep.x != null ? ep.x : ep[0];
        const ey = ep.y != null ? ep.y : ep[1];
        const cp = link.controlPoints || [];
        const t = performance.now();
        const szK = (cp && cp._xzgSizeK) || 1;
        const cntK = (cp && cp._xzgCountK) || 1;

        // 路径注入：节点高亮移植时，cp 携带 _xzgPathAt 沿节点边框取点
        const getPointAtT = cp._xzgPathAt || ((tVal) => {
            if (cp.length >= 2) {
                const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
                const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
                const c1x = cp[1].x != null ? cp[1].x : cp[1][0];
                const c1y = cp[1].y != null ? cp[1].y : cp[1][1];
                const mt = 1 - tVal;
                const x = mt * mt * mt * sx + 3 * mt * mt * tVal * c0x + 3 * mt * tVal * tVal * c1x + tVal * tVal * tVal * ex;
                const y = mt * mt * mt * sy + 3 * mt * mt * tVal * c0y + 3 * mt * tVal * tVal * c1y + tVal * tVal * tVal * ey;
                return { x, y };
            } else if (cp.length === 1) {
                const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
                const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
                const mt = 1 - tVal;
                const x = mt * mt * sx + 2 * mt * tVal * c0x + tVal * tVal * ex;
                const y = mt * mt * sy + 2 * mt * tVal * c0y + tVal * tVal * ey;
                return { x, y };
            } else {
                return {
                    x: sx + (ex - sx) * tVal,
                    y: sy + (ey - sy) * tVal
                };
            }
        });

        const drawStarburst = (cx, cy, color, size, rotation) => {
            const rayCount = 8;
            const rayLength = size;
            const rayHalfWidth = size * 0.06;
            const coreRadius = size * 0.18;
            const glowRadius = size * 0.6;

            ctx.save();
            ctx.translate(cx, cy);

            const glowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, glowRadius);
            glowGrad.addColorStop(0, color + 'CC');
            glowGrad.addColorStop(0.5, color + '66');
            glowGrad.addColorStop(1, color + '00');
            ctx.fillStyle = glowGrad;
            ctx.beginPath();
            ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
            ctx.fill();

            ctx.rotate(rotation);

            ctx.shadowColor = color;
            ctx.shadowBlur = size * 0.8;

            for (let i = 0; i < rayCount; i++) {
                const angle = (i * Math.PI * 2) / rayCount;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);

                const tipX = cos * rayLength;
                const tipY = sin * rayLength;

                const perpX = -sin;
                const perpY = cos;

                const baseInnerX = cos * coreRadius;
                const baseInnerY = sin * coreRadius;

                ctx.beginPath();
                ctx.moveTo(baseInnerX - perpX * rayHalfWidth, baseInnerY - perpY * rayHalfWidth);
                ctx.lineTo(tipX, tipY);
                ctx.lineTo(baseInnerX + perpX * rayHalfWidth, baseInnerY + perpY * rayHalfWidth);
                ctx.closePath();
                ctx.fillStyle = color;
                ctx.fill();
            }

            ctx.shadowBlur = size * 0.5;
            ctx.beginPath();
            ctx.arc(0, 0, coreRadius, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();

            ctx.restore();
        };

        const rainbowColors = [
            '#FF6B6B',
            '#FFA94D',
            '#FFE066',
            '#69DB7C',
            '#339AF0',
            '#9775FA',
            '#F06595'
        ];

        const sparkleCount = Math.max(1, Math.round(5 * cntK));
        const speed = 0.00025 * (this.linkAnimSpeed || 1);
        const baseOffset = (t * speed) % 1;

        ctx.save();

        for (let i = 0; i < sparkleCount; i++) {
            const tVal = (baseOffset + i / sparkleCount) % 1;
            const pos = getPointAtT(tVal);
            const color = rainbowColors[i % rainbowColors.length];
            const pulse = 0.7 + 0.3 * Math.sin(t * 0.004 + i * 1.2);
            const size = 11 * pulse * szK;
            const rotation = t * 0.001 + i * 0.5;

            drawStarburst(pos.x, pos.y, color, size, rotation);
        }

        ctx.restore();
    },

    _drawLaserOverlay(ctx, link, originId, targetId) {
        const sp = link.startPoint;
        const ep = link.endPoint;
        if (!sp || !ep) return;

        const sx = sp.x != null ? sp.x : sp[0];
        const sy = sp.y != null ? sp.y : sp[1];
        const ex = ep.x != null ? ep.x : ep[0];
        const ey = ep.y != null ? ep.y : ep[1];
        const cp = link.controlPoints || [];
        const laserColor = this.linkColor || '#888888';
        const t = Date.now();

        // 构建路径辅助函数
        const buildPath = () => {
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            if (cp.length >= 2) {
                const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
                const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
                const c1x = cp[1].x != null ? cp[1].x : cp[1][0];
                const c1y = cp[1].y != null ? cp[1].y : cp[1][1];
                ctx.bezierCurveTo(c0x, c0y, c1x, c1y, ex, ey);
            } else if (cp.length === 1) {
                const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
                const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
                ctx.quadraticCurveTo(c0x, c0y, ex, ey);
            } else {
                ctx.lineTo(ex, ey);
            }
        };

        const type = this.laserAnimType || 'flow';

        switch (type) {
            case 'flow':   this._animFlow(ctx, buildPath, sx, sy, ex, ey, laserColor, t); break;
            case 'gradient': this._animGradient(ctx, buildPath, sx, sy, ex, ey, laserColor, t); break;
            case 'breath': this._animBreath(ctx, buildPath, laserColor, t); break;
            case 'glow':   this._animGlow(ctx, buildPath, laserColor, t); break;
            default:       this._animFlow(ctx, buildPath, sx, sy, ex, ey, laserColor, t);
        }
    },

    // 流光溢彩：彩虹渐变沿连线流动
    _animFlow(ctx, buildPath, sx, sy, ex, ey, laserColor, t) {
        const speed = 0.045 * (this.linkAnimSpeed || 1);
        const dashLen = 14;
        const gapLen = 16;
        const offset = (t * speed) % (dashLen + gapLen);
        const hueShift = (t * 0.05) % 360;

        // 解析基础颜色
        const rgb = this._hexToRgb(laserColor);

        ctx.save();

        // 彩虹发光底层
        const grad = ctx.createLinearGradient(sx, sy, ex, ey);
        for (let i = 0; i <= 4; i++) {
            const hue = (hueShift + i * 90) % 360;
            grad.addColorStop(i / 4, `hsla(${hue}, 100%, 60%, 0.5)`);
        }
        buildPath();
        ctx.strokeStyle = grad;
        ctx.lineWidth = 3;
        ctx.shadowColor = laserColor;
        ctx.shadowBlur = 12;
        ctx.setLineDash([dashLen, gapLen]);
        ctx.lineDashOffset = -offset;
        ctx.stroke();

        // 白色核心
        buildPath();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.6;
        ctx.shadowBlur = 4;
        ctx.setLineDash([dashLen, gapLen]);
        ctx.lineDashOffset = -offset;
        ctx.stroke();

        ctx.restore();
    },

    // 颜色渐变：沿连线静态渐变
    _animGradient(ctx, buildPath, sx, sy, ex, ey, laserColor, t) {
        const rgb = this._hexToRgb(laserColor);
        const pulse = 0.5 + 0.3 * Math.sin(t * 0.003);

        ctx.save();

        // 渐变底层
        const grad = ctx.createLinearGradient(sx, sy, ex, ey);
        grad.addColorStop(0, laserColor);
        grad.addColorStop(0.5, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${pulse})`);
        grad.addColorStop(1, '#ffffff');
        buildPath();
        ctx.strokeStyle = grad;
        ctx.lineWidth = 4;
        ctx.shadowColor = laserColor;
        ctx.shadowBlur = 12;
        ctx.stroke();

        // 明亮核心
        const grad2 = ctx.createLinearGradient(sx, sy, ex, ey);
        grad2.addColorStop(0, `rgba(255,255,255,${pulse * 0.5})`);
        grad2.addColorStop(1, '#ffffff');
        buildPath();
        ctx.strokeStyle = grad2;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.8;
        ctx.stroke();

        ctx.restore();
    },

    // 亮度呼吸：整体亮度正弦波动
    _animBreath(ctx, buildPath, laserColor, t) {
        const breath = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 0.004));
        const rgb = this._hexToRgb(laserColor);

        ctx.save();

        // 呼吸发光层
        buildPath();
        ctx.strokeStyle = laserColor;
        ctx.lineWidth = 4;
        ctx.globalAlpha = breath;
        ctx.shadowColor = laserColor;
        ctx.shadowBlur = 10 + breath * 16;
        ctx.stroke();

        // 核心亮线
        buildPath();
        ctx.strokeStyle = `rgba(${Math.min(255, rgb.r + 100)}, ${Math.min(255, rgb.g + 100)}, ${Math.min(255, rgb.b + 100)}, ${breath})`;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 4;
        ctx.stroke();

        ctx.restore();
    },

    // 辉光：强烈光晕向外扩散
    _animGlow(ctx, buildPath, laserColor, t) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.003);
        const rgb = this._hexToRgb(laserColor);

        ctx.save();

        // 外层大光晕
        buildPath();
        ctx.strokeStyle = laserColor;
        ctx.lineWidth = 8;
        ctx.globalAlpha = 0.15 + pulse * 0.15;
        ctx.shadowColor = laserColor;
        ctx.shadowBlur = 25 + pulse * 15;
        ctx.stroke();

        // 中层光晕
        buildPath();
        ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.6)`;
        ctx.lineWidth = 4;
        ctx.globalAlpha = 0.4 + pulse * 0.3;
        ctx.shadowBlur = 12 + pulse * 8;
        ctx.stroke();

        // 内层亮核心
        buildPath();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5 + pulse * 0.4;
        ctx.shadowBlur = 6;
        ctx.stroke();

        ctx.restore();
    },

    _hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : { r: 0, g: 255, b: 255 };
    },

    _ensureAnimLoop() {
        if (this.linkAnimRunning) return;
        this.linkAnimRunning = true;
        const self = this;
        function loop() {
            const hasHighlightAnim = self.linkHighlightActive && self.linkHighlightAnimType && self.linkHighlightAnimType !== 'none' && self._hasSelectedNodes();
            if (!self.linkLaserActive && !self.linkAnimActive && !hasHighlightAnim) {
                self.linkAnimRunning = false;
                self.linkAnimFrameId = null;
                return;
            }
            // 吃豆人状态更新（每帧只执行一次，连线动画或高亮动画为 pulse 时均触发）
            if ((self.linkAnimActive && self.linkAnimType === 'pulse') || (hasHighlightAnim && self.linkHighlightAnimType === 'pulse')) {
                self._updatePacManState();
            }
            if (window.app?.canvas?.setDirty) {
                app.canvas.setDirty(true, true);
            }
            self.linkAnimFrameId = requestAnimationFrame(loop);
        }
        self.linkAnimFrameId = requestAnimationFrame(loop);
    },

    // 吃豆人状态更新（在 rAF 中调用，每帧一次）
    _updatePacManState() {
        const t = performance.now();
        const dt = t - (this._pacLastTime || t);
        this._pacLastTime = t;

        const linkSet = this._pacLinkSet;
        this._pacLinkSet = new Set(); // 清空，下一帧 drawLink 重新收集

        if (!linkSet || linkSet.size === 0) return;

        // 当前 key 无效（被删除等），重置为第一条
        if (!this._pacCurrentKey || !linkSet.has(this._pacCurrentKey)) {
            this._pacCurrentKey = linkSet.values().next().value;
            this._pacProgress = 0;
            return;
        }

        this._pacProgress += dt * 0.00025 * (this.linkAnimSpeed || 1);
        if (this._pacProgress >= 1) {
            // 吃完一根线，跳到下一根
            const keys = Array.from(linkSet);
            const idx = keys.indexOf(this._pacCurrentKey);
            const nextIdx = (idx + 1) % keys.length;
            this._pacCurrentKey = keys[nextIdx];
            this._pacProgress = 0;
        }
    },

    _ensureHighlightAnimLoop() {
        if (this.linkHighlightAnimRunning) return;
        this.linkHighlightAnimRunning = true;
        const self = this;
        function loop() {
            if (!self.linkHighlightActive || !self._hasSelectedNodes()) {
                self.linkHighlightAnimRunning = false;
                self.linkHighlightAnimFrameId = null;
                return;
            }
            if (window.app?.canvas?.setDirty) {
                app.canvas.setDirty(true, true);
            }
            self.linkHighlightAnimFrameId = requestAnimationFrame(loop);
        }
        self.linkHighlightAnimFrameId = requestAnimationFrame(loop);
    },

    _hasSelectedNodes() {
        if (!window.app || !app.canvas) return false;
        return this.getHighlightNodeIds().length > 0;
    },

    _stopAnimLoop() {
        this.linkAnimRunning = false;
        if (this.linkAnimFrameId) {
            cancelAnimationFrame(this.linkAnimFrameId);
            this.linkAnimFrameId = null;
        }
    },

    _stopHighlightAnimLoop() {
        this.linkHighlightAnimRunning = false;
        if (this.linkHighlightAnimFrameId) {
            cancelAnimationFrame(this.linkHighlightAnimFrameId);
            this.linkHighlightAnimFrameId = null;
        }
    },

    hookDrawNodeShape(canvas = app.canvas) {
        if (!canvas) return;

        const self = this;

        function hookMethod(methodName, makeWrapper) {
            // 只包装属性查找时实际命中的最近一层。把整条原型链都包起来，
            // 遇到子类调用 super 或扩展链式替换时会重复执行主题绘制。
            if (typeof canvas[methodName] !== 'function') return false;
            let proto = Object.getPrototypeOf(canvas);
            let owner = Object.prototype.hasOwnProperty.call(canvas, methodName) ? canvas : null;
            while (!owner && proto && proto !== Object.prototype) {
                if (Object.prototype.hasOwnProperty.call(proto, methodName) && typeof proto[methodName] === 'function') {
                    owner = proto;
                    break;
                }
                proto = Object.getPrototypeOf(proto);
            }
            if (!owner) return false;
            const orig = owner[methodName];
            if (orig._xzgThemeGradientHook) return true;
            const wrapper = makeWrapper(orig);
            wrapper._xzgWrapped = true;
            wrapper._xzgThemeGradientHook = true;
            owner[methodName] = wrapper;
            return true;
        }

        function makeDrawShapeWrapper(origFn) {
            return function(node, ctx, size, fgcolor, bgcolor, selected, mouseOver) {
                // 绕过状态下不应用主题色，保持紫色绕过状态
                if (node.mode === 4) {
                    origFn.call(this, node, ctx, size, fgcolor, bgcolor, selected, mouseOver);
                    return;
                }
                const gradientConfig = self.getNodeGradientConfig(node);

                // 大字文本展示节点：主题只作用在标题栏。
                // 正文（文字显示区）完全由节点自行绘制，主题一律不绘制、不覆盖，
                // 因此无论绘制先后，正文区域都不会被主题渐变或底色盖住。
                if (node.type === "XiaozhuguangBigDisplay") {
                    if (!gradientConfig) {
                        origFn.call(this, node, ctx, size, fgcolor, bgcolor, selected, mouseOver);
                        return;
                    }
                    const _LG = typeof LiteGraph !== 'undefined' ? LiteGraph : null;
                    const _th = _LG?.NODE_TITLE_HEIGHT || 30;
                    const _w = size[0], _h = size[1];
                    const _r = node.borderRadius || _LG?.NODE_CORNER_RADIUS || 8;
                    const _cfg = gradientConfig;
                    const _titlePts = self._titleGradPts(_w, _th);
                    const _sym = self.degToSymbol(_cfg.titleDirection || _cfg.direction);
                    const [_x1, _y1, _x2, _y2] = _titlePts[_sym] || _titlePts['↓'];
                    const _useT = _cfg.useTitleGradient && _cfg.titleStops && _cfg.titleStops.length > 0;
                    const _gradSrc = _useT ? _cfg.titleStops : (_cfg.stops || []);
                    const _grad = ctx.createLinearGradient(_x1, _y1, _x2, _y2);
                    (_gradSrc.length ? _gradSrc : [{ p: 0, color: '#333' }, { p: 1, color: '#333' }])
                        .forEach(s => _grad.addColorStop(s.p, s.color));

                    // 仅把主题渐变画到标题栏并绘制标题文字；正文用节点默认底色兜底（不透明），再交给节点 onDrawBackground 绘制文字
                    ctx.save();
                    try {
                        // 先画整个节点外框的圆角（不含渐变的底色）作为正文背景，避免正文镂空透明
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(0, -_th, _w, _h + _th, _r);
                        else ctx.rect(0, -_th, _w, _h + _th);
                        ctx.fillStyle = (node.bgcolor && node.bgcolor !== 'transparent') ? node.bgcolor : '#1a1a1a';
                        ctx.fill();

                        // 仅在标题栏区域叠上主题渐变
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(0, -_th, _w, _th, [_r, _r, 0, 0]);
                        else ctx.rect(0, -_th, _w, _th);
                        ctx.fillStyle = _grad;
                        ctx.fill();

                        const _title = node.getTitle ? node.getTitle() : (node.title || '');
                        if (_title) {
                            const _fs = _cfg.fontSize || _LG?.NODE_TEXT_SIZE || 14;
                            const _color = _cfg.titleText || '#ffffff';
                            const _align = _cfg.textAlign || 'left';
                            ctx.font = `${_fs}px "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif`;
                            ctx.fillStyle = _color;
                            ctx.textBaseline = 'middle';
                            let _textX = 10;
                            if (_align === 'center') { ctx.textAlign = 'center'; _textX = _w / 2; }
                            else if (_align === 'right') { ctx.textAlign = 'right'; _textX = _w - 10; }
                            else ctx.textAlign = 'left';
                            ctx.fillText(_title, _textX, -_th / 2);
                        }
                    } finally { ctx.restore(); }

                    // ⚠️ 关键：makeDrawShapeWrapper 中我们直接 return 跳过了 origFn，但
                    // LiteGraph 原本会在节点绘制流程中调用 node.onDrawBackground（大字文字在这里画）。
                    // 必须显式补调，否则开启主题后正文文字永远不会被绘制（表现为"正文透明/什么都没有"）。
                    try { if (typeof node.onDrawBackground === 'function') node.onDrawBackground(ctx); }
                    catch (e) { console.warn('[小珠光主题] BigDisplay onDrawBackground 调用异常', e); }

                    return;
                }

                if (!gradientConfig) {
                    origFn.call(this, node, ctx, size, fgcolor, bgcolor, selected, mouseOver);
                    return;
                }

                const LG = typeof LiteGraph !== 'undefined' ? LiteGraph : null;
                const th = LG?.NODE_TITLE_HEIGHT || 30;
                const w = size[0], h = size[1];
                const r = node.borderRadius || LG?.NODE_CORNER_RADIUS || 8;
                const cfg = gradientConfig;
                const pts = self._gradPts(w, h, th);
                const titlePts = self._titleGradPts(w, th);
                const bodyPts = self._bodyGradPts(w, h);
                const dirSym = self.degToSymbol(cfg.direction);
                const titleDirSym = self.degToSymbol(cfg.titleDirection || cfg.direction);

                ctx.save();
                try {
                    const useTitleGradient = cfg.useTitleGradient && cfg.titleStops && cfg.titleStops.length > 0;
                    
                    // 1. Draw custom background (title + body)
                    if (useTitleGradient) {
                        const [tx1, ty1, tx2, ty2] = titlePts[titleDirSym] || titlePts['↓'];
                        const titleGrad = ctx.createLinearGradient(tx1, ty1, tx2, ty2);
                        cfg.titleStops.forEach(s => titleGrad.addColorStop(s.p, s.color));
                        
                        const [bx1, by1, bx2, by2] = bodyPts[dirSym] || bodyPts['↓'];
                        const bodyGrad = ctx.createLinearGradient(bx1, by1, bx2, by2);
                        cfg.stops.forEach(s => bodyGrad.addColorStop(s.p, s.color));
                        
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(0, -th, w, th, [r, r, 0, 0]);
                        else ctx.rect(0, -th, w, th);
                        ctx.fillStyle = titleGrad;
                        ctx.fill();
                        
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(0, 0, w, h, [0, 0, r, r]);
                        else ctx.rect(0, 0, w, h);
                        ctx.fillStyle = bodyGrad;
                        ctx.fill();
                    } else {
                        const [x1, y1, x2, y2] = pts[dirSym] || pts['↓'];
                        const grad = ctx.createLinearGradient(x1, y1, x2, y2);
                        cfg.stops.forEach(s => grad.addColorStop(s.p, s.color));
                        
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(0, -th, w, h + th, r);
                        else ctx.rect(0, -th, w, h + th);
                        ctx.fillStyle = grad;
                        ctx.fill();
                    }

                    // 2. Call the original function with alpha=0 to hide original rendering
                    // (original drawNodeShape may use save/restore internally and reset alpha to 1 for title text)
                    ctx.globalAlpha = 0;
                    origFn.call(this, node, ctx, size, fgcolor, bgcolor, selected, mouseOver);
                    
                    // 3. Redraw title background to hide any original title text that was drawn with alpha=1
                    ctx.globalAlpha = 1;
                    // 进度条补画：origFn 在 globalAlpha=0 下执行，会把原生执行进度条
                    // （drawNodeShape 末尾的 drawProgressBar，视频加载器等耗时节点的加载进度）
                    // 一并隐藏。这里以正常透明度补画一次，保证主题渐变节点的执行进度条可见。
                    try {
                        if (typeof node.drawProgressBar === 'function' && node.progress) {
                            node.drawProgressBar(ctx);
                        }
                    } catch (_) {}
                    if (useTitleGradient) {
                        const [tx1, ty1, tx2, ty2] = titlePts[titleDirSym] || titlePts['↓'];
                        const titleGrad = ctx.createLinearGradient(tx1, ty1, tx2, ty2);
                        cfg.titleStops.forEach(s => titleGrad.addColorStop(s.p, s.color));
                        
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(0, -th, w, th, [r, r, 0, 0]);
                        else ctx.rect(0, -th, w, th);
                        ctx.fillStyle = titleGrad;
                        ctx.fill();
                    }

                    // 4. Draw custom title text on top (ensures correct position within title bar)
                    const title = node.getTitle ? node.getTitle() : (node.title || '');
                    if (title) {
                        const fontSize = cfg.fontSize || LG?.NODE_TEXT_SIZE || 14;
                        const color = cfg.titleText || '#ffffff';
                        const align = cfg.textAlign || 'left';
                        ctx.save();
                        ctx.font = `${fontSize}px "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif`;
                        ctx.fillStyle = color;
                        ctx.textBaseline = 'middle';
                        
                        let textX = 10;
                        if (align === 'center') {
                            ctx.textAlign = 'center';
                            textX = w / 2;
                        } else if (align === 'right') {
                            ctx.textAlign = 'right';
                            textX = w - 10;
                        } else {
                            ctx.textAlign = 'left';
                            textX = 10;
                        }
                        
                        ctx.fillText(title, textX, -th / 2);
                        ctx.restore();
                    }
                } catch(e) {
                    if (!node._xzgGradientDrawErrorLogged) {
                        node._xzgGradientDrawErrorLogged = true;
                        console.warn('[小珠光主题] 节点渐变绘制失败，已回退原背景', node.id, node.type, e);
                    }
                    origFn.call(this, node, ctx, size, fgcolor, bgcolor, selected, mouseOver);
                } finally {
                    ctx.restore();
                }
            };
        }

        const ok = hookMethod('drawNodeShape', makeDrawShapeWrapper);
        if (!ok) {
            hookMethod('drawNode', makeDrawShapeWrapper);
        }
    },

    _gradPts(w, h, th) {
        return {
            '↖': [w, h, 0, -th], '↑': [0, h, 0, -th], '↗': [0, h, w, -th],
            '←': [w, 0, 0,  0],  '→': [0, 0, w,  0],
            '↙': [w, -th, 0, h], '↓': [0, -th, 0, h], '↘': [0, -th, w, h],
        };
    },

    _titleGradPts(w, th) {
        return {
            '↖': [w, 0, 0, -th], '↑': [0, 0, 0, -th], '↗': [0, 0, w, -th],
            '←': [w, -th/2, 0, -th/2],  '→': [0, -th/2, w, -th/2],
            '↙': [w, -th, 0, 0], '↓': [0, -th, 0, 0], '↘': [0, -th, w, 0],
        };
    },

    _bodyGradPts(w, h) {
        return {
            '↖': [w, h, 0, 0], '↑': [0, h, 0, 0], '↗': [0, h, w, 0],
            '←': [w, h/2, 0, h/2],  '→': [0, h/2, w, h/2],
            '↙': [w, 0, 0, h], '↓': [0, 0, 0, h], '↘': [0, 0, w, h],
        };
    },

    degToSymbol(deg) {
        const map = {
            '0': '↓', '90': '→', '180': '↑', '270': '←',
            '45': '↘', '135': '↙', '225': '↖', '315': '↗'
        };
        return map[String(deg)] || '↓';
    },

    buildGradientConfig(colors) {
        const stops = [];
        if (colors.useGradient) {
            stops.push({ p: 0, color: colors.color1 });
            stops.push({ p: 0.5, color: colors.color2 });
            stops.push({ p: 1, color: colors.color3 });
        } else {
            stops.push({ p: 0, color: colors.color1 });
            stops.push({ p: 1, color: colors.color1 });
        }
        
        const titleStops = [];
        const useTitleGradient = colors.useTitleGradient !== false && colors.titleColor1;
        if (useTitleGradient) {
            titleStops.push({ p: 0, color: colors.titleColor1 });
            titleStops.push({ p: 0.5, color: colors.titleColor2 || colors.titleColor1 });
            titleStops.push({ p: 1, color: colors.titleColor3 || colors.titleColor1 });
        }
        
        return {
            direction: colors.direction || '90',
            stops: stops,
            titleDirection: colors.titleDirection || '90',
            titleStops: titleStops,
            useTitleGradient: useTitleGradient,
            titleText: colors.titleText || '#ffffff',
            useGradient: colors.useGradient !== false,
            fontSize: colors.fontSize || 14,
            textAlign: colors.textAlign || 'left'
        };
    },

    buildGradientCSS(colors) {
        if (!colors.useGradient) {
            return colors.color1;
        }
        const cssDeg = this.dirToCssDeg(colors.direction);
        return `linear-gradient(${cssDeg}deg, ${colors.color1} 0%, ${colors.color2} 50%, ${colors.color3} 100%)`;
    },

    buildTitleGradientCSS(colors) {
        if (!colors.useTitleGradient || !colors.titleColor1) {
            return null;
        }
        const cssDeg = this.dirToCssDeg(colors.titleDirection || '90');
        return `linear-gradient(${cssDeg}deg, ${colors.titleColor1} 0%, ${colors.titleColor2 || colors.titleColor1} 50%, ${colors.titleColor3 || colors.titleColor1} 100%)`;
    },

    dirToCssDeg(deg) {
        const sym = this.degToSymbol(deg);
        const map = {
            '↑': 0, '→': 90, '↓': 180, '←': 270,
            '↗': 45, '↘': 135, '↖': 225, '↙': 315
        };
        return map[sym] !== undefined ? map[sym] : 180;
    },

    applyThemeToNodes(nodes, colors) {
        if (!nodes || !nodes.length) return;

        const vueNodesMode = !!globalThis.LiteGraph?.vueNodesMode;
        if (vueNodesMode) {
            // Nodes 2 的节点背景由 DOM 样式绘制，避免依赖 LiteGraph canvas 钩子。
            this.refreshDOMGradients();
        } else {
            // Nodes 1 使用独立的原生画布绘制入口。
            this.ensureLegacyGradientHook();
        }
        
        const cfg = this.buildGradientConfig(colors);
        const gradCSS = this.buildGradientCSS(colors);

        nodes.forEach(node => {
            if (node.type === "XiaozhuguangTitle") return;
            node._xzgGradient = { ...cfg };
            node.properties ||= {};
            node.properties._xzgGradient = JSON.parse(JSON.stringify(cfg));
            if (node.type === "XiaozhuguangBigDisplay") {
                // 大字文本展示节点：仅标题栏允许主题，正文区域保持节点默认的背景/透明度，
                // 不设置 node.color/bgcolor。标题栏主题已由 makeDrawShapeWrapper 在画布上绘制，
                // 这里绝不能再调用 applyGradientToDOMNode —— 它会把不透明主题渐变铺到节点 DOM
                // 内层上，盖住画布绘制的正文文字（表现为文字区域变透明/无内容）。
                return;
            }
            node.color = colors.color1;
            node.bgcolor = colors.color1;
            this.applyGradientToDOMNode(node);
        });

        if (app.graph) {
            app.graph.setDirtyCanvas?.(true, true);
            // 标记工作流已修改，确保更改可被保存
            app.graph.change?.();
        }
    },

    applyGradientToDOMNode(node) {
        if (!node || !node._xzgGradient) return;
        // Nodes 1 的主题由主画布绘制，不能给其 DOM 控件覆盖层铺背景。
        if (!globalThis.LiteGraph?.vueNodesMode) return;
        // 大字展示节点：正文完全由画布绘制，DOM 层任何主题渐变/透明都会盖住文字。
        // 一律跳过 DOM 操作，标题栏主题交给 makeDrawShapeWrapper 画布绘制。
        // 另外必须清理历史遗留的 DOM 样式（之前调用可能把 inner/body 背景设为渐变或透明）。
        if (node.type === "XiaozhuguangBigDisplay") {
            this.removeGradientFromDOMNode(node);
            return;
        }

        const graphCanvas = document.getElementById("graph-canvas");
        // Nodes 2 的 DOM 节点是主 canvas 的兄弟元素，并不在 canvas 内部。
        const graphRoot = graphCanvas?.parentElement || document;
        const cfg = node._xzgGradient;
        const useTitleGradient = cfg.useTitleGradient && cfg.titleStops && cfg.titleStops.length > 0;
        
        const gradCSS = this.buildGradientCSS({
            color1: cfg.stops[0]?.color || '#e49c00',
            color2: cfg.stops[1]?.color || '#000000',
            color3: cfg.stops[2]?.color || '#005149',
            direction: cfg.direction || '90',
            useGradient: cfg.useGradient !== false
        });
        
        const titleGradCSS = useTitleGradient ? this.buildTitleGradientCSS({
            titleColor1: cfg.titleStops[0]?.color,
            titleColor2: cfg.titleStops[1]?.color,
            titleColor3: cfg.titleStops[2]?.color,
            titleDirection: cfg.titleDirection || '90',
            useTitleGradient: true
        }) : null;

        const nodeEls = graphRoot.querySelectorAll(
            `.lg-node[data-node-id="${node.id}"]`
        );
        
        nodeEls.forEach(nodeEl => {
            const inner = nodeEl.querySelector('[data-testid="node-inner-wrapper"]') || nodeEl;
            
            if (useTitleGradient) {
                inner.style.setProperty('background', gradCSS, 'important');
                inner.style.setProperty('--component-node-background', 'transparent', 'important');
                inner.style.setProperty('--component-node-header', 'transparent', 'important');
            } else {
                inner.style.setProperty('background', gradCSS, 'important');
                inner.style.setProperty('--component-node-background', 'transparent', 'important');
                inner.style.setProperty('--component-node-header', 'transparent', 'important');
            }

            const headerSelectors = [
                '[data-testid*="header"]', '.comfy-header', '.comfy-title', 
                '.node-header', '.node-title', '.litegraph .title',
                '.node-titlebar', '.title-bar', '.litemenu-title'
            ];
            const header = nodeEl.querySelector(headerSelectors.join(', '));
            if (header) {
                if (useTitleGradient && titleGradCSS) {
                    header.style.setProperty('background', titleGradCSS, 'important');
                    header.style.setProperty('background-color', titleGradCSS, 'important');
                } else {
                    header.style.setProperty('background', 'transparent', 'important');
                    header.style.setProperty('background-color', 'transparent', 'important');
                }
                header.style.setProperty('color', cfg.titleText || '#ffffff', 'important');
                if (cfg.fontSize) {
                    header.style.setProperty('font-size', cfg.fontSize + 'px', 'important');
                    const textEls = header.querySelectorAll('*');
                    textEls.forEach(el => {
                        el.style.setProperty('font-size', cfg.fontSize + 'px', 'important');
                    });
                }
                if (cfg.textAlign) {
                    header.style.setProperty('text-align', cfg.textAlign, 'important');
                    if (header.style.display === 'flex' || getComputedStyle(header).display === 'flex') {
                        header.style.setProperty('justify-content', cfg.textAlign === 'left' ? 'flex-start' : (cfg.textAlign === 'right' ? 'flex-end' : 'center'), 'important');
                    }
                    const textEls = header.querySelectorAll('span, div, p, h1, h2, h3, h4');
                    textEls.forEach(el => {
                        el.style.setProperty('text-align', cfg.textAlign, 'important');
                        if (getComputedStyle(el).display === 'flex') {
                            el.style.setProperty('justify-content', cfg.textAlign === 'left' ? 'flex-start' : (cfg.textAlign === 'right' ? 'flex-end' : 'center'), 'important');
                        }
                    });
                }
            }

            const body = nodeEl.querySelector('[data-testid*="body"], .comfy-body, .comfy-content, .node-body, .content');
            if (body) {
                body.style.setProperty('background', 'transparent', 'important');
                body.style.setProperty('background-color', 'transparent', 'important');
            }
        });
    },

    removeThemeFromNodes(nodes) {
        if (!nodes || !nodes.length) return;

        nodes.forEach(node => {
            delete node._xzgGradient;
            if (node.properties) delete node.properties._xzgGradient;
            node.color = null;
            node.bgcolor = null;
            this.removeGradientFromDOMNode(node);
        });

        if (app.graph) {
            app.graph.setDirtyCanvas?.(true, true);
            app.graph.change?.();
        }
    },

    removeGradientFromDOMNode(node) {
        const graphCanvas = document.getElementById("graph-canvas");
        const graphRoot = graphCanvas?.parentElement || document;

        const nodeEls = graphRoot.querySelectorAll(
            `.lg-node[data-node-id="${node.id}"]`
        );
        
        nodeEls.forEach(nodeEl => {
            const inner = nodeEl.querySelector('[data-testid="node-inner-wrapper"]') || nodeEl;
            inner.style.removeProperty('background');
            inner.style.removeProperty('background-color');
            inner.style.removeProperty('--component-node-background');
            inner.style.removeProperty('--component-node-header');

            // 只清理主题改过的背景层，不清空视频、文本框等自定义控件的背景。
            const body = nodeEl.querySelector('[data-testid*="body"], .comfy-body, .comfy-content, .node-body, .content');
            body?.style.removeProperty('background');
            body?.style.removeProperty('background-color');

            const headerSelectors = [
                '[data-testid*="header"]', '.comfy-header', '.comfy-title', 
                '.node-header', '.node-title', '.litegraph .title',
                '.node-titlebar', '.title-bar', '.litemenu-title'
            ];
            const header = nodeEl.querySelector(headerSelectors.join(', '));
            if (header) {
                header.style.removeProperty('background');
                header.style.removeProperty('background-color');
                header.style.removeProperty('color');
                header.style.removeProperty('font-size');
                header.style.removeProperty('text-align');
                header.style.removeProperty('justify-content');
                const allChilds = header.querySelectorAll('*');
                allChilds.forEach(child => {
                    child.style.removeProperty('font-size');
                    child.style.removeProperty('text-align');
                    child.style.removeProperty('justify-content');
                    child.style.removeProperty('flex');
                });
            }
        });
    },

    getSelectedNodes() {
        if (!window.app || !app.canvas) return [];
        const canvas = app.canvas;
        if (canvas.selected_nodes) {
            const nodes = Object.values(canvas.selected_nodes);
            if (nodes.length > 0) return nodes;
        }
        return [];
    },

    getTopLeftNode(nodes) {
        if (!nodes || nodes.length === 0) return null;
        if (nodes.length === 1) return nodes[0];
        
        let topLeft = nodes[0];
        for (let i = 1; i < nodes.length; i++) {
            const node = nodes[i];
            const nodeY = node.pos ? node.pos[1] : 0;
            const topLeftY = topLeft.pos ? topLeft.pos[1] : 0;
            const nodeX = node.pos ? node.pos[0] : 0;
            const topLeftX = topLeft.pos ? topLeft.pos[0] : 0;
            
            if (nodeY < topLeftY) {
                topLeft = node;
            } else if (nodeY === topLeftY && nodeX < topLeftX) {
                topLeft = node;
            }
        }
        return topLeft;
    },

    getNodeGradient(node) {
        const cfg = this.getNodeGradientConfig(node);
        if (!cfg) return null;
        const useTitleGradient = cfg.useTitleGradient && cfg.titleStops && cfg.titleStops.length > 0;
        return {
            color1: cfg.stops[0]?.color || '#e65c5c',
            color2: cfg.stops[1]?.color || '#4fc94f',
            color3: cfg.stops[2]?.color || '#4d94e6',
            direction: cfg.direction || '90',
            titleColor1: useTitleGradient ? (cfg.titleStops[0]?.color || '#e49c00') : undefined,
            titleColor2: useTitleGradient ? (cfg.titleStops[1]?.color || '#000000') : undefined,
            titleColor3: useTitleGradient ? (cfg.titleStops[2]?.color || '#005149') : undefined,
            titleDirection: cfg.titleDirection || '90',
            useTitleGradient: useTitleGradient,
            titleText: cfg.titleText || '#ffffff',
            useGradient: cfg.useGradient !== false,
            fontSize: cfg.fontSize || 14,
            textAlign: cfg.textAlign || 'left'
        };
    },

    getNodeGradientConfig(node) {
        if (!node) return null;
        const cfg = node._xzgGradient || node.properties?._xzgGradient;
        if (cfg && !node._xzgGradient) node._xzgGradient = cfg;
        return cfg || null;
    },

    setupContextMenu() {
        const self = this;

        const checkShortcut = (e) => {
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) {
                return false;
            }
            const panel = window.XZGThemePanel;
            if (!panel) return false;
            const shortcut = panel.getShortcut();
            if (!shortcut || !shortcut.key) return false;
            const key = e.key.toLowerCase();
            if (key !== shortcut.key.toLowerCase()) return false;
            if (!!e.ctrlKey !== !!shortcut.ctrl) return false;
            if (!!e.altKey !== !!shortcut.alt) return false;
            if (!!e.shiftKey !== !!shortcut.shift) return false;
            if (!!e.metaKey !== !!shortcut.meta) return false;
            return true;
        };

        this._shortcutHandler = (e) => {
            if (checkShortcut(e)) {
                e.preventDefault();
                const panel = window.XZGThemePanel;
                if (panel && panel.isVisible) {
                    panel.hide();
                } else {
                    const nodes = self.getSelectedNodes();
                    if (nodes.length > 0) {
                        self.currentNodes = nodes;
                        self.showPanelForNodes(nodes);
                    } else {
                        self.showPanel();
                    }
                }
            }
        };
        document.addEventListener("keydown", this._shortcutHandler);

        if (window.XZGThemePanel) {
            window.XZGThemePanel.onThemeChange = (theme) => {
                const nodes = self.getSelectedNodes();
                if (nodes && nodes.length > 0) {
                    self.currentNodes = nodes;
                    const colors = {
                        color1: theme.colors.color1,
                        color2: theme.colors.color2,
                        color3: theme.colors.color3,
                        direction: theme.colors.direction,
                        titleColor1: theme.colors.titleColor1,
                        titleColor2: theme.colors.titleColor2,
                        titleColor3: theme.colors.titleColor3,
                        titleDirection: theme.colors.titleDirection,
                        useTitleGradient: theme.colors.useTitleGradient,
                        titleText: theme.colors.titleText,
                        useGradient: theme.colors.useGradient,
                        fontSize: theme.colors.fontSize,
                        textAlign: theme.colors.textAlign
                    };
                    self.applyThemeToNodes(nodes, colors);
                }
            };
            window.XZGThemePanel.onApply = (colors) => {
                const nodes = self.getSelectedNodes();
                if (nodes && nodes.length > 0) {
                    self.currentNodes = nodes;
                    const themeColors = {
                        color1: colors.color1,
                        color2: colors.color2,
                        color3: colors.color3,
                        direction: colors.direction,
                        titleColor1: colors.titleColor1,
                        titleColor2: colors.titleColor2,
                        titleColor3: colors.titleColor3,
                        titleDirection: colors.titleDirection,
                        useTitleGradient: colors.useTitleGradient,
                        titleText: colors.textColor,
                        useGradient: colors.useGradient,
                        fontSize: colors.fontSize,
                        textAlign: colors.textAlign
                    };
                    self.applyThemeToNodes(nodes, themeColors);
                }
            };
            window.XZGThemePanel.onReset = () => {
                const nodes = self.getSelectedNodes();
                if (nodes && nodes.length > 0) {
                    self.currentNodes = nodes;
                    self.removeThemeFromNodes(nodes);
                }
            };
        }

        this.setupSelectionListener();

        let refreshFrame = 0;
        const scheduleDOMGradients = () => {
            if (refreshFrame) return;
            refreshFrame = requestAnimationFrame(() => {
                refreshFrame = 0;
                self.refreshDOMGradients();
            });
        };
        const observer = new MutationObserver(scheduleDOMGradients);
        
        const graphCanvas = document.getElementById("graph-canvas");
        const graphRoot = graphCanvas?.parentElement || document.body;
        if (graphRoot) {
            observer.observe(graphRoot, {
                childList: true, 
                subtree: true 
            });
        }
        // 本模块未 import app，且 init 可能在 window.app 就绪前执行；
        // 裸 app 会 ReferenceError 并曾导致早期 init 整链夭折（高亮钩子装不上）。
        window.app?.ui?.settings?.addEventListener?.("Comfy.VueNodes.Enabled.change", scheduleDOMGradients);
        scheduleDOMGradients();
    },

    setupSelectionListener() {
        const self = this;
        let lastSelectedIds = new Set();

        function checkSelectionChange() {
            if (!window.XZGThemePanel || !window.XZGThemePanel.isVisible) {
                lastSelectedIds = new Set();
                return;
            }
            
            const nodes = self.getSelectedNodes();
            const currentIds = new Set(nodes.map(n => n.id));
            
            let changed = false;
            if (currentIds.size !== lastSelectedIds.size) {
                changed = true;
            } else if (currentIds.size > 0) {
                for (const id of currentIds) {
                    if (!lastSelectedIds.has(id)) {
                        changed = true;
                        break;
                    }
                }
            }
            
            if (changed && currentIds.size > 0) {
                lastSelectedIds = currentIds;
                self.currentNodes = nodes;
                const refNode = self.getTopLeftNode(nodes);
                if (refNode) {
                    self.updatePanelFromNode(refNode);
                }
            }
        }

        setInterval(checkSelectionChange, 200);
    },

    updatePanelFromNode(node) {
        if (!window.XZGThemePanel) return;
        
        const grad = this.getNodeGradient(node);
        if (grad) {
            window.XZGThemePanel.setCurrentTheme({
                colors: {
                    color1: grad.color1,
                    color2: grad.color2,
                    color3: grad.color3,
                    direction: grad.direction,
                    titleColor1: grad.titleColor1,
                    titleColor2: grad.titleColor2,
                    titleColor3: grad.titleColor3,
                    titleDirection: grad.titleDirection,
                    useTitleGradient: grad.useTitleGradient,
                    titleText: grad.titleText,
                    useGradient: grad.useGradient,
                    fontSize: grad.fontSize,
                    textAlign: grad.textAlign
                }
            });
        } else {
            window.XZGThemePanel.resetToDefault();
        }
    },

    refreshDOMGradients() {
        if (!window.app || !app.graph) return;
        const nodes = app.graph._nodes || app.graph.nodes;
        if (!nodes) return;
        nodes.forEach(node => {
            // 大字展示节点：每次重绘都主动清除可能残留的 DOM 主题样式，
            // 避免 observer、onAdded 等把不透明 DOM 渐变再盖到正文上。
            if (node.type === "XiaozhuguangBigDisplay") {
                this.removeGradientFromDOMNode(node);
                return;
            }
            if (node._xzgGradient) {
                this.applyGradientToDOMNode(node);
            }
        });
    },

    showPanelForNodes(nodes) {
        if (!window.XZGThemePanel) return;
        
        window.XZGThemePanel.create();
        
        if (nodes && nodes.length > 0) {
            this.currentNodes = nodes;
            const refNode = this.getTopLeftNode(nodes);
            if (refNode) {
                this.updatePanelFromNode(refNode);
            }
        }
        
        window.XZGThemePanel.show();
    },

    showPanel(x, y) {
        this.showPanelForNodes(this.currentNodes);
    },

    _initWallpaperDB() {
        const self = this;
        try {
            if (!window.indexedDB) {
                this._wpDBReady = true;
                return;
            }
            const request = indexedDB.open('XzgThemeWallpaper', 1);
            request.onupgradeneeded = function(e) {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('wallpapers')) {
                    db.createObjectStore('wallpapers', { keyPath: 'id' });
                }
            };
            request.onsuccess = function(e) {
                self._wpDB = e.target.result;
                self._wpDBReady = true;
                self._loadWallpaperFromDB();
                if (self._wpPendingSave) {
                    const pending = self._wpPendingSave;
                    self._wpPendingSave = null;
                    self._doSaveWallpaperToDB(pending.type, pending.data);
                }
            };
            request.onerror = function() {
                self._wpDBReady = true;
                console.warn('[小珠光主题] IndexedDB 打开失败，将使用 localStorage');
                if (self._wpPendingSave) {
                    const pending = self._wpPendingSave;
                    self._wpPendingSave = null;
                    try {
                        localStorage.setItem('xzg-wallpaper-data', pending.data);
                        localStorage.setItem('xzg-wallpaper-type', pending.type);
                    } catch(e) {
                        console.warn('[小珠光主题] 壁纸数据过大，无法保存到 localStorage', e);
                    }
                }
            };
        } catch(e) {
            this._wpDBReady = true;
            console.warn('[小珠光主题] IndexedDB 初始化失败', e);
        }
    },

    _loadWallpaperFromDB() {
        const self = this;
        if (!this._wpDB) return;

        try {
            const oldData = localStorage.getItem('xzg-wallpaper-data');
            if (oldData && oldData.length > 1000) {
                this._saveWallpaperToDB(this.wallpaperType, oldData);
                try { localStorage.removeItem('xzg-wallpaper-data'); } catch(e) {}
                if (this.wallpaperActive && app.canvas) {
                    this._setCanvasTransparent(true);
                    this._applyWallpaper();
                }
                return;
            }
        } catch(e) {}

        try {
            const transaction = this._wpDB.transaction(['wallpapers'], 'readonly');
            const store = transaction.objectStore('wallpapers');
            const request = store.get('current');
            request.onsuccess = function(e) {
                const result = e.target.result;
                if (result && result.data) {
                    self.wallpaperData = result.data;
                    if (result.type) {
                        self.wallpaperType = result.type;
                        try { localStorage.setItem('xzg-wallpaper-type', result.type); } catch(e) {}
                    }
                    const applyWhenReady = () => {
                        if (!app.canvas) {
                            setTimeout(applyWhenReady, 50);
                            return;
                        }
                        if (self.wallpaperActive && self.wallpaperData) {
                            if (!self._wpBgCanvas) {
                                self._createBgCanvas();
                            }
                            if (!self._wpHooked) {
                                self._hookRenderBackground();
                            }
                            self._setCanvasTransparent(true);
                            self._applyWallpaper();
                        }
                    };
                    applyWhenReady();
                }
            };
        } catch(e) {
            console.warn('[小珠光主题] 从 IndexedDB 读取壁纸失败', e);
        }
    },

    _saveWallpaperToDB(type, data) {
        if (!this._wpDBReady) {
            this._wpPendingSave = { type: type, data: data };
            return true;
        }
        if (!this._wpDB) return false;
        return this._doSaveWallpaperToDB(type, data);
    },

    _doSaveWallpaperToDB(type, data) {
        if (!this._wpDB) return false;
        const self = this;
        try {
            const transaction = this._wpDB.transaction(['wallpapers'], 'readwrite');
            const store = transaction.objectStore('wallpapers');
            const request = store.put({ id: 'current', type: type, data: data });
            transaction.oncomplete = function() {
                try { localStorage.removeItem('xzg-wallpaper-data'); } catch(e) {}
            };
            transaction.onerror = function(e) {
                console.warn('[小珠光主题] 保存壁纸到 IndexedDB 失败', e);
                try {
                    localStorage.setItem('xzg-wallpaper-data', data);
                    localStorage.setItem('xzg-wallpaper-type', type);
                } catch(e2) {
                    console.warn('[小珠光主题] 壁纸数据过大，无法保存', e2);
                }
            };
            return true;
        } catch(e) {
            console.warn('[小珠光主题] 保存壁纸到 IndexedDB 异常', e);
            return false;
        }
    },

    _deleteWallpaperFromDB() {
        if (!this._wpDB) {
            this._wpPendingSave = null;
            return;
        }
        try {
            const transaction = this._wpDB.transaction(['wallpapers'], 'readwrite');
            const store = transaction.objectStore('wallpapers');
            store.delete('current');
        } catch(e) {}
    },

    initWallpaper() {
        const self = this;
        const tryInit = () => {
            if (!window.app || !app.canvas) {
                setTimeout(tryInit, 100);
                return;
            }
            self._createBgCanvas();
            self._hookRenderBackground();
            if (self.wallpaperActive && self.wallpaperData) {
                self._setCanvasTransparent(true);
                self._applyWallpaper();
            }
        };
        tryInit();
    },

    _createBgCanvas() {
        if (this._wpBgCanvas) return;
        const canvasEl = app.canvas.canvas;
        if (!canvasEl) return;

        const bgCanvas = document.createElement('canvas');
        bgCanvas.id = 'xzg-wallpaper-canvas';
        bgCanvas.style.position = 'absolute';
        bgCanvas.style.left = '0';
        bgCanvas.style.top = '0';
        bgCanvas.style.zIndex = '0';
        bgCanvas.style.pointerEvents = 'none';

        const parent = canvasEl.parentElement;
        if (parent) {
            parent.insertBefore(bgCanvas, canvasEl);
        }

        this._wpBgCanvas = bgCanvas;
        this._wpBgCtx = bgCanvas.getContext('2d');

        const resizeBgCanvas = () => {
            if (!this._wpBgCanvas) return;
            const rect = canvasEl.getBoundingClientRect();
            this._wpBgCanvas.width = canvasEl.width;
            this._wpBgCanvas.height = canvasEl.height;
            this._wpBgCanvas.style.width = canvasEl.style.width || rect.width + 'px';
            this._wpBgCanvas.style.height = canvasEl.style.height || rect.height + 'px';
            this._wpDrawCache = null;
            if (this.wallpaperActive && this.wallpaperData) {
                this._renderWallpaperToBgCanvas();
            }
        };

        resizeBgCanvas();
        const ro = new ResizeObserver(resizeBgCanvas);
        ro.observe(canvasEl);
        this._wpResizeObserver = ro;
    },

    _hookRenderBackground() {
        if (this._wpHooked) return;
        if (!app.canvas) return;

        const canvas = app.canvas;
        const self = this;
        const origCallback = canvas.onRenderBackground;

        canvas.onRenderBackground = function(cvs, ctx) {
            if (origCallback) {
                const result = origCallback.call(this, cvs, ctx);
                if (result) return true;
            }

            if (self.wallpaperActive && self.wallpaperData) {
                return true;
            }

            return false;
        };

        this._wpOrigOnRenderBackground = origCallback;
        this._wpHooked = true;
        console.log('[小珠光主题] 壁纸背景 Hook 已安装 ✓');
    },

    _drawMediaBackground(cvs, ctx, media) {
        const w = cvs.width;
        const h = cvs.height;
        const mediaW = media.naturalWidth || media.videoWidth || 0;
        const mediaH = media.naturalHeight || media.videoHeight || 0;
        if (!mediaW || !mediaH) return;

        const cacheKey = w + '_' + h + '_' + mediaW + '_' + mediaH + '_' + this.wallpaperFit + '_' + this.wallpaperOpacity;
        if (this._wpDrawCache && this._wpDrawCache.key === cacheKey) {
            const c = this._wpDrawCache;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(c.bgCanvas, 0, 0);
            ctx.save();
            ctx.globalAlpha = this.wallpaperOpacity;
            ctx.drawImage(media, c.dx, c.dy, c.dw, c.dh);
            ctx.restore();
            ctx.restore();
            return;
        }

        const fit = this.wallpaperFit || 'cover';
        let dx = 0, dy = 0, dw = w, dh = h;

        if (fit === 'cover') {
            const scale = Math.max(w / mediaW, h / mediaH);
            dw = mediaW * scale;
            dh = mediaH * scale;
            dx = (w - dw) / 2;
            dy = (h - dh) / 2;
        } else if (fit === 'contain') {
            const scale = Math.min(w / mediaW, h / mediaH);
            dw = mediaW * scale;
            dh = mediaH * scale;
            dx = (w - dw) / 2;
            dy = (h - dh) / 2;
        } else if (fit === 'fill') {
            dw = w;
            dh = h;
        }

        if (!this._wpDrawCache) {
            this._wpDrawCache = {};
        }
        this._wpDrawCache.key = cacheKey;
        this._wpDrawCache.dx = dx;
        this._wpDrawCache.dy = dy;
        this._wpDrawCache.dw = dw;
        this._wpDrawCache.dh = dh;
        if (!this._wpDrawCache.bgCanvas) {
            this._wpDrawCache.bgCanvas = document.createElement('canvas');
        }
        const bgCanvas = this._wpDrawCache.bgCanvas;
        bgCanvas.width = w;
        bgCanvas.height = h;
        const bgCtx = bgCanvas.getContext('2d');
        bgCtx.fillStyle = '#000000';
        bgCtx.fillRect(0, 0, w, h);

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(bgCanvas, 0, 0);
        ctx.save();
        ctx.globalAlpha = this.wallpaperOpacity;
        ctx.drawImage(media, dx, dy, dw, dh);
        ctx.restore();
        ctx.restore();
    },

    _renderWallpaperToBgCanvas() {
        if (!this._wpBgCanvas || !this._wpBgCtx) return;
        if (!this.wallpaperActive || !this.wallpaperData) return;

        const bgCanvas = this._wpBgCanvas;
        const bgCtx = this._wpBgCtx;
        const w = bgCanvas.width;
        const h = bgCanvas.height;

        if (this.wallpaperType === 'image' && this._wpImg && this._wpImgLoaded) {
            this._drawMediaToCtx(bgCanvas, bgCtx, this._wpImg);
        } else if (this.wallpaperType === 'video' && this._wpVideo && this._wpVideo.readyState >= 2) {
            this._drawMediaToCtx(bgCanvas, bgCtx, this._wpVideo);
        } else {
            bgCtx.fillStyle = '#000000';
            bgCtx.fillRect(0, 0, w, h);
        }
    },

    _drawMediaToCtx(cvs, ctx, media) {
        const w = cvs.width;
        const h = cvs.height;
        const mediaW = media.naturalWidth || media.videoWidth || 0;
        const mediaH = media.naturalHeight || media.videoHeight || 0;
        if (!mediaW || !mediaH) return;

        const cacheKey = 'bg_' + w + '_' + h + '_' + mediaW + '_' + mediaH + '_' + this.wallpaperFit + '_' + this.wallpaperOpacity;
        if (this._wpBgDrawCache && this._wpBgDrawCache.key === cacheKey) {
            const c = this._wpBgDrawCache;
            ctx.drawImage(c.bgCanvas, 0, 0);
            ctx.globalAlpha = this.wallpaperOpacity;
            ctx.drawImage(media, c.dx, c.dy, c.dw, c.dh);
            ctx.globalAlpha = 1;
            return;
        }

        const fit = this.wallpaperFit || 'cover';
        let dx = 0, dy = 0, dw = w, dh = h;

        if (fit === 'cover') {
            const scale = Math.max(w / mediaW, h / mediaH);
            dw = mediaW * scale;
            dh = mediaH * scale;
            dx = (w - dw) / 2;
            dy = (h - dh) / 2;
        } else if (fit === 'contain') {
            const scale = Math.min(w / mediaW, h / mediaH);
            dw = mediaW * scale;
            dh = mediaH * scale;
            dx = (w - dw) / 2;
            dy = (h - dh) / 2;
        } else if (fit === 'fill') {
            dw = w;
            dh = h;
        }

        if (!this._wpBgDrawCache) {
            this._wpBgDrawCache = {};
        }
        this._wpBgDrawCache.key = cacheKey;
        this._wpBgDrawCache.dx = dx;
        this._wpBgDrawCache.dy = dy;
        this._wpBgDrawCache.dw = dw;
        this._wpBgDrawCache.dh = dh;
        if (!this._wpBgDrawCache.bgCanvas) {
            this._wpBgDrawCache.bgCanvas = document.createElement('canvas');
        }
        const blackCanvas = this._wpBgDrawCache.bgCanvas;
        blackCanvas.width = w;
        blackCanvas.height = h;
        const blackCtx = blackCanvas.getContext('2d');
        blackCtx.fillStyle = '#000000';
        blackCtx.fillRect(0, 0, w, h);

        ctx.drawImage(blackCanvas, 0, 0);
        ctx.globalAlpha = this.wallpaperOpacity;
        ctx.drawImage(media, dx, dy, dw, dh);
        ctx.globalAlpha = 1;
    },

    _applyWallpaper() {
        if (!this.wallpaperActive || !this.wallpaperData) return;
        if (!this._wpHooked) {
            this._hookRenderBackground();
        }
        if (!this._wpBgCanvas) {
            this._createBgCanvas();
        }

        if (this.wallpaperType === 'image') {
            if (!this._wpImg) {
                this._wpImg = new Image();
                const self = this;
                this._wpImg.onload = function() {
                    self._wpImgLoaded = true;
                    self._renderWallpaperToBgCanvas();
                    if (app.canvas?.setDirty) {
                        app.canvas.setDirty(true, true);
                    }
                };
            }
            this._wpImg.src = this.wallpaperData;
            this._wpImgLoaded = false;
        } else if (this.wallpaperType === 'video') {
            this._startVideoWallpaper();
        }

        if (app.canvas?.setDirty) {
            app.canvas.setDirty(true, true);
        }
    },

    _startVideoWallpaper() {
        if (!app.canvas) return;
        const self = this;

        if (!this._wpVideo) {
            this._wpVideo = document.createElement('video');
            this._wpVideo.muted = true;
            this._wpVideo.loop = true;
            this._wpVideo.playsInline = true;
            this._wpVideo.style.display = 'none';
            document.body.appendChild(this._wpVideo);

            this._wpVideo.addEventListener('loadeddata', function() {
                if (self.wallpaperActive && self.wallpaperType === 'video') {
                    self._renderWallpaperToBgCanvas();
                    if (app.canvas?.setDirty) {
                        app.canvas.setDirty(true, true);
                    }
                }
            });

            document.addEventListener('visibilitychange', () => {
                if (!self._wpVideoPlaying) return;
                if (document.hidden) {
                    self._wpVideo.pause();
                } else {
                    self._wpVideo.play().catch(() => {});
                }
            });
        }

        if (this._wpVideoSrc === this.wallpaperData && this._wpVideoPlaying) {
            return;
        }

        this._wpVideoSrc = this.wallpaperData;
        this._wpVideo.src = this.wallpaperData;
        this._wpVideo.load();
        this._wpVideo.play().then(() => {
            self._wpVideoPlaying = true;
            self._wpVideoFrame();
        }).catch(() => {
            self._wpVideoPlaying = false;
        });
    },

    _wpVideoFrame() {
        if (!this.wallpaperActive || !this._wpVideoPlaying || !this._wpVideo) return;
        if (this.wallpaperType !== 'video') return;

        const now = performance.now();
        const minInterval = 1000 / 30;
        if (this._wpLastFrameTime && (now - this._wpLastFrameTime) < minInterval) {
            const self = this;
            requestAnimationFrame(() => self._wpVideoFrame());
            return;
        }
        this._wpLastFrameTime = now;

        this._renderWallpaperToBgCanvas();

        const video = this._wpVideo;
        if (video.requestVideoFrameCallback) {
            video.requestVideoFrameCallback(() => this._wpVideoFrame());
        } else {
            requestAnimationFrame(() => this._wpVideoFrame());
        }
    },

    setWallpaperActive(active) {
        this.wallpaperActive = active;
        try {
            localStorage.setItem('xzg-wallpaper-active', active ? 'true' : 'false');
        } catch(e) {}

        if (active && this.wallpaperData) {
            this._applyWallpaper();
            this._setCanvasTransparent(true);
        } else if (!active) {
            if (this._wpVideo) {
                this._wpVideo.pause();
                this._wpVideoPlaying = false;
            }
            this._wpImgLoaded = false;
            this._setCanvasTransparent(false);
        }

        if (app.canvas?.setDirty) {
            app.canvas.setDirty(true, true);
        }
        this._queueThemeCloudSave();
    },

    _setCanvasTransparent(transparent) {
        if (!app.canvas) return;
        const canvasEl = app.canvas.canvas;
        if (!canvasEl) return;

        if (transparent) {
            if (app.canvas.clear_color) {
                this._wpOrigClearColor = app.canvas.clear_color;
            }
            app.canvas.clear_color = 'transparent';
            if (app.canvas.bg_color) {
                this._wpOrigBgColor = app.canvas.bg_color;
            }
            app.canvas.bg_color = 'transparent';
            canvasEl.style.backgroundColor = 'transparent';
        } else {
            if (this._wpOrigClearColor !== undefined) {
                app.canvas.clear_color = this._wpOrigClearColor;
            }
            if (this._wpOrigBgColor !== undefined) {
                app.canvas.bg_color = this._wpOrigBgColor;
            }
            canvasEl.style.backgroundColor = '';
        }
    },

    setWallpaperData(type, data) {
        this.wallpaperType = type;
        this.wallpaperData = data;
        this._wpBgDrawCache = null;
        try {
            localStorage.setItem('xzg-wallpaper-type', type);
        } catch(e) {}
        const savedToDB = this._saveWallpaperToDB(type, data);
        if (!savedToDB) {
            try {
                localStorage.setItem('xzg-wallpaper-data', data);
            } catch(e) {
                console.warn('[小珠光主题] 壁纸数据过大，无法保存', e);
            }
        }
        if (!this.wallpaperActive) {
            this.setWallpaperActive(true);
        } else {
            this._applyWallpaper();
        }
        this._queueThemeCloudSave();
    },

    setWallpaperOpacity(opacity) {
        this.wallpaperOpacity = opacity;
        this._wpBgDrawCache = null;
        try {
            localStorage.setItem('xzg-wallpaper-opacity', String(opacity));
        } catch(e) {}
        this._renderWallpaperToBgCanvas();
        if (app.canvas?.setDirty) {
            app.canvas.setDirty(true, true);
        }
        this._queueThemeCloudSave();
    },

    setWallpaperFit(fit) {
        this.wallpaperFit = fit;
        this._wpBgDrawCache = null;
        try {
            localStorage.setItem('xzg-wallpaper-fit', fit);
        } catch(e) {}
        this._renderWallpaperToBgCanvas();
        if (app.canvas?.setDirty) {
            app.canvas.setDirty(true, true);
        }
        this._queueThemeCloudSave();
    },

    clearWallpaper() {
        this.wallpaperData = null;
        this.wallpaperActive = false;
        this._setCanvasTransparent(false);
        this._deleteWallpaperFromDB();
        try {
            localStorage.removeItem('xzg-wallpaper-data');
            localStorage.setItem('xzg-wallpaper-active', 'false');
        } catch(e) {}
        if (this._wpImg) {
            this._wpImg.src = '';
            this._wpImgLoaded = false;
        }
        if (this._wpVideo) {
            this._wpVideo.pause();
            this._wpVideo.src = '';
            this._wpVideoPlaying = false;
            this._wpVideoSrc = '';
        }
        this._wpBgDrawCache = null;
        if (this._wpBgCanvas && this._wpBgCtx) {
            this._wpBgCtx.clearRect(0, 0, this._wpBgCanvas.width, this._wpBgCanvas.height);
        }
        if (app.canvas?.setDirty) {
            app.canvas.setDirty(true, true);
        }
        this._queueThemeCloudSave();
    },

    waitForComfyUI() {
        return new Promise((resolve) => {
            const check = () => {
                if (window.app && window.app.graph && window.LiteGraph) {
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }
};

(function initThemeWhenReady() {
    if (window.XZGThemePresets && window.XZGThemePanel) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => {
                window.XZGThemeManager.init();
            });
        } else {
            window.XZGThemeManager.init();
        }
    } else {
        setTimeout(initThemeWhenReady, 50);
    }
})();

(function registerExtensionEarly() {
    function tryRegister() {
        if (window.app && typeof window.app.registerExtension === "function") {
            try {
                app.registerExtension({
                    name: "XZG.Theme",
                    loadedGraphNode(node) {
                        const manager = window.XZGThemeManager;
                        const gradient = manager.getNodeGradientConfig(node);
                        if (gradient) {
                            node._xzgGradient = JSON.parse(JSON.stringify(gradient));
                            if (!globalThis.LiteGraph?.vueNodesMode) manager.ensureLegacyGradientHook();
                        }
                    },
                    afterConfigureGraph() {
                        const manager = window.XZGThemeManager;
                        const nodes = app.graph?._nodes || app.graph?.nodes || [];
                        nodes.forEach(node => {
                            const gradient = manager.getNodeGradientConfig(node);
                            if (gradient) node._xzgGradient = JSON.parse(JSON.stringify(gradient));
                        });
                        if (globalThis.LiteGraph?.vueNodesMode) manager.refreshDOMGradients();
                        else manager.ensureLegacyGradientHook();
                        manager.setupLinkHighlight();
                        app.graph?.setDirtyCanvas?.(true, true);
                        app.canvas?.setDirty?.(true, true);
                        requestAnimationFrame(() => {
                            if (globalThis.LiteGraph?.vueNodesMode) manager.refreshDOMGradients();
                            else manager.ensureLegacyGradientHook();
                            manager.setupLinkHighlight();
                            app.graph?.setDirtyCanvas?.(true, true);
                            app.canvas?.setDirty?.(true, true);
                        });
                    },
                });
            } catch(e) {}
        } else {
            setTimeout(tryRegister, 100);
        }
    }
    tryRegister();
})();
// 云同步统一入口：供主题面板“导入配置”后一键推送全部云化设置
window.__xzgCloudPush = window.__xzgCloudPush || {};
window.__xzgCloudPush.theme = () => { try { window.XZGThemeManager?._queueThemeCloudSave?.(); } catch (e) {} };
