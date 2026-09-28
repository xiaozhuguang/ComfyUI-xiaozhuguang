// 注意：本 ComfyUI 版本(0.33.3)扩展实际挂载在 /extensions/<节点目录名>/js/...，
// 故需 3 级 ../ 才能回到站点根目录 /scripts/app.js
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { cloudLoad, cloudSave } from "./xzg_cloud_store.js";
import { xzgT } from "./xzg_i18n.js";

/**
 * 悬浮窗系统监控（xiaozhuguang）
 * - 页面加载后自动在右下角（避开 ComfyUI 底部功能区）显示半透明、可拖拽的监控悬浮窗
 * - 每秒轮询 /xzg/system_monitor_stats 展示 GPU/CPU/内存状态
 * - 工作流运行计时：execution_start 开始计时，成功/出错/中断停止；显示工作流名称，
 *   支持历史记录查询（localStorage 持久化，最近 5 条，可清空）
 * - 工作流中添加 XZG_Monitor 节点后，其“显示悬浮窗”开关可控制本窗显示/隐藏
 * - 拖动位置持久记忆：localStorage 兜底 + 云端（<ComfyUI>/user/xiaozhuguang/，参考工作流管理云端持久化方案），
 *   只做位置（left/top/posVer）上云，显示项、运行历史、隐藏状态均不上云
 */

const XZG_API = "/xzg/system_monitor_stats";
const XZG_NODE_TYPE = "XiaozhuguangSystemMonitor";
// 小珠光设置：是否启用 GPU/CPU 监控（设置 → xiaozhuguang → 功能开关 可开关）
const SETTING_ENABLED = "xiaozhuguang.Toggle.EnableMonitor";
// 防重复加载：本插件在当前 ComfyUI 版本可能被重复挂载加载，
// 用全局标志保证只创建一个监控实例（浮窗 + 顶部按钮 + 设置注册），
// 否则设置开关只能控制其中一个实例。
const MONITOR_SINGLETON = "__xzgSystemMonitorActive";
const XZG_STORE_KEY = "xzg-float-state-v1";
// 位置方案版本号：改为「右下角默认」后升到 2，旧方案保存的位置被忽略
const XZG_POS_VER = 2;
// 悬浮窗位置云端持久化 key（参考工作流管理云端方案：服务端磁盘为准，localStorage 兜底；只做位置，其它状态不上云）
const XZG_CLOUD_POS_KEY = "xzg_float_pos";
let _cloudPosTimer = null; // 位置云端推送防抖计时器
let _cloudDisplayTimer = null;
let _posDragged = false;   // 本会话是否已手动拖动过位置（防止云端异步回写覆盖用户刚拖的位置）
const XZG_DISPLAY_KEY = "xzg-display-v1";
const MONITOR_METRICS = [
  { key: "gpu_temp", label: "GPU 温度", unit: "°C", color: (v) => pctColor(0, v), get: (d) => d?.gpu?.gpus?.[0]?.temp },
  { key: "gpu_util", label: "GPU 利用率", unit: "%", color: (v, d) => pctColor(v, d?.gpu?.gpus?.[0]?.temp), get: (d) => d?.gpu?.gpus?.[0]?.util },
  { key: "gpu_vram", label: "GPU 显存占用", unit: "G", color: "#6fb3ff", get: (d) => { const g = d?.gpu?.gpus?.[0]; return g ? g.vram_used_mb / 1024 : null; } },
  { key: "gpu_power", label: "GPU 功耗", unit: "W", color: "#ffd666", get: (d) => d?.gpu?.gpus?.[0]?.power_w },
  { key: "cpu_util", label: "CPU 使用率", unit: "%", color: (v, d) => pctColor(v, d?.cpu?.temp), get: (d) => d?.cpu?.util },
  { key: "cpu_temp", label: "CPU 温度", unit: "°C", color: (v) => pctColor(0, v), get: (d) => d?.cpu?.temp },
  { key: "mem_used", label: "内存占用", unit: "G", color: "#c99cff", get: (d) => d?.mem ? d.mem.used_mb / 1024 : null },
];
const XZG_DISPLAY_DEFAULT = {
  gpu_util: true,
  gpu_temp: true,
  gpu_vram: true,
  gpu_power: true,
  cpu_util: true,
  cpu_temp: true,
  mem_used: true,
  run_timer: true,
  hist_open: false,
  panel_bg: true,
  compact: true,
  metric: "gpu_temp",
  orb_size: 88,
  orb_font_size: 30,
  animation: "rainbow",
  capsule_palette: "classic",
};
let _display = loadDisplay();
let _menuEl = null; // 右键设置菜单

function loadDisplay() {
  try {
    const raw = localStorage.getItem(XZG_DISPLAY_KEY);
    const s = { ...XZG_DISPLAY_DEFAULT, ...(JSON.parse(raw || "{}")) };
    if (!MONITOR_METRICS.some((metric) => metric.key === s.metric)) s.metric = "gpu_temp";
    s.orb_size = Math.max(52, Math.min(180, Number(s.orb_size) || 88));
    s.orb_font_size = Math.max(14, Math.min(72, Number(s.orb_font_size) || 30));
    if (s.animation === "comet") s.animation = "scan";
    if (["stars", "nebula"].includes(s.animation)) s.animation = "blackhole";
    if (!["off", "rainbow", "pulse", "scan", "ripple", "blackhole"].includes(s.animation)) s.animation = "rainbow";
    if (!["classic", "ice", "aurora", "amber", "graphite"].includes(s.capsule_palette)) s.capsule_palette = "classic";
    s.compact = s.compact !== false;
    s.panel_bg = true; // 面板始终带底色，不再提供"不带底色"选项
    return s;
  } catch (e) {
    return { ...XZG_DISPLAY_DEFAULT, compact: true };
  }
}

function saveDisplay() {
  try {
    localStorage.setItem(XZG_DISPLAY_KEY, JSON.stringify(_display));
  } catch (e) {
    /* ignore */
  }
  if (_cloudDisplayTimer) clearTimeout(_cloudDisplayTimer);
  _cloudDisplayTimer = setTimeout(() => {
    _cloudDisplayTimer = null;
    cloudSave("xzg_monitor_display", _display).catch(() => {});
  }, 500);
}

function normalizeDisplay(value) {
  const next = { ...XZG_DISPLAY_DEFAULT, ...(value && typeof value === "object" ? value : {}) };
  if (!MONITOR_METRICS.some((metric) => metric.key === next.metric)) next.metric = "gpu_temp";
  next.orb_size = Math.max(52, Math.min(180, Number(next.orb_size) || 88));
  next.orb_font_size = Math.max(14, Math.min(72, Number(next.orb_font_size) || 30));
  if (next.animation === "comet") next.animation = "scan";
  if (["stars", "nebula"].includes(next.animation)) next.animation = "blackhole";
  if (!["off", "rainbow", "pulse", "scan", "ripple", "blackhole"].includes(next.animation)) next.animation = "rainbow";
  if (!["classic", "ice", "aurora", "amber", "graphite"].includes(next.capsule_palette)) next.capsule_palette = "classic";
  next.compact = next.compact !== false;
  return next;
}

async function restoreMonitorDisplay() {
  try {
    const remote = await cloudLoad("xzg_monitor_display", { fallbackValue: null });
    if (remote && typeof remote === "object") {
      _display = normalizeDisplay(remote);
      localStorage.setItem(XZG_DISPLAY_KEY, JSON.stringify(_display));
      if (_float) _float.rerender();
    } else {
      cloudSave("xzg_monitor_display", _display).catch(() => {});
    }
  } catch (_) { /* 云端不可用时沿用本地配置 */ }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortGpuName(name) {
  // 省去常见的厂商/系列前缀，如 "NVIDIA GeForce RTX 4090" -> "RTX 4090"
  return esc(name)
    .replace(/^NVIDIA\s+/i, "")
    .replace(/^GeForce\s+/i, "")
    .replace(/^Quadro\s+/i, "")
    .trim();
}

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(XZG_STORE_KEY) || "{}");
  } catch (e) {
    return {};
  }
}

