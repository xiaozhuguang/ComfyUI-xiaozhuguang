import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const saveStyle = document.createElement("style");
saveStyle.textContent = `
.xzg-vram-save{width:100%;padding:7px 16px;background:transparent;color:#FFD700;border:1px solid #555;border-radius:4px;cursor:pointer;font-size:15px;font-weight:bold;text-shadow:0 0 8px rgba(255,215,0,.6);transition:background .2s,text-shadow .2s;}
.xzg-vram-save:hover{background:rgba(255,215,0,.1);}
.xzg-vram-save:active{transform:translateY(0);}
.xzg-vram-save:disabled{opacity:.55;cursor:default;}
`;
document.head.appendChild(saveStyle);

let state = null;
let panel = null;
let panelGraph = null;
const defaults = {enabled:false, reserved:0.6, clean_gpu_before:false, clean_gpu_after:false};
function workflowConfig(graph = app.graph) {
  const raw = graph?.extra?.xzg_vram_settings || {};
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof raw[key] === typeof value ? raw[key] : value]));
}
let running = false;
const notices = [];
let activeNotice = null;
let activeNoticeKey = null;
let noticeTimer = null;
let lastUpdate = null;

function enqueueNotice(message, key = null) {
  if (!message) return;
  if (key && activeNoticeKey === key && activeNotice) {
    activeNotice = message;
    draw();
    return;
  }
  const pending = key && notices.find(item => item.key === key);
  if (pending) pending.message = message;
  else notices.push({ message, key });
  showNextNotice();
}

function showNextNotice() {
  if (noticeTimer || activeNotice || !notices.length) return;
  const next = notices.shift();
  activeNotice = next.message;
  activeNoticeKey = next.key;
  draw();
  const summary = document.querySelector(".xzg-vram-summary");
  summary?.animate([
    { opacity: 0, offset: 0 },
    { opacity: 1, offset: 0.15 },
    { opacity: 1, offset: 0.85 },
    { opacity: 0, offset: 1 },
  ], { duration: 3000, easing: "ease-in-out" });
  document.querySelector("#xzg-toolbar-monitor-stats")?.animate([
    { opacity: 1, offset: 0 },
    { opacity: 0, offset: 0.15 },
    { opacity: 0, offset: 0.85 },
    { opacity: 1, offset: 1 },
  ], { duration: 3000, easing: "ease-in-out" });
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    activeNotice = null;
    activeNoticeKey = null;
    draw();
    showNextNotice();
  }, 3000);
}
const icon = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3"/><path d="M8 2v3m4-3v3m4-3v3M8 19v3m4-3v3m4-3v3M2 8h3m-3 4h3m-3 4h3m14-8h3m-3 4h3m-3 4h3"/><path d="M8 8h3v8H8z" fill="currentColor"/><rect x="13" y="8" width="3" height="8" rx="1"/></svg>`;

function accept(value, event = false) {
  if (!value) return;
  state = value;
  if (event && value.updated_at !== lastUpdate) {
    lastUpdate = value.updated_at;
    const startStages = ["cleaning", "start_done"];
    const endStages = ["cleaning_after", "end_done"];
    if (startStages.includes(value.stage)) enqueueNotice(value.message, `${value.prompt_id}:start`);
    else if (endStages.includes(value.stage)) enqueueNotice(value.message, `${value.prompt_id}:end`);
    else if (value.stage === "error") enqueueNotice(value.message);
  }
  draw();
}

function draw() {
  const capsule = document.getElementById("xzg-run-timer-menu-btn") || document.querySelector(".xzg-monitor-toolbar");
  if (!capsule || capsule.classList.contains("xzg-brand-intro")) return;
  let button = capsule.querySelector(".xzg-vram-button");
  if (!button) {
    button = document.createElement("button");
    button.className = "xzg-vram-button";
    button.innerHTML = icon;
    button.title = "显存设置";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", "false");
    button.style.cssText = "display:flex;align-items:center;justify-content:center;flex:0 0 28px;width:28px;height:28px;padding:0;background:transparent;border:0;border-radius:50%;cursor:pointer;color:#85bfff";
    for (const name of ["pointerdown", "dblclick", "contextmenu"]) button.addEventListener(name, e => e.stopPropagation());
    button.addEventListener("click", e => { e.stopPropagation(); panel ? close() : open(button); });
    capsule.appendChild(button);
  }
  const config = workflowConfig();
  const configured = config.enabled || config.clean_gpu_before || config.clean_gpu_after;
  button.style.color = configured ? "#ffd666" : "#a6a6a6";
  button.style.opacity = "1";
  let summary = capsule.querySelector(".xzg-vram-summary");
  if (!summary) {
    summary = document.createElement("span");
    summary.className = "xzg-vram-summary";
    summary.style.cssText = "font-size:12px;white-space:nowrap;color:#9ecaff;max-width:260px;overflow:hidden;text-overflow:ellipsis";
    capsule.insertBefore(summary, button);
  }
  const show = !!activeNotice;
  summary.style.display = "block";
  summary.style.position = "absolute";
  summary.style.opacity = "0";
  summary.style.pointerEvents = "none";
  summary.textContent = activeNotice || "";
  summary.title = state?.message || "显存设置";
  const stats = capsule.querySelector("#xzg-toolbar-monitor-stats");
  if (stats) {
    stats.style.display = "";
    summary.style.left = `${stats.offsetLeft}px`;
    summary.style.width = `${stats.offsetWidth}px`;
    stats.style.pointerEvents = show ? "none" : "";
  }
  if (panel && panelGraph !== app.graph) close();

}

