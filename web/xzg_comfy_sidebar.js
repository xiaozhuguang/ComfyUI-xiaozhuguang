import { cloudLoad, cloudSave } from "./xzg_cloud_store.js";

// ============================================================================
// ComfyUI 系统侧边栏（Node Library 等弹出面板）宽度云持久化
//
// 官方前端把可拖拽面板宽度存进 localStorage（PrimeVue Splitter 的 state-key，
// 常见键名：unified-sidebar* / builder-splitter* / default-sidebar* / Comfy.Menu.Width 等，
// 且随版本与「统一侧边栏宽度 / 侧边栏位置」设置变化，键名不固定）。
// 这里动态匹配所有相关键，整体收集到一个云键，实现跨会话 / 跨浏览器持久化：
//   本地兜底 → 异步 cloudLoad 以服务端为准回写 → 拖动松手 / 失焦 / 定时检测变化后防抖上云。
// ============================================================================

const COMFY_SIDEBAR_STATE_KEY = "xzg_comfy_sidebar_state";

let _sidebarTimer = null;
let _lastFingerprint = null;

function isSidebarKey(k) {
    if (k === COMFY_SIDEBAR_STATE_KEY) return false; // 排除云键自身，避免自嵌套
    const low = k.toLowerCase();
    return low.includes("sidebar") || low.includes("splitter") || low.startsWith("comfy.menu");
}

function collectSidebarKeys() {
    const map = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k) continue;
            if (isSidebarKey(k)) {
                const v = localStorage.getItem(k);
                if (v !== null) map[k] = v;
            }
        }
    } catch (e) {}
    return map;
}

function fingerprint(map) {
    try { return JSON.stringify(map); } catch (e) { return ""; }
}

/** 检测到侧边栏相关键变化时防抖上云（500ms 合并连续拖动） */
function maybePushSidebar() {
    const map = collectSidebarKeys();
    const fp = fingerprint(map);
    if (fp === _lastFingerprint) return;
    _lastFingerprint = fp;
    if (_sidebarTimer) clearTimeout(_sidebarTimer);
    _sidebarTimer = setTimeout(() => {
        _sidebarTimer = null;
        cloudSave(COMFY_SIDEBAR_STATE_KEY, map).catch(() => {});
    }, 500);
}

/** 把本地聚合键 xzg_comfy_sidebar_state 展开写回官方裸键（导入 / 云端缓存落地后使用），返回是否发生变更 */
function expandCloudKeyToLocal() {
    const raw = localStorage.getItem(COMFY_SIDEBAR_STATE_KEY);
    if (!raw) return false;
    let obj = null;
    try { obj = JSON.parse(raw); } catch (e) { return false; }
    if (!obj || typeof obj !== "object") return false;
    let changed = false;
    for (const k in obj) {
        if (typeof obj[k] === "string" && isSidebarKey(k)) {
            if (localStorage.getItem(k) !== obj[k]) {
                try { localStorage.setItem(k, obj[k]); changed = true; } catch (e) {}
            }
        }
    }
    return changed;
}

/** 侧边栏数据被外部改变（云回写 / 导入）后，同会话自动刷新一次让官方 Splitter 按新宽度重建（防循环） */
function requestSidebarReloadOnce() {
    if (document.readyState === "complete" && !sessionStorage.getItem("xzg_sidebar_reloaded")) {
        sessionStorage.setItem("xzg_sidebar_reloaded", "1");
        setTimeout(() => location.reload(), 300);
        return true;
    }
    return false;
}