function saveStore(store) {
  try {
    localStorage.setItem(XZG_STORE_KEY, JSON.stringify(store));
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 悬浮窗位置云端持久化（参考工作流管理的云端持久化方案：
// 服务端 <ComfyUI>/user/xiaozhuguang/ 磁盘为准，localStorage 仅做离线兜底）
// 只做「位置」（left/top/posVer）上云，显示项、运行历史、隐藏状态均不上云。
// 流程：本地兜底 → 异步 cloudLoad 以服务端为准回写 → 拖动松手防抖上云 + 页面关闭前 sendBeacon 兜底。
// ---------------------------------------------------------------------------

/** 从本地 store 提取位置部分；无有效位置时返回 null */
function collectFloatPos(store) {
  const s = store || loadStore();
  if (s.posVer !== XZG_POS_VER) return null;
  if (!s.left && !s.top) return null;
  return { left: s.left, top: s.top, posVer: XZG_POS_VER };
}

/** 把位置应用到浮窗 DOM（与本地记忆逻辑同语义） */
function applyPosStyle(root, left, top) {
  if (left) root.style.left = left;
  if (top) root.style.top = top;
  if (left || top) {
    root.style.right = "auto";
    root.style.bottom = "auto";
  }
}

/** 位置变化后防抖推送云端（拖动松手触发，合并连续拖动） */
function queueCloudSavePos() {
  if (_cloudPosTimer) clearTimeout(_cloudPosTimer);
  _cloudPosTimer = setTimeout(() => {
    _cloudPosTimer = null;
    const local = collectFloatPos(loadStore());
    if (local) cloudSave(XZG_CLOUD_POS_KEY, local).catch(() => {});
  }, 400);
}

/** 页面关闭/刷新前同步推送最新位置（sendBeacon keepalive），兜住防抖窗口内被打断的最后一次拖动 */
function pushFloatPosSync() {
  try {
    const local = collectFloatPos(loadStore());
    if (!local) return;
    const body = JSON.stringify({ key: XZG_CLOUD_POS_KEY, data: local });
    // 用 api.apiURL 拼接（云平台可能挂载在子路径下，硬编码根路径会 404 导致兜底推送失败）
    const storeUrl = api.apiURL("/xzg_cloud_store");
    if (navigator.sendBeacon) {
      navigator.sendBeacon(storeUrl, new Blob([body], { type: "application/json" }));
    } else {
      const x = new XMLHttpRequest();
      x.open("POST", storeUrl, false);
      x.setRequestHeader("Content-Type", "application/json");
      x.send(body);
    }
  } catch (e) { /* ignore */ }
}
window.addEventListener("pagehide", pushFloatPosSync);

/** 异步恢复云端位置：服务端有则应用并回写本地；服务端无但有本地则首次上云 */
async function cloudRestoreFloatPos(root) {
  try {
    const remote = await cloudLoad(XZG_CLOUD_POS_KEY, { fallbackValue: null });
    if (remote && typeof remote === "object" && remote.posVer === XZG_POS_VER &&
        (remote.left || remote.top)) {
      // 本会话已手动拖动过：以用户刚拖的位置为准（已由 queueCloudSavePos 推上云），跳过云端回写
      if (_posDragged) return;
      const store = loadStore();
      if (store.left !== remote.left || store.top !== remote.top || store.posVer !== XZG_POS_VER) {
        store.left = remote.left;
        store.top = remote.top;
        store.posVer = XZG_POS_VER;
        saveStore(store);
      }
      applyPosStyle(root, remote.left, remote.top);
    } else {
      // 服务端暂无：把本地位置首次上云
      const local = collectFloatPos(loadStore());
      if (local) cloudSave(XZG_CLOUD_POS_KEY, local).catch(() => {});
    }
  } catch (e) {
    // 服务端不可用：保留本地
  }
}

// ---------------------------------------------------------------------------
// UI 就绪门：刷新浏览器时前端有全屏加载遮罩（#splash-loader，z-index 9999），
// 而浮窗层级更高（99999），若立即创建会盖在遮罩上、先于整个主界面出现。
// 等前端移除该遮罩（主界面渲染完成）后再放行浮窗创建；
// 旧版前端无此遮罩时立即放行；15 秒超时兜底防异常卡死。
// ---------------------------------------------------------------------------

let _xzgUiReady = false;
const _xzgUiReadyWaiters = [];

function xzgMarkUiReady() {
  if (_xzgUiReady) return;
  _xzgUiReady = true;
  const waiters = _xzgUiReadyWaiters.splice(0);
  for (const cb of waiters) {
    try {
      cb();
    } catch (e) {
      console.warn("[小珠光] UI 就绪回调执行失败:", e);
    }
  }
}

function xzgWhenUiReady(cb) {
  if (_xzgUiReady) cb();
  else _xzgUiReadyWaiters.push(cb);
}

(function xzgWatchSplashGone() {
  const SPLASH_ID = "splash-loader";
  const TIMEOUT_MS = 15000;
  const startTs = Date.now();
  const timer = setInterval(() => {
    if (!document.getElementById(SPLASH_ID) || Date.now() - startTs > TIMEOUT_MS) {
      clearInterval(timer);
      xzgMarkUiReady();
    }
  }, 150);
})();

// ---------------------------------------------------------------------------
// 样式
// ---------------------------------------------------------------------------

const XZG_CSS = `
#xzg-float{position:fixed;right:16px;bottom:60px;z-index:1;width:166px;
  color:#e8e8e8;font:12px/1.5 'Segoe UI',system-ui,-apple-system,sans-serif;
  user-select:none;overflow:hidden;cursor:move;}
#xzg-float.xzg-bg{background:rgba(22,24,30,0.93);border:1px solid rgba(255,255,255,0.14);
  border-radius:10px;box-shadow:0 6px 26px rgba(0,0,0,0.5);}
#xzg-float .xzg-bd{padding:6px 8px;}
#xzg-float .xzg-sec+.xzg-sec{margin-top:6px;padding-top:6px;border-top:1px dashed rgba(255,255,255,0.13);}
#xzg-float .xzg-sec-t{font-weight:600;font-size:11px;color:#9db2ff;margin-bottom:3px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#xzg-float .xzg-sub{color:#8b8f9a;font-size:11px;font-weight:400;}
#xzg-float .xzg-row{display:grid;grid-template-columns:3.4em 1fr auto;align-items:center;gap:3px;margin:2px 0;}
#xzg-float .xzg-label{color:#b9bdc7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#xzg-float .xzg-bar{height:7px;background:rgba(255,255,255,0.10);border-radius:4px;overflow:hidden;}
#xzg-float .xzg-bar i{display:block;height:100%;border-radius:4px;
  transition:width .4s ease,background .4s ease;background:#52c41a;}
#xzg-float .xzg-val{text-align:right;color:#fff;font-variant-numeric:tabular-nums;white-space:nowrap;}
#xzg-float .xzg-note{color:#8b8f9a;text-align:center;padding:10px 0;}
/* 运行历史：隐藏滚动条（鼠标滚轮仍可滚动） */
#xzg-run-hist{scrollbar-width:none;-ms-overflow-style:none;}
#xzg-run-hist::-webkit-scrollbar{display:none;width:0;height:0;}
/* 顶部栏横置电池按钮：扁平描边与纯色电量，匹配左侧的线框图标 */
.xzg-batt{position:relative;display:inline-block;width:24px;height:13px;flex:none;
  border:1.5px solid #d4af37;border-radius:3px;box-shadow:none;}
.xzg-batt::after{content:"";position:absolute;right:-4px;top:50%;transform:translateY(-50%);
  width:2.5px;height:6.5px;background:#d4af37;border-radius:0 1.5px 1.5px 0;}
.xzg-batt .xzg-batt-fill{position:absolute;left:1.5px;top:1.5px;bottom:1.5px;
  width:calc(100% - 3px);background:#52c41a;border-radius:1px;
  transition:width .3s ease,background .3s ease;}
#xzg-monitor-menu-btn.xzg-mon-off .xzg-batt{border-color:#6b7280;box-shadow:none;}
#xzg-monitor-menu-btn.xzg-mon-off .xzg-batt::after{background:#6b7280;}
#xzg-monitor-menu-btn.xzg-mon-off .xzg-batt-fill{width:calc(18% - 1.5px);background:#9ca3af;}
/* 右键设置菜单 */
.xzg-menu{position:fixed;z-index:100000;min-width:158px;padding:4px;
  background:rgba(24,26,33,0.97);border:1px solid rgba(255,255,255,0.16);
  border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,0.55);
  color:#e8e8e8;font:12px/1.4 'Segoe UI',system-ui,-apple-system,sans-serif;
  user-select:none;}
.xzg-menu-t{padding:4px 8px 5px;color:#9db2ff;font-weight:600;font-size:11px;
  border-bottom:1px solid rgba(255,255,255,0.10);margin-bottom:3px;}
.xzg-menu-it{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:5px;cursor:pointer;}
.xzg-menu-it:hover{background:rgba(255,255,255,0.08);}
.xzg-menu-it .xzg-menu-box{display:inline-flex;align-items:center;justify-content:center;
  width:14px;height:14px;border:1px solid rgba(255,255,255,0.35);border-radius:3px;
  font-size:10px;line-height:1;color:transparent;flex:none;}
.xzg-menu-it.on{color:#ffd76a;}
.xzg-menu-it.on .xzg-menu-box{border-color:#d4af37;background:rgba(212,175,55,0.20);color:#ffd76a;}
#xzg-float.xzg-compact{width:auto;max-width:92vw;}
#xzg-float.xzg-compact{--xzg-chip-text:#f3f5fa;--xzg-gpu-bg:rgba(96,165,250,.14);--xzg-gpu-border:rgba(96,165,250,.28);--xzg-gpu-label:#8fc5ff;
  --xzg-cpu-bg:rgba(250,173,20,.12);--xzg-cpu-border:rgba(250,173,20,.26);--xzg-cpu-label:#ffd36e;
  --xzg-mem-bg:rgba(177,127,250,.13);--xzg-mem-border:rgba(177,127,250,.26);--xzg-mem-label:#d1afff;}
#xzg-float.xzg-compact.xzg-palette-ice{--xzg-chip-text:#ddf7ff;--xzg-gpu-bg:rgba(46,151,214,.18);--xzg-gpu-border:rgba(90,198,255,.38);--xzg-gpu-label:#83dcff;
  --xzg-cpu-bg:rgba(65,180,190,.13);--xzg-cpu-border:rgba(89,224,222,.30);--xzg-cpu-label:#81e6df;
  --xzg-mem-bg:rgba(101,133,211,.15);--xzg-mem-border:rgba(129,164,255,.32);--xzg-mem-label:#b6caff;}
#xzg-float.xzg-compact.xzg-palette-aurora{--xzg-chip-text:#f1e9ff;--xzg-gpu-bg:rgba(129,105,245,.16);--xzg-gpu-border:rgba(166,146,255,.34);--xzg-gpu-label:#c5b6ff;
  --xzg-cpu-bg:rgba(52,193,156,.13);--xzg-cpu-border:rgba(87,230,190,.30);--xzg-cpu-label:#80e8c6;
  --xzg-mem-bg:rgba(208,91,190,.13);--xzg-mem-border:rgba(238,130,218,.30);--xzg-mem-label:#f0a9df;}
#xzg-float.xzg-compact.xzg-palette-amber{--xzg-chip-text:#fff1dc;--xzg-gpu-bg:rgba(198,125,53,.15);--xzg-gpu-border:rgba(240,174,93,.34);--xzg-gpu-label:#ffc27a;
  --xzg-cpu-bg:rgba(191,79,66,.15);--xzg-cpu-border:rgba(237,119,93,.32);--xzg-cpu-label:#ff9b7e;
  --xzg-mem-bg:rgba(180,146,70,.14);--xzg-mem-border:rgba(230,195,106,.32);--xzg-mem-label:#f2d481;}
#xzg-float.xzg-compact.xzg-palette-graphite{--xzg-chip-text:#e2e5eb;--xzg-gpu-bg:rgba(132,151,174,.12);--xzg-gpu-border:rgba(170,188,210,.25);--xzg-gpu-label:#c1d1e3;
  --xzg-cpu-bg:rgba(164,145,127,.12);--xzg-cpu-border:rgba(195,177,157,.24);--xzg-cpu-label:#d8c6b2;
  --xzg-mem-bg:rgba(143,139,163,.13);--xzg-mem-border:rgba(178,173,202,.24);--xzg-mem-label:#cbc7df;}
#xzg-float.xzg-compact .xzg-bd{padding:10px 8px;}
#xzg-float.xzg-compact .xzg-cmp{display:flex;align-items:center;gap:8px;font-size:15px;line-height:1.6;white-space:nowrap;}
#xzg-float.xzg-compact .xzg-cmp b{font-weight:600;}
#xzg-float.xzg-compact .xzg-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;cursor:default;}
#xzg-float.xzg-compact .xzg-chip-gpu{background:var(--xzg-gpu-bg);border:1px solid var(--xzg-gpu-border);}
#xzg-float.xzg-compact .xzg-chip-cpu{background:var(--xzg-cpu-bg);border:1px solid var(--xzg-cpu-border);}
#xzg-float.xzg-compact .xzg-chip-mem{background:var(--xzg-mem-bg);border:1px solid var(--xzg-mem-border);}
#xzg-float.xzg-compact .xzg-chip-gpu b{color:var(--xzg-gpu-label);}
#xzg-float.xzg-compact .xzg-chip-cpu b{color:var(--xzg-cpu-label);}
#xzg-float.xzg-compact .xzg-chip-mem b{color:var(--xzg-mem-label);}
#xzg-float.xzg-compact .xzg-v{display:inline-block;text-align:right;font-variant-numeric:tabular-nums;color:var(--xzg-chip-text);}
#xzg-float.xzg-compact .xzg-chip[title]{cursor:zoom-in;}
#xzg-float:not(.xzg-orb) #xzg-timer-sec,#xzg-float:not(.xzg-orb) #xzg-run-hist{display:none!important;}
#xzg-float.xzg-orb{width:var(--xzg-orb-size,88px);height:var(--xzg-orb-size,88px);max-width:none;
  border-radius:50%;display:flex;align-items:center;justify-content:center;overflow:visible;
  background:radial-gradient(circle at 32% 26%,rgba(255,255,255,.24),transparent 34%),
    radial-gradient(circle at 50% 58%,rgba(38,43,55,.98),rgba(16,18,24,.96) 72%);
  border:1px solid rgba(255,255,255,.24);box-shadow:0 8px 28px rgba(0,0,0,.48),inset 0 1px 3px rgba(255,255,255,.12);
  isolation:isolate;}
#xzg-float.xzg-orb::before,#xzg-float.xzg-orb::after{content:"";position:absolute;inset:-3px;border-radius:50%;
  pointer-events:none;z-index:-1;}
#xzg-float.xzg-orb::before{padding:2px;inset:-2px;
  background:conic-gradient(from 0deg,#ff5ce5,#8d67ff,#42d9ff,#56f0b2,#ffe66d,#ff8b5c,#ff5ce5);
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask-composite:exclude;
  filter:blur(.2px);animation:xzg-orb-rainbow 5s linear infinite;}
#xzg-float.xzg-orb::after{inset:-8px;
  background:conic-gradient(from 40deg,rgba(255,92,229,.48),rgba(141,103,255,.35),rgba(66,217,255,.42),rgba(86,240,178,.34),rgba(255,230,109,.38),rgba(255,139,92,.42),rgba(255,92,229,.48));
  filter:blur(11px);opacity:.48;animation:xzg-orb-aura 3.2s ease-in-out infinite alternate;}
@keyframes xzg-orb-rainbow{to{transform:rotate(360deg);}}
@keyframes xzg-orb-aura{from{opacity:.30;transform:scale(.96) rotate(0deg)}to{opacity:.64;transform:scale(1.06) rotate(18deg)}}
#xzg-float.xzg-orb.xzg-anim-off::before,#xzg-float.xzg-orb.xzg-anim-off::after{display:none;}
#xzg-float.xzg-orb.xzg-anim-pulse::before{background:conic-gradient(#6b7cff,#62d9ff,#b36cff,#ff79b7,#6b7cff);animation:xzg-orb-rainbow 3.8s linear infinite;}
#xzg-float.xzg-orb.xzg-anim-pulse::after{background:radial-gradient(circle,#a779ff55,transparent 68%);animation:xzg-orb-aura 1.7s ease-in-out infinite alternate;}
#xzg-float.xzg-orb.xzg-anim-scan::before{inset:-3px;padding:2px;background:conic-gradient(from 0deg,transparent 0 72%,#60eaff 82%,#a87cff 91%,transparent 100%);animation:xzg-orb-rainbow 2.1s linear infinite;}
#xzg-float.xzg-orb.xzg-anim-scan::after{inset:-9px;background:conic-gradient(from 0deg,transparent 0 70%,#56dcff70 84%,#a568ff44 95%,transparent 100%);animation:xzg-orb-rainbow 2.1s linear infinite;filter:blur(8px);}
#xzg-float.xzg-orb.xzg-anim-ripple::before{inset:-3px;padding:2px;background:conic-gradient(#52dfff,#8972ff,#ff66bd,#52dfff);animation:xzg-orb-rainbow 7s linear infinite;}
#xzg-float.xzg-orb.xzg-anim-ripple::after{inset:-5px;background:transparent;border:2px solid rgba(109,206,255,.58);animation:xzg-orb-ripple 2s ease-out infinite;filter:none;}
#xzg-float.xzg-orb.xzg-anim-blackhole{background:radial-gradient(circle at 50% 58%,rgba(18,20,29,.98),rgba(5,6,12,.98) 72%);}
#xzg-float.xzg-orb.xzg-anim-blackhole::before{inset:-2px;padding:2px;background:conic-gradient(from 0deg,#110b22,#f0a54e,#fff0bd,#783dca,#1b4a80,#f5a94e,#110b22);animation:xzg-orb-rainbow 3.8s linear infinite;}
#xzg-float.xzg-orb.xzg-anim-blackhole::after{display:none;}
@keyframes xzg-orb-ripple{0%{transform:scale(.92);opacity:.65}100%{transform:scale(1.34);opacity:0}}
@keyframes xzg-orb-pulse-soft{from{transform:scale(.96);opacity:.28}to{transform:scale(1.1);opacity:.7}}
#xzg-float.xzg-orb.xzg-anim-pulse{animation:xzg-orb-pulse-soft 1.7s ease-in-out infinite alternate;}
#xzg-float.xzg-orb .xzg-orb-value{animation:none;text-shadow:0 1px 2px rgba(0,0,0,.72);}
@media(prefers-reduced-motion:reduce){#xzg-float.xzg-orb::before,#xzg-float.xzg-orb::after,#xzg-float.xzg-orb .xzg-orb-value{animation:none!important}}
#xzg-float.xzg-orb .xzg-bd{padding:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
#xzg-float.xzg-orb #xzg-timer-sec,#xzg-float.xzg-orb #xzg-run-hist{display:none!important;}
#xzg-float.xzg-orb #xzg-stats{width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
#xzg-float.xzg-orb .xzg-orb-value{font:700 var(--xzg-orb-font-size,30px)/1 'Segoe UI',system-ui,sans-serif;
  font-variant-numeric:tabular-nums;letter-spacing:-.04em;white-space:nowrap;text-shadow:0 2px 10px #0009;}
#xzg-float.xzg-orb .xzg-orb-value.small{font-size:calc(var(--xzg-orb-font-size,30px)*.74);}
#xzg-float.xzg-orb .xzg-note{font-size:10px;padding:8px;text-align:center;}
`;

// ---------------------------------------------------------------------------
// 工作流运行计时（事件驱动；历史记录 localStorage 持久化）
// ---------------------------------------------------------------------------

const XZG_RUN_HISTORY_KEY = "xzg-run-history-v1";
const XZG_RUN_HISTORY_MAX = 5; // 最多保留 5 条运行记录
// 运行状态（模块级：事件监听始终注册，历史记录与浮窗显隐/监控开关无关）
const _run = { running: false, name: "", startTs: 0 };
// 本会话是否真的跑过工作流：刷新后为 false，空闲时不再回放上次运行的历史记录
let _ranThisSession = false;
let _onRunChange = null; // 浮窗创建后注入：运行状态变化时立即刷新 UI（无需等下一次轮询）

function loadRunHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(XZG_RUN_HISTORY_KEY) || "[]");
    return Array.isArray(list) ? list.slice(0, XZG_RUN_HISTORY_MAX) : [];
  } catch (e) {
    return [];
  }
}

