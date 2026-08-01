/**
 * 小珠光箭头绘制工具
 *
 * 在 ComfyUI 画布上绘制箭头标注，支持：
 * - 点击拖拽绘制箭头
 * - 箭头样式设置（颜色、线宽、箭头大小）
 * - 撤销/重做
 * - 随工作流保存/加载
 * - 跟随缩放/平移
 * - 可自定义快捷键
 * - 面板可拖动
 */

import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";

// ============================================================================
// 常量
// ============================================================================

const EXTENSION_KEY = "xiaozhuguang_arrows";
const LOG_PREFIX = "[小珠光箭头]";
const OVERLAY_ID = "xzg-arrow-overlay";
const CANVAS_ID = "xzg-arrow-canvas";
const TOOLBAR_ID = "xzg-arrow-toolbar";
const STORAGE_SETTINGS_KEY = "xiaozhuguang.arrow.settings";
const STORAGE_SHORTCUT_KEY = "xiaozhuguang.arrow.shortcut";
const STORAGE_POSITION_KEY = "xiaozhuguang.arrow.position";
const STORAGE_SIZE_KEY = "xiaozhuguang.arrow.size";
const DEFAULT_SHORTCUT = { key: "t", ctrl: false, alt: false, shift: false, meta: false };

// ============================================================================
// 状态
// ============================================================================

let isArrowModeActive = false;
let arrows = [];
let currentArrow = null;
let isDrawing = false;
let startPoint = null;
let lastPoint = null;
// 贝塞尔曲线打点绘制阶段：0=未开始, 1=已点起点(预览终点), 2=已点终点(预览控制点)
let bezierDrawStage = 0;

// 箭头设置
const arrowSettings = {
    color: "#FF5555",
    lineWidth: 3,
    arrowSize: 10,
    opacity: 1.0,
    shapeType: "arrow", // "arrow" | "rectangle" | "ellipse" | "circle" | "bezier"
    shapeMode: "border", // "border" | "fill"
    borderRadius: 0,
    lineStyle: "solid", // "solid" | "dashed" | "dotted"
    dashGap: 2,         // 虚线/圆点间距倍数
    animType: "none",   // 特效动画类型
    animSpeed: 1,       // 动画速度
    animCount: 5        // 动画数量（星芒/粒子/光点等个数）
};

// 快捷键
let shortcut = { ...DEFAULT_SHORTCUT };

// 覆盖层
let overlayElement = null;
let canvasElement = null;
let canvasContext = null;
let resizeObserver = null;
let litegraphCanvas = null;
let transformTrackerCleanup = null;

// 历史记录
let history = [];
let currentHistoryIndex = -1;
const MAX_HISTORY = 50;

// 工具栏
let toolbarElement = null;

// 拖动状态
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

// 缩放状态
let isResizing = false;
let resizeStartX = 0;
let resizeStartWidth = 0;

// 箭头选中状态
let selectedArrowIndex = -1;

// 位移滑条上一次值（用于计算相对偏移）
let lastSliderX = 0;
let lastSliderY = 0;

// 动画渲染循环
let animRafId = null;

// ============================================================================
// 坐标工具
// ============================================================================

function getTransform() {
    try {
        const ds = window.app?.canvas?.ds;
        if (ds) {
            let scale = ds.scale || 1;
            scale = Math.max(0.01, Math.min(100, scale));
            if (!Number.isFinite(scale)) scale = 1;
            return {
                scale,
                offsetX: Number.isFinite(ds.offset?.[0]) ? ds.offset[0] : 0,
                offsetY: Number.isFinite(ds.offset?.[1]) ? ds.offset[1] : 0
            };
        }
    } catch (e) {}
    return { scale: 1, offsetX: 0, offsetY: 0 };
}

function screenToCanvas(screenX, screenY) {
    const { scale, offsetX, offsetY } = getTransform();
    return {
        x: screenX / scale - offsetX,
        y: screenY / scale - offsetY
    };
}

// ============================================================================
// 覆盖层管理
// ============================================================================

function createOverlay(container) {
    if (overlayElement) return { overlay: overlayElement, canvas: canvasElement };

    overlayElement = document.createElement("div");
    overlayElement.id = OVERLAY_ID;
    overlayElement.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 10;
        overflow: hidden;
        pointer-events: none;
        display: none;
    `;

    canvasElement = document.createElement("canvas");
    canvasElement.id = CANVAS_ID;
    canvasElement.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: inherit;
        touch-action: none;
    `;

    overlayElement.appendChild(canvasElement);
    container.appendChild(overlayElement);

    canvasContext = canvasElement.getContext("2d", {
        alpha: true,
        desynchronized: true,
        willReadFrequently: false
    });

    litegraphCanvas = container.querySelector("canvas:not(#" + CANVAS_ID + ")");
    updateCanvasSize();
    setupResizeObserver(container);
    setPointerEventsMode("none");

    return { overlay: overlayElement, canvas: canvasElement };
}

function updateCanvasSize() {
    if (!canvasElement || !overlayElement) return;
    const rect = overlayElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = rect.width;
    const displayHeight = rect.height;
    const bufferWidth = Math.floor(displayWidth * dpr);
    const bufferHeight = Math.floor(displayHeight * dpr);
    if (canvasElement.width !== bufferWidth || canvasElement.height !== bufferHeight) {
        canvasElement.width = bufferWidth;
        canvasElement.height = bufferHeight;
        canvasContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
}

function setupResizeObserver(container) {
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(updateCanvasSize);
    });
    resizeObserver.observe(container);
    window.addEventListener("resize", () => {
        requestAnimationFrame(updateCanvasSize);
    });
}

function setPointerEventsMode(mode) {
    if (overlayElement) overlayElement.style.pointerEvents = mode;
}

function setCursor(cursor) {
    if (canvasElement) canvasElement.style.cursor = cursor;
}

function getCanvasDimensions() {
    if (!canvasElement) return { width: 0, height: 0, dpr: 1 };
    const dpr = window.devicePixelRatio || 1;
    return {
        width: canvasElement.width / dpr,
        height: canvasElement.height / dpr,
        dpr
    };
}

function clearCanvas() {
    if (!canvasContext || !canvasElement) return;
    canvasContext.setTransform(1, 0, 0, 1, 0, 0);
    canvasContext.clearRect(0, 0, canvasElement.width, canvasElement.height);
}

// ============================================================================
// 形状绘制
// ============================================================================

// 计算形状包围盒
function getShapeBounds(shape) {
    // 新格式贝塞尔曲线：从所有点计算包围盒
    if (shape.type === "bezier" && shape.points && shape.points.length > 0) {
        const pts = getBezierPoints(shape);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of pts) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        return { minX, minY, maxX, maxY };
    }
    const sx = shape.start.x, sy = shape.start.y;
    const ex = shape.end.x, ey = shape.end.y;
    let minX = Math.min(sx, ex), minY = Math.min(sy, ey);
    let maxX = Math.max(sx, ex), maxY = Math.max(sy, ey);
    // 旧格式贝塞尔曲线：需要考虑控制点的影响范围
    if (shape.type === "bezier" && shape.control) {
        const p0 = shape.start, p1 = shape.control, p2 = shape.end;
        // 二次贝塞尔极值点：t = (p0 - p1) / (p0 - 2*p1 + p2)
        const denomX = p0.x - 2 * p1.x + p2.x;
        const denomY = p0.y - 2 * p1.y + p2.y;
        const candidates = [0, 1];
        if (Math.abs(denomX) > 1e-6) {
            const t = (p0.x - p1.x) / denomX;
            if (t > 0 && t < 1) candidates.push(t);
        }
        if (Math.abs(denomY) > 1e-6) {
            const t = (p0.y - p1.y) / denomY;
            if (t > 0 && t < 1) candidates.push(t);
        }
        for (const t of candidates) {
            const u = 1 - t;
            const x = u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x;
            const y = u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        return { minX, minY, maxX, maxY };
    }
    // 如果是箭头，还需要考虑箭头头部
    if (shape.type === "arrow") {
        const dx = ex - sx, dy = ey - sy;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
            const nx = dx / len, ny = dy / len;
            const px = -ny, py = nx;
            const halfLw = shape.lineWidth / 2;
            const headLen = shape.arrowSize;
            const headWidth = Math.max(headLen * Math.tan(Math.PI / 8), halfLw + 0.5);
            const baseX = ex - nx * headLen, baseY = ey - ny * headLen;
            const pts = [
                [ex, ey],
                [baseX + px * headWidth, baseY + py * headWidth],
                [baseX - px * headWidth, baseY - py * headWidth],
                [sx + px * halfLw, sy + py * halfLw],
                [sx - px * halfLw, sy - py * halfLw],
                [sx - halfLw, sy], [sx + halfLw, sy],
                [sx, sy - halfLw], [sx, sy + halfLw]
            ];
            let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
            for (const [x, y] of pts) {
                if (x < bMinX) bMinX = x;
                if (y < bMinY) bMinY = y;
                if (x > bMaxX) bMaxX = x;
                if (y > bMaxY) bMaxY = y;
            }
            return { minX: bMinX, minY: bMinY, maxX: bMaxX, maxY: bMaxY };
        }
    }
    return { minX, minY, maxX, maxY };
}

function drawShape(ctx, shape, isSelected) {
    if (!shape || !shape.start || !shape.end) return;

    const type = shape.type || "arrow";
    const mode = shape.mode || "border";

    // 选中高亮：虚线方框
    if (isSelected) {
        ctx.save();
        const bounds = getShapeBounds(shape);
        const pad = 4;
        const x = bounds.minX - pad;
        const y = bounds.minY - pad;
        const w = bounds.maxX - bounds.minX + pad * 2;
        const h = bounds.maxY - bounds.minY + pad * 2;
        ctx.strokeStyle = "#6699FF";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.globalAlpha = 0.8;
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
    }

    const sx = shape.start.x, sy = shape.start.y;
    const ex = shape.end.x, ey = shape.end.y;

    switch (type) {
        case "arrow":
            drawArrowShape(ctx, shape);
            break;
        case "rectangle":
            drawRectShape(ctx, shape, mode);
            break;
        case "ellipse":
            drawEllipseShape(ctx, shape, mode);
            break;
        case "circle":
            drawCircleShape(ctx, shape, mode);
            break;
        case "bezier":
            drawBezierShape(ctx, shape, mode);
            break;
    }

    // 特效动画覆盖层（绘制在基础形状之上）
    if (shape.animType && shape.animType !== "none") {
        drawArrowAnim(ctx, shape);
        ensureAnimLoop();
    }
}

// 计算二次贝塞尔曲线的控制点：取 start→end 中点向垂直方向偏移
function getBezierControlPoint(shape) {
    const sx = shape.start.x, sy = shape.start.y;
    const ex = shape.end.x, ey = shape.end.y;
    const mx = (sx + ex) / 2, my = (sy + ey) / 2;
    const dx = ex - sx, dy = ey - sy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return { x: mx, y: my };
    // 垂直方向单位向量
    const px = -dy / len, py = dx / len;
    // 偏移量为长度的 30%
    const offset = len * 0.3;
    return { x: mx + px * offset, y: my + py * offset };
}

// 计算二次贝塞尔曲线上的点
function quadraticBezierPoint(p0, p1, p2, t) {
    const u = 1 - t;
    return {
        x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
        y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y
    };
}

// 获取贝塞尔曲线的所有点（兼容旧 start/end/control 结构）
function getBezierPoints(shape) {
    // 新格式：points 数组（可能包含 previewPoint 用于实时预览）
    if (shape.points && shape.points.length >= 1) {
        const pts = [...shape.points];
        if (shape.previewPoint) pts.push(shape.previewPoint);
        if (pts.length >= 2) return pts;
        return [];
    }
    // 旧数据结构转换
    if (shape.start && shape.end) {
        if (shape.control) {
            return [shape.start, shape.control, shape.end];
        }
        return [shape.start, shape.end];
    }
    return [];
}

// 沿 catmull-rom 曲线采样点（用于命中检测）
function getBezierSamplePoints(pts, samplesPerSegment = 12) {
    if (pts.length < 2) return pts;
    const result = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = i > 0 ? pts[i - 1] : pts[i];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = i < pts.length - 2 ? pts[i + 2] : pts[i + 1];
        // catmull-rom 转三次贝塞尔控制点（与渲染保持一致）
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;
        for (let s = 1; s <= samplesPerSegment; s++) {
            const t = s / samplesPerSegment;
            const u = 1 - t;
            const x = u*u*u*p1.x + 3*u*u*t*cp1x + 3*u*t*t*cp2x + t*t*t*p2.x;
            const y = u*u*u*p1.y + 3*u*u*t*cp1y + 3*u*t*t*cp2y + t*t*t*p2.y;
            result.push({ x, y });
        }
    }
    return result;
}

function drawBezierShape(ctx, shape, mode) {
    const rawPts = getBezierPoints(shape);
    if (rawPts.length < 2) return;

    const lineStyle = shape.lineStyle || "solid";
    const headSize = shape.arrowSize || 0;

    // 填充模式：忽略线型，直接填充闭合区域
    if (mode === "fill") {
        ctx.save();
        ctx.globalAlpha = shape.opacity;
        ctx.beginPath();
        ctx.moveTo(rawPts[0].x, rawPts[0].y);
        if (rawPts.length === 2) {
            ctx.lineTo(rawPts[1].x, rawPts[1].y);
        } else {
            for (let i = 0; i < rawPts.length - 1; i++) {
                const p0 = i > 0 ? rawPts[i - 1] : rawPts[i];
                const p1 = rawPts[i];
                const p2 = rawPts[i + 1];
                const p3 = i < rawPts.length - 2 ? rawPts[i + 2] : rawPts[i + 1];
                const cp1x = p1.x + (p2.x - p0.x) / 6;
                const cp1y = p1.y + (p2.y - p0.y) / 6;
                const cp2x = p2.x - (p3.x - p1.x) / 6;
                const cp2y = p2.y - (p3.y - p1.y) / 6;
                ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
            }
        }
        ctx.closePath();
        ctx.fillStyle = shape.color;
        ctx.fill();
        ctx.restore();
        return;
    }

    // 实线 + 有箭头：绘制正经矢量箭头（单路径填充）
    if (lineStyle === "solid" && headSize > 0) {
        drawBezierArrowShape(ctx, shape, rawPts);
        return;
    }

    // 其他线型（虚线/圆点）或无箭头：描边方式
    ctx.save();
    ctx.globalAlpha = shape.opacity;
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.lineWidth;

    applyLineDash(ctx, lineStyle, shape.lineWidth);
    ctx.beginPath();
    ctx.moveTo(rawPts[0].x, rawPts[0].y);
    if (rawPts.length === 2) {
        ctx.lineTo(rawPts[1].x, rawPts[1].y);
    } else {
        for (let i = 0; i < rawPts.length - 1; i++) {
            const p0 = i > 0 ? rawPts[i - 1] : rawPts[i];
            const p1 = rawPts[i];
            const p2 = rawPts[i + 1];
            const p3 = i < rawPts.length - 2 ? rawPts[i + 2] : rawPts[i + 1];
            const cp1x = p1.x + (p2.x - p0.x) / 6;
            const cp1y = p1.y + (p2.y - p0.y) / 6;
            const cp2x = p2.x - (p3.x - p1.x) / 6;
            const cp2y = p2.y - (p3.y - p1.y) / 6;
            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
        }
    }
    ctx.stroke();
    ctx.restore();

    // 箭头头部：描边模式下单独绘制填充三角形
    if (headSize > 0 && rawPts.length >= 2) {
        const last = rawPts[rawPts.length - 1];
        const prev = rawPts[rawPts.length - 2];
        drawArrowHead(ctx, last.x, last.y, last.x - prev.x, last.y - prev.y, headSize, shape.color, shape.opacity);
    }
}

