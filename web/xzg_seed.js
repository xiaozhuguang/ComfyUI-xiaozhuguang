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
                    node.setDirtyCanvas(true);
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

        return origQueuePrompt.apply(this, arguments);
    };
    console.warn("[小珠光] Seed 节点 queuePrompt 拦截已安装");
}
_xzgInterceptQueuePrompt();

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

            // 锁定节点尺寸：宽 220，高 140，防止用户拖拽调整
            const FIXED_W = 220;
            const FIXED_H = 140;
            this.minWidth = FIXED_W;
            this.maxWidth = FIXED_W;
            this.minHeight = FIXED_H;
            this.maxHeight = FIXED_H;
            this.resizable = false;
            if (!this.size || this.size[0] !== FIXED_W || this.size[1] !== FIXED_H) {
                this.setSize([FIXED_W, FIXED_H]);
            }
            // 覆写 onResize 强制尺寸为锁定值
            const origOnResize = this.onResize?.bind(this);
            this.onResize = function (size) {
                if (size) { size[0] = FIXED_W; size[1] = FIXED_H; }
                if (this.size) { this.size[0] = FIXED_W; this.size[1] = FIXED_H; }
                return origOnResize?.apply(this, arguments);
            };

            const node = this;

            // 隐藏原生 control_after_generate combo widget（参考 KJNodes 的 hideWidgetForGood 模式）
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

            // 美化 seed 输入框：自定义绘制，风格与下方按钮统一（圆角4px、#2a2a2a 背景、#555 边框）
            // 同时保留原生 number widget 的可编辑/步进功能
            const styleSeedWidget = () => {
                const sw = node.widgets?.find(w => w.name === "seed");
                if (!sw || sw._xzgStyled) return;
                sw._xzgStyled = true;

                // 保存原生 draw（如果存在）
                const origDraw = sw.draw?.bind(sw);

                sw.draw = function (ctx, n, widget_width, y, H) {
                    const btnH = H || 24;
                    const pad = 6;  // 左右边距
                    const innerW = widget_width - pad * 2;
                    // 先抹平 litegraph 画的默认 number widget 背景（颜色取节点背景，确保三行底色一致）
                    const bg = n.bgcolor || n.color || "#2a2a2a";
                    ctx.save();
                    ctx.fillStyle = bg;
                    ctx.fillRect(0, y, widget_width, btnH);
                    ctx.restore();
                    // 自定义圆角矩形 + 边框（与下方按钮未选中态一致）
                    ctx.save();
                    ctx.fillStyle = "#2a2a2a";
                    _xzgRoundRect(ctx, pad, y, innerW, btnH, 4);
                    ctx.fill();

                    ctx.strokeStyle = "#555";
                    ctx.lineWidth = 1;
                    _xzgRoundRect(ctx, pad, y, innerW, btnH, 4);
                    ctx.stroke();

                    // 左标签（"seed:" 或中文）
                    const labelText = (this.label || this.name || "seed") + ":";
                    ctx.fillStyle = "#888";
                    ctx.font = "12px sans-serif";
                    ctx.textAlign = "left";
                    ctx.textBaseline = "middle";
                    ctx.fillText(labelText, pad + 8, y + btnH / 2);

                    // 右侧数值
                    const val = (typeof this.value === "number" ? this.value : parseInt(this.value, 10));
                    const displayVal = isNaN(val) ? this.value : String(val);
                    ctx.fillStyle = "#cccccc";
                    ctx.font = "12px monospace";
                    ctx.textAlign = "right";
                    ctx.fillText(displayVal, widget_width - pad - 8, y + btnH / 2);
                    ctx.restore();

                    // 调用原生 draw 处理内部状态（不传入绘图 context 已不影响显示，但保持事件逻辑）
                    // 注意：不再调用原生 draw，因为原生会画它自己的矩形覆盖我们的圆角
                    // 数字编辑逻辑由 litegraph 的鼠标处理（widget.type = 'number'）驱动
                };

                // 设置 computeSize 确保高度一致
                const origComputeSize = sw.computeSize?.bind(sw);
                if (!sw._xzgOrigComputeSize) {
                    sw._xzgOrigComputeSize = origComputeSize;
                }
                sw.computeSize = function (width) {
                    // 保持宽度，高度固定 24（与按钮行一致）
                    return [width, 24];
                };

                node.setDirtyCanvas(true, true);
                console.warn("[小珠光] seed 输入框已美化");
                return true;
            };
            styleSeedWidget();
            // 延迟重试以防 widget 尚未创建
            setTimeout(styleSeedWidget, 0);
            setTimeout(styleSeedWidget, 100);

            // 模式配色：四个模式选中底色全部统一为暗金色 #CDA56D
            const modeColors = {
                "fixed": "#CDA56D",
                "increment": "#CDA56D",
                "decrement": "#CDA56D",
                "randomize": "#CDA56D",
            };
            const modeLabels = {
                "fixed": () => xzgT("固定", "Fixed"),
                "increment": () => xzgT("增加", "Increment"),
                "decrement": () => xzgT("减少", "Decrement"),
                "randomize": () => xzgT("随机", "Randomize"),
            };
            // 布局：第一行 固定|随机，第二行 减少|增加
            const modeOrder = ["fixed", "randomize", "decrement", "increment"];

            // 自定义 2x2 模式选择器 widget（使用 addCustomWidget 注册）
            const modeSelector = node.addCustomWidget({
                name: "xzg_mode_selector",
                type: "xzg_mode_grid",
                options: { serialize: false },
                y: 0,
                _width: 0,
                _hoverIdx: -1,
                hitAreas: {},

                draw(ctx, n, widget_width, y, H) {
                    this.y = y;
                    this._width = widget_width;
                    this.hitAreas = {};

                    const ctrlWidget = n._xzgControlWidget;
                    const currentMode = ctrlWidget?.value || "fixed";

                    const pad = 6;  // 左右边距
                    const innerW = widget_width - pad * 2;
                    const gap = 4;
                    const btnW = (innerW - gap) / 2;
                    const btnH = 24;
                    const totalH = 52;

                    // 先抹平 litegraph 可能画的默认 widget 背景，避免不同类型叠加色不一致
                    const bg = n.bgcolor || n.color || "#2a2a2a";
                    ctx.save();
                    ctx.fillStyle = bg;
                    ctx.fillRect(0, y, widget_width, totalH);
                    ctx.restore();

                    ctx.save();
                    modeOrder.forEach((mode, i) => {
                        const col = i % 2;
                        const row = Math.floor(i / 2);
                        const bx = pad + col * (btnW + gap);
                        const by = y + row * (btnH + gap);

                        // 记录点击区域（含 pad 偏移，pos 坐标与绘制同系）
                        this.hitAreas[mode] = { bounds: [bx, by, btnW, btnH] };

                        const selected = currentMode === mode;
                        const hovered = this._hoverIdx === i;
                        const color = modeColors[mode];

                        // 背景
                        if (selected) {
                            ctx.fillStyle = color;
                        } else if (hovered) {
                            ctx.fillStyle = "#3a3a3a";
                        } else {
                            ctx.fillStyle = "#2a2a2a";
                        }
                        _xzgRoundRect(ctx, bx, by, btnW, btnH, 4);
                        ctx.fill();

                        // 边框
                        ctx.strokeStyle = selected ? color : "#555";
                        ctx.lineWidth = selected ? 2 : 1;
                        _xzgRoundRect(ctx, bx, by, btnW, btnH, 4);
                        ctx.stroke();

                        // 文字：选中态统一纯黑（与彩色底色高对比度），未选中态浅灰
                        ctx.fillStyle = selected ? "#000000" : "#cccccc";
                        ctx.font = "12px sans-serif";
                        ctx.textAlign = "center";
                        ctx.textBaseline = "middle";
                        ctx.fillText(modeLabels[mode](), bx + btnW / 2, by + btnH / 2);
                    });
                    ctx.restore();
                },

                mouse(event, pos, n) {
                    // wheel 事件放行给画布缩放
                    if (event.type === "wheel") return false;

                    const isMove = event.type === "mousemove" || event.type === "pointermove";
                    const isDown = event.type === "mousedown" || event.type === "pointerdown";

                    if (!isMove && !isDown) return false;

                    const x = pos[0];
                    const y = pos[1];

                    // 命中检测（hitAreas 已包含 pad 偏移，直接比较 pos）
                    let hoverIdx = -1;
                    let hitMode = null;
                    modeOrder.forEach((mode, i) => {
                        const area = this.hitAreas[mode];
                        if (!area) return;
                        const [bx, by, bw, bh] = area.bounds;
                        if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
                            hoverIdx = i;
                            hitMode = mode;
                        }
                    });

                    if (isMove) {
                        if (this._hoverIdx !== hoverIdx) {
                            this._hoverIdx = hoverIdx;
                            n.setDirtyCanvas(true);
                        }
                        return false;
                    }

                    // 点击：仅左键
                    if (event.button !== 0 && event.type === "mousedown") return false;

                    if (hitMode) {
                        const ctrlWidget = n._xzgControlWidget;
                        if (ctrlWidget) {
                            ctrlWidget.value = hitMode;
                            n.setDirtyCanvas(true, true);
                        }
                        return true;  // 消费事件，阻止节点拖动
                    }
                    return false;
                },

                computeSize(width) {
                    return [width, 52];
                }
            });

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

            // 自定义操作按钮行：单次抽卡 + 历史种子（与上方网格风格统一）
            // 布局：历史种子（左）| 单次抽卡（右）
            const actionLabels = [
                () => "📋 " + xzgT("历史种子", "History"),
                () => {
                    // _xzgDrawName 只在点击单次抽卡后设置，刷新/切工作流为 undefined → 回退默认
                    const name = node._xzgDrawName;
                    return "🎲 " + (name || xzgT("单次抽卡", "New Random"));
                },
            ];
            // ══ 老虎机动画：连续滚轮 ══
            // 速度指数衰减（真实老虎机 feel）：speed *= decay 每帧，最后把 finalName 精准对齐中央
            const REEL_START_SPEED = 20;    // 起始像素/帧（约 60fps 下 1200px/s ≈ 50 行/秒）
            const REEL_DECAY = 0.988;       // 速度每帧乘这个数（高速起步、较快衰减以在相同时长内收敛）
            const REEL_MIN_SPEED = 0.12;    // 低于该速度开始 finalName 对齐阶段（避免永远滚不完）

            const actionRow = node.addCustomWidget({
                name: "xzg_action_row",
                type: "xzg_action_buttons",
                options: { serialize: false },
                y: 0,
                _width: 0,
                _hoverIdx: -1,
                hitAreas: {},
                // 老虎机滚动状态：
                //   reel: [{ name, y }]   稳定队列，y 是该名字的顶边像素坐标（相对于节点 pos 坐标，与按钮 by 同系）
                //   speed: 当前速度（像素 / 帧，向上为负 = 加在 y 上 → y -= speed）
                //   finalName: 最终要停在正中的名字
                //   phase: 'spin'（自由滚动）| 'align'（强制对齐 finalName 到正中）| 'stop'
                //   alignT: align 阶段 0→1 的进度
                //   alignStartY: align 阶段起始中央名字的 y 值
                //   alignTargetY: align 阶段目标 y（正中）
                //   node, startTime, duration
                _slotAnim: null,
                // 启动老虎机：初始化滚轮队列、速度、持续 rAF 调度
                _triggerSlotAnim(finalName, targetNode) {
                    const btnH = 24;
                    const initY = 0; // 将在 draw 首次执行时按按钮实际 by 初始化
                    // 初始化滚轮（塞满按钮上下各多 1~2 个，确保滚动不空白）
                    const reel = [];
                    const rowsAbove = 2; // 按钮上方预填 2 行
                    const totalRows = 5; // 上2 + 中1 + 下2
                    for (let r = 0; r < totalRows; r++) {
                        reel.push({
                            name: XZG_DRAW_NAME_POOL[Math.floor(Math.random() * XZG_DRAW_NAME_POOL.length)],
                            y: 0, // draw 首次渲染时依据 by 写入真实基线
                        });
                    }
                    this._slotAnim = {
                        startTime: performance.now(),
                        duration: 1800,
                        finalName,
                        node: targetNode,
                        reel,
                        speed: REEL_START_SPEED,
                        rowsAbove,
                        phase: 'spin',
                        alignT: 0,
                        alignStartY: 0,
                        alignTargetY: 0,
                        _by: -1,        // 由 draw 写入按钮 by（pos 坐标系）
                        _cy: -1,        // 按钮中央 y
                        _inited: false, // 是否已按实际 by 初始化 reel y
                    };

                    const tick = () => {
                        const s = this._slotAnim;
                        if (!s) return;
                        s.node?.setDirtyCanvas(true);
                        const now = performance.now();
                        const t = Math.min(1, (now - s.startTime) / s.duration);

                        // 还没初始化位置（draw 第一帧会写 _by）先继续下一帧
                        if (!s._inited) { requestAnimationFrame(tick); return; }

                        // —— 阶段切换：自旋速度衰减到阈值 或 时间到 90% → 进入对齐阶段
                        if (s.phase === 'spin') {
                            // 指数衰减：越接近结束衰减越快
                            const extra = 1 - 0.25 * t; // 末期衰减更快
                            s.speed = Math.max(REEL_MIN_SPEED, s.speed * REEL_DECAY * extra);

                            if (t >= 0.88 || s.speed <= REEL_MIN_SPEED * 1.2) {
                                // 寻找队列中离中央最近的、名字 == finalName 的项，将其对齐到正中；
                                // 若当前队列没有 finalName，则在下一次滚入时 push(finalName) 到合适位置
                                s.phase = 'align';
                                s.alignT = 0;
                                // 找中央行（距离 _cy 最近）的 reel 项
                                let bestIdx = -1, bestDist = Infinity;
                                for (let i = 0; i < s.reel.length; i++) {
                                    const d = Math.abs((s.reel[i].y + btnH / 2) - s._cy);
                                    if (d < bestDist) { bestDist = d; bestIdx = i; }
                                }
                                // 强制把这一项的名字改成 finalName（停在正中央就是它）
                                if (bestIdx >= 0) {
                                    s.reel[bestIdx].name = s.finalName;
                                    s.alignStartY = s.reel[bestIdx].y;
                                    s.alignTargetY = s._cy - btnH / 2;
                                }
                            }
                        }

                        if (s.phase === 'align') {
                            // 200ms 内缓动（easeOutCubic）对齐到目标
                            s.alignT = Math.min(1, s.alignT + 16 / 220);
                            const k = 1 - Math.pow(1 - s.alignT, 3);
                            // 找到当前 bestIdx（同上，稳定不变：因为我们不再 roll）
                            let bestIdx = -1, bestDist = Infinity;
                            for (let i = 0; i < s.reel.length; i++) {
                                const d = Math.abs((s.reel[i].y + btnH / 2) - s._cy);
                                if (d < bestDist) { bestDist = d; bestIdx = i; }
                            }
                            if (bestIdx >= 0) {
                                const cur = s.alignStartY + (s.alignTargetY - s.alignStartY) * k;
                                const delta = cur - s.reel[bestIdx].y;
                                // 整个 reel 平移同样 delta（保持相对位置不变）
                                for (const item of s.reel) item.y += delta;
                            }
                            if (s.alignT >= 1) {
                                s.phase = 'stop';
                            }
                        }

                        if (s.phase !== 'align' && s.phase !== 'stop') {
                            // 自旋阶段：整列 reel 向上推进 s.speed 像素
                            for (const item of s.reel) item.y -= s.speed;
                            // 移除滚出顶部（完全越出）的项，底部连续补新项直到填满下方
                            const topLimit = s._by - btnH * 2;
                            while (s.reel.length && s.reel[0].y + btnH < topLimit) {
                                s.reel.shift();
                            }
                            const bottomLimit = s._by + btnH * 3;
                            while (true) {
                                const last = s.reel[s.reel.length - 1];
                                if (last && last.y > bottomLimit) break;
                                const newY = last ? last.y + btnH : bottomLimit;
                                // 滚动接近末端且下方正好是"下一个"会成为中央的位置时，塞入 finalName
                                let name;
                                if (t >= 0.75 && !s._pushedFinal) {
                                    // 计算：在 finalName 对齐相位，塞入位置要让最后对齐中央的就是它
                                    // 简化：只在接近尾部 push 一次 finalName，保证队列里有它
                                    name = finalName;
                                    s._pushedFinal = true;
                                } else {
                                    name = XZG_DRAW_NAME_POOL[Math.floor(Math.random() * XZG_DRAW_NAME_POOL.length)];
                                }
                                s.reel.push({ name, y: newY });
                            }
                        }

                        // 结束条件：stop 阶段保持 80ms 稳定展示后退出
                        if (s.phase === 'stop') {
                            if (!s._stopAt) s._stopAt = now;
                            if (now - s._stopAt >= 80) {
                                targetNode._xzgDrawName = finalName;
                                this._slotAnim = null;
                                return;
                            }
                        }

                        // 整体超时兜底（2s 强制收尾）
                        if (now - s.startTime >= 2000) {
                            targetNode._xzgDrawName = finalName;
                            this._slotAnim = null;
                            return;
                        }
                        requestAnimationFrame(tick);
                    };
                    requestAnimationFrame(tick);
                },

                draw(ctx, n, widget_width, y, H) {
                    this.y = y;
                    this._width = widget_width;
                    this.hitAreas = {};

                    const pad = 6;  // 左右边距
                    const innerW = widget_width - pad * 2;
                    const gap = 4;
                    const btnW = (innerW - gap) / 2;
                    const btnH = 24;

                    // 先抹平 litegraph 可能画的默认 widget 背景，统一用 #2a2a2a 确保底色一致
                    ctx.save();
                    ctx.fillStyle = "#2a2a2a";
                    ctx.fillRect(0, y, widget_width, btnH);
                    ctx.restore();

                    ctx.save();
                    actionLabels.forEach((labelFn, i) => {
                        const bx = pad + i * (btnW + gap);
                        const by = y;

                        // 记录点击区域（含 pad 偏移，pos 坐标与绘制同系）
                        this.hitAreas[i] = { bounds: [bx, by, btnW, btnH] };

                        const hovered = this._hoverIdx === i;
                        const isDrawBtn = i === 1; // 单次抽卡（右）是老虎机特效目标

                        // —— 老虎机状态（连续滚轮）——
                        let rolling = false;
                        let slotT = 0;
                        let slotSpeed = 0;
                        let slotPhase = 'spin';
                        if (isDrawBtn && this._slotAnim) {
                            rolling = true;
                            const s = this._slotAnim;
                            slotT = Math.min(1, (performance.now() - s.startTime) / s.duration);
                            slotSpeed = s.speed || 0;
                            slotPhase = s.phase;

                            // 首次进入：根据按钮 by 坐标初始化滚轮各项的 y，使最中间的 reel 项正好落在按钮中央
                            if (!s._inited) {
                                s._by = by;
                                s._cy = by + btnH / 2;
                                // 让索引 rowsAbove (2) 的项顶边 = by → 其中心正好对齐 _cy
                                for (let i = 0; i < s.reel.length; i++) {
                                    s.reel[i].y = by + (i - s.rowsAbove) * btnH;
                                }
                                s._inited = true;
                            }
                        }

                        // —— 背景（滚动时与普通按钮一致，不加金色边框/暗金底）——
                        ctx.save();
                        ctx.fillStyle = hovered ? "#3a3a3a" : "#2a2a2a";
                        _xzgRoundRect(ctx, bx, by, btnW, btnH, 4);
                        ctx.fill();

                        // 边框
                        ctx.strokeStyle = "#555";
                        ctx.lineWidth = 1;
                        _xzgRoundRect(ctx, bx, by, btnW, btnH, 4);
                        ctx.stroke();

                        // —— 文字区域 ——
                        if (rolling && this._slotAnim) {
                            const s = this._slotAnim;
                            const cy = s._cy;
                            const lineH = btnH;

                            // 裁剪到按钮内部（避免滚动文字越出按钮）
                            ctx.save();
                            ctx.beginPath();
                            ctx.rect(bx + 2, by + 1, btnW - 4, btnH - 2);
                            ctx.clip();

                            // clip 区域内先画一层不透明底色，确保残影叠加不会让底色变浅
                            ctx.fillStyle = hovered ? "#3a3a3a" : "#2a2a2a";
                            ctx.fillRect(bx + 2, by + 1, btnW - 4, btnH - 2);

                            // —— 高速运动模糊：沿运动方向（向上）叠加多层半透明残影 ——
                            // slotSpeed 是像素/帧，速度 > 0.6 才明显
                            const ghostLayers = [];
                            const blurMag = Math.min(2.8, slotSpeed * 0.7);
                            if (blurMag >= 0.4) {
                                const count = 3;
                                for (let g = 1; g <= count; g++) {
                                    ghostLayers.push({ offset: -g * (blurMag / count) * 1.6, alpha: 0.18 * (1 - g / (count + 1)) });
                                }
                            }
                            ghostLayers.push({ offset: 0, alpha: 1 }); // 主体

                            // 对 reel 中每个格子绘制
                            ctx.textAlign = "center";
                            ctx.textBaseline = "middle";
                            for (const item of s.reel) {
                                const topY = item.y;
                                const centerY = topY + lineH / 2;
                                // 完全远离按钮可见区域的跳过（clip 兜底，但少画更省）
                                if (centerY < cy - lineH * 1.8 || centerY > cy + lineH * 1.8) continue;

                                const dist = Math.abs(centerY - cy) / lineH; // 0=正中 1=相邻 2=外两格
                                const baseAlpha = Math.max(0, 1 - dist * 0.9);
                                const isMiddle = Math.abs(centerY - cy) < lineH * 0.35;
                                const isFinal = (item.name === s.finalName) && (slotPhase !== 'spin' || s._pushedFinal);

                                for (const g of ghostLayers) {
                                    const dy = g.offset;
                                    const layerAlpha = baseAlpha * g.alpha;
                                    if (layerAlpha <= 0.01) continue;
                                    // 滚动期间文字保持金色（与静止态一致），残影更淡
                                    let fillColor;
                                    if (g.offset === 0) {
                                        fillColor = `rgba(255,215,0,${layerAlpha})`;
                                    } else {
                                        fillColor = `rgba(200,170,40,${layerAlpha})`;
                                    }
                                    // 滚动期间保持普通字体（12px sans-serif），不做高亮加粗
                                    ctx.font = "12px sans-serif";
                                    ctx.fillStyle = fillColor;
                                    // 主体层加金色辉光（与静止态一致，无偏移）
                                    if (g.offset === 0) {
                                        ctx.save();
                                        ctx.shadowColor = "#FFD700";
                                        ctx.shadowBlur = 2;
                                        ctx.shadowOffsetX = 0;
                                        ctx.shadowOffsetY = 0;
                                        ctx.fillText("🎲 " + item.name, bx + btnW / 2, centerY + dy);
                                        ctx.restore();
                                    } else {
                                        ctx.fillText("🎲 " + item.name, bx + btnW / 2, centerY + dy);
                                    }
                                }
                            }
                            ctx.restore(); // clip
                        } else {
                            // 普通按钮文字：单次抽卡（i===1）用主题面板金色 + 辉光，历史种子用默认色
                            ctx.font = "12px sans-serif";
                            ctx.textAlign = "center";
                            ctx.textBaseline = "middle";
                            if (i === 1) {
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

                        ctx.restore(); // 按钮保存
                    });
                    ctx.restore(); // 外层保存
                },

                mouse(event, pos, n) {
                    if (event.type === "wheel") return false;

                    const isMove = event.type === "mousemove" || event.type === "pointermove";
                    const isDown = event.type === "mousedown" || event.type === "pointerdown";
                    if (!isMove && !isDown) return false;

                    const x = pos[0];
                    const y = pos[1];

                    // 命中检测（hitAreas 已包含 pad 偏移，直接比较 pos）
                    let hoverIdx = -1;
                    for (const [key, area] of Object.entries(this.hitAreas)) {
                        const [bx, by, bw, bh] = area.bounds;
                        if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
                            hoverIdx = parseInt(key, 10);
                            break;
                        }
                    }

                    if (isMove) {
                        if (this._hoverIdx !== hoverIdx) {
                            this._hoverIdx = hoverIdx;
                            n.setDirtyCanvas(true);
                        }
                        return false;
                    }

                    if (event.button !== 0 && event.type === "mousedown") return false;

                    if (hoverIdx === 0) {
                        // 历史种子（左）
                        _xzgShowSeedHistory(n);
                        return true;
                    } else if (hoverIdx === 1) {
                        // 单次抽卡（右）—— 老虎机滚动特效 + 生成随机种子
                        // 先抽取最终名（动画结束后才正式写入 drawName，避免滚动期间 label 提前变成最终名）
                        const finalName = _xzgPickRandomName();
                        this._triggerSlotAnim(finalName, n);
                        const sw = n.widgets?.find(w => w.name === "seed");
                        if (sw) {
                            sw.value = generateRandomSeed();
                            const ctrlW = n._xzgControlWidget;
                            if (ctrlW) ctrlW.value = "fixed";
                            n.setDirtyCanvas(true, true);
                        }
                        return true;
                    }
                    return false;
                },

                computeSize(width) {
                    return [width, 24];
                }
            });

            // 覆写 getWidgetOnPos：自定义 widget 区域返回对应 widget
            if (!node.getWidgetOnPos || !node.getWidgetOnPos.__xzgSeedPatched) {
                const origGetWidgetOnPos = node.getWidgetOnPos?.bind(node);
                node.getWidgetOnPos = function (x, y, includeDisabled, ...rest) {
                    const lx = x - node.pos[0];
                    const ly = y - node.pos[1];
                    // 考虑左右 padding=6px，只在真实内容区内命中
                    const left = 6;
                    const right = node.size[0] - 6;
                    // 模式选择器区域
                    if (modeSelector && typeof modeSelector.y === "number") {
                        if (ly >= modeSelector.y && ly <= modeSelector.y + 52 && lx >= left && lx <= right) {
                            return modeSelector;
                        }
                    }
                    // 操作按钮行区域
                    if (actionRow && typeof actionRow.y === "number") {
                        if (ly >= actionRow.y && ly <= actionRow.y + 24 && lx >= left && lx <= right) {
                            return actionRow;
                        }
                    }
                    // 其他区域：回退到原始查找（跳过隐藏的 control_after_generate）
                    if (origGetWidgetOnPos) {
                        const w = origGetWidgetOnPos(x, y, includeDisabled, ...rest);
                        if (w && w.name === "control_after_generate") return null;
                        return w;
                    }
                    return null;
                };
                node.getWidgetOnPos.__xzgSeedPatched = true;
            }

            // onConfigure 后 ComfyUI 可能重新初始化 widgets，再次触发隐藏 + seed 样式
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function (o) {
                origOnConfigure?.apply(this, arguments);
                // 加载工作流后 ComfyUI 可能重新创建/恢复了 control_after_generate widget，再次隐藏
                setTimeout(hideControlWidget, 0);
                setTimeout(hideControlWidget, 100);
                setTimeout(hideControlWidget, 300);
                // seed widget 美化（可能被重新设置，清除标记再执行）
                setTimeout(() => {
                    const s = node.widgets?.find(w => w.name === "seed");
                    if (s) s._xzgStyled = false;
                    styleSeedWidget();
                }, 50);
                // 加载工作流时：恢复尺寸锁定（宽220 高140）
                setTimeout(() => {
                    const FW = 220, FH = 140;
                    node.minWidth = FW;
                    node.maxWidth = FW;
                    node.minHeight = FH;
                    node.maxHeight = FH;
                    node.resizable = false;
                    if (node.size?.[0] !== FW || node.size?.[1] !== FH) {
                        node.setSize([FW, FH]);
                    }
                }, 0);
            };
        };
    },
});