function saveRunHistory(list) {
  try {
    localStorage.setItem(XZG_RUN_HISTORY_KEY, JSON.stringify(list.slice(0, XZG_RUN_HISTORY_MAX)));
  } catch (e) {
    /* ignore */
  }
}

function fmtDur(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

function fmtClock(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 当前工作流名称：多来源解析；取不到时返回空串（UI 只显示计时，不显示"未命名工作流"占位）
function resolveWorkflowName() {
  try {
    const wf = app.workflowManager?.activeWorkflow;
    if (wf?.name) return String(wf.name).replace(/\.json$/i, "");
  } catch (e) {
    /* ignore */
  }
  try {
    if (app.graph?.extra?.workflow_name) return String(app.graph.extra.workflow_name);
  } catch (e) {
    /* ignore */
  }
  return "";
}

// 显示用工作流名：空 / 旧记录里的"未命名工作流"占位 → 不显示名称
function displayName(name) {
  const s = String(name || "").trim();
  return !s || s === "未命名工作流" ? "" : s;
}

function startRun() {
  if (_run.running) return;
  _run.running = true;
  _ranThisSession = true;
  _run.name = resolveWorkflowName(); // 起跑时冻结工作流名
  _run.startTs = Date.now();
  if (_onRunChange) _onRunChange();
}

function stopRun(status) {
  if (!_run.running) return;
  _run.running = false;
  const end = Date.now();
  const list = loadRunHistory();
  list.unshift({ name: _run.name, start: _run.startTs, end, dur: Math.max(0, end - _run.startTs), status });
  saveRunHistory(list);
  _run.startTs = 0;
  if (_onRunChange) _onRunChange();
}

function registerRunEvents() {
  // 工作流开始：每个 prompt 启动时触发
  api.addEventListener("execution_start", () => startRun());
  // 兜底：错过 execution_start（如页面刷新时恰在执行中）以首个执行节点为起点
  api.addEventListener("executing", (e) => {
    if (e?.detail?.node && !_run.running) startRun();
  });
  // 工作流停止：成功 / 出错 / 中断
  api.addEventListener("execution_success", () => stopRun("完成"));
  api.addEventListener("execution_error", () => stopRun("出错"));
  api.addEventListener("execution_interrupted", () => stopRun("中断"));
  // 页面关闭时仍在运行：记一条"中断"，避免历史里悬空
  window.addEventListener("beforeunload", () => {
    if (_run.running) stopRun("中断");
  });
}

// ---------------------------------------------------------------------------
// 悬浮窗
// ---------------------------------------------------------------------------

function createFloatWindow() {
  // 幂等：已存在实例时直接复用（「设置 onChange」与「setup」两条创建路径可能先后触发，
  // 复用可避免出现两个 #xzg-float 导致重复轮询/重复 UI）
  if (window.__xzgFloat) {
    return window.__xzgFloat;
  }
  const style = document.createElement("style");
  style.textContent = XZG_CSS;
  document.head.appendChild(style);

  const store = loadStore();
  let hidden = !!store.hidden;
  _floatHidden = hidden;

  const root = document.createElement("div");
  root.id = "xzg-float";
  root.classList.add("xzg-bg");
  root.classList.toggle("xzg-orb", !_display.compact);
  root.classList.toggle("xzg-compact", _display.compact);
  root.classList.add(`xzg-anim-${_display.animation || "rainbow"}`);
  root.classList.add(`xzg-palette-${_display.capsule_palette || "classic"}`);
  root.style.setProperty("--xzg-orb-size", `${_display.orb_size}px`);
  root.style.setProperty("--xzg-orb-font-size", `${_display.orb_font_size}px`);
  // 首次监控请求完成前不展示空容器；否则紧凑模式会短暂呈现为空的小椭圆。
  root.style.visibility = "hidden";
  // 之前点电池按钮隐藏过浮窗：刷新后仍保持隐藏（否则会以空内容的小胶囊形态出现）
  if (hidden) root.style.display = "none";
  // 仅当位置由当前方案（右下角默认）保存过才应用记忆；开启“保持默认”时始终用默认位置
  if (store.posVer === XZG_POS_VER) {
    applyPosStyle(root, store.left, store.top);
  }
  // 云端位置恢复（异步）：以服务端为准回写本地；服务端暂无则把本地首次上云
  cloudRestoreFloatPos(root);
  root.innerHTML = `<div class="xzg-bd"></div>`;
  root.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (_menuEl) closeContextMenu();
    else showContextMenu(root);
  });

  const body = root.querySelector(".xzg-bd");
  // 结构：运行计时区（含可折叠历史）+ 监控数据区。
  // render() 只刷新数据区；计时区独立持久，避免每秒重建导致展开状态/文本跳动。
  body.innerHTML = `<div class="xzg-sec" id="xzg-timer-sec" style="cursor:pointer;"></div>
    <div id="xzg-run-hist" style="display:none;max-height:150px;overflow-y:auto;"></div>
    <div id="xzg-stats"></div>`;
  const statsEl = body.querySelector("#xzg-stats");

  // ---- 运行计时区 ----
  const timerSec = body.querySelector("#xzg-timer-sec");
  const histEl = body.querySelector("#xzg-run-hist");
  function renderTimerSec() {
    if (true) {
      // 精简模式：计时区与历史区整体隐藏（计时以单行小胶囊形式并入精简行）
      timerSec.style.display = "none";
      histEl.style.display = "none";
      return;
    }
    timerSec.style.display = "";
    // 只显示计时：去掉「运行计时/运行中/空闲」文案与工作流名占位。
    // 左侧依次为：三角（▼已展开历史 / ▶已收起）+ 状态圆点（绿=运行中，灰=空闲）；计时 20px 白色
    const open = histEl.style.display !== "none";
    const tri = open ? `<span style="color:#9db2ff">▼</span>` : `<span style="color:#9db2ff">▶</span>`;
    const dot = _run.running ? `<span style="color:#52c41a">●</span>` : `<span style="color:#6b7280">●</span>`;
    const timerStyle = `font-size:20px;color:#fff;font-variant-numeric:tabular-nums;line-height:1.3;`;
    if (_run.running) {
      const nm = displayName(_run.name);
      const nameHtml = nm ? `<span class="xzg-label" title="${esc(_run.name)}">${esc(nm)}</span>` : "";
      timerSec.innerHTML = `<div class="xzg-row" style="grid-template-columns:${nm ? "auto auto 1fr auto" : "auto auto 1fr"};gap:6px;">
        ${tri}${dot}${nameHtml}
        <span class="xzg-val" style="${timerStyle}">${fmtDur(Date.now() - _run.startTs)}</span></div>`;
    } else {
      // 空闲时只在「本会话跑过工作流」后显示上次运行时长；
      // 刚刷新完的页面不回放 localStorage 里的历史记录（保持 00:00）
      const last = _ranThisSession ? loadRunHistory()[0] : null;
      if (last) {
        const nm = displayName(last.name);
        const nameHtml = nm ? `<span class="xzg-label" title="${esc(nm)} · 上次运行 ${fmtClock(last.start)}">${esc(nm)}</span>` : "";
        timerSec.innerHTML = `<div class="xzg-row" style="grid-template-columns:${nm ? "auto auto 1fr auto" : "auto auto 1fr"};gap:6px;">
          ${tri}${dot}${nameHtml}
          <span class="xzg-val" style="${timerStyle}" title="上次运行 ${fmtClock(last.start)}">${fmtDur(last.dur)}</span></div>`;
      } else {
        timerSec.innerHTML = `<div class="xzg-row" style="grid-template-columns:auto auto 1fr;gap:6px;">${tri}${dot}
          <span class="xzg-val" style="${timerStyle}">00:00</span></div>`;
      }
    }
  }
  function renderHistory() {
    const list = loadRunHistory();
    if (!list.length) {
      histEl.innerHTML = `<div class="xzg-note" style="padding:4px 0;">暂无历史记录</div>`;
      return;
    }
    histEl.innerHTML = list.map((r) => {
      const icon = r.status === "完成" ? `<span style="color:#52c41a">✔</span>`
        : r.status === "出错" ? `<span style="color:#f5222d">✖</span>`
        : `<span style="color:#faad14">⏹</span>`;
      const nm = displayName(r.name);
      return `<div class="xzg-row" style="grid-template-columns:auto 1fr auto;">
        <span>${icon}</span>
        <span class="xzg-label" title="${esc(nm || fmtClock(r.start))}">${esc(nm || fmtClock(r.start))}</span>
        <span class="xzg-val">${fmtDur(r.dur)}</span></div>`;
    }).join("") + `<div id="xzg-run-hist-clear" style="text-align:right;padding:2px 4px;cursor:pointer;color:#8b8f9a;font-size:11px;">清空记录</div>`;
    const clr = histEl.querySelector("#xzg-run-hist-clear");
    if (clr) clr.addEventListener("click", (e) => {
      e.stopPropagation();
      saveRunHistory([]);
      renderHistory();
      renderTimerSec();
    });
  }
  // 展开/收起历史：按悬浮窗在屏幕中的位置自动决定扩展方向——
  //   下方空间够 → 正常向下扩展；
  //   下方不够且上方更宽裕 → 临时改「底部锚定」，窗口内容向上扩展（收起时还原定位）；
  //   两侧都不够 → 向下扩展并压缩历史区高度。
  let _preExpandPos = null;
  const setHistOpen = (open) => {
    histEl.style.display = open ? "" : "none";
    histEl.style.maxHeight = "150px";
    if (open) {
      const rect = root.getBoundingClientRect();
      const grow = Math.min(150, histEl.scrollHeight || 150); // 历史区实际需要的高度
      const below = window.innerHeight - rect.bottom - 8;      // 窗口下方可用空间
      const above = rect.top - 8;                              // 窗口上方可用空间
      if (below < grow) {
        if (above > below) {
          _preExpandPos = { top: root.style.top, bottom: root.style.bottom };
          root.style.top = "auto";
          root.style.bottom = Math.max(8, window.innerHeight - rect.bottom) + "px";
        } else {
          histEl.style.maxHeight = Math.max(60, below) + "px";
        }
      }
    } else if (_preExpandPos) {
      root.style.top = _preExpandPos.top;
      root.style.bottom = _preExpandPos.bottom;
      _preExpandPos = null;
    }
  };
  // 点击计时区头：展开/收起历史（状态记忆）
  timerSec.addEventListener("click", () => {
    const open = histEl.style.display !== "none";
    setHistOpen(!open);
    _display.hist_open = !open;
    saveDisplay();
    if (!open) renderHistory();
    renderTimerSec(); // 同步三角方向（▶/▼）
  });
  // 历史列表刷新后始终收起：不自动展开上次的展开状态，
  // 避免每次刷新先闪现历史记录（用户点计时区可随时展开）
  _display.hist_open = false;
  // 运行状态变化时由事件层立即回调刷新（启动/结束无需等下一次轮询）
  _onRunChange = () => {
    if (!_display.compact && _lastData) render(_lastData);
  };

  // ---- 拖拽（无标题栏，整窗可拖动） ----
  let dragging = false;
  let dx = 0;
  let dy = 0;
  root.addEventListener("mousedown", (e) => {
    const rect = root.getBoundingClientRect();
    dx = e.clientX - rect.left;
    dy = e.clientY - rect.top;
    dragging = true;
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    root.style.left = e.clientX - dx + "px";
    root.style.top = e.clientY - dy + "px";
    root.style.right = "auto";
    root.style.bottom = "auto";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    _posDragged = true;
    saveStore({
      ...loadStore(),
      left: root.style.left,
      top: root.style.top,
      posVer: XZG_POS_VER,
    });
    queueCloudSavePos(); // 位置变化后防抖推送到云端
  });

  function setVisible(v) {
    hidden = !v;
    root.style.display = v ? "" : "none";
    _floatHidden = hidden;
    saveStore({ ...loadStore(), hidden: hidden });
    refreshMenuBtn();
    if (v) poll(); // 打开时立即刷新一次数据
  }

  function resizeOrb(size) {
    const rect = root.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    _display.orb_size = Math.max(52, Math.min(180, Number(size) || 88));
    root.style.setProperty("--xzg-orb-size", `${_display.orb_size}px`);
    root.style.left = `${centerX - _display.orb_size / 2}px`;
    root.style.top = `${centerY - _display.orb_size / 2}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
    _posDragged = true;
    saveStore({ ...loadStore(), left: root.style.left, top: root.style.top, posVer: XZG_POS_VER });
    queueCloudSavePos();
    saveDisplay();
  }

  function setMetric(key) {
    if (key && MONITOR_METRICS.some((metric) => metric.key === key)) _display.metric = key;
    _display.compact = false;
    saveDisplay();
    root.classList.remove("xzg-compact");
    root.classList.add("xzg-orb");
    applyOrbAnimation();
    root.style.setProperty("--xzg-orb-size", `${_display.orb_size}px`);
    root.style.setProperty("--xzg-orb-font-size", `${_display.orb_font_size}px`);
    if (_lastData) render(_lastData);
  }

  function toggleCompact() {
    _display.compact = !_display.compact;
    saveDisplay();
    root.classList.toggle("xzg-compact", _display.compact);
    root.classList.toggle("xzg-orb", !_display.compact);
    if (!_display.compact) applyOrbAnimation();
    if (_lastData) render(_lastData);
  }

  function applyOrbAnimation() {
  root.classList.remove("xzg-anim-off", "xzg-anim-rainbow", "xzg-anim-pulse", "xzg-anim-scan", "xzg-anim-ripple", "xzg-anim-blackhole");
    root.classList.add(`xzg-anim-${_display.animation || "rainbow"}`);
  }

  root.addEventListener("dblclick", (event) => {
    if (!root.classList.contains("xzg-orb")) return;
    event.preventDefault();
    event.stopPropagation();
    toggleCompact();
  });

  statsEl.addEventListener("dblclick", (event) => {
    if (!_display.compact) return;
    const chip = event.target.closest("[data-xzg-metric]");
    if (!chip) return;
    event.preventDefault();
    event.stopPropagation();
    setMetric(chip.dataset.xzgMetric);
  });

  function renderCompact(data) {
    const valueHtml = (key, value, unit, color, minCh = 4.6, decimals = 0) => {
      if (!_display[key]) return "";
      const valid = value != null && !Number.isNaN(Number(value));
      const text = valid ? `${Number(value).toFixed(decimals)}${unit}` : "--";
      return `<span class="xzg-v" data-xzg-metric="${key}" style="min-width:${minCh}ch;color:${valid ? color : "#8b8f9a"}">${text}</span>`;
    };
    const parts = [];
    const gpus = data?.gpu?.gpus || [];
    if (gpus.length) {
      const multi = gpus.length > 1;
      for (const gpu of gpus) {
        let values = "";
        if (_display.gpu_util) values += valueHtml("gpu_util", gpu.util, "%", pctColor(gpu.util, gpu.temp));
        if (_display.gpu_temp) values += valueHtml("gpu_temp", gpu.temp, "°", pctColor(0, gpu.temp), 4.2);
        if (_display.gpu_vram) {
          const pair = fmtMemPair(gpu.vram_used_mb, gpu.vram_total_mb);
          values += `<span class="xzg-v" data-xzg-metric="gpu_vram" style="min-width:6.5ch">${pair}</span>`;
        }
        if (_display.gpu_power && gpu.power_w != null) values += valueHtml("gpu_power", gpu.power_w, "W", "#ffd666", 5.5);
        if (values) parts.push(`<span class="xzg-chip xzg-chip-gpu"><b>GPU${multi ? gpu.index ?? "" : ""}</b>${values}</span>`);
      }
    } else if (_display.gpu_util || _display.gpu_temp || _display.gpu_vram || _display.gpu_power) {
      parts.push(`<span class="xzg-chip xzg-chip-gpu"><b>GPU</b><span style="color:#8b8f9a">--</span></span>`);
    }
    const cpu = data?.cpu || {};
    let cpuValues = "";
    if (_display.cpu_util) {
      const cpuUtil = cpu.util == null ? null : Math.max(0, Math.min(100, Number(cpu.util)));
      cpuValues += valueHtml("cpu_util", cpuUtil, "%", pctColor(cpuUtil, cpu.temp));
    }
    if (_display.cpu_temp && cpu.temp != null) cpuValues += valueHtml("cpu_temp", cpu.temp, "°", pctColor(0, cpu.temp), 4.2);
    if (cpuValues) parts.push(`<span class="xzg-chip xzg-chip-cpu"><b>CPU</b>${cpuValues}</span>`);
    if (_display.mem_used && data?.mem) {
      parts.push(`<span class="xzg-chip xzg-chip-mem"><b>内存</b><span class="xzg-v" data-xzg-metric="mem_used">${fmtMemPair(data.mem.used_mb, data.mem.total_mb)}</span></span>`);
    }
    return `<div class="xzg-cmp">${parts.join("") || "<span style='color:#8b8f9a'>无可显示项目</span>"}</div>`;
  }

  let _lastData = null;
  function render(data) {
    _lastData = data;
    try {
      if (_display.compact) {
        statsEl.innerHTML = renderCompact(data);
      } else {
        const metric = MONITOR_METRICS.find((item) => item.key === _display.metric) || MONITOR_METRICS[0];
        const value = metric.get(data);
        const valid = value != null && !Number.isNaN(Number(value));
        let shown = "--";
        if (valid) {
          const number = Number(value);
          shown = metric.key === "gpu_vram" || metric.key === "mem_used" ? `${number.toFixed(1)}${metric.unit}`
            : metric.unit === "°C" ? `${number.toFixed(0)}°` : `${number.toFixed(0)}${metric.unit}`;
        }
        const small = shown.length > 5 ? " small" : "";
        const color = valid ? (typeof metric.color === "function" ? metric.color(Number(value), data) : metric.color) : "#8b8f9a";
        statsEl.innerHTML = `<div class="xzg-orb-value${small}" title="${esc(metric.label)}" style="color:${color}">${shown}</div>`;
      }
    } catch (e) {
      // 渲染出错时显示提示，避免内容区静默空白
      statsEl.innerHTML = `<div class="xzg-note">⚠ 渲染出错: ${esc(e && e.message ? e.message : e)}</div>`;
    }
    // 在布局与内容都已就绪后一次性显示，避免刷新时闪过空胶囊。
    root.style.visibility = "visible";
  }

  function renderOffline() {
    statsEl.innerHTML = _display.compact
      ? `<div class="xzg-cmp"><span style="color:#8b8f9a">连接中…</span></div>`
      : `<div class="xzg-orb-value" style="color:#8b8f9a" title="等待连接">--</div>`;
    root.style.visibility = "visible";
  }

  async function poll() {
    if (hidden) return;
    try {
      const res = await fetch(XZG_API, { cache: "no-store" });
      if (!res.ok) throw new Error("http " + res.status);
      const data = await res.json();
      render(data);
    } catch (e) {
      renderOffline();
    }
  }

  document.body.appendChild(root);
  // 轮询控制：支持「设置 → 功能开关」随时停止/恢复
  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(poll, 1000);
    poll();
  }
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  start();

  return {
    root,
    setVisible,
    resizeOrb,
    setAnimation(value) {
      _display.animation = value;
      saveDisplay();
      applyOrbAnimation();
    },
    rerender() {
      root.classList.toggle("xzg-orb", !_display.compact);
      root.classList.toggle("xzg-compact", _display.compact);
      root.classList.remove("xzg-palette-classic", "xzg-palette-ice", "xzg-palette-aurora", "xzg-palette-amber", "xzg-palette-graphite");
      root.classList.add(`xzg-palette-${_display.capsule_palette || "classic"}`);
      if (!_display.compact) applyOrbAnimation();
      root.style.setProperty("--xzg-orb-size", `${_display.orb_size}px`);
      root.style.setProperty("--xzg-orb-font-size", `${_display.orb_font_size}px`);
      if (_lastData) render(_lastData);
    },
    applyPanelBg() {
      root.classList.add("xzg-bg"); // 面板始终带底色
    },
    start,
    stop,
  };
}

