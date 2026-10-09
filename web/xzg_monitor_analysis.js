const METRICS = [
  { key: "gpu_vram", label: "GPU 显存", unit: "GB", index: 2, scale: 1024 },
  { key: "gpu_temp", label: "GPU 温度", unit: "°C", index: 1 },
  { key: "gpu_power", label: "GPU 功率", unit: "W", index: 3 },
  { key: "gpu_util", label: "GPU 利用率", unit: "%", index: 0 },
  { key: "mem_used", label: "内存占用", unit: "GB", index: 1, scale: 1024 },
  { key: "cpu_util", label: "CPU 利用率", unit: "%", index: 0 },
];

export function analyzeRunRecords(records, display = {}) {
  const finite = (value) => value != null && Number.isFinite(Number(value));
  return records.map((record) => {
    const samples = (record.samples || []).filter((sample) => finite(sample[0])).slice().sort((a, b) => a[0] - b[0]);
    const durationMs = Math.max(0, finite(record.durationMs) ? Number(record.durationMs)
      : finite(record.finishedAt) ? Number(record.finishedAt) - Number(record.startedAt)
      : Number(samples.at(-1)?.[0]) || 0);
    const duration = durationMs / 1000;
    // 结束后的补充采样不计入运行峰值、平均值和能耗。
    const runningSamples = samples.filter((sample) => sample[0] <= durationMs);
    const gpuCount = Math.max(record.gpuNames?.length || 0, ...runningSamples.map((sample) => sample[1]?.length || 0));
    const series = [];
    for (const metric of METRICS) {
      if (record.enabledMetrics && record.enabledMetrics[metric.key] === false) continue;
      if (!record.enabledMetrics && display[metric.key] === false) continue;
      const isGpu = metric.key.startsWith("gpu_");
      for (let gpu = 0; gpu < (isGpu ? gpuCount : 1); gpu++) {
        const schema = Number(record.schemaVersion) || 1;
        const cpuIndex = schema >= 3 ? metric.index : schema >= 2 ? (metric.index === 1 ? 2 : metric.index) : (metric.index === 1 ? 3 : metric.index);
        const points = runningSamples.map((sample) => {
          const raw = isGpu ? sample[1]?.[gpu]?.[metric.index] : sample[2]?.[cpuIndex];
          return { x: Number(sample[0]) / 1000, y: finite(raw) ? Number(raw) / (metric.scale || 1) : null, node: sample[3] || null };
        });
        const valid = points.filter((point) => point.y != null);
        let peak = null, integral = 0, coveredSeconds = 0;
        for (const point of valid) if (!peak || point.y > peak.y) peak = point;
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1], b = points[i], dt = b.x - a.x;
          if (a.y == null || b.y == null || dt <= 0) continue;
          integral += (a.y + b.y) / 2 * dt;
          coveredSeconds += dt;
        }
        const gpuId = String(record.gpuIds?.[gpu] ?? gpu);
        const rawCapacity = metric.key === "gpu_vram" ? record.gpuCapacityMb?.[gpu]
          : metric.key === "gpu_power" ? record.gpuPowerLimitsW?.[gpu]
          : metric.key === "mem_used" ? record.memoryTotalMb : metric.unit === "%" ? 100 : null;
        const capacity = finite(rawCapacity) && Number(rawCapacity) > 0 ? Number(rawCapacity) / (metric.scale || 1) : null;
        series.push({ key: isGpu ? `${metric.key}:${gpuId}` : metric.key, metricKey: metric.key,
          label: isGpu ? `${metric.label}${gpuCount > 1 ? ` · GPU ${gpuId}` : ""}` : metric.label, gpuName: isGpu ? record.gpuNames?.[gpu] || "" : "",
          unit: metric.unit, capacity, points, peak,
          average: coveredSeconds > 0 ? integral / coveredSeconds : valid[0]?.y ?? null,
          energyWh: metric.key === "gpu_power" && coveredSeconds > 0 ? integral / 3600 : null,
          coveredSeconds,
        });
      }
    }
    const intervals = (record.nodeIntervals || []).map((interval) => ({
      start: Math.max(0, Number(interval.startMs) || 0) / 1000,
      end: Math.min(durationMs, Math.max(0, Number(interval.endMs ?? durationMs) || 0)) / 1000,
      node: interval.node,
    })).filter((interval) => interval.node && interval.end > interval.start);
    const nodes = new Map();
    for (const interval of intervals) {
      const key = String(interval.node.id);
      const node = nodes.get(key) || { id: key, title: String(interval.node.title || key), seconds: 0, intervals: [] };
      node.seconds += interval.end - interval.start;
      node.intervals.push(interval);
      nodes.set(key, node);
    }
    return { id: record.id, name: String(record.analysisName || record.workflowName || "未命名工作流"), startedAt: record.startedAt,
      status: record.status || "", duration, series, nodes: [...nodes.values()].filter((node) => node.seconds >= 1), intervals };
  });
}

