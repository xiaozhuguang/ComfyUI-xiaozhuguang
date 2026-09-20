// 注意：本 ComfyUI 版本(0.33.3)扩展实际挂载在 /extensions/<节点目录名>/js/...，
// 故需 3 级 ../ 才能回到站点根目录 /scripts/app.js
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

/**
 * 悬浮窗系统监控（xiaozhuguang）
 * - 页面加载后自动在右下角（避开 ComfyUI 底部功能区）显示半透明、可拖拽的监控悬浮窗
 * - 每秒轮询 /xzg/system_monitor_stats 展示 GPU/CPU/内存状态
 * - 工作流运行计时：execution_start 开始计时，成功/出错/中断停止；显示工作流名称，
 *   支持历史记录查询（localStorage 持久化，最近 5 条，可清空）
 * - 工作流中添加 XZG_Monitor 节点后，其“显示悬浮窗”开关可控制本窗显示/隐藏
 * - 拖动位置持久记忆（localStorage），右键电池按钮可设置显示项目（面板固定带底色）
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
const XZG_DISPLAY_KEY = "xzg-display-v1";
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
  compact: false, // 精简模式：单行极小胶囊，无进度条/标题，宽度自适应
};
let _display = loadDisplay();
let _menuEl = null; // 右键设置菜单

function loadDisplay() {
  try {
    const raw = localStorage.getItem(XZG_DISPLAY_KEY);
    // 第一次使用（从未保存过显示设置）→ 默认进入精简模式；
    // 已保存过设置的老用户保持其已存状态（存储里没有 compact 键 → 维持常规模式）
    const firstTime = raw == null;
    const s = { ...XZG_DISPLAY_DEFAULT, ...(JSON.parse(raw || "{}")) };
    if (firstTime) s.compact = true;
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
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function fmtMem(mb) {
  if (mb == null || isNaN(mb)) return "--";
  if (mb >= 1024) return (mb / 1024).toFixed(1) + "G";
  return Math.round(mb) + "M";
}

// 显存/内存对简写：5.1G/48.0G → 5/48（取整，不显示单位）；
// 任一项 < 1G 或缺失时回退逐项显示
function fmtMemPair(usedMb, totalMb) {
  const u = usedMb == null || isNaN(usedMb) ? null : usedMb;
  const t = totalMb == null || isNaN(totalMb) ? null : totalMb;
  if (u == null && t == null) return "--";
  if (u != null && t != null && u >= 1024 && t >= 1024) {
    return `${Math.round(u / 1024)}/${Math.round(t / 1024)}`;
  }
  return `${u == null ? "--" : fmtMem(u)}/${t == null ? "--" : fmtMem(t)}`;
}

function fmtTemp(v) {
  if (v == null || isNaN(v)) return "--";
  return v.toFixed(0) + "°C";
}

function pctColor(pct, temp) {
  if (pct >= 85 || (temp != null && temp >= 85)) return "#f5222d";
  if (pct >= 60 || (temp != null && temp >= 70)) return "#faad14";
  return "#52c41a";
}

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
#xzg-float{position:fixed;right:16px;bottom:60px;z-index:999;width:166px;
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
/* 顶部栏横置电池按钮：金色外框 + 绿色电量 */
.xzg-batt{position:relative;display:inline-block;width:24px;height:13px;flex:none;
  border:1.5px solid #d4af37;border-radius:3px;box-shadow:0 0 6px rgba(212,175,55,0.5);
  transition:border-color .25s,box-shadow .25s;}
.xzg-batt::after{content:"";position:absolute;right:-4px;top:50%;transform:translateY(-50%);
  width:2.5px;height:6.5px;background:#d4af37;border-radius:0 1.5px 1.5px 0;transition:background .25s;}
.xzg-batt .xzg-batt-fill{position:absolute;left:1.5px;top:1.5px;bottom:1.5px;
  width:calc(100% - 3px);background:linear-gradient(180deg,#4ade80,#15803d);border-radius:1.5px;
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
/* 精简模式：单行胶囊，宽度自适应，无进度条/分区标题 */
#xzg-float.xzg-compact{width:auto;max-width:92vw;}
#xzg-float.xzg-compact .xzg-bd{padding:10px 8px;}
#xzg-float.xzg-compact .xzg-cmp{display:flex;align-items:center;gap:8px;
  font-size:15px;line-height:1.6;white-space:nowrap;}
#xzg-float.xzg-compact .xzg-cmp b{font-weight:600;}
/* 分区色片：GPU 蓝 / CPU 橙 / 内存 紫，标签与底色同色系，一眼区分 */
#xzg-float.xzg-compact .xzg-cmp .xzg-chip{display:inline-flex;align-items:center;gap:4px;
  padding:2px 9px;border-radius:999px;}
#xzg-float.xzg-compact .xzg-cmp .xzg-chip-gpu b{color:#6fb3ff;}
#xzg-float.xzg-compact .xzg-cmp .xzg-chip-gpu{background:rgba(96,165,250,0.14);
  border:1px solid rgba(96,165,250,0.28);}