// ---------------------------------------------------------------------------
// 顶部功能栏按钮（与小珠光同机制：app.menu 优先，选择器回退）
// ---------------------------------------------------------------------------

const XZG_BTN_ID = "xzg-monitor-menu-btn";
const XZG_THEME_BTN_ID = "xzg-theme-menu-btn";
let _float = null;       // 悬浮窗实例
let _floatHidden = false; // 悬浮窗当前是否隐藏
let _menuBtn = null;     // 顶部栏按钮
let _themeMenuBtn = null;
let _themeContextMenu = null;

window.XZGMonitorConfig = {
  reloadFromStorage() {
    try {
      _display = normalizeDisplay(JSON.parse(localStorage.getItem(XZG_DISPLAY_KEY) || "{}"));
      if (_float) _float.rerender();
      cloudSave("xzg_monitor_display", _display).catch(() => {});
      const store = loadStore();
      const pos = collectFloatPos(store);
      if (pos) {
        _posDragged = true;
        if (_float) applyPosStyle(_float.root, pos.left, pos.top);
        cloudSave(XZG_CLOUD_POS_KEY, pos).catch(() => {});
      }
    } catch (_) { /* keep current display state */ }
  },
};

function refreshMenuBtn() {
  if (!_menuBtn) return;
  _menuBtn.classList.toggle("xzg-mon-off", _floatHidden);
}

