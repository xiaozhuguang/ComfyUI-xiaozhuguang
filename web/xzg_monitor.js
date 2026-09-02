// 注意：本 ComfyUI 版本(0.33.3)扩展实际挂载在 /extensions/<节点目录名>/js/...，
// 故需 3 级 ../ 才能回到站点根目录 /scripts/app.js
import { app } from "../../../scripts/app.js";

/**
 * 悬浮窗系统监控（xiaozhuguang）
 * - 页面加载后自动在右下角（避开 ComfyUI 底部功能区）显示半透明、可拖拽的监控悬浮窗
 * - 每秒轮询 /xzg/system_monitor_stats 展示 GPU/CPU/内存状态
 * - 工作流中添加 XZG_Monitor 节点后，其“显示悬浮窗”开关可控制本窗显示/隐藏
 * - 拖动位置持久记忆（localStorage），右键电池按钮可设置显示项目与面板底色
 */

const XZG_API = "/xzg/system_monitor_stats";
const XZG_NODE_TYPE = "XiaozhuguangSystemMonitor";
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
  panel_bg: false,
};
let _display = loadDisplay();
let _menuEl = null; // 右键设置菜单

function loadDisplay() {
  try {
    return { ...XZG_DISPLAY_DEFAULT, ...(JSON.parse(localStorage.getItem(XZG_DISPLAY_KEY) || "{}")) };
  } catch (e) {
    return { ...XZG_DISPLAY_DEFAULT };
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
// 样式
// ---------------------------------------------------------------------------

const XZG_CSS = `
#xzg-float{position:fixed;right:16px;bottom:60px;z-index:99999;width:166px;
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
`;

// ---------------------------------------------------------------------------
// 悬浮窗
// ---------------------------------------------------------------------------

function createFloatWindow() {
  const style = document.createElement("style");
  style.textContent = XZG_CSS;
  document.head.appendChild(style);

  const store = loadStore();
  let hidden = !!store.hidden;
  _floatHidden = hidden;

  const root = document.createElement("div");
  root.id = "xzg-float";
  if (_display.panel_bg) root.classList.add("xzg-bg");
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
          <span class="xzg-val">${fmtMem(g.vram_used_mb)}/${fmtMem(g.vram_total_mb)}</span></div>`);
      }
      if (_display.gpu_power && g.power_w != null && !isNaN(g.power_w)) {
        rows.push(`<div class="xzg-row"><span class="xzg-label">功耗</span><span class="xzg-bar"></span>
          <span class="xzg-val">${g.power_w.toFixed(0)}W</span></div>`);
      }
      if (!rows.length) return "";
      const sub = g.index != null ? `GPU${g.index} · ${shortGpuName(g.name)}` : shortGpuName(g.name);
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
      <span class="xzg-val">${fmtMem(mem.used_mb)}/${fmtMem(mem.total_mb)}</span></div>`);
    return `<div class="xzg-sec"><div class="xzg-sec-t">内存</div>${rows.join("")}</div>`;
  }

  let _lastData = null;
  function render(data) {
    _lastData = data;
    try {
      body.innerHTML =
        renderGpu(data) +
        renderCpu(data.cpu || {}) +
        renderMem(data.mem || {});
    } catch (e) {
      // 渲染出错时显示提示，避免内容区静默空白
      body.innerHTML = `<div class="xzg-note">⚠ 渲染出错: ${esc(e && e.message ? e.message : e)}</div>`;
    }
  }

  function renderOffline() {
    body.innerHTML = `<div class="xzg-note">⚠ 连接后端失败，等待重试…</div>`;
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
  setInterval(poll, 1000);
  poll();

  return {
    root,
    setVisible,
    rerender() {
      if (_lastData) render(_lastData);
    },
    applyPanelBg() {
      root.classList.toggle("xzg-bg", !!_display.panel_bg);
    },
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
    { key: "gpu_util", label: "GPU 利用率" },
    { key: "gpu_temp", label: "GPU 温度" },
    { key: "gpu_vram", label: "GPU 显存" },
    { key: "gpu_power", label: "GPU 功耗" },
    { key: "cpu_util", label: "CPU 使用率" },
    { key: "cpu_temp", label: "CPU 温度" },
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
  // 分隔线 + 面板底色开关
  const sep = document.createElement("div");
  sep.style.cssText = "height:1px;background:rgba(255,255,255,0.10);margin:4px 6px;";
  menu.appendChild(sep);
  const bgRow = document.createElement("div");
  bgRow.className = "xzg-menu-it" + (_display.panel_bg ? " on" : "");
  bgRow.innerHTML = `<span class="xzg-menu-box">${_display.panel_bg ? "✓" : ""}</span><span>面板底色</span>`;
  bgRow.addEventListener("click", (e) => {
    e.stopPropagation();
    _display.panel_bg = !_display.panel_bg;
    saveDisplay();
    bgRow.classList.toggle("on", _display.panel_bg);
    bgRow.querySelector(".xzg-menu-box").textContent = _display.panel_bg ? "✓" : "";
    if (_float && _float.applyPanelBg) _float.applyPanelBg();
  });
  menu.appendChild(bgRow);
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
  if (container) {
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
// 注册扩展
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "Xiaozhuguang.SystemMonitor",
  setup() {
    // 右键菜单：点击菜单外 / Esc 关闭
    document.addEventListener("mousedown", (e) => {
      if (_menuEl && !_menuEl.contains(e.target) && e.target.id !== XZG_BTN_ID) closeContextMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeContextMenu();
    });
    window.__xzgFloat = createFloatWindow();
    _float = window.__xzgFloat;
    injectMenuButton(0);
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