// 曲线矢量箭头：沿曲线采样构建单条闭合填充路径（身体+箭头一体化）
function drawBezierArrowShape(ctx, shape, rawPts) {
    const pts = getBezierSamplePoints(rawPts, 16);
    if (pts.length < 2) return;

    const lw = shape.lineWidth;
    const halfLw = lw / 2;
    const headLen = shape.arrowSize || 0;

    // 累计弧长
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
        cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    const totalLen = cum[pts.length - 1];
    if (totalLen < 1) return;

    // 每个采样点的切线/法线
    const norms = [];
    for (let i = 0; i < pts.length; i++) {
        const prev = pts[i - 1] || pts[i];
        const next = pts[i + 1] || pts[i];
        let tx = next.x - prev.x, ty = next.y - prev.y;
        const len = Math.hypot(tx, ty);
        if (len < 1e-6) { tx = 1; ty = 0; } else { tx /= len; ty /= len; }
        norms.push({ px: -ty, py: tx });
    }

    ctx.save();
    ctx.fillStyle = shape.color;
    ctx.globalAlpha = shape.opacity;

    // 无箭头头部：绘制两端圆头的粗带
    if (headLen <= 0 || headLen >= totalLen) {
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
            const x = pts[i].x + norms[i].px * halfLw, y = pts[i].y + norms[i].py * halfLw;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        for (let i = pts.length - 1; i >= 0; i--) {
            ctx.lineTo(pts[i].x - norms[i].px * halfLw, pts[i].y - norms[i].py * halfLw);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        return;
    }

    // 有箭头：身体从起点到"基点"（距终点 headLen 处），头部从基点到终点
    const baseArc = totalLen - headLen;
    let baseIdx = 0;
    while (baseIdx < pts.length - 2 && cum[baseIdx + 1] < baseArc) baseIdx++;
    const segLen = cum[baseIdx + 1] - cum[baseIdx];
    const tBase = segLen > 1e-6 ? (baseArc - cum[baseIdx]) / segLen : 0;
    const bp0 = pts[baseIdx], bp1 = pts[baseIdx + 1];
    const baseX = bp0.x + (bp1.x - bp0.x) * tBase;
    const baseY = bp0.y + (bp1.y - bp0.y) * tBase;
    const bn0 = norms[baseIdx], bn1 = norms[baseIdx + 1];
    let baseNx = bn0.px * (1 - tBase) + bn1.px * tBase;
    let baseNy = bn0.py * (1 - tBase) + bn1.py * tBase;
    const bnLen = Math.hypot(baseNx, baseNy);
    if (bnLen > 1e-6) { baseNx /= bnLen; baseNy /= bnLen; }

    const tipX = pts[pts.length - 1].x, tipY = pts[pts.length - 1].y;
    const headWidth = Math.max(headLen * Math.tan(Math.PI / 8), halfLw + 0.5);
    const startN = norms[0];
    const startAngle = Math.atan2(startN.py, startN.px);

    ctx.beginPath();
    // 箭头尖端
    ctx.moveTo(tipX, tipY);
    // 左侧头部张角
    ctx.lineTo(baseX + baseNx * headWidth, baseY + baseNy * headWidth);
    // 收敛到身体左半宽
    ctx.lineTo(baseX + baseNx * halfLw, baseY + baseNy * halfLw);
    // 沿左侧身体回到起点
    for (let i = baseIdx; i >= 0; i--) {
        ctx.lineTo(pts[i].x + norms[i].px * halfLw, pts[i].y + norms[i].py * halfLw);
    }
    // 起点圆头
    ctx.arc(pts[0].x, pts[0].y, halfLw, startAngle, startAngle + Math.PI, false);
    // 沿右侧身体到基点
    for (let i = 0; i <= baseIdx; i++) {
        ctx.lineTo(pts[i].x - norms[i].px * halfLw, pts[i].y - norms[i].py * halfLw);
    }
    // 收敛到头部右张角
    ctx.lineTo(baseX - baseNx * halfLw, baseY - baseNy * halfLw);
    ctx.lineTo(baseX - baseNx * headWidth, baseY - baseNy * headWidth);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

// ============================================================================
// 线型工具
// ============================================================================

// 设置线型 dash 模式（实线/虚线/圆点虚线）。实线由 drawBezierArrowShape 处理。
function applyLineDash(ctx, lineStyle, lineWidth) {
    const lw = Math.max(1, lineWidth || 1);
    const gap = (typeof arrowSettings !== "undefined" ? (arrowSettings.dashGap || 2) : 2) * lw;
    if (lineStyle === "dashed") {
        ctx.setLineDash([lw * 3, gap]);
        ctx.lineCap = "butt";
    } else if (lineStyle === "dotted") {
        // 圆点：0 长度 dash + 间隙，配合 round cap 形成圆点
        ctx.setLineDash([0.1, gap]);
        ctx.lineCap = "round";
    } else {
        ctx.setLineDash([]);
        ctx.lineCap = "round";
    }
}

// 获取形状描边采样点
function getShapeStrokePoints(shape) {
    const type = shape.type || "arrow";
    if (type === "bezier") {
        const pts = getBezierPoints(shape);
        if (pts.length >= 2) return getBezierSamplePoints(pts, 12);
        return [];
    }
    if (type === "arrow") {
        const sx = shape.start.x, sy = shape.start.y;
        const ex = shape.end.x, ey = shape.end.y;
        const headLen = shape.arrowSize || 0;
        if (headLen <= 0) return [{ x: sx, y: sy }, { x: ex, y: ey }];
        const dx = ex - sx, dy = ey - sy;
        const len = Math.hypot(dx, dy);
        if (len < 1) return [{ x: sx, y: sy }, { x: ex, y: ey }];
        const nx = dx / len, ny = dy / len;
        return [{ x: sx, y: sy }, { x: ex - nx * headLen, y: ey - ny * headLen }];
    }
    if (type === "rectangle") {
        const sx = shape.start.x, sy = shape.start.y;
        const ex = shape.end.x, ey = shape.end.y;
        const left = Math.min(sx, ex), right = Math.max(sx, ex);
        const top = Math.min(sy, ey), bottom = Math.max(sy, ey);
        const w = right - left, h = bottom - top;
        const br = Math.min(shape.borderRadius || 0, Math.min(w, h) / 2);
        const pts = [];
        const N = 128; // total sample points
        // If no rounded corners, use simple 4-corner path
        if (br <= 0) {
            return [
                { x: left, y: top }, { x: right, y: top },
                { x: right, y: bottom }, { x: left, y: bottom },
                { x: left, y: top }
            ];
        }
        // Rounded rectangle perimeter: 4 straight edges + 4 quarter-circle arcs
        const straightTop = w - 2 * br;
        const straightRight = h - 2 * br;
        const straightBottom = w - 2 * br;
        const straightLeft = h - 2 * br;
        const arcLen = Math.PI / 2 * br;
        const totalLen = straightTop + straightRight + straightBottom + straightLeft + 4 * arcLen;
        for (let i = 0; i <= N; i++) {
            const t = i / N;
            const d = t * totalLen;
            let cumLen = 0;
            // Top edge (left to right)
            if (d < straightTop) {
                const p = d / straightTop;
                pts.push({ x: left + br + p * straightTop, y: top });
                continue;
            }
            cumLen += straightTop;
            // Top-right corner arc
            if (d < cumLen + arcLen) {
                const angle = (d - cumLen) / arcLen * (Math.PI / 2);
                pts.push({ x: right - br + br * Math.sin(angle), y: top + br - br * Math.cos(angle) });
                continue;
            }
            cumLen += arcLen;
            // Right edge (top to bottom)
            if (d < cumLen + straightRight) {
                const p = (d - cumLen) / straightRight;
                pts.push({ x: right, y: top + br + p * straightRight });
                continue;
            }
            cumLen += straightRight;
            // Bottom-right corner arc
            if (d < cumLen + arcLen) {
                const angle = (d - cumLen) / arcLen * (Math.PI / 2);
                pts.push({ x: right - br + br * Math.cos(angle), y: bottom - br + br * Math.sin(angle) });
                continue;
            }
            cumLen += arcLen;
            // Bottom edge (right to left)
            if (d < cumLen + straightBottom) {
                const p = (d - cumLen) / straightBottom;
                pts.push({ x: right - br - p * straightBottom, y: bottom });
                continue;
            }
            cumLen += straightBottom;
            // Bottom-left corner arc
            if (d < cumLen + arcLen) {
                const angle = (d - cumLen) / arcLen * (Math.PI / 2);
                pts.push({ x: left + br - br * Math.sin(angle), y: bottom - br + br * Math.cos(angle) });
                continue;
            }
            cumLen += arcLen;
            // Left edge (bottom to top)
            if (d < cumLen + straightLeft) {
                const p = (d - cumLen) / straightLeft;
                pts.push({ x: left, y: bottom - br - p * straightLeft });
                continue;
            }
            cumLen += straightLeft;
            // Top-left corner arc
            {
                const angle = (d - cumLen) / arcLen * (Math.PI / 2);
                pts.push({ x: left + br - br * Math.cos(angle), y: top + br - br * Math.sin(angle) });
            }
        }
        return pts;
    }
    if (type === "ellipse" || type === "circle") {
        const sx = shape.start.x, sy = shape.start.y;
        const ex = shape.end.x, ey = shape.end.y;
        const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
        let rx = Math.abs(ex - sx) / 2, ry = Math.abs(ey - sy) / 2;
        if (type === "circle") { const r = Math.max(rx, ry); rx = r; ry = r; }
        const pts = [];
        const N = 64;
        for (let i = 0; i < N; i++) {
            const a = i / N * Math.PI * 2;
            pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
        }
        return pts;
    }
    return [];
}

// 在终点绘制箭头头部（填充三角形）
function drawArrowHead(ctx, tipX, tipY, dirX, dirY, size, color, alpha) {
    if (size <= 0) return;
    const len = Math.sqrt(dirX * dirX + dirY * dirY);
    if (len < 1e-6) return;
    const nx = dirX / len, ny = dirY / len;
    const px = -ny, py = nx;
    const halfAngle = Math.PI / 8; // 22.5°，整体45°
    const halfWidth = Math.max(size * Math.tan(halfAngle), 0.5);
    const baseX = tipX - nx * size, baseY = tipY - ny * size;

    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(baseX + px * halfWidth, baseY + py * halfWidth);
    ctx.lineTo(baseX - px * halfWidth, baseY - py * halfWidth);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function drawArrowShape(ctx, arrow) {
    const sx = arrow.start.x, sy = arrow.start.y;
    const ex = arrow.end.x, ey = arrow.end.y;
    const dx = ex - sx, dy = ey - sy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;

    const nx = dx / len, ny = dy / len;
    const px = -ny, py = nx;
    const lw = arrow.lineWidth;
    const halfLw = lw / 2;
    const headLen = arrow.arrowSize || 0;
    const lineStyle = arrow.lineStyle || "solid";

    // 非实线线型：身体描边延伸到终点，再用填充三角形覆盖末端形成箭头
    if (lineStyle !== "solid") {
        ctx.save();
        ctx.globalAlpha = arrow.opacity;
        ctx.strokeStyle = arrow.color;
        ctx.lineWidth = lw;

        if (headLen > 0) {
            // 身体描边延伸到终点 tip，填充三角形会覆盖穿过的部分
            applyLineDash(ctx, lineStyle, lw);
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(ex, ey);
            ctx.stroke();
            // 填充三角形覆盖末端，形成箭头（重置 dash 避免影响填充）
            ctx.setLineDash([]);
            drawArrowHead(ctx, ex, ey, dx, dy, headLen, arrow.color, arrow.opacity);
        } else {
            // 无头部：整段描边
            applyLineDash(ctx, lineStyle, lw);
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(ex, ey);
            ctx.stroke();
        }
        ctx.restore();
        return;
    }

    ctx.save();
    ctx.fillStyle = arrow.color;
    ctx.strokeStyle = arrow.color;
    ctx.globalAlpha = arrow.opacity;

    // 箭头大小为 0：只绘制线段，不绘制头部
    if (headLen <= 0) {
        ctx.lineWidth = lw;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.restore();
        return;
    }

    const headWidth = Math.max(headLen * Math.tan(Math.PI / 8), halfLw + 0.5);
    const baseX = ex - nx * headLen, baseY = ey - ny * headLen;
    const perpAngle = Math.atan2(py, px);

    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(baseX + px * headWidth, baseY + py * headWidth);
    ctx.lineTo(baseX + px * halfLw, baseY + py * halfLw);
    ctx.lineTo(sx + px * halfLw, sy + py * halfLw);
    ctx.arc(sx, sy, halfLw, perpAngle, perpAngle + Math.PI, false);
    ctx.lineTo(baseX - px * halfLw, baseY - py * halfLw);
    ctx.lineTo(baseX - px * headWidth, baseY - py * headWidth);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
}

function drawRectShape(ctx, shape, mode) {
    const sx = shape.start.x, sy = shape.start.y;
    const ex = shape.end.x, ey = shape.end.y;
    const x = Math.min(sx, ex), y = Math.min(sy, ey);
    const w = Math.abs(ex - sx), h = Math.abs(ey - sy);
    const br = Math.min(shape.borderRadius || 0, Math.min(w, h) / 2);
    const lineStyle = shape.lineStyle || "solid";

    ctx.save();
    ctx.globalAlpha = shape.opacity;

    if (mode === "fill") {
        ctx.beginPath();
        if (br > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, br);
        else ctx.rect(x, y, w, h);
        ctx.fillStyle = shape.color;
        ctx.fill();
    } else {
        ctx.beginPath();
        if (br > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, br);
        else ctx.rect(x, y, w, h);
        ctx.strokeStyle = shape.color;
        ctx.lineWidth = shape.lineWidth;
        applyLineDash(ctx, lineStyle, shape.lineWidth);
        ctx.stroke();
    }

    ctx.restore();
}

function drawEllipseShape(ctx, shape, mode) {
    const sx = shape.start.x, sy = shape.start.y;
    const ex = shape.end.x, ey = shape.end.y;
    const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
    const rx = Math.abs(ex - sx) / 2, ry = Math.abs(ey - sy) / 2;
    const lineStyle = shape.lineStyle || "solid";

    ctx.save();
    ctx.globalAlpha = shape.opacity;

    if (mode === "fill") {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = shape.color;
        ctx.fill();
    } else {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.strokeStyle = shape.color;
        ctx.lineWidth = shape.lineWidth;
        applyLineDash(ctx, lineStyle, shape.lineWidth);
        ctx.stroke();
    }

    ctx.restore();
}

function drawCircleShape(ctx, shape, mode) {
    const sx = shape.start.x, sy = shape.start.y;
    const ex = shape.end.x, ey = shape.end.y;
    const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
    const r = Math.max(Math.abs(ex - sx), Math.abs(ey - sy)) / 2;
    const lineStyle = shape.lineStyle || "solid";

    ctx.save();
    ctx.globalAlpha = shape.opacity;

    if (mode === "fill") {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = shape.color;
        ctx.fill();
    } else {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = shape.color;
        ctx.lineWidth = shape.lineWidth;
        applyLineDash(ctx, lineStyle, shape.lineWidth);
        ctx.stroke();
    }

    ctx.restore();
}

// ============================================================================
// 特效动画（参考小珠光主题连线动画，去除紫色）
// ============================================================================

// 沿折线路径在参数 t (0~1) 处取点，并返回切线角度
function getPointAlongPath(points, t) {
    if (!points || points.length === 0) return { x: 0, y: 0, angle: 0 };
    if (points.length === 1) return { x: points[0].x, y: points[0].y, angle: 0 };
    // 计算总长度
    let totalLen = 0;
    const segLens = [];
    for (let i = 0; i < points.length - 1; i++) {
        const dx = points[i + 1].x - points[i].x;
        const dy = points[i + 1].y - points[i].y;
        const l = Math.sqrt(dx * dx + dy * dy);
        segLens.push(l);
        totalLen += l;
    }
    if (totalLen < 1e-6) return { x: points[0].x, y: points[0].y, angle: 0 };
    let target = (t % 1) * totalLen;
    if (target < 0) target += totalLen;
    let accum = 0;
    for (let i = 0; i < segLens.length; i++) {
        if (accum + segLens[i] >= target || i === segLens.length - 1) {
            const remain = target - accum;
            const ratio = segLens[i] > 1e-6 ? remain / segLens[i] : 0;
            const x = points[i].x + (points[i + 1].x - points[i].x) * ratio;
            const y = points[i].y + (points[i + 1].y - points[i].y) * ratio;
            const angle = Math.atan2(points[i + 1].y - points[i].y, points[i + 1].x - points[i].x);
            return { x, y, angle };
        }
        accum += segLens[i];
    }
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    return { x: last.x, y: last.y, angle: Math.atan2(last.y - prev.y, last.x - prev.x) };
}

// 获取形状动画路径采样点（用于能量脉冲等需要整体路径的动画）
function getAnimPathPoints(shape) {
    const type = shape.type || "arrow";
    if (type === "arrow") {
        const sx = shape.start.x, sy = shape.start.y;
        const ex = shape.end.x, ey = shape.end.y;
        const headLen = shape.arrowSize || 0;
        if (headLen <= 0) return [{ x: sx, y: sy }, { x: ex, y: ey }];
        const dx = ex - sx, dy = ey - sy;
        const len = Math.hypot(dx, dy);
        if (len < 1) return [{ x: sx, y: sy }, { x: ex, y: ey }];
        const nx = dx / len, ny = dy / len;
        // 箭头动画路径：从起点到箭头基点（不含头部）
        return [{ x: sx, y: sy }, { x: ex - nx * headLen, y: ey - ny * headLen }];
    }
    return getShapeStrokePoints(shape);
}

// 速度重映射：speed=1→2%, speed=50→100%, speed=100→200%（原最高10的20%）
function remapAnimSpeed(s) {
    if (s <= 0) return 0;
    return s * 2 / 100;
}

// 动画调度
function drawArrowAnim(ctx, shape) {
    const animType = shape.animType || "none";
    if (animType === "none") return;
    const pts = getAnimPathPoints(shape);
    if (pts.length < 2) return;
    const rawSpeed = shape.animSpeed || 1;
    const speed = remapAnimSpeed(rawSpeed);
    const count = Math.max(1, shape.animCount || 5);
    const t = performance.now();
    switch (animType) {
        case "sparkle":   drawAnimSparkle(ctx, pts, speed, t, count); break;
        case "energy":    drawAnimEnergy(ctx, pts, speed, t); break;
        case "transfer":  drawAnimTransfer(ctx, pts, speed, t, count); break;
        case "stellar":   drawAnimStellar(ctx, pts, speed, t, count); break;
        case "diy1":      drawAnimGoldFlow(ctx, pts, speed, t, count); break;
        case "crystal":   drawAnimCrystal(ctx, pts, speed, t, count); break;
        case "quantum":   drawAnimQuantum(ctx, pts, speed, t, count); break;
        case "lava":      drawAnimLava(ctx, pts, speed, t, count); break;
        case "randspark": drawAnimRandSpark(ctx, pts, speed, t, count); break;
        case "pulse":     drawAnimPulse(ctx, pts, speed, t); break;
        case "comet":     drawAnimComet(ctx, pts, speed, t, count); break;
    }
}

// 绘制星芒（8 束光芒 + 径向光晕 + 白色核心）
function _drawStarburst(ctx, cx, cy, color, size, rotation) {
    const rayCount = 8;
    const rayLength = size;
    const rayHalfWidth = size * 0.06;
    const coreRadius = size * 0.18;
    const glowRadius = size * 0.6;
    ctx.save();
    ctx.translate(cx, cy);
    const glowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, glowRadius);
    glowGrad.addColorStop(0, color + 'CC');
    glowGrad.addColorStop(0.5, color + '66');
    glowGrad.addColorStop(1, color + '00');
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(rotation);
    ctx.shadowColor = color;
    ctx.shadowBlur = size * 0.8;
    for (let i = 0; i < rayCount; i++) {
        const angle = (i * Math.PI * 2) / rayCount;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const tipX = cos * rayLength, tipY = sin * rayLength;
        const perpX = -sin, perpY = cos;
        const baseInnerX = cos * coreRadius, baseInnerY = sin * coreRadius;
        ctx.beginPath();
        ctx.moveTo(baseInnerX - perpX * rayHalfWidth, baseInnerY - perpY * rayHalfWidth);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(baseInnerX + perpX * rayHalfWidth, baseInnerY + perpY * rayHalfWidth);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
    }
    ctx.shadowBlur = size * 0.5;
    ctx.beginPath();
    ctx.arc(0, 0, coreRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
}

// 1. 七彩星芒
function drawAnimSparkle(ctx, pts, speed, t, count) {
    const rainbowColors = ['#FF6B6B', '#FFA94D', '#FFE066', '#69DB7C', '#339AF0', '#F06595'];
    count = Math.max(1, count || 5);
    const sp = 0.00025 * speed;
    const baseOffset = (t * sp) % 1;
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = (baseOffset + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        const color = rainbowColors[i % rainbowColors.length];
        const pulse = 0.7 + 0.3 * Math.sin(t * 0.004 + i * 1.2);
        const size = 11 * pulse;
        const rotation = t * 0.001 + i * 0.5;
        _drawStarburst(ctx, p.x, p.y, color, size, rotation);
    }
    ctx.restore();
}

// 2. 能量脉冲（七彩变色 + 明暗变化，沿整体路径描边）
function drawAnimEnergy(ctx, pts, speed, t) {
    const sp = 0.002 * speed;
    const pulse = 0.5 + 0.5 * Math.sin(t * sp);
    const hue = (t * 0.05) % 360;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    // 外层七彩
    ctx.strokeStyle = `hsla(${hue}, 100%, 60%, ${0.2 + pulse * 0.3})`;
    ctx.lineWidth = 6;
    ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
    ctx.shadowBlur = 15 + pulse * 10;
    ctx.stroke();
    // 核心白色
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.4 + pulse * 0.5})`;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = `hsl(${hue}, 100%, 70%)`;
    ctx.shadowBlur = 4;
    ctx.stroke();
    ctx.restore();
}

// 3. 高速穿梭光点（带拖尾）
function drawAnimTransfer(ctx, pts, speed, t, count) {
    const sp = 0.0012 * speed;
    count = Math.max(1, count || 3);
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * sp) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        // 拖尾
        for (let j = 0; j < 8; j++) {
            const tt = Math.max(0, tVal - j * 0.02);
            const tp = getPointAlongPath(pts, tt);
            const alpha = (1 - j / 8) * 0.5;
            const sz = (1 - j / 8) * 4;
            ctx.beginPath();
            ctx.arc(tp.x, tp.y, Math.max(0.5, sz), 0, Math.PI * 2);
            ctx.fillStyle = `rgba(120, 220, 255, ${alpha})`;
            ctx.shadowColor = '#74C0FC';
            ctx.shadowBlur = 6;
            ctx.fill();
        }
        // 头部
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.shadowColor = '#74C0FC';
        ctx.shadowBlur = 20;
        ctx.fill();
    }
    ctx.restore();
}

// 4. 恒星等离子（高亮星点拖尾）
function drawAnimStellar(ctx, pts, speed, t, count) {
    const sp = 0.00035 * speed;
    count = Math.max(1, count || 5);
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * sp) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        const trailLen = 5;
        for (let j = 0; j < trailLen; j++) {
            const tt = Math.max(0, tVal - j * 0.015);
            const tp = getPointAlongPath(pts, tt);
            const alpha = (1 - j / trailLen) * 0.4;
            const sz = (1 - j / trailLen) * 3 + 1;
            ctx.beginPath();
            ctx.arc(tp.x, tp.y, sz, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(180, 220, 255, ${alpha})`;
            ctx.shadowColor = '#A5D8FF';
            ctx.shadowBlur = 8;
            ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.shadowColor = '#74C0FC';
        ctx.shadowBlur = 15;
        ctx.fill();
    }
    ctx.restore();
}