function closeContextMenu() {
  if (_menuEl) {
    if (_menuEl._xzgOutsideHandler) document.removeEventListener("pointerdown", _menuEl._xzgOutsideHandler, true);
    if (_menuEl._xzgKeyHandler) document.removeEventListener("keydown", _menuEl._xzgKeyHandler, true);
    _menuEl.remove();
    _menuEl = null;
  }
}

function showContextMenu(btn) {
  closeContextMenu();
  const anchor = _menuBtn || btn;
  const menu = document.createElement("div");
  menu.id = "xzg-menu";
  menu.className = "xzg-menu";
  menu.innerHTML = `<div class="xzg-menu-t">胶囊显示项</div>`;
  const items = [
    { key: "gpu_util", label: "GPU 利用率" }, { key: "gpu_temp", label: "GPU 温度" },
    { key: "gpu_vram", label: "GPU 显存" }, { key: "gpu_power", label: "GPU 功耗" },
    { key: "cpu_util", label: "CPU 使用率" }, { key: "cpu_temp", label: "CPU 温度" },
    { key: "mem_used", label: "内存占用" },
  ];
  items.forEach((it) => {
    const row = document.createElement("div");
    row.className = "xzg-menu-it" + (_display[it.key] ? " on" : "");
    row.innerHTML = `<span class="xzg-menu-box">${_display[it.key] ? "✓" : ""}</span><span>${it.label}</span>`;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      _display[it.key] = !_display[it.key];
      saveDisplay();
      row.classList.toggle("on", _display[it.key]);
      row.querySelector(".xzg-menu-box").textContent = _display[it.key] ? "✓" : "";
      if (_float) _float.rerender();
    });
    menu.appendChild(row);
  });
  const sizeLabel = document.createElement("div");
  sizeLabel.className = "xzg-menu-t";
  sizeLabel.style.marginTop = "4px";
  sizeLabel.textContent = `圆球大小：${_display.orb_size}px`;
  if (!_display.compact) menu.appendChild(sizeLabel);
  const sizeInput = document.createElement("input");
  sizeInput.type = "range";
  sizeInput.min = "52";
  sizeInput.max = "180";
  sizeInput.step = "2";
  sizeInput.value = String(_display.orb_size);
  sizeInput.style.cssText = "display:block;width:calc(100% - 16px);margin:8px;accent-color:#d4af37;";
  sizeInput.addEventListener("input", () => {
    _display.orb_size = Number(sizeInput.value);
    sizeLabel.textContent = `圆球大小：${_display.orb_size}px`;
    if (_float) _float.resizeOrb(_display.orb_size);
    else saveDisplay();
  });
  if (!_display.compact) menu.appendChild(sizeInput);
  const fontSizeLabel = document.createElement("div");
  fontSizeLabel.className = "xzg-menu-t";
  fontSizeLabel.style.marginTop = "4px";
  fontSizeLabel.textContent = `字体大小：${_display.orb_font_size}px`;
  if (!_display.compact) menu.appendChild(fontSizeLabel);
  const fontSizeInput = document.createElement("input");
  fontSizeInput.type = "range";
  fontSizeInput.min = "14";
  fontSizeInput.max = "72";
  fontSizeInput.step = "1";
  fontSizeInput.value = String(_display.orb_font_size);
  fontSizeInput.style.cssText = "display:block;width:calc(100% - 16px);margin:8px;accent-color:#d4af37;";
  fontSizeInput.addEventListener("input", () => {
    _display.orb_font_size = Number(fontSizeInput.value);
    fontSizeLabel.textContent = `字体大小：${_display.orb_font_size}px`;
    saveDisplay();
    if (_float) _float.rerender();
  });
  if (!_display.compact) menu.appendChild(fontSizeInput);
  const animationTitle = document.createElement("div");
  animationTitle.className = "xzg-menu-t";
  animationTitle.style.marginTop = "5px";
  animationTitle.textContent = "悬浮球动画";
  menu.appendChild(animationTitle);
  const animations = [
    ["off", "关闭"], ["rainbow", "幻彩光环"], ["pulse", "脉冲呼吸"],
    ["scan", "扫描光"], ["ripple", "能量波纹"], ["blackhole", "黑洞吸积盘"],
  ];
  const animationSelect = document.createElement("select");
  animationSelect.className = "xzg-menu-animation-select";
  animationSelect.style.cssText = "display:block;width:calc(100% - 16px);margin:6px 8px 8px;padding:6px 8px;border:1px solid rgba(255,255,255,.2);border-radius:5px;background:#20232b;color:#eee;font:12px 'Segoe UI',system-ui,sans-serif;";
  for (const [value, label] of animations) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    animationSelect.appendChild(option);
  }
  animationSelect.value = _display.animation || "rainbow";
  animationSelect.addEventListener("change", (event) => {
    event.stopPropagation();
    _display.animation = animationSelect.value;
    saveDisplay();
    if (_float) _float.setAnimation(_display.animation);
  });
  animationSelect.addEventListener("pointerdown", (event) => event.stopPropagation());
  menu.appendChild(animationSelect);
  const paletteTitle = document.createElement("div");
  paletteTitle.className = "xzg-menu-t";
  paletteTitle.style.marginTop = "5px";
  paletteTitle.textContent = "胶囊配色与字体";
  menu.appendChild(paletteTitle);
  const palettes = [
    ["classic", "经典分区色"], ["ice", "冰蓝青"], ["aurora", "极光紫绿"],
    ["amber", "暖金铜红"], ["graphite", "石墨中性"],
  ];
  const paletteSelect = document.createElement("select");
  paletteSelect.className = "xzg-menu-palette-select";
  paletteSelect.style.cssText = animationSelect.style.cssText;
  for (const [value, label] of palettes) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    paletteSelect.appendChild(option);
  }
  paletteSelect.value = _display.capsule_palette || "classic";
  paletteSelect.addEventListener("change", (event) => {
    event.stopPropagation();
    _display.capsule_palette = paletteSelect.value;
    saveDisplay();
    if (_float) _float.rerender();
  });
  paletteSelect.addEventListener("pointerdown", (event) => event.stopPropagation());
  menu.appendChild(paletteSelect);
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4))}px`;
  const belowTop = r.bottom + 5;
  const aboveTop = r.top - menu.offsetHeight - 5;
  const menuTop = belowTop + menu.offsetHeight <= window.innerHeight - 4
    ? belowTop
    : aboveTop >= 4 ? aboveTop : Math.max(4, window.innerHeight - menu.offsetHeight - 4);
  menu.style.top = `${menuTop}px`;
  const mb = menu.getBoundingClientRect();
  if (mb.bottom > window.innerHeight - 4) {
    menu.style.top = Math.max(4, r.top - mb.height - 6) + "px";
  }
  const outsideHandler = (event) => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) closeContextMenu();
  };
  const keyHandler = (event) => {
    if (event.key === "Escape") closeContextMenu();
  };
  menu._xzgOutsideHandler = outsideHandler;
  menu._xzgKeyHandler = keyHandler;
  document.addEventListener("pointerdown", outsideHandler, true);
  document.addEventListener("keydown", keyHandler, true);
  _menuEl = menu;
}

function findMenuContainer() {
  if (app.menu?.element) return app.menu.element;
  const selectors = [
    ".comfyui-menu-right", ".comfyui-menu", ".comfy-menu",
    ".p-toolbar", ".top-menubar-container", ".actionbar-container",
    "[class*='menubar']", "[class*='menu-bar']",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function buildMenuButton() {
  const btn = document.createElement("div");
  btn.id = XZG_BTN_ID;
  btn.title = "显示/隐藏 系统监控悬浮窗";
  btn.style.cssText = `
    display:flex;align-items:center;justify-content:center;gap:4px;
    height:32px;padding:0 8px;cursor:pointer;
    color:#9db2ff;font-size:13px;border-radius:6px;user-select:none;
    transition:background 0.15s;position:relative;align-self:center;margin:auto 0;
    background:transparent;
  `;
  btn.innerHTML = `<span class="xzg-batt"><i class="xzg-batt-fill"></i></span>`;
  btn.addEventListener("mouseenter", () => {
    btn.style.background = "var(--comfy-input-bg,#353535)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "transparent";
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();
    if (_float) _float.setVisible(_floatHidden); // 隐藏→显示；显示→隐藏
  });
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (_menuEl) closeContextMenu();
    else showContextMenu(btn);
  });
  return btn;
}

function fmtMemPair(usedMb, totalMb) {
  const fmt = (mb) => mb == null || Number.isNaN(Number(mb)) ? "--"
    : Number(mb) >= 1024 ? `${(Number(mb) / 1024).toFixed(1)}G` : `${Math.round(Number(mb))}M`;
  if (usedMb == null || totalMb == null) return `${fmt(usedMb)}/${fmt(totalMb)}`;
  if (usedMb >= 1024 && totalMb >= 1024) return `${Math.round(usedMb / 1024)}/${Math.round(totalMb / 1024)}`;
  return `${fmt(usedMb)}/${fmt(totalMb)}`;
}

function pctColor(pct, temp) {
  if (pct >= 85 || (temp != null && temp >= 85)) return "#f5222d";
  if (pct >= 60 || (temp != null && temp >= 70)) return "#faad14";
  return "#52c41a";
}

function closeThemeContextMenu() {
  if (!_themeContextMenu) return;
  document.removeEventListener("pointerdown", _themeContextMenu.outsideHandler, true);
  document.removeEventListener("keydown", _themeContextMenu.keyHandler, true);
  _themeContextMenu.element.remove();
  _themeContextMenu = null;
}

function showThemeContextMenu(btn) {
  closeThemeContextMenu();
  const menu = document.createElement("div");
  menu.style.cssText = "position:fixed;z-index:2000002;min-width:190px;padding:5px;background:var(--comfy-menu-bg,#252525);color:var(--fg-color,#ddd);border:1px solid var(--border-color,#555);border-radius:7px;box-shadow:0 8px 24px #0009;font:13px Arial,'Microsoft YaHei',sans-serif";
  const addItem = (label, callback) => {
    const item = document.createElement("div");
    item.textContent = label;
    item.style.cssText = "padding:9px 11px;border-radius:4px;cursor:pointer;white-space:nowrap";
    item.addEventListener("mouseenter", () => { item.style.background = "rgba(255,255,255,.1)"; });
    item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      closeThemeContextMenu();
      callback();
    });
    menu.appendChild(item);
  };
  addItem(xzgT("设置 - 小珠光", "Settings - Xiaozhuguang"), () => openXiaozhuguangSettings());
  addItem(xzgT("导入导出配置", "Import / Export Config"), () => {
    const panel = window.XZGThemePanel;
    if (panel?.openConfigTransferDialog) panel.openConfigTransferDialog();
    else console.warn("[小珠光] 配置导入导出模块尚未就绪");
  });
  menu.addEventListener("pointerdown", (event) => event.stopPropagation());
  menu.addEventListener("contextmenu", (event) => { event.preventDefault(); event.stopPropagation(); });
  document.body.appendChild(menu);
  const rect = btn.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(rect.bottom + 5, window.innerHeight - menu.offsetHeight - 4))}px`;
  const outsideHandler = (event) => {
    if (!menu.contains(event.target) && !btn.contains(event.target)) closeThemeContextMenu();
  };
  const keyHandler = (event) => { if (event.key === "Escape") closeThemeContextMenu(); };
  _themeContextMenu = { element: menu, outsideHandler, keyHandler };
  document.addEventListener("pointerdown", outsideHandler, true);
  document.addEventListener("keydown", keyHandler, true);
}

