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
  { key: "cpu_util", label: "CPU 使用率", unit: "%", color: (v) => pctColor(v), get: (d) => d?.cpu?.util },
  { key: "mem_used", label: "内存占用", unit: "G", color: "#c99cff", get: (d) => d?.mem ? d.mem.used_mb / 1024 : null },
];
const XZG_DISPLAY_DEFAULT = {
  gpu_util: true,
  gpu_temp: true,
  gpu_vram: true,
  gpu_power: true,
  cpu_util: true,
  mem_used: true,
  run_timer: true,
  hist_open: false,
  panel_bg: true,
  compact: true,
  metric: "gpu_temp",
  orb_content: "metric",
  orb_size: 88,
  animation: "rainbow",
  capsule_palette: "classic",
  timer_effect: "white",
  timer_custom_color: "#65D6A6",
  chart_window: { width: 760, height: 560, left: null, top: null },
  chart_split: 0.70,
};
let _display = loadDisplay();
let _menuEl = null; // 右键设置菜单

function loadDisplay() {
  try {
    const raw = localStorage.getItem(XZG_DISPLAY_KEY);
    const s = { ...XZG_DISPLAY_DEFAULT, ...(JSON.parse(raw || "{}")) };
    delete s.cpu_temp;
    if (!MONITOR_METRICS.some((metric) => metric.key === s.metric)) s.metric = "gpu_temp";
    if (!["metric", "timer"].includes(s.orb_content)) s.orb_content = "metric";
    s.orb_size = Math.max(52, Math.min(180, Number(s.orb_size) || 88));
    delete s.orb_font_size; // 字号按圆球直径与内容宽度自动适配
    if (s.animation === "comet") s.animation = "scan";
    if (["stars", "nebula"].includes(s.animation)) s.animation = "blackhole";
    if (!["off", "rainbow", "pulse", "scan", "ripple", "blackhole"].includes(s.animation)) s.animation = "rainbow";
    if (s.capsule_palette === "ice" || !["classic", "aurora", "amber", "graphite"].includes(s.capsule_palette)) s.capsule_palette = "classic";
    if (!["white", "cyan", "green", "custom"].includes(s.timer_effect)) s.timer_effect = XZG_DISPLAY_DEFAULT.timer_effect;
    if (!/^#[0-9a-f]{6}$/i.test(s.timer_custom_color)) s.timer_custom_color = XZG_DISPLAY_DEFAULT.timer_custom_color;
    s.chart_window = normalizeChartWindow(s.chart_window);
    s.chart_split = normalizeChartSplit(s.chart_split);
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
  delete next.cpu_temp;
  if (!MONITOR_METRICS.some((metric) => metric.key === next.metric)) next.metric = "gpu_temp";
  if (!["metric", "timer"].includes(next.orb_content)) next.orb_content = "metric";
  next.orb_size = Math.max(52, Math.min(180, Number(next.orb_size) || 88));
  delete next.orb_font_size;
  if (next.animation === "comet") next.animation = "scan";
  if (["stars", "nebula"].includes(next.animation)) next.animation = "blackhole";
  if (!["off", "rainbow", "pulse", "scan", "ripple", "blackhole"].includes(next.animation)) next.animation = "rainbow";
  if (next.capsule_palette === "ice" || !["classic", "aurora", "amber", "graphite"].includes(next.capsule_palette)) next.capsule_palette = "classic";
  if (!["white", "cyan", "green", "custom"].includes(next.timer_effect)) next.timer_effect = XZG_DISPLAY_DEFAULT.timer_effect;
  if (!/^#[0-9a-f]{6}$/i.test(next.timer_custom_color)) next.timer_custom_color = XZG_DISPLAY_DEFAULT.timer_custom_color;
  next.chart_window = normalizeChartWindow(next.chart_window);
  next.chart_split = normalizeChartSplit(next.chart_split);
  next.compact = next.compact !== false;
  return next;
}

function normalizeChartWindow(value) {
  const defaults = XZG_DISPLAY_DEFAULT.chart_window;
  const source = value && typeof value === "object" ? value : {};
  const finiteOrNull = (v) => v == null || v === "" ? null : Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null;
  return {
    width: Math.max(480, Math.min(2400, Math.round(Number(source.width) || defaults.width))),
    height: Math.max(320, Math.min(1800, Math.round(Number(source.height) || defaults.height))),
    left: finiteOrNull(source.left),
    top: finiteOrNull(source.top),
  };
}

function normalizeChartSplit(value) {
  const split = Number(value);
  return Number.isFinite(split) ? Math.max(0.28, Math.min(0.82, split)) : XZG_DISPLAY_DEFAULT.chart_split;
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
/* 顶部系统监控图标：开启时双格，关闭时单格灰色 */
.xzg-monitor-icon{display:inline-flex;width:24px;height:18px;flex:none;color:rgb(205,165,109)!important;}
.xzg-monitor-icon svg{display:block;width:100%;height:100%;overflow:visible;}
.xzg-monitor-icon svg{fill:none!important;stroke:rgb(205,165,109)!important;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;}
.xzg-monitor-icon .xzg-batt-level{fill:rgb(205,165,109)!important;stroke:none!important;}
#xzg-monitor-menu-btn.xzg-mon-off .xzg-monitor-icon{color:#8b8f9a!important;}
#xzg-monitor-menu-btn.xzg-mon-off .xzg-monitor-icon svg{stroke:#8b8f9a!important;}
#xzg-monitor-menu-btn.xzg-mon-off .xzg-monitor-icon .xzg-batt-level{fill:#8b8f9a!important;}
/* 右键设置菜单 */
.xzg-menu{position:fixed;z-index:100000;min-width:158px;padding:4px;
  background:var(--comfy-menu-bg,#303030);border:1px solid var(--border-color,#555);
  border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,0.55);
  color:#e8e8e8;font:13px/1.4 'Segoe UI',system-ui,-apple-system,sans-serif;
  user-select:none;}
.xzg-menu-t{padding:4px 8px 5px;color:#9db2ff;font-weight:600;font-size:13px;
  margin-bottom:3px;}
.xzg-menu-sep{height:0;border-top:1px solid rgba(255,255,255,.10);margin:5px 4px;}
.xzg-menu-it{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:5px;cursor:pointer;}
.xzg-menu-it:hover{background:rgba(255,255,255,0.08);}
.xzg-menu-it .xzg-menu-box{display:inline-flex;align-items:center;justify-content:center;
  width:14px;height:14px;border:1px solid rgba(255,255,255,0.35);border-radius:3px;
  font-size:10px;line-height:1;color:transparent;flex:none;}
.xzg-menu-it.on{color:#ffd76a;}
.xzg-menu-it.on .xzg-menu-box{border-color:#d4af37;background:rgba(212,175,55,0.20);color:#ffd76a;}
.xzg-run-chart-window select,.xzg-run-chart-window select:focus{background-color:#303030!important;color:#eee!important;border:1px solid rgba(255,255,255,.24)!important;outline:none!important;box-shadow:none!important;}
.xzg-run-chart-window select option{background-color:#303030!important;color:#eee!important;}
.xzg-chart-split-handle::before{content:"";position:absolute;top:4px;bottom:4px;left:2px;width:2px;border-radius:2px;background:rgba(255,255,255,.28);transition:background .15s,transform .15s;}
.xzg-chart-split-handle:hover::before,.xzg-chart-split-handle:focus-visible::before{background:#DCC85B;transform:scaleX(1.5);}
.xzg-monitor-toolbar.xzg-compact{display:flex;align-items:center;gap:8px;flex:0 1 auto;min-width:0;max-width:min(76vw,760px);height:36px;padding:0 10px;box-sizing:border-box;border:1px solid transparent;border-radius:999px;background:linear-gradient(var(--xzg-capsule-bg,#171a20),var(--xzg-capsule-bg,#171a20)) padding-box,var(--xzg-capsule-edge,linear-gradient(90deg,#6d9fc5,#cda56d,#9582bd)) border-box;color:#e8e8e8;user-select:none;}
.xzg-monitor-toolbar.xzg-compact{--xzg-chip-text:#f2f5fa;--xzg-gpu-label:#84caff;--xzg-cpu-label:#e9bd70;--xzg-mem-label:#c7a6ef;
  --xzg-capsule-bg:#171c25;--xzg-capsule-edge:linear-gradient(100deg,#5698ca 0%,#718bb0 37%,#cda56d 68%,#9b83c1 100%);--xzg-capsule-separator:rgba(189,202,219,.27);}
.xzg-monitor-toolbar.xzg-palette-ice{--xzg-chip-text:#e4f7fc;--xzg-gpu-label:#8bd9f3;--xzg-cpu-label:#8fd5cc;--xzg-mem-label:#b5cafa;
  --xzg-capsule-bg:#12232b;--xzg-capsule-edge:linear-gradient(100deg,#46a9c7,#66c9d0,#9bc9ed);--xzg-capsule-separator:rgba(114,207,218,.3);}
.xzg-monitor-toolbar.xzg-palette-aurora{--xzg-chip-text:#f1edfa;--xzg-gpu-label:#c2aaff;--xzg-cpu-label:#76dfbd;--xzg-mem-label:#e59bd7;
  --xzg-capsule-bg:#211b30;--xzg-capsule-edge:linear-gradient(100deg,#9774df,#7a9fc5 48%,#55c9a2 100%);--xzg-capsule-separator:rgba(174,151,220,.3);}
.xzg-monitor-toolbar.xzg-palette-amber{--xzg-chip-text:#fff2df;--xzg-gpu-label:#f3b66e;--xzg-cpu-label:#ed8c72;--xzg-mem-label:#e3c27c;
  --xzg-capsule-bg:#2a201b;--xzg-capsule-edge:linear-gradient(100deg,#bd7544,#dfad59 52%,#b96556);--xzg-capsule-separator:rgba(223,173,89,.3);}
.xzg-monitor-toolbar.xzg-palette-graphite{--xzg-chip-text:#e7eaf0;--xzg-gpu-label:#b7c7d9;--xzg-cpu-label:#d4c1ae;--xzg-mem-label:#c2bfd2;
  --xzg-capsule-bg:#1b1f25;--xzg-capsule-edge:linear-gradient(100deg,#72849a,#a9b3bc 50%,#817f8e);--xzg-capsule-separator:rgba(179,190,203,.24);}
.xzg-monitor-toolbar.xzg-compact #xzg-toolbar-monitor-stats{min-width:0;max-width:calc(76vw - 68px);overflow-x:auto;scrollbar-width:none;}
.xzg-monitor-toolbar.xzg-compact #xzg-toolbar-monitor-stats::-webkit-scrollbar{display:none;}
.xzg-monitor-toolbar.xzg-orb #xzg-toolbar-monitor-stats{display:none;}
.xzg-monitor-toolbar.xzg-compact.xzg-has-monitor-stats:not(.xzg-orb) #xzg-toolbar-run-time{box-sizing:content-box;padding-right:10px;border-right:1px solid var(--xzg-capsule-separator);}
.xzg-monitor-toolbar.xzg-compact .xzg-cmp{display:flex;align-items:center;gap:8px;width:max-content;font-size:15px;line-height:1.6;white-space:nowrap;}
.xzg-monitor-toolbar.xzg-compact .xzg-cmp b{font-weight:600;}
.xzg-monitor-toolbar.xzg-compact .xzg-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 0;border:0;border-radius:0;background:transparent;cursor:default;}
.xzg-monitor-toolbar.xzg-compact .xzg-chip+.xzg-chip{margin-left:10px;padding-left:10px;border-left:1px solid var(--xzg-capsule-separator);}
.xzg-monitor-toolbar.xzg-compact .xzg-chip-gpu b{color:var(--xzg-gpu-label);}
.xzg-monitor-toolbar.xzg-compact .xzg-chip-cpu b{color:var(--xzg-cpu-label);}
.xzg-monitor-toolbar.xzg-compact .xzg-chip-mem b{color:var(--xzg-mem-label);}
.xzg-monitor-toolbar.xzg-compact .xzg-v{display:inline-block;position:relative;text-align:right;font-variant-numeric:tabular-nums;color:var(--xzg-chip-text);}
.xzg-monitor-toolbar.xzg-compact .xzg-v::after{content:"";position:absolute;inset:-6px -3px;}
.xzg-monitor-toolbar.xzg-compact .xzg-v[data-xzg-metric="gpu_vram"]{margin-left:-5px;}
.xzg-monitor-toolbar.xzg-compact .xzg-run-time{display:inline-block;min-width:54px;color:var(--xzg-timer-color,#DCC85B);font:600 20px/1 'Segoe UI',system-ui,sans-serif;font-variant-numeric:tabular-nums;text-align:center;white-space:nowrap;}
.xzg-monitor-toolbar.xzg-compact .xzg-run-time:not(.xzg-lcd){color:#fff;font-size:22px;filter:none;}
.xzg-monitor-toolbar.xzg-compact .xzg-run-time.xzg-lcd{display:inline-flex;align-items:center;gap:3px;min-width:60px;filter:none;transform:scale(.86);transform-origin:center;}
.xzg-run-time .xzg-lcd-digit{position:relative;display:inline-block;width:12px;height:22px;flex:none;}
.xzg-run-time .xzg-lcd-seg{position:absolute;display:block;background:transparent;border:1px solid transparent;border-radius:2px;box-sizing:border-box;}
.xzg-run-time .xzg-lcd-seg.on{background:var(--xzg-timer-color,#DCC85B);border-color:var(--xzg-timer-color,#DCC85B);box-shadow:0 0 3px var(--xzg-timer-glow-strong,rgba(220,200,91,.65)),0 0 7px var(--xzg-timer-glow,rgba(220,200,91,.34));}
.xzg-run-time .xzg-lcd-seg.a,.xzg-run-time .xzg-lcd-seg.g,.xzg-run-time .xzg-lcd-seg.d{left:2px;width:8px;height:3px;clip-path:polygon(18% 0,82% 0,100% 50%,82% 100%,18% 100%,0 50%);}
.xzg-run-time .xzg-lcd-seg.a{top:0}.xzg-run-time .xzg-lcd-seg.g{top:9px}.xzg-run-time .xzg-lcd-seg.d{bottom:0}
.xzg-run-time .xzg-lcd-seg.b,.xzg-run-time .xzg-lcd-seg.c,.xzg-run-time .xzg-lcd-seg.e,.xzg-run-time .xzg-lcd-seg.f{width:3px;height:8px;clip-path:polygon(0 18%,50% 0,100% 18%,100% 82%,50% 100%,0 82%);}
.xzg-run-time .xzg-lcd-seg.f{left:0;top:2px}.xzg-run-time .xzg-lcd-seg.b{right:0;top:2px}.xzg-run-time .xzg-lcd-seg.e{left:0;bottom:2px}.xzg-run-time .xzg-lcd-seg.c{right:0;bottom:2px}
.xzg-run-time .xzg-lcd-colon{height:22px;display:flex;flex-direction:column;justify-content:center;gap:5px;padding:0 1px;}
.xzg-run-time .xzg-lcd-colon i{width:3px;height:3px;border-radius:1px;background:var(--xzg-timer-color,#DCC85B);box-shadow:0 0 4px var(--xzg-timer-glow-strong,rgba(220,200,91,.6));animation:xzg-lcd-blink 1s steps(1,end) infinite;}
@keyframes xzg-lcd-blink{50%{opacity:0}}
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
#xzg-float.xzg-orb.xzg-orb-timer.xzg-no-timer-pulse.xzg-anim-pulse{animation:none;}
#xzg-float.xzg-orb .xzg-orb-value{animation:none;text-shadow:0 1px 2px rgba(0,0,0,.72);}
@media(prefers-reduced-motion:reduce){#xzg-float.xzg-orb::before,#xzg-float.xzg-orb::after,#xzg-float.xzg-orb .xzg-orb-value{animation:none!important}}
#xzg-float.xzg-orb .xzg-bd{padding:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
#xzg-float.xzg-orb #xzg-stats{width:100%;height:100%;display:flex;align-items:center;justify-content:center;}
#xzg-float.xzg-orb.xzg-orb-timer .xzg-bd{position:relative;display:flex;align-items:center;justify-content:center;}
#xzg-float.xzg-orb.xzg-orb-timer #xzg-stats{display:none;}
#xzg-float.xzg-orb.xzg-orb-timer #xzg-orb-run-time{display:inline-flex;align-items:center;justify-content:center;gap:3px;min-width:0;max-width:100%;height:100%;color:var(--xzg-timer-color,#F2F4F8);filter:none;transform:scale(var(--xzg-orb-content-scale,1));transition:transform .16s ease;}
#xzg-float.xzg-orb.xzg-orb-timer #xzg-orb-run-time:not(.xzg-lcd){display:block;font:700 var(--xzg-orb-auto-font,30px)/1 'Segoe UI',system-ui,sans-serif;color:#fff;filter:none;white-space:nowrap;transform:scaleX(var(--xzg-orb-timer-x-scale,1));transform-origin:center;transition:transform .16s ease;}
#xzg-float.xzg-orb .xzg-orb-value{font:700 var(--xzg-orb-auto-font,30px)/1 'Segoe UI',system-ui,sans-serif;
  font-variant-numeric:tabular-nums;letter-spacing:-.04em;white-space:nowrap;text-shadow:0 2px 10px #0009;}
#xzg-float.xzg-orb .xzg-orb-value.small{font-size:var(--xzg-orb-auto-font,30px);}
#xzg-float.xzg-orb .xzg-note{font-size:10px;padding:8px;text-align:center;}
`;

// ---------------------------------------------------------------------------
// 工作流运行计时（仅保留当前运行时长和最近一次时长）
// ---------------------------------------------------------------------------

// 运行状态（事件监听独立于浮窗显隐/监控开关）
const _run = { running: false, name: "", startTs: 0 };
let _lastRunDuration = 0;
let _onRunChange = null;
// 曲线记录保存到浏览器本机 IndexedDB，不写入 localStorage、云端或配置备份。
let _runRecordingEnabled = true;
let _activeRunMetrics = null;
let _lastRunMetrics = null;
let _currentRunNode = null;
let _runOwnerGraph = null;
const XZG_RUN_METRICS_MAX_SAMPLES = 7200; // 最多缓存两小时，每秒约一个点
const XZG_RUN_METRICS_HISTORY_LIMIT = 20;
const XZG_RUN_METRICS_DB_NAME = "xiaozhuguang-run-metrics";
const XZG_RUN_METRICS_DB_VERSION = 1;
let _runMetricsHistory = [];
let _runMetricsRestorePromise = Promise.resolve();
let _runMetricsDbPromise = null;
let _liveRunChartRefresh = null;

function openRunMetricsDb() {
  if (_runMetricsDbPromise) return _runMetricsDbPromise;
  _runMetricsDbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("浏览器不支持 IndexedDB"));
    const request = window.indexedDB.open(XZG_RUN_METRICS_DB_NAME, XZG_RUN_METRICS_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("runs")) db.createObjectStore("runs", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开曲线缓存"));
    request.onblocked = () => reject(new Error("曲线缓存升级被其他页面阻塞"));
  }).catch((error) => {
    _runMetricsDbPromise = null;
    throw error;
  });
  return _runMetricsDbPromise;
}

async function persistRunMetricsRecord(record) {
  if (!record?.id || !Array.isArray(record.samples) || record.samples.length < 2) return;
  try {
    const db = await openRunMetricsDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("runs", "readwrite");
      const store = transaction.objectStore("runs");
      store.put(record);
      const request = store.getAll();
      request.onsuccess = () => {
        const sorted = request.result.sort((a, b) => Number(b.startedAt) - Number(a.startedAt));
        for (const oldRecord of sorted.slice(XZG_RUN_METRICS_HISTORY_LIMIT)) store.delete(oldRecord.id);
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("保存曲线缓存失败"));
      transaction.onabort = () => reject(transaction.error || new Error("保存曲线缓存已取消"));
    });
  } catch (error) {
    console.warn("[小珠光] 本地曲线记录保存失败:", error);
  }
}

async function restoreRunMetricsHistory() {
  try {
    const db = await openRunMetricsDb();
    const records = await new Promise((resolve, reject) => {
      const transaction = db.transaction("runs", "readonly");
      const request = transaction.objectStore("runs").getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error("读取曲线缓存失败"));
    });
    const mergedRecords = new Map((records || []).map((record) => [record.id, record]));
    for (const record of _runMetricsHistory) mergedRecords.set(record.id, record);
    _runMetricsHistory = [...mergedRecords.values()]
      .filter((record) => Array.isArray(record.samples) && record.samples.length >= 2)
      .sort((a, b) => Number(b.startedAt) - Number(a.startedAt))
      .slice(0, XZG_RUN_METRICS_HISTORY_LIMIT);
    _lastRunMetrics = _runMetricsHistory[0] || null;
    _lastRunDuration = Number(_lastRunMetrics?.durationMs) || 0;
    for (const record of _runMetricsHistory) {
      if (record.status === "运行中") {
        record.status = "刷新前中断";
        await persistRunMetricsRecord(record);
      }
    }
  } catch (error) {
    console.warn("[小珠光] 本地曲线记录读取失败:", error);
  }
}

function finalizeActiveRunMetrics(status, finishedAt = Date.now()) {
  const record = _activeRunMetrics;
  if (!record) return null;
  record.durationMs = Math.max(0, finishedAt - record.startedAt);
  record.finishedAt = finishedAt;
  record.status = status;
  _activeRunMetrics = null;
  if (record.samples.length < 2) return record;
  _runMetricsHistory = [record, ..._runMetricsHistory.filter((item) => item.id !== record.id)]
    .sort((a, b) => Number(b.startedAt) - Number(a.startedAt))
    .slice(0, XZG_RUN_METRICS_HISTORY_LIMIT);
  _lastRunMetrics = record;
  void persistRunMetricsRecord(record);
  try { _liveRunChartRefresh?.(); } catch (error) { console.warn("[小珠光] 实时曲线刷新失败:", error); }
  return record;
}

function captureRunMetrics(data) {
  if (!_runRecordingEnabled || !_run.running || !_activeRunMetrics || !data) return;
  const sourceTime = Number(data.time) || 0;
  if (sourceTime && sourceTime === _activeRunMetrics.lastSourceTime) return;
  const now = Date.now();
  if (now - _activeRunMetrics.lastCapturedAt < 850) return;
  _activeRunMetrics.lastCapturedAt = now;
  if (_activeRunMetrics.samples.length >= XZG_RUN_METRICS_MAX_SAMPLES) return;
  _activeRunMetrics.lastSourceTime = sourceTime;
  const gpus = Array.isArray(data.gpu?.gpus) ? data.gpu.gpus : [];
  if (!_activeRunMetrics.gpuNames.length && gpus.length) {
    _activeRunMetrics.gpuNames = gpus.map((gpu, index) => String(gpu?.name || `GPU ${index}`));
    _activeRunMetrics.gpuIds = gpus.map((gpu, index) => String(gpu?.index ?? index));
  }
  const cpu = data.cpu || {};
  const mem = data.mem || {};
  // 只归属到 executing 事件确认仍处于执行中的节点；不要用可能滞留的 runningNodeId。
  const executionId = _currentRunNode?.id ?? null;
  const activeNode = executionId != null ? resolveExecutionNode(executionId) : null;
  const sampledNode = activeNode
    ? { id: String(executionId), title: activeNode.title }
    : (_currentRunNode ? { ..._currentRunNode } : null);
  _activeRunMetrics.samples.push([
    Math.max(0, now - _activeRunMetrics.startedAt),
    gpus.map((gpu) => [gpu?.util, gpu?.temp, gpu?.vram_used_mb, gpu?.power_w]),
    [cpu.util, mem.used_mb],
    sampledNode,
  ]);
  try { _liveRunChartRefresh?.(); } catch (error) { console.warn("[小珠光] 实时曲线刷新失败:", error); }
}

function resolveExecutionNode(executionId) {
  const parts = String(executionId).split(":").filter(Boolean);
  let graph = _runOwnerGraph || app.graph;
  let node = null;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    node = graph?.getNodeById?.(Number(part))
      || graph?._nodes?.find((item) => String(item.id) === part)
      || null;
    if (!node) return null;
    if (index < parts.length - 1) {
      graph = node.subgraph || node.subgraphNode?.graph || null;
      if (!graph) return null;
    }
  }
  if (!node) return null;
  const title = node.title
    || node.constructor?.nodeData?.display_name
    || node.nodeData?.display_name
    || node.comfyClass
    || node.type
    || node.constructor?.type
    || "节点";
  return { node, id: String(node.id), title: String(title) };
}

function beginRunMetricsCapture(startedAt = Date.now()) {
  _activeRunMetrics = {
    id: `${startedAt}-${Math.random().toString(36).slice(2, 9)}`,
    workflowName: _run.name || "工作流",
    schemaVersion: 3,
    startedAt,
    status: "运行中",
    lastSourceTime: 0,
    lastCapturedAt: 0,
    gpuNames: [],
    gpuIds: [],
    samples: [],
  };
  _currentRunNode = null;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

function runMetricsDurationMs(record) {
  if (!record) return null;
  const duration = Number(record.durationMs);
  if (Number.isFinite(duration)) return Math.max(0, duration);
  const sampledDuration = Number(record.samples?.at(-1)?.[0]);
  return Number.isFinite(sampledDuration) ? Math.max(0, sampledDuration) : 0;
}

function formatRunDurationDelta(deltaMs) {
  if (!Number.isFinite(Number(deltaMs))) return "--";
  const seconds = Math.round(Number(deltaMs) / 1000);
  return `${seconds > 0 ? "+" : ""}${seconds}秒`;
}

function updateRunTimerButton() {
  const elapsedMs = _run.running ? Date.now() - _run.startTs : _lastRunDuration;
  const orbTimerEffect = _display.timer_effect === "none" ? XZG_DISPLAY_DEFAULT.timer_effect : _display.timer_effect;
  if (_runTimerBtn) {
    const time = _runTimerBtn.querySelector("#xzg-toolbar-run-time");
    if (time) {
      time.style.display = _display.run_timer === false ? "none" : "";
      const value = fmtDur(elapsedMs);
      if (_display.timer_effect === "none") {
        time.classList.remove("xzg-lcd");
        time.textContent = value;
      } else {
        time.classList.add("xzg-lcd");
        time.innerHTML = renderLcdTime(value);
      }
    }
  }
  const orbTime = _float?.root?.querySelector("#xzg-orb-run-time");
  if (orbTime && _display.orb_content === "timer") {
    const seconds = String(Math.floor(elapsedMs / 1000));
    const size = _display.orb_size || 88;
    if (_display.timer_effect === "none") {
      // 无特效模式字号固定跟随球径；位数增加时仅压缩横向字宽，避免字号跳变。
      const autoFont = size * .42;
      const textWidth = seconds.length * autoFont * .62;
      const horizontalScale = Math.min(1, (size * .68) / Math.max(1, textWidth));
      _float.root.style.setProperty("--xzg-orb-auto-font", `${autoFont}px`);
      _float.root.style.setProperty("--xzg-orb-timer-x-scale", String(horizontalScale));
      orbTime.classList.remove("xzg-lcd");
      orbTime.textContent = seconds;
    } else {
      const rawWidth = seconds.length * 12 + Math.max(0, seconds.length - 1) * 3;
      // 按圆球直径和秒数位数共同缩放，不设固定最大倍率，避免圆球变大后数字停在原尺寸。
      const scale = Math.min((size * .68) / rawWidth, (size * .48) / 22);
      _float.root.style.setProperty("--xzg-orb-content-scale", String(Math.max(.2, scale)));
      orbTime.classList.add("xzg-lcd");
      orbTime.innerHTML = renderLcdTime(seconds);
    }
  }
}

const XZG_TIMER_EFFECTS = {
  violet: { color: "#D98BFF", dim: .13, glow: .38, activeGlow: .68 },
  ice: { color: "#8AB4F8", dim: .13, glow: .38, activeGlow: .68 },
  cyan: { color: "#55DDE0", dim: .15, glow: .42, activeGlow: .72 },
  green: { color: "#65D6A6", dim: .13, glow: .36, activeGlow: .65 },
  green: { color: "#65D6A6", dim: .13, glow: .36, activeGlow: .65 },
  white: { color: "#F2F4F8", dim: .12, glow: .32, activeGlow: .58 },
};

function applyTimerEffect() {
  if (!_runTimerBtn && !_float?.root) return;
  if (_float?.root) {
    _float.root.classList.remove("xzg-no-timer-pulse");
  }
  updateRunTimerButton();
  const effect = _display.timer_effect === "custom"
    ? { color: _display.timer_custom_color, dim: .13, glow: .38, activeGlow: .68 }
    : (XZG_TIMER_EFFECTS[_display.timer_effect] || XZG_TIMER_EFFECTS.white);
  const color = effect.color;
  const channels = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!channels) return;
  const [, r, g, b] = channels.map((part, index) => index ? parseInt(part, 16) : part);
  const rgba = (alpha) => `rgba(${r},${g},${b},${alpha})`;
  for (const host of [_runTimerBtn, _float?.root]) {
    if (!host) continue;
    host.style.setProperty("--xzg-timer-color", color);
    host.style.setProperty("--xzg-timer-dim", rgba(effect.dim));
    host.style.setProperty("--xzg-timer-dim-border", rgba(.12));
    host.style.setProperty("--xzg-timer-glow", rgba(effect.glow));
    host.style.setProperty("--xzg-timer-glow-strong", rgba(effect.activeGlow));
  }
}

const XZG_LCD_SEGMENTS = {
  "0": "ab cdef".replace(/ /g, ""), "1": "bc", "2": "abged", "3": "abgcd",
  "4": "fgbc", "5": "afgcd", "6": "afgecd", "7": "abc", "8": "abcdefg", "9": "abfgcd",
};

function renderLcdTime(value) {
  return [...String(value)].map((char) => {
    if (char === ":") return `<span class="xzg-lcd-colon" aria-hidden="true"><i></i><i></i></span>`;
    const active = XZG_LCD_SEGMENTS[char] || "";
    return `<span class="xzg-lcd-digit" role="img" aria-label="${char}">${[..."abcdefg"].map((seg) =>
      `<i class="xzg-lcd-seg ${seg}${active.includes(seg) ? " on" : ""}"></i>`).join("")}</span>`;
  }).join("");
}

// 从顶部当前激活的工作流标签读取名称，兼容官方标签栏和小珠光接管后的标签栏。
function resolveWorkflowName() {
  try {
    const activeTab = document.querySelector(
      ".xzg-owned-workflow-tab.active, " +
      '[data-testid="topbar-workflow-tabs"] [data-testid="workflow-tab"][aria-selected="true"], ' +
      '[data-testid="topbar-workflow-tabs"] [data-testid="workflow-tab"].active, ' +
      '[data-testid="topbar-workflow-tabs"] .workflow-tab[aria-selected="true"], ' +
      '[data-testid="topbar-workflow-tabs"] .workflow-tab.active'
    );
    if (!activeTab) return "";
    const label = activeTab.querySelector(".xzg-owned-workflow-tab-label")
      || activeTab.querySelector('[data-testid="workflow-tab-name"], .workflow-tab-name, .tab-label');
    return String(label?.textContent || activeTab.getAttribute("aria-label") || activeTab.textContent || "")
      .replace(/\s*×\s*$/, "")
      .trim()
      .replace(/\.json$/i, "");
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

function displayNodeId(id) {
  const parts = String(id ?? "").split(":").filter(Boolean);
  return parts.at(-1) || String(id ?? "");
}

function startRun() {
  if (_run.running) return;
  _activeRunMetrics = null;
  _run.running = true;
  _run.name = resolveWorkflowName(); // 起跑时冻结工作流名
  _run.startTs = Date.now();
  _runOwnerGraph = app.graph || null;
  _currentRunNode = null;
  if (_runRecordingEnabled) beginRunMetricsCapture(_run.startTs);
  // 保持已打开的曲线窗口，并立即切到本次工作流的实时记录。
  try { _liveRunChartRefresh?.(); } catch (error) { console.warn("[小珠光] 实时曲线切换失败:", error); }
  if (_onRunChange) _onRunChange();
}

function stopRun(status) {
  if (!_run.running) return;
  _run.running = false;
  const end = Date.now();
  _lastRunDuration = Math.max(0, end - _run.startTs);
  finalizeActiveRunMetrics(status, end);
  _run.startTs = 0;
  if (_onRunChange) _onRunChange();
}

function registerRunEvents() {
  _onRunChange = updateRunTimerButton;
  _runMetricsRestorePromise = restoreRunMetricsHistory();
  setInterval(updateRunTimerButton, 1000);
  // 工作流开始：每个 prompt 启动时触发
  api.addEventListener("execution_start", () => startRun());
  // 兜底：错过 execution_start（如页面刷新时恰在执行中）以首个执行节点为起点
  const onExecuting = (e) => {
    const detail = e?.detail;
    let eventNodeTitle = detail && typeof detail === "object"
      ? (detail.node_title ?? detail.nodeTitle ?? detail.node_name ?? detail.nodeName ?? detail.title)
      : null;
    let rawNodeId = detail && typeof detail === "object"
      ? (detail.node_id ?? detail.nodeId ?? detail.node ?? detail.display_node)
      : detail;
    let rawDisplayNodeId = detail && typeof detail === "object" ? detail.display_node : null;
    if (rawNodeId && typeof rawNodeId === "object") {
      eventNodeTitle ||= rawNodeId.title ?? rawNodeId.name ?? rawNodeId.type ?? null;
      rawNodeId = rawNodeId.id ?? rawNodeId.node_id ?? rawNodeId.nodeId ?? null;
    }
    if (rawDisplayNodeId && typeof rawDisplayNodeId === "object") {
      rawDisplayNodeId = rawDisplayNodeId.id ?? rawDisplayNodeId.node_id ?? rawDisplayNodeId.nodeId ?? null;
    }
    const nodeId = rawNodeId == null || rawNodeId === "" ? null : String(rawNodeId);
    const displayNodeId = rawDisplayNodeId == null || rawDisplayNodeId === "" ? null : String(rawDisplayNodeId);
    // ComfyUI 常见事件详情是裸节点 ID；不能只检查 detail.node，否则错过 execution_start
    // 的页面刷新恢复场景会漏掉节点记录。
    if (nodeId != null && !_run.running) startRun();
    if (!_run.running) return;
    if (nodeId == null) {
      _currentRunNode = null;
      return;
    }
    // 子图执行 ID 可能是“容器节点:内部节点”多段路径；优先解析执行节点，
    // 如果运行时 ID 是临时节点或不可见节点，则回退到 ComfyUI 提供的 display_node。
    const resolved = resolveExecutionNode(nodeId);
    const resolvedDisplay = displayNodeId && displayNodeId !== nodeId ? resolveExecutionNode(displayNodeId) : null;
    const resolvedNode = resolved || resolvedDisplay;
    const node = resolvedNode?.node;
    const title = resolved?.title
      || eventNodeTitle
      || resolvedDisplay?.title
      || node?.title
      || node?.constructor?.nodeData?.display_name
      || node?.nodeData?.display_name
      || node?.comfyClass
      || node?.type
      || node?.constructor?.type
      || "节点";
    _currentRunNode = { id: resolved ? nodeId : (resolvedDisplay ? displayNodeId : nodeId), title: String(title) };
  };
  const executionEmitters = new Set([api, app.api].filter((emitter) => typeof emitter?.addEventListener === "function"));
  for (const emitter of executionEmitters) emitter.addEventListener("executing", onExecuting);
  // 节点完成后立即结束其采样区间，避免 Lazy/惰性节点在等待下游期间持续占有时间轴。
  const onExecuted = (e) => {
    if (!_run.running || !_currentRunNode) return;
    const detail = e?.detail;
    const finishedId = detail && typeof detail === "object"
      ? (detail.node_id ?? detail.nodeId ?? detail.node)
      : detail;
    if (finishedId == null || finishedId === "") return;
    const finished = typeof finishedId === "object"
      ? (finishedId.id ?? finishedId.node_id ?? finishedId.nodeId)
      : finishedId;
    if (finished != null && String(finished) === String(_currentRunNode.id)) _currentRunNode = null;
  };
  for (const emitter of executionEmitters) emitter.addEventListener("executed", onExecuted);
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
  // 系统监控重新启用时默认恢复显示；隐藏状态由本会话电池按钮管理。
  let hidden = false;
  _floatHidden = hidden;

  const root = document.createElement("div");
  root.id = "xzg-float";
  root.classList.add("xzg-bg");
  root.classList.toggle("xzg-orb", !_display.compact);
  root.classList.toggle("xzg-compact", _display.compact);
  root.classList.add(`xzg-anim-${_display.animation || "rainbow"}`);
  root.classList.add(`xzg-palette-${_display.capsule_palette || "classic"}`);
  root.style.setProperty("--xzg-orb-size", `${_display.orb_size}px`);
  root.style.setProperty("--xzg-orb-auto-font", `${_display.orb_size * .34}px`);
  root.style.display = "none"; // 监控 UI 显示在顶部工具栏，保留隐藏采集宿主用于复用轮询逻辑。
  // 首次监控请求完成前不展示空容器；否则紧凑模式会短暂呈现为空的小椭圆。
  root.style.visibility = "hidden";
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
    // 右键悬浮球：直接弹出该指标对应的曲线观察窗口，而非设置面板。
    const metricKey = _display.metric || "gpu_util";
    const gpuChartMetric = { gpu_util: 0, gpu_temp: 1, gpu_vram: 2, gpu_power: 3 };
    const otherChartMetric = { cpu_util: 0, mem_used: 1 };
    const isGpu = metricKey.startsWith("gpu_");
    const metricIndex = isGpu ? (gpuChartMetric[metricKey] ?? 0) : (otherChartMetric[metricKey] ?? 0);
    const chartKey = isGpu ? `gpu:0:${metricIndex}` : `cpu:${metricIndex}`;
    showContextMenu(root, { chartKey, metricKey });
  });

  const body = root.querySelector(".xzg-bd");
  body.innerHTML = `<div id="xzg-stats"></div><div id="xzg-orb-run-time" class="xzg-run-time" style="display:none"></div>`;
  const statsEl = body.querySelector("#xzg-stats");
  const orbTimerEl = body.querySelector("#xzg-orb-run-time");
  let toolbarStatsHost = null;
  let toolbarHadStats = false;
  let toolbarTimeHost = null;
  let toolbarHadTime = false;
  function moveStatsToToolbar() {
    if (!toolbarStatsHost || !toolbarHadStats) return;
    toolbarStatsHost.appendChild(statsEl);
    if (_runTimerBtn && toolbarTimeHost && toolbarHadTime) _runTimerBtn.insertBefore(toolbarTimeHost, _runTimerBtn.firstChild);
  }
  function moveStatsToOrb() {
    if (!toolbarStatsHost || !toolbarHadStats) return;
    body.appendChild(statsEl);
    if (toolbarTimeHost && toolbarHadTime) toolbarTimeHost.remove();
  }
  function applyDisplayMode() {
    const orb = !_display.compact;
    root.classList.toggle("xzg-orb", orb);
    root.classList.toggle("xzg-compact", !orb);
    if (_runTimerBtn) {
      _runTimerBtn.classList.toggle("xzg-orb", orb);
      _runTimerBtn.classList.toggle("xzg-compact", !orb);
    }
    if (orb) {
      const timerOrb = _display.orb_content === "timer";
      root.classList.toggle("xzg-orb-timer", timerOrb);
      if (timerOrb) {
        if (toolbarStatsHost && toolbarHadStats) toolbarStatsHost.appendChild(statsEl);
        if (toolbarTimeHost && toolbarHadTime) toolbarTimeHost.remove();
        orbTimerEl.style.display = "inline-flex";
        updateRunTimerButton();
      } else {
        moveStatsToOrb();
    orbTimerEl.style.display = "none";
      }
      if (_runTimerBtn) _runTimerBtn.style.display = "none";
      root.style.display = _floatHidden || !_monitorInitialized ? "none" : "flex";
    } else {
      root.classList.remove("xzg-orb-timer");
      orbTimerEl.style.display = "none";
      root.style.display = "none";
      if (_runTimerBtn) _runTimerBtn.style.display = _floatHidden || !_monitorInitialized ? "none" : "flex";
      moveStatsToToolbar();
    }
  }
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
    root.style.display = !_display.compact && v && _monitorInitialized ? "flex" : "none";
    if (_runTimerBtn) _runTimerBtn.style.display = v && _display.compact && _monitorInitialized ? "flex" : "none";
    _floatHidden = hidden;
    // 不持久化隐藏状态，避免一次误操作导致之后每次启动都看不到监控。
    refreshMenuBtn();
    if (v) poll(); // 打开时立即刷新一次数据
  }

  function resizeOrb(size) {
    const orbVisible = root.classList.contains("xzg-orb") && root.style.display !== "none";
    const rect = orbVisible ? root.getBoundingClientRect() : null;
    const centerX = rect ? rect.left + rect.width / 2 : 0;
    const centerY = rect ? rect.top + rect.height / 2 : 0;
    _display.orb_size = Math.max(52, Math.min(180, Number(size) || 88));
    root.style.setProperty("--xzg-orb-size", `${_display.orb_size}px`);
    root.style.setProperty("--xzg-orb-auto-font", `${_display.orb_size * .34}px`);
    if (rect) {
      root.style.left = `${centerX - _display.orb_size / 2}px`;
      root.style.top = `${centerY - _display.orb_size / 2}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
      _posDragged = true;
      saveStore({ ...loadStore(), left: root.style.left, top: root.style.top, posVer: XZG_POS_VER });
      queueCloudSavePos();
    }
    saveDisplay();
    if (_lastData) render(_lastData);
    updateRunTimerButton();
  }

  function setMetric(key) {
    if (key && MONITOR_METRICS.some((metric) => metric.key === key)) _display.metric = key;
    _display.compact = false;
    _display.orb_content = "metric";
    saveDisplay();
    applyDisplayMode();
    applyOrbAnimation();
    root.style.setProperty("--xzg-orb-size", `${_display.orb_size}px`);
    if (_lastData) render(_lastData);
  }

  function toggleCompact() {
    _display.compact = !_display.compact;
    saveDisplay();
    applyDisplayMode();
    if (!_display.compact) applyOrbAnimation();
    if (_lastData) render(_lastData);
  }

  function showTimerOrb() {
    _display.compact = false;
    _display.orb_content = "timer";
    saveDisplay();
    applyDisplayMode();
    applyOrbAnimation();
    applyTimerEffect();
    root.style.setProperty("--xzg-orb-size", `${_display.orb_size}px`);
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
    if (!_display.compact) {
      event.preventDefault();
      event.stopPropagation();
      toggleCompact();
      return;
    }
    const chip = event.target.closest("[data-xzg-metric]");
    if (!chip) return;
    event.preventDefault();
    event.stopPropagation();
    setMetric(chip.dataset.xzgMetric);
  });
  statsEl.addEventListener("contextmenu", async (event) => {
    const parameter = event.target.closest("[data-xzg-metric]");
    if (!parameter) return;
    event.preventDefault();
    event.stopPropagation();
    await _runMetricsRestorePromise;
    const key = parameter.dataset.xzgMetric;
    const gpuChartMetric = { gpu_util: 0, gpu_temp: 1, gpu_vram: 2, gpu_power: 3 };
    const otherChartMetric = { cpu_util: 0, mem_used: 1 };
    const metricIndex = key.startsWith("gpu_") ? (gpuChartMetric[key] ?? 0) : (otherChartMetric[key] ?? 0);
    const gpuId = parameter.dataset.xzgGpuIndex || "0";
    const latestRun = _activeRunMetrics || _runMetricsHistory[0] || _lastRunMetrics;
    const gpuPosition = latestRun?.gpuIds?.findIndex((id) => String(id) === String(gpuId)) ?? 0;
    const schemaVersion = Number(latestRun?.schemaVersion) || 1;
    const cpuSampleIndex = schemaVersion >= 3 ? metricIndex : schemaVersion >= 2 ? (metricIndex === 1 ? 2 : metricIndex) : (metricIndex === 1 ? 3 : metricIndex);
    const hasTwoSamples = (latestRun?.samples || []).filter((sample) => {
      const value = key.startsWith("gpu_") ? sample[1]?.[Math.max(0, gpuPosition)]?.[metricIndex] : sample[2]?.[cpuSampleIndex];
      return value != null && Number.isFinite(Number(value));
    }).length >= 2;
    if (!hasTwoSamples) return;
    const chartKey = key.startsWith("gpu_") ? `gpu:${gpuId}:${metricIndex}` : `cpu:${metricIndex}`;
    showContextMenu(parameter, { chartKey, metricKey: key });
  });

  function renderCompact(data) {
    const valueHtml = (key, value, unit, color, minCh = 4.6, decimals = 0, gpuIndex = null) => {
      if (!_display[key]) return "";
      const valid = value != null && !Number.isNaN(Number(value));
      const text = valid ? `${Number(value).toFixed(decimals)}${unit}` : "--";
      const gpuAttr = gpuIndex == null ? "" : ` data-xzg-gpu-index="${esc(gpuIndex)}"`;
      return `<span class="xzg-v" data-xzg-metric="${key}"${gpuAttr} style="min-width:${minCh}ch;color:${valid ? color : "#8b8f9a"}">${text}</span>`;
    };
    const parts = [];
    const gpus = data?.gpu?.gpus || [];
    if (gpus.length) {
      const multi = gpus.length > 1;
      for (const [gpuPosition, gpu] of gpus.entries()) {
        const gpuIndex = String(gpu.index ?? gpuPosition);
        let values = "";
        if (_display.gpu_util) values += valueHtml("gpu_util", gpu.util, "%", pctColor(gpu.util, gpu.temp), 4.6, 0, gpuIndex);
        if (_display.gpu_temp) values += valueHtml("gpu_temp", gpu.temp, "°", pctColor(0, gpu.temp), 4.2, 0, gpuIndex);
        if (_display.gpu_vram) {
          const pair = fmtMemPair(gpu.vram_used_mb, gpu.vram_total_mb);
          values += `<span class="xzg-v" data-xzg-metric="gpu_vram" data-xzg-gpu-index="${esc(gpuIndex)}" style="min-width:6.5ch">${pair}</span>`;
        }
        if (_display.gpu_power && gpu.power_w != null) values += valueHtml("gpu_power", gpu.power_w, "W", "#ffd666", 5.5, 0, gpuIndex);
        if (values) parts.push(`<span class="xzg-chip xzg-chip-gpu"><b>GPU${multi ? gpu.index ?? "" : ""}</b>${values}</span>`);
      }
    } else if (_display.gpu_util || _display.gpu_temp || _display.gpu_vram || _display.gpu_power) {
      parts.push(`<span class="xzg-chip xzg-chip-gpu"><b>GPU</b><span style="color:#8b8f9a">--</span></span>`);
    }
    const cpu = data?.cpu || {};
    let cpuValues = "";
    if (_display.cpu_util) {
      const cpuUtil = cpu.util == null ? null : Math.max(0, Math.min(100, Number(cpu.util)));
      cpuValues += valueHtml("cpu_util", cpuUtil, "%", pctColor(cpuUtil));
    }
    if (cpuValues) parts.push(`<span class="xzg-chip xzg-chip-cpu"><b>CPU</b>${cpuValues}</span>`);
    if (_display.mem_used && data?.mem) {
      parts.push(`<span class="xzg-chip xzg-chip-mem"><b>内存</b><span class="xzg-v" data-xzg-metric="mem_used">${fmtMemPair(data.mem.used_mb, data.mem.total_mb)}</span></span>`);
    }
    _runTimerBtn?.classList.toggle("xzg-has-monitor-stats", parts.length > 0);
    const content = parts.join("") || (_display.run_timer !== false ? "" : "<span style='color:#8b8f9a'>无可显示项目</span>");
    return `<div class="xzg-cmp">${content}</div>`;
  }

  let _lastData = null;
  function render(data) {
    _lastData = data;
    captureRunMetrics(data);
    const firstResponse = !_monitorInitialized;
    _monitorInitialized = true;

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
          // 内存/显存在悬浮球上省略单位字母 G（只显示数字，如 7.8），字符更短字号更大。
          shown = metric.key === "gpu_vram" || metric.key === "mem_used" ? number.toFixed(1)
            : metric.unit === "°C" ? `${number.toFixed(0)}°` : `${number.toFixed(0)}${metric.unit}`;
        }
        const small = shown.length > 5 ? " small" : "";
        const size = _display.orb_size || 88;
        // 内存/显存数值带小数与单位（如 7.8GB），文本较长易被压缩偏小，加大其字体上限与宽度余量。
        const isMem = metric.key === "gpu_vram" || metric.key === "mem_used";
        const fontCap = isMem ? size * .44 : size * .38;
        const widthBudget = isMem ? size * .78 : size * .72;
        const autoFont = Math.max(9, Math.min(fontCap, widthBudget / (Math.max(1, shown.length) * .62)));
        root.style.setProperty("--xzg-orb-auto-font", `${autoFont}px`);
        const color = valid ? (typeof metric.color === "function" ? metric.color(Number(value), data) : metric.color) : "#8b8f9a";
        statsEl.innerHTML = `<div class="xzg-orb-value${small}" data-xzg-metric="${metric.key}"${metric.key.startsWith("gpu_") ? ' data-xzg-gpu-index="0"' : ""} title="${esc(metric.label)}" style="color:${color}">${shown}</div>`;
      }
    } catch (e) {
      // 渲染出错时显示提示，避免内容区静默空白
      statsEl.innerHTML = `<div class="xzg-note">⚠ 渲染出错: ${esc(e && e.message ? e.message : e)}</div>`;
    }
    // 在布局与内容都已就绪后一次性显示，避免刷新时闪过空胶囊。
    root.style.visibility = "visible";
    if (firstResponse) {
      if (_runTimerBtn) _runTimerBtn.style.visibility = "visible";
      applyDisplayMode();
    }
  }

  function renderOffline() {
    const firstResponse = !_monitorInitialized;
    _monitorInitialized = true;

    statsEl.innerHTML = _display.compact
      ? `<div class="xzg-cmp"><span style="color:#8b8f9a">连接中…</span></div>`
      : `<div class="xzg-orb-value" style="color:#8b8f9a" title="等待连接">--</div>`;
    root.style.visibility = "visible";
    if (firstResponse) {
      if (_runTimerBtn) _runTimerBtn.style.visibility = "visible";
      applyDisplayMode();
    }
  }

  async function poll() {
    if (hidden && !(_runRecordingEnabled && _run.running)) return;
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
    setToolbarHosts(statsHost, timeHost) {
      toolbarStatsHost = statsHost;
      toolbarHadStats = !!statsHost;
      if (timeHost) {
        toolbarTimeHost = timeHost;
        toolbarHadTime = true;
        if (!timeHost.dataset.xzgTimerDblClickBound) {
          timeHost.dataset.xzgTimerDblClickBound = "1";
          timeHost.addEventListener("dblclick", (event) => {
            event.preventDefault();
            event.stopPropagation();
            showTimerOrb();
          });
        }
      }
      applyDisplayMode();
    },
    showTimerOrb,
    resizeOrb,
    setAnimation(value) {
      _display.animation = value;
      saveDisplay();
      applyOrbAnimation();
    },
    rerender() {
      applyDisplayMode();
      root.classList.toggle("xzg-orb", !_display.compact);
      root.classList.toggle("xzg-compact", _display.compact);
      root.classList.remove("xzg-palette-classic", "xzg-palette-ice", "xzg-palette-aurora", "xzg-palette-amber", "xzg-palette-graphite");
      root.classList.add(`xzg-palette-${_display.capsule_palette || "classic"}`);
      if (_runTimerBtn) {
        _runTimerBtn.classList.toggle("xzg-orb", !_display.compact);
        _runTimerBtn.classList.toggle("xzg-compact", _display.compact);
        _runTimerBtn.classList.remove("xzg-palette-classic", "xzg-palette-ice", "xzg-palette-aurora", "xzg-palette-amber", "xzg-palette-graphite");
        _runTimerBtn.classList.add(`xzg-palette-${_display.capsule_palette || "classic"}`);
      }
      applyTimerEffect();
      if (!_display.compact) applyOrbAnimation();
      root.style.setProperty("--xzg-orb-size", `${_display.orb_size}px`);
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
const XZG_RUN_TIMER_BTN_ID = "xzg-run-timer-menu-btn";
let _float = null;       // 悬浮窗实例
let _floatHidden = false; // 悬浮窗当前是否隐藏
let _monitorInitialized = false; // 首次系统监测响应完成前隐藏时间/监控 UI
let _menuBtn = null;     // 顶部栏按钮
let _themeMenuBtn = null;
let _runTimerBtn = null;
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
  const off = _menuBtn.classList.contains("xzg-mon-off");
  const enabledIcon = _menuBtn.querySelector(".xzg-batt-on");
  const disabledIcon = _menuBtn.querySelector(".xzg-batt-off");
  if (enabledIcon && disabledIcon) {
    enabledIcon.style.display = off ? "none" : "block";
    disabledIcon.style.display = off ? "block" : "none";
  }
}

function closeContextMenu() {
  if (_menuEl) {
    if (_menuEl._xzgOutsideHandler) document.removeEventListener("pointerdown", _menuEl._xzgOutsideHandler, true);
    if (_menuEl._xzgKeyHandler) document.removeEventListener("keydown", _menuEl._xzgKeyHandler, true);
    if (_menuEl._xzgCleanup) _menuEl._xzgCleanup();
    _liveRunChartRefresh = null;
    _menuEl.remove();
    _menuEl = null;
  }
}

function showContextMenu(btn, chartRequest = null) {
  closeContextMenu();
  const isChartWindow = !!chartRequest;
  const anchor = btn || _menuBtn;
  const menu = document.createElement("div");
  menu.id = "xzg-menu";
  menu.className = "xzg-menu";
  menu.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  const addMenuDivider = () => {
    const divider = document.createElement("div");
    divider.className = "xzg-menu-sep";
    menu.appendChild(divider);
  };
  menu.innerHTML = `<div class="xzg-menu-t">胶囊显示项</div>`;
  const items = [
    { key: "run_timer", label: "运行时间" },
    { key: "gpu_util", label: "GPU 利用率" }, { key: "gpu_temp", label: "GPU 温度" },
    { key: "gpu_vram", label: "GPU 显存" }, { key: "gpu_power", label: "GPU 功耗" },
    { key: "cpu_util", label: "CPU 使用率" },
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
      if (it.key === "run_timer") updateRunTimerButton();
    });
    menu.appendChild(row);
  });
  const recordingRow = document.createElement("div");
  recordingRow.className = "xzg-menu-it" + (_runRecordingEnabled ? " on" : "");
  recordingRow.innerHTML = `<span class="xzg-menu-box">${_runRecordingEnabled ? "✓" : ""}</span><span>记录运行曲线</span>`;
  recordingRow.title = "仅记录工作流运行期间的数据，关闭页面后清除";
  recordingRow.addEventListener("click", (event) => {
    event.stopPropagation();
    _runRecordingEnabled = !_runRecordingEnabled;
    if (_runRecordingEnabled && _run.running) beginRunMetricsCapture(Date.now());
    else if (!_runRecordingEnabled && _activeRunMetrics) finalizeActiveRunMetrics("记录已关闭");
    recordingRow.classList.toggle("on", _runRecordingEnabled);
    recordingRow.querySelector(".xzg-menu-box").textContent = _runRecordingEnabled ? "✓" : "";
  });
  menu.appendChild(recordingRow);
  const chartButton = document.createElement("div");
  chartButton.className = "xzg-menu-it";
  chartButton.innerHTML = `<span class="xzg-menu-box">↗</span><span>查看上次运行曲线</span>`;
  chartButton.title = "查看最近一次已记录的工作流运行曲线";
  menu.appendChild(chartButton);
  const chartPanel = document.createElement("div");
  chartPanel.style.cssText = "display:none;position:relative;width:340px;max-width:calc(100vw - 40px);padding:8px;border:1px solid rgba(255,255,255,.14);border-radius:6px;background:rgba(0,0,0,.16);box-sizing:border-box;";
  const chartControls = document.createElement("div");
  chartControls.style.cssText = "display:grid;align-items:center;gap:6px;margin-bottom:4px;";
  const runSelect = document.createElement("select");
  runSelect.title = "选择最近一次工作流运行记录";
  runSelect.style.display = "none";
  const runPicker = document.createElement("div");
  runPicker.style.cssText = "min-width:0;position:relative;";
  const runPickerButton = document.createElement("button");
  runPickerButton.type = "button";
  runPickerButton.title = "选择历史工作流运行记录";
  runPickerButton.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-width:0;height:34px;padding:4px 8px;border:1px solid rgba(255,255,255,.24);border-radius:4px;background:#303030;color:#eee;text-align:left;font:12px 'Segoe UI',system-ui,sans-serif;cursor:pointer;";
  const runPickerLabel = document.createElement("span");
  runPickerLabel.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  runPickerLabel.textContent = "选择工作流运行记录";
  const runPickerArrow = document.createElement("span");
  runPickerArrow.textContent = "▾";
  runPickerArrow.style.cssText = "flex:none;color:#bbb;";
  runPickerButton.append(runPickerLabel, runPickerArrow);
  runPicker.append(runSelect, runPickerButton);
  const runHistoryPopup = document.createElement("div");
  runHistoryPopup.className = "xzg-run-history-popup";
  runHistoryPopup.style.cssText = "display:none;position:fixed;z-index:100002;max-height:min(42vh,360px);overflow:auto;padding:4px;border:1px solid rgba(255,255,255,.2);border-radius:5px;background:#303030;box-shadow:0 8px 24px #000a;box-sizing:border-box;color:#eee;font:12px 'Segoe UI',system-ui,sans-serif;";
  const closeRunHistoryPopup = () => { runHistoryPopup.style.display = "none"; runHistoryPopup.remove(); };
  const clearHistoryRow = document.createElement("div");
  clearHistoryRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 6px 7px;border-bottom:1px solid rgba(255,255,255,.12);margin-bottom:4px;";
  const historyTitle = document.createElement("span");
  historyTitle.textContent = "运行历史";
  historyTitle.style.cssText = "color:#aeb4be;font-weight:600;";
  // 共享的清理历史函数：清空 IndexedDB 运行曲线记录并刷新面板。
  // 供下拉弹窗内的按钮与工作流名称右侧的常驻按钮共同调用。
  const runClearMetricsHistory = async (sourceButton) => {
    if (!_runMetricsHistory.length) return;
    const disableTargets = () => {
      if (sourceButton) sourceButton.disabled = true;
      clearHistoryButton.disabled = true;
    };
    const enableTargets = () => {
      if (sourceButton) sourceButton.disabled = false;
      clearHistoryButton.disabled = false;
    };
    disableTargets();
    try {
      await _runMetricsRestorePromise;
      const db = await openRunMetricsDb();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("runs", "readwrite");
        transaction.objectStore("runs").clear();
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("清理曲线历史失败"));
        transaction.onabort = () => reject(transaction.error || new Error("清理曲线历史已取消"));
      });
      _runMetricsHistory = [];
      _lastRunMetrics = null;
      _lastRunDuration = 0;
      const activeId = _run.running ? _activeRunMetrics?.id : null;
      populateRunSelector(activeId);
      if (activeId) {
        chartCanvas.style.display = "block";
        populateRunChart(chartSelect.value);
      } else {
        chartChoices = [];
        chartSelect.replaceChildren();
        chartCanvas.getContext("2d")?.clearRect(0, 0, chartCanvas.width, chartCanvas.height);
        chartCanvas.style.display = "none";
      }
      renderRunHistoryPopup();
      if (runHistoryPopup.isConnected) positionRunHistoryPopup();
    } catch (error) {
      console.warn("[小珠光] 清理曲线历史失败:", error);
    } finally {
      enableTargets();
    }
  };
  const clearHistoryButton = document.createElement("button");
  clearHistoryButton.type = "button";
  clearHistoryButton.textContent = "清理历史记录";
  clearHistoryButton.title = "删除本地保存的历史曲线数据";
  clearHistoryButton.style.cssText = "padding:3px 7px;border:1px solid rgba(255,255,255,.18);border-radius:4px;background:#3a3a3a;color:#eee;font:inherit;cursor:pointer;";
  clearHistoryButton.addEventListener("mouseenter", () => { clearHistoryButton.style.background = "#4a4a4a"; });
  clearHistoryButton.addEventListener("mouseleave", () => { clearHistoryButton.style.background = "#3a3a3a"; });
  clearHistoryButton.addEventListener("click", (event) => {
    event.stopPropagation();
    runClearMetricsHistory(clearHistoryButton);
  });
  const syncRunPickerButton = () => {
    const selected = Array.from(runSelect.options).find((option) => option.value === runSelect.value);
    runPickerLabel.textContent = selected?.dataset.workflowName || "选择工作流运行记录";
    runPickerButton.title = selected?.textContent || "选择工作流运行记录";
  };
  const positionRunHistoryPopup = () => {
    const rect = runPickerButton.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 400), window.innerWidth - 16);
    runHistoryPopup.style.width = `${width}px`;
    runHistoryPopup.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))}px`;
    const popupHeight = Math.min(runHistoryPopup.scrollHeight || 240, window.innerHeight * .42, 360);
    const below = rect.bottom + 4;
    runHistoryPopup.style.top = `${below + popupHeight <= window.innerHeight - 8 ? below : Math.max(8, rect.top - popupHeight - 4)}px`;
  };
  const renderRunHistoryPopup = () => {
    runHistoryPopup.replaceChildren();
    clearHistoryButton.disabled = _runMetricsHistory.length === 0;
    clearHistoryButton.style.opacity = clearHistoryButton.disabled ? ".5" : "1";
    syncInlineClearButton();
    clearHistoryRow.append(historyTitle, clearHistoryButton);
    runHistoryPopup.appendChild(clearHistoryRow);
    if (!runSelect.options.length) {
      const empty = document.createElement("div");
      empty.textContent = "暂无历史记录";
      empty.style.cssText = "padding:10px 8px;color:#9da3ad;text-align:center;";
      runHistoryPopup.appendChild(empty);
      return;
    }
    for (const option of runSelect.options) {
      const row = document.createElement("button");
      row.type = "button";
      row.style.cssText = `display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;width:100%;padding:7px 8px;border:0;border-radius:3px;background:${option.value === runSelect.value ? "rgba(255,255,255,.10)" : "transparent"};color:#eee;text-align:left;cursor:pointer;font:inherit;`;
      row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,.10)"; });
      row.addEventListener("mouseleave", () => { row.style.background = option.value === runSelect.value ? "rgba(255,255,255,.10)" : "transparent"; });
      const left = document.createElement("span");
      left.style.cssText = "display:flex;flex-direction:column;gap:3px;min-width:0;";
      const name = document.createElement("span");
      name.textContent = option.dataset.workflowName || option.textContent;
      name.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      const date = document.createElement("span");
      date.textContent = option.dataset.time || "";
      date.style.cssText = "color:#9da3ad;font-size:11px;";
      left.append(name, date);
      const right = document.createElement("span");
      right.style.cssText = "display:flex;flex-direction:column;align-items:flex-end;gap:3px;white-space:nowrap;font-variant-numeric:tabular-nums;";
      const duration = document.createElement("span");
      duration.textContent = `时长 ${option.dataset.duration || "--"}`;
      const delta = document.createElement("span");
      delta.textContent = `较上次 ${option.dataset.delta || "--"}`;
      delta.style.color = option.dataset.delta?.startsWith("+") ? "#8fdaa9" : option.dataset.delta?.startsWith("-") ? "#f0988e" : "#aeb4be";
      right.append(duration, delta);
      row.append(left, right);
      row.addEventListener("click", () => {
        runSelect.value = option.value;
        runSelect.dispatchEvent(new Event("change", { bubbles: true }));
        closeRunHistoryPopup();
      });
      runHistoryPopup.appendChild(row);
    }
  };
  const outsideRunPopupHandler = (event) => {
    if (!runHistoryPopup.contains(event.target) && !runPickerButton.contains(event.target)) closeRunHistoryPopup();
  };
  runPickerButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (runHistoryPopup.style.display === "block") { closeRunHistoryPopup(); return; }
    renderRunHistoryPopup();
    document.body.appendChild(runHistoryPopup);
    runHistoryPopup.style.display = "block";
    positionRunHistoryPopup();
  });
  runPickerButton.addEventListener("pointerdown", (event) => event.stopPropagation());
  runHistoryPopup.addEventListener("pointerdown", (event) => event.stopPropagation());
  document.addEventListener("pointerdown", outsideRunPopupHandler, true);
  menu._xzgCleanup = () => {
    closeRunHistoryPopup();
    document.removeEventListener("pointerdown", outsideRunPopupHandler, true);
  };
  runPickerButton.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeRunHistoryPopup();
  });
  const chartSelect = document.createElement("select");
  chartSelect.style.cssText = "flex:.85 1 0;min-width:0;height:32px;padding:4px 6px;border:1px solid rgba(255,255,255,.24);border-radius:4px;background:#303030!important;background-color:#303030!important;color:#eee;color-scheme:dark;outline:none;box-shadow:none;font:12px 'Segoe UI',system-ui,sans-serif;";
  const chartSplitHandle = document.createElement("div");
  chartSplitHandle.className = "xzg-chart-split-handle";
  chartSplitHandle.setAttribute("role", "separator");
  chartSplitHandle.setAttribute("aria-orientation", "vertical");
  chartSplitHandle.setAttribute("aria-label", "拖动调整历史记录与监控类别列表宽度");
  chartSplitHandle.tabIndex = 0;
  chartSplitHandle.style.cssText = "width:6px;height:28px;margin:0 10px;justify-self:center;cursor:col-resize;touch-action:none;position:relative;";
  const closeChartButton = document.createElement("button");
  closeChartButton.type = "button";
  closeChartButton.title = "关闭曲线观察界面";
  // 绝对定位到面板右上角；透明大热区（104px，视觉 × 的 2 倍），内部红色 × 视觉保持原大小。
  closeChartButton.style.cssText = "position:absolute;top:-6px;right:-6px;width:104px;height:104px;padding:0;border:0;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;";
  const closeGlyph = document.createElement("span");
  closeGlyph.textContent = "×";
  closeGlyph.style.cssText = "color:#ff3b30;font-size:36px;font-weight:600;line-height:1;pointer-events:none;user-select:none;";
  closeChartButton.append(closeGlyph);
  closeChartButton.addEventListener("mouseenter", () => { closeGlyph.style.color = "#ff6b61"; });
  closeChartButton.addEventListener("mouseleave", () => { closeGlyph.style.color = "#ff3b30"; });
  // 常驻的“清除历史记录”按钮：显示在工作流名称选择器右侧，打开面板即可见，
  // 无需展开下拉弹窗。与弹窗内按钮共用 runClearMetricsHistory 清理逻辑。
  const inlineClearHistoryButton = document.createElement("button");
  inlineClearHistoryButton.type = "button";
  inlineClearHistoryButton.textContent = "清除历史记录";
  inlineClearHistoryButton.title = "删除本地保存的历史曲线数据";
  inlineClearHistoryButton.style.cssText = "flex:none;height:34px;padding:4px 8px;border:1px solid rgba(255,255,255,.18);border-radius:4px;background:#3a3a3a;color:#eee;font:12px 'Segoe UI',system-ui,sans-serif;cursor:pointer;white-space:nowrap;";
  inlineClearHistoryButton.addEventListener("mouseenter", () => { inlineClearHistoryButton.style.background = "#4a4a4a"; });
  inlineClearHistoryButton.addEventListener("mouseleave", () => { inlineClearHistoryButton.style.background = "#3a3a3a"; });
  inlineClearHistoryButton.addEventListener("click", (event) => {
    event.stopPropagation();
    runClearMetricsHistory(inlineClearHistoryButton);
  });
  const syncInlineClearButton = () => {
    inlineClearHistoryButton.disabled = _runMetricsHistory.length === 0;
    inlineClearHistoryButton.style.opacity = inlineClearHistoryButton.disabled ? ".5" : "1";
  };
  const runPickerRow = document.createElement("div");
  runPickerRow.style.cssText = "display:flex;align-items:center;gap:6px;min-width:0;";
  // 名称选择器占满按钮左侧的剩余空间（flex:1），按钮固定在最右贴着手柄。
  // 这样拖动分割手柄加宽左侧栏时，名称栏会跟随整体加宽，按钮始终贴着手柄。
  runPicker.style.flex = "1 1 0";
  runPickerRow.append(runPicker, inlineClearHistoryButton);
  chartControls.append(runPickerRow, chartSplitHandle, chartSelect);
  const applyChartSplit = () => {
    const split = normalizeChartSplit(_display.chart_split);
    const leftTracks = Math.round(split * 100);
    const rightTracks = 100 - leftTracks;
    chartControls.style.gridTemplateColumns = `minmax(0,${leftTracks}fr) 26px minmax(0,${rightTracks}fr)`;
    chartSplitHandle.setAttribute("aria-valuenow", String(leftTracks));
  };
  applyChartSplit();
  let resizingChartSplit = false;
  const updateChartSplitFromPointer = (event) => {
    const rect = chartControls.getBoundingClientRect();
    const flexibleWidth = rect.width - 26 - 12;
    if (flexibleWidth <= 0) return;
    _display.chart_split = normalizeChartSplit((event.clientX - rect.left - 19) / flexibleWidth);
    applyChartSplit();
  };
  chartSplitHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    resizingChartSplit = true;
    chartSplitHandle.setPointerCapture(event.pointerId);
    updateChartSplitFromPointer(event);
    event.preventDefault();
    event.stopPropagation();
  });
  chartSplitHandle.addEventListener("pointermove", (event) => {
    if (!resizingChartSplit) return;
    updateChartSplitFromPointer(event);
    event.stopPropagation();
  });
  const finishChartSplitDrag = () => {
    if (!resizingChartSplit) return;
    resizingChartSplit = false;
    saveDisplay();
  };
  chartSplitHandle.addEventListener("pointerup", finishChartSplitDrag);
  chartSplitHandle.addEventListener("pointercancel", finishChartSplitDrag);
  chartSplitHandle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    _display.chart_split = normalizeChartSplit(_display.chart_split + (event.key === "ArrowRight" ? .02 : -.02));
    applyChartSplit();
    saveDisplay();
    event.preventDefault();
  });
  const chartCanvas = document.createElement("canvas");
  chartCanvas.width = 640;
  chartCanvas.height = 340;
  chartCanvas.style.cssText = "display:block;width:100%;height:170px;border-radius:4px;background:rgba(5,8,14,.32);";
  chartPanel.append(chartControls, chartCanvas);
  chartPanel.appendChild(closeChartButton);
  menu.appendChild(chartPanel);
  let chartChoices = [];
  let _selectedRunMetrics = null;
  let chartHoverInfo = null;
  let chartScreenPoints = [];
  let chartDataPoints = [];
  const chartNodeColors = new Map();
  const getNodeColor = (node) => {
    if (!node || node.id == null) return null;
    const id = String(node.id);
    if (!chartNodeColors.has(id)) {
      const hue = (38 + chartNodeColors.size * 137.508) % 360;
      chartNodeColors.set(id, `hsl(${hue.toFixed(1)} 78% 64%)`);
    }
    return chartNodeColors.get(id);
  };
  const drawRunChart = () => {
    const ctx = chartCanvas.getContext("2d");
    if (!ctx) return;
    const choice = chartChoices.find((entry) => entry.value === chartSelect.value);
    const makeSeriesPoints = (record, seriesChoice) => {
      if (!record || !seriesChoice) return [];
      let gpuIndex = seriesChoice.gpu;
      if (seriesChoice.kind === "gpu") {
        const idMatch = record.gpuIds?.findIndex((id) => String(id) === String(seriesChoice.gpuId)) ?? -1;
        const nameMatch = seriesChoice.gpuName ? (record.gpuNames?.findIndex((name) => name === seriesChoice.gpuName) ?? -1) : -1;
        if (idMatch >= 0) gpuIndex = idMatch;
        else if (nameMatch >= 0) gpuIndex = nameMatch;
      }
      return record.samples.map((sample) => {
        const schemaVersion = Number(record.schemaVersion) || 1;
        const cpuIndex = schemaVersion >= 3
          ? seriesChoice.metric
          : schemaVersion >= 2
            ? (seriesChoice.metric === 1 ? 2 : seriesChoice.metric)
            : (seriesChoice.metric === 1 ? 3 : seriesChoice.metric);
        const raw = seriesChoice.kind === "gpu" ? sample[1]?.[gpuIndex]?.[seriesChoice.metric] : sample[2]?.[cpuIndex];
        const value = raw == null ? NaN : Number(raw);
        const scale = (seriesChoice.kind === "gpu" && seriesChoice.metric === 2) || (seriesChoice.kind === "cpu" && seriesChoice.metric === 2) ? 1024 : 1;
        return { x: Number(sample[0]) / 1000, y: Number.isFinite(value) ? value / scale : NaN, node: sample[3] || null, sample };
      }).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    };
    const points = makeSeriesPoints(_selectedRunMetrics, choice);
    const w = chartCanvas.width;
    const h = chartCanvas.height;
    // 标签从画布左侧 10px 处开始；绘图区宽度另按刻度文字动态避让。
    const pad = { l: 10, r: 12, t: 14, b: 34 };
    chartScreenPoints = [];
    chartDataPoints = [];
    ctx.clearRect(0, 0, w, h);
    ctx.font = "18px Segoe UI, sans-serif";
    ctx.textBaseline = "middle";
    const yTickLabels = points.length >= 2 && choice
      ? Array.from({ length: 5 }, (_, i) => {
          let minY = Math.min(...points.map((point) => point.y));
          let maxY = Math.max(...points.map((point) => point.y));
          if (choice.fixedMax != null) { minY = choice.fixedMin || 0; maxY = choice.fixedMax; }
          else { const span = Math.max(1, maxY - minY); minY = Math.max(0, minY - span * .12); maxY += span * .12; }
          if (maxY <= minY) maxY = minY + 1;
          return `${(maxY - (maxY - minY) * i / 4).toFixed(choice.decimals || 0)}${choice.unit || ""}`;
        })
      : [];
    const yLabelWidth = Math.max(0, ...yTickLabels.map((label) => ctx.measureText(label).width));
    pad.l = Math.ceil(10 + yLabelWidth + 7);
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    ctx.strokeStyle = "rgba(255,255,255,.11)";
    ctx.fillStyle = "#9ba3af";
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + plotH * i / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    }
    if (points.length < 2) {
      ctx.fillStyle = "#aaa"; ctx.textAlign = "center";
      ctx.fillText("没有足够的采样点", w / 2, h / 2);
      return;
    }
    let minY = Math.min(...points.map((point) => point.y));
    let maxY = Math.max(...points.map((point) => point.y));
    if (choice.fixedMax != null) { minY = choice.fixedMin || 0; maxY = choice.fixedMax; }
    else { const span = Math.max(1, maxY - minY); minY = Math.max(0, minY - span * .12); maxY += span * .12; }
    if (maxY <= minY) maxY = minY + 1;
    const maxX = Math.max(points[points.length - 1].x, 1);
    const unit = choice.unit || "";
    const getPointPosition = (point) => ({
      x: pad.l + plotW * point.x / maxX,
      y: pad.t + plotH * (maxY - point.y) / (maxY - minY),
    });
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const value = maxY - (maxY - minY) * i / 4;
      const y = pad.t + plotH * i / 4;
      ctx.fillText(`${value.toFixed(choice.decimals || 0)}${unit}`, pad.l - 7, y);
    }
    ctx.textAlign = "center";
    for (let i = 0; i <= 4; i++) {
      const seconds = maxX * i / 4;
      const label = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
      const labelHalfWidth = ctx.measureText(label).width / 2;
      const labelX = Math.max(pad.l + labelHalfWidth + 2, Math.min(w - pad.r - labelHalfWidth - 2, pad.l + plotW * i / 4));
      ctx.fillText(label, labelX, h - 14);
    }
    const nodeColor = (point) => getNodeColor(point.node) || choice.color || "#60c8ff";
    const drawSeries = (seriesPoints) => {
      const screen = seriesPoints.map((point) => getPointPosition(point));
      ctx.lineWidth = 3;
      ctx.setLineDash([]);
      let activePathColor = null;
      let pathHasPoints = false;
      const flushPath = () => {
        if (!pathHasPoints) return;
        ctx.strokeStyle = activePathColor;
        ctx.stroke();
        pathHasPoints = false;
      };
      const addColoredLine = (from, to, color) => {
        if (activePathColor !== color || !pathHasPoints) {
          flushPath();
          activePathColor = color;
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          pathHasPoints = true;
        }
        ctx.lineTo(to.x, to.y);
      };
      for (let i = 1; i < seriesPoints.length; i++) {
        const from = screen[i - 1];
        const to = screen[i];
        const fromColor = nodeColor(seriesPoints[i - 1]);
        const toColor = nodeColor(seriesPoints[i]);
        if (fromColor !== toColor) {
          const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
          addColoredLine(from, mid, fromColor);
          flushPath();
          addColoredLine(mid, to, toColor);
        } else addColoredLine(from, to, toColor);
      }
      flushPath();
      ctx.setLineDash([]);
      for (let i = 0; i < seriesPoints.length; i++) {
        if (seriesPoints.length > 300 && i !== 0 && i !== seriesPoints.length - 1 && nodeColor(seriesPoints[i]) === nodeColor(seriesPoints[i - 1])) continue;
        const point = screen[i];
        ctx.beginPath(); ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = nodeColor(seriesPoints[i]);
        ctx.fill();
      }
      return screen;
    };
    const screenPoints = drawSeries(points);
    // 高亮当前鼠标对应的数据点；提示框显示采样时刻、数值和当时执行的节点。
    chartScreenPoints = screenPoints;
    chartDataPoints = points;
    if (chartHoverInfo) {
      const x = chartHoverInfo.x;
      const y = chartHoverInfo.y;
      ctx.save();
      ctx.beginPath(); ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(235,242,255,.72)";
      ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = choice.color || "#60c8ff"; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
      const valueLabel = `${chartHoverInfo.value.toFixed(choice.decimals || 0)}${unit}`;
      ctx.font = "bold 17px Segoe UI, sans-serif";
      const labelWidth = ctx.measureText(valueLabel).width + 14;
      const labelX = Math.max(pad.l, Math.min(w - pad.r - labelWidth, x + 10));
      const labelMinY = pad.t + 2;
      const labelMaxY = Math.max(labelMinY, h - pad.b - 25);
      const nearTop = y <= pad.t + 30;
      const nearBottom = y >= h - pad.b - 30;
      const labelY = nearTop
        ? labelMinY
        : nearBottom
          ? Math.max(labelMinY, Math.min(labelMaxY, y + 9))
          : Math.max(labelMinY, Math.min(labelMaxY, y - 25));
      ctx.fillStyle = "rgba(12,15,22,.92)";
      ctx.fillRect(labelX, labelY, labelWidth, 23);
      ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(valueLabel, labelX + 7, labelY + 11.5);
      // 同步在纵轴交点和横轴时间位置标值，便于直接读取坐标。
      ctx.font = "bold 16px Segoe UI, sans-serif";
      const yLabel = `${chartHoverInfo.value.toFixed(choice.decimals || 0)}${unit}`;
      const yLabelWidth = Math.min(pad.l - 12, ctx.measureText(yLabel).width + 12);
      const yLabelX = pad.l - yLabelWidth - 5;
      const yLabelY = Math.max(pad.t, Math.min(h - pad.b - 22, y - 11));
      ctx.fillStyle = "rgba(12,15,22,.96)";
      ctx.fillRect(yLabelX, yLabelY, yLabelWidth, 22);
      ctx.fillStyle = "#fff"; ctx.textAlign = "center";
      ctx.fillText(yLabel, yLabelX + yLabelWidth / 2, yLabelY + 11);
      const timeWidth = ctx.measureText(chartHoverInfo.time).width + 14;
      const timeX = Math.max(pad.l + 2, Math.min(w - pad.r - timeWidth - 2, x - timeWidth / 2));
      const timeY = h - pad.b + 3;
      ctx.fillStyle = "rgba(12,15,22,.96)";
      ctx.fillRect(timeX, timeY, timeWidth, 22);
      ctx.fillStyle = "#fff"; ctx.textAlign = "center";
      ctx.fillText(chartHoverInfo.time, timeX + timeWidth / 2, timeY + 11);
      const node = chartHoverInfo.node;
      let nodeLabel = node ? `${displayNodeId(node.id)} · ${node.title}` : "无对应执行节点";
      ctx.font = "bold 15px Segoe UI, sans-serif";
      const maxNodeWidth = Math.max(90, w - pad.l - pad.r - 20);
      while (nodeLabel.length > 4 && ctx.measureText(nodeLabel).width > maxNodeWidth - 14) {
        nodeLabel = `${nodeLabel.slice(0, -2)}…`;
      }
      const nodeLabelWidth = Math.min(maxNodeWidth, ctx.measureText(nodeLabel).width + 14);
      const nodeLabelX = Math.max(pad.l, Math.min(w - pad.r - nodeLabelWidth, x + 10));
      // Keep node name and value callout on opposite sides near plot edges;
      // otherwise their boxes collide when the point is at the top or bottom.
      const nodeLabelY = nearTop
        ? Math.max(labelMinY, Math.min(labelMaxY, y + 34))
        : nearBottom
          ? Math.max(labelMinY, Math.min(labelMaxY, y - 52))
          : Math.max(labelMinY, Math.min(labelMaxY, y + 9));
      ctx.fillStyle = getNodeColor(node) || "rgba(12,15,22,.94)";
      ctx.fillRect(nodeLabelX, nodeLabelY, nodeLabelWidth, 23);
      ctx.fillStyle = "#11151b"; ctx.textAlign = "left";
      ctx.fillText(nodeLabel, nodeLabelX + 7, nodeLabelY + 11.5);
      ctx.restore();
    }
  };
  chartCanvas.addEventListener("pointermove", (event) => {
    const rect = chartCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height || chartScreenPoints.length < 2 || !chartDataPoints.length) return;
    const canvasX = (event.clientX - rect.left) * chartCanvas.width / rect.width;
    const w = chartCanvas.width;
    const h = chartCanvas.height;
    const pad = { l: chartDataPoints.length ? Math.ceil(17 + Math.max(0, ...Array.from({ length: 5 }, (_, i) => {
      const choice = chartChoices.find((entry) => entry.value === chartSelect.value);
      if (!choice) return 0;
      const values = chartDataPoints.map((point) => point.y);
      let minY = Math.min(...values); let maxY = Math.max(...values);
      if (choice.fixedMax != null) { minY = choice.fixedMin || 0; maxY = choice.fixedMax; }
      else { const span = Math.max(1, maxY - minY); minY = Math.max(0, minY - span * .12); maxY += span * .12; }
      if (maxY <= minY) maxY = minY + 1;
      const label = `${(maxY - (maxY - minY) * i / 4).toFixed(choice.decimals || 0)}${choice.unit || ""}`;
      return chartCanvas.getContext("2d")?.measureText(label).width || 0;
    }))) : 17, r: 12, t: 14, b: 34 };
    const plotW = w - pad.l - pad.r;
    const x = Math.max(pad.l, Math.min(w - pad.r, canvasX));
    let rightIndex = chartScreenPoints.findIndex((point) => point.x >= x);
    if (rightIndex < 0) rightIndex = chartScreenPoints.length - 1;
    const leftIndex = Math.max(0, rightIndex - 1);
    const leftScreen = chartScreenPoints[leftIndex];
    const rightScreen = chartScreenPoints[rightIndex];
    const leftData = chartDataPoints[leftIndex];
    const rightData = chartDataPoints[rightIndex];
    const spanX = rightScreen.x - leftScreen.x;
    const ratio = spanX > 0 ? Math.max(0, Math.min(1, (x - leftScreen.x) / spanX)) : 0;
    const y = leftScreen.y + (rightScreen.y - leftScreen.y) * ratio;
    const value = leftData.y + (rightData.y - leftData.y) * ratio;
    const maxX = Math.max(chartDataPoints[chartDataPoints.length - 1].x, 1);
    const seconds = Math.max(0, maxX * (x - pad.l) / plotW);
    const elapsed = Math.floor(seconds);
    const time = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
    const sample = ratio < .5 ? leftData.sample : rightData.sample;
    const node = sample?.[3];
    chartHoverInfo = { x, y: Math.max(pad.t, Math.min(h - pad.b, y)), value, time, node };
    drawRunChart();
  });
  chartCanvas.addEventListener("pointerleave", () => {
    if (!chartHoverInfo) return;
    chartHoverInfo = null;
    drawRunChart();
  });
  const populateRunSelector = (preferredId = null) => {
    runSelect.replaceChildren();
    const hasActiveRun = !!(_run.running && _activeRunMetrics);
    if (hasActiveRun) {
      const option = document.createElement("option");
      option.value = _activeRunMetrics.id;
      const workflowName = `● 正在运行 · ${displayName(_activeRunMetrics.workflowName) || "未命名工作流"}`;
      const activeDuration = Math.max(0, Date.now() - _activeRunMetrics.startedAt);
      const previousDuration = _runMetricsHistory.length ? runMetricsDurationMs(_runMetricsHistory[0]) : null;
      option.textContent = workflowName;
      option.dataset.workflowName = workflowName;
      option.dataset.time = new Date(Number(_activeRunMetrics.startedAt)).toLocaleString();
      option.dataset.duration = fmtDur(activeDuration);
      option.dataset.delta = previousDuration == null ? "--" : formatRunDurationDelta(activeDuration - previousDuration);
      runSelect.appendChild(option);
    }
    for (const [index, record] of _runMetricsHistory.entries()) {
      if (hasActiveRun && record.id === _activeRunMetrics.id) continue;
      const option = document.createElement("option");
      option.value = record.id;
      const date = new Date(Number(record.startedAt));
      const time = Number.isNaN(date.getTime()) ? "运行记录" : date.toLocaleString();
      const sequence = _runMetricsHistory.length - index;
      const workflowName = `${sequence} · ${displayName(record.workflowName) || "未命名工作流"}`;
      const durationMs = runMetricsDurationMs(record);
      const previous = _runMetricsHistory[index + 1];
      const delta = previous ? formatRunDurationDelta(durationMs - runMetricsDurationMs(previous)) : "--";
      option.textContent = `${sequence} · ${time} · ${displayName(record.workflowName) || "未命名工作流"}`;
      option.dataset.workflowName = workflowName;
      option.dataset.time = time;
      option.dataset.duration = fmtDur(durationMs);
      option.dataset.delta = delta;
      runSelect.appendChild(option);
    }
    const hasPreferred = preferredId && Array.from(runSelect.options).some((option) => option.value === preferredId);
    if (hasPreferred) runSelect.value = preferredId;
    else if (hasActiveRun) runSelect.value = _activeRunMetrics.id;
    else if (_runMetricsHistory.length) runSelect.value = _runMetricsHistory[0].id;
    _selectedRunMetrics = (_activeRunMetrics?.id === runSelect.value ? _activeRunMetrics : null)
      || _runMetricsHistory.find((record) => record.id === runSelect.value)
      || null;
    syncRunPickerButton();
    if (runHistoryPopup.isConnected && runHistoryPopup.style.display === "block") {
      renderRunHistoryPopup();
      positionRunHistoryPopup();
    }
  };
  const populateRunChart = (preferredKey = null) => {
    chartSelect.replaceChildren();
    chartChoices = [];
    chartNodeColors.clear();
    _selectedRunMetrics = (_activeRunMetrics?.id === runSelect.value ? _activeRunMetrics : null)
      || _runMetricsHistory.find((item) => item.id === runSelect.value)
      || _lastRunMetrics;
    const record = _selectedRunMetrics;
    if (!record) return;
    const first = record.samples.find((sample) => sample[1]?.length);
    const gpuCount = first?.[1]?.length || record.gpuNames.length || 0;
    const gpuMetrics = [
      [0, "利用率", "%", 100, "#53a9ff"], [1, "温度", "°C", null, "#ff794f"],
      [2, "显存", "GB", null, "#aa82ff"], [3, "功率", "W", null, "#ffd35a"],
    ];
    for (let gpu = 0; gpu < gpuCount; gpu++) {
      for (const [metric, label, unit, fixedMax, color] of gpuMetrics) {
        const gpuId = record.gpuIds?.[gpu] ?? String(gpu);
        chartChoices.push({ value: `gpu:${gpuId}:${metric}`, label: `${record.gpuNames[gpu] || `GPU ${gpu}`} · ${label}`, kind: "gpu", gpu, gpuId, gpuName: record.gpuNames[gpu], metric, unit, fixedMax, color, decimals: unit === "GB" ? 1 : 0 });
      }
    }
    const cpuMetrics = [
      [0, "CPU 利用率", "%", 100, "#56d6b5"],
      [1, "内存占用", "GB", null, "#86d69b"],
    ];
    for (const [metric, label, unit, fixedMax, color] of cpuMetrics) {
      chartChoices.push({ value: `cpu:${metric}`, label, kind: "cpu", metric, unit, fixedMax, color, decimals: unit === "GB" ? 1 : 0 });
    }
    for (const choice of chartChoices) {
      const option = document.createElement("option");
      option.value = choice.value;
      option.textContent = choice.label;
      chartSelect.appendChild(option);
    }
    if (preferredKey && chartChoices.some((choice) => choice.value === preferredKey)) chartSelect.value = preferredKey;
    drawRunChart();
  };
  runSelect.addEventListener("change", () => {
    chartHoverInfo = null;
    syncRunPickerButton();
    populateRunChart(chartSelect.value);
  });
  runSelect.addEventListener("pointerdown", (event) => event.stopPropagation());
  _liveRunChartRefresh = () => {
    if (!isChartWindow && chartPanel.style.display !== "block") return;
    const selectedId = _activeRunMetrics && _run.running ? _activeRunMetrics.id : runSelect.value;
    const selectedMetric = chartSelect.value;
    populateRunSelector(selectedId);
    populateRunChart(selectedMetric);
  };
  chartSelect.addEventListener("change", () => { chartHoverInfo = null; drawRunChart(); });
  chartSelect.addEventListener("pointerdown", (event) => event.stopPropagation());
  closeChartButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (isChartWindow) closeContextMenu();
    else chartPanel.style.display = "none";
  });
  closeChartButton.addEventListener("pointerdown", (event) => event.stopPropagation());
  chartButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    await _runMetricsRestorePromise;
    if (!_runMetricsHistory.length && !(_activeRunMetrics?.samples?.length >= 2)) {
      chartSelect.replaceChildren();
      runSelect.replaceChildren();
      chartPanel.style.display = "block";
      chartCanvas.style.display = "none";
      closeChartButton.style.display = "none";
      return;
    }
    chartCanvas.style.display = "block";
    closeChartButton.style.display = "block";
    populateRunSelector();
    populateRunChart();
    syncInlineClearButton();
    chartPanel.style.display = "block";
    menu.style.maxHeight = "min(78vh,760px)";
    menu.style.overflowY = "auto";
    const expandedMenuRect = menu.getBoundingClientRect();
    if (expandedMenuRect.right > window.innerWidth - 4) {
      menu.style.left = `${Math.max(4, window.innerWidth - expandedMenuRect.width - 4)}px`;
    }
    if (expandedMenuRect.bottom > window.innerHeight - 4) {
      menu.style.top = `${Math.max(4, window.innerHeight - expandedMenuRect.height - 4)}px`;
    }
    drawRunChart();
  });
  chartButton.addEventListener("pointerdown", (event) => event.stopPropagation());
  addMenuDivider();
  const sizeLabel = document.createElement("div");
  sizeLabel.className = "xzg-menu-t";
  sizeLabel.style.marginTop = "4px";
  sizeLabel.textContent = `圆球大小：${_display.orb_size}px`;
  menu.appendChild(sizeLabel);
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
  menu.appendChild(sizeInput);
  addMenuDivider();
  const paletteTitle = document.createElement("div");
  paletteTitle.className = "xzg-menu-t";
  paletteTitle.style.marginTop = "5px";
  paletteTitle.textContent = "胶囊配色";
  menu.appendChild(paletteTitle);
  const palettes = [
    ["classic", "默认经典分区色"], ["aurora", "极光紫绿"],
    ["amber", "暖金铜红"], ["graphite", "石墨中性"],
  ];
  const paletteSelect = document.createElement("select");
  paletteSelect.className = "xzg-menu-palette-select";
  paletteSelect.style.cssText = "display:block;width:calc(100% - 16px);margin:6px 8px 8px;padding:6px 8px;border:1px solid rgba(255,255,255,.2);border-radius:5px;background:var(--comfy-menu-bg,#303030);color:#eee;font:13px 'Segoe UI',system-ui,sans-serif;";
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
  addMenuDivider();
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
  animationSelect.style.cssText = "display:block;width:calc(100% - 16px);margin:6px 8px 8px;padding:6px 8px;border:1px solid rgba(255,255,255,.2);border-radius:5px;background:var(--comfy-menu-bg,#303030);color:#eee;font:13px 'Segoe UI',system-ui,sans-serif;";
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
  addMenuDivider();
  const timerEffectTitle = document.createElement("div");
  timerEffectTitle.className = "xzg-menu-t";
  timerEffectTitle.style.marginTop = "5px";
  timerEffectTitle.textContent = "计时器特效";
  menu.appendChild(timerEffectTitle);
  const timerEffectSelect = document.createElement("select");
  timerEffectSelect.style.cssText = animationSelect.style.cssText;
  const timerEffects = [
    ["white", "冷白"], ["cyan", "青蓝"], ["green", "绿色"],
  ];
  for (const [value, label] of timerEffects) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    timerEffectSelect.appendChild(option);
  }
  const customColorOption = document.createElement("option");
  customColorOption.value = "custom";
  customColorOption.textContent = _display.timer_custom_color || XZG_DISPLAY_DEFAULT.timer_custom_color;
  timerEffectSelect.appendChild(customColorOption);
  timerEffectSelect.value = ["white", "cyan", "green", "custom"].includes(_display.timer_effect) ? _display.timer_effect : "white";
  const customColorPicker = document.createElement("input");
  customColorPicker.type = "color";
  customColorPicker.value = _display.timer_custom_color || XZG_DISPLAY_DEFAULT.timer_custom_color;
  customColorPicker.title = "自定义计时器颜色";
  customColorPicker.style.cssText = "width:30px;height:26px;padding:2px;border:1px solid rgba(255,255,255,.2);border-radius:5px;background:var(--comfy-menu-bg,#303030);cursor:pointer;";
  customColorPicker.addEventListener("input", (event) => {
    event.stopPropagation();
    _display.timer_effect = "custom";
    _display.timer_custom_color = customColorPicker.value;
    customColorOption.textContent = customColorPicker.value.toUpperCase();
    timerEffectSelect.value = "custom";
    saveDisplay();
    applyTimerEffect();
  });
  customColorPicker.addEventListener("pointerdown", (event) => event.stopPropagation());
  timerEffectSelect.addEventListener("change", (event) => {
    event.stopPropagation();
    _display.timer_effect = timerEffectSelect.value;
    saveDisplay();
    updateRunTimerButton();
    applyTimerEffect();
  });
  timerEffectSelect.addEventListener("pointerdown", (event) => event.stopPropagation());
  const timerEffectRow = document.createElement("div");
  timerEffectRow.style.cssText = "display:flex;align-items:center;gap:6px;padding:0 8px 8px;";
  timerEffectSelect.style.width = "auto";
  timerEffectSelect.style.flex = "1";
  timerEffectSelect.style.margin = "6px 0 0";
  timerEffectRow.append(timerEffectSelect, customColorPicker);
  menu.appendChild(timerEffectRow);
  if (isChartWindow) {
    menu.classList.add("xzg-run-chart-window");
    const chartMenuTitle = document.createElement("div");
    chartMenuTitle.className = "xzg-menu-t";
    const metricNames = {
      gpu_util: "GPU 利用率", gpu_temp: "GPU 温度", gpu_vram: "GPU 显存", gpu_power: "GPU 功率",
      cpu_util: "CPU 利用率", mem_used: "内存占用",
    };
    chartMenuTitle.textContent = `${metricNames[chartRequest.metricKey] || "运行参数"} 曲线`;
    chartMenuTitle.style.cssText = "display:flex;align-items:center;flex:0 0 30px;height:30px;min-height:30px;padding:2px 8px 4px;margin:-2px 0 0;border:0;font:600 15px/1.2 'Segoe UI',system-ui,sans-serif;white-space:nowrap;cursor:move;touch-action:none;user-select:none;";
    menu.replaceChildren(chartMenuTitle, chartPanel);
    // 联动：切换右侧曲线类型列表时，左上角标题同步更新。
    const syncChartWindowTitle = () => {
      const value = chartSelect.value;
      let metricKey = null;
      if (value.startsWith("gpu:")) {
        const parts = value.split(":");
        const metric = Number(parts[2]);
        metricKey = ["gpu_util", "gpu_temp", "gpu_vram", "gpu_power"][metric] || "gpu_util";
      } else if (value.startsWith("cpu:")) {
        const metric = Number(value.split(":")[1]);
        metricKey = metric === 1 ? "mem_used" : "cpu_util";
      }
      if (metricKey) chartMenuTitle.textContent = `${metricNames[metricKey] || "运行参数"} 曲线`;
    };
    chartSelect.addEventListener("change", syncChartWindowTitle);
    const savedChartWindow = normalizeChartWindow(_display.chart_window);
    menu.style.width = `min(${savedChartWindow.width}px,calc(100vw - 24px))`;
    menu.style.height = `min(${savedChartWindow.height}px,calc(100vh - 24px))`;
    menu.style.minWidth = "0";
    menu.style.maxWidth = "calc(100vw - 24px)";
    menu.style.minHeight = "min(320px,calc(100vh - 24px))";
    menu.style.padding = "12px";
    menu.style.boxSizing = "border-box";
    menu.style.display = "flex";
    menu.style.flexDirection = "column";
    menu.style.resize = "both";
    menu.style.overflow = "auto";
    chartPanel.style.display = "block";
    chartPanel.style.flex = "1 1 auto";
    chartPanel.style.minHeight = "0";
    chartPanel.style.height = "calc(100% - 42px)";
    chartPanel.style.width = "100%";
    chartPanel.style.maxWidth = "none";
    chartPanel.style.padding = "0";
    chartPanel.style.border = "0";
    chartPanel.style.background = "transparent";
    chartPanel.style.boxSizing = "border-box";
    chartPanel.style.display = "flex";
    chartPanel.style.flexDirection = "column";
    chartCanvas.style.flex = "1 1 auto";
    chartCanvas.style.minHeight = "120px";
    chartCanvas.style.height = "100%";
    chartCanvas.style.maxHeight = "none";
    chartSelect.style.fontSize = "14px";
    runSelect.style.height = "34px";
    chartSelect.style.height = "34px";
    chartCanvas.width = 1200;
    chartCanvas.height = 700;
    chartCanvas.style.width = "100%";
    let drag = null;
    chartMenuTitle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = menu.getBoundingClientRect();
      drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      chartMenuTitle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    chartMenuTitle.addEventListener("pointermove", (event) => {
      if (!drag) return;
      menu.style.left = `${Math.max(0, Math.min(window.innerWidth - menu.offsetWidth, drag.left + event.clientX - drag.x))}px`;
      menu.style.top = `${Math.max(0, Math.min(window.innerHeight - 36, drag.top + event.clientY - drag.y))}px`;
    });
    const saveChartWindowGeometry = () => {
      if (!menu.isConnected) return;
      const rect = menu.getBoundingClientRect();
      _display.chart_window = normalizeChartWindow({ width: rect.width, height: rect.height, left: rect.left, top: rect.top });
      saveDisplay();
    };
    const stopChartDrag = () => {
      if (!drag) return;
      drag = null;
      saveChartWindowGeometry();
    };
    chartMenuTitle.addEventListener("pointerup", stopChartDrag);
    chartMenuTitle.addEventListener("pointercancel", stopChartDrag);
    let chartResizeSaveTimer = null;
    let chartCanvasResizeObserver = null;
    const cleanupRunHistoryPicker = menu._xzgCleanup;
    menu._xzgCleanup = () => {
      cleanupRunHistoryPicker?.();
      chartResizeObserver?.disconnect();
      chartCanvasResizeObserver?.disconnect();
      if (chartResizeSaveTimer) clearTimeout(chartResizeSaveTimer);
    };
    let skipInitialChartResize = true;
    const chartResizeObserver = new ResizeObserver(() => {
      if (skipInitialChartResize) { skipInitialChartResize = false; return; }
      if (chartResizeSaveTimer) clearTimeout(chartResizeSaveTimer);
      chartResizeSaveTimer = setTimeout(() => {
        chartResizeSaveTimer = null;
        saveChartWindowGeometry();
      }, 250);
    });
    chartResizeObserver.observe(menu);
    // Canvas text is rasterized at its intrinsic dimensions. Keep those dimensions
    // in sync with the displayed box so resizing scales the graph without stretching glyphs.
    chartCanvasResizeObserver = new ResizeObserver(([entry]) => {
      const width = Math.max(1, Math.round(entry.contentRect.width));
      const height = Math.max(1, Math.round(entry.contentRect.height));
      if (chartCanvas.width === width && chartCanvas.height === height) return;
      chartCanvas.width = width;
      chartCanvas.height = height;
      drawRunChart();
    });
    chartCanvasResizeObserver.observe(chartCanvas);
    // 窗口模式：关闭按钮移到菜单容器上，垂直居中对齐标题栏行（标题栏高约30px）。
    // 热区104px，中心放在标题栏中线处，让红色×与标题栏同一行。
    menu.appendChild(closeChartButton);
    closeChartButton.style.top = "-30px";
    closeChartButton.style.right = "2px";
    if (_runMetricsHistory.length || _activeRunMetrics?.samples?.length >= 2) {
      chartCanvas.style.display = "block";
      closeChartButton.style.display = "block";
      populateRunSelector();
      populateRunChart(chartRequest.chartKey);
    } else {
      chartCanvas.style.display = "none";
      closeChartButton.style.display = "none";
    }
  } else {
    chartButton.remove();
    chartPanel.remove();
    menu.style.width = "min(350px,calc(100vw - 16px))";
    menu.style.minWidth = "min(0px,calc(100vw - 16px))";
    menu.style.maxWidth = "calc(100vw - 16px)";
    menu.style.display = "grid";
    menu.style.gridTemplateColumns = "100px minmax(0,1fr)";
    menu.style.alignItems = "center";
    menu.style.columnGap = "12px";
    menu.style.rowGap = "1px";
    menu.style.boxSizing = "border-box";
    menu.children[0].style.gridColumn = "1 / -1";
    recordingRow.style.gridColumn = "1 / -1";
    for (const divider of menu.querySelectorAll(":scope > .xzg-menu-sep")) divider.style.gridColumn = "1 / -1";
    sizeLabel.style.margin = "0";
    sizeInput.style.width = "100%";
    sizeInput.style.margin = "0";
    paletteTitle.style.margin = "0";
    paletteSelect.style.width = "100%";
    paletteSelect.style.margin = "0";
    animationTitle.style.margin = "0";
    animationSelect.style.width = "100%";
    animationSelect.style.margin = "0";
    timerEffectTitle.style.margin = "0";
    timerEffectRow.style.padding = "0";
    timerEffectRow.style.margin = "0";
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  if (isChartWindow) {
    const rect = menu.getBoundingClientRect();
    const savedChartWindow = normalizeChartWindow(_display.chart_window);
    const left = savedChartWindow.left == null ? (window.innerWidth - rect.width) / 2 : savedChartWindow.left;
    const top = savedChartWindow.top == null ? (window.innerHeight - rect.height) / 2 : savedChartWindow.top;
    menu.style.left = `${Math.max(0, Math.min(window.innerWidth - rect.width, left))}px`;
    menu.style.top = `${Math.max(0, Math.min(window.innerHeight - rect.height, top))}px`;
  } else {
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
  }
  const outsideHandler = (event) => {
    if (!isChartWindow && !menu.contains(event.target) && !anchor.contains(event.target) && !runHistoryPopup.contains(event.target)) closeContextMenu();
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
  btn.innerHTML = `<span class="xzg-monitor-icon" aria-hidden="true">
    <svg class="xzg-batt-on" viewBox="0 0 24 18">
      <rect x="1.5" y="2.5" width="19" height="13" rx="2"/>
      <path d="M22 6v6"/>
      <rect class="xzg-batt-level" x="4" y="5" width="5" height="8" rx=".8"/>
      <rect class="xzg-batt-level" x="11" y="5" width="5" height="8" rx=".8"/>
    </svg>
    <svg class="xzg-batt-off" viewBox="0 0 24 18" style="display:none">
      <rect x="1.5" y="2.5" width="19" height="13" rx="2"/>
      <path d="M22 6v6"/>
      <rect class="xzg-batt-level" x="4" y="5" width="5" height="8" rx=".8"/>
    </svg>
  </span>`;
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

function buildRunTimerButton() {
  const btn = document.createElement("div");
  btn.id = XZG_RUN_TIMER_BTN_ID;
  btn.className = `xzg-monitor-toolbar xzg-compact xzg-palette-${_display.capsule_palette || "classic"}`;
  btn.title = "工作流运行时间与 GPU / CPU / 内存监控；双击指标切换胶囊显示";
  btn.setAttribute("aria-label", "工作流运行时间与 GPU、CPU、内存监控");
  btn.style.cssText = `
    display:flex;align-items:center;gap:8px;flex:0 1 auto;min-width:0;
    max-width:min(76vw,760px);height:36px;padding:0 10px;box-sizing:border-box;cursor:default;
    color:#fff;border:1px solid transparent;border-radius:999px;user-select:none;position:relative;
    align-self:center;margin:auto 0;background:linear-gradient(var(--xzg-capsule-bg,#171a20),var(--xzg-capsule-bg,#171a20)) padding-box,var(--xzg-capsule-edge,linear-gradient(90deg,#6d9fc5,#cda56d,#9582bd)) border-box;overflow:hidden;
  `;
  btn.innerHTML = `<span id="xzg-toolbar-run-time" class="xzg-run-time"></span><div id="xzg-toolbar-monitor-stats"></div>`;
  btn.style.visibility = _monitorInitialized ? "visible" : "hidden";
  const stats = document.getElementById("xzg-stats");
  const statsHost = btn.querySelector("#xzg-toolbar-monitor-stats");
  const timeHost = btn.querySelector("#xzg-toolbar-run-time");
  if (stats) {
    statsHost.appendChild(stats);
    if (_float) _float.setToolbarHosts(statsHost, timeHost);
  }
  updateRunTimerButton();
  return btn;
}

function attachRunTimerContextMenu(btn) {
  if (!btn || btn.dataset.xzgRunContextMenu === "true") return;
  btn.dataset.xzgRunContextMenu = "true";
  btn.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
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
  // ===== 动画参数：段间间隔 X 统一改 GAP 即可 =====
  const SEG = 2.4;                       // 标准段时长（秒）
  const SEG1 = 10;                       // 第一段特殊时长（Z轴旋转缓入缓出）
  const SEG7 = 10;                       // 第七段特殊时长（吹铜钱）
  const GAP = 0;                         // 段间间隔 X（秒），0 = 无延迟
  const TOTAL = SEG1 + SEG * 5 + SEG7;   // 总周期 = 第一段10s + 5段标准 + 第七段10s
  const seg6Pct = SEG / TOTAL * 100;    // 标准段占总周期的百分比（用于呼吸中间点）
  const p1e = SEG1 / TOTAL * 100;                    // 第一段结束（Z轴旋转）
  const p2s = (SEG1 + GAP) / TOTAL * 100;            // 第二段开始（单弧段）
  const p2e = (SEG1 + SEG + GAP) / TOTAL * 100;      // 第二段结束
  const p3s = (SEG1 + SEG + GAP * 2) / TOTAL * 100;  // 第三段开始（双弧段同向）
  const p3e = (SEG1 + SEG * 2 + GAP * 2) / TOTAL * 100; // 第三段结束
  const p4s = (SEG1 + SEG * 2 + GAP * 3) / TOTAL * 100; // 第四段开始（双弧段反向）
  const p4e = (SEG1 + SEG * 3 + GAP * 3) / TOTAL * 100; // 第四段结束
  const p5s = (SEG1 + SEG * 3 + GAP * 4) / TOTAL * 100; // 第五段开始（X交叉双线）
  const p5e = (SEG1 + SEG * 4 + GAP * 4) / TOTAL * 100; // 第五段结束
  const p6s = (SEG1 + SEG * 4 + GAP * 5) / TOTAL * 100; // 第六段开始（明暗呼吸）
  const p6e = (SEG1 + SEG * 5 + GAP * 5) / TOTAL * 100; // 第六段结束
  const p7s = (SEG1 + SEG * 5 + GAP * 6) / TOTAL * 100; // 第七段开始（吹铜钱Y轴快转）
  const f = (v) => v.toFixed(2) + "%";
  // ==================================================
  if (!document.getElementById("xzg-theme-icon-sheen-style")) {
    const style = document.createElement("style");
    style.id = "xzg-theme-icon-sheen-style";
    style.textContent = `
      /* 第一段：整个图标绕 Z 轴旋转一周 */
      /* 统一 transform：第一段绕Z轴转30圈（10s ease-in-out），第七段绕Y轴转12圈（10s ease-in-out） */
      @keyframes xzg-theme-icon-transform {
        0% { transform: rotateZ(0deg) rotateY(0deg); animation-timing-function:ease-in-out; }
        ${f(p1e)} { transform: rotateZ(10800deg) rotateY(0deg); }
        ${f(p1e+0.1)},${f(p7s-0.1)} { transform: rotateZ(0deg) rotateY(0deg); }
        ${f(p7s)} { transform: rotateZ(0deg) rotateY(0deg); animation-timing-function:ease-in-out; }
        100% { transform: rotateZ(0deg) rotateY(4320deg); }
      }
      /* 弧段1：第二段单弧段顺时针 + 第三四段双弧段（第四段顺时针） */
      @keyframes xzg-theme-ring-sweep {
        0%,${f(p2s-0.1)} { transform: rotate(0deg); opacity:0; }
        ${f(p2s)} { transform: rotate(0deg); opacity:1; }
        ${f(p2e)} { transform: rotate(360deg); opacity:1; }
        ${f(p2e+0.1)} { transform: rotate(360deg); opacity:0; }
        ${f(p3s)} { transform: rotate(360deg); opacity:0; }
        ${f(p3s+0.1)} { transform: rotate(360deg); opacity:1; }
        ${f(p3e)} { transform: rotate(720deg); opacity:1; }
        ${f(p3e+0.1)} { transform: rotate(720deg); opacity:0; }
        ${f(p4s)} { transform: rotate(720deg); opacity:0; }
        ${f(p4s+0.1)} { transform: rotate(720deg); opacity:1; }
        ${f(p4e)} { transform: rotate(1080deg); opacity:1; }
        ${f(p4e+0.1)},100% { transform: rotate(1080deg); opacity:0; }
      }
      /* 弧段2：第三四段双弧段（第四段逆时针，与弧段1反向） */
      @keyframes xzg-theme-ring-sweep-2 {
        0%,${f(p3s-0.1)} { transform: rotate(0deg); opacity:0; }
        ${f(p3s)} { transform: rotate(0deg); opacity:1; }
        ${f(p3e)} { transform: rotate(360deg); opacity:1; }
        ${f(p3e+0.1)} { transform: rotate(360deg); opacity:0; }
        ${f(p4s)} { transform: rotate(360deg); opacity:0; }
        ${f(p4s+0.1)} { transform: rotate(360deg); opacity:1; }
        ${f(p4e)} { transform: rotate(0deg); opacity:1; }
        ${f(p4e+0.1)},100% { transform: rotate(0deg); opacity:0; }
      }
      /* 第五段：X 交叉双线（4px 宽）从左往右滑动 */
      @keyframes xzg-theme-inner-sweep {
        0%,${f(p5s-0.1)} { clip-path: polygon(evenodd, -31px 0px, 0px 0px, 0px 31px, -31px 31px, -31px 0px, 0px 0px, -15.5px 13.5px, -31px 31px, 0px 31px, -15.5px 17.5px); opacity:0; }
        ${f(p5s)} { clip-path: polygon(evenodd, -31px 0px, 0px 0px, 0px 31px, -31px 31px, -31px 0px, 0px 0px, -15.5px 13.5px, -31px 31px, 0px 31px, -15.5px 17.5px); opacity:1; }
        ${f(p5e)} { clip-path: polygon(evenodd, 31px 0px, 62px 0px, 62px 31px, 31px 31px, 31px 0px, 62px 0px, 46.5px 13.5px, 31px 31px, 62px 31px, 46.5px 17.5px); opacity:1; }
        ${f(p5e+0.1)},100% { clip-path: polygon(evenodd, 31px 0px, 62px 0px, 62px 31px, 31px 31px, 31px 0px, 62px 0px, 46.5px 13.5px, 31px 31px, 62px 31px, 46.5px 17.5px); opacity:0; }
      }
      /* 第六段：明暗呼吸（opacity 两次起伏） */
      @keyframes xzg-theme-icon-breathe {
        0%,${f(p6s-0.1)} { opacity:1; }
        ${f(p6s)} { opacity:1; }
        ${f(p6s+seg6Pct*0.25)} { opacity:0.45; }
        ${f(p6s+seg6Pct*0.5)} { opacity:1; }
        ${f(p6s+seg6Pct*0.75)} { opacity:0.45; }
        ${f(p6e)} { opacity:1; }
        ${f(p6e+0.1)},100% { opacity:1; }
      }
      @keyframes xzg-theme-ring-glow {
        0%,100% { filter:drop-shadow(0 0 0 transparent); }
      }
      @keyframes xzg-theme-inner-glow {
        0%,60%,100% { filter:drop-shadow(0 0 0 rgba(0,212,255,0)); }
        68%,92% { filter:drop-shadow(0 0 2px rgba(0,212,255,.7)); }
      }
      @media (prefers-reduced-motion: reduce) {
        .xzg-theme-sweep-layer { animation:none !important; }
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
    width:35px;height:35px;padding:2px;box-sizing:border-box;flex:none;
    cursor:pointer;border-radius:6px;user-select:none;
    transition:background 0.15s;align-self:center;margin:auto 0;
    background:transparent;perspective:150px;
  `;
  const iconUrl = new URL("./xzg_theme_icon_mid.png", import.meta.url).href;
  const iconWrap = document.createElement("span");
  // 新 Logo 为方形透明画布，完整保留圆环与字母，不再使用圆形裁切。
  iconWrap.style.cssText = "position:relative;display:block;width:31px;height:31px;flex:none;overflow:hidden;pointer-events:none;";
  const icon = document.createElement("img");
  icon.src = iconUrl;
  icon.alt = "XZG";
  icon.draggable = false;
  icon.style.cssText = "position:absolute;inset:0;display:block;width:31px;height:31px;object-fit:contain;";
  const makeSweepLayer = (className, mask, animationName, glowName) => {
    const layer = document.createElement("img");
    layer.className = `xzg-theme-sweep-layer ${className}`;
    layer.src = new URL("./xzg_theme_icon_bright.png", import.meta.url).href;
    layer.alt = "";
    layer.draggable = false;
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText = `position:absolute;inset:0;display:block;width:31px;height:31px;object-fit:contain;opacity:0;pointer-events:none;${mask}animation:${animationName} 5s linear infinite,${glowName} 5s ease-in-out infinite;`;
    return layer;
  };
  const brightUrl = new URL("./xzg_theme_icon_bright.png", import.meta.url).href;
  // 第四段：X 交叉双线从左往右滑动
  const innerSweep = document.createElement("div");
  innerSweep.className = "xzg-theme-sweep-layer xzg-theme-inner-sweep";
  innerSweep.setAttribute("aria-hidden", "true");
  innerSweep.style.cssText = `position:absolute;inset:0;width:31px;height:31px;pointer-events:none;opacity:0;background:url(${brightUrl}) center/31px 31px no-repeat;`;
  // 弧段1（顶部）：第二段单弧段顺时针 + 第三四段双弧段
  const ringSweep = document.createElement("div");
  ringSweep.className = "xzg-theme-sweep-layer xzg-theme-ring-sweep";
  ringSweep.setAttribute("aria-hidden", "true");
  ringSweep.style.cssText = `position:absolute;inset:0;width:31px;height:31px;pointer-events:none;opacity:0;background:url(${brightUrl}) center/31px 31px no-repeat;clip-path:path('M 11.54 0.72 A 15.3 15.3 0 0 1 19.46 0.72 L 18.99 2.46 A 13.5 13.5 0 0 0 12.01 2.46 Z');transform-origin:15.5px 15.5px;`;
  // 弧段2（底部，相隔180°）：第三四段双弧段
  const ringSweep2 = document.createElement("div");
  ringSweep2.className = "xzg-theme-sweep-layer xzg-theme-ring-sweep-2";
  ringSweep2.setAttribute("aria-hidden", "true");
  ringSweep2.style.cssText = `position:absolute;inset:0;width:31px;height:31px;pointer-events:none;opacity:0;background:url(${brightUrl}) center/31px 31px no-repeat;clip-path:path('M 19.46 30.28 A 15.3 15.3 0 0 1 11.54 30.28 L 12.01 28.54 A 13.5 13.5 0 0 0 18.99 28.54 Z');transform-origin:15.5px 15.5px;`;
  // 中亮图常驻；JS 随机调度七段动画，段间间隔5分钟。
  iconWrap.append(icon, innerSweep, ringSweep, ringSweep2);
  btn.appendChild(iconWrap);
  // ===== 随机动画调度（Web Animations API）=====
  const GAP_MS = 5 * 60 * 1000; // 段间间隔 5 分钟
  const X_LEFT = "polygon(evenodd, -31px 0px, 0px 0px, 0px 31px, -31px 31px, -31px 0px, 0px 0px, -15.5px 13.5px, -31px 31px, 0px 31px, -15.5px 17.5px)";
  const X_RIGHT = "polygon(evenodd, 31px 0px, 62px 0px, 62px 31px, 31px 31px, 31px 0px, 62px 0px, 46.5px 13.5px, 31px 31px, 62px 31px, 46.5px 17.5px)";
  const SEGMENTS = [
    { name:"Z轴高速旋转", duration:10000, easing:"ease-in-out", plays:[
      { el:iconWrap, kf:[{transform:"rotateZ(0deg) rotateY(0deg)"},{transform:"rotateZ(10800deg) rotateY(0deg)"}] },
    ]},
    { name:"单弧段顺时针", duration:2400, easing:"linear", before:()=>{ringSweep.style.opacity=1;ringSweep2.style.opacity=0;}, plays:[
      { el:ringSweep, kf:[{transform:"rotate(0deg)"},{transform:"rotate(360deg)"}] },
    ]},
    { name:"双弧段同向", duration:2400, easing:"linear", before:()=>{ringSweep.style.opacity=1;ringSweep2.style.opacity=1;}, plays:[
      { el:ringSweep, kf:[{transform:"rotate(0deg)"},{transform:"rotate(360deg)"}] },
      { el:ringSweep2, kf:[{transform:"rotate(0deg)"},{transform:"rotate(360deg)"}] },
    ]},
    { name:"双弧段反向", duration:2400, easing:"linear", before:()=>{ringSweep.style.opacity=1;ringSweep2.style.opacity=1;}, plays:[
      { el:ringSweep, kf:[{transform:"rotate(0deg)"},{transform:"rotate(360deg)"}] },
      { el:ringSweep2, kf:[{transform:"rotate(360deg)"},{transform:"rotate(0deg)"}] },
    ]},
    { name:"X交叉双线扫掠", duration:2400, easing:"linear", before:()=>{innerSweep.style.opacity=1;}, plays:[
      { el:innerSweep, kf:[{clipPath:X_LEFT},{clipPath:X_RIGHT}] },
    ]},
    { name:"明暗呼吸", duration:2400, easing:"ease-in-out", plays:[
      { el:icon, kf:[{opacity:1},{opacity:0.45},{opacity:1},{opacity:0.45},{opacity:1}] },
    ]},
    { name:"Y轴吹铜钱", duration:10000, easing:"ease-in-out", plays:[
      { el:iconWrap, kf:[{transform:"rotateZ(0deg) rotateY(0deg)"},{transform:"rotateZ(0deg) rotateY(4320deg)"}] },
    ]},
  ];
  let _animLoopTimer = null;
  function resetLayers() {
    iconWrap.getAnimations().forEach(a=>a.cancel());
    icon.getAnimations().forEach(a=>a.cancel());
    innerSweep.getAnimations().forEach(a=>a.cancel());
    ringSweep.getAnimations().forEach(a=>a.cancel());
    ringSweep2.getAnimations().forEach(a=>a.cancel());
    iconWrap.style.transform = "";
    icon.style.opacity = "";
    innerSweep.style.opacity = 0;
    innerSweep.style.clipPath = "";
    ringSweep.style.opacity = 0;
    ringSweep.style.transform = "";
    ringSweep2.style.opacity = 0;
    ringSweep2.style.transform = "";
  }
  async function playRandomSegment() {
    resetLayers();
    const seg = SEGMENTS[Math.floor(Math.random() * SEGMENTS.length)];
    if (seg.before) seg.before();
    const handles = seg.plays.map(p => p.el.animate(p.kf, { duration: seg.duration, easing: seg.easing, fill: "forwards" }));
    await Promise.all(handles.map(h => h.finished));
    resetLayers();
    _animLoopTimer = setTimeout(playRandomSegment, GAP_MS);
  }
  playRandomSegment();
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
    }
    _runTimerBtn = document.getElementById(XZG_RUN_TIMER_BTN_ID) || buildRunTimerButton();
    attachRunTimerContextMenu(_runTimerBtn);
    _runTimerBtn.style.display = _floatHidden ? "none" : "flex";
    _runTimerBtn.style.visibility = _monitorInitialized ? "visible" : "hidden";
    applyTimerEffect();
    if (_float) {
      _float.setToolbarHosts(
        _runTimerBtn.querySelector("#xzg-toolbar-monitor-stats"),
        _runTimerBtn.querySelector("#xzg-toolbar-run-time"),
      );
    }
    const firstMenuItem = container.firstElementChild;
    if (firstMenuItem !== _runTimerBtn) container.insertBefore(_runTimerBtn, firstMenuItem);
    refreshMenuBtn();
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
      } else {
        _float.setVisible(true);
        _float.start();
      }
      injectMenuButton(0);
    });
  } else {
    // 关闭：移除顶部电池与主题按钮，隐藏监控栏并停止轮询。
    // 保留监控栏 DOM，使 stats 节点在再次启用时仍可复用。
    document.querySelectorAll("#" + XZG_BTN_ID).forEach((b) => b.remove());
    document.querySelectorAll("#" + XZG_THEME_BTN_ID).forEach((b) => b.remove());
    if (_runTimerBtn) _runTimerBtn.style.display = "none";
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
      if (_menuEl && !_menuEl.contains(e.target) && !e.target.closest?.(".xzg-run-history-popup") && e.target.id !== XZG_BTN_ID) closeContextMenu();
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