// 5. 金星流动（金色圆形粒子 + 长拖尾）
function drawAnimGoldFlow(ctx, pts, speed, t, count) {
    const sp = 0.0003 * speed;
    count = Math.max(1, count || 4);
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * sp) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        for (let j = 0; j < 12; j++) {
            const tt = Math.max(0, tVal - j * 0.012);
            const tp = getPointAlongPath(pts, tt);
            const alpha = (1 - j / 12) * 0.4;
            const sz = (1 - j / 12) * 4 + 0.5;
            ctx.beginPath();
            ctx.arc(tp.x, tp.y, sz, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 215, 0, ${alpha})`;
            ctx.shadowColor = '#FFD700';
            ctx.shadowBlur = 8;
            ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#FFF8DC';
        ctx.shadowColor = '#FFD700';
        ctx.shadowBlur = 18;
        ctx.fill();
    }
    ctx.restore();
}

// 6. 水晶溪流（透明方块粒子、渐变发光质感）
function drawAnimCrystal(ctx, pts, speed, t, count) {
    const sp = 0.00025 * speed;
    count = Math.max(1, count || 7);
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * sp) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        const size = 5;
        const rot = t * 0.001 + i;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(rot);
        const grad = ctx.createLinearGradient(-size, -size, size, size);
        grad.addColorStop(0, 'rgba(100, 200, 255, 0.8)');
        grad.addColorStop(0.5, 'rgba(200, 240, 255, 0.4)');
        grad.addColorStop(1, 'rgba(100, 200, 255, 0.8)');
        ctx.fillStyle = grad;
        ctx.shadowColor = '#74C0FC';
        ctx.shadowBlur = 10;
        ctx.fillRect(-size, -size, size * 2, size * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 0.5;
        ctx.shadowBlur = 0;
        ctx.strokeRect(-size, -size, size * 2, size * 2);
        ctx.restore();
    }
    ctx.restore();
}

// 7. 量子场（细碎光点随机穿梭）
function drawAnimQuantum(ctx, pts, speed, t, count) {
    const sp = 0.0004 * speed;
    count = Math.max(1, count || 14);
    const seed = Math.floor(t / 80);
    const rng = (i) => { const x = Math.sin(seed * 99.7 + i * 31.3) * 43758.5453; return x - Math.floor(x); };
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * sp * (0.5 + rng(i) * 0.8)) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        const jitter = 4;
        const jx = (rng(i * 2 + 1) - 0.5) * jitter;
        const jy = (rng(i * 2 + 2) - 0.5) * jitter;
        const size = 1 + rng(i * 3 + 5) * 2;
        const color = ['#74C0FC', '#A5D8FF', '#E7F5FF', '#4DABF7'][i % 4];
        ctx.beginPath();
        ctx.arc(p.x + jx, p.y + jy, size, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 6;
        ctx.globalAlpha = 0.4 + rng(i * 7) * 0.6;
        ctx.fill();
    }
    ctx.restore();
}

// 8. 熔岩流（橙红渐变块状粒子）
function drawAnimLava(ctx, pts, speed, t, count) {
    const sp = 0.0002 * speed;
    count = Math.max(1, count || 6);
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * sp) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        const size = 4 + Math.sin(t * 0.003 + i) * 1.5;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size * 2);
        grad.addColorStop(0, 'rgba(255, 220, 100, 0.9)');
        grad.addColorStop(0.4, 'rgba(255, 140, 50, 0.6)');
        grad.addColorStop(1, 'rgba(200, 50, 0, 0)');
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 2, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.shadowColor = '#FF6B35';
        ctx.shadowBlur = 12;
        ctx.fill();
    }
    ctx.restore();
}

// 9. 随机闪烁星芒
function drawAnimRandSpark(ctx, pts, speed, t, count) {
    const sp = 0.001 * speed;
    count = Math.max(1, count || 10);
    const seed = Math.floor(t * sp / 5);
    const rng = (i) => { const x = Math.sin(seed * 78.3 + i * 52.7) * 43758.5453; return x - Math.floor(x); };
    // 去除紫色，用粉/青替代
    const colors = ['#FFD700', '#FF6B6B', '#4DABF7', '#69DB7C', '#FF922B', '#F06595'];
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = rng(i * 3 + 1);
        const p = getPointAlongPath(pts, tVal);
        const lifePhase = (t * sp * 0.5 + i * 1.7) % 3;
        const alpha = lifePhase < 1 ? lifePhase : (lifePhase < 2 ? 1 : Math.max(0, 2 - lifePhase));
        if (alpha <= 0.01) continue;
        const sz = 4 + rng(i * 5 + 3) * 5;
        const color = colors[Math.floor(rng(i * 7 + 9) * colors.length)];
        const rotation = rng(i * 11) * Math.PI * 2 + t * 0.001;
        ctx.globalAlpha = alpha;
        _drawStarburst(ctx, p.x, p.y, color, sz, rotation);
    }
    ctx.restore();
}

// 10. 脉冲（整体路径呼吸发光）
function drawAnimPulse(ctx, pts, speed, t) {
    const sp = 0.003 * speed;
    const pulse = 0.5 + 0.5 * Math.sin(t * sp);
    const hue = (t * 0.05) % 360;
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = `hsla(${hue}, 100%, 65%, ${0.15 + pulse * 0.15})`;
    ctx.lineWidth = 8 + pulse * 6;
    ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
    ctx.shadowBlur = 25 + pulse * 15;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.3 + pulse * 0.4})`;
    ctx.lineWidth = 2;
    ctx.shadowBlur = 12 + pulse * 8;
    ctx.stroke();
    ctx.restore();
}

// 11. 流星彗星（沿路径飞行的光点 + 拖尾 + 色变 + 粒子 + 大小脉动 + 明暗变化）
function drawAnimComet(ctx, pts, speed, t, count) {
    const moveSp = 0.00018 * speed;    // 光点沿路径移动速度
    const fastSp = 0.0033;             // 色变/脉动/明暗的快相位速度
    count = Math.max(1, count || 3);   // 同时飞行的彗星数量
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * moveSp) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        const prev = getPointAlongPath(pts, Math.max(0, tVal - 0.008));
        // 运动方向
        let dx = p.x - prev.x, dy = p.y - prev.y;
        const dlen = Math.hypot(dx, dy);
        if (dlen > 1e-4) { dx /= dlen; dy /= dlen; } else { dx = 1; dy = 0; }
        const px = -dy, py = dx;

        // 色变（每颗彗星色相基准不同）
        const hueBase = i * 120;
        const hue = (hueBase + t * fastSp * 360 / (Math.PI * 2) * 0.05) % 360;
        const starColor = `hsl(${hue}, 90%, 65%)`;
        // 大小脉动 + 明暗变化
        const pulse = 0.7 + 0.3 * Math.sin(t * fastSp * 2 + hueBase);
        const brightness = 0.55 + 0.45 * Math.sin(t * fastSp * 2 + hueBase + 0.6);
        const coreSize = Math.max(1.2, 3.5 * pulse);
        const haloSize = Math.max(3, 9 * pulse);
        const tailLen = 30 * (0.6 + pulse * 0.4);
        const tailWidth = 3.5;

        // === 1. 拖尾（沿运动反方向锥形渐变，越靠近星头越亮越宽） ===
        const tailEndX = p.x - dx * tailLen;
        const tailEndY = p.y - dy * tailLen;
        const tailHalf = tailWidth * 1.2;
        ctx.beginPath();
        ctx.moveTo(tailEndX, tailEndY);
        ctx.lineTo(p.x + px * tailHalf, p.y + py * tailHalf);
        ctx.lineTo(p.x - px * tailHalf, p.y - py * tailHalf);
        ctx.closePath();
        const tailGrad = ctx.createLinearGradient(tailEndX, tailEndY, p.x, p.y);
        tailGrad.addColorStop(0, `hsla(${hue}, 90%, 65%, 0)`);
        tailGrad.addColorStop(0.5, `hsla(${hue}, 90%, 70%, ${0.18 * brightness})`);
        tailGrad.addColorStop(1, `hsla(${hue}, 90%, 78%, ${0.65 * brightness})`);
        ctx.fillStyle = tailGrad;
        ctx.shadowColor = starColor;
        ctx.shadowBlur = 12;
        ctx.fill();

        // === 2. 光晕（径向渐变，随脉动大小变化） ===
        ctx.shadowBlur = 0;
        const haloGrad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, haloSize);
        haloGrad.addColorStop(0, `hsla(${hue}, 90%, 75%, ${0.75 * brightness})`);
        haloGrad.addColorStop(0.4, `hsla(${hue}, 90%, 60%, ${0.32 * brightness})`);
        haloGrad.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
        ctx.fillStyle = haloGrad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, haloSize, 0, Math.PI * 2);
        ctx.fill();

        // === 3. 粒子（沿拖尾散落，闪烁，越靠近星头越大越亮） ===
        const particleCount = 5;
        for (let j = 0; j < particleCount; j++) {
            const tt = (j + 1) / (particleCount + 1);
            const jitter = Math.sin(t * fastSp * 3 + j * 1.7 + hueBase) * tailWidth * 0.6;
            const ppx = p.x - dx * tailLen * tt + px * jitter;
            const ppy = p.y - dy * tailLen * tt + py * jitter;
            const psize = (1 - tt) * 1.8 + 0.4;
            const palpha = (1 - tt) * 0.65 * (0.4 + 0.6 * Math.sin(t * fastSp * 4 + j + hueBase));
            if (palpha <= 0.02) continue;
            ctx.fillStyle = `hsla(${hue}, 95%, 82%, ${palpha})`;
            ctx.shadowColor = starColor;
            ctx.shadowBlur = 6;
            ctx.beginPath();
            ctx.arc(ppx, ppy, psize, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.shadowBlur = 0;

        // === 4. 星核（白色亮点，大小+明暗脉动） ===
        ctx.fillStyle = '#FFFFFF';
        ctx.shadowColor = starColor;
        ctx.shadowBlur = 12;
        ctx.globalAlpha = brightness;
        ctx.beginPath();
        ctx.arc(p.x, p.y, coreSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
    }
    ctx.restore();
}

// ============================================================================
// 渲染
// ============================================================================

// 点与线段距离
function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

// 圆角矩形的有符号距离函数（SDF）
// 返回点到圆角矩形表面的距离，负值表示内部，正值表示外部
function sdRoundedRect(px, py, cx, cy, hw, hh, r) {
    const dx = Math.abs(px - cx) - hw + r;
    const dy = Math.abs(py - cy) - hh + r;
    const inside = Math.min(Math.max(dx, dy), 0);
    const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2);
    return inside + outside - r;
}