function openXiaozhuguangSettings() {
  const themePanel = window.XZGThemePanel;
  if (themePanel?.isVisible) themePanel.hide();
  try {
    app.extensionManager?.command?.execute?.("Comfy.ShowSettingsDialog");
    revealXiaozhuguangSettings();
  } catch (err) {
    console.warn("[小珠光] 打开小珠光设置失败:", err);
  }
}

function buildThemeMenuButton() {
  if (!document.getElementById("xzg-theme-icon-sheen-style")) {
    const style = document.createElement("style");
    style.id = "xzg-theme-icon-sheen-style";
    style.textContent = `
      @keyframes xzg-theme-ring-orbit {
        0%,4% { transform:rotate(0deg); opacity:0; }
        6% { opacity:1; }
        30% { opacity:.82; }
        34%,100% { transform:rotate(360deg); opacity:0; }
      }
      @keyframes xzg-theme-letters-sweep {
        0%,35% { transform:translateX(-140%); opacity:0; }
        38% { opacity:.85; }
        62% { transform:translateX(140%); opacity:.72; }
        66%,100% { transform:translateX(140%); opacity:0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .xzg-theme-ring-orbit, .xzg-theme-letters-sweep { animation:none !important; }
      }
    `;
    document.head.appendChild(style);
  }
  const btn = document.createElement("div");
  btn.id = XZG_THEME_BTN_ID;
  btn.title = "小珠光主题面板";
  btn.setAttribute("role", "button");
  btn.setAttribute("aria-label", "打开小珠光主题面板");
  btn.style.cssText = `
    display:flex;align-items:center;justify-content:center;
    width:32px;height:32px;padding:2px;box-sizing:border-box;flex:none;
    cursor:pointer;border-radius:6px;user-select:none;
    transition:background 0.15s;align-self:center;margin:auto 0;
    background:transparent;
  `;
  const iconUrl = new URL("./xzg_theme_icon.webp", import.meta.url).href;
  const iconWrap = document.createElement("span");
  // 动画层限制在图标圆形边界内，避免高光溢出到圆环外侧区域。
  iconWrap.style.cssText = "position:relative;display:block;width:28px;height:28px;flex:none;border-radius:50%;overflow:hidden;pointer-events:none;";
  const icon = document.createElement("img");
  icon.src = iconUrl;
  icon.alt = "XZG";
  icon.draggable = false;
  icon.style.cssText = "display:block;width:28px;height:28px;object-fit:cover;border-radius:50%;";
  const makeGlint = (className) => {
    const orbit = document.createElement("span");
    orbit.className = className;
    orbit.setAttribute("aria-hidden", "true");
    orbit.style.cssText = `
      position:absolute;inset:0;pointer-events:none;opacity:0;
      animation:xzg-theme-ring-orbit 6s linear infinite;
    `;
    const glint = document.createElement("span");
    glint.style.cssText = `
      position:absolute;left:50%;top:.5px;width:4px;height:4px;border-radius:50%;
      transform:translate(-50%,-15%);
      background:radial-gradient(circle,rgba(255,255,245,1) 0%,rgba(255,244,195,.95) 28%,rgba(255,196,75,.62) 52%,rgba(255,190,60,0) 100%);
      filter:drop-shadow(0 0 2px rgba(255,224,140,.95));
    `;
    orbit.appendChild(glint);
    return orbit;
  };
  // 先扫 G 外环（图标原图），下一段扫 XZ 字母（第二段动画延迟到环扫完）。
  const ringGlint = makeGlint("xzg-theme-ring-orbit");
  const lettersSweep = document.createElement("span");
  lettersSweep.className = "xzg-theme-letters-sweep";
  lettersSweep.setAttribute("aria-hidden", "true");
  lettersSweep.style.cssText = `
    position:absolute;inset:0;opacity:0;pointer-events:none;
    clip-path:inset(25% 16% 24% 16%);
    background:linear-gradient(108deg,transparent 43%,rgba(255,247,205,.18) 48%,rgba(255,248,215,1) 50%,rgba(255,255,250,.5) 52%,transparent 57%);
    -webkit-mask-image:url("${iconUrl}");mask-image:url("${iconUrl}");
    -webkit-mask-size:100% 100%;mask-size:100% 100%;
    -webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;
    animation:xzg-theme-letters-sweep 6s linear infinite;
  `;
  iconWrap.append(icon, ringGlint, lettersSweep);
  btn.appendChild(iconWrap);
  btn.addEventListener("mouseenter", () => {
    btn.style.background = "var(--comfy-input-bg,#353535)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "transparent";
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const panel = window.XZGThemePanel;
    if (!panel) return;
    if (panel.isVisible) {
      panel.hide();
      return;
    }
    const manager = window.XZGThemeManager;
    const selectedNodes = manager?.getSelectedNodes?.() || [];
    if (selectedNodes.length > 0) manager.currentNodes = selectedNodes;
    if (manager?.showPanel) manager.showPanel();
    else panel.show();
  });
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const themePanel = window.XZGThemePanel;
    if (themePanel?.isVisible) themePanel.hide();
    showThemeContextMenu(btn);
  });
  return btn;
}