#xzg-float.xzg-compact .xzg-cmp .xzg-chip-cpu b{color:#ffc53d;}
#xzg-float.xzg-compact .xzg-cmp .xzg-chip-cpu{background:rgba(250,173,20,0.12);
  border:1px solid rgba(250,173,20,0.26);}
#xzg-float.xzg-compact .xzg-cmp .xzg-chip-mem b{color:#c99cff;}
#xzg-float.xzg-compact .xzg-cmp .xzg-chip-mem{background:rgba(177,127,250,0.13);
  border:1px solid rgba(177,127,250,0.26);}
#xzg-float.xzg-compact .xzg-cmp .xzg-chip-timer{background:rgba(255,255,255,0.08);
  border:1px solid rgba(255,255,255,0.14);}
#xzg-float.xzg-compact .xzg-cmp .xzg-v{font-variant-numeric:tabular-nums;color:#fff;
  display:inline-block;text-align:right;}
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
  root.classList.add("xzg-bg"); // 面板始终带底色
  // 之前点电池按钮隐藏过浮窗：刷新后仍保持隐藏（否则会以空内容的小胶囊形态出现）
  if (hidden) root.style.display = "none";
  // 仅当位置由当前方案（右下角默认）保存过才应用记忆；开启“保持默认”时始终用默认位置
  if (store.posVer === XZG_POS_VER) {
    if (store.left) root.style.left = store.left;
    if (store.top) root.style.top = store.top;
    if (store.left || store.top) {
      root.style.right = "auto";
      root.style.bottom = "auto";
    }
  }
  root.innerHTML = `<div class="xzg-bd"></div>`;

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
    if (!_display.run_timer || _display.compact) {
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
    if (_display.compact) {
      // 精简模式：计时并入单行，运行状态变化立即重渲染该行
      if (_lastData) statsEl.innerHTML = renderCompact(_lastData);
      return;
    }
    renderTimerSec();
    if (_display.hist_open) renderHistory();
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
    saveStore({
      ...loadStore(),
      left: root.style.left,
      top: root.style.top,
      posVer: XZG_POS_VER,
    });
  });

  function setVisible(v) {
    hidden = !v;
    root.style.display = v ? "" : "none";
    _floatHidden = hidden;
    saveStore({ ...loadStore(), hidden: hidden });
    refreshMenuBtn();
    if (v) poll(); // 打开时立即刷新一次数据
  }

  function bar(pct, temp) {
    const c = pctColor(pct, temp);
    const w = Math.max(0, Math.min(100, pct));
    return `<div class="xzg-bar"><i style="width:${w.toFixed(0)}%;background:${c}"></i></div>`;
  }

  function renderGpu(data) {
    if (!data || !data.gpu || !data.gpu.available || !data.gpu.gpus.length) {
      return `<div class="xzg-note">未检测到 NVIDIA GPU</div>`;
    }
    const multiGpu = data.gpu.gpus.length > 1; // 单卡不显示 GPU 编号
    return data.gpu.gpus.map((g) => {
      const vramPct = g.vram_total_mb > 0 ? (g.vram_used_mb / g.vram_total_mb) * 100 : 0;
      const rows = [];
      if (_display.gpu_util) {
        rows.push(`<div class="xzg-row"><span class="xzg-label">利用率</span>${bar(g.util, g.temp)}
          <span class="xzg-val" style="color:${pctColor(g.util, g.temp)}">${g.util.toFixed(0)}%</span></div>`);
      }
      if (_display.gpu_temp) {
        rows.push(`<div class="xzg-row"><span class="xzg-label">温度</span><span class="xzg-bar"></span>
          <span class="xzg-val" style="color:${pctColor(0, g.temp)}">${fmtTemp(g.temp)}</span></div>`);
      }
      if (_display.gpu_vram) {
        rows.push(`<div class="xzg-row"><span class="xzg-label">显存</span>${bar(vramPct, null)}
          <span class="xzg-val">${fmtMemPair(g.vram_used_mb, g.vram_total_mb)}</span></div>`);
      }
      if (_display.gpu_power && g.power_w != null && !isNaN(g.power_w)) {
        rows.push(`<div class="xzg-row"><span class="xzg-label">功耗</span><span class="xzg-bar"></span>
          <span class="xzg-val">${g.power_w.toFixed(0)}W</span></div>`);
      }
      if (!rows.length) return "";
      const sub = (multiGpu && g.index != null) ? `GPU${g.index} · ${shortGpuName(g.name)}` : shortGpuName(g.name);
      return `<div class="xzg-sec"><div class="xzg-sec-t">${sub}</div>${rows.join("")}</div>`;
    }).join("");
  }

  function renderCpu(cpu) {
    const rows = [];
    if (_display.cpu_util) {
      rows.push(`<div class="xzg-row"><span class="xzg-label">使用率</span>${bar(cpu.util, cpu.temp)}
        <span class="xzg-val" style="color:${pctColor(cpu.util, cpu.temp)}">${cpu.util.toFixed(0)}%</span></div>`);
    }
    // CPU 温度检测不到时整行隐藏，不留占位
    if (_display.cpu_temp && cpu.temp != null && !isNaN(cpu.temp)) {
      rows.push(`<div class="xzg-row"><span class="xzg-label">温度</span><span class="xzg-bar"></span>
        <span class="xzg-val" style="color:${pctColor(0, cpu.temp)}">${fmtTemp(cpu.temp)}</span></div>`);
    }
    if (!rows.length) return "";
    let sub = `${cpu.cores || "--"} 线程`;
    if (cpu.freq_mhz) sub += ` · ${(cpu.freq_mhz / 1000).toFixed(1)} GHz`;
    return `<div class="xzg-sec"><div class="xzg-sec-t">CPU <span class="xzg-sub">${sub}</span></div>${rows.join("")}</div>`;
  }

  function renderMem(mem) {
    if (!_display.mem_used) return "";
    const rows = [];
    rows.push(`<div class="xzg-row"><span class="xzg-label">占用</span>${bar(mem.percent, null)}
      <span class="xzg-val">${fmtMemPair(mem.used_mb, mem.total_mb)}</span></div>`);
    return `<div class="xzg-sec"><div class="xzg-sec-t">内存</div>${rows.join("")}</div>`;
  }

  // 精简模式：单行小胶囊。只输出勾选的数值（无进度条/标题/单位占位），
  // 遵循与常规模式相同的显示项开关；计时作为行首「圆点+时长」并入。
  // 各数值段带 min-width（ch 单位）+ 右对齐 + tabular-nums，
  // 位数增减（9%→100%、45°→102°）时胶囊总宽不跳动。
  function renderCompact(data) {
    // 数值段通用：min-width 固定占位（覆盖常见位数范围，超出时自然放宽）
    const v = (content, minCh, extra) =>
      `<span class="xzg-v" style="min-width:${minCh}ch;${extra || ""}">${content}</span>`;
    const parts = [];
    if (_display.run_timer) {
      const dot = _run.running ? `<span style="color:#52c41a">●</span>` : `<span style="color:#6b7280">●</span>`;
      const lastRun = _ranThisSession ? loadRunHistory()[0] : null; // 刷新后不回放历史
      const dur = _run.running ? fmtDur(Date.now() - _run.startTs) : (lastRun ? fmtDur(lastRun.dur) : "00:00");
      parts.push(`<span class="xzg-chip xzg-chip-timer">${dot}${v(dur, 5.5)}</span>`);
    }
    if (data && data.gpu && data.gpu.available && data.gpu.gpus.length) {
      // 单卡不显示编号（GPU 而非 GPU0）；多卡时才用 GPU0/GPU1 区分
      const multiGpu = data.gpu.gpus.length > 1;
      for (const g of data.gpu.gpus) {
        let s = `<b>GPU${multiGpu && g.index != null ? g.index : ""}</b>`;
        if (_display.gpu_util) {
          s += ` ` + v(g.util == null ? "--" : g.util.toFixed(0) + "%", 4.6,
            `color:${pctColor(g.util, g.temp)}`);
        }
        if (_display.gpu_temp) {
          s += ` ` + v(g.temp == null || isNaN(g.temp) ? "--" : g.temp.toFixed(0) + "°", 4.2,
            `color:${pctColor(0, g.temp)}`);
        }
        if (_display.gpu_vram) {
          s += ` ` + v(fmtMemPair(g.vram_used_mb, g.vram_total_mb), 6.5);
        }
        if (_display.gpu_power && g.power_w != null && !isNaN(g.power_w)) {
          s += ` ` + v(g.power_w.toFixed(0) + "W", 5.5);
        }
        parts.push(`<span class="xzg-chip xzg-chip-gpu">${s}</span>`);
      }
    } else if (_display.gpu_util || _display.gpu_temp || _display.gpu_vram || _display.gpu_power) {
      parts.push(`<span class="xzg-chip xzg-chip-gpu"><b>GPU</b> <span class="xzg-v" style="color:#8b8f9a">--</span></span>`);
    }
    const cpu = (data && data.cpu) || {};
    let cs = "";
    if (_display.cpu_util && cpu.util != null && !isNaN(cpu.util)) {
      cs += ` ` + v(cpu.util.toFixed(0) + "%", 4.6, `color:${pctColor(cpu.util, cpu.temp)}`);
    }
    if (_display.cpu_temp && cpu.temp != null && !isNaN(cpu.temp)) {
      cs += ` ` + v(cpu.temp.toFixed(0) + "°", 4.2, `color:${pctColor(0, cpu.temp)}`);
    }
    if (cs) parts.push(`<span class="xzg-chip xzg-chip-cpu"><b>CPU</b>${cs}</span>`);
    if (_display.mem_used && data && data.mem) {
      parts.push(`<span class="xzg-chip xzg-chip-mem"><b>内存</b> ` +
        v(fmtMemPair(data.mem.used_mb, data.mem.total_mb), 6.5) + `</span>`);
    }
    if (!parts.length) {
      return `<div class="xzg-cmp"><span style="color:#8b8f9a">精简模式：右键顶部电池按钮勾选显示项</span></div>`;
    }
    return `<div class="xzg-cmp">${parts.join("")}</div>`;
  }

  let _lastData = null;
  function render(data) {
    _lastData = data;
    try {
      // 精简模式：切换单行胶囊布局（宽度自适应），并整体重渲染
      root.classList.toggle("xzg-compact", !!_display.compact);
      if (_display.compact) {
        statsEl.innerHTML = renderCompact(data);
      } else {
        statsEl.innerHTML =
          renderGpu(data) +
          renderCpu(data.cpu || {}) +
          renderMem(data.mem || {});
      }
      renderTimerSec(); // 运行中时随轮询刷新已用时长
    } catch (e) {
      // 渲染出错时显示提示，避免内容区静默空白
      statsEl.innerHTML = `<div class="xzg-note">⚠ 渲染出错: ${esc(e && e.message ? e.message : e)}</div>`;
    }
  }

  function renderOffline() {
    statsEl.innerHTML = `<div class="xzg-note">⚠ 连接后端失败，等待重试…</div>`;
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
    rerender() {
      // 立即应用精简/常规布局切换（即使暂无数据也先切壳，下一秒轮询补数据）
      root.classList.toggle("xzg-compact", !!_display.compact);
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
let _float = null;       // 悬浮窗实例
let _floatHidden = false; // 悬浮窗当前是否隐藏
let _menuBtn = null;     // 顶部栏按钮

function refreshMenuBtn() {
  if (!_menuBtn) return;
  _menuBtn.classList.toggle("xzg-mon-off", _floatHidden);
}

function closeContextMenu() {
  if (_menuEl) {
    _menuEl.remove();
    _menuEl = null;
  }
}

function showContextMenu(btn) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.id = "xzg-menu";
  menu.className = "xzg-menu";
  menu.innerHTML = `<div class="xzg-menu-t">显示项目</div>`;
  const items = [
    { key: "compact", label: "精简模式（极小占用）" },
    { key: "gpu_util", label: "GPU 利用率" },
    { key: "gpu_temp", label: "GPU 温度" },
    { key: "gpu_vram", label: "GPU 显存" },
    { key: "gpu_power", label: "GPU 功耗" },
    { key: "cpu_util", label: "CPU 使用率" },
    { key: "cpu_temp", label: "CPU 温度" },
    { key: "mem_used", label: "内存占用" },
    { key: "run_timer", label: "运行计时" },
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
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.max(4, r.right - menu.offsetWidth) + "px";
  menu.style.top = r.bottom + 6 + "px";
  const mb = menu.getBoundingClientRect();
  if (mb.bottom > window.innerHeight - 4) {
    menu.style.top = Math.max(4, r.top - mb.height - 6) + "px";
  }
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

function injectMenuButton(retries) {
  const container = findMenuContainer();
  // 仅当容器已挂载到文档时注入；否则等下一次重试，
  // 否则 append 到 detached 容器会因 getElementById 探测不到而重复注入多个按钮
  if (container && container.isConnected) {
    if (!document.getElementById(XZG_BTN_ID)) {
      _menuBtn = buildMenuButton();
      container.appendChild(_menuBtn);
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
    // 关闭：移除所有顶部电池按钮 + 停止轮询 + 隐藏所有浮窗（关闭监控）
    document.querySelectorAll("#" + XZG_BTN_ID).forEach((b) => b.remove());
    _menuBtn = null;
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
