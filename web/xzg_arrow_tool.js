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
    lineWidth: 2,
    arrowSize: 10,
    opacity: 1.0,
    shapeType: "arrow", // "arrow" | "rectangle" | "ellipse" | "circle" | "bezier" | "freehand"
    shapeMode: "border", // "border" | "fill"
    borderRadius: 3,
    lineStyle: "solid", // "solid" | "dashed" | "dotted"
    dashGap: 2,         // 虚线/圆点间距倍数
    animType: "none",   // 特效动画类型
    animSpeed: 30,       // 动画速度
    animCount: 5,       // 动画数量（星芒/粒子/光点等个数）
    animSize: 15,      // 动画元素大小（0-100，默认15为75%，最小10%）
    pacmanDots: 8,       // 吃豆人豆子数量
    pacmanSize: 50,       // 吃豆人自身大小 (0-100, 50=默认1x, 100=10x)
    pacmanDotRatio: 30,   // 豆子占吃豆人的大小比例 (5-100, 30=30%)
    fadeInEnabled: true,  // 渐入开关
    fadeInDuration: 1000,   // 渐入时长（ms）
    smoothness: 50,         // 手绘平滑幅度（5-100px，最小收集距离）
    closed: false,          // 曲线闭合
    deactivateClickSelect: false  // 钝化激活：禁止点击画布选择箭头
};

// 默认箭头设置（用于恢复默认）
const DEFAULT_ARROW_SETTINGS = { ...arrowSettings };

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

// 箭头选中状态（多选支持）
let selectedArrowIndices = new Set();

// 辅助函数：选中状态查询
function isSelected(idx) { return selectedArrowIndices.has(idx); }
function getSelectedIndices() { return [...selectedArrowIndices]; }
function hasSelection() { return selectedArrowIndices.size > 0; }
function clearSelection() { selectedArrowIndices.clear(); }
function setSingleSelection(idx) { selectedArrowIndices.clear(); selectedArrowIndices.add(idx); }
function addToSelection(idx) { selectedArrowIndices.add(idx); }
function removeFromSelection(idx) { selectedArrowIndices.delete(idx); }
function toggleSelection(idx) { if (selectedArrowIndices.has(idx)) selectedArrowIndices.delete(idx); else selectedArrowIndices.add(idx); }
function getFirstSelectedIndex() { return selectedArrowIndices.size > 0 ? [...selectedArrowIndices][0] : -1; }

// 批量应用属性到所有选中的箭头，返回是否成功应用
function applyToSelectedArrows(prop, val) {
    if (!hasSelection()) return false;
    const selIndices = getSelectedIndices();
    for (const idx of selIndices) {
        arrows[idx][prop] = val;
    }
    return true;
}

// 端点拖拽状态
let _draggingEndpoint = null; // { arrowIndex: number, point: 'start'|'end', pointIndex?: number, startX: number, startY: number }

// 整体拖拽状态（拖动中心手柄移动整个形状，支持多选）
let _draggingShape = null; // { arrowIndices: number[], refIndex: number, offsetX: number, offsetY: number, startCenters: {x:number,y:number}[] }

// 旋转拖拽状态（拖动旋转手柄旋转形状，仅单选）
let _draggingRotation = null; // { arrowIndex: number, centerX: number, centerY: number, startAngle: number }

// 框选状态
let _boxSelecting = false;
let _boxSelectStart = null; // { x, y }
let _boxSelectRect = null; // { x, y, w, h } — 规范化后的矩形（x,y为左上角）

// 拖拽滑条时隐藏选中高亮，避免干扰实时预览
let _hideSelectionHighlight = false;

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

// 使用 requestAnimationFrame 节流渲染，避免鼠标高频事件导致卡顿
let _renderRafId = null;
function scheduleRender() {
    if (_renderRafId !== null) return;
    _renderRafId = requestAnimationFrame(() => {
        _renderRafId = null;
        renderArrows();
    });
}

// ============================================================================
// 形状绘制
// ============================================================================