function revealXiaozhuguangSettings(attempt = 0) {
  const dialog = document.querySelector('[data-testid="settings-dialog"]');
  if (dialog) {
    const navItems = dialog.querySelectorAll("[data-nav-id], button, [role=button]");
    const xzgNav = [...navItems].find((item) =>
      /^(小珠光|xiaozhuguang)$/i.test(item.textContent?.trim() || "")
    );
    if (xzgNav && !xzgNav.matches("[aria-current=true], [data-active=true], .active")) {
      xzgNav.click();
    }
    const row = [...dialog.querySelectorAll('[data-setting-id^="xiaozhuguang."]')]
      .find((item) => item.getClientRects().length > 0);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
  }
  if (attempt < 60) setTimeout(() => revealXiaozhuguangSettings(attempt + 1), 100);
}

function injectMenuButton(retries) {
  const container = findMenuContainer();
  // 仅当容器已挂载到文档时注入；否则等下一次重试，
  // 否则 append 到 detached 容器会因 getElementById 探测不到而重复注入多个按钮
  if (container && container.isConnected) {
    if (!document.getElementById(XZG_BTN_ID)) {
      _menuBtn = buildMenuButton();
      container.appendChild(_menuBtn);
      _themeMenuBtn = buildThemeMenuButton();
      container.insertBefore(_themeMenuBtn, _menuBtn.nextSibling);
      refreshMenuBtn();
    }
    return;
  }
  if (retries < 30) {
    setTimeout(() => injectMenuButton(retries + 1), 300);
  }
}

