import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { xzgT } from "./xzg_i18n.js";

const SEED_NODE_TYPE = "XiaozhuguangSeed";
const MAX_HISTORY = 20;
const STORAGE_KEY = "xzg_seed_history";
// 随机种子上限：2^50（与 rgthree 一致，JavaScript 安全整数范围内）
const RANDOM_MAX = 1125899906842624;

// ─── 历史种子存储 ───
// 历史格式：[{ seed: number, time: number(Date.now()) }, ...]
// 兼容旧格式：[number, number, ...]（自动转换）
function loadHistory() {
    try {
        const data = localStorage.getItem(STORAGE_KEY);
        if (!data) return [];
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) return [];
        // 兼容旧格式：纯数字自动转为 { seed, time: 0 }
        return parsed.map(item =>
            typeof item === "number" ? { seed: item, time: 0 } : item
        ).filter(item => item && typeof item.seed === "number");
    } catch { return []; }
}

function saveHistory(history) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
    } catch {}
}

function generateRandomSeed() {
    return Math.floor(Math.random() * RANDOM_MAX) + 1;
}

// 圆角矩形辅助函数（兼容旧版浏览器）
function _xzgRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// 格式化时间戳为 HH:MM:SS
function _formatTime(ts) {
    if (!ts) return "--:--:--";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 一次性刷新节点上所有 canvas 控件（多个 widget 状态同时变化时使用）
// Nodes 2.0 的 DOM canvas 靠 widget.triggerDraw 重绘，光调 setDirtyCanvas 不会更新画面。
function _xzgRefreshAll(n) {
    try {
        for (const w of n?.widgets ?? []) {
            if (typeof w?.triggerDraw === "function") {
                try { w.triggerDraw(); } catch {}
            }
        }
    } catch {}
    try { n?.setDirtyCanvas?.(true, true); } catch {}
}

// ─── 历史种子对话框 ───
function _xzgShowSeedHistory(node) {
    // 每次打开都从 localStorage 重新读取最新历史，确保多节点间同步
    const history = loadHistory();

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;";

    const dialog = document.createElement("div");
    dialog.style.cssText = "background:#2a2a2a;border:1px solid #555;border-radius:8px;padding:16px;min-width:320px;max-width:420px;box-shadow:0 4px 20px rgba(0,0,0,0.5);";

    const title = document.createElement("div");
    title.textContent = xzgT("历史种子", "Seed History");
    title.style.cssText = "color:#dcc85b;font-size:14px;font-weight:bold;margin-bottom:12px;text-align:center;";
    dialog.appendChild(title);

    const list = document.createElement("div");
    list.style.cssText = "max-height:320px;overflow-y:auto;";

    if (history.length === 0) {
        // 历史为空时显示提示
        const empty = document.createElement("div");
        empty.textContent = xzgT("暂无历史种子，执行一次生成后会自动记录", "No history yet. Run a generation to record seeds.");
        empty.style.cssText = "color:#888;font-size:12px;text-align:center;padding:24px 8px;";
        list.appendChild(empty);
    } else {
        history.forEach((item, i) => {
            const seed = item.seed;
            const timeStr = _formatTime(item.time);
            const row = document.createElement("div");
            row.style.cssText = "padding:6px 12px;color:#ddd;cursor:pointer;border-radius:4px;font-size:12px;display:flex;align-items:center;gap:8px;";
            row.innerHTML = `
                <span style="color:#888;min-width:24px;">${i + 1}.</span>
                <span style="color:#6699FF;font-family:monospace;min-width:72px;">${timeStr}</span>
                <span style="flex:1;text-align:right;font-family:monospace;color:#dcc85b;">${seed}</span>
            `;
            row.addEventListener("mouseenter", () => { row.style.background = "#3a3a3a"; });
            row.addEventListener("mouseleave", () => { row.style.background = ""; });
            row.addEventListener("click", () => {
                const sw = node.widgets?.find(w => w.name === "seed");
                const cw = node._xzgControlWidget;
                if (sw) {
                    sw.value = seed;
                    if (cw) {
                        cw.value = "fixed";  // 应用历史种子时切换为 fixed，避免后续生成改变种子
                    }
                    _xzgRefreshAll(node);
                }
                overlay.remove();
            });
            list.appendChild(row);
        });
    }
    dialog.appendChild(list);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;margin-top:12px;";

    if (history.length > 0) {
        const clearBtn = document.createElement("button");
        clearBtn.textContent = xzgT("清空", "Clear");
        clearBtn.style.cssText = "flex:1;padding:6px;background:#353535;color:#ff6b6b;border:1px solid #555;border-radius:4px;cursor:pointer;font-size:12px;";
        clearBtn.addEventListener("click", () => {
            node._xzgSeedHistory = [];
            saveHistory([]);
            overlay.remove();
        });
        btnRow.appendChild(clearBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.textContent = xzgT("关闭", "Close");
    closeBtn.style.cssText = "flex:1;padding:6px;background:#353535;color:#ddd;border:1px solid #555;border-radius:4px;cursor:pointer;font-size:12px;";
    closeBtn.addEventListener("click", () => overlay.remove());
    btnRow.appendChild(closeBtn);

    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

// ─── queuePrompt 拦截（只执行一次）───
// 注意：ComfyUI 新版可能不会自动调用 setup()，所以把拦截逻辑放在模块顶层执行
let _xzgQueuePromptIntercepted = false;
function _xzgInterceptQueuePrompt() {
    if (_xzgQueuePromptIntercepted) return;
    if (typeof api.queuePrompt !== "function") return;
    _xzgQueuePromptIntercepted = true;

    const origQueuePrompt = api.queuePrompt;
    api.queuePrompt = async function () {
        // 只记录历史种子。seed 修改走官方时序：afterQueued 回调（发送当前值 → 修改为下次准备）
        try {
            const nodes = app.graph?._nodes || [];
            const now = Date.now();
            for (const node of nodes) {
                if (node.type !== SEED_NODE_TYPE) continue;
                const sw = node.widgets?.find(w => w.name === "seed");
                if (!sw) continue;
                const seed = typeof sw.value === "number" ? sw.value : parseInt(sw.value, 10);
                if (isNaN(seed)) continue;

                let history = loadHistory();
                history = history.filter(item => item.seed !== seed);
                history.unshift({ seed, time: now });
                history = history.slice(0, MAX_HISTORY);
                saveHistory(history);
                node._xzgSeedHistory = history;
            }
        } catch (e) {
            console.warn("[小珠光] 记录种子历史失败:", e);
        }

        const result = origQueuePrompt.apply(this, arguments);

        // 排队后前端会按 control_after_generate 自动改写种子，
        // 自绘 canvas 不会自己刷新，这里补一次重绘，避免数值显示停在旧值。
        const repaint = () => {
            for (const node of app.graph?._nodes || []) {
                if (node.type !== SEED_NODE_TYPE) continue;
                node._xzgSeedUI?.paint?.();
            }
        };
        setTimeout(repaint, 0);
        setTimeout(repaint, 120);
        setTimeout(repaint, 500);

        return result;
    };
    console.warn("[小珠光] Seed 节点 queuePrompt 拦截已安装");
}
_xzgInterceptQueuePrompt();

// ═══════════════════════════════════════════════════════════
//  节点 UI：DOM 控件 + 自绘 canvas（参考「小珠光选择器」的做法）
//  Nodes 2.0 下不要用 legacy canvas 控件（addCustomWidget + draw/mouse）：
//    1) 绘制坐标是"视口像素"，画布缩放后行高/字号与节点不成比例；
//    2) 前端容器带 mx-[-12px]，canvas 整体左移，右侧固定留白；
//    3) 点击要经过 handleDown → widget.mouse 的坐标换算，容易错位。
//  DOM 控件里自绘 canvas 用客户端像素（clientWidth/Height），几何与缩放无关，
//  点击走原生 DOM 事件，命中区与画面完全一致。
// ═══════════════════════════════════════════════════════════

// ══ 凡人修仙传角色 & 宝物名称池（用于单次抽卡按钮随机显示）══
// 仅存在节点对象属性上，不序列化/不持久化，刷新浏览器或切工作流后自动恢复默认
const XZG_DRAW_NAME_POOL = [
    "韩立", "南宫婉", "紫灵", "银月", "慕沛灵", "元瑶", "墨彩环", "陈巧倩",
    "厉飞雨", "董萱儿", "钟吾", "啼魂", "凌玉灵", "温天仁", "乌丑", "极阴祖师",
    "玄骨", "柳玉", "魏无涯", "合欢老魔", "南陇侯", "云露老魔", "风希", "掌天瓶",
    "青竹蜂云剑", "风雷翅", "虚天鼎", "朱雀环", "张铁", "曲魂", "乾蓝冰焰",
    "大挪移令", "玄阴诀", "噬金虫", "血玉蜘蛛", "九曲灵参", "火龙童子", "程天坤", "温夫人"
];
function _xzgPickRandomName() {
    return XZG_DRAW_NAME_POOL[Math.floor(Math.random() * XZG_DRAW_NAME_POOL.length)];
}

const XZG_MODE_ORDER = ["fixed", "randomize", "decrement", "increment"];
const XZG_MODE_COLORS = {
    "fixed": "#CDA56D",
    "increment": "#CDA56D",
    "decrement": "#CDA56D",
    "randomize": "#CDA56D",
};
const XZG_MODE_LABELS = {
    "fixed": () => xzgT("固定", "Fixed"),
    "increment": () => xzgT("增加", "Increment"),
    "decrement": () => xzgT("减少", "Decrement"),
    "randomize": () => xzgT("随机", "Randomize"),
};

// 行高/间距全部用客户端像素，和画布缩放无关
const XZG_UI_ROW_H = 24;
const XZG_UI_PAD = 6;
const XZG_UI_GAP = 4;
const XZG_UI_VGAP = 8;
const XZG_UI_MODE_H = XZG_UI_ROW_H * 2 + XZG_UI_GAP;
const XZG_UI_CONTENT_H = XZG_UI_ROW_H + XZG_UI_VGAP + XZG_UI_MODE_H + XZG_UI_VGAP + XZG_UI_ROW_H;

// 老虎机动画参数
const REEL_START_SPEED = 20;
const REEL_DECAY = 0.988;
const REEL_MIN_SPEED = 0.12;

// 隐藏原生 seed 控件的渲染，但保留在 widgets 数组中：
// 值、序列化（widgets_values）和提交参数都不变，只是不再画任何东西。
function _xzgHideSeedWidget(node) {
    const sw = node.widgets?.find(w => w.name === "seed");
    if (!sw) return;
    try { sw.options.hidden = true; } catch {}
    sw.draw = function () {};
    sw.computeSize = function (w) { return [w, 0]; };
}

/**
 * 创建种子节点的整块自绘 UI。
 * @returns {{refresh: Function, paint: Function}}
 */
function createSeedUI(node) {
    const ROW_H = XZG_UI_ROW_H, PAD = XZG_UI_PAD, GAP = XZG_UI_GAP, VGAP = XZG_UI_VGAP;

    const root = document.createElement("div");
    root.style.cssText = "width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;contain:size layout;pointer-events:none;position:relative;";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;display:block;min-width:0;min-height:0;width:100%;height:100%;touch-action:manipulation;cursor:pointer;pointer-events:auto;";
    canvas.width = 1;
    canvas.height = 1;
    root.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    let width = 0, height = 0, dpr = 2;
    let hitAreas = [];
    let hoverKey = null;
    let slotAnim = null;
    let disposed = false;

    const getSeed = () => node.widgets?.find(w => w.name === "seed");
    const getCtrl = () => node._xzgControlWidget;

    // ── 种子行 ──
    const paintSeedRow = (fullW, y) => {
        const innerW = fullW - PAD * 2;
        const sw = getSeed();
        ctx.fillStyle = "#2a2a2a";
        _xzgRoundRect(ctx, PAD, y, innerW, ROW_H, 4);
        ctx.fill();
        ctx.strokeStyle = "#555";
        ctx.lineWidth = 1;
        _xzgRoundRect(ctx, PAD, y, innerW, ROW_H, 4);
        ctx.stroke();

        const labelText = (sw?.label || sw?.name || "seed") + ":";
        ctx.fillStyle = "#888";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(labelText, PAD + 8, y + ROW_H / 2);

        const raw = sw?.value;
        const num = typeof raw === "number" ? raw : parseInt(raw, 10);
        const displayVal = isNaN(num) ? String(raw ?? "") : String(num);
        ctx.fillStyle = hoverKey === "seed" ? "#ffffff" : "#cccccc";
        ctx.font = "12px monospace";
        ctx.textAlign = "right";
        ctx.fillText(displayVal, PAD + innerW - 8, y + ROW_H / 2);

        hitAreas.push({ key: "seed", x: PAD, y, w: innerW, h: ROW_H });
    };

    // ── 2x2 模式网格 ──
    const paintModes = (fullW, y) => {
        const innerW = fullW - PAD * 2;
        const btnW = (innerW - GAP) / 2;
        const currentMode = getCtrl()?.value || "fixed";
        XZG_MODE_ORDER.forEach((mode, i) => {
            const col = i % 2;
            const row = Math.floor(i / 2);
            const bx = PAD + col * (btnW + GAP);
            const by = y + row * (ROW_H + GAP);
            hitAreas.push({ key: "mode:" + mode, x: bx, y: by, w: btnW, h: ROW_H });

            const selected = currentMode === mode;
            const hovered = hoverKey === "mode:" + mode;
            const color = XZG_MODE_COLORS[mode];

            ctx.fillStyle = selected ? color : (hovered ? "#3a3a3a" : "#2a2a2a");
            _xzgRoundRect(ctx, bx, by, btnW, ROW_H, 4);
            ctx.fill();

            ctx.strokeStyle = selected ? color : "#555";
            ctx.lineWidth = 1;
            _xzgRoundRect(ctx, bx, by, btnW, ROW_H, 4);
            ctx.stroke();

            ctx.fillStyle = selected ? "#000000" : "#cccccc";
            ctx.font = "12px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(XZG_MODE_LABELS[mode](), bx + btnW / 2, by + ROW_H / 2);
        });
    };

    // ── 操作按钮行（历史种子 | 单次抽卡）──
    const paintActions = (fullW, y) => {
        const innerW = fullW - PAD * 2;
        const btnW = (innerW - GAP) / 2;
        const labels = [
            () => "📋 " + xzgT("历史种子", "History"),
            () => "🎲 " + (node._xzgDrawName || xzgT("单次抽卡", "New Random")),
        ];
        const btnH = ROW_H;
        const s = slotAnim;

        labels.forEach((labelFn, i) => {
            const bx = PAD + i * (btnW + GAP);
            const by = y;
            const hovered = hoverKey === "action:" + i;
            const isDrawBtn = i === 1;
            hitAreas.push({ key: "action:" + i, x: bx, y: by, w: btnW, h: btnH });

            // 老虎机：首次绘制时按按钮位置初始化滚轮
            let rolling = false;
            let slotSpeed = 0;
            let slotPhase = "spin";
            if (isDrawBtn && s) {
                rolling = true;
                slotSpeed = s.speed || 0;
                slotPhase = s.phase;
                if (!s._inited) {
                    s._by = by;
                    s._cy = by + btnH / 2;
                    for (let k = 0; k < s.reel.length; k++) {
                        s.reel[k].y = by + (k - s.rowsAbove) * btnH;
                    }
                    s._inited = true;
                }
            }

            ctx.fillStyle = hovered ? "#3a3a3a" : "#2a2a2a";
            _xzgRoundRect(ctx, bx, by, btnW, btnH, 4);
            ctx.fill();

            ctx.strokeStyle = "#555";
            ctx.lineWidth = 1;
            _xzgRoundRect(ctx, bx, by, btnW, btnH, 4);
            ctx.stroke();

            if (rolling && s) {
                const cy = s._cy;
                const lineH = btnH;

                ctx.save();
                ctx.beginPath();
                ctx.rect(bx + 2, by + 1, btnW - 4, btnH - 2);
                ctx.clip();

                ctx.fillStyle = hovered ? "#3a3a3a" : "#2a2a2a";
                ctx.fillRect(bx + 2, by + 1, btnW - 4, btnH - 2);

                // 高速运动模糊：沿运动方向（向上）叠加多层半透明残影
                const ghostLayers = [];
                const blurMag = Math.min(2.8, slotSpeed * 0.7);
                if (blurMag >= 0.4) {
                    const count = 3;
                    for (let g = 1; g <= count; g++) {
                        ghostLayers.push({ offset: -g * (blurMag / count) * 1.6, alpha: 0.18 * (1 - g / (count + 1)) });
                    }
                }
                ghostLayers.push({ offset: 0, alpha: 1 });

                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                for (const item of s.reel) {
                    const centerY = item.y + lineH / 2;
                    if (centerY < cy - lineH * 1.8 || centerY > cy + lineH * 1.8) continue;

                    const dist = Math.abs(centerY - cy) / lineH;
                    const baseAlpha = Math.max(0, 1 - dist * 0.9);

                    for (const g of ghostLayers) {
                        const layerAlpha = baseAlpha * g.alpha;
                        if (layerAlpha <= 0.01) continue;
                        ctx.font = "12px sans-serif";
                        ctx.fillStyle = g.offset === 0
                            ? `rgba(255,215,0,${layerAlpha})`
                            : `rgba(200,170,40,${layerAlpha})`;
                        if (g.offset === 0) {
                            ctx.save();
                            ctx.shadowColor = "#FFD700";
                            ctx.shadowBlur = 2;
                            ctx.shadowOffsetX = 0;
                            ctx.shadowOffsetY = 0;
                            ctx.fillText("🎲 " + item.name, bx + btnW / 2, centerY + g.offset);
                            ctx.restore();
                        } else {
                            ctx.fillText("🎲 " + item.name, bx + btnW / 2, centerY + g.offset);
                        }
                    }
                }
                ctx.restore();
            } else {
                ctx.font = "12px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                if (isDrawBtn) {
                    ctx.save();
                    ctx.shadowColor = "#FFD700";
                    ctx.shadowBlur = 2;
                    ctx.shadowOffsetX = 0;
                    ctx.shadowOffsetY = 0;
                    ctx.fillStyle = "#FFD700";
                    ctx.fillText(labelFn(), bx + btnW / 2, by + btnH / 2);
                    ctx.restore();
                } else {
                    ctx.fillStyle = hovered ? "#ffffff" : "#cccccc";
                    ctx.fillText(labelFn(), bx + btnW / 2, by + btnH / 2);
                }
            }
        });
    };

    const paint = () => {
        if (disposed || !width || !height) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        hitAreas = [];
        // 容器多出来的高度上下均分，避免内容全部贴顶
        let y = Math.max(0, Math.round((height - XZG_UI_CONTENT_H) / 2));
        paintSeedRow(width, y);
        y += ROW_H + VGAP;
        paintModes(width, y);
        y += XZG_UI_MODE_H + VGAP;
        paintActions(width, y);
    };

    // 尺寸：用 clientWidth/clientHeight（布局像素），不受画布缩放影响
    const resize = () => {
        if (disposed) return;
        const rect = root.getBoundingClientRect();
        const w = root.clientWidth || rect.width;
        const h = root.clientHeight || rect.height;
        if (!w || !h) return;
        width = Math.round(w);
        height = Math.round(h);
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        const superSample = width * height > 400000 ? 1 : 2;
        dpr = (window.devicePixelRatio || 1) * superSample;
        const bw = Math.round(width * dpr);
        const bh = Math.round(height * dpr);
        if (canvas.width !== bw || canvas.height !== bh) {
            canvas.width = bw;
            canvas.height = bh;
        }
        paint();
        fitNodeHeight(height);
    };

    // 高度自校准：容器比内容高时收紧节点高度，
    // 让标题下方的留白与底部留白一致（Nodes 2.0 / 旧版画布的预留高度不同）。
    let fitting = false;
    const fitNodeHeight = (availH) => {
        if (fitting || disposed || !availH) return;
        const curr = Math.round(node.size?.[1] || 0);
        if (curr <= 0) return;
        const chrome = curr - availH;              // 标题、边距、角标等占用的高度
        if (chrome < 0) return;
        const target = XZG_UI_CONTENT_H + 8 + chrome;
        if (Math.abs(target - curr) < 4) return;
        fitting = true;
        if (typeof node._xzgLockSize === "function") {
            node._xzgLockSize(target);
        } else {
            node.size[1] = target;
            node.setDirtyCanvas?.(true, true);
        }
        setTimeout(() => { fitting = false; if (!disposed) resize(); }, 120);
    };

    // ── 老虎机动画 ──
    const startSlotAnim = (finalName) => {
        const rowsAbove = 2;
        const totalRows = 5;
        const reel = [];
        for (let r = 0; r < totalRows; r++) {
            reel.push({
                name: XZG_DRAW_NAME_POOL[Math.floor(Math.random() * XZG_DRAW_NAME_POOL.length)],
                y: 0,
            });
        }
        slotAnim = {
            startTime: performance.now(),
            duration: 1800,
            finalName,
            reel,
            speed: REEL_START_SPEED,
            rowsAbove,
            phase: "spin",
            alignT: 0,
            alignStartY: 0,
            alignTargetY: 0,
            _by: -1,
            _cy: -1,
            _inited: false,
        };

        const tick = () => {
            const s = slotAnim;
            if (disposed || !s) return;
            paint();
            const now = performance.now();
            const t = Math.min(1, (now - s.startTime) / s.duration);

            if (!s._inited) { requestAnimationFrame(tick); return; }

            if (s.phase === "spin") {
                const extra = 1 - 0.25 * t;
                s.speed = Math.max(REEL_MIN_SPEED, s.speed * REEL_DECAY * extra);
                if (t >= 0.88 || s.speed <= REEL_MIN_SPEED * 1.2) {
                    s.phase = "align";
                    s.alignT = 0;
                    let bestIdx = -1, bestDist = Infinity;
                    for (let i = 0; i < s.reel.length; i++) {
                        const d = Math.abs((s.reel[i].y + ROW_H / 2) - s._cy);
                        if (d < bestDist) { bestDist = d; bestIdx = i; }
                    }
                    if (bestIdx >= 0) {
                        s.reel[bestIdx].name = s.finalName;
                        s.alignStartY = s.reel[bestIdx].y;
                        s.alignTargetY = s._cy - ROW_H / 2;
                    }
                }
            }

            if (s.phase === "align") {
                s.alignT = Math.min(1, s.alignT + 16 / 220);
                const k = 1 - Math.pow(1 - s.alignT, 3);
                let bestIdx = -1, bestDist = Infinity;
                for (let i = 0; i < s.reel.length; i++) {
                    const d = Math.abs((s.reel[i].y + ROW_H / 2) - s._cy);
                    if (d < bestDist) { bestDist = d; bestIdx = i; }
                }
                if (bestIdx >= 0) {
                    const cur = s.alignStartY + (s.alignTargetY - s.alignStartY) * k;
                    const delta = cur - s.reel[bestIdx].y;
                    for (const item of s.reel) item.y += delta;
                }
                if (s.alignT >= 1) s.phase = "stop";
            }

            if (s.phase !== "align" && s.phase !== "stop") {
                for (const item of s.reel) item.y -= s.speed;
                const topLimit = s._by - ROW_H * 2;
                while (s.reel.length && s.reel[0].y + ROW_H < topLimit) s.reel.shift();
                const bottomLimit = s._by + ROW_H * 3;
                while (true) {
                    const last = s.reel[s.reel.length - 1];
                    if (last && last.y > bottomLimit) break;
                    const newY = last ? last.y + ROW_H : bottomLimit;
                    let name;
                    if (t >= 0.75 && !s._pushedFinal) {
                        name = s.finalName;
                        s._pushedFinal = true;
                    } else {
                        name = XZG_DRAW_NAME_POOL[Math.floor(Math.random() * XZG_DRAW_NAME_POOL.length)];
                    }
                    s.reel.push({ name, y: newY });
                }
            }

            if (s.phase === "stop") {
                if (!s._stopAt) s._stopAt = now;
                if (now - s._stopAt >= 80) {
                    node._xzgDrawName = finalName;
                    slotAnim = null;
                    paint();
                    return;
                }
            }

            if (now - s.startTime >= 2000) {
                node._xzgDrawName = finalName;
                slotAnim = null;
                paint();
                return;
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };

    // ── 交互 ──
    const localPos = (event) => {
        const b = canvas.getBoundingClientRect();
        if (!b.width || !b.height) return null;
        // 抵消节点层 transform 带来的缩放
        const zx = (canvas.clientWidth || b.width) / b.width;
        const zy = (canvas.clientHeight || b.height) / b.height;
        return [(event.clientX - b.left) * zx, (event.clientY - b.top) * zy];
    };

    const hitAt = (x, y) => hitAreas.find(a => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) || null;

    const openSeedEditor = (event) => {
        const sw = getSeed();
        const lcanvas = app.canvas;
        if (!sw || !lcanvas?.prompt) return;
        lcanvas.prompt(sw.label || xzgT("种子", "seed"), String(sw.value ?? ""), (v) => {
            const num = parseInt(v, 10);
            if (isNaN(num)) return;
            sw.value = num;
            paint();
        }, event);
    };

    const onPointerDown = (event) => {
        if (event.button !== 0) return;
        const pos = localPos(event);
        if (!pos) return;
        const hit = hitAt(pos[0], pos[1]);
        if (!hit) return;
        event.preventDefault();
        event.stopPropagation();

        if (hit.key === "seed") {
            openSeedEditor(event);
        } else if (hit.key.startsWith("mode:")) {
            const mode = hit.key.slice(5);
            const ctrl = getCtrl();
            if (ctrl) {
                ctrl.value = mode;
                paint();
                node.setDirtyCanvas?.(true, true);
            }
        } else if (hit.key === "action:0") {
            _xzgShowSeedHistory(node);
        } else if (hit.key === "action:1") {
            const finalName = _xzgPickRandomName();
            startSlotAnim(finalName);
            const sw = getSeed();
            if (sw) {
                sw.value = generateRandomSeed();
                const ctrl = getCtrl();
                if (ctrl) ctrl.value = "fixed";
            }
            paint();
            node.setDirtyCanvas?.(true, true);
        }
    };

    const onPointerMove = (event) => {
        const pos = localPos(event);
        if (!pos) return;
        const hit = hitAt(pos[0], pos[1]);
        const key = hit ? hit.key : null;
        if (key !== hoverKey) {
            hoverKey = key;
            paint();
        }
    };

    const onPointerLeave = () => {
        if (hoverKey !== null) {
            hoverKey = null;
            paint();
        }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);

    // Nodes 1：DOM 控件盖在画布上，滚轮事件到不了 LiteGraph，这里转交
    const onWheel = (event) => {
        if (globalThis.LiteGraph?.vueNodesMode) return;
        const lcanvas = app.canvas;
        if (!lcanvas) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof lcanvas.processMouseWheel === "function") {
            lcanvas.processMouseWheel(event);
            return;
        }
        lcanvas.canvas?.dispatchEvent(new WheelEvent("wheel", {
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            clientX: event.clientX,
            clientY: event.clientY,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
            bubbles: true,
            cancelable: true,
        }));
    };
    root.addEventListener("wheel", onWheel, { passive: false });

    const observer = new ResizeObserver(resize);
    observer.observe(root);
    window.addEventListener("resize", resize);

    // 注册为 DOM 控件：value 固定 null，保持 widgets_values 的占位（与旧工作流兼容）
    const uiWidget = node.addDOMWidget("xzg_seed_ui", "custom", root, {
        hideOnZoom: false,
        margin: 0,
        getMinHeight: () => XZG_UI_CONTENT_H,
        getHeight: () => "100%",
    });
    uiWidget.value = null;
    // 纯展示控件：不写入 widgets_values，也不进入提交参数（否则会多出一个未知输入）
    uiWidget.serialize = false;
    try { uiWidget.options.serialize = false; } catch {}
    // 让 _xzgRefreshAll 也能刷新这块画布
    uiWidget.triggerDraw = () => resize();

    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        disposed = true;
        try { observer.disconnect(); } catch {}
        window.removeEventListener("resize", resize);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerleave", onPointerLeave);
        root.removeEventListener("wheel", onWheel);
        return origOnRemoved?.apply(this, arguments);
    };

    // DOM 控件挂载后再测量一次
    requestAnimationFrame(resize);
    setTimeout(resize, 0);
    setTimeout(resize, 120);

    return { refresh: resize, paint };
}

// ─── 注册扩展 ───
app.registerExtension({
    name: "xiaozhuguang.seed",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== SEED_NODE_TYPE) return;

        // 确保拦截已安装（防止模块加载顺序问题）
        _xzgInterceptQueuePrompt();

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);

            this._xzgSeedHistory = loadHistory();

            // 锁定节点尺寸：宽度固定，高度先给初值，
            // 随后由自绘 UI 按"容器实测高度"自动校准（Nodes 2.0 与旧版画布预留高度不同）
            const LOCK_W = 220;
            let LOCK_H = 178;
            const applySizeLock = (h) => {
                LOCK_H = Math.max(XZG_UI_CONTENT_H + 8, Math.round(h) || LOCK_H);
                this.minWidth = LOCK_W;
                this.maxWidth = LOCK_W;
                this.minHeight = LOCK_H;
                this.maxHeight = LOCK_H;
                this.resizable = false;
                if (!this.size || this.size[0] !== LOCK_W || this.size[1] !== LOCK_H) {
                    this.setSize([LOCK_W, LOCK_H]);
                }
            };
            applySizeLock(LOCK_H);
            this._xzgLockSize = applySizeLock;

            // 本节点不做画布内控件绘制（全部由 DOM 控件自绘），
            // 把控件起始位置归零：否则旧版画布会把 DOM 控件整体下移一个标题高度，
            // 导致标题下方留白远大于底部。
            this.widgets_start_y = 0;

            // 覆写 onResize 强制尺寸为锁定值
            const origOnResize = this.onResize?.bind(this);
            this.onResize = function (size) {
                if (size) { size[0] = LOCK_W; size[1] = LOCK_H; }
                if (this.size) { this.size[0] = LOCK_W; this.size[1] = LOCK_H; }
                return origOnResize?.apply(this, arguments);
            };

            const node = this;

            // 隐藏原生 control_after_generate combo widget（直接移出布局与渲染）
            // 不 splice — 保留在 widgets 数组中确保 afterQueued 回调和序列化仍由 ComfyUI 原生处理
            // 只做彻底隐藏：改 type + computeSize + 空 draw + hidden + 处理 linkedWidgets
            const hideWidgetForGood = (w, suffix = '') => {
                if (!w) return;
                w.origType = w.origType || w.type;
                w.origComputeSize = w.origComputeSize || w.computeSize;
                w.origSerializeValue = w.origSerializeValue || w.serializeValue;
                w.type = "xzgHiddenWidget" + suffix;
                w.computeSize = () => [0, -4];
                w.hidden = true;
                // 空 draw 方法，覆盖 litegraph 默认绘制（解决残留框问题）
                w.draw = function () {};
                // 处理 linkedWidgets（control_after_generate 可能是 seed 的 linkedWidget）
                if (w.linkedWidgets) {
                    for (const lw of w.linkedWidgets) {
                        hideWidgetForGood(lw, ':' + w.name);
                    }
                }
            };

            const hideControlWidget = () => {
                if (!node.widgets) return false;
                const w = node.widgets.find(x => x.name === "control_after_generate");
                if (!w) return false;
                if (node._xzgControlWidget) {
                    // 已隐藏过了
                    if (node._xzgControlWidget === w) return true;
                }
                node._xzgControlWidget = w;
                hideWidgetForGood(w);
                node.setDirtyCanvas(true, true);
                console.warn("[小珠光] 已隐藏原生 control_after_generate widget");
                return true;
            };

            // 立即尝试 + 多次延迟重试，覆盖 ComfyUI 异步添加的情况
            hideControlWidget();
            let retries = 0;
            const retry = () => {
                if (retries >= 20) return;
                retries++;
                hideControlWidget();
                setTimeout(retry, 50);
            };
            setTimeout(retry, 0);

            // ─── 自绘 UI（DOM 控件 + canvas，参考小珠光选择器）───
            // seed 原生控件不再渲染（值/序列化/提交参数保持不变），整块界面由下面的 canvas 绘制
            _xzgHideSeedWidget(node);
            const seedUI = createSeedUI(node);
            node._xzgSeedUI = seedUI;
            // 前端可能稍后才把 widget 挂进 Vue 节点，延迟再隐藏/测量几次
            setTimeout(() => { _xzgHideSeedWidget(node); seedUI.refresh(); }, 0);
            setTimeout(() => { _xzgHideSeedWidget(node); seedUI.refresh(); }, 120);
            setTimeout(() => { _xzgHideSeedWidget(node); seedUI.refresh(); }, 400);

            // onConfigure 后 ComfyUI 可能重新初始化 widgets，再次触发隐藏 + UI 重绘
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function (o) {
                origOnConfigure?.apply(this, arguments);
                // 加载工作流后 ComfyUI 可能重新创建/恢复了 control_after_generate widget，再次隐藏
                setTimeout(hideControlWidget, 0);
                setTimeout(hideControlWidget, 100);
                setTimeout(hideControlWidget, 300);
                // seed widget 可能被重新创建（隐藏状态丢失），重新隐藏并重绘
                setTimeout(() => { _xzgHideSeedWidget(node); seedUI.refresh(); }, 0);
                setTimeout(() => { _xzgHideSeedWidget(node); seedUI.refresh(); }, 150);
                // 加载工作流时：沿用工作流里保存的高度恢复锁定，随后 UI 会再校准一次
                setTimeout(() => {
                    node.widgets_start_y = 0;
                    node._xzgLockSize?.(node.size?.[1] || 178);
                    seedUI.refresh();
                }, 0);
            };
        };
    },
});
