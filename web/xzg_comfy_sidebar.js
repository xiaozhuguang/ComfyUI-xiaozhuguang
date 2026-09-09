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
                // 回写后更新指纹，避免本模块自己触发一次无谓上云
                _lastFingerprint = fingerprint(collectSidebarKeys());
                // 官方 Splitter 初始化早于云回写（读的是旧宽度），不会自动重排；
                // 同会话内自动刷新一次，让官方组件按云端宽度重建（sessionStorage 标记防循环）
                if (document.readyState === "complete" && !sessionStorage.getItem("xzg_sidebar_reloaded")) {
                    sessionStorage.setItem("xzg_sidebar_reloaded", "1");
                    setTimeout(() => location.reload(), 300);
                }
                return;
            }
        }
        // 服务端暂无：把本地相关键首次推上云
        maybePushSidebar();
    } catch (e) {
        console.warn("[小珠光] 从云同步系统侧边栏宽度失败:", e);
    }
}

// 模块加载即拉取（尽早回写，赶在官方 Splitter 初始化前写回本地）
cloudRestoreSidebar();

// 事件驱动 + 兜底：拖动 splitter 松手 / 窗口失焦 / 每 60s 定时检测，变化即防抖上云
document.addEventListener("mouseup", maybePushSidebar, true);
window.addEventListener("blur", maybePushSidebar);
setInterval(maybePushSidebar, 60000);