// ---------------------------------------------------------------------------
// 设置项：启用/关闭 GPU/CPU 监控（与节点收藏器/工作流管理器同机制）
// ---------------------------------------------------------------------------

function isMonitorEnabled() {
  try {
    // 新版前端已废弃 getSettingValue 的第二个参数（默认值改由设置项定义提供）
    return app?.ui?.settings?.getSettingValue?.(SETTING_ENABLED) !== false;
  } catch (e) {
    return true;
  }
}

function registerMonitorSetting() {
  try {
    const settings = app?.ui?.settings;
    if (!settings?.addSetting) return;
    settings.addSetting({
      id: SETTING_ENABLED,
      name: "[小珠光] 启用「GPU/CPU 监控」",
      defaultValue: true,
      type: "boolean",
      onChange: (v) => setMonitorEnabled(!!v),
    });
  } catch (e) {
    console.warn("[小珠光] 注册 GPU/CPU 监控设置失败:", e);
  }
}

// 浮窗延迟创建后，工作流里的 XiaozhuguangSystemMonitor 节点可能已先加载完成：
// 按「显示悬浮窗」控件补一次显隐同步（与 beforeRegisterNodeDef 里 onNodeCreated 的 apply 等价）
function applyMonitorNodeState() {
  try {
    const nodes = (app.graph && app.graph.nodes) || [];
    for (const n of nodes) {
      if (!n || (n.type !== XZG_NODE_TYPE && n.comfyClass !== XZG_NODE_TYPE)) continue;
      const w = n.widgets ? n.widgets.find((x) => x.name === "show_float") : null;
      if (window.__xzgFloat) window.__xzgFloat.setVisible(w ? !!w.value : true);
      return;
    }
  } catch (e) {
    /* ignore */
  }
}

/** 设置项变更时调用：立即启用/关闭监控（顶部电池按钮 + 轮询） */
function setMonitorEnabled(v) {
  v = !!v;
  if (v) {
    // 启用：等待 UI 就绪（加载遮罩移除）后再创建/恢复浮窗轮询 + 注入顶部电池按钮，
    // 避免刷新时浮窗盖在加载画面上、先于主界面出现
    xzgWhenUiReady(() => {
      if (!isMonitorEnabled()) return; // 等待期间被关闭：放弃本次创建
      if (!_float) {
        window.__xzgFloat = createFloatWindow();
        _float = window.__xzgFloat;
        applyMonitorNodeState();
      } else {
        _float.root.style.display = _floatHidden ? "none" : "";
        _float.start();
      }
      injectMenuButton(0);
    });
  } else {
    // 关闭：移除顶部电池与主题按钮 + 停止轮询 + 隐藏所有浮窗（关闭监控）
    document.querySelectorAll("#" + XZG_BTN_ID).forEach((b) => b.remove());
    document.querySelectorAll("#" + XZG_THEME_BTN_ID).forEach((b) => b.remove());
    _menuBtn = null;
    _themeMenuBtn = null;
    document.querySelectorAll("#xzg-float").forEach((f) => {
      f.style.display = "none";
    });
    if (_float) _float.stop();
  }
}

// ---------------------------------------------------------------------------
// 注册扩展
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "Xiaozhuguang.SystemMonitor",
  setup() {
    // 防重复加载：同一页面只允许一个实例创建浮窗/按钮/注册设置
    if (window[MONITOR_SINGLETON]) return;
    window[MONITOR_SINGLETON] = true;
    // 右键菜单：点击菜单外 / Esc 关闭
    document.addEventListener("mousedown", (e) => {
      if (_menuEl && !_menuEl.contains(e.target) && e.target.id !== XZG_BTN_ID) closeContextMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeContextMenu();
    });
    // 注册「功能开关」设置项（与节点收藏器/工作流管理器同机制）
    registerMonitorSetting();
    // 工作流运行计时：事件监听始终注册（历史记录与浮窗显隐/监控开关无关）
    registerRunEvents();
    restoreMonitorDisplay();
    if (!isMonitorEnabled()) return; // 设置里关闭了监控：不创建浮窗、不注入顶部按钮、不轮询
    // 内部等待 UI 就绪（加载遮罩移除、主界面渲染完成）后再创建浮窗/注入顶部按钮
    setMonitorEnabled(true);
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== XZG_NODE_TYPE) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const widget = this.widgets ? this.widgets.find((w) => w.name === "show_float") : null;
      const apply = () => {
        if (window.__xzgFloat) window.__xzgFloat.setVisible(widget ? !!widget.value : true);
      };
      apply();
      if (widget && widget.callback == null) {
        widget.callback = () => apply();
      }
      return r;
    };
  },
});