// 点击测试：返回点击位置命中的形状索引，-1 表示未命中
function hitTestShape(canvasX, canvasY) {
    const threshold = 10;
    for (let i = arrows.length - 1; i >= 0; i--) {
        const a = arrows[i];
        const type = a.type || "arrow";
        if (type === "arrow") {
            const dist = distanceToSegment(canvasX, canvasY, a.start.x, a.start.y, a.end.x, a.end.y);
            if (dist <= threshold) return i;
        } else if (type === "bezier") {
            // 贝塞尔曲线：采样曲线点，检测到曲线段的最小距离
            const pts = getBezierPoints(a);
            if (pts.length >= 2) {
                const samples = getBezierSamplePoints(pts);
                let minDist = Infinity;
                for (let s = 0; s < samples.length - 1; s++) {
                    const d = distanceToSegment(canvasX, canvasY, samples[s].x, samples[s].y, samples[s+1].x, samples[s+1].y);
                    if (d < minDist) minDist = d;
                }
                if (minDist <= threshold) return i;
            }
        } else {
            // 矩形/椭圆/圆形：检测点是否在形状内部（带边框阈值）
            const sx = a.start.x, sy = a.start.y, ex = a.end.x, ey = a.end.y;
            const minX = Math.min(sx, ex) - threshold, minY = Math.min(sy, ey) - threshold;
            const maxX = Math.max(sx, ex) + threshold, maxY = Math.max(sy, ey) + threshold;
            // 先在包围盒范围内检测
            if (canvasX >= minX && canvasX <= maxX && canvasY >= minY && canvasY <= maxY) {
                const left = Math.min(sx, ex), right = Math.max(sx, ex);
                const top = Math.min(sy, ey), bottom = Math.max(sy, ey);
                const w = right - left, h = bottom - top;
                const cx = (left + right) / 2, cy = (top + bottom) / 2;
                if (a.mode === "fill") {
                    if (type === "rectangle") {
                        const br = Math.min(a.borderRadius || 0, Math.min(w, h) / 2);
                        if (br > 0) {
                            // 圆角矩形：使用 SDF 检测点是否在内部
                            if (sdRoundedRect(canvasX, canvasY, cx, cy, w / 2, h / 2, br) <= 0) return i;
                        } else {
                            return i;
                        }
                    } else {
                        // 填充模式：点在包围盒内即命中（椭圆/圆形）
                        return i;
                    }
                } else {
                    // 边框模式：检测点到边界的距离
                    const rx = Math.abs(ex - sx) / 2 || 1, ry = Math.abs(ey - sy) / 2 || 1;
                    if (type === "rectangle") {
                        const br = Math.min(a.borderRadius || 0, Math.min(w, h) / 2);
                        // 使用 SDF 检测点到圆角矩形边框的距离
                        const sd = sdRoundedRect(canvasX, canvasY, cx, cy, w / 2, h / 2, br);
                        if (Math.abs(sd) <= threshold) return i;
                    } else if (type === "ellipse" || type === "circle") {
                        const r = type === "circle" ? Math.max(rx, ry) : 1;
                        const rxActual = type === "circle" ? r : rx;
                        const ryActual = type === "circle" ? r : ry;
                        const dx = (canvasX - cx) / rxActual;
                        const dy = (canvasY - cy) / ryActual;
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        // 点在椭圆内部且靠近边界（dist 在 0.8~1.0 之间）
                        if (dist >= 0.7 && dist <= 1.0) return i;
                    }
                }
            }
        }
    }
    return -1;
}

// 检查是否存在带动画的箭头
function hasAnimatedArrows() {
    if (isDrawing && currentArrow && currentArrow.animType && currentArrow.animType !== "none") return true;
    for (const a of arrows) {
        if (a.animType && a.animType !== "none") return true;
    }
    return false;
}

// 确保动画循环运行（有动画箭头时持续刷新）
function ensureAnimLoop() {
    if (animRafId !== null) return;
    if (!overlayElement || overlayElement.style.display === "none") return;
    const tick = () => {
        if (!hasAnimatedArrows()) {
            animRafId = null;
            return;
        }
        renderArrows();
        animRafId = requestAnimationFrame(tick);
    };
    animRafId = requestAnimationFrame(tick);
}

// 停止动画循环
function stopAnimLoop() {
    if (animRafId !== null) {
        cancelAnimationFrame(animRafId);
        animRafId = null;
    }
}

function renderArrows() {
    const ctx = canvasContext;
    const canvas = canvasElement;
    if (!ctx || !canvas) return;

    const dpr = window.devicePixelRatio || 1;

    // 清空画布
    clearCanvas();

    // 应用 LiteGraph 变换
    const transform = getTransform();
    ctx.setTransform(
        transform.scale * dpr,
        0,
        0,
        transform.scale * dpr,
        transform.offsetX * transform.scale * dpr,
        transform.offsetY * transform.scale * dpr
    );

    // 绘制所有已完成形状
    for (let i = 0; i < arrows.length; i++) {
        drawShape(ctx, arrows[i], i === selectedArrowIndex);
    }

    // 绘制当前正在绘制的形状
    if (isDrawing && currentArrow && currentArrow.start && currentArrow.end) {
        drawShape(ctx, currentArrow);
    }

    // 绘制模式指示器（屏幕坐标）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (isArrowModeActive) {
        const { width, height } = getCanvasDimensions();
        drawModeIndicator(ctx, width, height);
    }
}

function drawModeIndicator(ctx, width, height) {
    const padding = 12;
    const shapeNames = {
        arrow: xzgT("箭头", "Arrow"),
        rectangle: xzgT("矩形", "Rect"),
        ellipse: xzgT("椭圆", "Oval"),
        circle: xzgT("圆形", "Circle"),
        bezier: xzgT("曲线", "Curve")
    };
    const shapeName = shapeNames[arrowSettings.shapeType] || xzgT("箭头", "Arrow");
    // 贝塞尔打点式：显示当前阶段提示
    let stageText = xzgT("绘制中", "DRAWING");
    if (arrowSettings.shapeType === "bezier") {
        if (bezierDrawStage === 0) stageText = xzgT("点击放置起点", "Click to set start");
        else stageText = xzgT("点击添加点，双击完成", "Click to add, dbl-click to finish");
    }
    const text = `${shapeName}: ${stageText}`;
    const bgColor = "rgba(255, 85, 85, 0.9)";

    ctx.font = "bold 13px -apple-system, BlinkMacSystemFont, sans-serif";
    const textWidth = ctx.measureText(text).width;

    const boxWidth = textWidth + padding * 2;
    const boxHeight = 28;
    const x = width - boxWidth - 10;
    const y = 10;

    ctx.fillStyle = bgColor;
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, boxWidth, boxHeight, 6);
    } else {
        ctx.rect(x, y, boxWidth, boxHeight);
    }
    ctx.fill();

    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(text, x + padding, y + 19);

    ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    const hintText = xzgT("Esc: 退出", "Esc: Exit");
    const hintWidth = ctx.measureText(hintText).width;
    ctx.fillText(hintText, width - hintWidth - 10 - padding, y + 45);
}

// ============================================================================
// 指针事件
// ============================================================================

function setupPointerEvents() {
    const canvas = canvasElement;
    if (!canvas) return;

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("pointercancel", handlePointerCancel);

    canvas.addEventListener("touchstart", (e) => {
        if (isArrowModeActive) e.preventDefault();
    }, { passive: false });

    canvas.addEventListener("touchmove", (e) => {
        if (isArrowModeActive && isDrawing) e.preventDefault();
    }, { passive: false });

    // 鼠标滚轮事件：转发给 LiteGraph 画布以支持缩放/平移
    canvas.addEventListener("wheel", (e) => {
        if (isArrowModeActive && litegraphCanvas) {
            litegraphCanvas.dispatchEvent(new WheelEvent("wheel", {
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                deltaZ: e.deltaZ,
                deltaMode: e.deltaMode,
                clientX: e.clientX,
                clientY: e.clientY,
                screenX: e.screenX,
                screenY: e.screenY,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                shiftKey: e.shiftKey,
                metaKey: e.metaKey,
                bubbles: true,
                cancelable: true
            }));
        }
    }, { passive: false });

    // 贝塞尔绘制中右键阻止默认菜单
    canvas.addEventListener("contextmenu", (e) => {
        if (isDrawing && currentArrow?.type === "bezier") {
            e.preventDefault();
        }
    });

    window.addEventListener("blur", () => {
        if (isDrawing) abortCurrentArrow();
    });

    document.addEventListener("visibilitychange", () => {
        if (document.hidden && isDrawing) abortCurrentArrow();
    });

    // 面板关闭时不做任何事件拦截，箭头完全不可交互
}