export function buildRunAnalysisHtml(records, display = {}) {
  const data = JSON.stringify(analyzeRunRecords(records, display)).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小珠光 · 工作流运行分析</title>
<style>
:root{color-scheme:dark;font:14px/1.6 'Segoe UI',system-ui,sans-serif;background:#101319;color:#e6e8ef}*{box-sizing:border-box}body{margin:0}main{max-width:1440px;margin:auto;padding:30px 28px 60px}h1{font-size:28px;margin:0;color:#FFD700}h2{font-size:18px;margin:0 0 14px}p{color:#9ba5b6;margin:8px 0 18px}.card{background:#191e27;border:1px solid #303846;border-radius:12px;padding:20px;margin:18px 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.grid .card{margin:0}button,select{font:inherit;border:1px solid #485162;background:#252d3a;color:#eceef5;border-radius:6px;padding:6px 12px}button{cursor:pointer}button:hover{border-color:#FFD700}label{cursor:pointer}input{accent-color:#FFD700}.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin:12px 0}.legend label{font-size:13px}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}.chart{width:100%;max-width:100%;height:auto;display:block;overflow:visible}/* 与「资源采样峰值对比」的半宽网格列等宽（(100% - 18px 间距)/2），保证两区柱状图同比例缩放、行行对齐 */
#duration{max-width:calc(50% - 9px)}.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}.card-head h2{margin:0}.card-head select{max-width:min(420px,100%)}.chart text{font-family:'Segoe UI',system-ui,sans-serif}.hint{font-size:12px;color:#98a4b8}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px;white-space:nowrap}th,td{padding:9px 12px;border-bottom:1px solid #303846;text-align:right}th:first-child,td:first-child{text-align:left}th{color:#acb6c9}.tooltip{position:fixed;display:none;pointer-events:none;background:#111722f2;border:1px solid #6c778b;border-radius:7px;padding:9px 12px;z-index:10;max-width:420px;font-size:12px;white-space:pre-line}.range-info{color:#FFD700;min-height:24px}.bar{cursor:pointer}.bar:hover{filter:brightness(1.2)}.badge{padding:3px 8px;background:#252c39;border-radius:4px}.empty{padding:40px;text-align:center;color:#99a4b6}@media(max-width:850px){main{padding:18px 12px}.grid{grid-template-columns:1fr}.card{padding:14px}h1{font-size:23px}#duration{max-width:100%}}@media print{button,.tooltip{display:none}.card{break-inside:avoid}}
button:focus,select:focus,input:focus{outline:none;box-shadow:none}select:focus{border-color:#485162}
</style></head><body><main><header><div class="controls"><h1>工作流运行分析</h1><button id="download">保存分析网页</button></div><p>从运行开始对齐时间 · 物理显存口径 · 峰值为约每秒采样得到的峰值，短暂尖峰可能未被捕捉。此报告为生成时的记录快照。</p></header>
<div id="records" class="legend"></div>
<section class="card"><h2>资源曲线叠加</h2><div id="metrics" class="legend"></div><p class="hint">点选一个指标查看实际数值，不同记录用颜色区分；悬停查看采样值和执行节点。</p><div id="range-info" class="range-info"></div><div id="overlay"></div></section>
<section class="card"><div class="card-head"><h2>耗时对比</h2><div id="duration-select"></div></div><div id="duration"></div></section>
<section class="card"><div class="card-head"><h2>资源采样峰值对比</h2><div id="peaks-select"></div></div><p class="hint">点击柱子定位到峰值时间，查看对应曲线及执行节点。虚线标出记录当时的容量或功率上限；旧记录未保存上限时不显示容量线。右侧下拉选择节点后，峰值与平均值仅统计该节点执行区间。</p><div id="peaks" class="grid"></div></section>
<section class="card"><div class="card-head"><h2>节点耗时分析</h2><div id="node-head" class="controls" style="display:flex;flex-wrap:wrap;align-items:center;gap:16px"><button type="button" data-node-order="duration"><span class="order-check" aria-hidden="true"></span>耗时从高到低</button><button type="button" data-node-order="execution"><span class="order-check" aria-hidden="true"></span>执行顺序</button></div></div><p class="hint">点击节点柱子或时间轴，曲线会高亮对应执行时间段。缓存命中的节点可能没有执行区间；旧记录缺少区间时无法还原准确节点耗时。</p><div class="grid"><div><h2>节点耗时</h2><div id="nodes"></div></div><div><h2>执行耗时占比</h2><div id="donut"></div></div></div><h2>执行时间轴</h2><div id="timeline"></div></section>
 </main><div id="tooltip" class="tooltip"></div>
<script id="analysis-data" type="application/json">${data}</script><script>(${runAnalysisPage.toString()})();</script></body></html>`;
}

function showRenameDialog(currentName) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.style.cssText = "width:min(400px,calc(100vw - 32px));padding:20px;border:1px solid #62604b;border-radius:12px;background:#20242d;color:#eee;font:14px/1.6 'Segoe UI',system-ui,sans-serif;z-index:100006;color-scheme:dark;box-shadow:0 12px 40px #0009";
    dialog.innerHTML = `<form method="dialog" style="display:grid;gap:14px"><strong style="color:#FFD700;font-size:16px">重命名记录</strong><input name="name" type="text" autocomplete="off" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #566174;border-radius:6px;background:#151a22;color:#f1f3f8;font:14px inherit;outline:none"><div style="display:flex;justify-content:flex-end;gap:8px"><button value="cancel" style="padding:7px 14px;border:1px solid #596273;border-radius:5px;background:#2a303b;color:#ddd;cursor:pointer">取消</button><button value="save" style="padding:7px 14px;border:1px solid #9b8240;border-radius:5px;background:#302b1c;color:#FFD700;cursor:pointer">保存</button></div></form>`;
    const input = dialog.querySelector("input");
    input.value = currentName;
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "save" ? input.value.trim() : null);
      dialog.remove();
    }, { once: true });
    document.body.appendChild(dialog);
    dialog.showModal();
    input.focus(); input.select();
  });
}