// 计算形状包围盒
function getShapeBounds(shape) {
    // 新格式贝塞尔曲线：从所有点计算包围盒
    if ((shape.type === "bezier" || shape.type === "freehand") && shape.points && shape.points.length > 0) {
        const pts = shape.type === "bezier" ? getBezierPoints(shape) : shape.points;
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
        case "freehand":
            drawFreehandShape(ctx, shape, mode);
            break;
    }

    // 选中高亮：白色虚线描边跟随形状轮廓（绘制在形状上层）
    if (isSelected) {
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.globalAlpha = 1;
        drawShapeVectorPath(ctx, shape);
        ctx.restore();

        // 端点拖拽手柄（选中时显示，手绘不显示）
        // 贝塞尔曲线显示所有控制点，其他类型显示首尾端点
        // 圆形/椭圆：在边缘显示手柄，用于调整半径
        const skipHandleTypes = ["freehand"];
        if (!skipHandleTypes.includes(shape.type || "arrow")) {
            ctx.save();
            ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
            ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
            ctx.lineWidth = 1.5;
            const handleR = 5;
            if (shape.type === "circle") {
                // 圆形：右侧边缘一个手柄
                const cx = (shape.start.x + shape.end.x) / 2;
                const cy = (shape.start.y + shape.end.y) / 2;
                const r = Math.max(Math.abs(shape.end.x - shape.start.x), Math.abs(shape.end.y - shape.start.y)) / 2;
                ctx.beginPath();
                ctx.arc(cx + r, cy, handleR, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            } else if (shape.type === "ellipse") {
                // 椭圆：右侧（长轴）和下侧（短轴）各一个手柄
                const cx = (shape.start.x + shape.end.x) / 2;
                const cy = (shape.start.y + shape.end.y) / 2;
                const rx = Math.max(Math.abs(shape.end.x - shape.start.x) / 2, 0.1);
                const ry = Math.max(Math.abs(shape.end.y - shape.start.y) / 2, 0.1);
                const rot = shape.rotation || 0;
                const cos = Math.cos(rot * Math.PI / 180), sin = Math.sin(rot * Math.PI / 180);
                // 右侧手柄（视觉位置）
                const rhx = cx + rx * cos;
                const rhy = cy + rx * sin;
                ctx.beginPath();
                ctx.arc(rhx, rhy, handleR, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                // 下侧手柄（视觉位置）
                const bhx = cx - ry * sin;
                const bhy = cy + ry * cos;
                ctx.beginPath();
                ctx.arc(bhx, bhy, handleR, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            } else if (shape.type === "bezier" && shape.points && shape.points.length > 0) {
                // 贝塞尔曲线：绘制所有控制点
                for (const p of shape.points) {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, handleR, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                }
            } else {
                // 矩形：端点未旋转，需要应用旋转变换
                const type = shape.type || "arrow";
                const rot = shape.rotation || 0;
                if (type === "rectangle" && rot !== 0) {
                    const cx = (shape.start.x + shape.end.x) / 2;
                    const cy = (shape.start.y + shape.end.y) / 2;
                    ctx.translate(cx, cy);
                    ctx.rotate(rot * Math.PI / 180);
                    ctx.translate(-cx, -cy);
                }
                // 起始点
                ctx.beginPath();
                ctx.arc(shape.start.x, shape.start.y, handleR, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                // 结束点
                ctx.beginPath();
                ctx.arc(shape.end.x, shape.end.y, handleR, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
            ctx.restore();
        }

        // 中心拖动手柄（菱形，所有类型都显示，用于整体移动形状）
        {
            const center = _getShapeCenter(shape);
            const size = 6;
            ctx.save();
            ctx.fillStyle = "rgba(255, 215, 0, 0.85)";
            ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(center.x, center.y - size);
            ctx.lineTo(center.x + size, center.y);
            ctx.lineTo(center.x, center.y + size);
            ctx.lineTo(center.x - size, center.y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }

        // 旋转手柄（中心上方的小圆 + 连接虚线，用于旋转形状）
        {
            const center = _getShapeCenter(shape);
            const rotDist = 30;
            const rotHandleX = center.x;
            const rotHandleY = center.y - rotDist;
            ctx.save();
            // 旋转手柄跟着形状一起转
            const rot = shape.rotation || 0;
            if (rot !== 0) {
                ctx.translate(center.x, center.y);
                ctx.rotate(rot * Math.PI / 180);
                ctx.translate(-center.x, -center.y);
            }
            // 连接虚线
            ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(center.x, center.y - 6);
            ctx.lineTo(rotHandleX, rotHandleY + 5);
            ctx.stroke();
            ctx.setLineDash([]);
            // 旋转手柄圆
            ctx.fillStyle = "rgba(100, 200, 255, 0.85)";
            ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(rotHandleX, rotHandleY, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }
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
function getBezierSamplePoints(pts, samplesPerSegment = 12, closed = false) {
    if (pts.length < 2) return pts;
    const n = pts.length;
    const result = [pts[0]];
    const segments = closed ? n : n - 1;
    for (let i = 0; i < segments; i++) {
        const p0 = closed ? pts[(i - 1 + n) % n] : (i > 0 ? pts[i - 1] : pts[i]);
        const p1 = pts[i];
        const p2 = pts[(i + 1) % n];
        const p3 = closed ? pts[(i + 2) % n] : (i < n - 2 ? pts[i + 2] : pts[i + 1]);
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

// 绘制 Catmull-Rom 插值曲线路径，支持闭合环绕（环绕时最后一段也是平滑贝塞尔曲线）
function drawCatmullRomPath(ctx, rawPts, closed) {
    const n = rawPts.length;
    if (n < 2) return;
    ctx.moveTo(rawPts[0].x, rawPts[0].y);
    if (n === 2) {
        ctx.lineTo(rawPts[1].x, rawPts[1].y);
        return;
    }
    const segments = closed ? n : n - 1;
    for (let i = 0; i < segments; i++) {
        const p0 = closed ? rawPts[(i - 1 + n) % n] : (i > 0 ? rawPts[i - 1] : rawPts[i]);
        const p1 = rawPts[i];
        const p2 = rawPts[(i + 1) % n];
        const p3 = closed ? rawPts[(i + 2) % n] : (i < n - 2 ? rawPts[i + 2] : rawPts[i + 1]);
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
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
        drawCatmullRomPath(ctx, rawPts, shape.closed === true);
        ctx.closePath();
        ctx.fillStyle = shape.color;
        ctx.fill();
        ctx.restore();
        return;
    }

    // 实线 + 有箭头：绘制正经矢量箭头（单路径填充）
    if (lineStyle === "solid" && headSize > 0) {
        if (shape.closed) {
            // 闭合曲线：无箭头，直接描边
            ctx.save();
            ctx.globalAlpha = shape.opacity;
            ctx.strokeStyle = shape.color;
            ctx.lineWidth = shape.lineWidth;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            drawCatmullRomPath(ctx, rawPts, true);
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
            return;
        }
        drawBezierArrowShape(ctx, shape, rawPts);
        return;
    }

    // 其他线型（虚线/圆点）或无箭头：描边方式
    ctx.save();
    ctx.globalAlpha = shape.opacity;
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.lineWidth;

    applyLineDash(ctx, lineStyle, shape.lineWidth, shape.dashGap);
    ctx.beginPath();
    drawCatmullRomPath(ctx, rawPts, shape.closed === true);
    if (shape.closed) ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // 箭头头部：描边模式下单独绘制填充三角形（闭合曲线不画箭头）
    if (!shape.closed && headSize > 0 && rawPts.length >= 2) {
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
// 手绘形状（自由绘制 + 路径平滑）
// ============================================================================

// 收集原始点期间，只保留距离上一个点 >= minDist 的点，减少抖动
function collectFreehandPoint(rawPts, pt, minDist) {
    if (rawPts.length === 0) { rawPts.push(pt); return; }
    const last = rawPts[rawPts.length - 1];
    if (Math.hypot(pt.x - last.x, pt.y - last.y) >= minDist) {
        rawPts.push(pt);
    }
}

// Catmull-Rom 插值平滑：对简化后的点生成密集光滑曲线
function smoothFreehandPoints(rawPts) {
    if (rawPts.length < 3) return rawPts;
    const result = [];
    for (let i = 0; i < rawPts.length - 1; i++) {
        const p0 = rawPts[Math.max(0, i - 1)];
        const p1 = rawPts[i];
        const p2 = rawPts[i + 1];
        const p3 = rawPts[Math.min(rawPts.length - 1, i + 2)];
        // 每段插值 8 个点
        for (let t = 0; t < 1; t += 0.125) {
            const tt = t * t;
            const ttt = tt * t;
            const x = 0.5 * (
                2 * p1.x +
                (-p0.x + p2.x) * t +
                (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * tt +
                (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * ttt
            );
            const y = 0.5 * (
                2 * p1.y +
                (-p0.y + p2.y) * t +
                (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * tt +
                (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * ttt
            );
            result.push({ x, y });
        }
    }
    result.push(rawPts[rawPts.length - 1]);
    return result;
}

// 绘制手绘形状（使用 Catmull-Rom 插值平滑描边）
function drawFreehandShape(ctx, shape, mode) {
    const pts = shape.points || [];
    if (pts.length < 2) return;
    const lineStyle = shape.lineStyle || "solid";
    ctx.save();
    ctx.globalAlpha = shape.opacity;
    if (mode === "fill") {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
            const p0 = i > 0 ? pts[i - 1] : pts[i];
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const p3 = i < pts.length - 2 ? pts[i + 2] : pts[i + 1];
            const cp1x = p1.x + (p2.x - p0.x) / 6;
            const cp1y = p1.y + (p2.y - p0.y) / 6;
            const cp2x = p2.x - (p3.x - p1.x) / 6;
            const cp2y = p2.y - (p3.y - p1.y) / 6;
            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
        }
        ctx.closePath();
        ctx.fillStyle = shape.color;
        ctx.fill();
    } else {
        ctx.strokeStyle = shape.color;
        ctx.lineWidth = shape.lineWidth;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        applyLineDash(ctx, lineStyle, shape.lineWidth, shape.dashGap);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
            const p0 = i > 0 ? pts[i - 1] : pts[i];
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const p3 = i < pts.length - 2 ? pts[i + 2] : pts[i + 1];
            const cp1x = p1.x + (p2.x - p0.x) / 6;
            const cp1y = p1.y + (p2.y - p0.y) / 6;
            const cp2x = p2.x - (p3.x - p1.x) / 6;
            const cp2y = p2.y - (p3.y - p1.y) / 6;
            ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
        }
        ctx.stroke();
    }
    ctx.restore();
}

// ============================================================================
// 线型工具
// ============================================================================

// 设置线型 dash 模式（实线/虚线/圆点虚线）。实线由 drawBezierArrowShape 处理。
function applyLineDash(ctx, lineStyle, lineWidth, dashGap) {
    const lw = Math.max(1, lineWidth || 1);
    const gap = (dashGap !== undefined ? dashGap : (arrowSettings.dashGap || 2)) * lw;
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
    if (type === "freehand" && shape.points && shape.points.length >= 2) {
        return shape.points;
    }
    if (type === "bezier") {
        const pts = getBezierPoints(shape);
        if (pts.length >= 2) {
            return getBezierSamplePoints(pts, 12, shape.closed === true);
        }
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
        const N = 256; // total sample points
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
            applyLineDash(ctx, lineStyle, lw, arrow.dashGap);
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(ex, ey);
            ctx.stroke();
            // 填充三角形覆盖末端，形成箭头（重置 dash 避免影响填充）
            ctx.setLineDash([]);
            drawArrowHead(ctx, ex, ey, dx, dy, headLen, arrow.color, arrow.opacity);
        } else {
            // 无头部：整段描边
            applyLineDash(ctx, lineStyle, lw, arrow.dashGap);
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
    const rot = shape.rotation || 0;

    ctx.save();
    ctx.globalAlpha = shape.opacity;
    if (rot !== 0) {
        const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
        ctx.translate(cx, cy);
        ctx.rotate(rot * Math.PI / 180);
        ctx.translate(-cx, -cy);
    }

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
        applyLineDash(ctx, lineStyle, shape.lineWidth, shape.dashGap);
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
    const rot = shape.rotation || 0;

    ctx.save();
    ctx.globalAlpha = shape.opacity;
    if (rot !== 0) {
        ctx.translate(cx, cy);
        ctx.rotate(rot * Math.PI / 180);
        ctx.translate(-cx, -cy);
    }

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
        applyLineDash(ctx, lineStyle, shape.lineWidth, shape.dashGap);
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
    const rot = shape.rotation || 0;

    ctx.save();
    ctx.globalAlpha = shape.opacity;
    if (rot !== 0) {
        ctx.translate(cx, cy);
        ctx.rotate(rot * Math.PI / 180);
        ctx.translate(-cx, -cy);
    }

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
        applyLineDash(ctx, lineStyle, shape.lineWidth, shape.dashGap);
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

// 使用 Canvas 矢量命令绘制形状路径（圆角处用 arcTo，避免 lineTo 采样导致的锯齿）
// 内部使用 Path2D 缓存，形状不变时复用路径，避免重复构建
function drawShapeVectorPath(ctx, shape) {
    const rotType = shape.type || "arrow";
    const rot = shape.rotation || 0;
    const needsRot = (rotType === "rectangle" || rotType === "ellipse" || rotType === "circle") && rot !== 0;
    // 尝试使用缓存的 Path2D
    const cacheKey = getShapePathCacheKey(shape);
    if (shape._vectorPath2d && shape._vectorPathKey === cacheKey) {
        if (needsRot) {
            const cx = (shape.start.x + shape.end.x) / 2;
            const cy = (shape.start.y + shape.end.y) / 2;
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(rot * Math.PI / 180);
            ctx.translate(-cx, -cy);
            ctx.stroke(shape._vectorPath2d);
            ctx.restore();
        } else {
            ctx.stroke(shape._vectorPath2d);
        }
        return;
    }
    const path = new Path2D();
    const type = shape.type || "arrow";
    const sx = shape.start.x, sy = shape.start.y;
    const ex = shape.end.x, ey = shape.end.y;
    if (type === "arrow") {
        const headLen = shape.arrowSize || 0;
        if (headLen <= 0) { path.moveTo(sx, sy); path.lineTo(ex, ey); }
        else {
            const dx = ex - sx, dy = ey - sy;
            const len = Math.hypot(dx, dy);
            if (len < 1) { path.moveTo(sx, sy); path.lineTo(ex, ey); }
            else {
                const nx = dx / len, ny = dy / len;
                path.moveTo(sx, sy);
                path.lineTo(ex - nx * headLen, ey - ny * headLen);
            }
        }
    } else if (type === "rectangle") {
        const left = Math.min(sx, ex), right = Math.max(sx, ex);
        const top = Math.min(sy, ey), bottom = Math.max(sy, ey);
        const w = right - left, h = bottom - top;
        const br = Math.min(shape.borderRadius || 0, Math.min(w, h) / 2);
        if (br <= 0) {
            path.moveTo(left, top); path.lineTo(right, top);
            path.lineTo(right, bottom); path.lineTo(left, bottom);
            path.closePath();
        } else {
            path.moveTo(left + br, top);
            path.lineTo(right - br, top);
            path.arcTo(right, top, right, top + br, br);
            path.lineTo(right, bottom - br);
            path.arcTo(right, bottom, right - br, bottom, br);
            path.lineTo(left + br, bottom);
            path.arcTo(left, bottom, left, bottom - br, br);
            path.lineTo(left, top + br);
            path.arcTo(left, top, left + br, top, br);
            path.closePath();
        }
    } else if (type === "ellipse" || type === "circle") {
        const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
        if (type === "circle") {
            const r = Math.max(Math.abs(ex - sx), Math.abs(ey - sy)) / 2;
            path.ellipse(cx, cy, r, r, 0, 0, Math.PI * 2);
        } else {
            const rx = Math.max(Math.abs(ex - sx) / 2, 0.1);
            const ry = Math.max(Math.abs(ey - sy) / 2, 0.1);
            path.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        }
    } else if (type === "bezier") {
        const pts = getBezierPoints(shape);
        if (pts.length >= 2) {
            const samples = getBezierSamplePoints(pts, 12, shape.closed === true);
            path.moveTo(samples[0].x, samples[0].y);
            for (let i = 1; i < samples.length; i++) path.lineTo(samples[i].x, samples[i].y);
            if (shape.closed) path.closePath();
        }
    } else if (type === "freehand") {
        const pts = shape.points || [];
        if (pts.length >= 2) {
            path.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
        }
    } else {
        // 兜底：使用采样点
        const fallbackPts = getAnimPathPoints(shape);
        path.moveTo(fallbackPts[0].x, fallbackPts[0].y);
        for (let i = 1; i < fallbackPts.length; i++) path.lineTo(fallbackPts[i].x, fallbackPts[i].y);
    }
    // 缓存 Path2D
    shape._vectorPath2d = path;
    shape._vectorPathKey = cacheKey;
    // 矩形/椭圆/圆形：应用旋转变换后描边
    if (needsRot) {
        const cx = (shape.start.x + shape.end.x) / 2;
        const cy = (shape.start.y + shape.end.y) / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rot * Math.PI / 180);
        ctx.translate(-cx, -cy);
        ctx.stroke(path);
        ctx.restore();
    } else {
        ctx.stroke(path);
    }
}

function getShapePathCacheKey(shape) {
    const type = shape.type || "arrow";
    const sx = shape.start.x, sy = shape.start.y;
    const ex = shape.end.x, ey = shape.end.y;
    const br = shape.borderRadius || 0;
    const headLen = shape.arrowSize || 0;
    if (type === "freehand") {
        const pts = shape.points || [];
        const ptHash = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('|');
        return `${type}|${pts.length}|${ptHash}`;
    }
    if (type === "bezier") {
        const pts = shape.points || [];
        const ptHash = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('|');
        return `${type}|${pts.length}|${!!shape.closed}|${ptHash}`;
    }
    const rot = shape.rotation || 0;
    return `${type}|${sx.toFixed(1)}|${sy.toFixed(1)}|${ex.toFixed(1)}|${ey.toFixed(1)}|${br}|${headLen}|${rot.toFixed(1)}`;
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
    const sizeRatio = shape.animSize !== undefined ? 0.1 + (shape.animSize / 100) * 4.9 : 1;
    const t = performance.now();
    switch (animType) {
        case "sparkle":   drawAnimSparkle(ctx, pts, speed, t, count, sizeRatio); break;
        case "energy":    drawAnimEnergy(ctx, shape, speed, t, sizeRatio); break;
        case "transfer":  drawAnimTransfer(ctx, pts, speed, t, count, sizeRatio); break;
        case "stellar":   drawAnimStellar(ctx, pts, speed, t, count, sizeRatio); break;
        case "diy1":      drawAnimGoldFlow(ctx, pts, speed, t, count, sizeRatio); break;
        case "crystal":   drawAnimCrystal(ctx, pts, speed, t, count, sizeRatio); break;
        case "quantum":   drawAnimQuantum(ctx, pts, speed, t, count, sizeRatio); break;
        case "lava":      drawAnimLava(ctx, pts, speed, t, count, sizeRatio); break;
        case "randspark": drawAnimRandSpark(ctx, pts, speed, t, count, sizeRatio); break;
        case "pulse":     drawAnimPulse(ctx, pts, speed, t, sizeRatio); break;
        case "comet":     drawAnimComet(ctx, pts, speed, t, count, sizeRatio); break;
        case "pacman":    drawAnimPacman(ctx, shape, pts, rawSpeed, t, sizeRatio); break;
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
function drawAnimSparkle(ctx, pts, speed, t, count, sizeRatio) {
    const rainbowColors = ['#FF6B6B', '#FFA94D', '#FFE066', '#69DB7C', '#339AF0', '#F06595'];
    count = Math.max(1, count || 5);
    const sp = 0.00025 * speed;
    const baseOffset = (t * sp) % 1;
    const brightPulse = 0.5 + 0.5 * Math.sin(t * 0.0025 * speed);
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = (baseOffset + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        const color = rainbowColors[i % rainbowColors.length];
        const pulse = 0.7 + 0.3 * Math.sin(t * 0.004 + i * 1.2);
        const size = 11 * pulse * sizeRatio;
        const rotation = t * 0.001 + i * 0.5;
        ctx.globalAlpha = 0.5 + brightPulse * 0.5;
        _drawStarburst(ctx, p.x, p.y, color, size, rotation);
        ctx.globalAlpha = 1;
    }
    ctx.restore();
}

// 2. 能量脉冲（七彩变色 + 明暗变化，沿整体路径描边，使用矢量绘制避免圆角锯齿）
// drawShapeVectorPath 内部使用 Path2D 缓存，第二次调用直接复用缓存路径
function drawAnimEnergy(ctx, shape, speed, t, sizeRatio) {
    const sp = 0.002 * speed;
    const pulse = 0.5 + 0.5 * Math.sin(t * sp);
    const hue = (t * 0.05) % 360;
    ctx.save();
    // 外层七彩
    ctx.strokeStyle = `hsla(${hue}, 100%, 60%, ${0.2 + pulse * 0.3})`;
    ctx.lineWidth = 6 * sizeRatio;
    ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
    ctx.shadowBlur = (15 + pulse * 10) * sizeRatio;
    drawShapeVectorPath(ctx, shape);
    // 核心白色（复用缓存的 Path2D）
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.4 + pulse * 0.5})`;
    ctx.lineWidth = 1.5 * sizeRatio;
    ctx.shadowColor = `hsl(${hue}, 100%, 70%)`;
    ctx.shadowBlur = 4 * sizeRatio;
    drawShapeVectorPath(ctx, shape);
    ctx.restore();
}

// 3. 高速穿梭光点（带拖尾）
function drawAnimTransfer(ctx, pts, speed, t, count, sizeRatio) {
    const sp = 0.0012 * speed;
    count = Math.max(1, count || 3);
    const brightPulse = 0.5 + 0.5 * Math.sin(t * 0.0025 * speed);
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * sp) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        // 拖尾
        for (let j = 0; j < 8; j++) {
            const tt = Math.max(0, tVal - j * 0.02);
            const tp = getPointAlongPath(pts, tt);
            const alpha = (1 - j / 8) * 0.5 * (0.5 + brightPulse * 0.5);
            const sz = (1 - j / 8) * 4 * sizeRatio;
            ctx.beginPath();
            ctx.arc(tp.x, tp.y, Math.max(0.5, sz), 0, Math.PI * 2);
            ctx.fillStyle = `rgba(120, 220, 255, ${alpha})`;
            ctx.shadowColor = '#74C0FC';
            ctx.shadowBlur = 6 * sizeRatio;
            ctx.fill();
        }
        // 头部
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 * sizeRatio, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${0.5 + brightPulse * 0.5})`;
        ctx.shadowColor = '#74C0FC';
        ctx.shadowBlur = 20 * sizeRatio;
        ctx.fill();
    }
    ctx.restore();
}

// 4. 恒星等离子（高亮星点拖尾）
function drawAnimStellar(ctx, pts, speed, t, count, sizeRatio) {
    const sp = 0.00035 * speed;
    count = Math.max(1, count || 5);
    const brightPulse = 0.5 + 0.5 * Math.sin(t * 0.0025 * speed);
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * sp) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        const trailLen = 5;
        for (let j = 0; j < trailLen; j++) {
            const tt = Math.max(0, tVal - j * 0.015);
            const tp = getPointAlongPath(pts, tt);
            const alpha = (1 - j / trailLen) * 0.4 * (0.5 + brightPulse * 0.5);
            const sz = ((1 - j / trailLen) * 3 + 1) * sizeRatio;
            ctx.beginPath();
            ctx.arc(tp.x, tp.y, sz, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(180, 220, 255, ${alpha})`;
            ctx.shadowColor = '#A5D8FF';
            ctx.shadowBlur = 8 * sizeRatio;
            ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 * sizeRatio, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${0.5 + brightPulse * 0.5})`;
        ctx.shadowColor = '#74C0FC';
        ctx.shadowBlur = 15 * sizeRatio;
        ctx.fill();
    }
    ctx.restore();
}

// 5. 金星流动（金色圆形粒子 + 长拖尾）
function drawAnimGoldFlow(ctx, pts, speed, t, count, sizeRatio) {
    const sp = 0.0003 * speed;
    count = Math.max(1, count || 4);
    const brightPulse = 0.5 + 0.5 * Math.sin(t * 0.0025 * speed);
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * sp) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        for (let j = 0; j < 12; j++) {
            const tt = Math.max(0, tVal - j * 0.012);
            const tp = getPointAlongPath(pts, tt);
            const alpha = (1 - j / 12) * 0.4 * (0.5 + brightPulse * 0.5);
            const sz = ((1 - j / 12) * 4 + 0.5) * sizeRatio;
            ctx.beginPath();
            ctx.arc(tp.x, tp.y, sz, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 215, 0, ${alpha})`;
            ctx.shadowColor = '#FFD700';
            ctx.shadowBlur = 8 * sizeRatio;
            ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 * sizeRatio, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 248, 220, ${0.5 + brightPulse * 0.5})`;
        ctx.shadowColor = '#FFD700';
        ctx.shadowBlur = 18 * sizeRatio;
        ctx.fill();
    }
    ctx.restore();
}

// 6. 水晶溪流（透明方块粒子、渐变发光质感）
function drawAnimCrystal(ctx, pts, speed, t, count, sizeRatio) {
    const sp = 0.00025 * speed;
    count = Math.max(1, count || 7);
    const brightPulse = 0.5 + 0.5 * Math.sin(t * 0.0025 * speed);
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * sp) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        const size = 5 * sizeRatio;
        const rot = t * 0.001 + i;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(rot);
        const grad = ctx.createLinearGradient(-size, -size, size, size);
        grad.addColorStop(0, `rgba(100, 200, 255, ${0.4 + brightPulse * 0.4})`);
        grad.addColorStop(0.5, `rgba(200, 240, 255, ${0.2 + brightPulse * 0.2})`);
        grad.addColorStop(1, `rgba(100, 200, 255, ${0.4 + brightPulse * 0.4})`);
        ctx.fillStyle = grad;
        ctx.shadowColor = '#74C0FC';
        ctx.shadowBlur = 10 * sizeRatio;
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
function drawAnimQuantum(ctx, pts, speed, t, count, sizeRatio) {
    const sp = 0.0004 * speed;
    count = Math.max(1, count || 14);
    const brightPulse = 0.5 + 0.5 * Math.sin(t * 0.0025 * speed);
    const seed = Math.floor(t / 80);
    const rng = (i) => { const x = Math.sin(seed * 99.7 + i * 31.3) * 43758.5453; return x - Math.floor(x); };
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * sp * (0.5 + rng(i) * 0.8)) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        const jitter = 4 * sizeRatio;
        const jx = (rng(i * 2 + 1) - 0.5) * jitter;
        const jy = (rng(i * 2 + 2) - 0.5) * jitter;
        const size = (1 + rng(i * 3 + 5) * 2) * sizeRatio;
        const color = ['#74C0FC', '#A5D8FF', '#E7F5FF', '#4DABF7'][i % 4];
        ctx.beginPath();
        ctx.arc(p.x + jx, p.y + jy, size, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 6 * sizeRatio;
        ctx.globalAlpha = (0.4 + rng(i * 7) * 0.6) * (0.5 + brightPulse * 0.5);
        ctx.fill();
    }
    ctx.restore();
}

// 8. 熔岩流（橙红渐变块状粒子）
function drawAnimLava(ctx, pts, speed, t, count, sizeRatio) {
    const sp = 0.0002 * speed;
    count = Math.max(1, count || 6);
    const brightPulse = 0.5 + 0.5 * Math.sin(t * 0.0025 * speed);
    ctx.save();
    for (let i = 0; i < count; i++) {
        const tVal = ((t * sp) + i / count) % 1;
        const p = getPointAlongPath(pts, tVal);
        const size = (4 + Math.sin(t * 0.003 + i) * 1.5) * sizeRatio;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size * 2);
        grad.addColorStop(0, `rgba(255, 220, 100, ${0.45 + brightPulse * 0.45})`);
        grad.addColorStop(0.4, `rgba(255, 140, 50, ${0.3 + brightPulse * 0.3})`);
        grad.addColorStop(1, 'rgba(200, 50, 0, 0)');
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 2, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.shadowColor = '#FF6B35';
        ctx.shadowBlur = 12 * sizeRatio;
        ctx.fill();
    }
    ctx.restore();
}

// 9. 随机闪烁星芒
function drawAnimRandSpark(ctx, pts, speed, t, count, sizeRatio) {
    const sp = 0.001 * speed;
    count = Math.max(1, count || 10);
    const brightPulse = 0.5 + 0.5 * Math.sin(t * 0.0025 * speed);
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
        const sz = (4 + rng(i * 5 + 3) * 5) * sizeRatio;
        const color = colors[Math.floor(rng(i * 7 + 9) * colors.length)];
        const rotation = rng(i * 11) * Math.PI * 2 + t * 0.001;
        ctx.globalAlpha = alpha * (0.5 + brightPulse * 0.5);
        _drawStarburst(ctx, p.x, p.y, color, sz, rotation);
        ctx.globalAlpha = 1;
    }
    ctx.restore();
}

// 10. 脉冲（整体路径呼吸发光）
function drawAnimPulse(ctx, pts, speed, t, sizeRatio) {
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
    ctx.lineWidth = (8 + pulse * 6) * sizeRatio;
    ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
    ctx.shadowBlur = (25 + pulse * 15) * sizeRatio;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.3 + pulse * 0.4})`;
    ctx.lineWidth = 2 * sizeRatio;
    ctx.shadowBlur = (12 + pulse * 8) * sizeRatio;
    ctx.stroke();
    ctx.restore();
}

// 11. 流星彗星（沿路径飞行的光点 + 拖尾 + 色变 + 粒子 + 大小脉动 + 明暗变化）
function drawAnimComet(ctx, pts, speed, t, count, sizeRatio) {
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
        const coreSize = Math.max(1.2, 3.5 * pulse) * sizeRatio;
        const haloSize = Math.max(3, 9 * pulse) * sizeRatio;
        const tailLen = 30 * (0.6 + pulse * 0.4) * sizeRatio;
        const tailWidth = 3.5 * sizeRatio;

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
        ctx.shadowBlur = 12 * sizeRatio;
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
            const psize = ((1 - tt) * 1.8 + 0.4) * sizeRatio;
            const palpha = (1 - tt) * 0.65 * (0.4 + 0.6 * Math.sin(t * fastSp * 4 + j + hueBase));
            if (palpha <= 0.02) continue;
            ctx.fillStyle = `hsla(${hue}, 95%, 82%, ${palpha})`;
            ctx.shadowColor = starColor;
            ctx.shadowBlur = 6 * sizeRatio;
            ctx.beginPath();
            ctx.arc(ppx, ppy, psize, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.shadowBlur = 0;

        // === 4. 星核（白色亮点，大小+明暗脉动） ===
        ctx.fillStyle = '#FFFFFF';
        ctx.shadowColor = starColor;
        ctx.shadowBlur = 12 * sizeRatio;
        ctx.globalAlpha = brightness;
        ctx.beginPath();
        ctx.arc(p.x, p.y, coreSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
    }
    ctx.restore();
}

// 12. 吃豆人（沿路径移动的吃豆人 + 豆子，隐藏被吃掉的豆子）
function drawAnimPacman(ctx, shape, pts, speed, t, sizeRatio) {
    if (pts.length < 2) return;
    // 计算路径总长度
    let pathLen = 0;
    for (let i = 0; i < pts.length - 1; i++) {
        pathLen += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    }
    if (pathLen < 1e-6) return;
    // 固定像素速度：speed 映射为 10-200 px/s，不受路径长度影响
    const pxPerSec = 10 + (speed / 100) * 190;
    const dist = (t / 1000) * pxPerSec;
    const progress = ((dist % pathLen) + pathLen) % pathLen / pathLen;

    // 获取路径上的点
    const p = getPointAlongPath(pts, progress);
    const angle = p.angle || 0;

    // 大小：使用 pacmanSize（独立于通用 animSize），豆子与之固定比例
    const pacSize = shape.pacmanSize !== undefined ? shape.pacmanSize : 50;
    // 0.1x at 0, 1x at 50, 10x at 100
    const pacMultiplier = Math.pow(10, (pacSize - 50) / 50);
    const pacRadius = 14 * pacMultiplier;

    // 豆子数量（从形状参数读取，默认8）
    const requestedDots = Math.max(1, shape.pacmanDots || 8);

    ctx.save();

    // === 绘制豆子（沿路径均匀分布，被吃豆人吃掉的隐藏） ===
    const dotRatio = (shape.pacmanDotRatio !== undefined ? shape.pacmanDotRatio : 30) / 100;
    const dotRadius = pacRadius * dotRatio;
    // 确保豆子间距至少 5 个豆子直径（pathLen 已在上方计算）
    const minSpacing = 10 * dotRadius; // 5 个豆子直径
    const maxDotsBySpacing = minSpacing > 0 ? Math.floor(pathLen / minSpacing) : requestedDots;
    const dotCount = Math.max(1, Math.min(requestedDots, maxDotsBySpacing));
    for (let i = 0; i < dotCount; i++) {
        const dotT = (i + 0.5) / dotCount;
        // 吃豆人进度之前的豆子隐藏（被吃掉）
        if (dotT < progress) continue;
        const dp = getPointAlongPath(pts, dotT);
        ctx.beginPath();
        ctx.arc(dp.x, dp.y, dotRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#FFEE88';
        ctx.shadowBlur = 0;
        ctx.fill();
    }

    // === 绘制吃豆人 ===
    const mouthOpen = (Math.sin(t * 0.012) * 0.5 + 0.5) * 0.6 + 0.1;
    const eyeRadius = pacRadius * 0.22;

    ctx.translate(p.x, p.y);
    ctx.rotate(angle);

    // 身体（黄色圆弧）
    ctx.beginPath();
    ctx.arc(0, 0, pacRadius, mouthOpen, Math.PI * 2 - mouthOpen);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fillStyle = '#FFEE00';
    ctx.shadowColor = '#FFEE00';
    ctx.shadowBlur = 10 * sizeRatio;
    ctx.fill();

    // 眼睛（黑色圆点）
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(0, -pacRadius * 0.45, eyeRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#222';
    ctx.fill();

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
                const samples = getBezierSamplePoints(pts, 12, a.closed === true);
                let minDist = Infinity;
                for (let s = 0; s < samples.length - 1; s++) {
                    const d = distanceToSegment(canvasX, canvasY, samples[s].x, samples[s].y, samples[s+1].x, samples[s+1].y);
                    if (d < minDist) minDist = d;
                }
                if (minDist <= threshold) return i;
            }
        } else if (type === "freehand") {
            // 手绘：检测到平滑后点的距离
            const pts = a.points || [];
            if (pts.length >= 2) {
                let minDist = Infinity;
                for (let s = 0; s < pts.length - 1; s++) {
                    const d = distanceToSegment(canvasX, canvasY, pts[s].x, pts[s].y, pts[s+1].x, pts[s+1].y);
                    if (d < minDist) minDist = d;
                }
                if (minDist <= threshold) return i;
            }
        } else {
            // 矩形/椭圆/圆形：检测点是否在形状内部（带边框阈值）
            const sx = a.start.x, sy = a.start.y, ex = a.end.x, ey = a.end.y;
            // 旋转变换：将点击坐标转换到形状的本地坐标系
            let lx = canvasX, ly = canvasY;
            const rot = a.rotation || 0;
            if (rot !== 0) {
                const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
                const angle = -rot * Math.PI / 180;
                const cos = Math.cos(angle), sin = Math.sin(angle);
                const dx = canvasX - cx, dy = canvasY - cy;
                lx = cx + dx * cos - dy * sin;
                ly = cy + dx * sin + dy * cos;
            }
            const minX = Math.min(sx, ex) - threshold, minY = Math.min(sy, ey) - threshold;
            const maxX = Math.max(sx, ex) + threshold, maxY = Math.max(sy, ey) + threshold;
            // 先在包围盒范围内检测
            if (lx >= minX && lx <= maxX && ly >= minY && ly <= maxY) {
                const left = Math.min(sx, ex), right = Math.max(sx, ex);
                const top = Math.min(sy, ey), bottom = Math.max(sy, ey);
                const w = right - left, h = bottom - top;
                const cx = (left + right) / 2, cy = (top + bottom) / 2;
                if (a.mode === "fill") {
                    if (type === "rectangle") {
                        const br = Math.min(a.borderRadius || 0, Math.min(w, h) / 2);
                        if (br > 0) {
                            // 圆角矩形：使用 SDF 检测点是否在内部
                            if (sdRoundedRect(lx, ly, cx, cy, w / 2, h / 2, br) <= 0) return i;
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
                        const sd = sdRoundedRect(lx, ly, cx, cy, w / 2, h / 2, br);
                        if (Math.abs(sd) <= threshold) return i;
                    } else if (type === "ellipse" || type === "circle") {
                        const r = type === "circle" ? Math.max(rx, ry) : 1;
                        const rxActual = type === "circle" ? r : rx;
                        const ryActual = type === "circle" ? r : ry;
                        const dx = (lx - cx) / rxActual;
                        const dy = (ly - cy) / ryActual;
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

// 整体偏移形状的所有点
function _offsetShape(shape, dx, dy) {
    if (shape.start) { shape.start.x += dx; shape.start.y += dy; }
    if (shape.end) { shape.end.x += dx; shape.end.y += dy; }
    if (shape.points) {
        for (const p of shape.points) { p.x += dx; p.y += dy; }
    }
}

// 旋转形状的所有点（绕中心点旋转 deltaDeg 度）
// 矩形/椭圆/圆形：不旋转坐标点，旋转通过渲染时 canvas 变换实现
function _rotateShape(shape, cx, cy, deltaDeg) {
    const type = shape.type || "arrow";
    if (type === "rectangle" || type === "ellipse" || type === "circle") return;
    const delta = deltaDeg * Math.PI / 180;
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    if (shape.points) {
        for (const p of shape.points) {
            const px = p.x - cx;
            const py = p.y - cy;
            p.x = cx + px * cos - py * sin;
            p.y = cy + px * sin + py * cos;
        }
    }
    if (shape.start) {
        const sx = shape.start.x - cx;
        const sy = shape.start.y - cy;
        shape.start.x = cx + sx * cos - sy * sin;
        shape.start.y = cy + sx * sin + sy * cos;
    }
    if (shape.end) {
        const ex = shape.end.x - cx;
        const ey = shape.end.y - cy;
        shape.end.x = cx + ex * cos - ey * sin;
        shape.end.y = cy + ex * sin + ey * cos;
    }
    if (shape.control) {
        const px = shape.control.x - cx;
        const py = shape.control.y - cy;
        shape.control.x = cx + px * cos - py * sin;
        shape.control.y = cy + px * sin + py * cos;
    }
}

// 计算形状的中心点坐标
function _getShapeCenter(shape) {
    const type = shape.type || "arrow";
    if (type === "freehand" || type === "bezier") {
        const pts = shape.points || [];
        if (pts.length === 0) {
            return { x: (shape.start.x + shape.end.x) / 2, y: (shape.start.y + shape.end.y) / 2 };
        }
        let sx = 0, sy = 0;
        for (const p of pts) { sx += p.x; sy += p.y; }
        return { x: sx / pts.length, y: sy / pts.length };
    }
    // arrow, rectangle, ellipse, circle：使用 start/end 中点
    return { x: (shape.start.x + shape.end.x) / 2, y: (shape.start.y + shape.end.y) / 2 };
}

// 检测点击是否命中箭头的端点（首/尾），用于拖拽调整
// 返回 { arrowIndex, point: 'start'|'end', pointIndex?: number } 或 null
// 手绘、椭圆、圆形不支持端点拖拽
// 贝塞尔曲线支持所有控制点拖拽（pointIndex 为 points 数组索引）
function hitTestEndpoint(canvasX, canvasY) {
    if (!hasSelection()) return null;
    const threshold = 15;
    const selIndices = getSelectedIndices();

    for (const selIdx of selIndices) {
        if (selIdx < 0 || selIdx >= arrows.length) continue;
        const arrow = arrows[selIdx];
        const type = arrow.type || "arrow";
        if (type === "freehand") continue;

        // 圆形：只检测右侧手柄
        if (type === "circle") {
            const cx = (arrow.start.x + arrow.end.x) / 2;
            const cy = (arrow.start.y + arrow.end.y) / 2;
            const r = Math.max(Math.abs(arrow.end.x - arrow.start.x), Math.abs(arrow.end.y - arrow.start.y)) / 2;
            const hx = cx + r;
            const hy = cy;
            const dist = Math.hypot(canvasX - hx, canvasY - hy);
            if (dist <= threshold) return { arrowIndex: selIdx, point: 'radius' };
            continue;
        }

        // 椭圆：检测右侧（rx）和下侧（ry）手柄
        if (type === "ellipse") {
            const cx = (arrow.start.x + arrow.end.x) / 2;
            const cy = (arrow.start.y + arrow.end.y) / 2;
            const rx = Math.max(Math.abs(arrow.end.x - arrow.start.x) / 2, 0.1);
            const ry = Math.max(Math.abs(arrow.end.y - arrow.start.y) / 2, 0.1);
            const rot = arrow.rotation || 0;
            const cos = Math.cos(rot * Math.PI / 180), sin = Math.sin(rot * Math.PI / 180);
            // 右侧手柄
            const rhx = cx + rx * cos;
            const rhy = cy + rx * sin;
            if (Math.hypot(canvasX - rhx, canvasY - rhy) <= threshold) {
                return { arrowIndex: selIdx, point: 'rx' };
            }
            // 下侧手柄
            const bhx = cx - ry * sin;
            const bhy = cy + ry * cos;
            if (Math.hypot(canvasX - bhx, canvasY - bhy) <= threshold) {
                return { arrowIndex: selIdx, point: 'ry' };
            }
            continue;
        }

        // 贝塞尔曲线：检测所有控制点
        if (type === "bezier" && arrow.points && arrow.points.length > 0) {
            for (let i = 0; i < arrow.points.length; i++) {
                const p = arrow.points[i];
                const dist = Math.hypot(canvasX - p.x, canvasY - p.y);
                if (dist <= threshold) {
                    return { arrowIndex: selIdx, point: i === 0 ? 'start' : (i === arrow.points.length - 1 ? 'end' : 'control'), pointIndex: i };
                }
            }
            continue;
        }

        // 矩形：端点未旋转，需要逆旋转点击坐标后再检测
        let lx = canvasX, ly = canvasY;
        if (type === "rectangle" && arrow.rotation) {
            const rot = arrow.rotation * Math.PI / 180;
            const cos = Math.cos(-rot), sin = Math.sin(-rot);
            const cx = (arrow.start.x + arrow.end.x) / 2;
            const cy = (arrow.start.y + arrow.end.y) / 2;
            const dx = canvasX - cx, dy = canvasY - cy;
            lx = cx + dx * cos - dy * sin;
            ly = cy + dx * sin + dy * cos;
        }

        // 检查起始点
        if (arrow.start) {
            const dist = Math.hypot(lx - arrow.start.x, ly - arrow.start.y);
            if (dist <= threshold) return { arrowIndex: selIdx, point: 'start' };
        }
        // 检查结束点
        if (arrow.end) {
            const dist = Math.hypot(lx - arrow.end.x, ly - arrow.end.y);
            if (dist <= threshold) return { arrowIndex: selIdx, point: 'end' };
        }
    }
    return null;
}

// 检测点击是否命中形状的中心拖动手柄（菱形）
function hitTestShapeCenter(canvasX, canvasY) {
    if (!hasSelection()) return null;
    const threshold = 12;
    const selIndices = getSelectedIndices();

    for (const selIdx of selIndices) {
        if (selIdx < 0 || selIdx >= arrows.length) continue;
        const arrow = arrows[selIdx];
        const center = _getShapeCenter(arrow);
        const dist = Math.hypot(canvasX - center.x, canvasY - center.y);
        if (dist <= threshold) return { arrowIndex: selIdx, centerX: center.x, centerY: center.y };
    }
    return null;
}

// 检测点击是否命中旋转手柄（中心上方的小圆）
function hitTestRotationHandle(canvasX, canvasY) {
    const selIdx = getFirstSelectedIndex();
    if (selIdx < 0 || selIdx >= arrows.length) return null;
    const threshold = 10;
    const arrow = arrows[selIdx];
    const center = _getShapeCenter(arrow);
    const rotDist = 30;
    const rot = arrow.rotation || 0;
    let hx = center.x;
    let hy = center.y - rotDist;
    // 手柄跟着旋转，计算旋转后的位置
    if (rot !== 0) {
        const angle = rot * Math.PI / 180;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const dy = -rotDist;
        hx = center.x + dy * sin;
        hy = center.y + dy * cos;
    }
    const dist = Math.hypot(canvasX - hx, canvasY - hy);
    if (dist <= threshold) return { arrowIndex: selIdx, centerX: center.x, centerY: center.y };
    return null;
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
        const isSel = isSelected(i) && !_hideSelectionHighlight;
        drawShape(ctx, arrows[i], isSel);
    }

    // 绘制当前正在绘制的形状
    if (isDrawing && currentArrow && currentArrow.start && currentArrow.end) {
        drawShape(ctx, currentArrow);
    }

    // 绘制框选矩形
    if (_boxSelecting && _boxSelectRect) {
        ctx.save();
        ctx.strokeStyle = "rgba(102, 153, 255, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.fillStyle = "rgba(102, 153, 255, 0.1)";
        ctx.fillRect(_boxSelectRect.x, _boxSelectRect.y, _boxSelectRect.w, _boxSelectRect.h);
        ctx.strokeRect(_boxSelectRect.x, _boxSelectRect.y, _boxSelectRect.w, _boxSelectRect.h);
        ctx.restore();
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
        bezier: xzgT("曲线", "Curve"),
        freehand: xzgT("手绘", "Freehand")
    };
    const shapeName = shapeNames[arrowSettings.shapeType] || xzgT("箭头", "Arrow");
    // 贝塞尔/手绘：显示当前阶段提示
    let stageText = xzgT("绘制中", "DRAWING");
    if (arrowSettings.shapeType === "bezier") {
        if (bezierDrawStage === 0) stageText = xzgT("点击放置起点", "Click to set start");
        else stageText = xzgT("点击添加点，双击完成", "Click to add, dbl-click to finish");
    } else if (arrowSettings.shapeType === "freehand") {
        stageText = xzgT("拖拽绘制", "Drag to draw");
    }
    const text = `${shapeName}: ${stageText}`;
    const bgColor = "rgba(255, 85, 85, 0.9)";

    ctx.font = "bold 14px -apple-system, BlinkMacSystemFont, sans-serif";
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

    ctx.font = "14px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    const hintText = xzgT("Esc: 退出", "Esc: Exit");
    const hintWidth = ctx.measureText(hintText).width;
    ctx.fillText(hintText, width - hintWidth - 10 - padding, y + 45);

    // 每次渲染后将箭头数据同步到 graph.extra
    syncArrowsToExtra();
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

    // 鼠标滚轮：直接转发到 LiteGraph 画布，确保缩放正常
    canvas.addEventListener("wheel", (e) => {
        if (isArrowModeActive && litegraphCanvas) {
            const newEvent = new WheelEvent("wheel", {
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
            });
            litegraphCanvas.dispatchEvent(newEvent);
        }
    }, { passive: true });

    // 中键按下：穿透覆盖层，让画布平移手势到达 LiteGraph 画布
    overlayElement.addEventListener("pointerdown", (e) => {
        if (isArrowModeActive && e.button === 1) {
            // 设置穿透，后续 pointermove/pointerup 直接到达 LiteGraph 画布
            overlayElement.style.pointerEvents = "none";
            // 手动转发当前 pointerdown 到 LiteGraph 画布（平移起始）
            if (litegraphCanvas) {
                const newEvent = new PointerEvent("pointerdown", {
                    clientX: e.clientX,
                    clientY: e.clientY,
                    screenX: e.screenX,
                    screenY: e.screenY,
                    button: 1,
                    buttons: 4,
                    pointerId: e.pointerId,
                    pointerType: e.pointerType || "mouse",
                    isPrimary: true,
                    width: e.width,
                    height: e.height,
                    pressure: e.pressure,
                    tiltX: e.tiltX,
                    tiltY: e.tiltY,
                    ctrlKey: e.ctrlKey,
                    shiftKey: e.shiftKey,
                    altKey: e.altKey,
                    metaKey: e.metaKey,
                    bubbles: true,
                    cancelable: true
                });
                litegraphCanvas.dispatchEvent(newEvent);
            }
            e.stopPropagation();
            e.preventDefault();
        }
    }, true); // capture 阶段拦截

    // 中键释放：恢复覆盖层事件捕获
    document.addEventListener("pointerup", (e) => {
        if (e.button === 1 && overlayElement) {
            if (isArrowModeActive) {
                overlayElement.style.pointerEvents = "auto";
            } else {
                overlayElement.style.pointerEvents = "none";
            }
        }
    }, true);

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
            // 钝化激活模式下，点击画布不激活面板
            if (arrowSettings.deactivateClickSelect) {
                e.stopImmediatePropagation();
                e.preventDefault();
                return;
            }
            // 激活箭头模式并弹出面板
            isArrowModeActive = true;
            showToolbar();
            showOverlay();
            setPointerEventsMode("auto");
            setCursor("crosshair");
            setSingleSelection(hitIndex);
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
    const ctrlHeld = e.ctrlKey || e.metaKey;

    // 检查是否点击到已有箭头（贝塞尔打点进行中时跳过命中检测，继续打点）
    const hitIndex = (bezierDrawStage > 0) ? -1 : hitTestShape(canvasPos.x, canvasPos.y);
    if (hitIndex >= 0) {
        // Ctrl+点击：切换该形状的选中状态
        if (ctrlHeld) {
            toggleSelection(hitIndex);
            renderArrows();
            updateToolbarState();
            updateTransformSliders();
            updateStyleSliders();
            e.preventDefault();
            return;
        }

        // 如果点击的是已选中形状之一，检查手柄
        if (isSelected(hitIndex)) {
            // 旋转手柄：仅单选时可用
            if (selectedArrowIndices.size === 1) {
                const rotHit = hitTestRotationHandle(canvasPos.x, canvasPos.y);
                if (rotHit) {
                    const startAngle = Math.atan2(canvasPos.y - rotHit.centerY, canvasPos.x - rotHit.centerX);
                    _draggingRotation = {
                        arrowIndex: rotHit.arrowIndex,
                        centerX: rotHit.centerX,
                        centerY: rotHit.centerY,
                        startAngle: startAngle
                    };
                    e.preventDefault();
                    return;
                }
            }
            // 中心手柄：拖拽所有选中的形状
            const centerHit = hitTestShapeCenter(canvasPos.x, canvasPos.y);
            if (centerHit) {
                const selIndices = getSelectedIndices();
                const startCenters = selIndices.map(i => _getShapeCenter(arrows[i]));
                const center = _getShapeCenter(arrows[centerHit.arrowIndex]);
                _draggingShape = {
                    arrowIndices: selIndices,
                    refIndex: centerHit.arrowIndex,
                    offsetX: canvasPos.x - center.x,
                    offsetY: canvasPos.y - center.y,
                    startCenters: startCenters
                };
                e.preventDefault();
                return;
            }
            // 端点手柄：仅拖拽该形状的端点
            const epHit = hitTestEndpoint(canvasPos.x, canvasPos.y);
            if (epHit) {
                const arrow = arrows[epHit.arrowIndex];
                let pt;
                if (epHit.pointIndex !== undefined && arrow.points) {
                    pt = arrow.points[epHit.pointIndex];
                } else {
                    pt = epHit.point === 'start' ? arrow.start : arrow.end;
                }
                _draggingEndpoint = {
                    arrowIndex: epHit.arrowIndex,
                    point: epHit.point,
                    pointIndex: epHit.pointIndex,
                    startX: pt.x,
                    startY: pt.y
                };
                // 矩形：记录对侧端点的视觉位置
                if (arrow.type === "rectangle" && arrow.rotation) {
                    const rot = arrow.rotation * Math.PI / 180;
                    const cos = Math.cos(rot), sin = Math.sin(rot);
                    const cx = (arrow.start.x + arrow.end.x) / 2;
                    const cy = (arrow.start.y + arrow.end.y) / 2;
                    if (epHit.point === 'start') {
                        const dx = arrow.end.x - cx, dy = arrow.end.y - cy;
                        _draggingEndpoint.fixedVisualX = cx + dx * cos - dy * sin;
                        _draggingEndpoint.fixedVisualY = cy + dx * sin + dy * cos;
                    } else {
                        const dx = arrow.start.x - cx, dy = arrow.start.y - cy;
                        _draggingEndpoint.fixedVisualX = cx + dx * cos - dy * sin;
                        _draggingEndpoint.fixedVisualY = cy + dx * sin + dy * cos;
                    }
                }
                // 圆形：记录圆心
                if (arrow.type === "circle") {
                    _draggingEndpoint.centerX = (arrow.start.x + arrow.end.x) / 2;
                    _draggingEndpoint.centerY = (arrow.start.y + arrow.end.y) / 2;
                }
                // 椭圆：记录圆心和另一轴长度
                if (arrow.type === "ellipse") {
                    _draggingEndpoint.centerX = (arrow.start.x + arrow.end.x) / 2;
                    _draggingEndpoint.centerY = (arrow.start.y + arrow.end.y) / 2;
                    _draggingEndpoint.otherRx = Math.max(Math.abs(arrow.end.x - arrow.start.x) / 2, 0.1);
                    _draggingEndpoint.otherRy = Math.max(Math.abs(arrow.end.y - arrow.start.y) / 2, 0.1);
                }
                e.preventDefault();
                return;
            }
        }

        // 钝化激活模式下，只有面板已打开时才能点选
        if (arrowSettings.deactivateClickSelect && !isArrowModeActive) {
            e.preventDefault();
            return;
        }
        // 如果模式未激活，先激活箭头模式并弹出面板
        if (!isArrowModeActive) {
            isArrowModeActive = true;
            showToolbar();
            setPointerEventsMode("auto");
            setCursor("crosshair");
        }
        // 单选该形状
        setSingleSelection(hitIndex);
        renderArrows();
        updateToolbarState();
        updateTransformSliders();
        updateStyleSliders();
        e.preventDefault();
        return;
    }

    // 未命中箭头
    // Ctrl+拖拽：启动框选
    if (ctrlHeld && isArrowModeActive) {
        _boxSelecting = true;
        _boxSelectStart = { x: canvasPos.x, y: canvasPos.y };
        _boxSelectRect = null;
        e.preventDefault();
        return;
    }

    // 检查是否点击了已选中形状的手柄（边框模式下中心在内部，hitTestShape 检测不到）
    if (hasSelection()) {
        // 旋转手柄：仅单选时可用
        if (selectedArrowIndices.size === 1) {
            const rotHit = hitTestRotationHandle(canvasPos.x, canvasPos.y);
            if (rotHit) {
                const startAngle = Math.atan2(canvasPos.y - rotHit.centerY, canvasPos.x - rotHit.centerX);
                _draggingRotation = {
                    arrowIndex: rotHit.arrowIndex,
                    centerX: rotHit.centerX,
                    centerY: rotHit.centerY,
                    startAngle: startAngle
                };
                e.preventDefault();
                return;
            }
        }
        const centerHit = hitTestShapeCenter(canvasPos.x, canvasPos.y);
        if (centerHit && isSelected(centerHit.arrowIndex)) {
            const selIndices = getSelectedIndices();
            const startCenters = selIndices.map(i => _getShapeCenter(arrows[i]));
            const center = _getShapeCenter(arrows[centerHit.arrowIndex]);
            _draggingShape = {
                arrowIndices: selIndices,
                refIndex: centerHit.arrowIndex,
                offsetX: canvasPos.x - center.x,
                offsetY: canvasPos.y - center.y,
                startCenters: startCenters
            };
            e.preventDefault();
            return;
        }
        const epHit2 = hitTestEndpoint(canvasPos.x, canvasPos.y);
        if (epHit2) {
            const arrow2 = arrows[epHit2.arrowIndex];
            let pt2;
            if (epHit2.pointIndex !== undefined && arrow2.points) {
                pt2 = arrow2.points[epHit2.pointIndex];
            } else {
                pt2 = epHit2.point === 'start' ? arrow2.start : arrow2.end;
            }
            _draggingEndpoint = {
                arrowIndex: epHit2.arrowIndex,
                point: epHit2.point,
                pointIndex: epHit2.pointIndex,
                startX: pt2.x,
                startY: pt2.y
            };
            // 矩形
            if (arrow2.type === "rectangle" && arrow2.rotation) {
                const rot3 = arrow2.rotation * Math.PI / 180;
                const cos3 = Math.cos(rot3), sin3 = Math.sin(rot3);
                const cx3 = (arrow2.start.x + arrow2.end.x) / 2;
                const cy3 = (arrow2.start.y + arrow2.end.y) / 2;
                if (epHit2.point === 'start') {
                    const dx3 = arrow2.end.x - cx3, dy3 = arrow2.end.y - cy3;
                    _draggingEndpoint.fixedVisualX = cx3 + dx3 * cos3 - dy3 * sin3;
                    _draggingEndpoint.fixedVisualY = cy3 + dx3 * sin3 + dy3 * cos3;
                } else {
                    const dx3 = arrow2.start.x - cx3, dy3 = arrow2.start.y - cy3;
                    _draggingEndpoint.fixedVisualX = cx3 + dx3 * cos3 - dy3 * sin3;
                    _draggingEndpoint.fixedVisualY = cy3 + dx3 * sin3 + dy3 * cos3;
                }
            }
            if (arrow2.type === "circle") {
                _draggingEndpoint.centerX = (arrow2.start.x + arrow2.end.x) / 2;
                _draggingEndpoint.centerY = (arrow2.start.y + arrow2.end.y) / 2;
            }
            if (arrow2.type === "ellipse") {
                _draggingEndpoint.centerX = (arrow2.start.x + arrow2.end.x) / 2;
                _draggingEndpoint.centerY = (arrow2.start.y + arrow2.end.y) / 2;
                _draggingEndpoint.otherRx = Math.max(Math.abs(arrow2.end.x - arrow2.start.x) / 2, 0.1);
                _draggingEndpoint.otherRy = Math.max(Math.abs(arrow2.end.y - arrow2.start.y) / 2, 0.1);
            }
            e.preventDefault();
            return;
        }
        // 点击空白处（无Ctrl）：取消选择
        clearSelection();
        renderArrows();
        updateToolbarState();
    }

    // 未命中箭头：仅在模式激活时开始绘制新箭头
    if (!isArrowModeActive) return;

    // 贝塞尔曲线：顺序打点绘制
    if (arrowSettings.shapeType === "bezier") {
        if (bezierDrawStage === 0) {
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
                animCount: arrowSettings.animCount,
                animSize: arrowSettings.animSize,
                closed: arrowSettings.closed,
                pacmanDots: arrowSettings.pacmanDots,
                pacmanSize: arrowSettings.pacmanSize,
                pacmanDotRatio: arrowSettings.pacmanDotRatio
            };
        } else {
            const lastPt = currentArrow.points[currentArrow.points.length - 1];
            const dist = Math.hypot(canvasPos.x - lastPt.x, canvasPos.y - lastPt.y);
            if (dist < 5) {
                e.preventDefault();
                return;
            }
            delete currentArrow.previewPoint;
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
        animCount: arrowSettings.animCount,
        animSize: arrowSettings.animSize,
        pacmanDots: arrowSettings.pacmanDots,
        pacmanSize: arrowSettings.pacmanSize,
        pacmanDotRatio: arrowSettings.pacmanDotRatio
    };
    if (arrowSettings.shapeType === "freehand") {
        if (!currentArrow.rawPoints) currentArrow.rawPoints = [];
        if (!currentArrow.points) currentArrow.points = [];
        collectFreehandPoint(currentArrow.rawPoints, { x: canvasPos.x, y: canvasPos.y }, arrowSettings.smoothness);
    }
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

    // 框选中：更新框选矩形
    if (_boxSelecting && _boxSelectStart) {
        const x = Math.min(_boxSelectStart.x, canvasPos.x);
        const y = Math.min(_boxSelectStart.y, canvasPos.y);
        const w = Math.abs(canvasPos.x - _boxSelectStart.x);
        const h = Math.abs(canvasPos.y - _boxSelectStart.y);
        _boxSelectRect = { x, y, w, h };
        scheduleRender();
        e.preventDefault();
        return;
    }

    // 端点拖拽中：更新端点位置
    if (_draggingEndpoint) {
        const arrow = arrows[_draggingEndpoint.arrowIndex];
        if (arrow) {
            if (_draggingEndpoint.pointIndex !== undefined && arrow.points) {
                // 贝塞尔曲线控制点拖拽
                arrow.points[_draggingEndpoint.pointIndex].x = canvasPos.x;
                arrow.points[_draggingEndpoint.pointIndex].y = canvasPos.y;
                // 同步 start/end
                if (_draggingEndpoint.pointIndex === 0) {
                    arrow.start.x = canvasPos.x;
                    arrow.start.y = canvasPos.y;
                }
                if (_draggingEndpoint.pointIndex === arrow.points.length - 1) {
                    arrow.end.x = canvasPos.x;
                    arrow.end.y = canvasPos.y;
                }
            } else if (_draggingEndpoint.point === 'radius') {
                // 圆形：保持圆心不动，拖动右侧手柄改变半径
                const cx = _draggingEndpoint.centerX;
                const cy = _draggingEndpoint.centerY;
                const newR = Math.max(Math.abs(canvasPos.x - cx), Math.abs(canvasPos.y - cy));
                arrow.start.x = cx - newR;
                arrow.start.y = cy - newR;
                arrow.end.x = cx + newR;
                arrow.end.y = cy + newR;
            } else if (_draggingEndpoint.point === 'rx') {
                // 椭圆：拖动右侧手柄，只改变rx，保持圆心和ry不变
                const cx = _draggingEndpoint.centerX;
                const cy = _draggingEndpoint.centerY;
                const ry = _draggingEndpoint.otherRy;
                const rot = (arrow.rotation || 0) * Math.PI / 180;
                const cos = Math.cos(rot), sin = Math.sin(rot);
                const dx = canvasPos.x - cx, dy = canvasPos.y - cy;
                const newRx = Math.max(Math.abs(dx * cos + dy * sin), 0.1);
                arrow.start.x = cx - newRx;
                arrow.start.y = cy - ry;
                arrow.end.x = cx + newRx;
                arrow.end.y = cy + ry;
            } else if (_draggingEndpoint.point === 'ry') {
                // 椭圆：拖动下侧手柄，只改变ry，保持圆心和rx不变
                const cx = _draggingEndpoint.centerX;
                const cy = _draggingEndpoint.centerY;
                const rx = _draggingEndpoint.otherRx;
                const rot = (arrow.rotation || 0) * Math.PI / 180;
                const cos = Math.cos(rot), sin = Math.sin(rot);
                const dx = canvasPos.x - cx, dy = canvasPos.y - cy;
                const newRy = Math.max(Math.abs(-dx * sin + dy * cos), 0.1);
                arrow.start.x = cx - rx;
                arrow.start.y = cy - newRy;
                arrow.end.x = cx + rx;
                arrow.end.y = cy + newRy;
            } else if (_draggingEndpoint.point === 'start') {
                // 矩形旋转后：以对侧端点视觉位置为锚点，保持不动
                if (arrow.type === "rectangle" && arrow.rotation && _draggingEndpoint.fixedVisualX !== undefined) {
                    const rot = arrow.rotation * Math.PI / 180;
                    const cos = Math.cos(rot), sin = Math.sin(rot);
                    const fvx = _draggingEndpoint.fixedVisualX;
                    const fvy = _draggingEndpoint.fixedVisualY;
                    const newCx = (canvasPos.x + fvx) / 2;
                    const newCy = (canvasPos.y + fvy) / 2;
                    const hdx = (canvasPos.x - fvx) / 2;
                    const hdy = (canvasPos.y - fvy) / 2;
                    const invHdx = hdx * cos + hdy * sin;
                    const invHdy = -hdx * sin + hdy * cos;
                    arrow.start.x = newCx + invHdx;
                    arrow.start.y = newCy + invHdy;
                    arrow.end.x = newCx - invHdx;
                    arrow.end.y = newCy - invHdy;
                } else {
                    arrow.start.x = canvasPos.x;
                    arrow.start.y = canvasPos.y;
                }
                // 贝塞尔曲线同步 points 首点
                if (arrow.type === "bezier" && arrow.points && arrow.points.length > 0) {
                    arrow.points[0].x = canvasPos.x;
                    arrow.points[0].y = canvasPos.y;
                }
            } else {
                // 矩形旋转后：以对侧端点视觉位置为锚点，保持不动
                if (arrow.type === "rectangle" && arrow.rotation && _draggingEndpoint.fixedVisualX !== undefined) {
                    const rot = arrow.rotation * Math.PI / 180;
                    const cos = Math.cos(rot), sin = Math.sin(rot);
                    const fvx = _draggingEndpoint.fixedVisualX;
                    const fvy = _draggingEndpoint.fixedVisualY;
                    const newCx = (canvasPos.x + fvx) / 2;
                    const newCy = (canvasPos.y + fvy) / 2;
                    const hdx = (canvasPos.x - fvx) / 2;
                    const hdy = (canvasPos.y - fvy) / 2;
                    const invHdx = hdx * cos + hdy * sin;
                    const invHdy = -hdx * sin + hdy * cos;
                    arrow.end.x = newCx + invHdx;
                    arrow.end.y = newCy + invHdy;
                    arrow.start.x = newCx - invHdx;
                    arrow.start.y = newCy - invHdy;
                } else {
                    arrow.end.x = canvasPos.x;
                    arrow.end.y = canvasPos.y;
                }
                // 贝塞尔曲线同步 points 尾点
                if (arrow.type === "bezier" && arrow.points && arrow.points.length > 0) {
                    const last = arrow.points[arrow.points.length - 1];
                    last.x = canvasPos.x;
                    last.y = canvasPos.y;
                }
            }
            scheduleRender();
        }
        e.preventDefault();
        return;
    }

    // 旋转拖拽中：旋转整个形状
    if (_draggingRotation) {
        const arrow = arrows[_draggingRotation.arrowIndex];
        if (arrow) {
            const currentAngle = Math.atan2(canvasPos.y - _draggingRotation.centerY, canvasPos.x - _draggingRotation.centerX);
            const deltaDeg = (currentAngle - _draggingRotation.startAngle) * 180 / Math.PI;
            const prevRotation = arrow.rotation || 0;
            const targetAngleDeg = prevRotation + deltaDeg;
            _rotateShape(arrow, _draggingRotation.centerX, _draggingRotation.centerY, targetAngleDeg - prevRotation);
            arrow.rotation = ((targetAngleDeg % 360) + 360) % 360;
            _draggingRotation.startAngle = currentAngle;
            scheduleRender();
        }
        e.preventDefault();
        return;
    }

    // 整体拖拽中：移动所有选中的形状
    if (_draggingShape) {
        const targetX = canvasPos.x - _draggingShape.offsetX;
        const targetY = canvasPos.y - _draggingShape.offsetY;
        // 以拖拽起始形状的中心为参考计算偏移
        const refCenter = _getShapeCenter(arrows[_draggingShape.refIndex]);
        const dx = targetX - refCenter.x;
        const dy = targetY - refCenter.y;
        for (const idx of _draggingShape.arrowIndices) {
            _offsetShape(arrows[idx], dx, dy);
        }
        scheduleRender();
        e.preventDefault();
        return;
    }

    // 悬停在已选中箭头的手柄上时，切换光标
    if (hasSelection() && isArrowModeActive) {
        const rotHit = hitTestRotationHandle(canvasPos.x, canvasPos.y);
        if (rotHit) {
            setCursor("grab");
        } else {
            const centerHit = hitTestShapeCenter(canvasPos.x, canvasPos.y);
            if (centerHit && isSelected(centerHit.arrowIndex)) {
                setCursor("move");
            } else {
                const epHit = hitTestEndpoint(canvasPos.x, canvasPos.y);
                if (epHit) {
                    setCursor("grab");
                } else {
                    setCursor("crosshair");
                }
            }
        }
    }

    if (!isDrawing) return;

    if (currentArrow) {
        if (currentArrow.type === "freehand") {
            // 手绘：收集原始点并实时平滑预览
            if (!currentArrow.rawPoints) currentArrow.rawPoints = [];
            collectFreehandPoint(currentArrow.rawPoints, { x: canvasPos.x, y: canvasPos.y }, arrowSettings.smoothness);
            currentArrow.points = smoothFreehandPoints(currentArrow.rawPoints);
            currentArrow.end = { x: canvasPos.x, y: canvasPos.y };
        } else if (currentArrow.type === "bezier" && bezierDrawStage >= 1) {
            // 贝塞尔打点：用 previewPoint 实时预览下一段曲线
            currentArrow.previewPoint = { x: canvasPos.x, y: canvasPos.y };
            currentArrow.end = { x: canvasPos.x, y: canvasPos.y };
        } else {
            currentArrow.end = { x: canvasPos.x, y: canvasPos.y };
        }
    }
    lastPoint = { x: canvasPos.x, y: canvasPos.y };

    scheduleRender();
    e.preventDefault();
}

function handlePointerUp(e) {
    // 框选结束：选中框内所有形状
    if (_boxSelecting) {
        _boxSelecting = false;
        if (_boxSelectRect && _boxSelectRect.w > 4 && _boxSelectRect.h > 4) {
            // 收集框内的形状
            for (let i = 0; i < arrows.length; i++) {
                const center = _getShapeCenter(arrows[i]);
                if (center.x >= _boxSelectRect.x && center.x <= _boxSelectRect.x + _boxSelectRect.w &&
                    center.y >= _boxSelectRect.y && center.y <= _boxSelectRect.y + _boxSelectRect.h) {
                    addToSelection(i);
                }
            }
            renderArrows();
            updateToolbarState();
            updateTransformSliders();
            updateStyleSliders();
        }
        _boxSelectStart = null;
        _boxSelectRect = null;
        renderArrows();
        return;
    }

    // 端点拖拽结束：记录状态并清理
    if (_draggingEndpoint) {
        const arrow = arrows[_draggingEndpoint.arrowIndex];
        if (arrow) {
            let pt;
            if (_draggingEndpoint.pointIndex !== undefined && arrow.points) {
                pt = arrow.points[_draggingEndpoint.pointIndex];
            } else {
                pt = _draggingEndpoint.point === 'start' ? arrow.start : arrow.end;
            }
            // 只有位置确实改变了才记录
            if (pt && (pt.x !== _draggingEndpoint.startX || pt.y !== _draggingEndpoint.startY)) {
                recordState(xzgT("调整箭头端点", "Adjust arrow endpoint"));
                syncArrowsToExtra();
            }
        }
        _draggingEndpoint = null;
        updateTransformSliders();
        updateStyleSliders();
        renderArrows();
        return;
    }

    // 整体拖拽结束：记录状态并清理
    if (_draggingShape) {
        // 检查是否有形状实际移动了
        let moved = false;
        for (let i = 0; i < _draggingShape.arrowIndices.length; i++) {
            const idx = _draggingShape.arrowIndices[i];
            const nowCenter = _getShapeCenter(arrows[idx]);
            const startCenter = _draggingShape.startCenters[i];
            if (nowCenter.x !== startCenter.x || nowCenter.y !== startCenter.y) {
                moved = true;
                break;
            }
        }
        if (moved) {
            recordState(xzgT("移动形状位置", "Move shape position"));
            syncArrowsToExtra();
        }
        _draggingShape = null;
        updateTransformSliders();
        updateStyleSliders();
        renderArrows();
        return;
    }

    // 旋转拖拽结束：记录状态并清理
    if (_draggingRotation) {
        recordState(xzgT("旋转形状", "Rotate shape"));
        syncArrowsToExtra();
        _draggingRotation = null;
        updateTransformSliders();
        updateStyleSliders();
        renderArrows();
        return;
    }

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
        // 手绘：用原始点数作为有效长度判断
        const isValid = currentArrow.type === "freehand"
            ? (currentArrow.rawPoints && currentArrow.rawPoints.length >= 3)
            : (() => {
                const dx = currentArrow.end.x - currentArrow.start.x;
                const dy = currentArrow.end.y - currentArrow.start.y;
                return Math.sqrt(dx * dx + dy * dy) >= 10;
              })();

        if (isValid) {
            const arrowData = {
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
                animCount: currentArrow.animCount || 5,
                animSize: currentArrow.animSize !== undefined ? currentArrow.animSize : 50,
                dashGap: arrowSettings.dashGap,
                rotation: 0,
                pacmanDots: currentArrow.pacmanDots !== undefined ? currentArrow.pacmanDots : arrowSettings.pacmanDots,
                pacmanSize: currentArrow.pacmanSize !== undefined ? currentArrow.pacmanSize : arrowSettings.pacmanSize,
                pacmanDotRatio: currentArrow.pacmanDotRatio !== undefined ? currentArrow.pacmanDotRatio : arrowSettings.pacmanDotRatio
            };
            // 手绘：保存平滑后的点和平滑幅度
            if (currentArrow.type === "freehand" && currentArrow.rawPoints) {
                arrowData.points = smoothFreehandPoints(currentArrow.rawPoints);
                arrowData.smoothness = arrowSettings.smoothness;
            }
            arrows.push(arrowData);
            // 自动选中新绘制的箭头（单选）
            setSingleSelection(arrows.length - 1);
            const actionName = currentArrow.type === "freehand" ? xzgT("手绘绘制", "Freehand draw") : xzgT("绘制箭头", "Draw arrow");
            recordState(actionName);
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
    if (_boxSelecting) {
        _boxSelecting = false;
        _boxSelectStart = null;
        _boxSelectRect = null;
        renderArrows();
        return;
    }
    if (_draggingEndpoint) {
        _draggingEndpoint = null;
        renderArrows();
        return;
    }
    if (_draggingShape) {
        _draggingShape = null;
        renderArrows();
        return;
    }
    if (_draggingRotation) {
        _draggingRotation = null;
        renderArrows();
        return;
    }
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
        animCount: currentArrow.animCount || 5,
        animSize: currentArrow.animSize !== undefined ? currentArrow.animSize : 50,
        closed: arrowSettings.closed,
        dashGap: arrowSettings.dashGap,
        rotation: 0
    });
    setSingleSelection(arrows.length - 1);
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
    // 清除已失效的选中索引（箭头被删除后索引不再有效）
    for (const idx of selectedArrowIndices) {
        if (idx >= arrows.length) {
            selectedArrowIndices.delete(idx);
        }
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
                    color: #aaaaaa; font-size: 13px; font-weight: 600;
                    padding: 14px 16px 8px 16px;
                }
                .xzg-arrow-dialog-body {
                    color: #aaaaaa; font-size: 13px; line-height: 1.6;
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
                    background: #2a2a2a; color: #aaaaaa;
                    font-size: 13px; cursor: pointer;
                    transition: all 0.15s;
                }
                .xzg-arrow-dialog-btn:hover { background: #3a3a3a; color: #aaaaaa; }
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
    clearSelection();
    recordState(xzgT("清除所有箭头", "Clear all arrows"));
    renderArrows();
    updateToolbarState();
}

function deleteSelectedArrow() {
    if (!hasSelection()) return;
    const indices = getSelectedIndices().sort((a, b) => b - a); // 从大到小排序，从后往前删除
    for (const idx of indices) {
        arrows.splice(idx, 1);
    }
    clearSelection();
    const count = indices.length;
    recordState(xzgT(`删除${count}个箭头`, `Delete ${count} arrows`));
    renderArrows();
    updateToolbarState();
}

// 变换函数（旋转手柄已替代旋转滑条，保留空函数兼容调用）
function updateTransformSliders() {}

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

    if (hasSelection()) {
        const arrow = arrows[getFirstSelectedIndex()];
        const type = arrow.type || "arrow";
        const mode = arrow.mode || "border";
        const lineStyle = arrow.lineStyle || "solid";
        if (colorInput) colorInput.value = arrow.color;
        if (widthSlider) widthSlider.value = arrow.lineWidth;
        if (widthDisplay) widthDisplay.textContent = arrow.lineWidth;
        if (headSlider) headSlider.value = arrow.arrowSize;
        if (headDisplay) headDisplay.textContent = arrow.arrowSize;
        const arrowAnimType = arrow.animType || "none";
        if (opacitySlider) {
            opacitySlider.min = arrowAnimType !== "none" ? "0" : "20";
            // 无特效时透明度低于20%则强制恢复，防止内容不可见
            if (arrowAnimType === "none" && arrow.opacity < 0.2) {
                arrow.opacity = 0.2;
                arrowSettings.opacity = 0.2;
            }
            opacitySlider.value = Math.round(arrow.opacity * 100);
        }
        if (opacityDisplay) opacityDisplay.textContent = `${Math.round(arrow.opacity * 100)}`;
        if (radiusSlider) radiusSlider.value = arrow.borderRadius || 0;
        if (radiusDisplay) radiusDisplay.textContent = arrow.borderRadius || 0;
        if (radiusRow) radiusRow.style.display = type === "rectangle" ? "" : "none";
        // 箭头大小仅箭头/曲线显示，闭合曲线时隐藏
        if (headRow) {
            const showHead = type === "arrow" || (type === "bezier" && !arrow.closed);
            headRow.style.display = showHead ? "" : "none";
        }

        // 同步平滑幅度滑条
        const smoothnessSlider = toolbarElement.querySelector(".xzg-arrow-smoothness-slider");
        const smoothnessDisplay = toolbarElement.querySelector(".xzg-arrow-smoothness-value");
        const smoothnessRow = toolbarElement.querySelector("#xzg-arrow-smoothness-row");
        const smoothVal = arrow.smoothness !== undefined ? arrow.smoothness : arrowSettings.smoothness;
        if (smoothnessSlider) smoothnessSlider.value = smoothVal;
        if (smoothnessDisplay) smoothnessDisplay.textContent = smoothVal;
        if (smoothnessRow) smoothnessRow.style.display = type === "freehand" ? "" : "none";

        // 同步闭合开关
        const closedToggle = toolbarElement.querySelector(".xzg-arrow-closed-toggle");
        const closedState = toolbarElement.querySelector(".xzg-arrow-closed-state");
        const closedRow = toolbarElement.querySelector("#xzg-arrow-closed-row");
        const closedVal = arrow.closed !== undefined ? arrow.closed : arrowSettings.closed;
        if (closedToggle) {
            closedToggle.dataset.checked = closedVal ? "true" : "false";
            const track = closedToggle.querySelector(".xzg-closed-toggle-track");
            const thumb = closedToggle.querySelector(".xzg-closed-toggle-thumb");
            if (track) track.style.background = closedVal ? "#4CAF50" : "#666666";
            if (thumb) thumb.style.left = closedVal ? "14px" : "2px";
        }
        if (closedState) {
            closedState.textContent = closedVal ? xzgT("开", "ON") : xzgT("关", "OFF");
            closedState.style.color = closedVal ? "#4CAF50" : "#999";
        }
        if (closedRow) closedRow.style.display = type === "bezier" ? "" : "none";

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
        if (animCountSlider) {
            animCountSlider.value = animCnt;
            animCountSlider.max = (animType === "pacman") ? 500 : 100;
        }
        if (animCountDisplay) animCountDisplay.textContent = animCnt;
        if (animCountRow) animCountRow.style.display = (animType === "none" || animType === "energy" || animType === "pulse" || animType === "pacman") ? "none" : "flex";
        const animSizeSlider = toolbarElement.querySelector(".xzg-arrow-anim-size-slider");
        const animSizeDisplay = toolbarElement.querySelector(".xzg-arrow-anim-size-value");
        const animSizeRow = toolbarElement.querySelector("#xzg-arrow-anim-size-row");
        const animSz = arrow.animSize !== undefined ? arrow.animSize : 50;
        if (animSizeSlider) animSizeSlider.value = animSz;
        if (animSizeDisplay) animSizeDisplay.textContent = animSz;
        if (animSizeRow) animSizeRow.style.display = (animType === "none" || animType === "pacman") ? "none" : "flex";

        // 同步吃豆人豆子数量滑条
        const pacmanDotsSlider = toolbarElement.querySelector(".xzg-arrow-pacman-dots-slider");
        const pacmanDotsDisplay = toolbarElement.querySelector(".xzg-arrow-pacman-dots-value");
        const pacmanDotsRow = toolbarElement.querySelector("#xzg-arrow-pacman-dots-row");
        const pacDots = arrow.pacmanDots !== undefined ? arrow.pacmanDots : arrowSettings.pacmanDots;
        if (pacmanDotsSlider) pacmanDotsSlider.value = pacDots;
        if (pacmanDotsDisplay) pacmanDotsDisplay.textContent = pacDots;
        if (pacmanDotsRow) pacmanDotsRow.style.display = (animType === "pacman") ? "flex" : "none";
        // 同步吃豆人大小滑条
        const pacmanSizeSlider = toolbarElement.querySelector(".xzg-arrow-pacman-size-slider");
        const pacmanSizeDisplay = toolbarElement.querySelector(".xzg-arrow-pacman-size-value");
        const pacmanSizeRow = toolbarElement.querySelector("#xzg-arrow-pacman-size-row");
        const pacSize = arrow.pacmanSize !== undefined ? arrow.pacmanSize : arrowSettings.pacmanSize;
        if (pacmanSizeSlider) pacmanSizeSlider.value = pacSize;
        if (pacmanSizeDisplay) pacmanSizeDisplay.textContent = pacSize;
        if (pacmanSizeRow) pacmanSizeRow.style.display = (animType === "pacman") ? "flex" : "none";
        // 同步豆子比例滑条
        const pacmanRatioSlider = toolbarElement.querySelector(".xzg-arrow-pacman-ratio-slider");
        const pacmanRatioDisplay = toolbarElement.querySelector(".xzg-arrow-pacman-ratio-value");
        const pacmanRatioRow = toolbarElement.querySelector("#xzg-arrow-pacman-ratio-row");
        const pacRatio = arrow.pacmanDotRatio !== undefined ? arrow.pacmanDotRatio : arrowSettings.pacmanDotRatio;
        if (pacmanRatioSlider) pacmanRatioSlider.value = pacRatio;
        if (pacmanRatioDisplay) pacmanRatioDisplay.textContent = pacRatio;
        if (pacmanRatioRow) pacmanRatioRow.style.display = (animType === "pacman") ? "flex" : "none";

        // 同步形状与线型下拉列表（形状始终显示全局设置，只影响新绘制内容）
        if (shapeSelect) {
            shapeSelect.value = arrowSettings.shapeType;
        }
        if (lineStyleSelect) lineStyleSelect.value = lineStyle;
        // 同步间距滑块
        const dashGapRow = toolbarElement.querySelector("#xzg-arrow-dashgap-row");
        if (dashGapRow) dashGapRow.style.display = (lineStyle === "solid") ? "none" : "flex";
        const dashGapSlider = toolbarElement.querySelector(".xzg-arrow-dashgap-slider");
        const dashGapDisplay = toolbarElement.querySelector(".xzg-arrow-dashgap-value");
        const dashGapVal = arrow.dashGap !== undefined ? arrow.dashGap : arrowSettings.dashGap;
        if (dashGapSlider) dashGapSlider.value = dashGapVal;
        if (dashGapDisplay) dashGapDisplay.textContent = dashGapVal;
        // 同步模式行显示
        const modeRow = toolbarElement.querySelector("#xzg-arrow-mode-row");
        if (modeRow) modeRow.style.display = (type === "arrow" || type === "bezier" || type === "freehand") ? "none" : "";
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
        if (opacityDisplay) opacityDisplay.textContent = `${Math.round(arrowSettings.opacity * 100)}`;
        if (radiusSlider) radiusSlider.value = arrowSettings.borderRadius;
        if (radiusDisplay) radiusDisplay.textContent = arrowSettings.borderRadius;
        if (radiusRow) radiusRow.style.display = arrowSettings.shapeType === "rectangle" ? "" : "none";
        // 箭头大小仅箭头/曲线显示，闭合曲线时隐藏
        if (headRow) {
            const showHead = arrowSettings.shapeType === "arrow" || (arrowSettings.shapeType === "bezier" && !arrowSettings.closed);
            headRow.style.display = showHead ? "" : "none";
        }

        // 同步平滑幅度滑条（全局设置）
        const smoothnessSlider = toolbarElement.querySelector(".xzg-arrow-smoothness-slider");
        const smoothnessDisplay = toolbarElement.querySelector(".xzg-arrow-smoothness-value");
        const smoothnessRow = toolbarElement.querySelector("#xzg-arrow-smoothness-row");
        if (smoothnessSlider) smoothnessSlider.value = arrowSettings.smoothness;
        if (smoothnessDisplay) smoothnessDisplay.textContent = arrowSettings.smoothness;
        if (smoothnessRow) smoothnessRow.style.display = arrowSettings.shapeType === "freehand" ? "" : "none";

        // 同步闭合开关（全局设置）
        const closedToggle = toolbarElement.querySelector(".xzg-arrow-closed-toggle");
        const closedState = toolbarElement.querySelector(".xzg-arrow-closed-state");
        const closedRow = toolbarElement.querySelector("#xzg-arrow-closed-row");
        if (closedToggle) {
            closedToggle.dataset.checked = arrowSettings.closed ? "true" : "false";
            const track = closedToggle.querySelector(".xzg-closed-toggle-track");
            const thumb = closedToggle.querySelector(".xzg-closed-toggle-thumb");
            if (track) track.style.background = arrowSettings.closed ? "#4CAF50" : "#666666";
            if (thumb) thumb.style.left = arrowSettings.closed ? "14px" : "2px";
        }
        if (closedState) {
            closedState.textContent = arrowSettings.closed ? xzgT("开", "ON") : xzgT("关", "OFF");
            closedState.style.color = arrowSettings.closed ? "#4CAF50" : "#999";
        }
        if (closedRow) closedRow.style.display = arrowSettings.shapeType === "bezier" ? "" : "none";

        // 同步特效动画控件为全局设置
        if (animSelect) animSelect.value = arrowSettings.animType;
        if (animSpeedSlider) animSpeedSlider.value = arrowSettings.animSpeed;
        if (animSpeedDisplay) animSpeedDisplay.textContent = arrowSettings.animSpeed;
        if (animSpeedRow) animSpeedRow.style.display = (arrowSettings.animType === "none") ? "none" : "flex";
        const animCountSliderG = toolbarElement.querySelector(".xzg-arrow-anim-count-slider");
        const animCountDisplayG = toolbarElement.querySelector(".xzg-arrow-anim-count-value");
        const animCountRowG = toolbarElement.querySelector("#xzg-arrow-anim-count-row");
        if (animCountSliderG) {
            animCountSliderG.value = arrowSettings.animCount;
            animCountSliderG.max = (arrowSettings.animType === "pacman") ? 500 : 100;
        }
        if (animCountDisplayG) animCountDisplayG.textContent = arrowSettings.animCount;
        if (animCountRowG) animCountRowG.style.display = (arrowSettings.animType === "none" || arrowSettings.animType === "energy" || arrowSettings.animType === "pulse" || arrowSettings.animType === "pacman") ? "none" : "flex";
        const animSizeSliderG = toolbarElement.querySelector(".xzg-arrow-anim-size-slider");
        const animSizeDisplayG = toolbarElement.querySelector(".xzg-arrow-anim-size-value");
        const animSizeRowG = toolbarElement.querySelector("#xzg-arrow-anim-size-row");
        if (animSizeSliderG) animSizeSliderG.value = arrowSettings.animSize;
        if (animSizeDisplayG) animSizeDisplayG.textContent = arrowSettings.animSize;
        if (animSizeRowG) animSizeRowG.style.display = (arrowSettings.animType === "none" || arrowSettings.animType === "pacman") ? "none" : "flex";

        // 同步吃豆人豆子数量滑条（全局）
        const pacmanDotsRowG = toolbarElement.querySelector("#xzg-arrow-pacman-dots-row");
        const pacmanDotsSliderG = toolbarElement.querySelector(".xzg-arrow-pacman-dots-slider");
        const pacmanDotsDisplayG = toolbarElement.querySelector(".xzg-arrow-pacman-dots-value");
        if (pacmanDotsSliderG) pacmanDotsSliderG.value = arrowSettings.pacmanDots;
        if (pacmanDotsDisplayG) pacmanDotsDisplayG.textContent = arrowSettings.pacmanDots;
        if (pacmanDotsRowG) pacmanDotsRowG.style.display = (arrowSettings.animType === "pacman") ? "flex" : "none";
        // 同步吃豆人大小滑条（全局）
        const pacmanSizeRowG = toolbarElement.querySelector("#xzg-arrow-pacman-size-row");
        const pacmanSizeSliderG = toolbarElement.querySelector(".xzg-arrow-pacman-size-slider");
        const pacmanSizeDisplayG = toolbarElement.querySelector(".xzg-arrow-pacman-size-value");
        if (pacmanSizeSliderG) pacmanSizeSliderG.value = arrowSettings.pacmanSize;
        if (pacmanSizeDisplayG) pacmanSizeDisplayG.textContent = arrowSettings.pacmanSize;
        if (pacmanSizeRowG) pacmanSizeRowG.style.display = (arrowSettings.animType === "pacman") ? "flex" : "none";
        // 同步豆子比例滑条（全局）
        const pacmanRatioRowG = toolbarElement.querySelector("#xzg-arrow-pacman-ratio-row");
        const pacmanRatioSliderG = toolbarElement.querySelector(".xzg-arrow-pacman-ratio-slider");
        const pacmanRatioDisplayG = toolbarElement.querySelector(".xzg-arrow-pacman-ratio-value");
        if (pacmanRatioSliderG) pacmanRatioSliderG.value = arrowSettings.pacmanDotRatio;
        if (pacmanRatioDisplayG) pacmanRatioDisplayG.textContent = arrowSettings.pacmanDotRatio;
        if (pacmanRatioRowG) pacmanRatioRowG.style.display = (arrowSettings.animType === "pacman") ? "flex" : "none";

        // 同步下拉列表为全局设置
        if (shapeSelect) {
            shapeSelect.value = arrowSettings.shapeType;
        }
        if (lineStyleSelect) lineStyleSelect.value = arrowSettings.lineStyle;
        // 同步间距滑块
        const dashGapRow = toolbarElement.querySelector("#xzg-arrow-dashgap-row");
        if (dashGapRow) dashGapRow.style.display = (arrowSettings.lineStyle === "solid") ? "none" : "flex";
        const dashGapSlider = toolbarElement.querySelector(".xzg-arrow-dashgap-slider");
        const dashGapDisplay = toolbarElement.querySelector(".xzg-arrow-dashgap-value");
        const dashGapVal = arrowSettings.dashGap;
        if (dashGapSlider) dashGapSlider.value = dashGapVal;
        if (dashGapDisplay) dashGapDisplay.textContent = dashGapVal;
        const modeRow = toolbarElement.querySelector("#xzg-arrow-mode-row");
        if (modeRow) modeRow.style.display = (arrowSettings.shapeType === "arrow" || arrowSettings.shapeType === "bezier" || arrowSettings.shapeType === "freehand") ? "none" : "";
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
        clearSelection();
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
// 持久化（按工作流保存箭头）
// ============================================================================

const EXTENSION_KEY = "xiaozhuguang_arrows";

/** 将 arrows 数组同步到 app.graph.extra，确保序列化时包含箭头数据 */
function syncArrowsToExtra() {
    if (!app?.graph) return;
    try {
        if (!app.graph.extra) app.graph.extra = {};
        if (arrows.length > 0) {
            app.graph.extra[EXTENSION_KEY] = {
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
                        animSpeed: a.animSpeed !== undefined ? a.animSpeed : 1,
                        animCount: a.animCount !== undefined ? a.animCount : 5,
                        animSize: a.animSize !== undefined ? a.animSize : 50,
                        smoothness: a.smoothness !== undefined ? a.smoothness : arrowSettings.smoothness,
                        closed: a.closed !== undefined ? a.closed : arrowSettings.closed,
                        pacmanDots: a.pacmanDots !== undefined ? a.pacmanDots : arrowSettings.pacmanDots,
                        pacmanSize: a.pacmanSize !== undefined ? a.pacmanSize : arrowSettings.pacmanSize,
                        pacmanDotRatio: a.pacmanDotRatio !== undefined ? a.pacmanDotRatio : arrowSettings.pacmanDotRatio
                    };
                    if (a.rotation !== undefined) obj.rotation = a.rotation;
                    if (a.points) obj.points = a.points.map(p => ({ x: p.x, y: p.y }));
                    if (a.control) obj.control = { x: a.control.x, y: a.control.y };
                    return obj;
                })
            };
        } else if (app.graph.extra && app.graph.extra[EXTENSION_KEY]) {
            delete app.graph.extra[EXTENSION_KEY];
        }
        // 缓存当前工作流引用到 graph 对象上
        // 确保 configure 执行前能找到正确的工作流来保存箭头
        try {
            const wfStore = app?.extensionManager?.workflow;
            if (wfStore?.workflows && Array.isArray(wfStore.workflows)) {
                const currentWf = wfStore.workflows.find(w => typeof wfStore.isActive === 'function' && wfStore.isActive(w));
                if (currentWf) {
                    app.graph._arrowWorkflow = currentWf;
                }
            }
        } catch (e) {}
    } catch (e) {}
}

/** 设置持久化 */
function setupPersistence() {
    const LGraph = window.LGraph;

    // 1) serialize 补丁：将箭头写入序列化数据的 extra 中
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
                            animCount: a.animCount || 5,
                            animSize: a.animSize !== undefined ? a.animSize : 50,
                            smoothness: a.smoothness !== undefined ? a.smoothness : arrowSettings.smoothness,
                            closed: a.closed !== undefined ? a.closed : arrowSettings.closed,
                            pacmanDots: a.pacmanDots !== undefined ? a.pacmanDots : arrowSettings.pacmanDots,
                            pacmanSize: a.pacmanSize !== undefined ? a.pacmanSize : arrowSettings.pacmanSize,
                            pacmanDotRatio: a.pacmanDotRatio !== undefined ? a.pacmanDotRatio : arrowSettings.pacmanDotRatio
                        };
                        if (a.rotation !== undefined) obj.rotation = a.rotation;
                        if (a.points) obj.points = a.points.map(p => ({ x: p.x, y: p.y }));
                        if (a.control) obj.control = { x: a.control.x, y: a.control.y };
                        return obj;
                    })
                };
            } else {
                delete data.extra[EXTENSION_KEY];
            }
            return data;
        };
    }

    // 2) loadGraphData 补丁：不做清除（由 configure 补丁负责保存旧箭头和恢复新箭头）
    //    如果在这里清除 arrows，configure 的 BEFORE 逻辑就无法检测到 arrows.length > 0
    //    导致旧工作流的箭头不会被保存
    if (app) {
        const origLoadGraphData = app.loadGraphData.bind(app);
        app.loadGraphData = async function (graphData, ...args) {
            const result = await origLoadGraphData(graphData, ...args);
            return result;
        };
    }

    // 3) configure 补丁：
    //    BEFORE origConfigure: 用 graph._arrowWorkflow 缓存的引用保存当前箭头到旧工作流
    //    AFTER origConfigure: 从 data.extra 恢复箭头（新工作流的数据）
    if (LGraph && LGraph.prototype.configure) {
        const origConfigure = LGraph.prototype.configure;
        LGraph.prototype.configure = function (data) {
            // BEFORE: 保存当前箭头到旧工作流（用缓存的引用，此时 activeWorkflow 可能已切换）
            try {
                if (this._arrowWorkflow && arrows.length > 0) {
                    // 确保箭头已写入 graph.extra
                    if (!this.extra) this.extra = {};
                    this.extra[EXTENSION_KEY] = {
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
                                animSpeed: a.animSpeed !== undefined ? a.animSpeed : 1,
                                animCount: a.animCount !== undefined ? a.animCount : 5,
                                animSize: a.animSize !== undefined ? a.animSize : 50
                            };
                            if (a.rotation !== undefined) obj.rotation = a.rotation;
                            if (a.points) obj.points = a.points.map(p => ({ x: p.x, y: p.y }));
                            if (a.control) obj.control = { x: a.control.x, y: a.control.y };
                            return obj;
                        })
                    };
                    // 序列化当前图（含箭头）写入旧工作流的 content
                    const serialized = this.serialize();
                    if (serialized) {
                        this._arrowWorkflow.content = JSON.stringify(serialized);
                    }
                }
            } catch (e) {}

            const result = origConfigure.apply(this, arguments);

            // AFTER: 清除箭头，从新数据恢复
            arrows = [];
            history = [];
            currentHistoryIndex = -1;

            const savedArrows = data?.extra?.[EXTENSION_KEY]?.arrows;
            if (savedArrows && Array.isArray(savedArrows) && savedArrows.length > 0) {
                arrows = savedArrows.map(a => ({
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
                    animCount: a.animCount !== undefined ? a.animCount : 5,
                    animSize: a.animSize !== undefined ? a.animSize : 50,
                    smoothness: a.smoothness !== undefined ? a.smoothness : arrowSettings.smoothness,
                    closed: a.closed !== undefined ? a.closed : arrowSettings.closed,
                    pacmanDots: a.pacmanDots !== undefined ? a.pacmanDots : arrowSettings.pacmanDots,
                    pacmanSize: a.pacmanSize !== undefined ? a.pacmanSize : arrowSettings.pacmanSize,
                    pacmanDotRatio: a.pacmanDotRatio !== undefined ? a.pacmanDotRatio : arrowSettings.pacmanDotRatio,
                    rotation: a.rotation !== undefined ? a.rotation : 0,
                    ...(a.points ? { points: a.points.map(p => ({ x: p.x, y: p.y })) } : {}),
                    ...(a.control ? { control: { x: a.control.x, y: a.control.y } } : {})
                }));
            }

            // 更新当前工作流引用为新的 active workflow
            try {
                const wfStore = app?.extensionManager?.workflow;
                if (wfStore?.workflows && Array.isArray(wfStore.workflows)) {
                    const currentWf = wfStore.workflows.find(w => typeof wfStore.isActive === 'function' && wfStore.isActive(w));
                    if (currentWf) {
                        this._arrowWorkflow = currentWf;
                    }
                }
            } catch (e) {}

            recordInitialState();
            renderArrows();
            updateToolbarState();

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
            if (parsed.animSize !== undefined) arrowSettings.animSize = parsed.animSize;
            if (parsed.fadeInEnabled !== undefined) arrowSettings.fadeInEnabled = parsed.fadeInEnabled;
            if (parsed.fadeInDuration !== undefined) arrowSettings.fadeInDuration = parsed.fadeInDuration;
            if (parsed.smoothness !== undefined) arrowSettings.smoothness = parsed.smoothness;
            if (parsed.closed !== undefined) arrowSettings.closed = parsed.closed;
            if (parsed.deactivateClickSelect !== undefined) arrowSettings.deactivateClickSelect = parsed.deactivateClickSelect;
            if (parsed.pacmanDots !== undefined) arrowSettings.pacmanDots = parsed.pacmanDots;
            if (parsed.pacmanSize !== undefined) arrowSettings.pacmanSize = parsed.pacmanSize;
            if (parsed.pacmanDotRatio !== undefined) arrowSettings.pacmanDotRatio = parsed.pacmanDotRatio;
        }
    } catch (e) {}
}

function saveSettings() {
    try {
        localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(arrowSettings));
    } catch (e) {}
}

// 恢复默认设置
function resetArrowSettings() {
    // 重置设置对象
    Object.keys(DEFAULT_ARROW_SETTINGS).forEach(key => {
        arrowSettings[key] = DEFAULT_ARROW_SETTINGS[key];
    });
    localStorage.removeItem(STORAGE_SETTINGS_KEY);

    if (!toolbarElement) return;

    // 更新各控件
    const shapeSelect = toolbarElement.querySelector("#xzg-shape-select");
    if (shapeSelect) shapeSelect.value = arrowSettings.shapeType;

    const lineStyleSelect = toolbarElement.querySelector("#xzg-linestyle-select");
    if (lineStyleSelect) lineStyleSelect.value = arrowSettings.lineStyle;

    const animSelect = toolbarElement.querySelector(".xzg-arrow-anim-select");
    if (animSelect) animSelect.value = arrowSettings.animType;

    const colorInput = toolbarElement.querySelector(".xzg-arrow-color-input");
    if (colorInput) colorInput.value = arrowSettings.color;

    // 更新滑块
    const sliders = [
        [".xzg-arrow-width-slider", ".xzg-arrow-width-value", arrowSettings.lineWidth],
        [".xzg-arrow-opacity-slider", ".xzg-arrow-opacity-value", Math.round(arrowSettings.opacity * 100)],
        [".xzg-arrow-head-slider", ".xzg-arrow-head-value", arrowSettings.arrowSize],
        [".xzg-arrow-dashgap-slider", ".xzg-arrow-dashgap-value", arrowSettings.dashGap],
        [".xzg-arrow-radius-slider", ".xzg-arrow-radius-value", arrowSettings.borderRadius],
        [".xzg-arrow-smoothness-slider", null, arrowSettings.smoothness],
        [".xzg-arrow-anim-speed-slider", ".xzg-arrow-anim-speed-value", arrowSettings.animSpeed],
        [".xzg-arrow-anim-count-slider", ".xzg-arrow-anim-count-value", arrowSettings.animCount],
        [".xzg-arrow-anim-size-slider", ".xzg-arrow-anim-size-value", arrowSettings.animSize],
        [".xzg-arrow-fadein-slider", ".xzg-arrow-fadein-value", arrowSettings.fadeInDuration]
    ];
    sliders.forEach(([sliderSel, valueSel, val]) => {
        const slider = toolbarElement.querySelector(sliderSel);
        if (slider) slider.value = val;
        if (valueSel) {
            const display = toolbarElement.querySelector(valueSel);
            if (display) {
                if (valueSel.includes("fadein-value")) {
                    display.textContent = (val / 1000).toFixed(1) + 's';
                } else {
                    display.textContent = val;
                }
            }
        }
    });

    // 更新开关
    const updateToggle = (btnSel, stateSel, isOn) => {
        const btn = toolbarElement.querySelector(btnSel);
        if (btn) {
            btn.dataset.checked = isOn ? 'true' : 'false';
            const track = btn.querySelector('[class$="-track"]');
            const thumb = btn.querySelector('[class$="-thumb"]');
            if (track) track.style.background = isOn ? '#4CAF50' : '#666666';
            if (thumb) thumb.style.left = isOn ? '14px' : '2px';
        }
        if (stateSel) {
            const state = toolbarElement.querySelector(stateSel);
            if (state) {
                state.textContent = isOn ? xzgT("开", "ON") : xzgT("关", "OFF");
                state.style.color = isOn ? '#4CAF50' : '#999';
            }
        }
    };
    updateToggle(".xzg-arrow-fadein-toggle", null, arrowSettings.fadeInEnabled);
    updateToggle(".xzg-arrow-deactivate-toggle", ".xzg-arrow-deactivate-state", arrowSettings.deactivateClickSelect);
    updateToggle(".xzg-arrow-closed-toggle", ".xzg-arrow-closed-state", arrowSettings.closed);

    // 渐入滑块透明度
    const fadeInSlider = toolbarElement.querySelector(".xzg-arrow-fadein-slider");
    const fadeInValue = toolbarElement.querySelector(".xzg-arrow-fadein-value");
    const fadeInOpacity = arrowSettings.fadeInEnabled ? '1' : '0.4';
    if (fadeInSlider) fadeInSlider.style.opacity = fadeInOpacity;
    if (fadeInValue) fadeInValue.style.opacity = fadeInOpacity;

    // 模式按钮
    toolbarElement.querySelectorAll(".xzg-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === arrowSettings.shapeMode));

    // 更新形状相关行的显示
    const shape = arrowSettings.shapeType;
    const modeRow = toolbarElement.querySelector("#xzg-arrow-mode-row");
    if (modeRow) {
        const noMode = shape === "arrow" || shape === "bezier" || shape === "freehand";
        modeRow.style.display = noMode ? "none" : "";
        if (noMode) arrowSettings.shapeMode = "border";
    }
    const radiusRow = toolbarElement.querySelector("#xzg-arrow-radius-row");
    if (radiusRow) radiusRow.style.display = shape === "rectangle" ? "" : "none";
    const smoothnessRow = toolbarElement.querySelector("#xzg-arrow-smoothness-row");
    if (smoothnessRow) smoothnessRow.style.display = shape === "freehand" ? "" : "none";
    const closedRow = toolbarElement.querySelector("#xzg-arrow-closed-row");
    if (closedRow) closedRow.style.display = shape === "bezier" ? "" : "none";
    const headRow = toolbarElement.querySelector("#xzg-arrow-head-row");
    if (headRow) headRow.style.display = (shape === "arrow" || shape === "bezier") ? "" : "none";
    const dashgapRow = toolbarElement.querySelector("#xzg-arrow-dashgap-row");
    if (dashgapRow) dashgapRow.style.display = arrowSettings.lineStyle === "solid" ? "none" : "flex";
    const animSpeedRow = toolbarElement.querySelector("#xzg-arrow-anim-speed-row");
    if (animSpeedRow) animSpeedRow.style.display = arrowSettings.animType !== "none" ? "" : "none";
    const animCountRow = toolbarElement.querySelector("#xzg-arrow-anim-count-row");
    if (animCountRow) {
        animCountRow.style.display = (arrowSettings.animType !== "none" && arrowSettings.animType !== "energy" && arrowSettings.animType !== "pulse" && arrowSettings.animType !== "pacman") ? "" : "none";
    }
    const animSizeRow = toolbarElement.querySelector("#xzg-arrow-anim-size-row");
    if (animSizeRow) animSizeRow.style.display = (arrowSettings.animType !== "none" && arrowSettings.animType !== "pacman") ? "" : "none";
    const pacmanDotsRow = toolbarElement.querySelector("#xzg-arrow-pacman-dots-row");
    if (pacmanDotsRow) pacmanDotsRow.style.display = arrowSettings.animType === "pacman" ? "" : "none";
    const pacmanSizeRow = toolbarElement.querySelector("#xzg-arrow-pacman-size-row");
    if (pacmanSizeRow) pacmanSizeRow.style.display = arrowSettings.animType === "pacman" ? "" : "none";
    const pacmanRatioRow = toolbarElement.querySelector("#xzg-arrow-pacman-ratio-row");
    if (pacmanRatioRow) pacmanRatioRow.style.display = arrowSettings.animType === "pacman" ? "" : "none";

    // 如果选中了绘图，批量恢复所有选中绘图参数为默认
    if (hasSelection()) {
        const selIndices = getSelectedIndices();
        for (const idx of selIndices) {
            const arrow = arrows[idx];
            arrow.color = DEFAULT_ARROW_SETTINGS.color;
            arrow.lineWidth = DEFAULT_ARROW_SETTINGS.lineWidth;
            arrow.arrowSize = DEFAULT_ARROW_SETTINGS.arrowSize;
            arrow.opacity = DEFAULT_ARROW_SETTINGS.opacity;
            arrow.borderRadius = DEFAULT_ARROW_SETTINGS.borderRadius;
            arrow.lineStyle = DEFAULT_ARROW_SETTINGS.lineStyle;
            arrow.animType = DEFAULT_ARROW_SETTINGS.animType;
            arrow.animSpeed = DEFAULT_ARROW_SETTINGS.animSpeed;
            arrow.animCount = DEFAULT_ARROW_SETTINGS.animCount;
            arrow.animSize = DEFAULT_ARROW_SETTINGS.animSize;
            if (arrow.hasOwnProperty("pacmanDots")) arrow.pacmanDots = DEFAULT_ARROW_SETTINGS.pacmanDots;
            if (arrow.hasOwnProperty("pacmanSize")) arrow.pacmanSize = DEFAULT_ARROW_SETTINGS.pacmanSize;
            if (arrow.hasOwnProperty("pacmanDotRatio")) arrow.pacmanDotRatio = DEFAULT_ARROW_SETTINGS.pacmanDotRatio;
            if (arrow.hasOwnProperty("closed")) arrow.closed = DEFAULT_ARROW_SETTINGS.closed;
            if (arrow.hasOwnProperty("smoothness")) arrow.smoothness = DEFAULT_ARROW_SETTINGS.smoothness;
            // 如果形状是箭头/曲线，模式强制设为 border
            if (arrow.type === "arrow" || arrow.type === "bezier" || arrow.type === "freehand") {
                arrow.mode = "border";
            } else {
                arrow.mode = DEFAULT_ARROW_SETTINGS.shapeMode;
            }
        }
        renderArrows();
        recordState(xzgT("恢复默认参数", "Reset to defaults"));
    }
    saveSettings();
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

// 使用说明弹窗
function showArrowHelp() {
    const existing = document.querySelector(".xzg-arrow-help-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "xzg-arrow-help-overlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:100002;";

    const dialog = document.createElement("div");
    dialog.className = "xzg-arrow-help-dialog";
    dialog.style.cssText = `
        background:var(--comfy-menu-bg,#2a2a2a);border:1px solid var(--border-color,#555);
        border-radius:8px;min-width:440px;max-width:560px;max-height:86vh;
        box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;
    `;

    dialog.innerHTML = [
        '<div class="xzg-arrow-help-title">' + xzgT("小珠光箭头工具 · 使用说明", "Arrow Tool · Help") + '</div>',
        '<div class="xzg-arrow-help-body">',
        '<h4>' + xzgT("打开 / 关闭面板", "Open / Close Panel") + '</h4>',
        '<ul>',
        '<li>' + xzgT("快捷键：T（默认），点击标题栏「快捷键」按钮可自定义", 'Shortcut: T (default); click the "Shortcut" button to customize') + '</li>',
        '<li>' + xzgT("点击面板底部「确定」按钮关闭面板", 'Click the "OK" button at the bottom to close the panel') + '</li>',
        '</ul>',
        '<h4>' + xzgT("绘制形状", "Draw Shapes") + '</h4>',
        '<ul>',
        '<li>' + xzgT("选择形状类型后，在画布上拖拽即可绘制", "Select a shape type, then drag on the canvas to draw") + '</li>',
        '<li><b>' + xzgT("箭头", "Arrow") + '</b>：' + xzgT("直线箭头，支持箭头头部大小调节", "Straight arrow with adjustable head size") + '</li>',
        '<li><b>' + xzgT("曲线", "Curve") + '</b>：' + xzgT("点击画布打点，双击结束绘制，支持闭合", "Click to place points, double-click to finish; supports closed curves") + '</li>',
        '<li><b>' + xzgT("手绘", "Freehand") + '</b>：' + xzgT("自由绘制，支持平滑度调节", "Free-form drawing with adjustable smoothness") + '</li>',
        '<li><b>' + xzgT("矩形 / 椭圆 / 圆形", "Rect / Oval / Circle") + '</b>：' + xzgT("拖拽绘制，支持边框 / 填充两种模式", "Drag to draw; supports border and fill modes") + '</li>',
        '</ul>',
        '<h4>' + xzgT("编辑已有绘图", "Edit Existing Drawings") + '</h4>',
        '<ul>',
        '<li>' + xzgT("选中已有绘图，可修改颜色、线宽、透明度、特效等参数，不可修改现有形状，比如将箭头改为矩形", "Select an existing drawing to adjust color, line width, opacity, effects, etc.; shape cannot be changed, e.g. arrow cannot be changed to rectangle") + '</li>',
        '<li>' + xzgT("选中绘图后，右侧「▣」按钮可将当前参数应用到所有绘图", 'After selecting a drawing, click the "▣" button to apply that parameter to all drawings') + '</li>',
        '</ul>',
        '<h4>' + xzgT("参数说明", "Parameter Guide") + '</h4>',
        '<ul>',
        '<li><b>' + xzgT("颜色", "Color") + '</b>：' + xzgT("绘图颜色", "Drawing color") + '</li>',
        '<li><b>' + xzgT("线宽", "Width") + '</b>：' + xzgT("线条粗细", "Line thickness") + '</li>',
        '<li><b>' + xzgT("透明度", "Opacity") + '</b>：' + xzgT("整体透明度", "Overall transparency") + '</li>',
        '<li><b>' + xzgT("箭头", "Head") + '</b>：' + xzgT("箭头头部大小（仅箭头/曲线可用）", "Arrow head size (arrow/curve only)") + '</li>',
        '<li><b>' + xzgT("圆角", "Radius") + '</b>：' + xzgT("矩形圆角大小", "Rectangle corner radius") + '</li>',
        '<li><b>' + xzgT("平滑", "Smooth") + '</b>：' + xzgT("手绘线条平滑幅度", "Freehand smoothness") + '</li>',
        '<li><b>' + xzgT("线型", "Line") + '</b>：' + xzgT("实线 / 虚线 / 圆点虚线", "Solid / Dashed / Dotted") + '</li>',
        '<li><b>' + xzgT("间距", "Gap") + '</b>：' + xzgT("虚线/圆点的间距倍数", "Dash/dot gap multiplier") + '</li>',
        '<li><b>' + xzgT("特效", "Effect") + '</b>：' + xzgT("动画特效类型及参数（速度、数量、大小、淡入）", "Animation effect type and parameters (speed, count, size, fade-in)") + '</li>',
        '<li><b>' + xzgT("钝化激活", "Deactivate") + '</b>：' + xzgT("开启后，只能通过快捷键 T 打开面板后点选绘图内容，无法在画布上直接点选激活", "When enabled, drawings can only be selected after opening the panel via shortcut T; direct canvas click selection is disabled") + '</li>',
        '</ul>',
        '</div>',
        '<div class="xzg-arrow-help-footer">',
        '<button class="xzg-arrow-help-btn-close" id="xzg-arrow-help-close">' + xzgT("明白了", "Got it") + '</button>',
        '</div>'
    ].join('\n');

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => {
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("pointerdown", closeOutside, true);
        overlay.remove();
    };

    const closeOutside = (e) => {
        if (!dialog.contains(e.target)) {
            close();
        }
    };

    overlay.querySelector("#xzg-arrow-help-close").addEventListener("click", close);

    dialog.addEventListener("mousedown", (e) => e.stopPropagation());
    dialog.addEventListener("pointerdown", (e) => e.stopPropagation());
    dialog.addEventListener("click", (e) => e.stopPropagation());

    document.addEventListener("pointerdown", closeOutside, true);

    const onKey = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    };
    document.addEventListener("keydown", onKey, true);
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
                <p style="margin-bottom: 16px; color: #aaaaaa; font-size: 13px; text-align: center;">${xzgT("请按下你想要的快捷键","Press the shortcut keys you want")}</p>
                <div style="text-align: center; margin-bottom: 16px;">
                    <div id="xzg-arrow-listen-display" style="
                        padding: 16px 24px;
                        background: #667eea;
                        border: 2px solid #667eea;
                        border-radius: 6px;
                        color: #aaaaaa;
                        font-size: 13px;
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
        width: 320px;
        min-width: 320px;
        background: rgb(30, 30, 30);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        color: #aaaaaa;
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
            <div class="xzg-arrow-header-btns">
                <button class="xzg-arrow-help-btn" id="xzg-arrow-help-btn" title="${xzgT("使用说明", "Usage Guide")}">📖 ${xzgT("说明","Help")}</button>
                <button class="xzg-arrow-shortcut-btn" id="xzg-arrow-shortcut-btn" title="${xzgT("点击修改快捷键", "Click to change shortcut")}"></button>
            </div>
        </div>
        <div class="xzg-arrow-content">
            <div class="xzg-arrow-select-row">
                <div class="xzg-arrow-select-cell">
                    <label>${xzgT("形状", "Shape")}</label>
                    <select class="xzg-shape-select" id="xzg-shape-select">
                        <option value="freehand" ${arrowSettings.shapeType === "freehand" ? "selected" : ""}>${xzgT("手绘", "Freehand")}</option>
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
            <div class="xzg-arrow-mode-row" id="xzg-arrow-mode-row" style="${(arrowSettings.shapeType === "arrow" || arrowSettings.shapeType === "bezier" || arrowSettings.shapeType === "freehand") ? "display:none;" : ""}">
                <button class="xzg-mode-btn ${arrowSettings.shapeMode === "border" ? "active" : ""}" data-mode="border">${xzgT("边框", "Border")}</button>
                <button class="xzg-mode-btn ${arrowSettings.shapeMode === "fill" ? "active" : ""}" data-mode="fill">${xzgT("填充", "Fill")}</button>
            </div>
            <div class="xzg-arrow-section">
                <div class="xzg-arrow-basic-group">
                <div class="xzg-arrow-setting-row" id="xzg-arrow-smoothness-row" style="${arrowSettings.shapeType === "freehand" ? "" : "display:none;"}">
                    <label class="xzg-arrow-red-label">${xzgT("平滑", "Smooth")}</label>
                    <input type="range" class="xzg-arrow-smoothness-slider xzg-arrow-red-slider" min="5" max="100" value="${arrowSettings.smoothness}">
                    <span class="xzg-arrow-smoothness-value">${arrowSettings.smoothness}</span>
                    <button class="xzg-apply-prop-btn" data-prop="smoothness" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-closed-row" style="${arrowSettings.shapeType === "bezier" ? "" : "display:none;"}">
                    <label class="xzg-arrow-red-label">${xzgT("闭合", "Closed")}</label>
                    <button type="button" class="xzg-arrow-closed-toggle" data-checked="${arrowSettings.closed ? 'true' : 'false'}" style="background:none;border:none;padding:0;cursor:pointer;display:inline-flex;align-items:center;">
                        <span class="xzg-closed-toggle-track" style="position:relative;display:inline-block;width:32px;height:20px;border-radius:10px;background:${arrowSettings.closed ? '#4CAF50' : '#666666'};transition:background 0.2s;">
                            <span class="xzg-closed-toggle-thumb" style="position:absolute;top:2px;left:${arrowSettings.closed ? '14px' : '2px'};width:16px;height:16px;border-radius:8px;background:#fff;transition:left 0.2s;"></span>
                        </span>
                    </button>
                    <span class="xzg-arrow-closed-state" style="font-size:12px;color:${arrowSettings.closed ? '#4CAF50' : '#999'};min-width:20px;text-align:left;">${arrowSettings.closed ? xzgT("开", "ON") : xzgT("关", "OFF")}</span>
                </div>
                <div class="xzg-arrow-setting-row">
                    <label class="xzg-arrow-red-label">${xzgT("颜色", "Color")}</label>
                    <input type="color" class="xzg-arrow-color-input" value="${arrowSettings.color}">
                    <span class="xzg-arrow-color-placeholder"></span>
                    <button class="xzg-apply-prop-btn" data-prop="color" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row">
                    <label class="xzg-arrow-red-label">${xzgT("线宽", "Width")}</label>
                    <input type="range" class="xzg-arrow-width-slider xzg-arrow-red-slider" min="1" max="10" value="${arrowSettings.lineWidth}">
                    <span class="xzg-arrow-width-value">${arrowSettings.lineWidth}</span>
                    <button class="xzg-apply-prop-btn" data-prop="lineWidth" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row">
                    <label class="xzg-arrow-red-label">${xzgT("透明度", "Opacity")}</label>
                    <input type="range" class="xzg-arrow-opacity-slider xzg-arrow-red-slider" min="${arrowSettings.animType !== "none" ? 0 : 20}" max="100" value="${Math.round(arrowSettings.opacity * 100)}">
                    <span class="xzg-arrow-opacity-value">${Math.round(arrowSettings.opacity * 100)}</span>
                    <button class="xzg-apply-prop-btn" data-prop="opacity" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-dashgap-row" style="display:${(arrowSettings.lineStyle === "solid") ? "none" : "flex"};">
                    <label class="xzg-arrow-blue-label">${xzgT("间距", "Gap")}</label>
                    <input type="range" class="xzg-arrow-dashgap-slider xzg-arrow-blue-slider" min="1" max="10" value="${arrowSettings.dashGap}">
                    <span class="xzg-arrow-dashgap-value">${arrowSettings.dashGap}</span>
                    <button class="xzg-apply-prop-btn" data-prop="dashGap" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-head-row">
                    <label class="xzg-arrow-red-label">${xzgT("箭头", "Head")}</label>
                    <input type="range" class="xzg-arrow-head-slider xzg-arrow-red-slider" min="0" max="50" value="${arrowSettings.arrowSize}">
                    <span class="xzg-arrow-head-value">${arrowSettings.arrowSize}</span>
                    <button class="xzg-apply-prop-btn" data-prop="arrowSize" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-radius-row" style="display:none;">
                    <label class="xzg-arrow-red-label">${xzgT("圆角", "Radius")}</label>
                    <input type="range" class="xzg-arrow-radius-slider xzg-arrow-red-slider" min="0" max="50" value="${arrowSettings.borderRadius}">
                    <span class="xzg-arrow-radius-value">${arrowSettings.borderRadius}</span>
                    <button class="xzg-apply-prop-btn" data-prop="borderRadius" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-silver-group">
                <div class="xzg-arrow-setting-row" id="xzg-arrow-anim-row">
                    <label class="xzg-arrow-blue-label">${xzgT("特效", "FX")}</label>
                    <select class="xzg-arrow-anim-select" id="xzg-arrow-anim-select">
                        <option value="none" ${arrowSettings.animType === "none" ? "selected" : ""}>${xzgT("无", "None")}</option>
                        <option value="sparkle" ${arrowSettings.animType === "sparkle" ? "selected" : ""}>${xzgT("七彩星芒", "Sparkle")}</option>
                        <option value="pacman" ${arrowSettings.animType === "pacman" ? "selected" : ""}>${xzgT("吃豆人", "Pac-Man")}</option>
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
                    <button class="xzg-apply-prop-btn" data-prop="animType" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-anim-speed-row" style="display:none;">
                    <label class="xzg-arrow-blue-label">${xzgT("速度", "Speed")}</label>
                    <input type="range" class="xzg-arrow-anim-speed-slider xzg-arrow-blue-slider" min="1" max="100" value="${arrowSettings.animSpeed}">
                    <span class="xzg-arrow-anim-speed-value">${arrowSettings.animSpeed}</span>
                    <button class="xzg-apply-prop-btn" data-prop="animSpeed" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-anim-count-row" style="display:none;">
                    <label class="xzg-arrow-blue-label">${xzgT("数量", "Count")}</label>
                    <input type="range" class="xzg-arrow-anim-count-slider xzg-arrow-blue-slider" min="1" max="100" value="${arrowSettings.animCount}">
                    <span class="xzg-arrow-anim-count-value">${arrowSettings.animCount}</span>
                    <button class="xzg-apply-prop-btn" data-prop="animCount" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-anim-size-row" style="display:none;">
                    <label class="xzg-arrow-blue-label">${xzgT("大小", "Size")}</label>
                    <input type="range" class="xzg-arrow-anim-size-slider xzg-arrow-blue-slider" min="0" max="100" value="${arrowSettings.animSize}">
                    <span class="xzg-arrow-anim-size-value">${arrowSettings.animSize}</span>
                    <button class="xzg-apply-prop-btn" data-prop="animSize" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-pacman-dots-row" style="display:none;">
                    <label class="xzg-arrow-blue-label xzg-arrow-pacman-label">${xzgT("豆子数量", "Dot Count")}</label>
                    <input type="range" class="xzg-arrow-pacman-dots-slider xzg-arrow-blue-slider" min="2" max="500" value="${arrowSettings.pacmanDots}">
                    <span class="xzg-arrow-pacman-dots-value">${arrowSettings.pacmanDots}</span>
                    <button class="xzg-apply-prop-btn" data-prop="pacmanDots" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-pacman-size-row" style="display:none;">
                    <label class="xzg-arrow-blue-label xzg-arrow-pacman-label xzg-arrow-pacman-size-label">${xzgT("吃豆人大小", "Pac Size")}</label>
                    <input type="range" class="xzg-arrow-pacman-size-slider xzg-arrow-blue-slider" min="0" max="100" value="${arrowSettings.pacmanSize}">
                    <span class="xzg-arrow-pacman-size-value">${arrowSettings.pacmanSize}</span>
                    <button class="xzg-apply-prop-btn" data-prop="pacmanSize" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row" id="xzg-arrow-pacman-ratio-row" style="display:none;">
                    <label class="xzg-arrow-blue-label xzg-arrow-pacman-label">${xzgT("豆子比例", "Dot Ratio")}</label>
                    <input type="range" class="xzg-arrow-pacman-ratio-slider xzg-arrow-blue-slider" min="0" max="30" value="${arrowSettings.pacmanDotRatio}">
                    <span class="xzg-arrow-pacman-ratio-value">${arrowSettings.pacmanDotRatio}</span>
                    <button class="xzg-apply-prop-btn" data-prop="pacmanDotRatio" title="应用到所有">▣</button>
                </div>
                </div>
                <div class="xzg-arrow-copper-group">
                <div class="xzg-arrow-setting-row" id="xzg-arrow-fadein-row">
                    <label class="xzg-arrow-copper-label">${xzgT("渐入", "Fade")}</label>
                    <button type="button" class="xzg-arrow-fadein-toggle" data-checked="${arrowSettings.fadeInEnabled ? 'true' : 'false'}" style="background:none;border:none;padding:0;cursor:pointer;display:inline-flex;align-items:center;">
                        <span class="xzg-fadein-toggle-track" style="position:relative;display:inline-block;width:32px;height:20px;border-radius:10px;background:${arrowSettings.fadeInEnabled ? '#4CAF50' : '#666666'};transition:background 0.2s;">
                            <span class="xzg-fadein-toggle-thumb" style="position:absolute;top:2px;left:${arrowSettings.fadeInEnabled ? '14px' : '2px'};width:16px;height:16px;border-radius:8px;background:#fff;transition:left 0.2s;"></span>
                        </span>
                    </button>
                    <input type="range" class="xzg-arrow-fadein-slider xzg-arrow-copper-slider" style="min-width:0;opacity:${arrowSettings.fadeInEnabled ? '1' : '0.4'};" min="100" max="8000" step="100" value="${arrowSettings.fadeInDuration}">
                    <span class="xzg-arrow-fadein-value" style="min-width:36px;text-align:right;font-size:12px;padding-right:4px;box-sizing:content-box;opacity:${arrowSettings.fadeInEnabled ? '1' : '0.4'};">${(arrowSettings.fadeInDuration / 1000).toFixed(1)}s</span>
                    <button class="xzg-apply-prop-btn" data-prop="fadeInDuration" title="应用到所有">▣</button>
                </div>
                <div class="xzg-arrow-setting-row">
                    <label class="xzg-arrow-copper-label" style="white-space:nowrap;">${xzgT("钝化激活", "Deactivate")}</label>
                    <button type="button" class="xzg-arrow-deactivate-toggle" data-checked="${arrowSettings.deactivateClickSelect ? 'true' : 'false'}" style="background:none;border:none;padding:0;cursor:pointer;display:inline-flex;align-items:center;">
                        <span class="xzg-deactivate-toggle-track" style="position:relative;display:inline-block;width:32px;height:20px;border-radius:10px;background:${arrowSettings.deactivateClickSelect ? '#4CAF50' : '#666666'};transition:background 0.2s;">
                            <span class="xzg-deactivate-toggle-thumb" style="position:absolute;top:2px;left:${arrowSettings.deactivateClickSelect ? '14px' : '2px'};width:16px;height:16px;border-radius:8px;background:#fff;transition:left 0.2s;"></span>
                        </span>
                    </button>
                    <span class="xzg-arrow-deactivate-state" style="font-size:12px;color:${arrowSettings.deactivateClickSelect ? '#4CAF50' : '#999'};min-width:20px;text-align:left;">${arrowSettings.deactivateClickSelect ? xzgT("开", "ON") : xzgT("关", "OFF")}</span>
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
                            ${xzgT("清除全部", "Clear All")}
                        </button>

                    </div>
                </div>
            </div>
            <div class="xzg-arrow-confirm-row">
                <button class="xzg-arrow-confirm-btn" id="xzg-arrow-close-btn">${xzgT("确定", "OK")}</button>
                <button class="xzg-arrow-reset-btn" id="xzg-arrow-reset-btn">${xzgT("恢复默认", "Reset")}</button>
            </div>
        </div>
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
            color: #aaaaaa;
            font-size: 13px;
        }
        .xzg-arrow-shortcut-btn {
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.2);
            color: #aaaaaa;
            padding: 3px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            transition: all 0.15s;
            white-space: nowrap;
        }
        .xzg-arrow-shortcut-btn:hover {
            background: rgba(255,255,255,0.15);
            border-color: rgba(255,255,255,0.35);
            color: #aaaaaa;
        }
        .xzg-arrow-header-btns {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .xzg-arrow-help-btn {
            background: rgba(255, 215, 0, 0.1);
            border: 1px solid rgba(255, 215, 0, 0.3);
            color: #FFD700;
            padding: 3px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            transition: all 0.15s;
            white-space: nowrap;
            line-height: 1.4;
        }
        .xzg-arrow-help-btn:hover {
            background: rgba(255, 215, 0, 0.2);
            border-color: rgba(255, 215, 0, 0.5);
        }
        .xzg-arrow-confirm-row {
            padding: 0 8px 4px;
            display: flex;
            gap: 6px;
        }
        .xzg-arrow-confirm-btn {
            flex: 1;
            background: none;
            border: 1px solid rgba(255, 215, 0, 0.4);
            color: #FFD700;
            font-size: 13px;
            font-weight: 600;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.15s;
        }
        .xzg-arrow-confirm-btn:hover {
            background: rgba(255, 215, 0, 0.1);
            border-color: #FFD700;
        }
        .xzg-arrow-reset-btn {
            background: none;
            border: 1px solid rgba(255, 255, 255, 0.2);
            color: #ccc;
            font-size: 13px;
            padding: 8px 12px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.15s;
            white-space: nowrap;
        }
        .xzg-arrow-reset-btn:hover {
            background: rgba(255, 255, 255, 0.08);
            border-color: rgba(255, 255, 255, 0.4);
            color: #aaaaaa;
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
            color: #aaaaaa;
            font-size: 13px;
        }
        .xzg-arrow-select-cell select {
            flex: 1;
            min-width: 0;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.2);
            color: #aaaaaa;
            padding: 4px 4px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
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
            color: #aaaaaa;
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
            color: #aaaaaa;
            padding: 4px 2px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.15s;
            text-align: center;
        }
        .xzg-mode-btn:hover {
            background: rgba(255,255,255,0.1);
            color: #aaaaaa;
        }
        .xzg-mode-btn.active {
            background: rgba(102,126,234,0.25);
            border-color: #667eea;
            color: #aaaaaa;
        }
        .xzg-arrow-section {
            margin-bottom: 12px;
        }
        .xzg-arrow-section:last-child {
            margin-bottom: 0;
        }
        .xzg-arrow-section-label {
            font-size: 13px;
            color: #aaaaaa;
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
        .xzg-apply-prop-btn {
            background: none;
            border: none;
            color: #888;
            cursor: pointer;
            font-size: 13px;
            padding: 0;
            width: 20px;
            text-align: center;
            line-height: 1;
            flex-shrink: 0;
            opacity: 0.5;
            transition: opacity 0.2s, color 0.2s;
        }
        .xzg-apply-prop-btn:hover {
            opacity: 1;
            color: #4CAF50;
        }
        .xzg-arrow-setting-row [class$="-value"] {
            display: none !important;
        }
        .xzg-arrow-spacer {
            width: 20px;
            flex-shrink: 0;
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
            color: #aaaaaa;
        }
        .xzg-arrow-silver-group {
            border: 1px solid #C0C0C0;
            border-radius: 4px;
            padding: 6px 8px;
            margin-bottom: 8px;
        }
        .xzg-arrow-silver-group .xzg-arrow-setting-row .xzg-arrow-blue-label {
            color: #aaaaaa !important;
        }
        .xzg-arrow-copper-group {
            border: 1px solid #B87333;
            border-radius: 4px;
            padding: 6px 8px;
            margin-bottom: 8px;
        }
        .xzg-arrow-copper-group .xzg-arrow-setting-row .xzg-arrow-copper-label {
            color: #aaaaaa !important;
            min-width: 64px;
            font-size: 13px;
        }
        .xzg-arrow-copper-slider::-webkit-slider-thumb {
            background: #B87333 !important;
        }
        .xzg-arrow-copper-slider::-moz-range-thumb {
            background: #B87333 !important;
        }
        .xzg-arrow-blue-slider::-webkit-slider-thumb {
            background: #6699FF !important;
        }
        .xzg-arrow-blue-slider::-moz-range-thumb {
            background: #6699FF !important;
        }
        .xzg-arrow-anim-select {
            color: #aaaaaa !important;
            font-size: 13px;
            border: 1px solid rgba(255,255,255,0.2) !important;
            background: #000 !important;
        }
        .xzg-arrow-anim-select option {
            background: #000 !important;
            color: #aaaaaa !important;
        }
        .xzg-arrow-setting-row label {
            width: 50px;
            color: #aaaaaa;
            font-size: 13px;
        }
        .xzg-arrow-pacman-label {
            font-size: 13px;
            white-space: nowrap;
        }
        .xzg-arrow-setting-row .xzg-arrow-pacman-size-label {
            font-size: 13px;
            white-space: nowrap;
        }
        .xzg-arrow-red-label {
            color: #aaaaaa !important;
        }
        .xzg-arrow-red-slider::-webkit-slider-thumb {
            background: #FF4444 !important;
        }
        .xzg-arrow-red-slider::-moz-range-thumb {
            background: #FF4444 !important;
        }
        .xzg-arrow-green-label {
            color: #aaaaaa !important;
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
            color: #aaaaaa;
            font-size: 13px;
            padding-right: 4px;
            box-sizing: content-box;
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
            justify-content: center;
        }
        .xzg-arrow-action-row .xzg-arrow-action-btn {
            flex: 1;
        }
        .xzg-arrow-action-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #aaaaaa;
            padding: 6px 8px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.15s;
            font-size: 13px;
        }
        .xzg-arrow-action-btn:hover:not(:disabled) {
            background: rgba(255, 255, 255, 0.1);
            color: #aaaaaa;
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
        }
        /* 使用说明弹窗 */
        .xzg-arrow-help-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 100002;
        }
        .xzg-arrow-help-dialog {
            background: var(--comfy-menu-bg, #2a2a2a);
            border: 1px solid var(--border-color, #555);
            border-radius: 8px;
            min-width: 440px;
            max-width: 560px;
            max-height: 86vh;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            display: flex;
            flex-direction: column;
        }
        .xzg-arrow-help-title {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 14px 16px;
            font-size: 13px;
            font-weight: bold;
            color: #aaaaaa;
            border-bottom: 1px solid var(--border-color, #444);
            text-align: center;
        }
        .xzg-arrow-help-body {
            padding: 16px 18px;
            max-height: 64vh;
            overflow-y: auto;
            line-height: 1.6;
            font-size: 13px;
            color: #ccc;
        }
        .xzg-arrow-help-body h4 {
            margin: 16px 0 6px;
            font-size: 13px;
            color: #FFD700;
            border-bottom: 1px solid rgba(255, 215, 0, 0.2);
            padding-bottom: 4px;
        }
        .xzg-arrow-help-body h4:first-child { margin-top: 0; }
        .xzg-arrow-help-body ul { margin: 4px 0; padding-left: 20px; }
        .xzg-arrow-help-body li { margin: 3px 0; }
        .xzg-arrow-help-body b { color: #FFD700; }
        .xzg-arrow-help-body code {
            background: rgba(255, 255, 255, 0.1);
            padding: 1px 5px;
            border-radius: 3px;
            font-size: 13px;
        }
        .xzg-arrow-help-footer {
            padding: 12px 16px;
            border-top: 1px solid var(--border-color, #444);
            display: flex;
            justify-content: center;
        }
        .xzg-arrow-help-btn-close {
            background: transparent;
            border: 1px solid #FFD700;
            color: #FFD700;
            padding: 6px 24px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            transition: all 0.15s;
        }
        .xzg-arrow-help-btn-close:hover {
            background: rgba(255, 215, 0, 0.15);
        }
        `;
    document.head.appendChild(style);
}

function setupToolbarEvents() {
    if (!toolbarElement) return;

    // 使用说明按钮
    const helpBtn = toolbarElement.querySelector("#xzg-arrow-help-btn");
    helpBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        console.log("[小珠光箭头] 点击使用说明按钮");
        try {
            showArrowHelp();
        } catch (err) {
            console.error("[小珠光箭头] showArrowHelp 错误:", err);
            alert("说明弹窗错误: " + err.message);
        }
    });

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

    // 恢复默认按钮
    const resetBtn = toolbarElement.querySelector("#xzg-arrow-reset-btn");
    resetBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        resetArrowSettings();
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
            const noMode = shape === "arrow" || shape === "bezier" || shape === "freehand";
            modeRow.style.display = noMode ? "none" : "";
            if (noMode) arrowSettings.shapeMode = "border";
        }
        // 圆角行仅矩形显示
        const radiusRow = toolbarElement.querySelector("#xzg-arrow-radius-row");
        if (radiusRow) {
            radiusRow.style.display = shape === "rectangle" ? "" : "none";
        }
        // 平滑幅度滑条仅手绘显示
        const smoothnessRow = toolbarElement.querySelector("#xzg-arrow-smoothness-row");
        if (smoothnessRow) {
            smoothnessRow.style.display = shape === "freehand" ? "" : "none";
        }
        // 闭合开关仅曲线显示
        const closedRow = toolbarElement.querySelector("#xzg-arrow-closed-row");
        if (closedRow) {
            closedRow.style.display = shape === "bezier" ? "" : "none";
        }
        // 箭头大小仅箭头/曲线显示，闭合曲线时隐藏
        const headRow = toolbarElement.querySelector("#xzg-arrow-head-row");
        if (headRow) {
            const showHead = shape === "arrow" || (shape === "bezier" && !arrowSettings.closed);
            headRow.style.display = showHead ? "" : "none";
        }
        // 更新模式按钮激活状态
        toolbarElement.querySelectorAll(".xzg-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === arrowSettings.shapeMode));
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
        if (applyToSelectedArrows("lineStyle", arrowSettings.lineStyle)) {
            renderArrows();
            recordState(xzgT("切换线型", "Change line style"));
        }
        saveSettings();
    });

    // 虚线/圆点间距滑块
    const dashGapSlider = toolbarElement.querySelector(".xzg-arrow-dashgap-slider");
    dashGapSlider?.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        const display = toolbarElement.querySelector(".xzg-arrow-dashgap-value");
        if (display) display.textContent = val;
        if (applyToSelectedArrows("dashGap", val)) {
            renderArrows();
        } else {
            arrowSettings.dashGap = val;
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
            if (applyToSelectedArrows("mode", arrowSettings.shapeMode)) {
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
        applyToSelectedArrows("color", e.target.value);
        renderArrows();
        saveSettings();
    });
    colorInput?.addEventListener("change", () => {
        if (hasSelection()) {
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
        applyToSelectedArrows("lineWidth", arrowSettings.lineWidth);
        renderArrows();
        saveSettings();
    });
    widthSlider?.addEventListener("change", () => {
        if (hasSelection()) {
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
        applyToSelectedArrows("arrowSize", arrowSettings.arrowSize);
        renderArrows();
        saveSettings();
    });
    headSlider?.addEventListener("change", () => {
        if (hasSelection()) {
            recordState(xzgT("修改箭头大小", "Change arrow size"));
        }
    });

    // 透明度滑块
    const opacitySlider = toolbarElement.querySelector(".xzg-arrow-opacity-slider");
    opacitySlider?.addEventListener("input", (e) => {
        arrowSettings.opacity = parseInt(e.target.value) / 100;
        const display = toolbarElement.querySelector(".xzg-arrow-opacity-value");
        if (display) display.textContent = `${e.target.value}`;
        if (currentArrow) {
            currentArrow.opacity = arrowSettings.opacity;
        }
        applyToSelectedArrows("opacity", arrowSettings.opacity);
        renderArrows();
        saveSettings();
    });
    opacitySlider?.addEventListener("change", () => {
        if (hasSelection()) {
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
        applyToSelectedArrows("borderRadius", arrowSettings.borderRadius);
        renderArrows();
        saveSettings();
    });
    radiusSlider?.addEventListener("change", () => {
        if (hasSelection()) {
            recordState(xzgT("修改矩形圆角", "Change rectangle radius"));
        }
    });

    // 平滑幅度滑块（仅手绘模式）
    const smoothnessSlider = toolbarElement.querySelector(".xzg-arrow-smoothness-slider");
    smoothnessSlider?.addEventListener("input", (e) => {
        arrowSettings.smoothness = parseInt(e.target.value);
        const display = toolbarElement.querySelector(".xzg-arrow-smoothness-value");
        if (display) display.textContent = arrowSettings.smoothness;
        // 当前正在绘制的手绘，更新实时平滑
        if (currentArrow && currentArrow.type === "freehand" && currentArrow.rawPoints) {
            currentArrow.points = smoothFreehandPoints(currentArrow.rawPoints);
        }
        renderArrows();
        saveSettings();
    });
    smoothnessSlider?.addEventListener("change", () => {
        if (hasSelection()) {
            recordState(xzgT("修改平滑幅度", "Change smoothness"));
        }
    });

    // 闭合开关（仅曲线模式）
    const closedToggle = toolbarElement.querySelector(".xzg-arrow-closed-toggle");
    closedToggle?.addEventListener("click", (e) => {
        e.stopPropagation();
        const isChecked = closedToggle.dataset.checked === "true";
        const newVal = !isChecked;
        arrowSettings.closed = newVal;
        closedToggle.dataset.checked = newVal ? "true" : "false";
        const track = closedToggle.querySelector(".xzg-closed-toggle-track");
        const thumb = closedToggle.querySelector(".xzg-closed-toggle-thumb");
        if (track) track.style.background = newVal ? "#4CAF50" : "#666666";
        if (thumb) thumb.style.left = newVal ? "14px" : "2px";
        const stateLabel = toolbarElement.querySelector(".xzg-arrow-closed-state");
        if (stateLabel) {
            stateLabel.textContent = newVal ? xzgT("开", "ON") : xzgT("关", "OFF");
            stateLabel.style.color = newVal ? "#4CAF50" : "#999";
        }
        applyToSelectedArrows("closed", arrowSettings.closed);
        // 闭合曲线时隐藏箭头大小滑条
        const headRow = toolbarElement.querySelector("#xzg-arrow-head-row");
        if (headRow) {
            const showHead = arrowSettings.shapeType === "arrow" || (arrowSettings.shapeType === "bezier" && !newVal);
            headRow.style.display = showHead ? "" : "none";
        }
        renderArrows();
        saveSettings();
        if (hasSelection()) {
            recordState(xzgT("切换闭合", "Toggle closed"));
        }
    });

    // 特效动画下拉
    const animSelect = toolbarElement.querySelector(".xzg-arrow-anim-select");
    const animSpeedRow = toolbarElement.querySelector("#xzg-arrow-anim-speed-row");
    const animCountRow = toolbarElement.querySelector("#xzg-arrow-anim-count-row");
    const animCountSlider = toolbarElement.querySelector(".xzg-arrow-anim-count-slider");
    const animSizeRow = toolbarElement.querySelector("#xzg-arrow-anim-size-row");
    const animPacmanDotsRow = toolbarElement.querySelector("#xzg-arrow-pacman-dots-row");
    const animPacmanSizeRow = toolbarElement.querySelector("#xzg-arrow-pacman-size-row");
    const animPacmanRatioRow = toolbarElement.querySelector("#xzg-arrow-pacman-ratio-row");
    const showAnimRows = (type) => {
        const show = type !== "none";
        const isPacman = type === "pacman";
        if (animSpeedRow) animSpeedRow.style.display = show ? "flex" : "none";
        const showCount = show && type !== "energy" && type !== "pulse" && !isPacman;
        if (animCountRow) animCountRow.style.display = showCount ? "flex" : "none";
        // 吃豆人时隐藏通用大小，显示专用大小滑条
        if (animSizeRow) animSizeRow.style.display = show && !isPacman ? "flex" : "none";
        if (animPacmanDotsRow) animPacmanDotsRow.style.display = isPacman ? "flex" : "none";
        if (animPacmanSizeRow) animPacmanSizeRow.style.display = isPacman ? "flex" : "none";
        if (animPacmanRatioRow) animPacmanRatioRow.style.display = isPacman ? "flex" : "none";
        // 吃豆人时数量上限改为500
        if (animCountSlider) {
            if (isPacman) {
                animCountSlider.max = 500;
            } else {
                animCountSlider.max = 100;
            }
        }
    };
    animSelect?.addEventListener("change", (e) => {
        arrowSettings.animType = e.target.value;
        showAnimRows(arrowSettings.animType);
        // 开启特效时透明度最低可到0
        const opacitySlider = toolbarElement.querySelector(".xzg-arrow-opacity-slider");
        const opacityDisplay = toolbarElement.querySelector(".xzg-arrow-opacity-value");
        if (opacitySlider) opacitySlider.min = arrowSettings.animType !== "none" ? "0" : "20";
        // 切换为无特效时，若透明度低于20%则强制恢复为20%，防止内容不可见
        if (arrowSettings.animType === "none" && arrowSettings.opacity < 0.2) {
            arrowSettings.opacity = 0.2;
            if (opacitySlider) opacitySlider.value = "20";
            if (opacityDisplay) opacityDisplay.textContent = "20";
        }
        if (currentArrow) {
            currentArrow.animType = arrowSettings.animType;
            currentArrow.opacity = arrowSettings.opacity;
        }
        if (hasSelection()) {
            const selIndices = getSelectedIndices();
            for (const idx of selIndices) {
                arrows[idx].animType = arrowSettings.animType;
                arrows[idx].opacity = arrowSettings.opacity;
            }
            recordState(xzgT("修改特效动画", "Change animation"));
        }
        if (arrowSettings.animType !== "none") {
            ensureAnimLoop();
        }
        renderArrows();
        saveSettings();
    });

    // 动画速度滑块（拖动时不实时渲染，松开后才生效）
    const animSpeedSlider = toolbarElement.querySelector(".xzg-arrow-anim-speed-slider");
    animSpeedSlider?.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        const display = toolbarElement.querySelector(".xzg-arrow-anim-speed-value");
        if (display) display.textContent = val;
    });
    animSpeedSlider?.addEventListener("change", (e) => {
        const val = parseInt(e.target.value);
        arrowSettings.animSpeed = val;
        if (currentArrow) currentArrow.animSpeed = val;
        applyToSelectedArrows("animSpeed", val);
        renderArrows();
        saveSettings();
    });

    // 动画数量滑块
    animCountSlider?.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        arrowSettings.animCount = val;
        const display = toolbarElement.querySelector(".xzg-arrow-anim-count-value");
        if (display) display.textContent = val;
        if (currentArrow) currentArrow.animCount = val;
        applyToSelectedArrows("animCount", val);
        renderArrows();
    });
    animCountSlider?.addEventListener("change", () => {
        saveSettings();
    });

    // 动画大小滑块
    const animSizeSlider = toolbarElement.querySelector(".xzg-arrow-anim-size-slider");
    animSizeSlider?.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        arrowSettings.animSize = val;
        const display = toolbarElement.querySelector(".xzg-arrow-anim-size-value");
        if (display) display.textContent = val;
        if (currentArrow) currentArrow.animSize = val;
        applyToSelectedArrows("animSize", val);
        renderArrows();
    });
    animSizeSlider?.addEventListener("change", () => {
        saveSettings();
    });

    // 吃豆人豆子数量滑条
    const pacmanDotsSlider = toolbarElement.querySelector(".xzg-arrow-pacman-dots-slider");
    pacmanDotsSlider?.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        arrowSettings.pacmanDots = val;
        const display = toolbarElement.querySelector(".xzg-arrow-pacman-dots-value");
        if (display) display.textContent = val;
        if (currentArrow) currentArrow.pacmanDots = val;
        applyToSelectedArrows("pacmanDots", val);
        renderArrows();
    });
    pacmanDotsSlider?.addEventListener("change", () => {
        saveSettings();
    });

    // 吃豆人大小滑条
    const pacmanSizeSlider = toolbarElement.querySelector(".xzg-arrow-pacman-size-slider");
    pacmanSizeSlider?.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        arrowSettings.pacmanSize = val;
        const display = toolbarElement.querySelector(".xzg-arrow-pacman-size-value");
        if (display) display.textContent = val;
        if (currentArrow) currentArrow.pacmanSize = val;
        applyToSelectedArrows("pacmanSize", val);
        renderArrows();
    });
    pacmanSizeSlider?.addEventListener("change", () => {
        saveSettings();
    });

    // 豆子比例滑条
    const pacmanRatioSlider = toolbarElement.querySelector(".xzg-arrow-pacman-ratio-slider");
    pacmanRatioSlider?.addEventListener("input", (e) => {
        const val = parseInt(e.target.value);
        arrowSettings.pacmanDotRatio = val;
        const display = toolbarElement.querySelector(".xzg-arrow-pacman-ratio-value");
        if (display) display.textContent = val;
        if (currentArrow) currentArrow.pacmanDotRatio = val;
        applyToSelectedArrows("pacmanDotRatio", val);
        renderArrows();
    });
    pacmanRatioSlider?.addEventListener("change", () => {
        saveSettings();
    });

    // 渐入开关
    const fadeInToggle = toolbarElement.querySelector(".xzg-arrow-fadein-toggle");
    const fadeInSlider = toolbarElement.querySelector(".xzg-arrow-fadein-slider");
    const fadeInValue = toolbarElement.querySelector(".xzg-arrow-fadein-value");
    const updateFadeInToggle = (enabled) => {
        fadeInToggle.dataset.checked = enabled ? 'true' : 'false';
        const track = fadeInToggle.querySelector('.xzg-fadein-toggle-track');
        const thumb = fadeInToggle.querySelector('.xzg-fadein-toggle-thumb');
        const label = fadeInToggle.querySelector('.xzg-fadein-toggle-label');
        if (track) track.style.background = enabled ? '#4CAF50' : '#666666';
        if (thumb) thumb.style.left = enabled ? '14px' : '2px';
        if (label) {
            label.textContent = enabled ? '开' : '关';
            label.style.color = enabled ? '#FFD700' : '#777';
        }
        if (fadeInSlider) fadeInSlider.style.opacity = enabled ? '1' : '0.4';
        if (fadeInValue) fadeInValue.style.opacity = enabled ? '1' : '0.4';
        arrowSettings.fadeInEnabled = enabled;
        // 关闭渐入时立即恢复可见
        if (!enabled && canvasElement) {
            canvasElement.style.transition = 'none';
            canvasElement.style.opacity = '1';
        }
    };
    fadeInToggle?.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOn = fadeInToggle.dataset.checked === 'true';
        updateFadeInToggle(!isOn);
        saveSettings();
    });

    // 钝化激活开关
    const deactivateToggle = toolbarElement.querySelector(".xzg-arrow-deactivate-toggle");
    deactivateToggle?.addEventListener("click", (e) => {
        e.stopPropagation();
        const isChecked = deactivateToggle.dataset.checked === "true";
        const newVal = !isChecked;
        arrowSettings.deactivateClickSelect = newVal;
        deactivateToggle.dataset.checked = newVal ? "true" : "false";
        const track = deactivateToggle.querySelector(".xzg-deactivate-toggle-track");
        const thumb = deactivateToggle.querySelector(".xzg-deactivate-toggle-thumb");
        if (track) track.style.background = newVal ? "#4CAF50" : "#666666";
        if (thumb) thumb.style.left = newVal ? "14px" : "2px";
        const stateLabel = toolbarElement.querySelector(".xzg-arrow-deactivate-state");
        if (stateLabel) {
            stateLabel.textContent = newVal ? xzgT("开", "ON") : xzgT("关", "OFF");
            stateLabel.style.color = newVal ? "#4CAF50" : "#999";
        }
        saveSettings();
    });

    // 渐入时长滑块
    fadeInSlider?.addEventListener("input", (e) => {
        const v = parseInt(e.target.value) || 1000;
        arrowSettings.fadeInDuration = v;
        const display = toolbarElement.querySelector(".xzg-arrow-fadein-value");
        if (display) display.textContent = (v / 1000).toFixed(1) + 's';
    });
    fadeInSlider?.addEventListener("change", () => {
        saveSettings();
    });

    // 单项应用到所有（通过事件委托监听 .xzg-apply-prop-btn 点击）
    toolbarElement.addEventListener("click", (e) => {
        const btn = e.target.closest(".xzg-apply-prop-btn");
        if (!btn) return;
        e.stopPropagation();
        const prop = btn.dataset.prop;
        if (!prop) return;
        if (!hasSelection()) return;
        const source = arrows[getFirstSelectedIndex()];
        if (!source || source[prop] === undefined) return;
        const val = source[prop];
        for (let i = 0; i < arrows.length; i++) {
            arrows[i][prop] = val;
        }
        renderArrows();
        recordState(xzgT("应用" + prop, "Apply " + prop));
    });

    // 清除按钮
    const clearBtn = toolbarElement.querySelector(".xzg-arrow-clear-btn");
    clearBtn?.addEventListener("click", clearAllArrows);

    // 删除选中按钮
    const deleteBtn = toolbarElement.querySelector(".xzg-arrow-delete-btn");
    deleteBtn?.addEventListener("click", deleteSelectedArrow);

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
        // 点击快捷键按钮或使用说明按钮不触发拖动
        if (e.target.closest("#xzg-arrow-shortcut-btn")) return;
        if (e.target.closest("#xzg-arrow-help-btn")) return;

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
    if (deleteBtn) deleteBtn.disabled = !hasSelection();
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
            if ((e.key === "Delete" || e.key === "Backspace") && hasSelection()) {
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

    // 设置变换追踪（含渐入检测）
    let lastTransformStr = "";
    let _arrowCanvasMoving = false;
    let _arrowMoveStopTimer = null;
    transformTrackerCleanup = createTransformTracker(() => {
        const transform = getTransform();
        const transformStr = `${transform.scale},${transform.offsetX},${transform.offsetY}`;
        const moved = transformStr !== lastTransformStr;
        if (moved) {
            lastTransformStr = transformStr;
            renderArrows();
        }
        // 渐入检测
        if (arrowSettings.fadeInEnabled && canvasElement) {
            if (moved) {
                if (!_arrowCanvasMoving) {
                    _arrowCanvasMoving = true;
                    canvasElement.style.transition = 'opacity 0s';
                    canvasElement.style.opacity = '0';
                }
                if (_arrowMoveStopTimer) {
                    clearTimeout(_arrowMoveStopTimer);
                    _arrowMoveStopTimer = null;
                }
                // 画布停止移动后延迟触发渐入
                _arrowMoveStopTimer = setTimeout(() => {
                    _arrowCanvasMoving = false;
                    const fadeDur = (arrowSettings.fadeInDuration || 1000) / 1000;
                    canvasElement.style.transition = `opacity ${fadeDur}s ease`;
                    canvasElement.style.opacity = '1';
                    _arrowMoveStopTimer = null;
                }, 150);
            }
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

    // 滑条拖拽时隐藏选中高亮，避免干扰调整时的实时预览
    // 使用捕获阶段确保在滑条自身处理器之前执行，避免事件顺序导致手柄闪烁/消失
    if (toolbarElement) {
        toolbarElement.addEventListener("input", (e) => {
            if (e.target.matches('input[type="range"]')) {
                _hideSelectionHighlight = true;
            }
        }, true);
        toolbarElement.addEventListener("change", (e) => {
            if (e.target.matches('input[type="range"]')) {
                _hideSelectionHighlight = false;
                renderArrows();
            }
        }, true);
    }

    // 页面关闭/刷新前确保箭头数据已同步到 graph.extra
    window.addEventListener('beforeunload', function () {
        syncArrowsToExtra();
    });

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
// 全局 API：供编组拖动时移动箭头
// ============================================================================

/**
 * 计算箭头的中心点（图坐标）
 * @param {Object} arrow - 箭头数据
 * @returns {{x: number, y: number} | null}
 */
function getArrowCenter(arrow) {
    if (arrow.points && arrow.points.length > 0) {
        const cx = arrow.points.reduce((s, p) => s + p.x, 0) / arrow.points.length;
        const cy = arrow.points.reduce((s, p) => s + p.y, 0) / arrow.points.length;
        return { x: cx, y: cy };
    }
    if (arrow.start && arrow.end) {
        return { x: (arrow.start.x + arrow.end.x) / 2, y: (arrow.start.y + arrow.end.y) / 2 };
    }
    return null;
}

/**
 * 获取中心点落在指定编组框内的箭头的初始位置快照
 * 返回快照数组，供编组拖动时计算偏移
 * @param {{x: number, y: number, w: number, h: number}} bounds - 编组框（图坐标）
 * @returns {Array<{index: number, startX: number, startY: number, ...}>}
 */
function getArrowStartsInBounds(bounds) {
    const snapshots = [];
    if (!bounds || arrows.length === 0) return snapshots;
    for (let i = 0; i < arrows.length; i++) {
        const arrow = arrows[i];
        const center = getArrowCenter(arrow);
        if (!center) continue;
        if (center.x >= bounds.x && center.x <= bounds.x + bounds.w &&
            center.y >= bounds.y && center.y <= bounds.y + bounds.h) {
            const snap = { index: i, start: { x: arrow.start?.x, y: arrow.start?.y } };
            if (arrow.end) snap.end = { x: arrow.end.x, y: arrow.end.y };
            if (arrow.points) snap.points = arrow.points.map(p => ({ x: p.x, y: p.y }));
            if (arrow.control) snap.control = { x: arrow.control.x, y: arrow.control.y };
            snapshots.push(snap);
        }
    }
    return snapshots;
}

/**
 * 根据快照将箭头移动到初始位置 + 偏移量的位置
 * @param {Array} snapshots - getArrowStartsInBounds 返回的快照
 * @param {number} dx - X 偏移量
 * @param {number} dy - Y 偏移量
 */
function applyArrowStarts(snapshots, dx, dy) {
    if (!snapshots || snapshots.length === 0) return;
    for (const snap of snapshots) {
        const arrow = arrows[snap.index];
        if (!arrow) continue;
        if (snap.points && arrow.points) {
            for (let j = 0; j < arrow.points.length; j++) {
                arrow.points[j].x = snap.points[j].x + dx;
                arrow.points[j].y = snap.points[j].y + dy;
            }
        }
        if (snap.start && arrow.start) {
            arrow.start.x = snap.start.x + dx;
            arrow.start.y = snap.start.y + dy;
        }
        if (snap.end && arrow.end) {
            arrow.end.x = snap.end.x + dx;
            arrow.end.y = snap.end.y + dy;
        }
        if (snap.control && arrow.control) {
            arrow.control.x = snap.control.x + dx;
            arrow.control.y = snap.control.y + dy;
        }
    }
    renderArrows();
    syncArrowsToExtra();
}

// 挂载到全局供编组模块调用
window.__xzg_getArrowStartsInBounds = getArrowStartsInBounds;
window.__xzg_applyArrowStarts = applyArrowStarts;

// ============================================================================
// 扩展注册
// ============================================================================

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.arrow",

    async setup() {
        waitForCanvasAndInitialize();
    }
});