function close() {
  panel?.remove(); panel = null;
  document.querySelector(".xzg-vram-button")?.setAttribute("aria-expanded", "false");
}

function open(button) {
  button.setAttribute("aria-expanded", "true");
  panel = document.createElement("form");
  panel.style.cssText = "position:fixed;z-index:100100;width:290px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:16px;background:#20242c;color:#e5edf7;border:1px solid #4c6078;border-radius:14px;box-shadow:0 12px 40px #0008;font:13px system-ui;display:grid;gap:12px;user-select:none;-webkit-user-select:none";
  panel.innerHTML = `<strong>显存设置</strong><fieldset style="margin:0;padding:12px;border:1px solid #4c6078;border-radius:10px;display:grid;gap:12px"><label style="display:flex;align-items:center;justify-content:space-between;gap:16px"><strong>额外显存预留</strong><input name="enabled" type="checkbox" role="switch" aria-label="开启额外显存预留"></label><label style="display:flex;align-items:center;justify-content:space-between">预留量 <span><input name="reserved" aria-label="预留量 GB" type="number" min="-2" step="0.1" style="width:85px;user-select:text;-webkit-user-select:text"> GB</span></label></fieldset><div style="display:grid;gap:10px"><strong>运行清理</strong><label><input name="clean_gpu_before" type="checkbox"> 运行<span style="color:#ff6666">前</span>清理显存和模型</label><label><input name="clean_gpu_after" type="checkbox"> 运行<span style="color:#ff6666">后</span>清理显存和模型</label></div><small style="color:#aab5c5">清理后可能需要重新加载模型。设置随工作流保存，修改用于下次任务。</small><small data-result role="status"></small><button type="submit" class="xzg-vram-save">保存</button>`;
  panelGraph = app.graph;
  const config = workflowConfig(panelGraph);
  for (const [key, value] of Object.entries(config)) {
    const input = panel.elements.namedItem(key);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = value; else input.value = value;
  }
  const enabledChange = () => {
    panel.elements.namedItem("reserved").disabled = !panel.elements.enabled.checked;
  };
  panel.elements.enabled.addEventListener("change", enabledChange);
  enabledChange();
  panel.addEventListener("submit", async e => {
    e.preventDefault();
    const current = panel;
    const config = {};
    for (const key of ["enabled", "reserved", "clean_gpu_before", "clean_gpu_after"]) {
      const input = current.elements.namedItem(key);
      config[key] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
    }
    const result = current.querySelector("[data-result]");
    const submit = current.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      if (panelGraph !== app.graph) throw new Error("工作流已切换，请重新打开设置");
      if (!Number.isFinite(config.reserved) || config.reserved < -2) throw new Error("预留参数超出范围");
      panelGraph.beforeChange?.();
      panelGraph.extra ||= {};
      panelGraph.extra.xzg_vram_settings = {...config};
      panelGraph.afterChange?.();
      panelGraph.setDirtyCanvas?.(true, true);
      if (panel === current) close();
    } catch (error) { result.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  panel.addEventListener("pointerdown", e => e.stopPropagation());
  document.body.appendChild(panel);
  const rect = button.getBoundingClientRect();
  panel.style.left = `${Math.max(12, Math.min(rect.right - 290, innerWidth - 302))}px`;
  panel.style.top = `${Math.max(12, Math.min(rect.bottom + 8, innerHeight - panel.offsetHeight - 12))}px`;
  draw();
}

document.addEventListener("pointerdown", e => { if (panel && !panel.contains(e.target) && !e.target.closest(".xzg-vram-button")) close(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
api.addEventListener("xzg_vram_state", e => accept(e.detail, true));
api.addEventListener("execution_start", () => { running = true; draw(); });
for (const name of ["execution_success", "execution_error", "execution_interrupted"]) api.addEventListener(name, () => { running = false; draw(); });
api.addEventListener("executing", e => {
  const node = typeof e.detail === "object" && e.detail !== null ? e.detail.node : e.detail;
  running = node != null; draw();
});
setInterval(draw, 400);
api.fetchApi("/xzg/vram_settings").then(r => r.json()).then(value => accept(value)).catch(error => console.warn("[小珠光] 显存设置加载失败", error));

export function updateVramState(value) { accept(value); }


app.registerExtension({
  name: "xiaozhuguang.VramWorkflowSettings",
  afterConfigureGraph() { close(); draw(); },
});