export function showRunAnalysisPicker(records, selectedId, display, onRename = null) {
  document.getElementById("xzg-analysis-picker")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "xzg-analysis-picker";
  dialog.style.cssText = "width:min(620px,calc(100vw - 32px));max-height:80vh;padding:22px;border:1px solid #62604b;border-radius:12px;background:#20242d;color:#eee;font:14px/1.6 'Segoe UI',system-ui,sans-serif;z-index:100005;color-scheme:dark;";
  const title = document.createElement("h3");
  title.textContent = "选择历史记录 · 图表分析";
  title.style.cssText = "margin:0 0 8px;color:#FFD700;";
  const note = document.createElement("p");
  note.textContent = "勾选一条生成单次分析，勾选多条生成对比。资源指标跟随胶囊启用项。";
  note.style.cssText = "color:#abb4c3;margin:0 0 12px;";
  const list = document.createElement("div");
  list.style.cssText = "max-height:44vh;overflow:auto;display:grid;gap:6px;";
  // 默认全选全部历史记录（selectedId 仅用于界面定位，不影响勾选状态）
  const selected = new Set(records.map((record) => record.id));
  const checks = [];
  for (const record of records) {
    const label = document.createElement("div");
    label.style.cssText = "display:flex;align-items:center;gap:10px;padding:9px;border-radius:5px;background:#2a303b;cursor:pointer;white-space:nowrap;min-width:0;";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selected.has(record.id);
    check.style.accentColor = "#FFD700";
    const text = document.createElement("span");
    const seconds = Math.max(0, Number(record.durationMs ?? record.samples?.at(-1)?.[0]) || 0) / 1000;
    text.textContent = `${record.workflowName || "未命名工作流"} · ${new Date(record.startedAt).toLocaleString()} · ${seconds.toFixed(1)} 秒`;
    text.style.cssText = "min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    check.addEventListener("change", () => {
      if (check.checked) selected.add(record.id); else selected.delete(record.id);
      generate.disabled = selected.size === 0;
    });
    checks.push({ check, id: record.id });
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "✎ 重命名";
    rename.style.cssText = "flex:none;white-space:nowrap;word-break:keep-all;margin-left:auto;padding:3px 8px;border:1px solid #536177;border-radius:5px;background:#252d3a;color:#dce6f5;font:12px/1.4 'Segoe UI',system-ui,sans-serif;cursor:pointer";
    rename.addEventListener("click", async () => {
      const value = await showRenameDialog(record.workflowName || "未命名工作流");
      if (value == null) return;
      record.workflowName = value || "未命名工作流";
      text.textContent = `${record.workflowName} · ${new Date(record.startedAt).toLocaleString()} · ${seconds.toFixed(1)} 秒`;
      try { await onRename?.(record); } catch (error) { console.warn("[小珠光] 运行记录重命名保存失败", error); }
    });
    label.append(check, text, rename);
    list.appendChild(label);
  }
  if (!records.length) list.textContent = "暂无历史记录，完成一次工作流运行后即可生成分析。";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:16px;";
  const makeButton = (text, kind = "default") => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.style.cssText = "padding:6px 12px;border:0;background:#343942;border-radius:5px;cursor:pointer;color:#fff;";
    return button;
  };
  const all = makeButton("全选 / 取消全选", "green");
  all.disabled = !records.length;
  all.addEventListener("click", () => {
    const checked = selected.size !== records.length;
    selected.clear();
    for (const item of checks) { item.check.checked = checked; if (checked) selected.add(item.id); }
    generate.disabled = selected.size === 0;
  });
  const cancel = makeButton("取消", "red");
  cancel.addEventListener("click", () => dialog.close());
  const generate = makeButton("▮ 生成分析网页", "gold");
  generate.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-3px;margin-right:5px"><path fill="#54c8ff" d="M3 13h4v8H3z"/><path fill="#ffd34e" d="M10 8h4v13h-4z"/><path fill="#d38cff" d="M17 3h4v18h-4z"/></svg><span>生成分析网页</span>`;
  generate.disabled = !selected.size;
  generate.addEventListener("click", () => {
    const html = buildRunAnalysisHtml(records.filter((record) => selected.has(record.id)), display);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const tab = window.open(url, "_blank");
    if (!tab) {
      note.textContent = "浏览器阻止了新标签页，请允许弹出窗口后重试。";
      URL.revokeObjectURL(url);
      return;
    }
    tab.opener = null;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("pointerdown", (event) => event.stopPropagation());
  actions.append(all, cancel, generate);
  dialog.append(title, note, list, actions);
  document.body.appendChild(dialog);
  dialog.showModal();
}

function runAnalysisPage() {
  const runs = JSON.parse(document.getElementById("analysis-data").textContent);
  const $ = (id) => document.getElementById(id);
  const colors = ["#FFD700", "#70c8ff", "#c7a6ef", "#61d9b1", "#ff897e", "#f3b56d", "#86a8ff", "#ed8aca"];
  const color = (i) => i < colors.length ? colors[i] : `hsl(${(i * 137.508) % 360} 72% 67%)`;
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (value, unit = "") => value == null ? "—" : `${Number(value).toFixed(unit === "%" || unit === "W" ? 0 : 1)}${unit}`;
  const time = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  const name = (run, i) => `${i + 1} · ${run.name}`;
  const svg = (body, width, height) => `<svg class="chart" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  const text = (x, y, value, fill = "#aeb8ca", anchor = "start", size = 12) => `<text x="${x}" y="${y}" fill="${fill}" text-anchor="${anchor}" font-size="${size}">${escape(value)}</text>`;
  // 近似文本像素宽度：全角字符（中日韩等）按 font-size 计，半角按 0.55 倍计
  const textWidth = (value, size = 12) => [...String(value)].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? size : size * 0.55), 0);
  // 按像素宽度截断（超出补 …），保证锚点左侧/右侧的文本始终留在 SVG viewBox 内，不溢出卡片边界
  const fitLabel = (value, maxWidth, size = 12) => {
    let out = "", w = 0;
    for (const ch of String(value)) {
      const cw = ch.charCodeAt(0) > 255 ? size : size * 0.55;
      if (w + cw > maxWidth) return out + "…";
      w += cw; out += ch;
    }
    return out;
  };
  const tooltip = (event, value) => {
    $("tooltip").textContent = value;
    $("tooltip").style.display = "block";
    $("tooltip").style.left = `${Math.max(8, Math.min(innerWidth - 430, event.clientX + 14))}px`;
    $("tooltip").style.top = `${Math.max(8, Math.min(innerHeight - $("tooltip").offsetHeight - 8, event.clientY + 14))}px`;
  };
  const hideTooltip = () => { $("tooltip").style.display = "none"; };
  const selectedRuns = new Set(runs.map((_, i) => i));
  const metrics = [...new Map(runs.flatMap((run) => run.series).map((series) => [series.key, series])).values()];
  // 默认选中「GPU 显存」（有有效采样时）；否则退回第一个有有效采样的指标。
  const firstDataMetric = metrics.find((metric) => runs.some((run) => run.series.some((s) => s.key === metric.key && s.peak)));
  const preferredMetric = metrics.find((metric) => metric.key === "gpu_vram" &&
    runs.some((run) => run.series.some((s) => s.key === metric.key && s.peak)));
  let selectedMetric = (preferredMetric || firstDataMetric || metrics[0])?.key || null;
  for (const id of ["records", "metrics"]) $(id).replaceChildren();
  let selectedNodeRun = 0;
  let nodeOrder = "duration";
  hideTooltip();
  let range = null;
  const activeRuns = () => runs.map((run, i) => ({ run, i })).filter(({ i }) => selectedRuns.has(i));
  const empty = (id, message = "没有可展示的数据") => { $(id).innerHTML = `<div class="empty">${escape(message)}</div>`; };
  // ---- 节点下拉（耗时对比与峰值对比各一个，默认统计整次运行） ----
  // 聚合当前勾选记录的全部节点：按节点 id 排序，标题取该节点耗时最长记录的写法
  const nodeUnion = () => {
    const map = new Map();
    for (const { run } of activeRuns()) {
      for (const node of run.nodes) {
        const key = String(node.id), prev = map.get(key);
        if (!prev || node.seconds > prev.seconds) map.set(key, { title: node.title, seconds: node.seconds });
      }
    }
    return [...map.keys()]
      .sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || String(a).localeCompare(String(b)))
      .map((key) => ({ key, title: map.get(key).title }));
  };
  // 按执行区间统计峰值/平均值：不给区间时沿用整次运行的既有统计。
  // 峰值取采样点 x 落在区间内的最大值；平均值沿用梯形积分，按段中点落在区间内计入。
  const seriesStatsWithin = (s, intervals) => {
    if (!s) return { peak: null, average: null };
    if (!intervals) return { peak: s.peak, average: s.average };
    let peak = null, integral = 0, covered = 0;
    for (const point of s.points) {
      if (point.y == null) continue;
      if (!intervals.some((iv) => point.x >= iv.start && point.x <= iv.end)) continue;
      if (!peak || point.y > peak.y) peak = point;
    }
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1], b = s.points[i], dt = b.x - a.x;
      if (a.y == null || b.y == null || dt <= 0) continue;
      const mid = (a.x + b.x) / 2;
      if (!intervals.some((iv) => mid >= iv.start && mid <= iv.end)) continue;
      integral += (a.y + b.y) / 2 * dt;
      covered += dt;
    }
    return { peak, average: covered > 0 ? integral / covered : null };
  };
  let durationNodeKey = "";
  const durationSelect = document.createElement("select");
  durationSelect.addEventListener("change", () => {
    durationNodeKey = durationSelect.value;
    render();
  });
  $("duration-select").appendChild(durationSelect);
  let peakNodeKey = "";
  const peakSelect = document.createElement("select");
  peakSelect.addEventListener("change", () => {
    peakNodeKey = peakSelect.value;
    renderPeaks();
  });
  $("peaks-select").appendChild(peakSelect);
  for (const [i, run] of runs.entries()) {
    const label = document.createElement("div");
    label.style.cssText = "display:flex;align-items:center;gap:7px;";
    label.innerHTML = `<input type="checkbox" checked> <i style="background:${color(i)}"></i><span>${escape(name(run, i))}</span><span class="hint">${escape(new Date(run.startedAt).toLocaleString())}</span>`;
    label.querySelector("input").addEventListener("change", (event) => {
      if (event.target.checked) selectedRuns.add(i); else selectedRuns.delete(i);
      render();
    });
    $("records").appendChild(label);
  }
  // 节点耗时分析的记录切换：标题行右侧下拉（与耗时对比 / 峰值对比一致）
  const nodeRunSelect = document.createElement("select");
  for (const [i, run] of runs.entries()) nodeRunSelect.append(new Option(name(run, i), String(i)));
  nodeRunSelect.value = String(selectedNodeRun);
  nodeRunSelect.addEventListener("change", () => {
    selectedNodeRun = Number(nodeRunSelect.value) || 0;
    renderNodes();
  });
  $("node-head").insertBefore(nodeRunSelect, $("node-head").querySelector("[data-node-order]"));
  for (const metric of metrics) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="radio" name="resource-metric" value="${escape(metric.key)}" ${metric.key === selectedMetric ? "checked" : ""}> ${escape(metric.label)}`;
    label.querySelector("input").addEventListener("change", (event) => {
      selectedMetric = metric.key;
      range = null;
      renderOverlay();
    });
    $("metrics").appendChild(label);
  }
  function focus(i, start, end, label, metricKey) {
    selectedRuns.add(i);
    $("records").querySelectorAll("input")[i].checked = true;
    if (metricKey) {
      selectedMetric = metricKey;
      $("metrics").querySelectorAll("input").forEach(input => { input.checked = input.value === selectedMetric; });
    }
    range = { i, start, end, label };
    renderOverlay();
    $("overlay").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function renderOverlay() {
    const actual = true;
    $("range-info").textContent = range ? `${name(runs[range.i], range.i)} · ${range.label} · ${range.start.toFixed(2)}–${range.end.toFixed(2)} 秒` : "";
    const series = activeRuns().flatMap(({ run, i }) => run.series.filter((s) => s.key === selectedMetric).map((s) => ({ ...s, run, i })));
    if (!series.some((s) => s.peak)) { empty("overlay", "请选择有有效采样的记录和指标"); return; }
    const w = 1100, h = 380, pad = { l: 72, r: 34, t: 22, b: 36 }, pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const maxX = Math.max(1, ...activeRuns().map(({ run }) => run.duration));
    const bases = new Map(metrics.map((metric) => [metric.key, Math.max(1, ...series.filter((s) => s.key === metric.key).map((s) => s.peak?.y || 0))]));
    const normalized = (s, y) => actual ? y : y / (s.capacity || bases.get(s.key) || 1) * 100;
    const maximum = Math.max(1, ...series.flatMap((s) => [s.peak ? normalized(s, s.peak.y) : 0, actual ? s.capacity || 0 : 100]));
    const top = maximum * 1.12;
    const x = (v) => pad.l + v / maxX * pw, y = (v) => pad.t + ph * (1 - v / top);
    let body = "";
    for (let t = 0; t <= 4; t++) {
      const value = maximum * t / 4;
      body += `<path d="M${pad.l},${y(value)}H${w - pad.r}" stroke="#343e4d"/>` + text(pad.l - 9, y(value) + 4, fmt(value, actual ? series[0].unit : "%"), "#aeb8ca", "end");
      body += text(x(maxX * t / 4), h - 10, time(maxX * t / 4), "#aeb8ca", t === 0 ? "start" : t === 4 ? "end" : "middle");
    }
    if (range && selectedRuns.has(range.i)) body += `<rect x="${x(range.start)}" y="${pad.t}" width="${Math.max(2, x(range.end) - x(range.start))}" height="${ph}" fill="${color(range.i)}" opacity=".12"/>`;
    const dashes = ["", "8 4", "3 4", "12 4 3 4", "2 3", "15 5"];
    for (const s of series) {
      let path = "", pen = false;
      for (const point of s.points) {
        if (point.y == null) { pen = false; continue; }
        path += `${pen ? "L" : "M"}${x(point.x).toFixed(2)},${y(normalized(s, point.y)).toFixed(2)}`; pen = true;
      }
      body += `<path d="${path}" fill="none" stroke="${color(s.i)}" stroke-width="2" stroke-dasharray="${dashes[Math.max(0, metrics.findIndex((m) => m.key === s.key)) % dashes.length]}"/>`;
    }
    body += `<line id="crosshair" y1="${pad.t}" y2="${h - pad.b}" stroke="#ffffff88" stroke-dasharray="4 4" visibility="hidden"/>`;
    $("overlay").innerHTML = svg(body, w, h);
    const chart = $("overlay").firstElementChild;
    chart.addEventListener("pointermove", (event) => {
      const rect = chart.getBoundingClientRect(), seconds = Math.max(0, Math.min(maxX, ((event.clientX - rect.left) / rect.width * w - pad.l) / pw * maxX));
      const cross = $("crosshair"); cross.setAttribute("x1", x(seconds)); cross.setAttribute("x2", x(seconds)); cross.setAttribute("visibility", "visible");
      const lines = [`时间 ${seconds.toFixed(2)} 秒`];
      for (const s of series) {
        if (seconds > s.run.duration) continue;
        let low = 0, high = s.points.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (s.points[mid].x < seconds) low = mid + 1; else high = mid;
        }
        let left = low - 1, right = low;
        while (left >= 0 && s.points[left].y == null) left--;
        while (right < s.points.length && s.points[right].y == null) right++;
        const a = s.points[left], b = s.points[right];
        const point = !a ? b : !b || seconds - a.x <= b.x - seconds ? a : b;
        if (point) lines.push(`${name(s.run, s.i)} · ${s.label}：${fmt(point.y, s.unit)}（采样 ${point.x.toFixed(2)}s）${point.node ? ` · ${point.node.title}` : ""}`);
      }
      tooltip(event, lines.join("\n"));
    });
    chart.addEventListener("pointerleave", () => { hideTooltip(); $("crosshair").setAttribute("visibility", "hidden"); });
  }
  function bars(container, entries, unit, onClick, capacities = [], compact = false) {
    if (!entries.length) { empty(container); return; }
    const w = 650, left = 175, right = 100, row = compact ? 32 : 42, barHeight = compact ? 17 : 23, h = entries.length * row + 42;
    const max = Math.max(1, ...entries.map((entry) => entry.value || 0), ...capacities.map((c) => c.value || 0)) * 1.12;
    const plotRight = w - right; // 绘图区右边界，所有图形不得越过
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const xOf = (v) => left + clamp((v || 0) / max, 0, 1) * (plotRight - left);
    let body = "";
    for (const [j, entry] of entries.entries()) {
      const cy = 24 + j * row;
      body += text(left - 9, cy + 5, fitLabel(entry.label, left - 36, 12), "#c3ccda", "end", 12);
      if (entry.value != null) {
        const endX = xOf(entry.value);
        body += `<rect class="bar" data-bar="${j}" x="${left}" y="${cy - barHeight / 2}" width="${Math.max(2, endX - left)}" height="${barHeight}" rx="3" fill="${entry.color}"/>`;
        // 数值标签限制在画布内：右侧按实际文本宽度判断放得下就放条右，放不下则贴在条内右端，绝不越过卡片右边界。
        const valueText = fmt(entry.value, unit);
        const labelAfter = endX + 8 + textWidth(valueText, 12) <= w - 4;
        body += text(labelAfter ? endX + 8 : clamp(endX - 8, left, w - 4), cy + 6, valueText, entry.color, labelAfter ? "start" : "end", 12);
      }
    }
    for (const cap of [...new Map(capacities.map((cap) => [cap.value, cap])).values()]) {
      // 容量虚线及底部标签严格钳制在绘图区/画布内，避免顶到或画出卡片右边界。
      const cx = clamp(xOf(cap.value), left, plotRight);
      const capText = fmt(cap.value, unit), halfW = textWidth(capText, 10) / 2;
      const labelX = clamp(cx, left + halfW + 2, w - halfW - 2);
      body += `<path d="M${cx},8V${h - 25}" stroke="${cap.color}" stroke-dasharray="5 4" opacity=".6"/>` + text(labelX, h - 7, capText, cap.color, "middle", 10);
    }
    $(container).innerHTML = svg(body, w, h);
    $(container).querySelectorAll("[data-bar]").forEach((element) => {
      const entry = entries[Number(element.dataset.bar)];
      element.addEventListener("pointermove", (event) => tooltip(event, entry.detail || `${entry.label}\n${fmt(entry.value, unit)}`));
      element.addEventListener("pointerleave", hideTooltip);
      if (onClick) element.addEventListener("click", () => onClick(entry));
    });
  }
  function renderPeaks() {
    $("peaks").replaceChildren();
    // 节点下拉：选中节点后，峰值与平均值仅统计该节点的执行区间
    const nodeItems = nodeUnion();
    if (peakNodeKey && !nodeItems.some((item) => item.key === peakNodeKey)) peakNodeKey = "";
    peakSelect.replaceChildren(new Option("整次运行", ""));
    for (const item of nodeItems) peakSelect.append(new Option(`${item.key} · ${item.title}`, item.key));
    peakSelect.value = peakNodeKey;
    peakSelect.style.display = nodeItems.length ? "" : "none";
    const scopeLabel = peakNodeKey ? `节点「${nodeItems.find((item) => item.key === peakNodeKey)?.title ?? peakNodeKey}」` : "整次运行";
    const priority = ["gpu_vram", "gpu_temp", "gpu_power", "mem_used"];
    const orderedMetrics = metrics.slice().sort((a, b) => {
      const rank = (key) => { const index = priority.indexOf(key); return index < 0 ? priority.length : index; };
      return rank(a.metricKey) - rank(b.metricKey);
    });
    for (const [j, metric] of orderedMetrics.entries()) {
      const card = document.createElement("div"), title = document.createElement("h2"), plot = document.createElement("div");
      title.textContent = metric.label; plot.id = `peak-${j}`; card.append(title, plot); $("peaks").appendChild(card);
      const entries = activeRuns().map(({ run, i }) => {
        const s = run.series.find((s) => s.key === metric.key);
        const intervals = peakNodeKey ? (run.nodes.find((node) => String(node.id) === peakNodeKey)?.intervals || []) : null;
        const stats = seriesStatsWithin(s, intervals);
        return { i, stats, metric, value: stats.peak?.y ?? null, color: color(i), label: name(run, i),
          detail: `${name(run, i)} · ${scopeLabel}\n${metric.label}峰值：${fmt(stats.peak?.y, metric.unit)}\n时间：${stats.peak?.x?.toFixed(2) ?? "—"} 秒\n节点：${stats.peak?.node?.title || "无节点信息"}\n平均：${fmt(stats.average, metric.unit)}` };
      });
      const caps = activeRuns().flatMap(({ run, i }) => { const capacity = run.series.find((s) => s.key === metric.key)?.capacity; return capacity ? [{ value: capacity, color: color(i) }] : []; });
      bars(plot.id, entries, metric.unit, (entry) => {
        const peak = entry.stats?.peak;
        if (!peak) return;
        const intervals = entry.stats.peak && peakNodeKey
          ? activeRuns().find(({ i }) => i === entry.i)?.run.nodes.find((node) => String(node.id) === peakNodeKey)?.intervals || []
          : null;
        const hit = intervals?.find((iv) => peak.x >= iv.start && peak.x <= iv.end);
        focus(entry.i, hit ? hit.start : peak.x, hit ? hit.end : peak.x, hit ? `资源峰值 · ${scopeLabel}` : "资源峰值", metric.key);
      }, caps);
    }
    if (!metrics.length) $("peaks").textContent = "胶囊未启用资源指标，可继续查看耗时分析。";
  }
  function renderNodes() {
    const i = selectedNodeRun, run = runs[i];
    if (!run) return;
    const nodes = run.nodes.slice();
    if (nodeOrder === "duration") nodes.sort((a, b) => b.seconds - a.seconds);
    bars("nodes", nodes.map((node, j) => ({ label: `${node.id} · ${node.title}`, value: node.seconds, color: color(j), node })), "s", (entry) => {
      const interval = entry.node.intervals[0]; focus(i, interval.start, interval.end, entry.node.title);
    });
    if (!nodes.length) { empty("donut", "这条记录没有节点执行区间"); empty("timeline", "这条记录没有节点执行区间"); return; }
    const sorted = run.nodes.slice().sort((a, b) => b.seconds - a.seconds);
    const slices = sorted.slice(0, 7).map((node) => ({ title: node.title, value: node.seconds }));
    const other = sorted.slice(7).reduce((sum, node) => sum + node.seconds, 0);
    if (other) slices.push({ title: "其他节点", value: other });
    const total = slices.reduce((sum, s) => sum + s.value, 0), radius = 70, perimeter = 2 * Math.PI * radius;
    let offset = 0, donut = "";
    for (const [j, slice] of slices.entries()) {
      const length = slice.value / total * perimeter;
      donut += `<circle cx="110" cy="110" r="${radius}" fill="none" stroke="${color(j)}" stroke-width="28" stroke-dasharray="${length} ${perimeter}" stroke-dashoffset="${-offset}" transform="rotate(-90 110 110)"/>`;
      offset += length;
      donut += text(220, 27 + j * 26, `${slice.title.slice(0, 18)} · ${(slice.value / total * 100).toFixed(1)}%`, color(j));
    }
    donut += text(110, 108, fmt(total, "s"), "#eee", "middle", 19) + text(110, 130, "节点执行合计", "#9ca9bb", "middle");
    $("donut").innerHTML = svg(donut, 590, 225);
    const w = 1100, left = 180, width = w - left - 25, duration = Math.max(1, run.duration), h = nodes.length * 32 + 34;
    let timeline = "";
    nodes.forEach((node, j) => {
      timeline += text(left - 10, j * 32 + 22, fitLabel(`${node.id} · ${node.title}`, left - 36), "#aeb8ca", "end");
      node.intervals.forEach((interval, k) => { timeline += `<rect class="bar" data-node="${j}" data-interval="${k}" x="${left + interval.start / duration * width}" y="${j * 32 + 8}" width="${Math.max(2, (interval.end - interval.start) / duration * width)}" height="19" rx="3" fill="${color(j)}"/>`; });
    });
    for (let t = 0; t <= 4; t++) timeline += text(left + width * t / 4, h - 3, time(duration * t / 4), "#aeb8ca", t === 0 ? "start" : t === 4 ? "end" : "middle");
    $("timeline").innerHTML = svg(timeline, w, h);
    $("timeline").querySelectorAll("[data-node]").forEach((element) => {
      const node = nodes[Number(element.dataset.node)], interval = node.intervals[Number(element.dataset.interval)];
      element.addEventListener("click", () => focus(i, interval.start, interval.end, node.title));
      element.addEventListener("pointermove", (event) => tooltip(event, `${node.title}\n${interval.start.toFixed(2)}–${interval.end.toFixed(2)} 秒\n耗时 ${(interval.end - interval.start).toFixed(2)} 秒`));
      element.addEventListener("pointerleave", hideTooltip);
    });
  }
  function renderScatter() {
    const points = activeRuns().flatMap(({ run, i }) => {
      const peaks = run.series.filter((s) => s.metricKey === "gpu_vram" && s.peak).map((s) => s.peak.y);
      return peaks.length ? [{ run, i, y: Math.max(...peaks) }] : [];
    });
    if (!points.length) { empty("scatter", "没有显存采样数据"); return; }
    const w = 650, h = 260, left = 55, bottom = 225, pw = 560, ph = 195;
    const maxX = Math.max(1, ...points.map((p) => p.run.duration)) * 1.12, maxY = Math.max(1, ...points.map((p) => p.y)) * 1.12;
    let body = "";
    for (let t = 0; t <= 4; t++) {
      const cy = bottom - ph * t / 4;
      body += `<path d="M${left},${cy}H${left + pw}" stroke="#343e4d"/>` + text(left - 7, cy + 4, fmt(maxY * t / 4, "GB"), "#aeb8ca", "end", 10);
      body += text(left + pw * t / 4, h - 12, fmt(maxX * t / 4, "s"), "#aeb8ca", t === 4 ? "end" : "start", 10);
    }
    points.forEach((p, j) => { const x = left + p.run.duration / maxX * pw, y = bottom - p.y / maxY * ph; body += `<circle class="bar" data-point="${j}" cx="${x}" cy="${y}" r="7" fill="${color(p.i)}"/>` + text(x + 10, y - 7, p.i + 1, color(p.i)); });
    $("scatter").innerHTML = svg(body, w, h);
    $("scatter").querySelectorAll("[data-point]").forEach((element) => {
      const p = points[Number(element.dataset.point)];
      element.addEventListener("pointermove", (event) => tooltip(event, `${name(p.run, p.i)}\n总耗时 ${fmt(p.run.duration, "s")}\n单卡最高显存 ${fmt(p.y, "GB")}`)); element.addEventListener("pointerleave", hideTooltip);
    });
  }
  function render() {
    renderOverlay(); renderPeaks();
    // 节点下拉：聚合当前勾选记录的全部节点，按执行节点 id 排序
    const nodeItems = nodeUnion();
    const nodeKeys = nodeItems.map((item) => item.key);
    if (durationNodeKey && !nodeKeys.includes(durationNodeKey)) durationNodeKey = "";
    durationSelect.replaceChildren(new Option("总耗时", ""));
    for (const item of nodeItems) durationSelect.append(new Option(`${item.key} · ${item.title}`, item.key));
    durationSelect.value = durationNodeKey;
    durationSelect.style.display = nodeKeys.length ? "" : "none";
    const entries = activeRuns().map(({ run, i }) => {
      const node = durationNodeKey ? run.nodes.find((item) => String(item.id) === durationNodeKey) : null;
      const value = durationNodeKey ? (node ? node.seconds : null) : run.duration;
      const what = durationNodeKey ? `节点「${node ? node.title : durationNodeKey}」耗时 ${fmt(value, "s")}` : `总耗时 ${fmt(run.duration, "s")}`;
      return { label: name(run, i), value, color: color(i), detail: `${name(run, i)}\n${new Date(run.startedAt).toLocaleString()}\n${what}\n总耗时 ${fmt(run.duration, "s")}\n${run.status}` };
    });
    bars("duration", entries, "s", null, [], true);
  }
  const updateNodeOrderButtons = () => document.querySelectorAll("[data-node-order]").forEach((item) => {
    const active = item.dataset.nodeOrder === nodeOrder;
    item.style.cssText = "display:inline-flex;align-items:center;gap:7px;padding:4px 0;border:0;background:transparent;color:#fff;font:13px/1.5 'Segoe UI',system-ui,sans-serif;cursor:pointer;";
    const check = item.querySelector(".order-check");
    check.style.cssText = `width:14px;height:14px;box-sizing:border-box;border:1px solid ${active ? "#FFD700" : "#9299a5"};border-radius:3px;background:${active ? "#FFD700" : "transparent"};color:#171a20;font:bold 11px/12px sans-serif;text-align:center;`;
    check.textContent = active ? "✓" : "";
  });
  document.querySelectorAll("[data-node-order]").forEach((button) => button.addEventListener("click", () => {
    nodeOrder = button.dataset.nodeOrder;
    updateNodeOrderButtons();
    renderNodes();
  }));
  updateNodeOrderButtons();
  $("download").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob(["<!doctype html>" + document.documentElement.outerHTML], { type: "text/html;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `小珠光运行分析-${new Date().toISOString().slice(0, 10)}.html`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  render(); renderNodes();
}
