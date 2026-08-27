/**
 * 小珠光 · 云存储
 *
 * 云平台（晨羽等）浏览器 localStorage 无法跨会话持久化（刷新/换设备即丢）。
 * 这里把数据优先存到服务端（ComfyUI 用户目录磁盘），localStorage 仅做离线兜底。
 *
 * 用法：
 *   const data = await cloudLoad("some_key", { fallbackValue: null });
 *   cloudSave("some_key", data);   // 内部防抖 + 失败静默（回落 localStorage）
 */
import { api } from "../../scripts/api.js";

// 防止同一 key 并发拉取多次
const _pending = new Map();

function localGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}
function localSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) {}
}

async function _fetchJson(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
}

/**
 * 从云端加载某个 key 的 JSON 数据。
 * 优先级：服务端 > 本地 localStorage > fallbackValue。
 * 服务端有数据时会把服务端数据回写本地；服务端没有但有本地数据时，会把本地数据推送到服务端。
 */
export function cloudLoad(key, { fallbackValue = null } = {}) {
    let loc = null;
    const locStr = localGet(key);
    if (locStr != null) {
        try { loc = JSON.parse(locStr); } catch (e) { loc = null; }
    }

    if (_pending.has(key)) {
        const p = _pending.get(key);
        return p.catch(() => loc ?? fallbackValue);
    }

    const p = (async () => {
        const url = api.apiURL("/xzg_cloud_store?key=" + encodeURIComponent(key));
        try {
            const r = await _fetchJson(url);
            if (r && r.found && r.data != null) {
                localSet(key, JSON.stringify(r.data)); // 服务端为准，回写本地兜底
                return r.data;
            }
            // 服务端暂无：把本地数据推上去，实现首次上云
            if (loc != null) {
                cloudSave(key, loc).catch(() => {});
                return loc;
            }
            return fallbackValue;
        } catch (e) {
            // 服务端不可用（离线/云平台没挂上）：回退本地
            return loc ?? fallbackValue;
        }
    })();

    _pending.set(key, p);
    const finish = () => _pending.delete(key);
    p.then(finish, finish);
    return p;
}

/**
 * 保存某个 key 的 JSON 数据到服务端，并同时写入本地做兜底。
 * 返回 Promise，服务端失败会被吞掉（数据仍保留在 localStorage）。
 */
export function cloudSave(key, data) {
    localSet(key, JSON.stringify(data)); // 本地总是先写，兜底
    const url = api.apiURL("/xzg_cloud_store");
    return _fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, data }),
    }).catch(() => { /* 服务端失败则依赖 localStorage */ });
}

// ----------------------------------------------------------------------------
// 面板几何 UI 态（收藏面板位置/尺寸、工作流左侧栏宽度）云持久化
//
// 背景：面板位置/尺寸之前只写各自的 localStorage 键（xiaozhuguang.* 、xzg_*），
// 未纳入收藏/工作流 JSON，云平台上刷新/换分配即丢。这里把它们集中收集到
// 服务端一个键 xzg_ui_state 下，localStorage 的原始键仍作为本地兜底。
// ----------------------------------------------------------------------------
const UI_KEY = "xzg_ui_state";
// 需要云持久化的面板几何键（节点收藏器 + 工作流管理器）
const UI_GEOMETRY_KEYS = [
    "xiaozhuguang.PanelPos",
    "xiaozhuguang.PanelWidth",
    "xiaozhuguang.PanelHeight",
    "xiaozhuguang.SplitWidth",
    "xzg_wf_left_col_width",
];

let _uiInit = null;

/** 拉取云端面板几何态并写入对应 localStorage 键（云优先）。首次上云时把本地几何推上去。返回 Promise。 */
export function cloudUIInit() {
    if (_uiInit) return _uiInit;
    _uiInit = (async () => {
        try {
            const url = api.apiURL("/xzg_cloud_store?key=" + encodeURIComponent(UI_KEY));
            const r = await _fetchJson(url);
            const remote = (r && r.found && r.data && typeof r.data === "object") ? r.data : null;
            if (remote) {
                let wrote = false;
                for (const k of UI_GEOMETRY_KEYS) {
                    if (Object.prototype.hasOwnProperty.call(remote, k) && remote[k] !== undefined) {
                        const v = remote[k];
                        localSet(k, typeof v === "object" ? JSON.stringify(v) : String(v));
                        wrote = true;
                    }
                }
                // 云端为空则把本地首次上云
                if (!wrote) pushGeometryToCloud();
            } else {
                pushGeometryToCloud();
            }
        } catch (e) {
            // 服务端不可用：保留本地
        }
    })();
    return _uiInit;
}

function readGeometryMap() {
    const map = {};
    for (const k of UI_GEOMETRY_KEYS) {
        const v = localGet(k);
        if (v != null) map[k] = v;
    }
    return map;
}

function pushGeometryToCloud() {
    const map = readGeometryMap();
    if (Object.keys(map).length) cloudSave(UI_KEY, map).catch(() => {});
}

let _uiTimer = null;

/** 在某个面板几何键写完后调用：收集全部几何键推送到云端（防抖）。 */
export function cloudUIQueueGeometry() {
    if (_uiTimer) clearTimeout(_uiTimer);
    _uiTimer = setTimeout(() => {
        _uiTimer = null;
        pushGeometryToCloud();
    }, 400);
}