async function cloudRestoreSidebar() {
    try {
        const s = await cloudLoad(COMFY_SIDEBAR_STATE_KEY, { fallbackValue: null });
        if (s && typeof s === "object" && Object.keys(s).length) {
            let changed = false;
            for (const k in s) {
                if (typeof s[k] === "string" && isSidebarKey(k)) {
                    if (localStorage.getItem(k) !== s[k]) {
                        try { localStorage.setItem(k, s[k]); changed = true; } catch (e) {}
                    }
                }
            }
            if (changed) {
                // 回写后更新指纹，避免本模块自己触发一次无谓上云；
                // 不自动刷新：Splitter 未初始化会直接读新值，已初始化则本地已就位、下次刷新自然生效，
                // 避免打开页面/切换工作流时被强制重载打断
                _lastFingerprint = fingerprint(collectSidebarKeys());
                return;
            }
        }
        // 服务端暂无：把本地相关键首次推上云
        maybePushSidebar();
    } catch (e) {
        console.warn("[小珠光] 从云同步系统侧边栏宽度失败:", e);
    }
}

// 模块加载：先展开本地聚合键到官方裸键（覆盖「导入后刷新」/「换设备本地已有云端缓存」场景），
// 再异步拉云（cloudLoad 回写裸键；Splitter 未初始化则直接生效，已初始化则本地就位下次自然生效）
if (expandCloudKeyToLocal()) {
    _lastFingerprint = fingerprint(collectSidebarKeys());
}
cloudRestoreSidebar();

/** 定时兜底：聚合键展开 + 变化检测上云（覆盖导入后 60s 内的补同步；展开不触发刷新） */
function periodicSidebarCheck() {
    if (expandCloudKeyToLocal()) {
        _lastFingerprint = fingerprint(collectSidebarKeys());
    }
    maybePushSidebar();
}

// 事件驱动 + 兜底：拖动 splitter 松手 / 窗口失焦 / 每 60s 定时检测，变化即防抖上云
document.addEventListener("mouseup", maybePushSidebar, true);
window.addEventListener("blur", maybePushSidebar);
setInterval(periodicSidebarCheck, 60000);

/** 页面关闭/刷新前同步推送最新宽度（sendBeacon keepalive），
 *  兜住防抖窗口内被刷新/切换打断的最后一次拖动，保证下次打开恢复的是用户最后拖动的宽度 */
function pushSidebarSync() {
    try {
        const map = collectSidebarKeys();
        // 同步更新本地聚合键：刷新后模块加载 expand 会以聚合键为准展开裸键，
        // 若不更新，聚合键仍是旧值，会把用户最后拖动的宽度覆盖成旧云端值（表现为「固定宽度」）
        try { localStorage.setItem(COMFY_SIDEBAR_STATE_KEY, JSON.stringify(map)); } catch (e) {}
        const body = JSON.stringify({ key: COMFY_SIDEBAR_STATE_KEY, data: map });
        if (navigator.sendBeacon) {
            navigator.sendBeacon("/xzg_cloud_store", new Blob([body], { type: "application/json" }));
        } else {
            const x = new XMLHttpRequest();
            x.open("POST", "/xzg_cloud_store", false);
            x.setRequestHeader("Content-Type", "application/json");
            x.send(body);
        }
    } catch (e) {}
}
window.addEventListener("pagehide", pushSidebarSync);

// 导入配置后立即展开裸键并上云（importAllConfig includeXzg 分支末尾统一调用 __xzgCloudPush）
if (typeof window !== "undefined") {
    window.__xzgCloudPush = window.__xzgCloudPush || {};
    window.__xzgCloudPush.comfySidebar = () => {
        if (expandCloudKeyToLocal()) {
            _lastFingerprint = fingerprint(collectSidebarKeys());
            // 用户主动导入属新动作：清除防循环标记，允许再次自动刷新应用新宽度
            try { sessionStorage.removeItem("xzg_sidebar_reloaded"); } catch (e) {}
            // 先立即上云（把导入值覆盖到云端），等推送完成再刷新，
            // 避免刷新后 cloudLoad 被旧云端值覆盖导入结果
            cloudSave(COMFY_SIDEBAR_STATE_KEY, collectSidebarKeys())
                .catch(() => {})
                .finally(() => requestSidebarReloadOnce());
        } else {
            maybePushSidebar();
        }
    };
}