// 双击画布关闭面板（或在贝塞尔绘制时完成曲线）
function setupCanvasDoubleClick() {
    // 覆盖层上的双击：仅用于完成贝塞尔曲线打点绘制（不再关闭面板）
    if (canvasElement) {
        canvasElement.addEventListener("dblclick", (e) => {
            if (isArrowModeActive) {
                // 贝塞尔绘制中：双击完成曲线（移除双击产生的重复点）
                if (isDrawing && currentArrow?.type === "bezier" && currentArrow.points?.length >= 2) {
                    const pts = currentArrow.points;
                    const last = pts[pts.length - 1];
                    const secondLast = pts[pts.length - 2];
                    if (Math.hypot(last.x - secondLast.x, last.y - secondLast.y) < 5) {
                        pts.pop(); // 移除双击产生的重复点
                    }
                    finishBezierDrawing();
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
        });
    }
    // LiteGraph 画布上的双击：模式激活时拦截，避免触发其他行为
    if (litegraphCanvas) {
        litegraphCanvas.addEventListener("dblclick", (e) => {
            if (isArrowModeActive && isDrawing && currentArrow?.type === "bezier") {
                e.preventDefault();
                e.stopPropagation();
            }
        });
    }
}

// 在 LiteGraph 画布上检测箭头点击（当模式未激活时，覆盖层 pointer-events:none 不接收事件）
function setupLiteGraphArrowClick() {
    if (!litegraphCanvas) return;

    litegraphCanvas.addEventListener("pointerdown", (e) => {
        // 模式激活时由覆盖层处理，无需在此处理
        if (isArrowModeActive) return;

        const rect = litegraphCanvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const canvasPos = screenToCanvas(screenX, screenY);
        const hitIndex = hitTestShape(canvasPos.x, canvasPos.y);

        if (hitIndex >= 0) {
            // 激活箭头模式并弹出面板
            isArrowModeActive = true;
            showToolbar();
            showOverlay();
            setPointerEventsMode("auto");
            setCursor("crosshair");
            selectedArrowIndex = hitIndex;
            renderArrows();
            updateToolbarState();
            updateTransformSliders();
            updateStyleSliders();
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }, true); // 使用 capture 阶段确保在 LiteGraph 之前处理
}

function handlePointerDown(e) {
    // 右键结束贝塞尔曲线绘制
    if (e.button === 2 && isDrawing && currentArrow?.type === "bezier") {
        finishBezierDrawing();
        e.preventDefault();
        return;
    }
    if (e.button !== 0) return;

    const rect = e.target.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const canvasPos = screenToCanvas(screenX, screenY);

    // 检查是否点击到已有箭头（贝塞尔打点进行中时跳过命中检测，继续打点）
    const hitIndex = (bezierDrawStage > 0) ? -1 : hitTestShape(canvasPos.x, canvasPos.y);
    if (hitIndex >= 0) {
        // 如果模式未激活，先激活箭头模式并弹出面板
        if (!isArrowModeActive) {
            isArrowModeActive = true;
            showToolbar();
            setPointerEventsMode("auto");
            setCursor("crosshair");
        }
        // 选中箭头
        selectedArrowIndex = hitIndex;
        renderArrows();
        updateToolbarState();
        updateTransformSliders();
        updateStyleSliders();
        e.preventDefault();
        return;
    }

    // 未命中箭头：仅在模式激活时开始绘制新箭头
    if (!isArrowModeActive) return;

    // 取消选中
    selectedArrowIndex = -1;

    // 贝塞尔曲线：顺序打点绘制（1, 2, 3, 4, 5...），双击或回车完成
    if (arrowSettings.shapeType === "bezier") {
        if (bezierDrawStage === 0) {
            // 第一击：起点
            bezierDrawStage = 1;
            isDrawing = true;
            startPoint = { x: canvasPos.x, y: canvasPos.y };
            currentArrow = {
                points: [{ x: canvasPos.x, y: canvasPos.y }],
                start: { x: canvasPos.x, y: canvasPos.y },
                end: { x: canvasPos.x, y: canvasPos.y },
                color: arrowSettings.color,
                lineWidth: arrowSettings.lineWidth,
                arrowSize: arrowSettings.arrowSize,
                opacity: arrowSettings.opacity,
                type: "bezier",
                mode: "border",
                borderRadius: arrowSettings.borderRadius,
                lineStyle: arrowSettings.lineStyle,
                animType: arrowSettings.animType,
                animSpeed: arrowSettings.animSpeed,
                animCount: arrowSettings.animCount
            };
        } else {
            // 后续点击：添加新点
            currentArrow.points.push({ x: canvasPos.x, y: canvasPos.y });
            currentArrow.end = { x: canvasPos.x, y: canvasPos.y };
            bezierDrawStage++;
        }
        lastPoint = { x: canvasPos.x, y: canvasPos.y };
        renderArrows();
        e.preventDefault();
        return;
    }

    // 其他形状：拖拽式绘制
    isDrawing = true;
    startPoint = { x: canvasPos.x, y: canvasPos.y };
    currentArrow = {
        start: { x: canvasPos.x, y: canvasPos.y },
        end: { x: canvasPos.x, y: canvasPos.y },
        color: arrowSettings.color,
        lineWidth: arrowSettings.lineWidth,
        arrowSize: arrowSettings.arrowSize,
        opacity: arrowSettings.opacity,
        type: arrowSettings.shapeType,
        mode: arrowSettings.shapeType === "arrow" ? "border" : arrowSettings.shapeMode,
        borderRadius: arrowSettings.borderRadius,
        lineStyle: arrowSettings.lineStyle,
        animType: arrowSettings.animType,
        animSpeed: arrowSettings.animSpeed,
        animCount: arrowSettings.animCount
    };
    lastPoint = { x: canvasPos.x, y: canvasPos.y };

    if (e.target.setPointerCapture) {
        e.target.setPointerCapture(e.pointerId);
    }
    e.preventDefault();
}

function handlePointerMove(e) {
    const rect = e.target.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const canvasPos = screenToCanvas(screenX, screenY);

    if (!isDrawing) return;

    if (currentArrow) {
        // 贝塞尔打点：用 previewPoint 实时预览下一段曲线
        if (currentArrow.type === "bezier" && bezierDrawStage >= 1) {
            currentArrow.previewPoint = { x: canvasPos.x, y: canvasPos.y };
            currentArrow.end = { x: canvasPos.x, y: canvasPos.y };
        } else {
            currentArrow.end = { x: canvasPos.x, y: canvasPos.y };
        }
    }
    lastPoint = { x: canvasPos.x, y: canvasPos.y };

    renderArrows();
    e.preventDefault();
}

function handlePointerUp(e) {
    if (!isDrawing) return;

    // 贝塞尔打点式绘制：pointerup 不结束绘制，等待下一次点击
    if (currentArrow && currentArrow.type === "bezier") {
        if (e.target.hasPointerCapture?.(e.pointerId)) {
            e.target.releasePointerCapture(e.pointerId);
        }
        return;
    }

    isDrawing = false;

    if (currentArrow && currentArrow.start && currentArrow.end) {
        const dx = currentArrow.end.x - currentArrow.start.x;
        const dy = currentArrow.end.y - currentArrow.start.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist >= 10) {
            arrows.push({
                start: { x: currentArrow.start.x, y: currentArrow.start.y },
                end: { x: currentArrow.end.x, y: currentArrow.end.y },
                color: currentArrow.color,
                lineWidth: currentArrow.lineWidth,
                arrowSize: currentArrow.arrowSize,
                opacity: currentArrow.opacity,
                type: currentArrow.type,
                mode: currentArrow.mode,
                borderRadius: currentArrow.borderRadius,
                lineStyle: currentArrow.lineStyle || "solid",
                animType: currentArrow.animType || "none",
                animSpeed: currentArrow.animSpeed || 1,
                animCount: currentArrow.animCount || 5
            });
            // 自动选中新绘制的箭头
            selectedArrowIndex = arrows.length - 1;
            recordState(xzgT("绘制箭头", "Draw arrow"));
            updateToolbarState();
            updateTransformSliders();
            updateStyleSliders();
        }
    }

    currentArrow = null;
    startPoint = null;
    lastPoint = null;

    if (e.target.hasPointerCapture?.(e.pointerId)) {
        e.target.releasePointerCapture(e.pointerId);
    }

    renderArrows();
}

function handlePointerLeave(e) {
    // 贝塞尔打点式绘制：离开画布不取消，保持打点状态
    if (currentArrow && currentArrow.type === "bezier") return;
    handlePointerUp(e);
}

function handlePointerCancel(e) {
    abortCurrentArrow();
    renderArrows();
}

function abortCurrentArrow() {
    isDrawing = false;
    currentArrow = null;
    startPoint = null;
    lastPoint = null;
    bezierDrawStage = 0;
}

// 完成贝塞尔曲线打点绘制（双击或回车触发）
function finishBezierDrawing() {
    if (!currentArrow || !currentArrow.points || currentArrow.points.length < 2) {
        // 点数不足，取消绘制
        abortCurrentArrow();
        renderArrows();
        return;
    }
    // 移除预览点
    delete currentArrow.previewPoint;
    const pts = currentArrow.points;
    arrows.push({
        points: pts.map(p => ({ x: p.x, y: p.y })),
        start: { x: pts[0].x, y: pts[0].y },
        end: { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y },
        color: currentArrow.color,
        lineWidth: currentArrow.lineWidth,
        arrowSize: currentArrow.arrowSize,
        opacity: currentArrow.opacity,
        type: "bezier",
        mode: "border",
        borderRadius: currentArrow.borderRadius,
        lineStyle: currentArrow.lineStyle || "solid",
        animType: currentArrow.animType || "none",
        animSpeed: currentArrow.animSpeed || 1,
        animCount: currentArrow.animCount || 5
    });
    selectedArrowIndex = arrows.length - 1;
    recordState(xzgT("绘制曲线", "Draw curve"));
    updateToolbarState();
    updateTransformSliders();
    updateStyleSliders();
    bezierDrawStage = 0;
    isDrawing = false;
    currentArrow = null;
    startPoint = null;
    renderArrows();
}

// 面板关闭时箭头不做任何事件拦截，由快捷键 T 统一控制模式切换

// ============================================================================
// 历史记录
// ============================================================================

function recordState(actionName) {
    if (currentHistoryIndex < history.length - 1) {
        history = history.slice(0, currentHistoryIndex + 1);
    }
    history.push(JSON.stringify(arrows));
    if (history.length > MAX_HISTORY) {
        history.shift();
    } else {
        currentHistoryIndex++;
    }
}

function recordInitialState() {
    if (history.length === 0) {
        history.push(JSON.stringify(arrows));
        currentHistoryIndex = 0;
    }
}

function performUndo() {
    if (currentHistoryIndex <= 0) return false;
    currentHistoryIndex--;
    arrows = JSON.parse(history[currentHistoryIndex]);
    syncSelectionAfterChange();
    renderArrows();
    updateToolbarState();
    return true;
}

function performRedo() {
    if (currentHistoryIndex >= history.length - 1) return false;
    currentHistoryIndex++;
    arrows = JSON.parse(history[currentHistoryIndex]);
    syncSelectionAfterChange();
    renderArrows();
    updateToolbarState();
    return true;
}

function syncSelectionAfterChange() {
    if (selectedArrowIndex >= arrows.length) {
        selectedArrowIndex = -1;
    }
}

function canUndo() {
    return currentHistoryIndex > 0;
}

function canRedo() {
    return currentHistoryIndex < history.length - 1;
}

// 自定义确认对话框（不使用浏览器原生 confirm）
function showArrowConfirmDialog(title, message) {
    return new Promise((resolve) => {
        // 注入样式（仅一次）
        if (!document.getElementById("xzg-arrow-dialog-styles")) {
            const style = document.createElement("style");
            style.id = "xzg-arrow-dialog-styles";
            style.textContent = `
                .xzg-arrow-dialog-overlay {
                    position: fixed; inset: 0;
                    background: rgba(0,0,0,0.5);
                    display: flex; align-items: center; justify-content: center;
                    z-index: 100000;
                    animation: xzg-arrow-fade-in 0.15s ease-out;
                }
                @keyframes xzg-arrow-fade-in { from { opacity: 0; } to { opacity: 1; } }
                .xzg-arrow-dialog {
                    background: #1e1e1e;
                    border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 10px;
                    padding: 0;
                    min-width: 280px;
                    max-width: calc(100vw - 40px);
                    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
                    overflow: hidden;
                    animation: xzg-arrow-pop-in 0.2s ease-out;
                }
                @keyframes xzg-arrow-pop-in {
                    from { transform: scale(0.95); opacity: 0; }
                    to { transform: scale(1); opacity: 1; }
                }
                .xzg-arrow-dialog-title {
                    color: #fff; font-size: 14px; font-weight: 600;
                    padding: 14px 16px 8px 16px;
                }
                .xzg-arrow-dialog-body {
                    color: #aaa; font-size: 12px; line-height: 1.6;
                    padding: 0 16px 16px 16px;
                }
                .xzg-arrow-dialog-footer {
                    display: flex; gap: 8px;
                    padding: 0 16px 16px 16px;
                    justify-content: flex-end;
                }
                .xzg-arrow-dialog-btn {
                    height: 30px; padding: 0 16px;
                    border-radius: 6px; border: 1px solid rgba(255,255,255,0.15);
                    background: #2a2a2a; color: #ddd;
                    font-size: 12px; cursor: pointer;
                    transition: all 0.15s;
                }
                .xzg-arrow-dialog-btn:hover { background: #3a3a3a; color: #fff; }
                .xzg-arrow-dialog-btn-cancel { }
                .xzg-arrow-dialog-btn-confirm {
                    background: rgba(255,85,85,0.2);
                    border-color: rgba(255,85,85,0.4);
                    color: #ff6b6b;
                }
                .xzg-arrow-dialog-btn-confirm:hover {
                    background: rgba(255,85,85,0.3);
                    color: #ff8585;
                }
            `;
            document.head.appendChild(style);
        }

        const overlay = document.createElement("div");
        overlay.className = "xzg-arrow-dialog-overlay";
        overlay.innerHTML = `
            <div class="xzg-arrow-dialog">
                <div class="xzg-arrow-dialog-title">${title}</div>
                <div class="xzg-arrow-dialog-body">${message}</div>
                <div class="xzg-arrow-dialog-footer">
                    <button class="xzg-arrow-dialog-btn xzg-arrow-dialog-btn-cancel">${xzgT("取消", "Cancel")}</button>
                    <button class="xzg-arrow-dialog-btn xzg-arrow-dialog-btn-confirm">${xzgT("确认清除", "Confirm Clear")}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const finish = (val) => {
            document.removeEventListener("keydown", onKey, true);
            overlay.remove();
            resolve(val);
        };
        const onKey = (e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
            else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); }
        };
        document.addEventListener("keydown", onKey, true);

        overlay.querySelector(".xzg-arrow-dialog-btn-cancel").addEventListener("click", () => finish(false));
        overlay.querySelector(".xzg-arrow-dialog-btn-confirm").addEventListener("click", () => finish(true));
        overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(false); });

        // 自动聚焦确认按钮
        overlay.querySelector(".xzg-arrow-dialog-btn-confirm").focus();
    });
}

async function clearAllArrows() {
    if (arrows.length === 0) return;
    const confirmed = await showArrowConfirmDialog(
        xzgT("清除所有箭头", "Clear All Arrows"),
        xzgT(`确定要清除全部 ${arrows.length} 个箭头吗？此操作可通过撤销恢复。`, `Are you sure you want to clear all ${arrows.length} arrows? This can be undone.`)
    );
    if (!confirmed) return;
    arrows = [];
    selectedArrowIndex = -1;
    recordState(xzgT("清除所有箭头", "Clear all arrows"));
    renderArrows();
    updateToolbarState();
}

function deleteSelectedArrow() {
    if (selectedArrowIndex < 0 || selectedArrowIndex >= arrows.length) return;
    arrows.splice(selectedArrowIndex, 1);
    selectedArrowIndex = -1;
    recordState(xzgT("删除箭头", "Delete arrow"));
    renderArrows();
    updateToolbarState();
}

// 变换函数
function applyArrowRotation(index, targetAngleDeg) {
    const arrow = arrows[index];
    // 计算中心点
    let cx, cy;
    if (arrow.points && arrow.points.length > 0) {
        cx = arrow.points.reduce((s, p) => s + p.x, 0) / arrow.points.length;
        cy = arrow.points.reduce((s, p) => s + p.y, 0) / arrow.points.length;
    } else {
        cx = (arrow.start.x + arrow.end.x) / 2;
        cy = (arrow.start.y + arrow.end.y) / 2;
    }
    // 当前角度（首末点连线）
    const currentAngle = Math.atan2(arrow.end.y - arrow.start.y, arrow.end.x - arrow.start.x);
    const targetAngle = targetAngleDeg * Math.PI / 180;
    const delta = targetAngle - currentAngle;
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);

    // 旋转所有点（新格式）
    if (arrow.points) {
        for (const p of arrow.points) {
            const px = p.x - cx;
            const py = p.y - cy;
            p.x = cx + px * cos - py * sin;
            p.y = cy + px * sin + py * cos;
        }
    }

    // 旋转起点/终点/控制点（旧格式）
    const sx = arrow.start.x - cx;
    const sy = arrow.start.y - cy;
    arrow.start.x = cx + sx * cos - sy * sin;
    arrow.start.y = cy + sx * sin + sy * cos;

    const ex = arrow.end.x - cx;
    const ey = arrow.end.y - cy;
    arrow.end.x = cx + ex * cos - ey * sin;
    arrow.end.y = cy + ex * sin + ey * cos;

    if (arrow.control) {
        const px = arrow.control.x - cx;
        const py = arrow.control.y - cy;
        arrow.control.x = cx + px * cos - py * sin;
        arrow.control.y = cy + px * sin + py * cos;
    }

    updateTransformSliders();
}

function applyArrowPosition(index) {
    const arrow = arrows[index];
    const sliderX = toolbarElement?.querySelector(".xzg-arrow-x-slider");
    const sliderY = toolbarElement?.querySelector(".xzg-arrow-y-slider");
    if (!sliderX || !sliderY) return;

    const offsetX = parseFloat(sliderX.value);
    const offsetY = parseFloat(sliderY.value);
    const dx = offsetX - lastSliderX;
    const dy = offsetY - lastSliderY;

    // 移动所有点（新格式）
    if (arrow.points) {
        for (const p of arrow.points) {
            p.x += dx;
            p.y += dy;
        }
    }

    arrow.start.x += dx;
    arrow.start.y += dy;
    arrow.end.x += dx;
    arrow.end.y += dy;
    // 贝塞尔曲线的控制点也一起移动
    if (arrow.control) {
        arrow.control.x += dx;
        arrow.control.y += dy;
    }

    lastSliderX = offsetX;
    lastSliderY = offsetY;
}

// 重置单轴位移（双击滑块触发）
function resetAxis(axis) {
    if (selectedArrowIndex < 0 || selectedArrowIndex >= arrows.length) return;
    const arrow = arrows[selectedArrowIndex];

    if (axis === "x") {
        const delta = 0 - lastSliderX;
        if (delta !== 0) {
            if (arrow.points) {
                for (const p of arrow.points) { p.x += delta; }
            }
            arrow.start.x += delta;
            arrow.end.x += delta;
            if (arrow.control) arrow.control.x += delta;
        }
        const slider = toolbarElement?.querySelector(".xzg-arrow-x-slider");
        const display = toolbarElement?.querySelector(".xzg-arrow-x-value");
        if (slider) slider.value = 0;
        if (display) display.textContent = "0";
        lastSliderX = 0;
    } else {
        const delta = 0 - lastSliderY;
        if (delta !== 0) {
            if (arrow.points) {
                for (const p of arrow.points) { p.y += delta; }
            }
            arrow.start.y += delta;
            arrow.end.y += delta;
            if (arrow.control) arrow.control.y += delta;
        }
        const slider = toolbarElement?.querySelector(".xzg-arrow-y-slider");
        const display = toolbarElement?.querySelector(".xzg-arrow-y-value");
        if (slider) slider.value = 0;
        if (display) display.textContent = "0";
        lastSliderY = 0;
    }

    renderArrows();
    recordState(xzgT("重置位移", "Reset offset"));
}

function updateTransformSliders() {
    if (!toolbarElement) return;
    const rotateSlider = toolbarElement.querySelector(".xzg-arrow-rotate-slider");
    const xSlider = toolbarElement.querySelector(".xzg-arrow-x-slider");
    const ySlider = toolbarElement.querySelector(".xzg-arrow-y-slider");
    const rotateDisplay = toolbarElement.querySelector(".xzg-arrow-rotate-value");
    const xDisplay = toolbarElement.querySelector(".xzg-arrow-x-value");
    const yDisplay = toolbarElement.querySelector(".xzg-arrow-y-value");

    if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
        const arrow = arrows[selectedArrowIndex];
        const angle = Math.atan2(arrow.end.y - arrow.start.y, arrow.end.x - arrow.start.x);
        const angleDeg = ((angle * 180 / Math.PI) % 360 + 360) % 360;

        if (rotateSlider) rotateSlider.value = angleDeg;
        if (rotateDisplay) rotateDisplay.textContent = `${Math.round(angleDeg)}°`;

        // 重置位移滑条为相对偏移 0
        lastSliderX = 0;
        lastSliderY = 0;
        if (xSlider) { xSlider.value = 0; }
        if (xDisplay) xDisplay.textContent = `0`;
        if (ySlider) { ySlider.value = 0; }
        if (yDisplay) yDisplay.textContent = `0`;
    } else {
        // 无选中箭头时重置滑条
        if (rotateSlider) rotateSlider.value = 0;
        if (rotateDisplay) rotateDisplay.textContent = `0°`;
        if (xSlider) xSlider.value = 0;
        if (xDisplay) xDisplay.textContent = `0`;
        if (ySlider) ySlider.value = 0;
        if (yDisplay) yDisplay.textContent = `0`;
    }
}

function updateStyleSliders() {
    if (!toolbarElement) return;
    const colorInput = toolbarElement.querySelector(".xzg-arrow-color-input");
    const widthSlider = toolbarElement.querySelector(".xzg-arrow-width-slider");
    const widthDisplay = toolbarElement.querySelector(".xzg-arrow-width-value");
    const headSlider = toolbarElement.querySelector(".xzg-arrow-head-slider");
    const headDisplay = toolbarElement.querySelector(".xzg-arrow-head-value");
    const headRow = toolbarElement.querySelector("#xzg-arrow-head-row");
    const opacitySlider = toolbarElement.querySelector(".xzg-arrow-opacity-slider");
    const opacityDisplay = toolbarElement.querySelector(".xzg-arrow-opacity-value");
    const radiusSlider = toolbarElement.querySelector(".xzg-arrow-radius-slider");
    const radiusDisplay = toolbarElement.querySelector(".xzg-arrow-radius-value");
    const radiusRow = toolbarElement.querySelector("#xzg-arrow-radius-row");
    const shapeSelect = toolbarElement.querySelector("#xzg-shape-select");
    const lineStyleSelect = toolbarElement.querySelector("#xzg-linestyle-select");
    const animSelect = toolbarElement.querySelector(".xzg-arrow-anim-select");
    const animSpeedSlider = toolbarElement.querySelector(".xzg-arrow-anim-speed-slider");
    const animSpeedDisplay = toolbarElement.querySelector(".xzg-arrow-anim-speed-value");
    const animSpeedRow = toolbarElement.querySelector("#xzg-arrow-anim-speed-row");

    if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
        const arrow = arrows[selectedArrowIndex];
        const type = arrow.type || "arrow";
        const mode = arrow.mode || "border";
        const lineStyle = arrow.lineStyle || "solid";
        if (colorInput) colorInput.value = arrow.color;
        if (widthSlider) widthSlider.value = arrow.lineWidth;
        if (widthDisplay) widthDisplay.textContent = arrow.lineWidth;
        if (headSlider) headSlider.value = arrow.arrowSize;
        if (headDisplay) headDisplay.textContent = arrow.arrowSize;
        if (opacitySlider) opacitySlider.value = Math.round(arrow.opacity * 100);
        if (opacityDisplay) opacityDisplay.textContent = `${Math.round(arrow.opacity * 100)}%`;
        if (radiusSlider) radiusSlider.value = arrow.borderRadius || 0;
        if (radiusDisplay) radiusDisplay.textContent = arrow.borderRadius || 0;
        if (radiusRow) radiusRow.style.display = type === "rectangle" ? "" : "none";

        // 同步特效动画控件
        const animType = arrow.animType || "none";
        const animSpd = arrow.animSpeed !== undefined ? arrow.animSpeed : 1;
        const animCnt = arrow.animCount !== undefined ? arrow.animCount : 5;
        if (animSelect) animSelect.value = animType;
        if (animSpeedSlider) animSpeedSlider.value = animSpd;
        if (animSpeedDisplay) animSpeedDisplay.textContent = animSpd;
        if (animSpeedRow) animSpeedRow.style.display = (animType === "none") ? "none" : "flex";
        const animCountSlider = toolbarElement.querySelector(".xzg-arrow-anim-count-slider");
        const animCountDisplay = toolbarElement.querySelector(".xzg-arrow-anim-count-value");
        const animCountRow = toolbarElement.querySelector("#xzg-arrow-anim-count-row");
        if (animCountSlider) animCountSlider.value = animCnt;
        if (animCountDisplay) animCountDisplay.textContent = animCnt;
        if (animCountRow) animCountRow.style.display = (animType === "none" || animType === "energy" || animType === "pulse") ? "none" : "flex";

        // 同步形状与线型下拉列表
        if (shapeSelect) shapeSelect.value = type;
        if (lineStyleSelect) lineStyleSelect.value = lineStyle;
        // 同步间距滑块
        const dashGapRow = toolbarElement.querySelector("#xzg-arrow-dashgap-row");
        if (dashGapRow) dashGapRow.style.display = (lineStyle === "solid") ? "none" : "flex";
        const dashGapSlider = toolbarElement.querySelector(".xzg-arrow-dashgap-slider");
        const dashGapDisplay = toolbarElement.querySelector(".xzg-arrow-dashgap-value");
        if (dashGapSlider) dashGapSlider.value = arrowSettings.dashGap;
        if (dashGapDisplay) dashGapDisplay.textContent = arrowSettings.dashGap;
        // 同步模式行显示
        const modeRow = toolbarElement.querySelector("#xzg-arrow-mode-row");
        if (modeRow) modeRow.style.display = (type === "arrow" || type === "bezier") ? "none" : "";
        // 同步模式按钮
        toolbarElement.querySelectorAll(".xzg-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
    } else {
        // 无选中箭头时还原为全局设置
        if (colorInput) colorInput.value = arrowSettings.color;
        if (widthSlider) widthSlider.value = arrowSettings.lineWidth;
        if (widthDisplay) widthDisplay.textContent = arrowSettings.lineWidth;
        if (headSlider) headSlider.value = arrowSettings.arrowSize;
        if (headDisplay) headDisplay.textContent = arrowSettings.arrowSize;
        if (opacitySlider) opacitySlider.value = Math.round(arrowSettings.opacity * 100);
        if (opacityDisplay) opacityDisplay.textContent = `${Math.round(arrowSettings.opacity * 100)}%`;
        if (radiusSlider) radiusSlider.value = arrowSettings.borderRadius;
        if (radiusDisplay) radiusDisplay.textContent = arrowSettings.borderRadius;
        if (radiusRow) radiusRow.style.display = arrowSettings.shapeType === "rectangle" ? "" : "none";

        // 同步特效动画控件为全局设置
        if (animSelect) animSelect.value = arrowSettings.animType;
        if (animSpeedSlider) animSpeedSlider.value = arrowSettings.animSpeed;
        if (animSpeedDisplay) animSpeedDisplay.textContent = arrowSettings.animSpeed;
        if (animSpeedRow) animSpeedRow.style.display = (arrowSettings.animType === "none") ? "none" : "flex";
        const animCountSliderG = toolbarElement.querySelector(".xzg-arrow-anim-count-slider");
        const animCountDisplayG = toolbarElement.querySelector(".xzg-arrow-anim-count-value");
        const animCountRowG = toolbarElement.querySelector("#xzg-arrow-anim-count-row");
        if (animCountSliderG) animCountSliderG.value = arrowSettings.animCount;
        if (animCountDisplayG) animCountDisplayG.textContent = arrowSettings.animCount;
        if (animCountRowG) animCountRowG.style.display = (arrowSettings.animType === "none" || arrowSettings.animType === "energy" || arrowSettings.animType === "pulse") ? "none" : "flex";

        // 同步下拉列表为全局设置
        if (shapeSelect) shapeSelect.value = arrowSettings.shapeType;
        if (lineStyleSelect) lineStyleSelect.value = arrowSettings.lineStyle;
        // 同步间距滑块
        const dashGapRow = toolbarElement.querySelector("#xzg-arrow-dashgap-row");
        if (dashGapRow) dashGapRow.style.display = (arrowSettings.lineStyle === "solid") ? "none" : "flex";
        const dashGapSlider = toolbarElement.querySelector(".xzg-arrow-dashgap-slider");
        const dashGapDisplay = toolbarElement.querySelector(".xzg-arrow-dashgap-value");
        if (dashGapSlider) dashGapSlider.value = arrowSettings.dashGap;
        if (dashGapDisplay) dashGapDisplay.textContent = arrowSettings.dashGap;
        const modeRow = toolbarElement.querySelector("#xzg-arrow-mode-row");
        if (modeRow) modeRow.style.display = (arrowSettings.shapeType === "arrow" || arrowSettings.shapeType === "bezier") ? "none" : "";
        toolbarElement.querySelectorAll(".xzg-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === arrowSettings.shapeMode));
    }
}

// ============================================================================
// 模式切换 - 面板控制，覆盖层始终显示
// ============================================================================

function toggleArrowMode() {
    isArrowModeActive = !isArrowModeActive;

    if (isArrowModeActive) {
        // 激活：显示面板 + 覆盖层
        showToolbar();
        showOverlay();
        setPointerEventsMode("auto");
        setCursor("crosshair");
    } else {
        // 关闭：隐藏面板，覆盖层保持显示但穿透鼠标事件，让箭头持久可见
        hideToolbar();
        setPointerEventsMode("none");
        setCursor("default");
        abortCurrentArrow();
        selectedArrowIndex = -1;
    }

    renderArrows();
    updateToolbarState();
    updateTransformSliders();
    updateStyleSliders();
}

function showOverlay() {
    if (overlayElement) {
        overlayElement.style.display = "block";
        // 覆盖层从隐藏变为可见后，重新计算画布尺寸
        // 因为隐藏时 getBoundingClientRect 返回 0
        requestAnimationFrame(updateCanvasSize);
        // 若存在带动画的箭头，启动动画循环
        if (hasAnimatedArrows()) ensureAnimLoop();
    }
}

function hideOverlay() {
    if (overlayElement) overlayElement.style.display = "none";
    stopAnimLoop();
}

// ============================================================================
// 持久化
// ============================================================================

function setupPersistence() {
    const LGraph = window.LGraph;
    if (LGraph && LGraph.prototype.serialize) {
        const origSerialize = LGraph.prototype.serialize;
        LGraph.prototype.serialize = function () {
            const data = origSerialize.apply(this, arguments);
            if (!data.extra) data.extra = {};
            if (arrows.length > 0) {
                data.extra[EXTENSION_KEY] = {
                    version: 3,
                    arrows: arrows.map(a => {
                        const obj = {
                            start: { x: a.start.x, y: a.start.y },
                            end: { x: a.end.x, y: a.end.y },
                            color: a.color,
                            lineWidth: a.lineWidth,
                            arrowSize: a.arrowSize,
                            opacity: a.opacity,
                            type: a.type || "arrow",
                            mode: a.mode || "border",
                            borderRadius: a.borderRadius || 0,
                            lineStyle: a.lineStyle || "solid",
                            animType: a.animType || "none",
                            animSpeed: a.animSpeed || 1,
                            animCount: a.animCount || 5
                        };
                        // 新格式贝塞尔曲线：保存 points 数组
                        if (a.points) {
                            obj.points = a.points.map(p => ({ x: p.x, y: p.y }));
                        }
                        // 旧格式贝塞尔曲线：保存 control 点
                        if (a.control) {
                            obj.control = { x: a.control.x, y: a.control.y };
                        }
                        return obj;
                    })
                };
            } else {
                delete data.extra[EXTENSION_KEY];
            }
            return data;
        };
    }

    if (app) {
        const origLoadGraphData = app.loadGraphData.bind(app);
        app.loadGraphData = async function (graphData, ...args) {
            arrows = [];
            history = [];
            currentHistoryIndex = -1;

            const result = await origLoadGraphData(graphData, ...args);

            setTimeout(() => {
                if (graphData?.extra?.[EXTENSION_KEY]) {
                    const data = graphData.extra[EXTENSION_KEY];
                    if (data.arrows && Array.isArray(data.arrows)) {
                        arrows = data.arrows.map(a => {
                            const obj = {
                                start: { x: a.start.x, y: a.start.y },
                                end: { x: a.end.x, y: a.end.y },
                                color: a.color || "#FF5555",
                                lineWidth: a.lineWidth || 3,
                                arrowSize: a.arrowSize || 10,
                                opacity: a.opacity !== undefined ? a.opacity : 1.0,
                                type: a.type || "arrow",
                                mode: a.mode || "border",
                                borderRadius: a.borderRadius || 0,
                                lineStyle: a.lineStyle || "solid",
                                animType: a.animType || "none",
                                animSpeed: a.animSpeed !== undefined ? a.animSpeed : 1,
                                animCount: a.animCount !== undefined ? a.animCount : 5
                            };
                            // 新格式贝塞尔曲线：加载 points 数组
                            if (a.points) {
                                obj.points = a.points.map(p => ({ x: p.x, y: p.y }));
                            }
                            // 旧格式贝塞尔曲线：加载 control 点
                            if (a.control) {
                                obj.control = { x: a.control.x, y: a.control.y };
                            }
                            return obj;
                        });
                        recordInitialState();
                        renderArrows();
                        updateToolbarState();
                    }
                } else {
                    recordInitialState();
                    renderArrows();
                }
            }, 100);

            return result;
        };
    }
}

// ============================================================================
// 设置持久化
// ============================================================================

function loadSettings() {
    try {
        const saved = localStorage.getItem(STORAGE_SETTINGS_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed.color) arrowSettings.color = parsed.color;
            if (parsed.lineWidth) arrowSettings.lineWidth = parsed.lineWidth;
            if (parsed.arrowSize) arrowSettings.arrowSize = parsed.arrowSize;
            if (parsed.opacity !== undefined) arrowSettings.opacity = parsed.opacity;
            if (parsed.shapeType) arrowSettings.shapeType = parsed.shapeType;
            if (parsed.shapeMode) arrowSettings.shapeMode = parsed.shapeMode;
            if (parsed.borderRadius !== undefined) arrowSettings.borderRadius = parsed.borderRadius;
            if (parsed.lineStyle) arrowSettings.lineStyle = parsed.lineStyle;
            if (parsed.dashGap !== undefined) arrowSettings.dashGap = parsed.dashGap;
            if (parsed.animType !== undefined) arrowSettings.animType = parsed.animType;
            if (parsed.animSpeed !== undefined) arrowSettings.animSpeed = parsed.animSpeed;
            if (parsed.animCount !== undefined) arrowSettings.animCount = parsed.animCount;
        }
    } catch (e) {}
}

function saveSettings() {
    try {
        localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(arrowSettings));
    } catch (e) {}
}

function loadShortcut() {
    try {
        const saved = localStorage.getItem(STORAGE_SHORTCUT_KEY);
        if (saved) {
            shortcut = { ...DEFAULT_SHORTCUT, ...JSON.parse(saved) };
        }
    } catch (e) {}
}

function saveShortcut(s) {
    shortcut = { ...s };
    try {
        localStorage.setItem(STORAGE_SHORTCUT_KEY, JSON.stringify(shortcut));
    } catch (e) {}
}

function formatShortcut(sc) {
    const parts = [];
    if (sc.ctrl) parts.push("Ctrl");
    if (sc.alt) parts.push("Alt");
    if (sc.shift) parts.push("Shift");
    if (sc.meta) parts.push("Meta");
    parts.push(sc.key.toUpperCase());
    return parts.join("+");
}

function loadPosition() {
    try {
        const saved = localStorage.getItem(STORAGE_POSITION_KEY);
        if (saved) {
            const pos = JSON.parse(saved);
            if (typeof pos.top === "number" && typeof pos.left === "number") {
                return pos;
            }
        }
    } catch (e) {}
    return null;
}

function savePosition(top, left) {
    try {
        localStorage.setItem(STORAGE_POSITION_KEY, JSON.stringify({ top, left }));
    } catch (e) {}
}

function loadSize() {
    try {
        const saved = localStorage.getItem(STORAGE_SIZE_KEY);
        if (saved) {
            const size = JSON.parse(saved);
            if (typeof size.width === "number" && size.width >= 220) {
                return size;
            }
        }
    } catch (e) {}
    return null;
}

function saveSize(width) {
    try {
        localStorage.setItem(STORAGE_SIZE_KEY, JSON.stringify({ width }));
    } catch (e) {}
}

// ============================================================================
// 快捷键对话框（参考主题面板）
// ============================================================================

function showShortcutDialog() {
    const originalShortcut = { ...shortcut };
    let pendingShortcut = null;

    const dialog = document.createElement("div");
    dialog.className = "xzg-dialog-overlay";
    dialog.innerHTML = `
        <div class="xzg-dialog">
            <div class="xzg-dialog-title">${xzgT("设置快捷键","Set Shortcut")}</div>
            <div class="xzg-dialog-body">
                <p style="margin-bottom: 16px; color: #888; font-size: 12px; text-align: center;">${xzgT("请按下你想要的快捷键","Press the shortcut keys you want")}</p>
                <div style="text-align: center; margin-bottom: 16px;">
                    <div id="xzg-arrow-listen-display" style="
                        padding: 16px 24px;
                        background: #667eea;
                        border: 2px solid #667eea;
                        border-radius: 6px;
                        color: #fff;
                        font-size: 16px;
                        font-weight: bold;
                        min-width: 180px;
                        display: inline-block;
                    ">${xzgT("请按快捷键...","Press keys...")}</div>
                </div>
            </div>
            <div class="xzg-dialog-footer">
                <button class="xzg-btn xzg-btn-cancel" id="xzg-arrow-dialog-cancel" type="button">${xzgT("取消","Cancel")}</button>
                <button class="xzg-btn xzg-btn-ok" id="xzg-arrow-dialog-ok" type="button" disabled>${xzgT("确定","OK")}</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);

    const display = dialog.querySelector("#xzg-arrow-listen-display");
    const okBtn = dialog.querySelector("#xzg-arrow-dialog-ok");
    let isListening = true;
    let keydownHandler = null;

    const cleanup = () => {
        isListening = false;
        document.removeEventListener("keydown", keydownHandler, true);
        dialog.remove();
    };

    const showPreview = (s) => {
        const parts = [];
        if (s.ctrl) parts.push("Ctrl");
        if (s.alt) parts.push("Alt");
        if (s.shift) parts.push("Shift");
        if (s.meta) parts.push("Meta");
        parts.push(s.key.toUpperCase());
        display.textContent = parts.join(" + ");
        display.style.background = "#2a2a2a";
        display.style.color = "#667eea";
        okBtn.disabled = false;
    };

    keydownHandler = (e) => {
        if (!isListening) return;
        e.preventDefault();
        e.stopPropagation();

        if (e.key === "Escape") return;

        const key = e.key.toLowerCase();
        if (key === "control" || key === "alt" || key === "shift" || key === "meta") {
            return;
        }

        pendingShortcut = {
            key: key,
            ctrl: e.ctrlKey,
            alt: e.altKey,
            shift: e.shiftKey,
            meta: e.metaKey
        };

        showPreview(pendingShortcut);
    };

    document.addEventListener("keydown", keydownHandler, true);

    dialog.querySelector("#xzg-arrow-dialog-cancel").addEventListener("click", () => {
        cleanup();
    });

    okBtn.addEventListener("click", () => {
        if (!pendingShortcut) return;
        saveShortcut(pendingShortcut);
        updateShortcutDisplay();
        cleanup();
    });

    // 点击对话框外部关闭
    dialog.addEventListener("click", (e) => {
        if (e.target === dialog) cleanup();
    });
}

// ============================================================================
// 工具栏
// ============================================================================

function createToolbar(container) {
    if (toolbarElement) return toolbarElement;

    // 加载保存的位置和尺寸
    const savedPos = loadPosition();
    const savedSize = loadSize();
    const posStyle = savedPos
        ? `top:${savedPos.top}px;left:${savedPos.left}px;right:auto;`
        : `top:60px;right:10px;`;
    const widthStyle = savedSize ? `width:${savedSize.width}px;` : `width:220px;`;

    toolbarElement = document.createElement("div");
    toolbarElement.id = TOOLBAR_ID;
    toolbarElement.style.cssText = `
        position: absolute;
        ${posStyle}
        ${widthStyle}
        min-width: 220px;
        background: rgba(30, 30, 30, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        color: #fff;
        z-index: 1000;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        user-select: none;
        display: none;
    `;

    toolbarElement.innerHTML = buildToolbarHTML();
    container.appendChild(toolbarElement);

    applyToolbarStyles();
    setupToolbarEvents();
    updateShortcutDisplay();

    return toolbarElement;
}

function buildToolbarHTML() {
    return `
        <div class="xzg-arrow-header">
            <span class="xzg-arrow-title">${xzgT("小珠光箭头工具", "Xiaozhuguang Arrow Tool")}</span>
            <button class="xzg-arrow-shortcut-btn" id="xzg-arrow-shortcut-btn" title="${xzgT("点击修改快捷键", "Click to change shortcut")}"></button>
            <button class="xzg-arrow-close-btn" id="xzg-arrow-close-btn" title="${xzgT("关闭", "Close")}">✕</button>
        </div>
        <div class="xzg-arrow-content">
            <div class="xzg-arrow-select-row">
                <div class="xzg-arrow-select-cell">
                    <label>${xzgT("形状", "Shape")}</label>
                    <select class="xzg-shape-select" id="xzg-shape-select">
                        <option value="arrow" ${arrowSettings.shapeType === "arrow" ? "selected" : ""}>${xzgT("箭头", "Arrow")}</option>
                        <option value="rectangle" ${arrowSettings.shapeType === "rectangle" ? "selected" : ""}>${xzgT("矩形", "Rect")}</option>
                        <option value="ellipse" ${arrowSettings.shapeType === "ellipse" ? "selected" : ""}>${xzgT("椭圆", "Oval")}</option>
                        <option value="circle" ${arrowSettings.shapeType === "circle" ? "selected" : ""}>${xzgT("圆形", "Circle")}</option>
                        <option value="bezier" ${arrowSettings.shapeType === "bezier" ? "selected" : ""}>${xzgT("曲线", "Curve")}</option>
                    </select>
                </div>
                <div class="xzg-arrow-select-cell">
                    <label>${xzgT("线型", "Line")}</label>
                    <select class="xzg-linestyle-select" id="xzg-linestyle-select">
                        <option value="solid" ${arrowSettings.lineStyle === "solid" ? "selected" : ""}>${xzgT("实线", "Solid")}</option>
                        <option value="dashed" ${arrowSettings.lineStyle === "dashed" ? "selected" : ""}>${xzgT("虚线", "Dashed")}</option>
                        <option value="dotted" ${arrowSettings.lineStyle === "dotted" ? "selected" : ""}>${xzgT("圆点虚线", "Dotted")}</option>
                    </select>
                </div>
            </div>
            <div class="xzg-arrow-mode-row" id="xzg-arrow-mode-row" style="${(arrowSettings.shapeType === "arrow" || arrowSettings.shapeType === "bezier") ? "display:none;" : ""}">
                <button class="xzg-mode-btn ${arrowSettings.shapeMode === "border" ? "active" : ""}" data-mode="border">${xzgT("边框", "Border")}</button>
                <button class="xzg-mode-btn ${arrowSettings.shapeMode === "fill" ? "active" : ""}" data-mode="fill">${xzgT("填充", "Fill")}</button>
            </div>
            <div class="xzg-arrow-section">
                <div class="xzg-arrow-basic-group">
                <div class="xzg-arrow-setting-row">
                    <label class="xzg-arrow-red-label">${xzgT("颜色", "Color")}</label>
                    <input type="color" class="xzg-arrow-color-input" value="${arrowSettings.color}">
                    <span class="xzg-arrow-color-placeholder"></span>
                </div>
                <div class="xzg-arrow-setting-row">
                    <label class="xzg-arrow-red-label">${xzgT("线宽", "Width")}</label>
                    <input type="range" class="xzg-arrow-width-slider xzg-arrow-red-slider" min="1" max="10" value="${arrowSettings.lineWidth}">
                    <span class="xzg-arrow-width-value">${arrowSettings.lineWidth}</span>
                </div>
                <div class="xzg-arrow-setting-row">
                    <label class="xzg-arrow-red-label">${xzgT("透明度", "Opacity")}</label>
                    <input type="range" class="xzg-arrow-opacity-slider xzg-arrow-red-slider" min="${arrowSettings.animType !== "none" ? 0 : 20}" max="100" value="${Math.round(arrowSettings.opacity * 100)}">
                    <span class="xzg-arrow-opacity-value">${Math.round(arrowSettings.opacity * 100)}%</span>
                </div>
                <div class="xzg-arrow-setting-row">
                    <label class="xzg-arrow-green-label">${xzgT("旋转", "Rotate")}</label>
                    <input type="range" class="xzg-arrow-rotate-slider xzg-arrow-green-slider" min="0" max="360" value="0">
                    <span class="xzg-arrow-rotate-value">0°</span>
                </div>
                <div class="xzg-arrow-setting-row">
                    <label class="xzg-arrow-green-label">${xzgT("相对X", "Rel X")}</label>
                    <input type="range" class="xzg-arrow-x-slider xzg-arrow-green-slider" min="-200" max="200" value="0">
                    <span class="xzg-arrow-x-value">0</span>
                </div>
                <div class="xzg-arrow-setting-row">
                    <label class="xzg-arrow-green-label">${xzgT("相对Y", "Rel Y")}</label>
                    <input type="range" class="xzg-arrow-y-slider xzg-arrow-green-slider" min="-200" max="200" value="0">
                    <span class="xzg-arrow-y-value">0</span>
                </div>
                </div>
                <div class="xzg-arrow-silver-group">
                <div class="xzg-arrow-setting-row" id="xzg-arrow-head-row">
                    <label class="xzg-arrow-blue-label">${xzgT("箭头", "Head")}</label>
                    <input type="range" class="xzg-arrow-head-slider xzg-arrow-blue-slider" min="0" max="50" value="${arrowSettings.arrowSize}">
                    <span class="xzg-arrow-head-value">${arrowSettings.arrowSize}</span>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-radius-row" style="display:none;">
                    <label class="xzg-arrow-blue-label">${xzgT("圆角", "Radius")}</label>
                    <input type="range" class="xzg-arrow-radius-slider xzg-arrow-blue-slider" min="0" max="50" value="${arrowSettings.borderRadius}">
                    <span class="xzg-arrow-radius-value">${arrowSettings.borderRadius}</span>
                </div>
                
                <div class="xzg-arrow-setting-row" id="xzg-arrow-anim-row">
                    <label class="xzg-arrow-blue-label">${xzgT("特效", "FX")}</label>
                    <select class="xzg-arrow-anim-select" id="xzg-arrow-anim-select">
                        <option value="none" ${arrowSettings.animType === "none" ? "selected" : ""}>${xzgT("无", "None")}</option>
                        <option value="sparkle" ${arrowSettings.animType === "sparkle" ? "selected" : ""}>${xzgT("七彩星芒", "Sparkle")}</option>
                        <option value="energy" ${arrowSettings.animType === "energy" ? "selected" : ""}>${xzgT("能量脉冲", "Energy")}</option>
                        <option value="transfer" ${arrowSettings.animType === "transfer" ? "selected" : ""}>${xzgT("高速穿梭", "Transfer")}</option>
                        <option value="stellar" ${arrowSettings.animType === "stellar" ? "selected" : ""}>${xzgT("恒星等离子", "Stellar")}</option>
                        <option value="diy1" ${arrowSettings.animType === "diy1" ? "selected" : ""}>${xzgT("金星流动", "Gold Flow")}</option>
                        <option value="crystal" ${arrowSettings.animType === "crystal" ? "selected" : ""}>${xzgT("水晶溪流", "Crystal")}</option>
                        <option value="quantum" ${arrowSettings.animType === "quantum" ? "selected" : ""}>${xzgT("量子场", "Quantum")}</option>
                        <option value="lava" ${arrowSettings.animType === "lava" ? "selected" : ""}>${xzgT("熔岩流", "Lava")}</option>
                        <option value="randspark" ${arrowSettings.animType === "randspark" ? "selected" : ""}>${xzgT("随机闪烁", "Rand Spark")}</option>
                        <option value="pulse" ${arrowSettings.animType === "pulse" ? "selected" : ""}>${xzgT("脉冲呼吸", "Pulse")}</option>
                        <option value="comet" ${arrowSettings.animType === "comet" ? "selected" : ""}>${xzgT("流星彗星", "Comet")}</option>
                    </select>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-anim-speed-row" style="display:none;">
                    <label class="xzg-arrow-blue-label">${xzgT("速度", "Speed")}</label>
                    <input type="range" class="xzg-arrow-anim-speed-slider xzg-arrow-blue-slider" min="1" max="100" value="${arrowSettings.animSpeed}">
                    <span class="xzg-arrow-anim-speed-value">${arrowSettings.animSpeed}</span>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-anim-count-row" style="display:none;">
                    <label class="xzg-arrow-blue-label">${xzgT("数量", "Count")}</label>
                    <input type="range" class="xzg-arrow-anim-count-slider xzg-arrow-blue-slider" min="1" max="30" value="${arrowSettings.animCount}">
                    <span class="xzg-arrow-anim-count-value">${arrowSettings.animCount}</span>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-dashgap-row" style="display:${(arrowSettings.lineStyle === "solid") ? "none" : "flex"};">
                    <label class="xzg-arrow-blue-label">${xzgT("间距", "Gap")}</label>
                    <input type="range" class="xzg-arrow-dashgap-slider xzg-arrow-blue-slider" min="1" max="10" value="${arrowSettings.dashGap}">
                    <span class="xzg-arrow-dashgap-value">${arrowSettings.dashGap}</span>
                </div>
                </div>
            </div>
            <div class="xzg-arrow-section">
                <div class="xzg-arrow-action-buttons">
                    <div class="xzg-arrow-action-row">
                        <button class="xzg-arrow-action-btn xzg-arrow-delete-btn" disabled>
                            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>
                            ${xzgT("删除", "Delete")}
                        </button>
                        <button class="xzg-arrow-action-btn xzg-arrow-clear-btn" disabled>
                            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>
                            ${xzgT("清除", "Clear")}
                        </button>
                    </div>
                </div>
            </div>
        </div>
        <div class="xzg-arrow-resize-handle"></div>
    `;
}

function applyToolbarStyles() {
    const styleId = "xzg-arrow-toolbar-styles";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
        .xzg-arrow-header {
            display: flex;
            align-items: center;
            padding: 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            gap: 8px;
            cursor: move;
        }
        .xzg-arrow-title {
            flex: 1;
            font-weight: 600;
            color: #fff;
            font-size: 12px;
        }
        .xzg-arrow-shortcut-btn {
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.2);
            color: #fff;
            padding: 3px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            transition: all 0.15s;
            white-space: nowrap;
        }
        .xzg-arrow-shortcut-btn:hover {
            background: rgba(255,255,255,0.15);
            border-color: rgba(255,255,255,0.35);
            color: #fff;
        }
        .xzg-arrow-close-btn {
            background: none;
            border: none;
            color: #FF5555;
            font-size: 14px;
            line-height: 1;
            padding: 2px 4px;
            cursor: pointer;
            border-radius: 3px;
            transition: all 0.15s;
        }
        .xzg-arrow-close-btn:hover {
            color: #fff;
            background: rgba(255,85,85,0.3);
        }
        .xzg-arrow-content {
            padding: 8px;
        }
        .xzg-arrow-shape-types {
            display: flex;
            gap: 4px;
            margin-bottom: 6px;
        }
        .xzg-arrow-select-row {
            display: flex;
            gap: 6px;
            margin-bottom: 6px;
        }
        .xzg-arrow-select-cell {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }
        .xzg-arrow-select-cell label {
            width: 34px;
            flex-shrink: 0;
            color: #fff;
            font-size: 12px;
        }
        .xzg-arrow-select-cell select {
            flex: 1;
            min-width: 0;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.2);
            color: #fff;
            padding: 4px 4px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            outline: none;
            transition: border-color 0.15s;
        }
        .xzg-arrow-select-cell select:hover {
            border-color: rgba(255,255,255,0.4);
        }
        .xzg-arrow-select-cell select:focus {
            border-color: #667eea;
        }
        .xzg-arrow-select-cell select option {
            background: #2a2a2a;
            color: #fff;
        }
        .xzg-arrow-mode-row {
            display: flex;
            gap: 4px;
            margin-bottom: 6px;
        }
        .xzg-mode-btn {
            flex: 1;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            color: #fff;
            padding: 4px 2px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.15s;
            text-align: center;
        }
        .xzg-mode-btn:hover {
            background: rgba(255,255,255,0.1);
            color: #fff;
        }
        .xzg-mode-btn.active {
            background: rgba(102,126,234,0.25);
            border-color: #667eea;
            color: #fff;
        }
        .xzg-arrow-section {
            margin-bottom: 12px;
        }
        .xzg-arrow-section:last-child {
            margin-bottom: 0;
        }
        .xzg-arrow-section-label {
            font-size: 12px;
            color: #fff;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 6px;
        }
        .xzg-arrow-setting-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 6px;
        }
        .xzg-arrow-setting-row:last-child {
            margin-bottom: 0;
        }
        .xzg-arrow-basic-group {
            border: 1px solid #D4AF37;
            border-radius: 4px;
            padding: 6px 8px;
            margin-bottom: 8px;
        }
        .xzg-arrow-basic-group .xzg-arrow-setting-row label {
            color: #E8E0D0;
        }
        .xzg-arrow-silver-group {
            border: 1px solid #C0C0C0;
            border-radius: 4px;
            padding: 6px 8px;
            margin-bottom: 8px;
        }
        .xzg-arrow-silver-group .xzg-arrow-setting-row .xzg-arrow-blue-label {
            color: #6699FF !important;
        }
        .xzg-arrow-blue-slider::-webkit-slider-thumb {
            background: #6699FF !important;
        }
        .xzg-arrow-blue-slider::-moz-range-thumb {
            background: #6699FF !important;
        }
        .xzg-arrow-anim-select {
            color: #6699FF !important;
            font-size: 12px;
            border: 1px solid #6699FF !important;
            background: #000 !important;
        }
        .xzg-arrow-anim-select option {
            background: #000 !important;
            color: #6699FF !important;
        }
        .xzg-arrow-setting-row label {
            width: 50px;
            color: #fff;
            font-size: 12px;
        }
        .xzg-arrow-red-label {
            color: #FF4444 !important;
        }
        .xzg-arrow-red-slider::-webkit-slider-thumb {
            background: #FF4444 !important;
        }
        .xzg-arrow-red-slider::-moz-range-thumb {
            background: #FF4444 !important;
        }
        .xzg-arrow-green-label {
            color: #44BB44 !important;
        }
        .xzg-arrow-green-slider::-webkit-slider-thumb {
            background: #44BB44 !important;
        }
        .xzg-arrow-green-slider::-moz-range-thumb {
            background: #44BB44 !important;
        }
        .xzg-arrow-setting-row input[type="range"] {
            flex: 1;
            height: 4px;
            -webkit-appearance: none;
            appearance: none;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 2px;
            cursor: pointer;
        }
        .xzg-arrow-setting-row input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 12px;
            height: 12px;
            background: #fff;
            border-radius: 50%;
            cursor: pointer;
        }
        .xzg-arrow-setting-row input[type="range"]::-moz-range-thumb {
            width: 12px;
            height: 12px;
            background: #fff;
            border-radius: 50%;
            cursor: pointer;
            border: none;
        }
        .xzg-arrow-setting-row span {
            width: 35px;
            text-align: right;
            color: #fff;
            font-size: 12px;
        }
        .xzg-arrow-color-input {
            flex: 1;
            height: 24px;
            padding: 0;
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 4px;
            cursor: pointer;
            background: transparent;
        }
        .xzg-arrow-color-placeholder {
            width: 35px;
            flex-shrink: 0;
        }
        .xzg-arrow-color-input::-webkit-color-swatch-wrapper {
            padding: 2px;
        }
        .xzg-arrow-color-input::-webkit-color-swatch {
            border-radius: 2px;
            border: none;
        }
        .xzg-arrow-action-buttons {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .xzg-arrow-action-row {
            display: flex;
            gap: 4px;
        }
        .xzg-arrow-action-row .xzg-arrow-action-btn {
            flex: 1;
        }
        .xzg-arrow-action-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #fff;
            padding: 6px 8px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.15s;
            font-size: 12px;
        }
        .xzg-arrow-action-btn:hover:not(:disabled) {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
        }
        .xzg-arrow-action-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        .xzg-arrow-clear-btn:hover:not(:disabled),
        .xzg-arrow-delete-btn:hover:not(:disabled) {
            background: rgba(255, 85, 85, 0.2);
            border-color: rgba(255, 85, 85, 0.5);
            color: #FF5555;
        }
        .xzg-arrow-resize-handle {
            position: absolute;
            bottom: 0;
            right: 0;
            width: 14px;
            height: 14px;
            cursor: nwse-resize;
            background: transparent;
            z-index: 1;
        }
        .xzg-arrow-resize-handle::after {
            content: "";
            position: absolute;
            bottom: 3px;
            right: 3px;
            width: 6px;
            height: 6px;
            border-right: 2px solid rgba(255,255,255,0.3);
            border-bottom: 2px solid rgba(255,255,255,0.3);
        }
        .xzg-arrow-resize-handle:hover::after {
            border-color: rgba(255,255,255,0.6);
        }
    `;
    document.head.appendChild(style);
}

function setupToolbarEvents() {
    if (!toolbarElement) return;

    // 快捷键按钮
    const shortcutBtn = toolbarElement.querySelector("#xzg-arrow-shortcut-btn");
    shortcutBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        showShortcutDialog();
    });

    // 关闭按钮
    const closeBtn = toolbarElement.querySelector("#xzg-arrow-close-btn");
    closeBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleArrowMode();
    });

    // 形状类型选择（下拉列表）
    const shapeSelect = toolbarElement.querySelector("#xzg-shape-select");
    shapeSelect?.addEventListener("change", (e) => {
        e.stopPropagation();
        const shape = e.target.value;
        // 切换形状时取消进行中的贝塞尔打点
        if (bezierDrawStage > 0) {
            abortCurrentArrow();
            renderArrows();
        }
        arrowSettings.shapeType = shape;
        // 箭头/曲线类型默认为边框模式，隐藏模式行；其他形状显示模式行
        const modeRow = toolbarElement.querySelector("#xzg-arrow-mode-row");
        if (modeRow) {
            const noMode = shape === "arrow" || shape === "bezier";
            modeRow.style.display = noMode ? "none" : "";
            if (noMode) arrowSettings.shapeMode = "border";
        }
        // 圆角行仅矩形显示
        const radiusRow = toolbarElement.querySelector("#xzg-arrow-radius-row");
        if (radiusRow) {
            radiusRow.style.display = shape === "rectangle" ? "" : "none";
        }
        // 更新模式按钮激活状态
        toolbarElement.querySelectorAll(".xzg-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === arrowSettings.shapeMode));
        // 切换形状时同步选中箭头的形状
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            arrows[selectedArrowIndex].type = shape;
            renderArrows();
            recordState(xzgT("切换形状", "Change shape"));
        }
        saveSettings();
    });

    // 线型选择（下拉列表）
    const lineStyleSelect = toolbarElement.querySelector("#xzg-linestyle-select");
    lineStyleSelect?.addEventListener("change", (e) => {
        e.stopPropagation();
        arrowSettings.lineStyle = e.target.value;
        // 显示/隐藏间距滑块
        const dashGapRow = toolbarElement.querySelector("#xzg-arrow-dashgap-row");
        if (dashGapRow) dashGapRow.style.display = (arrowSettings.lineStyle === "solid") ? "none" : "flex";
        // 立即应用到当前选中的箭头
        if (currentArrow) currentArrow.lineStyle = arrowSettings.lineStyle;
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            arrows[selectedArrowIndex].lineStyle = arrowSettings.lineStyle;
            renderArrows();
            recordState(xzgT("切换线型", "Change line style"));
        }
        saveSettings();
    });

    // 虚线/圆点间距滑块
    const dashGapSlider = toolbarElement.querySelector(".xzg-arrow-dashgap-slider");
    dashGapSlider?.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        arrowSettings.dashGap = val;
        const display = toolbarElement.querySelector(".xzg-arrow-dashgap-value");
        if (display) display.textContent = val;
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            renderArrows();
        }
    });
    dashGapSlider?.addEventListener("change", () => {
        saveSettings();
    });

    // 边框/填充模式切换
    toolbarElement.querySelectorAll(".xzg-mode-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            arrowSettings.shapeMode = btn.dataset.mode;
            toolbarElement.querySelectorAll(".xzg-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === arrowSettings.shapeMode));
            // 立即应用到当前选中的节点
            if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
                arrows[selectedArrowIndex].mode = arrowSettings.shapeMode;
                renderArrows();
                recordState(xzgT("切换填充模式", "Toggle fill mode"));
            }
            saveSettings();
        });
    });

    // 颜色选择
    const colorInput = toolbarElement.querySelector(".xzg-arrow-color-input");
    colorInput?.addEventListener("input", (e) => {
        arrowSettings.color = e.target.value;
        if (currentArrow) {
            currentArrow.color = e.target.value;
        }
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            arrows[selectedArrowIndex].color = e.target.value;
        }
        renderArrows();
        saveSettings();
    });
    colorInput?.addEventListener("change", () => {
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            recordState(xzgT("修改箭头颜色", "Change arrow color"));
        }
    });

    // 线宽滑块
    const widthSlider = toolbarElement.querySelector(".xzg-arrow-width-slider");
    widthSlider?.addEventListener("input", (e) => {
        arrowSettings.lineWidth = parseInt(e.target.value);
        const display = toolbarElement.querySelector(".xzg-arrow-width-value");
        if (display) display.textContent = arrowSettings.lineWidth;
        if (currentArrow) {
            currentArrow.lineWidth = arrowSettings.lineWidth;
        }
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            arrows[selectedArrowIndex].lineWidth = arrowSettings.lineWidth;
        }
        renderArrows();
        saveSettings();
    });
    widthSlider?.addEventListener("change", () => {
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            recordState(xzgT("修改箭头线宽", "Change arrow width"));
        }
    });

    // 箭头大小滑块
    const headSlider = toolbarElement.querySelector(".xzg-arrow-head-slider");
    headSlider?.addEventListener("input", (e) => {
        arrowSettings.arrowSize = parseInt(e.target.value);
        const display = toolbarElement.querySelector(".xzg-arrow-head-value");
        if (display) display.textContent = arrowSettings.arrowSize;
        if (currentArrow) {
            currentArrow.arrowSize = arrowSettings.arrowSize;
        }
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            arrows[selectedArrowIndex].arrowSize = arrowSettings.arrowSize;
        }
        renderArrows();
        saveSettings();
    });
    headSlider?.addEventListener("change", () => {
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            recordState(xzgT("修改箭头大小", "Change arrow size"));
        }
    });

    // 透明度滑块
    const opacitySlider = toolbarElement.querySelector(".xzg-arrow-opacity-slider");
    opacitySlider?.addEventListener("input", (e) => {
        arrowSettings.opacity = parseInt(e.target.value) / 100;
        const display = toolbarElement.querySelector(".xzg-arrow-opacity-value");
        if (display) display.textContent = `${e.target.value}%`;
        if (currentArrow) {
            currentArrow.opacity = arrowSettings.opacity;
        }
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            arrows[selectedArrowIndex].opacity = arrowSettings.opacity;
        }
        renderArrows();
        saveSettings();
    });
    opacitySlider?.addEventListener("change", () => {
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            recordState(xzgT("修改箭头透明度", "Change arrow opacity"));
        }
    });

    // 圆角滑块
    const radiusSlider = toolbarElement.querySelector(".xzg-arrow-radius-slider");
    radiusSlider?.addEventListener("input", (e) => {
        arrowSettings.borderRadius = parseInt(e.target.value);
        const display = toolbarElement.querySelector(".xzg-arrow-radius-value");
        if (display) display.textContent = arrowSettings.borderRadius;
        if (currentArrow) {
            currentArrow.borderRadius = arrowSettings.borderRadius;
        }
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            arrows[selectedArrowIndex].borderRadius = arrowSettings.borderRadius;
        }
        renderArrows();
        saveSettings();
    });
    radiusSlider?.addEventListener("change", () => {
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            recordState(xzgT("修改矩形圆角", "Change rectangle radius"));
        }
    });

    // 特效动画下拉
    const animSelect = toolbarElement.querySelector(".xzg-arrow-anim-select");
    const animSpeedRow = toolbarElement.querySelector("#xzg-arrow-anim-speed-row");
    const animCountRow = toolbarElement.querySelector("#xzg-arrow-anim-count-row");
    animSelect?.addEventListener("change", (e) => {
        arrowSettings.animType = e.target.value;
        // 显示/隐藏速度滑块
        if (animSpeedRow) animSpeedRow.style.display = (arrowSettings.animType === "none") ? "none" : "flex";
        // 显示/隐藏数量滑块（energy/pulse 为整体路径效果，无需数量）
        if (animCountRow) animCountRow.style.display = (arrowSettings.animType === "none" || arrowSettings.animType === "energy" || arrowSettings.animType === "pulse") ? "none" : "flex";
        // 开启特效时透明度最低可到0
        const opacitySlider = toolbarElement.querySelector(".xzg-arrow-opacity-slider");
        if (opacitySlider) opacitySlider.min = arrowSettings.animType !== "none" ? "0" : "20";
        if (currentArrow) currentArrow.animType = arrowSettings.animType;
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            arrows[selectedArrowIndex].animType = arrowSettings.animType;
            recordState(xzgT("修改特效动画", "Change animation"));
        }
        if (arrowSettings.animType !== "none") {
            ensureAnimLoop();
        }
        renderArrows();
        saveSettings();
    });

    // 动画速度滑块
    const animSpeedSlider = toolbarElement.querySelector(".xzg-arrow-anim-speed-slider");
    animSpeedSlider?.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        arrowSettings.animSpeed = val;
        const display = toolbarElement.querySelector(".xzg-arrow-anim-speed-value");
        if (display) display.textContent = val;
        if (currentArrow) currentArrow.animSpeed = val;
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            arrows[selectedArrowIndex].animSpeed = val;
        }
        renderArrows();
    });
    animSpeedSlider?.addEventListener("change", () => {
        saveSettings();
    });

    // 动画数量滑块
    const animCountSlider = toolbarElement.querySelector(".xzg-arrow-anim-count-slider");
    animCountSlider?.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        arrowSettings.animCount = val;
        const display = toolbarElement.querySelector(".xzg-arrow-anim-count-value");
        if (display) display.textContent = val;
        if (currentArrow) currentArrow.animCount = val;
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            arrows[selectedArrowIndex].animCount = val;
        }
        renderArrows();
    });
    animCountSlider?.addEventListener("change", () => {
        saveSettings();
    });

    // 旋转滑块
    const rotateSlider = toolbarElement.querySelector(".xzg-arrow-rotate-slider");
    rotateSlider?.addEventListener("input", (e) => {
        const angle = parseFloat(e.target.value);
        const display = toolbarElement.querySelector(".xzg-arrow-rotate-value");
        if (display) display.textContent = `${Math.round(angle)}°`;
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            applyArrowRotation(selectedArrowIndex, angle);
            renderArrows();
        }
    });
    rotateSlider?.addEventListener("change", () => {
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            recordState(xzgT("旋转箭头", "Rotate arrow"));
        }
    });

    // X 位移滑块
    const xSlider = toolbarElement.querySelector(".xzg-arrow-x-slider");
    xSlider?.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        const display = toolbarElement.querySelector(".xzg-arrow-x-value");
        if (display) display.textContent = `${Math.round(val)}`;
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            applyArrowPosition(selectedArrowIndex);
            renderArrows();
        }
    });
    xSlider?.addEventListener("change", () => {
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            recordState(xzgT("移动箭头", "Move arrow"));
        }
    });
    // 双击 X 滑块归零
    xSlider?.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        resetAxis("x");
    });

    // Y 位移滑块
    const ySlider = toolbarElement.querySelector(".xzg-arrow-y-slider");
    ySlider?.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        const display = toolbarElement.querySelector(".xzg-arrow-y-value");
        if (display) display.textContent = `${Math.round(val)}`;
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            applyArrowPosition(selectedArrowIndex);
            renderArrows();
        }
    });
    ySlider?.addEventListener("change", () => {
        if (selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
            recordState(xzgT("移动箭头", "Move arrow"));
        }
    });
    // 双击 Y 滑块归零
    ySlider?.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        resetAxis("y");
    });

    // 清除按钮
    const clearBtn = toolbarElement.querySelector(".xzg-arrow-clear-btn");
    clearBtn?.addEventListener("click", clearAllArrows);

    // 删除选中按钮
    const deleteBtn = toolbarElement.querySelector(".xzg-arrow-delete-btn");
    deleteBtn?.addEventListener("click", deleteSelectedArrow);

    // 缩放手柄
    setupResizeHandle();

    // 拖动功能
    setupDrag();
}

function setupResizeHandle() {
    const handle = toolbarElement?.querySelector(".xzg-arrow-resize-handle");
    if (!handle) return;

    handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        resizeStartX = e.clientX;
        resizeStartWidth = toolbarElement.offsetWidth;
        toolbarElement.style.cursor = "nwse-resize";
        // 禁用 header 拖拽
        const header = toolbarElement.querySelector(".xzg-arrow-header");
        if (header) header.style.pointerEvents = "none";
    });

    document.addEventListener("mousemove", handleResizeMove);
    document.addEventListener("mouseup", handleResizeEnd);
}

function handleResizeMove(e) {
    if (!isResizing) return;
    const minWidth = 220;
    const maxWidth = 600;
    const delta = e.clientX - resizeStartX;
    const newWidth = Math.max(minWidth, Math.min(maxWidth, resizeStartWidth + delta));
    toolbarElement.style.width = `${newWidth}px`;
    toolbarElement.style.right = "auto";
}

function handleResizeEnd() {
    if (!isResizing) return;
    isResizing = false;
    toolbarElement.style.cursor = "";
    const header = toolbarElement.querySelector(".xzg-arrow-header");
    if (header) header.style.pointerEvents = "";
    const width = parseFloat(toolbarElement.style.width);
    if (!isNaN(width) && width >= 220) {
        saveSize(width);
    }
}

function setupDrag() {
    const header = toolbarElement?.querySelector(".xzg-arrow-header");
    if (!header) return;

    header.addEventListener("mousedown", (e) => {
        // 点击快捷键按钮或关闭按钮不触发拖动
        if (e.target.closest("#xzg-arrow-shortcut-btn") || e.target.closest("#xzg-arrow-close-btn")) return;

        isDragging = true;
        const rect = toolbarElement.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        toolbarElement.style.cursor = "grabbing";
        toolbarElement.style.right = "auto";
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        const parentRect = toolbarElement.parentElement.getBoundingClientRect();
        const newLeft = e.clientX - parentRect.left - dragOffsetX;
        const newTop = e.clientY - parentRect.top - dragOffsetY;
        toolbarElement.style.left = `${newLeft}px`;
        toolbarElement.style.top = `${newTop}px`;
        toolbarElement.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
        if (!isDragging) return;
        isDragging = false;
        toolbarElement.style.cursor = "";
        const left = parseFloat(toolbarElement.style.left);
        const top = parseFloat(toolbarElement.style.top);
        if (!isNaN(left) && !isNaN(top)) {
            savePosition(top, left);
        }
    });
}

function updateShortcutDisplay() {
    const btn = toolbarElement?.querySelector("#xzg-arrow-shortcut-btn");
    if (btn) {
        btn.textContent = xzgT("快捷键","Shortcut") + ": " + formatShortcut(shortcut);
    }
}

function updateToolbarState() {
    if (!toolbarElement) return;

    const clearBtn = toolbarElement.querySelector(".xzg-arrow-clear-btn");
    const deleteBtn = toolbarElement.querySelector(".xzg-arrow-delete-btn");

    if (clearBtn) clearBtn.disabled = arrows.length === 0;
    if (deleteBtn) deleteBtn.disabled = selectedArrowIndex < 0 || selectedArrowIndex >= arrows.length;
}

function showToolbar() {
    if (toolbarElement) {
        toolbarElement.style.display = "block";
    }
}

function hideToolbar() {
    if (toolbarElement) toolbarElement.style.display = "none";
}

// ============================================================================
// 键盘快捷键（使用可自定义快捷键）
// ============================================================================

function setupKeyboardShortcut() {
    document.addEventListener("keydown", (e) => {
        const activeEl = document.activeElement;
        const isTyping = activeEl && (
            (activeEl.tagName === "INPUT" && activeEl.type !== "range") ||
            activeEl.tagName === "TEXTAREA" ||
            activeEl.isContentEditable
        );
        if (isTyping) return;

        // 检查是否匹配自定义快捷键
        const match =
            (e.key.toLowerCase() === shortcut.key) &&
            (e.ctrlKey === !!shortcut.ctrl) &&
            (e.altKey === !!shortcut.alt) &&
            (e.shiftKey === !!shortcut.shift) &&
            (e.metaKey === !!shortcut.meta);

        if (match) {
            toggleArrowMode();
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (isArrowModeActive) {
            // 回车完成贝塞尔曲线绘制
            if (e.key === "Enter" && isDrawing && currentArrow?.type === "bezier") {
                finishBezierDrawing();
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            // Ctrl+Z 撤销
            if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
                performUndo();
                e.preventDefault();
                e.stopPropagation();
            }
            // Ctrl+Shift+Z 重做
            if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey) && e.shiftKey) {
                performRedo();
                e.preventDefault();
                e.stopPropagation();
            }
            // Escape 退出模式
            if (e.key === "Escape") {
                toggleArrowMode();
                e.preventDefault();
                e.stopPropagation();
            }
            // Delete/Backspace 删除选中箭头
            if ((e.key === "Delete" || e.key === "Backspace") && selectedArrowIndex >= 0 && selectedArrowIndex < arrows.length) {
                deleteSelectedArrow();
                e.preventDefault();
                e.stopPropagation();
            }
        }
    }, true);
}

// ============================================================================
// 初始化
// ============================================================================

function waitForCanvasAndInitialize() {
    let attempts = 0;
    const maxAttempts = 300;
    const pollInterval = 100;

    function tryInitialize() {
        try {
            const canvas = document.querySelector("canvas");
            if (canvas && canvas.parentElement && app?.canvas?.ds) {
                initializeArrowSystem(canvas);
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    if (tryInitialize()) return;

    const intervalId = setInterval(() => {
        attempts++;
        if (tryInitialize()) {
            clearInterval(intervalId);
        } else if (attempts >= maxAttempts) {
            clearInterval(intervalId);
        }
    }, pollInterval);
}

function initializeArrowSystem(litegraphCanvas) {
    const container = litegraphCanvas.parentElement;
    container.style.position = "relative";

    // 加载设置
    loadSettings();
    loadShortcut();

    // 创建覆盖层（默认隐藏）
    createOverlay(container);

    // 创建工具栏（默认隐藏）
    createToolbar(container);

    // 设置变换追踪
    let lastTransformStr = "";
    transformTrackerCleanup = createTransformTracker(() => {
        const transform = getTransform();
        const transformStr = `${transform.scale},${transform.offsetX},${transform.offsetY}`;
        if (transformStr !== lastTransformStr) {
            lastTransformStr = transformStr;
            renderArrows();
        }
    });

    // 设置指针事件
    setupPointerEvents();

    // 设置 LiteGraph 画布箭头点击检测（模式未激活时也可点击箭头弹出面板）
    setupLiteGraphArrowClick();

    // 设置双击画布关闭面板
    setupCanvasDoubleClick();

    // 设置键盘快捷键
    setupKeyboardShortcut();

    // 设置持久化
    setupPersistence();

    // 记录初始状态
    recordInitialState();

    // 初始化渲染（覆盖层显示但穿透鼠标事件，已绘制的箭头持久可见）
    showOverlay();
    setPointerEventsMode("none");
    renderArrows();
    updateToolbarState();
}

function createTransformTracker(onChange) {
    let lastScale = -1;
    let lastOffsetX = -Infinity;
    let lastOffsetY = -Infinity;
    let rafId = null;
    let isRunning = true;

    function checkTransform() {
        if (!isRunning) return;
        onChange();
        rafId = requestAnimationFrame(checkTransform);
    }

    checkTransform();
    return () => {
        isRunning = false;
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    };
}

// ============================================================================
// 扩展注册
// ============================================================================

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.arrow",

    async setup() {
        waitForCanvasAndInitialize();
    }
});