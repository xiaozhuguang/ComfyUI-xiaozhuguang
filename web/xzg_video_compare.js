import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { xzgT } from "./xzg_i18n.js";

const viewers = new Set();
const minScreenHeight = 150;
const minWidgetHeight = 315;
const chartPadding = 8;
const historyLimit = 48 * 1024 * 1024;

// Walks the subgraph chain for qualified ids like "12:7:5" (same lookup the execution server uses).
function findNodeByQualifiedId(rootGraph, qualifiedId) {
  if (!rootGraph || qualifiedId == null) return null;
  const parts = String(qualifiedId).split(":");
  let graph = rootGraph;
  for (let i = 0; i < parts.length - 1; i++) {
    const parentId = parseInt(parts[i], 10);
    if (!Number.isFinite(parentId)) return null;
    const parentNode = graph?.getNodeById?.(parentId);
    if (!parentNode?.subgraph) return null;
    graph = parentNode.subgraph;
  }
  const leafId = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(leafId)) return null;
  return graph?.getNodeById?.(leafId) || null;
}

function makePane(label) {
  const pane = document.createElement("div");
  pane.style.cssText = "display:grid;grid-template-rows:auto minmax(0,1fr);gap:4px;min-width:0";
  const title = document.createElement("span");
  title.textContent = label;
  const screen = document.createElement("div");
  screen.style.cssText = `position:relative;min-height:${minScreenHeight}px;background:#111;border-radius:4px;overflow:hidden`;
  pane.append(title, screen);
  return { pane, screen };
}

function mediaElement(tag) {
  const media = document.createElement(tag);
  media.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";
  if (tag === "video") {
    media.muted = true;
    media.playsInline = true;
  }
  return media;
}

function drawCurves(chart, series, total, cursorStep, locked = false) {
  const ctx = chart.getContext("2d");
  if (!ctx) return;
  const width = chart.clientWidth || 320;
  const height = chart.clientHeight || 120;
  const dpr = globalThis.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (chart.width !== pixelWidth || chart.height !== pixelHeight) {
    chart.width = pixelWidth;
    chart.height = pixelHeight;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const padY = 5;
  const bottom = height - padY;
  const x = (step) => chartPadding + Math.max(0, width - 2 * chartPadding) * step / Math.max(1, total);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#34363a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const fraction of [0.25, 0.5, 0.75]) {
    const y = padY + fraction * (bottom - padY);
    ctx.moveTo(x(0), y);
    ctx.lineTo(x(total), y);
  }
  ctx.stroke();

  for (const { points, color, fill, dashed } of series) {
    const valid = points.filter(([, value]) => Number.isFinite(value));
    if (!valid.length) continue;
    const max = valid.reduce((peak, [, value]) => Math.max(peak, value), 0);
    const min = valid.reduce((floor, [, value]) => Math.min(floor, value), 0);
    const y = (value) => bottom - (bottom - padY) * (value - min) / Math.max(max - min, 1e-6);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(x(0), bottom);
      ctx.lineTo(x(0), y(valid[0][1]));
      for (const [step, value] of valid) ctx.lineTo(x(step), y(value));
      ctx.lineTo(x(valid.at(-1)[0]), bottom);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.lineWidth = dashed ? 1 : 1.5;
    ctx.setLineDash(dashed ? [3, 3] : []);
    ctx.beginPath();
    for (const [index, [step, value]] of valid.entries()) {
      if (index === 0) ctx.moveTo(x(step), y(value));
      else ctx.lineTo(x(step), y(value));
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const selected = valid.find(([step]) => step === cursorStep);
    if (selected) {
      ctx.beginPath();
      ctx.arc(x(cursorStep), y(selected[1]), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.strokeStyle = locked ? "#dabc62" : "#7286a1";
  ctx.lineWidth = 1;
  ctx.setLineDash(locked ? [4, 2] : []);
  ctx.beginPath();
  ctx.moveTo(x(cursorStep), padY);
  ctx.lineTo(x(cursorStep), bottom);
  ctx.stroke();
  ctx.setLineDash([]);
}

function makeCurve(label, axisLabel) {
  const { pane, screen } = makePane(label);
  screen.style.minHeight = "0";
  const heading = pane.firstElementChild;
  const chart = document.createElement("canvas");
  chart.width = 320;
  chart.height = 144;
  chart.style.cssText = "display:block;width:100%;height:120px;background:#17181b";
  chart.title = axisLabel;
  screen.append(chart);
  return { pane, heading, chart };
}

function createViewer(node) {
  const root = document.createElement("div");
  root.style.cssText = `display:grid;grid-template-rows:minmax(min-content,1fr) auto;gap:8px;height:100%;min-height:${minWidgetHeight}px;color:#ddd;font:12px sans-serif`;
  const panes = document.createElement("div");
  panes.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px";
  const referencePane = makePane(xzgT("参考画面", "Reference"));
  const previewPane = makePane(xzgT("采样预览", "Sampling preview"));
  panes.append(referencePane.pane, previewPane.pane);
  const curves = document.createElement("div");
  curves.style.cssText = panes.style.cssText;
  const metrics = makeCurve("σ / Δ", xzgT("悬停查看步骤，点击锁定或解锁。", "Hover to inspect a step. Click to lock or unlock."));
  const timing = makeCurve(xzgT("步耗时（毫秒）", "Step time (ms)"),
    xzgT("点击切换毫秒或秒。", "Click to switch between milliseconds and seconds."));
  metrics.chart.tabIndex = 0;
  metrics.chart.style.cursor = "crosshair";
  timing.chart.style.cursor = "pointer";
  curves.append(metrics.pane, timing.pane);
  root.append(panes, curves);
  root.addEventListener("wheel", (event) => {
    if (globalThis.LiteGraph?.vueNodesMode) return;
    const canvas = app.canvas;
    if (!canvas?.canvas) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof canvas.processMouseWheel === "function") {
      canvas.processMouseWheel(event);
    } else {
      canvas.canvas.dispatchEvent(new WheelEvent("wheel", event));
    }
  }, { passive: false });
  const widget = node.addDOMWidget("xzg_compare", "xzg_compare", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => minWidgetHeight,
    getHeight: () => "100%",
  });
  widget.computeLayoutSize = () => ({ minHeight: minWidgetHeight, minWidth: 0 });
  const [width, height] = node.computeSize();
  node.setSize([Math.max(540, width, node.size[0]), Math.max(height, node.size[1])]);

  const reference = mediaElement("video");
  reference.preload = "auto";
  referencePane.screen.append(reference);
  let info;
  let referenceUrl;
  let preview;
  let frameRequest = 0;
  let sequence;
  let displayedFrame;
  let soughtTime;
  let frameIndex = 0;
  let frameInterval = 0;
  let nextFrameAt = 0;
  let live;
  let latestFrames;
  let hoverStep;
  let lockedStep;
  let seconds = false;
  let historySize = 0;
  const history = new Map();

  function matchesNodeId(id) {
    const value = String(id ?? "");
    if (value === String(node.id)) return true;
    return value.includes(":") && value.split(":").pop() === String(node.id);
  }

  function selectStep() {
    if (!live) return;
    const step = lockedStep ?? hoverStep ?? live.step;
    const sigmas = (live.sigmas ?? []).map((value, index) => [index, value]);
    const deltas = live.deltas ?? [];
    const timings = live.timings ?? [];
    const valueAt = (points) => points.find(([index]) => index === step)?.[1];
    const format = (value) => Number.isFinite(value) ? value.toFixed(3) : "—";
    const elapsed = valueAt(timings);
    const suffix = ` · ${xzgT("步", "Step")} ${step}/${live.total}`;
    metrics.heading.textContent = `σ ${format(valueAt(sigmas))} / Δ ${format(valueAt(deltas))}${suffix}`;
    timing.heading.textContent = `${xzgT("步耗时", "Step time")} ${format(elapsed / (seconds ? 1000 : 1))} ${seconds ? "s" : "ms"}${suffix}`;
    drawCurves(metrics.chart, [
      { points: sigmas, color: "#c6ccd6", dashed: true },
      { points: deltas, color: "#ff9b55", fill: "rgba(255, 155, 85, .16)" },
    ], live.total, step, lockedStep != null);
    drawCurves(timing.chart, [
      { points: timings, color: "#76c6af", fill: "rgba(118, 198, 175, .16)" },
    ], live.total, step, lockedStep != null);
    const saved = history.get(step);
    if (saved) previewPane.screen.title = "";
    else if (latestFrames) {
      previewPane.screen.title = xzgT("此步骤没有保留预览，正在显示最新画面。", "This step has no retained preview. Showing the latest preview.");
    }
    const frames = saved?.frames ?? latestFrames;
    if (frames !== sequence) {
      sequence = frames;
      frameIndex = Math.min(frameIndex, Math.max(0, (sequence?.length ?? 0) - 1));
    }
  }

  function stepAt(event) {
    const rect = metrics.chart.getBoundingClientRect();
    const width = metrics.chart.clientWidth || 320;
    const x = (event.clientX - rect.left) * width / rect.width;
    const fraction = (x - chartPadding) / Math.max(1, width - 2 * chartPadding);
    return Math.max(0, Math.min(live.step, Math.round(fraction * live.total)));
  }

  metrics.chart.addEventListener("pointermove", (event) => {
    if (!live || lockedStep != null) return;
    const step = stepAt(event);
    if (step === hoverStep) return;
    hoverStep = step;
    selectStep();
  });
  metrics.chart.addEventListener("pointerleave", () => {
    hoverStep = undefined;
    selectStep();
  });
  metrics.chart.addEventListener("click", (event) => {
    if (!live) return;
    lockedStep = lockedStep == null ? stepAt(event) : undefined;
    hoverStep = undefined;
    selectStep();
  });
  metrics.chart.addEventListener("keydown", (event) => {
    if (!live || !["ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    lockedStep = event.key === "Escape" ? undefined : Math.max(0, Math.min(live.step,
      (lockedStep ?? hoverStep ?? live.step) + (event.key === "ArrowLeft" ? -1 : 1)));
    hoverStep = undefined;
    selectStep();
  });
  timing.chart.addEventListener("click", () => {
    seconds = !seconds;
    selectStep();
  });
  const resizeCharts = new ResizeObserver(selectStep);
  resizeCharts.observe(curves);

  function showTimedFrame(now) {
    if (!sequence?.length) return;
    if (displayedFrame === sequence[frameIndex] && now >= nextFrameAt) {
      frameIndex = (frameIndex + 1) % sequence.length;
    }
    const frame = sequence[frameIndex];
    if (frame !== displayedFrame) {
      preview.src = "data:image/jpeg;base64," + frame.image;
      displayedFrame = frame;
      const next = sequence[frameIndex + 1];
      // No artificial 100ms floor: the sampling density decides the pacing, and the last
      // frame reuses the previous interval so looping does not add a visible hold.
      if (next) frameInterval = Math.max(16, (next.time - frame.time) * 1000);
      nextFrameAt = now + (frameInterval || 200);
    }
    if (referenceUrl && !reference.error && !reference.seeking
      && reference.readyState >= 1 && Number.isFinite(reference.duration)) {
      const target = Math.min(frame.time, Math.max(0, reference.duration - 0.001));
      if (soughtTime !== target && Math.abs(reference.currentTime - target) > 0.001) {
        soughtTime = target;
        reference.currentTime = target;
      }
    }
  }

  function tick(now) {
    showTimedFrame(now);
    frameRequest = requestAnimationFrame(tick);
  }

  function clearPreview() {
    preview?.remove();
    preview = undefined;
  }

  reference.addEventListener("error", () => {
    referencePane.screen.title = xzgT("无法播放参考画面", "Unable to play the reference");
  });

  return {
    configure(value) {
      if (!value) return;
      const url = value.video ? api.apiURL("/view?" + new URLSearchParams(value.video)) : undefined;
      if (info?.source !== value.source || url !== referenceUrl) {
        sequence = displayedFrame = latestFrames = undefined;
        frameIndex = 0;
        clearPreview();
        previewPane.screen.title = "";
      }
      info = value;
      if (!frameRequest) frameRequest = requestAnimationFrame(tick);
      if (url !== referenceUrl) {
        soughtTime = undefined;
        referenceUrl = url;
        if (url) reference.src = url;
        else reference.removeAttribute("src");
        reference.load();
      }
      referencePane.screen.title = xzgT(value.message, value.message_en) ?? "";
    },
    updateLive(event) {
      if (!event || !matchesNodeId(event.node_id)) return;
      const referenceInfo = event.reference ?? info;
      if (referenceInfo
        && (info?.source !== referenceInfo.source
          || info?.video?.filename !== referenceInfo.video?.filename)) {
        this.configure(referenceInfo);
      }
      if (!live || live.run_id !== event.run_id || event.step < live.step) {
        history.clear();
        historySize = 0;
        hoverStep = lockedStep = undefined;
        frameIndex = 0;
        frameInterval = 0;
        sequence = displayedFrame = latestFrames = undefined;
      }
      // Curves and step metadata must advance even for steps whose frames were dropped.
      live = event;
      if (event.message) {
        previewPane.screen.title = xzgT(event.message, event.message_en);
      }
      if (event.frames?.length) {
        previewPane.screen.title = "";
        latestFrames = event.frames;
        if (!preview) {
          preview = mediaElement("img");
          previewPane.screen.append(preview);
        }
        const size = event.frames.reduce((sum, frame) => sum + frame.image.length, 0);
        historySize -= history.get(event.step)?.size ?? 0;
        history.set(event.step, { frames: event.frames, size });
        historySize += size;
        while (historySize > historyLimit && history.size > 1) {
          const oldest = history.keys().next().value;
          historySize -= history.get(oldest).size;
          history.delete(oldest);
        }
      }
      selectStep();
    },
    dispose() {
      resizeCharts.disconnect();
      cancelAnimationFrame(frameRequest);
      clearPreview();
      reference.removeAttribute("src");
      reference.load();
    },
  };
}

app.registerExtension({
  name: "xiaozhuguang.video_compare",
  setup() {
    api.addEventListener("xzg_live_video_compare", ({ detail }) => {
      if (!detail) return;
      const target = findNodeByQualifiedId(app.graph, detail.node_id);
      if (target?.xzgVideoCompare) {
        target.xzgVideoCompare.updateLive(detail);
        return;
      }
      for (const viewer of viewers) viewer.updateLive(detail);
    });
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "XZGLiveVideoCompare") return;
    const { onNodeCreated, onExecuted, onRemoved } = nodeType.prototype;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      this.xzgVideoCompare = createViewer(this);
      viewers.add(this.xzgVideoCompare);
      return result;
    };
    nodeType.prototype.onExecuted = function (output) {
      const result = onExecuted?.call(this, output);
      this.xzgVideoCompare?.configure(output?.xzg_video_compare?.[0]);
      return result;
    };
    nodeType.prototype.onRemoved = function (...args) {
      viewers.delete(this.xzgVideoCompare);
      this.xzgVideoCompare?.dispose();
      return onRemoved?.apply(this, args);
    };
  },
});
