import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { XiaozhuguangVideoPlayer } from "./xzg_video_player.js";
import { xzgLang } from "./xzg_i18n.js";
import { xzgEnableCanvasPanOnSpace } from "./xzg_save_utils.js";

// ═══════════════════════════════════════════════════════════════════════
// 双语标签翻译映射
// ═══════════════════════════════════════════════════════════════════════
const _LABEL_MAP = {
    "强制帧率": "Force FPS",
    "视频": "Video",
    "视频比例": "Aspect Ratio",
    "比例模式": "Ratio Mode",
    "自定义宽度": "Custom Width",
    "自定义高度": "Custom Height",
    "跳过帧数": "Skip Frames",
    "帧数上限": "Max Frames",
    "上传视频": "Upload Video",
    "边长模式": "Edge Mode",
    "边长尺寸": "Edge Size",
    "自定义比例": "Custom Ratio",
    "原始比例": "Original",
    "竖屏9:16": "Portrait 9:16",
    "竖屏3:4": "Portrait 3:4",
    "横屏16:9": "Landscape 16:9",
    "横屏4:3": "Landscape 4:3",
    "等比1:1": "Square 1:1",
    "裁剪(crop)": "Crop",
    "拉伸(fill)": "Stretch (Fill)",
    "留边(letterbox)": "Letterbox",
    "长边": "Long Edge",
    "短边": "Short Edge",
    "宽度": "Width",
    "高度": "Height",
    "图像": "image",
    "音频": "audio",
    "视频信息": "video info",
    "单击视频播放或暂停/双击视频上传": "Click to play/pause | Double-click to upload",
};

function _tr(zh) {
    const lang = xzgLang();
    return (lang === "en" && _LABEL_MAP[zh]) ? _LABEL_MAP[zh] : zh;
}

const VIDEO_EXTS = ["webm", "mp4", "mkv", "gif", "mov", "avi", "flv", "wmv", "m4v", "mpg", "mpeg", "ts"];
const VIDEO_PREVIEW_WIDGET_NAME = "xzg_video_preview";
const VIDEO_PREVIEW_MIN_H = 100;

// ═══════════════════════════════════════════════════════════════════════
// 自定义数值 widget（VHS 同款方案：从源头创建 canvas 不认识的 widget 类型）
// ═══════════════════════════════════════════════════════════════════════
function _xzgWidgetNumberMouse(event, [x, y], node) {
    // 防御性检查：如果 widget 实际是 combo（有 options.values），显示下拉列表而非 prompt
    // 覆盖 onConfigure/requestAnimationFrame 时序窗口内 mouse handler 未及时更新的情况
    if (Array.isArray(this.options?.values) && this.options.values.length > 0) {
        if (event.type === 'pointerup' && !app.canvas._xzgValueDragged) {
            if (app.canvas) app.canvas._xzgBlockPrompt = true;
            _xzgShowComboDropdown(this, node, event);
            return true;
        }
        return true;
    }
    const widgetWidth = this._xzgDrawW || this.width || node.size[0];
    const oldValue = this.value;
    const step = this._xzgStep || 1;
    // 拖动时的量化步长：step>1（如自定义宽高 step=8）时 dragStep=1（流畅1像素/单位），否则与 step 相同
    // 也允许外部显式设置 widget._xzgDragStep 覆盖
    const dragStep = this._xzgDragStep ?? (step > 1 ? 1 : step);
    const min = this._xzgMin;
    const max = this._xzgMax;
    // 拖动时的上限（如果设置了 _xzgDragMax，则拖动时用它；输入框输入时用 _xzgMax）
    const dragMax = this._xzgDragMax != null ? this._xzgDragMax : max;

    const clamp = (v, useMax) => {
        const m = useMax != null ? useMax : max;
        if (min != null && v < min) v = min;
        if (m != null && v > m) v = m;
        return v;
    };

    if (event.type === 'pointermove') {
        if (event.deltaX) {
            let newValue = this.value + event.deltaX;
            // 拖动过程中按 dragStep 吸附（宽/高 step=8 时用 dragStep=1 保证流畅）
            if (dragStep > 0) {
                newValue = Math.round(newValue / dragStep) * dragStep;
            }
            // 浮点累加精度修正：极接近整数时归整
            if (Math.abs(newValue - Math.round(newValue)) < 1e-6) {
                newValue = Math.round(newValue);
            }
            this.value = clamp(newValue, dragMax);
            app.canvas._xzgValueDragged = true;
        }
    } else if (event.type === 'pointerup') {
        if (app.canvas._xzgValueDragged) {
            // 松手时按最终 step 吸附（宽高：1→8 倍数；跳过帧数/帧数上限：1→1；强制帧率：0.001→0.001）
            let newValue = this.value;
            if (step > 0) {
                newValue = Math.round(newValue / step) * step;
            }
            if (Math.abs(newValue - Math.round(newValue)) < 1e-6) {
                newValue = Math.round(newValue);
            }
            this.value = clamp(newValue, dragMax);
        } else {
            // 点击 → 弹输入框（输入时用 max）
            app.canvas._xzgAllowPrompt = true;
            app.canvas?.prompt?.(
                this.label || this.name,
                this.value,
                (v) => {
                    let nv = Number(v);
                    if (step > 0) {
                        nv = Math.round(nv / step) * step;
                    }
                    if (Math.abs(nv - Math.round(nv)) < 1e-6) {
                        nv = Math.round(nv);
                    }
                    this.value = clamp(nv, max);
                    if (this.callback) this.callback(this.value);
                    node.setDirtyCanvas?.(true, true);
                },
                event
            );
            return true;
        }
        app.canvas._xzgValueDragged = false;
    }

    if (oldValue !== this.value) {
        if (this.callback) this.callback(this.value);
        node.setDirtyCanvas?.(true, true);
    }
    return true;
}

// 带重置按钮的数值控件鼠标处理器（点击 × 一键归零）
function _xzgWidgetNumberWithResetMouse(event, [x, y], node) {
    // 防御性检查：combo widget 不走重置按钮逻辑，避免 stale _xzgResetRect 误触发
    if (Array.isArray(this.options?.values) && this.options.values.length > 0) {
        if (event.type === 'pointerup' && !app.canvas._xzgValueDragged) {
            if (app.canvas) app.canvas._xzgBlockPrompt = true;
            _xzgShowComboDropdown(this, node, event);
            return true;
        }
        return true;
    }
    if (event.type === 'pointerup' && !app.canvas._xzgValueDragged && this._xzgResetRect) {
        const [rx, ry, rw, rh] = this._xzgResetRect;
        if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
            this.value = 0;
            if (this.callback) this.callback(this.value);
            node.setDirtyCanvas?.(true, true);
            return true;
        }
    }
    // 悬停高亮
    if (event.type === 'pointermove' && this._xzgResetRect) {
        const [rx, ry, rw, rh] = this._xzgResetRect;
        const hover = x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
        if (hover !== this._xzgResetHover) {
            this._xzgResetHover = hover;
            node.setDirtyCanvas?.(true, true);
        }
    }
    return _xzgWidgetNumberMouse.call(this, event, [x, y], node);
}

function _xzgDrawWidget(ctx, node, width, y, H) {
    // 属性面板切换等触发节点 reflow 时，widget 传入的宽/高可能与 node.size 暂时不一致，
    // 强制把该行绘制限制在节点实际边界内，避免溢出节点（与波形钳制一致）
    const _nW = node?.size?.[0], _nH = node?.size?.[1];
    if (_nW != null && _nW > 0) width = Math.max(1, Math.min(width, _nW));
    if (_nH != null && _nH > 0) H = Math.max(1, Math.min(H, Math.max(0, _nH - y)));
    this._xzgDrawW = width;
    // 记录 LiteGraph 实际计算的 y/H，供激光线等需要精确定位的元素使用
    // 解决节点 resize 后硬编码 yOffset 导致位置错乱的问题
    this._xzgLastY = y;
    this._xzgLastH = H;
    const pad = 16;
    const r = 6;
    const w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(pad, y + 1, w, H - 2, r); } else { ctx.rect(pad, y + 1, w, H - 2); }
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();
    // 左侧：中文标签
    ctx.fillStyle = '#9ab';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label || this.name || '', pad + 6, y + H / 2);
    // 右侧：当前值（支持自定义颜色）
    // 拖动中：按 dragStep 显示（宽高 step=8 时 dragStep=1 → 流畅显示 1,2,3…）
    // 非拖动状态：按 step 显示（松手后为 8 的倍数 / step 的整数倍）
    const step = this._xzgStep || 1;
    const dragStep = this._xzgDragStep ?? (step > 1 ? 1 : step);
    const isDragging = !!app.canvas?._xzgValueDragged;
    const displayStep = isDragging ? dragStep : step;
    let displayValue = this.value;
    if (typeof displayValue === 'number' && !Number.isNaN(displayValue)) {
        if (displayStep > 0) {
            displayValue = Math.round(displayValue / displayStep) * displayStep;
        }
        if (Math.abs(displayValue - Math.round(displayValue)) < 1e-6) {
            displayValue = Math.round(displayValue);
        }
    }
    const valueText = String(displayValue);
    ctx.fillStyle = this._xzgValueColor || '#fff';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'right';
    let valueX = width - pad - 6;
    // 重置按钮（×），点击一键归零
    if (this._xzgShowReset) {
        valueX -= 18; // 左移留出按钮空间
        const btnR = 7;
        const btnCX = width - pad - 6 - btnR;
        const btnCY = y + H / 2;
        this._xzgResetRect = [btnCX - btnR, btnCY - btnR, btnR * 2, btnR * 2];
        // 暗灰色 × 符号
        ctx.strokeStyle = this._xzgResetHover ? '#888' : '#555';
        ctx.lineWidth = 2;
        const s = 4;
        ctx.beginPath();
        ctx.moveTo(btnCX - s, btnCY - s);
        ctx.lineTo(btnCX + s, btnCY + s);
        ctx.moveTo(btnCX + s, btnCY - s);
        ctx.lineTo(btnCX - s, btnCY + s);
        ctx.stroke();
    }
    // 绘制数值（恢复 fillStyle，防止重置按钮影响数值颜色）
    ctx.fillStyle = this._xzgValueColor || '#fff';
    ctx.fillText(valueText, valueX, y + H / 2);
}

// combo / button 同款圆角风格
function _xzgDrawComboWidget(ctx, node, width, y, H) {
    // 属性面板切换等触发节点 reflow 时，widget 传入的宽/高可能与 node.size 暂时不一致，
    // 强制把该行绘制限制在节点实际边界内，避免溢出节点（与波形钳制一致）
    const _nW = node?.size?.[0], _nH = node?.size?.[1];
    if (_nW != null && _nW > 0) width = Math.max(1, Math.min(width, _nW));
    if (_nH != null && _nH > 0) H = Math.max(1, Math.min(H, Math.max(0, _nH - y)));
    this._xzgDrawW = width;
    this._xzgLastY = y;
    this._xzgLastH = H;
    const pad = 16, r = 6;
    const w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(pad, y + 1, w, H - 2, r); } else { ctx.rect(pad, y + 1, w, H - 2); }
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();
    // 左侧标签（超长省略）
    ctx.fillStyle = '#9ab';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelText = this.label || this.name || '';
    const labelMaxW = width - pad * 2 - 54; // 留出右侧值+箭头空间，再减3字符
    if (ctx.measureText(labelText).width > labelMaxW) {
        let truncated = labelText;
        while (ctx.measureText(truncated + '…').width > labelMaxW && truncated.length > 0) {
            truncated = truncated.slice(0, -1);
        }
        ctx.fillText(truncated + '…', pad + 6, y + H / 2);
    } else {
        ctx.fillText(labelText, pad + 6, y + H / 2);
    }
    // 右侧：当前值（超长省略）
    const displayText = this._xzgDisplayVal ? this._xzgDisplayVal(String(this.value ?? '')) : String(this.value ?? '');
    ctx.fillStyle = '#fff';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    const valMaxW = width - pad * 2 - 54;
    if (ctx.measureText(displayText).width > valMaxW) {
        let truncated = displayText;
        while (ctx.measureText(truncated + '…').width > valMaxW && truncated.length > 0) {
            truncated = truncated.slice(0, -1);
        }
        ctx.fillText(truncated + '…', width - pad - 16, y + H / 2);
    } else {
        ctx.fillText(displayText, width - pad - 16, y + H / 2);
    }
    // 右侧下拉箭头 ▼
    ctx.fillStyle = '#888';
    ctx.beginPath();
    const dx = width - pad - 8, dy = y + H / 2;
    ctx.moveTo(dx - 4, dy - 2);
    ctx.lineTo(dx + 4, dy - 2);
    ctx.lineTo(dx, dy + 3);
    ctx.closePath();
    ctx.fill();
}

// 强制帧率 combo 的 mouse 处理器：点击弹出下拉列表，禁止拖拽
function _xzgFpsComboMouse(event, [x, y], node) {
    if (event.type === 'pointerdown') {
        // 在 pointerdown 时就阻止 prompt，防止 LiteGraph 在 pointerup 后调用 prompt
        if (app.canvas) app.canvas._xzgBlockPrompt = true;
        // 安全网：如果 pointerup 没有触发 _xzgShowComboDropdown（如用户拖走），
        // 500ms 后自动恢复 _xzgBlockPrompt
        setTimeout(() => {
            if (!document.querySelector('.xzg-fps-dropdown') && app.canvas) {
                app.canvas._xzgBlockPrompt = false;
            }
        }, 500);
    }
    if (event.type === 'pointerup') {
        _xzgShowComboDropdown(this, node, event);
        return true;
    }
    return true;
}

// 显示 combo 下拉列表（DOM 方式）
function _xzgShowComboDropdown(widget, node, event) {
    // 移除已有的下拉
    const old = document.querySelector('.xzg-fps-dropdown');
    if (old) old.remove();

    // 下拉打开期间阻止 LiteGraph 原生 prompt 弹出（避免 value 对话框与下拉同时出现）
    if (app.canvas) app.canvas._xzgBlockPrompt = true;

    const values = widget.options?.values || ["0", "16", "24", "25", "30", "60"];
    const canvasRect = app.canvas?.canvas?.getBoundingClientRect?.();
    if (!canvasRect) return;

    // 计算 widget 在屏幕上的位置
    let wx = event.clientX;
    let wy = event.clientY;
    if (!wx || !wy) {
        // fallback: 优先使用 _xzgDrawComboWidget 中记录的实际绘制位置
        const pad = 16;
        const scale = app.canvas.ds.scale;
        const offset = app.canvas.ds.offset;
        const nodeX = (node.pos?.[0] + offset[0]) * scale + canvasRect.left;
        const nodeY = (node.pos?.[1] + offset[1]) * scale + canvasRect.top;
        const lastY = widget._xzgLastY;
        const lastH = widget._xzgLastH ?? 20;
        const widgetY = (lastY != null)
            ? (nodeY + (lastY + lastH) * scale)
            : (() => {
                // 最终回退：用 computeSize 累加
                const widgetIdx = node.widgets?.indexOf(widget) ?? 0;
                return nodeY + (node.widgets?.slice(0, widgetIdx).reduce((s, w) => s + (w.computeSize?.(node.size[0])?.[1] || 20), 0) || 0) * scale;
            })();
        wx = nodeX + node.size[0] * scale - pad;
        wy = widgetY;
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'xzg-fps-dropdown notranslate';
    dropdown.setAttribute('translate', 'no');
    dropdown.dataset.noTranslate = '1';
    dropdown.dataset.xzgFpsDropdown = '1';
    dropdown.style.cssText = `
        position: fixed; z-index: 99999;
        left: ${Math.max(4, wx - 60)}px; top: ${wy + 4}px;
        min-width: 80px;
        background: #2a2a2a; border: 1px solid #555; border-radius: 6px;
        padding: 4px 0; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    `;

    const createdItems = [];
    values.forEach(v => {
        const item = document.createElement('div');
        item.className = 'notranslate';
        item.setAttribute('translate', 'no');
        item.dataset.noTranslate = '1';
        const displayText = widget._xzgDisplayVal ? widget._xzgDisplayVal(String(v)) : String(v);
        // 使用 dataset 缓存原始正确值，防止被外部 MutationObserver 篡改
        item.dataset.xzgRawValue = String(v);
        item.dataset.xzgDisplay = displayText;
        item.textContent = displayText;
        createdItems.push({ el: item, expected: displayText, raw: String(v) });
        const selected = String(v) === String(widget.value);
        item.style.cssText = `
            padding: 4px 16px; cursor: pointer; font-size: 13px;
            color: ${selected ? '#FFD700' : '#ccc'};
            background: ${selected ? '#333' : 'transparent'};
        `;
        item.onmouseenter = () => { item.style.background = '#444'; };
        item.onmouseleave = () => { item.style.background = selected ? '#333' : 'transparent'; };
        // 阻止 pointerdown 冒泡，防止关闭外部时误关
        item.addEventListener('pointerdown', (e) => e.stopPropagation());
        item.onclick = (e) => {
            e.stopPropagation();
            widget.value = v;
            if (widget.callback) widget.callback(v);
            node.setDirtyCanvas?.(true, true);
            _closeDropdown();
        };
        dropdown.appendChild(item);
    });

    // 阻止 dropdown 本身的 pointerdown 冒泡
    dropdown.addEventListener('pointerdown', (e) => e.stopPropagation());

    // 关闭下拉并恢复 prompt 权限
    const _closeDropdown = () => {
        dropdown.remove();
        if (app.canvas) app.canvas._xzgBlockPrompt = false;
    };

    // 点击外部关闭（capture 阶段拦截，不受 LiteGraph stopPropagation 影响）
    const close = (e) => {
        if (!dropdown.contains(e.target)) {
            _closeDropdown();
            document.removeEventListener('pointerdown', close, true);
        }
    };
    document.addEventListener('pointerdown', close, true);

    document.body.appendChild(dropdown);

    // 兜底修复：防止 PromptAssistant 或其他使用 MutationObserver 的插件
    // 在 DOM append 后批量改写我们刚刚设置的 textContent（例如把 Custom 误改成"自定义节点"）
    // 分别在 0ms（微任务之后）、10ms、50ms 三重修正
    const repairIfTampered = () => {
        if (!document.body.contains(dropdown)) return;
        createdItems.forEach(({ el, expected }) => {
            if (el.textContent !== expected) {
                console.warn("[小珠光 dropdown] 检测到外部插件篡改下拉项文本，已修复:",
                    JSON.stringify(el.textContent), "->", JSON.stringify(expected));
                el.textContent = expected;
            }
        });
    };
    Promise.resolve().then(repairIfTampered);
    setTimeout(repairIfTampered, 10);
    setTimeout(repairIfTampered, 50);
}

function _xzgDrawButtonWidget(ctx, node, width, y, H) {
    // 属性面板切换等触发节点 reflow 时，widget 传入的宽/高可能与 node.size 暂时不一致，
    // 强制把该行绘制限制在节点实际边界内，避免溢出节点（与波形钳制一致）
    const _nW = node?.size?.[0], _nH = node?.size?.[1];
    if (_nW != null && _nW > 0) width = Math.max(1, Math.min(width, _nW));
    if (_nH != null && _nH > 0) H = Math.max(1, Math.min(H, Math.max(0, _nH - y)));
    const pad = 16, r = 6;
    const w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(pad, y + 1, w, H - 2, r); } else { ctx.rect(pad, y + 1, w, H - 2); }
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label || this.name || this.value || '', width / 2, y + H / 2);
}

// ═══════════════════════════════════════════════════════════════════════
// 激光引导线（参考小珠光编组激光引导线风格）
// ═══════════════════════════════════════════════════════════════════════
let _xzgLaserSvg = null;
let _xzgLaserRafId = null;

function _xzgShowLaserLine(widget, node) {
    _xzgHideLaserLine();

    const player = node._xzgVideoPlayer;
    if (!player) return;

    const isSkip = widget.name === '跳过帧数';
    const markerEl = isSkip ? player._loadRangeStart : player._loadRangeEnd;
    if (!markerEl || markerEl.style.display === 'none') return;

    const color = isSkip ? '#ef4444' : '#3b82f6';
    const glowFilter = `drop-shadow(0 0 4px ${color}88) drop-shadow(0 0 12px ${color}44)`;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:100000;";
    svg.id = "xzg-video-loader-laser";

    // 计算控件数值区域屏幕位置（使用 widget 实际绘制位置，跟随节点 resize 变化）
    const getWidgetScreenPos = () => {
        const canvas = app.canvas;
        if (!canvas?.ds || !canvas?.canvas) return null;
        const canvasRect = canvas.canvas.getBoundingClientRect();
        const scale = canvas.ds.scale;
        const offset = canvas.ds.offset;

        // 节点右侧数值区域屏幕坐标（需加 offset 补偿画布平移）
        const valueX = (node.pos[0] + offset[0] + node.size[0] - 50) * scale + canvasRect.left;
        // Y: 优先使用 _xzgDrawWidget 中记录的实际绘制位置（精确跟随 resize）
        // 回退到硬编码值（首次绘制前或异常情况）
        const lastY = widget._xzgLastY;
        const lastH = widget._xzgLastH ?? 20;
        const yOffset = (lastY != null)
            ? (lastY + lastH / 2)
            : ((widget.name === '跳过帧数') ? 217 : 242);
        const sy = (node.pos[1] + offset[1] + yOffset) * scale + canvasRect.top;
        return { x1: valueX, y1: sy };
    };

    const drawLine = () => {
        const canvas = app.canvas;
        if (!canvas?.ds || !canvas?.canvas) return;

        // 获取起点位置（每次重绘重新计算，跟随画布移动/缩放）
        const startPos = getWidgetScreenPos();
        if (!startPos) return;

        // 终点：标记元素屏幕位置（每次重绘重新计算，跟随竖杠移动）
        const markerRect = markerEl.getBoundingClientRect();
        const x2 = markerRect.left + markerRect.width / 2;
        const y2 = markerRect.top + markerRect.height / 2;

        // 清空并重绘
        while (svg.firstChild) svg.removeChild(svg.firstChild);

        // 主线
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", startPos.x1);
        line.setAttribute("y1", startPos.y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);
        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", "2");
        line.setAttribute("stroke-dasharray", "6 4");
        line.style.filter = glowFilter;
        const anim = document.createElementNS("http://www.w3.org/2000/svg", "animate");
        anim.setAttribute("attributeName", "stroke-dashoffset");
        anim.setAttribute("from", "0");
        anim.setAttribute("to", "20");
        anim.setAttribute("dur", "0.5s");
        anim.setAttribute("repeatCount", "indefinite");
        line.appendChild(anim);
        svg.appendChild(line);

        // 终点圆环
        const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        ring.setAttribute("cx", x2);
        ring.setAttribute("cy", y2);
        ring.setAttribute("r", "6");
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", color);
        ring.setAttribute("stroke-width", "2");
        ring.style.filter = glowFilter;
        const ringAnim = document.createElementNS("http://www.w3.org/2000/svg", "animate");
        ringAnim.setAttribute("attributeName", "r");
        ringAnim.setAttribute("values", "4;10;4");
        ringAnim.setAttribute("dur", "1s");
        ringAnim.setAttribute("repeatCount", "indefinite");
        ring.appendChild(ringAnim);
        const ringOpacity = document.createElementNS("http://www.w3.org/2000/svg", "animate");
        ringOpacity.setAttribute("attributeName", "opacity");
        ringOpacity.setAttribute("values", "1;0.3;1");
        ringOpacity.setAttribute("dur", "1s");
        ringOpacity.setAttribute("repeatCount", "indefinite");
        ring.appendChild(ringOpacity);
        svg.appendChild(ring);
    };

    drawLine();
    document.body.appendChild(svg);
    _xzgLaserSvg = svg;
    // 独立变量存储 rAF ID，函数引用保持不变 → 循环正确持续
    const loop = () => {
        drawLine();
        _xzgLaserRafId = requestAnimationFrame(loop);
    };
    _xzgLaserRafId = requestAnimationFrame(loop);
}

function _xzgHideLaserLine() {
    if (_xzgLaserRafId) {
        cancelAnimationFrame(_xzgLaserRafId);
        _xzgLaserRafId = null;
    }
    const svg = document.getElementById("xzg-video-loader-laser");
    if (svg) svg.remove();
    _xzgLaserSvg = null;
}

// 带激光引导线 + 重置按钮的数值控件鼠标处理器
function _xzgWidgetNumberWithLaserMouse(event, [x, y], node) {
    // 重置按钮点击
    if (event.type === 'pointerup' && !app.canvas._xzgValueDragged && this._xzgResetRect) {
        const [rx, ry, rw, rh] = this._xzgResetRect;
        if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
            this.value = 0;
            if (this.callback) this.callback(this.value);
            node.setDirtyCanvas?.(true, true);
            _xzgHideLaserLine();
            return true;
        }
    }
    // 悬停高亮
    if (event.type === 'pointermove' && this._xzgResetRect) {
        const [rx, ry, rw, rh] = this._xzgResetRect;
        const hover = x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
        if (hover !== this._xzgResetHover) {
            this._xzgResetHover = hover;
            node.setDirtyCanvas?.(true, true);
        }
    }

    const result = _xzgWidgetNumberMouse.call(this, event, [x, y], node);

    if (event.type === 'pointermove' && event.deltaX) {
        if (!_xzgLaserSvg) {
            _xzgShowLaserLine(this, node);
        }
    } else if (event.type === 'pointerup' || event.type === 'pointerleave') {
        _xzgHideLaserLine();
    }

    return result;
}

// 根据视频比例切换自定义宽度/高度的显示和行为
function _updateRatioWidgets(node) {
    const ratioWidget = node.widgets?.find(w => w.name === "视频比例");
    const wWidget = node.widgets?.find(w => w.name === "自定义宽度");
    const hWidget = node.widgets?.find(w => w.name === "自定义高度");
    if (!ratioWidget || !wWidget || !hWidget) return;

    const isRatio = ratioWidget.value !== "自定义比例";

    if (isRatio) {
        wWidget.options.values = ["1", "2", "3", "4"];
        wWidget._xzgDisplayVal = (v) => _tr(({1:"长边",2:"短边",3:"宽度",4:"高度"})[v] || v);
        wWidget.draw = _xzgDrawComboWidget;
        wWidget.mouse = _xzgFpsComboMouse;
        wWidget._xzgShowReset = false;
        wWidget.label = _tr("边长模式");
        if (wWidget.value < 1 || wWidget.value > 4) wWidget.value = "1";
        hWidget.label = _tr("边长尺寸");
        hWidget.draw = _xzgDrawWidget;
        hWidget.mouse = _xzgWidgetNumberMouse;
        hWidget._xzgShowReset = false;
    } else {
        wWidget.options.values = undefined;
        wWidget._xzgDisplayVal = undefined;
        wWidget.draw = _xzgDrawWidget;
        wWidget.mouse = _xzgWidgetNumberWithResetMouse;
        wWidget._xzgShowReset = true;
        wWidget.label = _tr("自定义宽度");
        // 仅在值无效（边长模式遗留的字符串，或负数）时重置为 0
        // 保留 configure 恢复的数值，避免切换工作流后宽高被冲掉
        if (typeof wWidget.value !== "number" || wWidget.value < 0) wWidget.value = 0;
        hWidget.draw = _xzgDrawWidget;
        hWidget.mouse = _xzgWidgetNumberWithResetMouse;
        hWidget._xzgShowReset = true;
        hWidget.label = _tr("自定义高度");
        if (typeof hWidget.value !== "number" || hWidget.value < 0) hWidget.value = 0;
    }
    node.setDirtyCanvas?.(true, true);
}

// 统一应用所有 widget 的样式（圆角、颜色、重置按钮等），可重复调用
function _applyWidgetStyles(node) {
    // 这些栏会随属性面板开/关改变绘制宽度（同「视频」栏修复）：
    // ComfyUI 会把 widget.width 写成面板侧行宽度，导致行绘制/交互命中区超出节点。
    // 这里统一将 width 定义为只读访问器，始终跟随节点实际宽度，忽略污染性写入。
    const _XRG_WIDGET_NAME_FIX = {
        '强制帧率': 1, '视频比例': 1, '比例模式': 1, '自定义宽度': 1,
        '自定义高度': 1, '跳过帧数': 1, '帧数上限': 1,
    };
    for (const w of node.widgets || []) {
        if (w.name === VIDEO_PREVIEW_WIDGET_NAME) continue;
        if (_XRG_WIDGET_NAME_FIX[w.name] && !w._xzgWidthFixed) {
            w._xzgWidthFixed = true;
            Object.defineProperty(w, 'width', {
                configurable: true,
                get() { return node.size?.[0] || 0; },
                set(_) { /* 忽略外部写入，防止行绘制/命中区溢出节点 */ },
            });
        }
        if (w.name === '强制帧率') {
            w._xzgValueColor = '#FFD700';
            w._xzgShowReset = true;
            w.draw = _xzgDrawWidget;
            w.mouse = _xzgWidgetNumberWithResetMouse;
            w.label = _tr("强制帧率");
            // 拖动时每步 +1（流畅整数），松手/输入按 step=0.001 吸附精度
            w._xzgDragStep = 1;
        } else if (w.name === '视频') {
            w.draw = _xzgDrawComboWidget;
            w.label = _tr("视频");
        } else if (w.name === '视频比例') {
            w.draw = _xzgDrawComboWidget;
            w.mouse = _xzgFpsComboMouse;
            w.value = String(w.value ?? "自定义比例");
            w.options = w.options || {};
            w.options.values = ["自定义比例", "原始比例", "竖屏9:16", "竖屏3:4", "横屏16:9", "横屏4:3", "等比1:1"];
            w._xzgDisplayVal = (v) => _tr(String(v));
            w.label = _tr("视频比例");
        } else if (w.name === '比例模式') {
            w.draw = _xzgDrawComboWidget;
            w.mouse = _xzgFpsComboMouse;
            w.value = String(w.value ?? "裁剪(crop)");
            w.options = w.options || {};
            w.options.values = ["裁剪(crop)", "拉伸(fill)", "留边(letterbox)"];
            w._xzgDisplayVal = (v) => _tr(String(v));
            w.label = _tr("比例模式");
        } else if (w.name === '上传视频') {
            w.draw = _xzgDrawButtonWidget;
            w.label = _tr("上传视频");
        } else if (w.name === '跳过帧数') {
            w._xzgValueColor = '#FF4444';
            w._xzgShowReset = true;
            w.draw = _xzgDrawWidget;
            w.mouse = _xzgWidgetNumberWithLaserMouse;
            w.label = _tr("跳过帧数");
        } else if (w.name === '帧数上限') {
            w._xzgValueColor = '#6699FF';
            w._xzgShowReset = true;
            w.draw = _xzgDrawWidget;
            w.mouse = _xzgWidgetNumberWithLaserMouse;
            w.label = _tr("帧数上限");
        } else if (w.name === '自定义宽度' || w.name === '自定义高度') {
            w._xzgValueColor = w._xzgValueColor || '#fff';
            w._xzgShowReset = true;
            w.draw = _xzgDrawWidget;
            w.mouse = _xzgWidgetNumberWithResetMouse;
            w.label = _tr(w.name);
        }
    }
}

function _xzgCreateNumberWidget(node, inputName, inputData) {
    const opts = inputData[1] || {};
    const w = {
        name: inputName,
        type: 'number',
        value: opts.default ?? 0,
        options: {},
        _xzgStep: opts.step || 1,
        _xzgMin: opts.min,
        _xzgMax: opts.max,
        computeSize(width) { return [width, 20]; },
        draw: _xzgDrawWidget,
        mouse: _xzgWidgetNumberMouse,
        callback(v) { if (this._xzgCb) this._xzgCb(v); },
    };
    if (!node.widgets) node.widgets = [];
    node.widgets.push(w);
    return w;
}

// 自定义 combo widget：从源头创建，绕过 ComfyUI 原生 combo 渲染
// 完全使用小珠光圆角风格 draw + 自定义 DOM 下拉列表
// type 设为 'xzg_combo' 而非 'combo'，防止 LiteGraph processNodeWidgets 识别为原生 combo 弹出 <select>
function _xzgCreateComboWidget(node, inputName, inputData) {
    const values = Array.isArray(inputData[0]) ? inputData[0] : [];
    const opts = inputData[1] || {};
    const w = {
        name: inputName,
        type: 'xzg_combo',
        value: opts.default != null ? opts.default : (values[0] != null ? values[0] : ""),
        options: { values: values },
        computeSize(width) { return [width, 20]; },
        draw: _xzgDrawComboWidget,
        mouse: _xzgFpsComboMouse,
        callback(v) { if (this._xzgCb) this._xzgCb(v); },
    };
    if (!node.widgets) node.widgets = [];
    node.widgets.push(w);
    return w;
}

// 拦截 canvas.prompt：拖拽后(canvas 自己调的)不弹框
function _xzgPatchCanvasPrompt() {
    if (app.canvas._xzgPromptPatched) return;
    const origPrompt = app.canvas.prompt;
    app.canvas.prompt = function () {
        // 自定义下拉打开期间，彻底阻止原生 prompt 弹出
        if (app.canvas._xzgBlockPrompt) return null;
        if (app.canvas._xzgAllowPrompt) {
            app.canvas._xzgAllowPrompt = false;
            app.canvas._xzgLastPromptMs = Date.now();
            return origPrompt.apply(this, arguments);
        }
        if (app.canvas._xzgValueDragged) {
            app.canvas._xzgValueDragged = false;
            return null;
        }
        if (app.canvas._xzgLastPromptMs && Date.now() - app.canvas._xzgLastPromptMs < 300) {
            return null;
        }
        return origPrompt.apply(this, arguments);
    };
    app.canvas._xzgPromptPatched = true;
}

function isVideoFilename(name) {
    if (!name) return false;
    const ext = name.split(".").pop().toLowerCase();
    return VIDEO_EXTS.includes(ext);
}

function getVideoUrl(filename) {
    if (!filename) return "";
    let name = filename;
    let type = "input";
    let subfolder = "";
    const suffixes = [" [output]", " [input]", " [temp]"];
    for (const s of suffixes) {
        if (name.endsWith(s)) {
            type = s.trim().slice(1, -1);
            name = name.slice(0, -s.length);
            break;
        }
    }
    const params = new URLSearchParams({ filename: name, type });
    if (subfolder) params.set("subfolder", subfolder);
    return `/view?${params.toString()}&rand=${Math.random()}`;
}

function _extractFilename(url) {
    try {
        const params = new URLSearchParams(new URL(url, location.origin).search);
        const name = params.get("filename");
        return name || "video.mp4";
    } catch (_) {
        return "video.mp4";
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 分块上传（并发 + 重试 + 断点续传 + 1GB 限制）
// 比 Load Video UI 的改进：
//   1. 20MB 分块（Load Video UI 10MB）→ 请求数减半
//   2. 3 路并发上传（Load Video UI 顺序）→ 速度提升 ~3 倍
//   3. 每块 3 次重试（Load Video UI 无重试）→ 网络抖动不中断
//   4. 断点续传（Load Video UI 无续传）→ 中断后可恢复
//   5. 1GB 硬限制（Load Video UI 无限制）
// ═══════════════════════════════════════════════════════════════════════
const _XZG_VIDEO_CHUNK_SIZE = 20 * 1024 * 1024;   // 20MB 分块
const _XZG_VIDEO_MAX_SIZE = 1024 * 1024 * 1024;    // 1GB 限制
const _XZG_VIDEO_CONCURRENCY = 3;                   // 3 路并发
const _XZG_VIDEO_RETRY = 3;                         // 每块重试 3 次

function _xzgFormatSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
}

// 视频加载器专用提示弹窗（风格与音频加载器一致，不使用浏览器 alert）
function _xzgVideoAlert(message, title = "提示") {
    const existing = document.querySelector(".xzg-video-alert-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "xzg-video-alert-overlay";
    overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:sans-serif;";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const dialog = document.createElement("div");
    dialog.style.cssText =
        "background:var(--comfy-menu-bg,#1e1e1e);color:#ddd;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.5);width:420px;max-width:90vw;border:1px solid rgba(255,255,255,0.1);";
    dialog.onclick = (e) => e.stopPropagation();

    dialog.innerHTML = `
        <div style="padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;justify-content:space-between;align-items:center;">
            <div style="font-size:14px;font-weight:bold;color:#FFD700;">${title}</div>
        </div>
        <div style="padding:14px 18px;font-size:12px;line-height:1.6;white-space:pre-wrap;">${message}</div>
        <div style="padding:12px 18px;border-top:1px solid rgba(255,255,255,0.1);display:flex;justify-content:flex-end;">
            <button class="xzg-video-alert-ok" style="padding:6px 16px;background:#FFD700;color:#333;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;">知道了</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
    };
    dialog.querySelector(".xzg-video-alert-ok").onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    };
    document.addEventListener("keydown", onKey, true);
}

// 上传单个分块（带重试）
async function _xzgUploadOneChunk(sessionId, chunkIndex, chunkOffset, chunkBlob) {
    const formData = new FormData();
    formData.append("session_id", sessionId);
    formData.append("chunk_index", chunkIndex);
    formData.append("chunk_offset", chunkOffset);
    formData.append("chunk", chunkBlob);

    for (let attempt = 0; attempt < _XZG_VIDEO_RETRY; attempt++) {
        try {
            // 重试时需要重新构造 FormData（blob 已被消费）
            const fd = attempt === 0 ? formData : new FormData([
                ["session_id", sessionId],
                ["chunk_index", String(chunkIndex)],
                ["chunk_offset", String(chunkOffset)],
                ["chunk", chunkBlob],
            ]);
            const resp = await api.fetchApi("/xzg/video_upload_chunk", { method: "POST", body: fd });
            if (resp.ok) {
                return await resp.json();
            }
            if (resp.status === 404) throw new Error("会话已过期");
            console.warn(`[小珠光] 分块 ${chunkIndex} 上传失败 (HTTP ${resp.status})，重试 ${attempt + 1}/${_XZG_VIDEO_RETRY}`);
        } catch (e) {
            console.warn(`[小珠光] 分块 ${chunkIndex} 上传异常:`, e.message, `，重试 ${attempt + 1}/${_XZG_VIDEO_RETRY}`);
        }
    }
    throw new Error(`分块 ${chunkIndex} 上传失败（已重试 ${_XZG_VIDEO_RETRY} 次）`);
}

// 并发上传所有分块
async function _xzgUploadAllChunks(file, sessionId, onProgress) {
    const totalChunks = Math.ceil(file.size / _XZG_VIDEO_CHUNK_SIZE);
    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
        const offset = i * _XZG_VIDEO_CHUNK_SIZE;
        const end = Math.min(offset + _XZG_VIDEO_CHUNK_SIZE, file.size);
        chunks.push({ index: i, offset, blob: file.slice(offset, end) });
    }

    let completed = 0;
    let queueIdx = 0;
    const finalResult = { filename: null };

    // 并发 worker
    async function worker() {
        while (queueIdx < chunks.length) {
            const chunk = chunks[queueIdx++];
            const result = await _xzgUploadOneChunk(sessionId, chunk.index, chunk.offset, chunk.blob);
            completed++;
            if (onProgress) onProgress(completed, totalChunks);
            if (result.status === "done") {
                finalResult.filename = result.filename;
            }
        }
    }

    // 启动 _XZG_VIDEO_CONCURRENCY 个 worker
    const workers = [];
    for (let i = 0; i < _XZG_VIDEO_CONCURRENCY; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    // 如果最后一个分块不是由当前 worker 完成的，需要查询状态
    if (!finalResult.filename) {
        const statusResp = await api.fetchApi(`/xzg/video_upload_status?session_id=${sessionId}`);
        if (statusResp.ok) {
            const status = await statusResp.json();
            if (status.done) {
                finalResult.filename = status.filename;
            }
        }
    }

    return finalResult.filename;
}

async function uploadVideoFiles(files, onProgress) {
    const uploaded = [];
    for (const file of files) {
        try {
            // 1GB 限制
            if (file.size > _XZG_VIDEO_MAX_SIZE) {
                _xzgVideoAlert(
                    `视频 "${file.name}"（${_xzgFormatSize(file.size)}）超过 1GB 限制。\n请压缩后再上传。`,
                    "上传失败"
                );
                continue;
            }

            let filename = null;

            if (file.size <= _XZG_VIDEO_CHUNK_SIZE) {
                // 小文件：走标准上传端点
                const body = new FormData();
                body.append("image", file);
                body.append("overwrite", "true");
                body.append("type", "input");
                const resp = await api.fetchApi("/upload/image", { method: "POST", body });
                if (resp.status === 200) {
                    const data = await resp.json();
                    if (data && data.name) filename = data.name;
                } else if (resp.status === 413) {
                    _xzgVideoAlert(
                        `视频 "${file.name}" 超过服务器上传限制，请使用分块上传。`,
                        "上传失败"
                    );
                }
            } else {
                // 大文件：分块上传
                const totalChunks = Math.ceil(file.size / _XZG_VIDEO_CHUNK_SIZE);
                if (onProgress) onProgress(0, totalChunks);

                // 启动会话
                const startResp = await api.fetchApi("/xzg/video_upload_start", {
                    method: "POST",
                    body: JSON.stringify({
                        filename: file.name,
                        total_size: file.size,
                        total_chunks: totalChunks,
                    }),
                    headers: { "Content-Type": "application/json" },
                });

                if (!startResp.ok) {
                    const errData = await startResp.json().catch(() => ({}));
                    _xzgVideoAlert(
                        `视频上传启动失败: ${errData.error || startResp.statusText}`,
                        "上传失败"
                    );
                    continue;
                }

                const startData = await startResp.json();
                const sessionId = startData.session_id;

                // 并发上传所有分块
                filename = await _xzgUploadAllChunks(file, sessionId, (completed, total) => {
                    if (onProgress) onProgress(completed, total);
                });

                if (!filename) {
                    _xzgVideoAlert(
                        `视频 "${file.name}" 分块上传未完成，请重试。`,
                        "上传失败"
                    );
                    continue;
                }
            }

            if (filename) {
                uploaded.push(filename);
            }
        } catch (e) {
            console.warn("[小珠光] 视频上传失败:", e);
            _xzgVideoAlert(
                `视频 "${file.name}" 上传失败: ${e.message}`,
                "上传失败"
            );
        }
    }
    return uploaded;
}

// 把值写回「跳过帧数/帧数上限/自定义宽高」控件：
// 若控件已转为 input（有上游连线），同步写回上游 PrimitiveNode / 同名 widget 并触发其 callback，
// 保证红蓝头、预览比例等联动正确；无连线时直接写回本节点 widget。
function _xzgWriteLinkedValue(node, inputName, value) {
    const inp = node.inputs?.find(x => x.name === inputName);
    if (inp && inp.link != null) {
        const graph = node.graph;
        const link = graph?.links?.[inp.link];
        if (link) {
            const originNode = graph.getNodeById(link.origin_id);
            if (originNode && originNode.widgets) {
                const pw = (originNode.type === "PrimitiveNode")
                    ? originNode.widgets[0]
                    : originNode.widgets.find(x => x.name === inputName);
                if (pw) {
                    pw.value = value;
                    if (typeof pw.callback === "function") pw.callback(value);
                    return;
                }
            }
        }
    }
    const w = node.widgets?.find(x => x.name === inputName);
    if (w) {
        w.value = value;
        if (typeof w.callback === "function") w.callback(value);
    }
}

async function refreshVideoCombo(videoWidget, selectName) {
    try {
        const resp = await api.fetchApi("/object_info/XiaozhuguangVideoLoader");
        if (!resp.ok) return;
        const info = await resp.json();
        const list = info?.XiaozhuguangVideoLoader?.input?.required?.["视频"]?.[0];
        if (Array.isArray(list)) {
            videoWidget.options.values = list;
            if (selectName && list.includes(selectName)) {
                videoWidget.value = selectName;
            } else if (list.length > 0) {
                videoWidget.value = list[list.length - 1];
            }
            videoWidget.callback?.(videoWidget.value);
        }
    } catch (_) {}
}

function bindVideoLoaderInteractions(node) {
    node.resizable = true;
    node.minWidth = 300;
    node.minHeight = 500;
    // 强制 setSize 不得小于最小尺寸（防止拖动右下角缩小）
    const origSetSize = node.setSize;
    node.setSize = function(size) {
        size[0] = Math.max(size[0], this.minWidth || 300);
        size[1] = Math.max(size[1], this.minHeight || 500);
        return origSetSize?.apply(this, arguments);
    };
    node.setSize([300, 500]);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = false;
    fileInput.accept = VIDEO_EXTS.map(e => "." + e).join(",");
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    const triggerUpload = () => {
        app.canvas.node_widget = null;
        fileInput.value = "";
        fileInput.click();
    };

    const playerContainer = document.createElement("div");
    playerContainer.className = "xzg-video-preview-container";
    playerContainer.style.width = "100%";
    playerContainer.style.background = "#1a1a1a";
    playerContainer.style.position = "relative";
    playerContainer.style.pointerEvents = "none";
    // 启用空格+拖动平移画布（DOM widget 默认会拦截 pointer 事件）
    xzgEnableCanvasPanOnSpace(playerContainer);
    // 注入全局 CSS：统一预览区背景色，避免 ComfyUI 默认样式干扰
    if (!document.getElementById("xzg-video-preview-style")) {
        const st = document.createElement("style");
        st.id = "xzg-video-preview-style";
        st.textContent = `
            .xzg-video-preview-container { background: #1a1a1a !important; }
            .xzg-video-preview-container, .xzg-video-preview-container * {
                user-select: none; -webkit-user-select: none;
            }
            .xzg-video-preview-container input,
            .xzg-video-preview-container textarea,
            .xzg-video-preview-container [contenteditable] {
                user-select: text; -webkit-user-select: text;
            }
        `;
        document.head.appendChild(st);
    }

    // Bypass 紫色覆盖层
    const bypassOverlay = document.createElement("div");
    bypassOverlay.style.cssText =
        "position:absolute;inset:0;background-color:rgba(106,36,106,0.6);pointer-events:none;z-index:100;display:none;";
    playerContainer.appendChild(bypassOverlay);

    // 上传进度覆盖层
    const uploadOverlay = document.createElement("div");
    uploadOverlay.style.cssText =
        "position:absolute;inset:0;background:rgba(0,0,0,0.85);display:none;flex-direction:column;align-items:center;justify-content:center;z-index:101;pointer-events:none;";
    const uploadTitle = document.createElement("div");
    uploadTitle.style.cssText = "color:#FFD700;font-size:13px;margin-bottom:8px;";
    uploadOverlay.appendChild(uploadTitle);
    const uploadBarBg = document.createElement("div");
    uploadBarBg.style.cssText = "width:80%;height:6px;background:#333;border-radius:3px;overflow:hidden;";
    const uploadBarFill = document.createElement("div");
    uploadBarFill.style.cssText = "width:0%;height:100%;background:linear-gradient(90deg,#B8860B,#FFD700,#FFF8DC);border-radius:3px;transition:width 0.3s ease;";
    uploadBarBg.appendChild(uploadBarFill);
    uploadOverlay.appendChild(uploadBarBg);
    const uploadPct = document.createElement("div");
    uploadPct.style.cssText = "color:#888;font-size:11px;margin-top:6px;";
    uploadOverlay.appendChild(uploadPct);
    playerContainer.appendChild(uploadOverlay);

    // 快剪联动按钮：点击后静默导出快剪时间线，自动加载到当前节点
    const fastcutBtn = document.createElement("button");
    fastcutBtn.title = "静默导出快剪编辑器的时间线内容并加载到当前节点";
    fastcutBtn.style.cssText =
        "position:absolute;top:6px;right:6px;z-index:102;" +
        "display:inline-flex;align-items:center;gap:4px;" +
        "padding:2px 6px;font-size:11px;line-height:1;" +
        "background:transparent;color:#dcc85b;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;" +
        "opacity:0;";
    fastcutBtn.innerHTML = '<span style="font-size:13px;">🎬</span><span>从快剪加载</span>';
    playerContainer.appendChild(fastcutBtn);

    // 鼠标进入预览区时显示按钮，离开时隐藏
    // playerContainer 本身 pointer-events:none，通过子元素冒泡的 mouseover/mouseout 监听
    playerContainer.addEventListener("mouseover", () => {
        fastcutBtn.style.opacity = "1";
    });
    playerContainer.addEventListener("mouseout", (e) => {
        // 只有当鼠标真正离开预览区时才隐藏
        // 导入过程中保持可见，让用户看到进度反馈
        if (!playerContainer.contains(e.relatedTarget) && !fastcutBtn.disabled) {
            fastcutBtn.style.opacity = "0";
        }
    });

    // wheel 事件转发：悬浮在从快剪加载按钮/上传遮罩等覆盖层上时，
    // 滚轮仍能触发布局缩放（与 video player 内部 _forwardWheel 保持一致）
    const _xzgForwardWheel = (e) => {
        const cv = app.canvas?.canvas;
        if (!cv) return;
        e.preventDefault();
        e.stopPropagation();
        cv.dispatchEvent(new WheelEvent('wheel', {
            deltaY: e.deltaY, deltaX: e.deltaX,
            clientX: e.clientX, clientY: e.clientY,
            ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
            bubbles: true, cancelable: true
        }));
    };
    playerContainer.addEventListener('wheel', _xzgForwardWheel, { passive: false });

    const showUploadProgress = (visible, completed, total) => {
        if (visible) {
            uploadOverlay.style.display = "flex";
            if (total > 0) {
                const pct = Math.round((completed / total) * 100);
                uploadTitle.textContent = "上传视频中...";
                uploadBarFill.style.width = pct + "%";
                uploadPct.textContent = `${pct}%`;
            } else {
                uploadTitle.textContent = "准备上传...";
                uploadBarFill.style.width = "0%";
                uploadPct.textContent = "";
            }
        } else {
            uploadOverlay.style.display = "none";
        }
    };

    const updateBypassState = () => {
        if (node.mode === 4) {
            bypassOverlay.style.display = "block";
        } else {
            bypassOverlay.style.display = "none";
        }
    };
    updateBypassState();

    node._xzgUpdateBypassState = updateBypassState;

    node._xzgSourceFps = null;

    const updateFpsLabel = (sourceFps) => {
        const fpsWidget = node.widgets?.find(w => w.name === "强制帧率");
        if (!fpsWidget) return;
        fpsWidget.label = _tr("强制帧率");
        node.setDirtyCanvas?.(true, true);
    };

    const updateFrameLimitLabel = () => {
        const limitWidget = node.widgets?.find(w => w.name === "帧数上限");
        if (!limitWidget) return;
        limitWidget.label = _tr("帧数上限");
        node.setDirtyCanvas?.(true, true);
    };

    const updateVideoInfoLabels = () => {
        // Canvas 架构：player.videoElement 始终返回 null，改用 player.src 判断
        if (!player.src) return;
        const ratioWidget = node.widgets?.find(w => w.name === "视频比例");
        const wWidget = node.widgets?.find(w => w.name === "自定义宽度");
        const hWidget = node.widgets?.find(w => w.name === "自定义高度");
        const isRatio = ratioWidget?.value !== "自定义比例";
        if (wWidget) {
            wWidget.label = isRatio ? _tr("边长模式") : _tr("自定义宽度");
        }
        if (hWidget) {
            hWidget.label = isRatio ? _tr("边长尺寸") : _tr("自定义高度");
        }
        updateFrameLimitLabel();
    };

    // 在 rAF 回调执行前，先声明引用，让 onLoadedMetadata 可安全调用
    let _syncLoadRange = null;
    // 仅应用加载范围（红蓝头定位），不重置回原视频
    let _applyLoadRange = null;

    const player = new XiaozhuguangVideoPlayer({
        container: playerContainer,
        onDblClick: triggerUpload,
        onLoadedMetadata: () => {
            updateVideoInfoLabels();
            // 只同步红蓝头，不触发 _resetToSourceVideo：
            // 预览视频（合成覆盖）加载完成后若走 _syncLoadRange 会立即把刚盖上的预览重置回原视频，
            // 导致"合成视频只盖一瞬间又显示默认比例"。参数变化时才由 _syncLoadRange 重置。
            _applyLoadRange?.();
        },
        onSourceFpsDetected: (fps) => {
            if (typeof fps === "number" && fps > 0) {
                node._xzgSourceFps = Math.round(fps);
                updateFpsLabel(fps);
                updateFrameLimitLabel();
                node.setDirtyCanvas?.(true, true);
            }
        },
        onSaveToDesktop: () => {
            const url = player.getSrc();
            if (!url) return;
            XiaozhuguangVideoPlayer.downloadVideo(url, _extractFilename(url));
        },
        // 拖拽红杠 → 更新跳过帧数（支持上游连线输入：写回上游控件）
        onLoadRangeStartDrag: (value, isEnd) => {
            const skipWidget = node.widgets?.find(w => w.name === "跳过帧数");
            if (!skipWidget) return;
            _xzgWriteLinkedValue(node, "跳过帧数", value);
            if (!isEnd) {
                _xzgShowLaserLine(skipWidget, node);
            } else {
                _xzgHideLaserLine();
            }
            node.setDirtyCanvas?.(true, true);
        },
        // 拖拽蓝杠 → 更新帧数上限（支持上游连线输入：写回上游控件）
        onLoadRangeEndDrag: (value, isEnd) => {
            const limitWidget = node.widgets?.find(w => w.name === "帧数上限");
            if (!limitWidget) return;
            _xzgWriteLinkedValue(node, "帧数上限", value);
            if (!isEnd) {
                _xzgShowLaserLine(limitWidget, node);
            } else {
                _xzgHideLaserLine();
            }
            node.setDirtyCanvas?.(true, true);
        },
    });
    node._xzgVideoPlayer = player;

    // 阻止拖放视频到预览区时浏览器默认打开新窗口
    const _onDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
    };
    playerContainer.addEventListener('dragover', _onDragOver, { capture: true });
    playerContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // 1. 文件拖入 → 上传 + 加载
        const files = Array.from(e.dataTransfer?.files || []).filter(f => isVideoFilename(f.name));
        if (files.length > 0) {
            const dt = new DataTransfer();
            files.forEach(f => dt.items.add(f));
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event("change", { bubbles: true }));
            return;
        }

        // 2. ComfyUI 内部拖入
        const textData = e.dataTransfer?.getData('text/plain');
        if (textData) {
            let rawName = textData;
            for (const s of [' [output]', ' [input]', ' [temp]']) {
                if (rawName.endsWith(s)) {
                    rawName = rawName.slice(0, -s.length);
                    break;
                }
            }
            if (isVideoFilename(rawName)) {
                player.load(getVideoUrl(textData));
                if (textData.includes(' [input]') || !textData.includes(' [')) {
                    const videoWidget = node.widgets?.find(w => w.name === "视频");
                    if (videoWidget) {
                        refreshVideoCombo(videoWidget, rawName);
                    }
                }
            }
        }
    }, { capture: true });

    const uploadBtn = node.addWidget("button", "上传视频", "upload", triggerUpload);
    uploadBtn.options.serialize = false;

    // 拦截 player.load 自动存储当前文件名（用于序列化恢复）
    player._currentFile = "";
    const _origPlayerLoad = player.load.bind(player);
    player.load = function (url) {
        if (url) {
            try {
                const p = new URL(url, location.origin);
                this._currentFile = p.searchParams.get("filename") || "";
            } catch (_) { this._currentFile = ""; }
        } else {
            this._currentFile = "";
        }
        return _origPlayerLoad(url);
    };

    // 视频播放区域下方的小字描述
    const hintText = document.createElement("div");
    hintText.textContent = _tr("单击视频播放或暂停/双击视频上传");
    hintText.style.cssText = `
        width: 100%; text-align: center; font-size: 11px; color: #666;
        padding: 4px 0 2px; pointer-events: none;
    `;
    playerContainer.appendChild(hintText);

    const previewWidget = node.addDOMWidget(VIDEO_PREVIEW_WIDGET_NAME, "video", playerContainer, {
        hideOnZoom: false,
        getValue() { return player._currentFile || ""; },
        setValue(v) {
            if (!v) { player.load(""); return; }
            // 旧版兼容：可能是完整 URL 字符串
            let filename = v;
            if (typeof v === "string" && v.startsWith("/view?")) {
                try {
                    filename = new URL(v, location.origin).searchParams.get("filename") || v;
                } catch (_) { }
            }
            const url = getVideoUrl(filename);
            if (url && url !== player.src) {
                player._currentFile = filename;
                player.load(url);
            } else if (!url) {
                player.load("");
            }
        },
    });
    // 与视频保存节点一致：DOM 预览 widget 的文件名只是显示产物（来源于权威的"视频"下拉框），
    // 不序列化，避免其作为独立字段持久化/进入缓存，防止与下拉框值发散。
    previewWidget.serialize = false;
    if (previewWidget.options) previewWidget.options.serialize = false;
    previewWidget.computeLayoutSize = function () {
        return { minHeight: VIDEO_PREVIEW_MIN_H, minWidth: 0 };
    };
    // 修复：ComfyUI（属性面板/线性模式渲染等）会把 DOM widget 的 width 写成
    // 面板侧行宽度（如 368px），而画布侧 DOM 宿主宽度 = widget.width - margin*2，
    // 一旦该值大于节点实际宽度，预览区就会溢出节点（随属性面板开/关变化）。
    // 这里把 width 定义为只读访问器，始终跟随节点实际宽度，忽略污染性写入。
    Object.defineProperty(previewWidget, 'width', {
        configurable: true,
        get() { return node.size?.[0] || 0; },
        set(_) { /* 忽略外部写入，防止预览区溢出节点 */ },
    });
    previewWidget.onRemove = () => {
        player.destroy();
        fileInput.remove();
    };

    const origOnResize = node.onResize;
    node.onResize = function (size) {
        const r = origOnResize?.apply(this, arguments);
        requestAnimationFrame(() => player.resize());
        return r;
    };

    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        _xzgHideLaserLine();
        player.destroy();
        fileInput.remove();
        return origOnRemoved?.apply(this, arguments);
    };

    const origOnConfigure = node.onConfigure;
    node.onConfigure = function (info) {
        origOnConfigure?.apply(this, arguments);
        requestAnimationFrame(() => {
            _applyWidgetStyles(node);
            _updateRatioWidgets(node);
            player.resize();
        });
    };

    // 从后端输出捕获视频真实帧率 + 实际加载帧数 + 宽高
    const origOnExecuted = node.onExecuted;
    node.onExecuted = function (output) {
        origOnExecuted?.apply(this, arguments);
        if (!output || !player) return;
        // ComfyUI onExecuted output 结构：{ result: [...], ui: {...} }
        // video_info 是返回值数组的第三个元素（index 2）
        const result = output.result || output;
        let vi = null;
        if (Array.isArray(result)) {
            vi = result[2];
        } else if (result && typeof result === "object") {
            vi = result.xzg_video_info || result.video_info || null;
        }
        if (vi) {
            const fps = vi.source_fps || vi.loaded_fps;
            if (typeof fps === "number" && fps > 0) {
                player.applyBackendFps(Math.round(fps));
            }
            // 记录原视频分辨率（供视频编辑器继承：自定义宽高为0时用此值）
            const sw = vi.source_width, sh = vi.source_height;
            if (typeof sw === "number" && typeof sh === "number" && sw > 0 && sh > 0) {
                node._xzgSourceWidth = Math.round(sw);
                node._xzgSourceHeight = Math.round(sh);
            }
            // 用后端实际加载的帧数（准确，避免前端推算误差）
            const lf = vi.loaded_frame_count;
            if (typeof lf === "number" && lf > 0) {
                player.setTotalFrames(lf);
            }
            // 用后端实际加载的宽高同步预览比例
            const lw = vi.loaded_width;
            const lh = vi.loaded_height;
            if (typeof lw === "number" && typeof lh === "number" && lw > 0 && lh > 0) {
                player.setCustomSize(lw, lh);
            }
            // 用后端返回的原始宽高/帧数更新标签
            updateVideoInfoLabels();
            // 视频加载完成后更新控件边界约束（跳过帧数 max、帧数上限 min/max）
            // 用 _applyLoadRange 而非 _syncLoadRange：执行后若预览视频已加载（_loadPreviewFromOutput），
            // _syncLoadRange 内的 _resetToSourceVideo 会把刚盖上的预览重置回原视频，导致预览闪烁/丢失
            _applyLoadRange?.();
        }
    };

    fileInput.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []).filter(f => isVideoFilename(f.name));
        if (files.length === 0) return;
        // 显示进度覆盖层
        const hasLargeFile = files.some(f => f.size > _XZG_VIDEO_CHUNK_SIZE);
        if (hasLargeFile) showUploadProgress(true, 0, 0);
        const uploaded = await uploadVideoFiles(files, (completed, total) => {
            showUploadProgress(true, completed, total);
        });
        showUploadProgress(false);
        if (uploaded.length > 0) {
            const videoWidget = node.widgets?.find(w => w.name === "视频");
            if (videoWidget) {
                await refreshVideoCombo(videoWidget, uploaded[0]);
                player.load(getVideoUrl(videoWidget.value));
            }
        }
        fileInput.value = "";
        node.setDirtyCanvas?.(true, true);
    });

    const origProcessDrop = node.processDrop;
    node.processDrop = function (e) {
        // 1. 操作系统文件拖入 → 上传 + 加载
        const files = Array.from(e.dataTransfer?.files || []).filter(f => isVideoFilename(f.name));
        if (files.length > 0) {
            e.preventDefault?.();
            e.stopPropagation?.();
            const dt = new DataTransfer();
            files.forEach(f => dt.items.add(f));
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }

        // 2. ComfyUI 内部拖入（从预览面板/文件列表拖出视频文件名）
        const textData = e.dataTransfer?.getData('text/plain');
        if (textData) {
            // 去掉 [output]/[input]/[temp] 后缀再判断扩展名
            let rawName = textData;
            for (const s of [' [output]', ' [input]', ' [temp]']) {
                if (rawName.endsWith(s)) {
                    rawName = rawName.slice(0, -s.length);
                    break;
                }
            }
            if (isVideoFilename(rawName)) {
                e.preventDefault?.();
                e.stopPropagation?.();
                // 直接用 getVideoUrl 解析文件名 + 类型，加载视频
                _isPreviewLoaded = false;
                player.load(getVideoUrl(textData));
                // 如果是 input 类型，同步下拉列表
                if (textData.includes(' [input]') || !textData.includes(' [')) {
                    const videoWidget = node.widgets?.find(w => w.name === "视频");
                    if (videoWidget) {
                        refreshVideoCombo(videoWidget, rawName);
                    }
                }
                return true;
            }
        }

        return origProcessDrop?.apply(this, arguments);
    };

    requestAnimationFrame(() => {
        const videoWidget = node.widgets?.find(w => w.name === "视频");
        if (videoWidget) {
            const origCb = videoWidget.callback;
            videoWidget.callback = function (value) {
                origCb?.apply(this, arguments);
                const url = getVideoUrl(value);
                _isPreviewLoaded = false;
                player.load(url || "");
            };
            if (videoWidget.value) {
                player.load(getVideoUrl(videoWidget.value));
            }
        }

        // 快剪联动按钮：静默导出快剪时间线 → 自动加载到当前节点
        const _fastcutOriginalText = "从快剪加载";
        // 只更新文字 span，保留前面的 🎬 图标
        const _setFastcutText = (text) => {
            const spans = fastcutBtn.querySelectorAll("span");
            const textSpan = spans[spans.length - 1];
            if (textSpan) textSpan.textContent = text;
        };
        fastcutBtn.addEventListener("mouseenter", () => {
            if (fastcutBtn.disabled) return;
            fastcutBtn.style.color = "#fff";
        });
        fastcutBtn.addEventListener("mouseleave", () => {
            if (fastcutBtn.disabled) return;
            fastcutBtn.style.color = "#dcc85b";
        });
        fastcutBtn.onclick = () => {
            // 防止重复点击
            if (fastcutBtn.disabled) return;
            fastcutBtn.disabled = true;
            _setFastcutText("等待确认...");
            fastcutBtn.style.color = "#fff";

            // 注册回调：用户在快剪中点击"确认"→ 导出完成后加载到当前节点
            // 兼容两种签名：
            //   旧：(filename, type)   → 双字符串
            //   新：(data)             → { filename, type, audio_only, ... }
            window._xzgOnVideoEditorExport = (firstArg, secondArg) => {
                const isObj = firstArg && typeof firstArg === "object" && !Array.isArray(firstArg);
                const data = isObj ? firstArg : null;
                const filename = data ? (data.filename || "") : (firstArg || "");
                const type = data ? (data.type || "output") : (secondArg || "output");
                // 纯音频导出时交给回调消费，当前节点（视频加载器）不处理
                if (data && data.audio_only) return;
                const annotated = `${filename} [${type}]`;
                if (videoWidget) {
                    videoWidget.value = annotated;
                    videoWidget.callback?.(annotated);
                } else {
                    player.load(getVideoUrl(annotated));
                }
            };

            const confirmCallback = (result) => {
                fastcutBtn.disabled = false;
                if (result && result.error) {
                    _setFastcutText("失败");
                    fastcutBtn.style.color = "#ff6b6b";
                    console.warn("[小珠光] 快剪加载失败:", result.error);
                    setTimeout(() => {
                        _setFastcutText(_fastcutOriginalText);
                        fastcutBtn.style.color = "#dcc85b";
                    }, 2000);
                } else if (result && result.filename && !result.audio_only) {
                    _setFastcutText("已加载");
                    fastcutBtn.style.color = "#9FC615";
                    setTimeout(() => {
                        _setFastcutText(_fastcutOriginalText);
                        fastcutBtn.style.color = "#dcc85b";
                    }, 1500);
                } else if (result && result.audio_only) {
                    // 音频导出被视频加载器忽略（交给音频加载器）
                    _setFastcutText("已导出音频");
                    fastcutBtn.style.color = "#9FC615";
                    setTimeout(() => {
                        _setFastcutText(_fastcutOriginalText);
                        fastcutBtn.style.color = "#dcc85b";
                    }, 1500);
                } else {
                    // 无结果（用户直接关闭但未导出）→ 恢复按钮
                    _setFastcutText(_fastcutOriginalText);
                    fastcutBtn.style.color = "#dcc85b";
                }
            };

            // 打开快剪编辑器，并传入 confirmCallback
            // modeFilter: "video" → 快剪只显示视频格式、隐藏「导出」按钮（仅「确认」导出）
            if (typeof window._xzgOpenVideoEditor === "function") {
                window._xzgOpenVideoEditor({ confirmCallback, modeFilter: "video" });
            } else {
                // 兼容：启动器未加载（理论上不会发生），恢复按钮
                _setFastcutText("快剪未加载");
                fastcutBtn.style.color = "#ff6b6b";
                fastcutBtn.disabled = false;
                setTimeout(() => {
                    _setFastcutText(_fastcutOriginalText);
                    fastcutBtn.style.color = "#dcc85b";
                }, 2000);
            }
        };
        // 同步强制帧率到播放器
        const fpsWidget = node.widgets?.find(w => w.name === "强制帧率");
        // 帧率变化时更新label（包括播放器初始化和自动检测）
        player.onFpsChange = (fps) => {
            updateFpsLabel(fps);
            updateVideoInfoLabels();
        };
        if (fpsWidget) {
            const origFpsCb = fpsWidget.callback;
            fpsWidget.callback = function (value) {
                origFpsCb?.apply(this, arguments);
                const fps = Number(value);
                if (fps > 0) {
                    player.setFrameRate(fps);
                } else {
                    player.resetFrameRate();
                }
            };
            const initFps = Number(fpsWidget.value);
            if (initFps > 0) {
                player.setFrameRate(initFps);
            } else {
                player.resetFrameRate();
            }
        }
        // 同步自定义宽高到播放器，预览比例随参数变化
        const wWidget = node.widgets?.find(w => w.name === "自定义宽度");
        const hWidget = node.widgets?.find(w => w.name === "自定义高度");

        // 追踪外部连线输入的值：当 widget 被转为 input 时，
        // 通过 graph.links 追溯到上游节点（通常是 PrimitiveNode）读取其 widget 值
        const _resolveLinkedValue = (inputName) => {
            // 先检查对应的 input 是否有连线 → 有连线时优先从连线追溯
            const inp = node.inputs?.find(x => x.name === inputName);
            if (inp && inp.link != null) {
                const graph = node.graph;
                if (graph && graph.links) {
                    const link = graph.links[inp.link];
                    if (link) {
                        const originNode = graph.getNodeById(link.origin_id);
                        if (originNode) {
                            // PrimitiveNode（ComfyUI widget→input 转换节点）：读其 widget 值
                            if (originNode.type === "PrimitiveNode" && originNode.widgets) {
                                const pw = originNode.widgets[0];
                                if (pw) return Number(pw.value) || 0;
                            }
                            // 其他节点：尝试匹配同名的输出 widget 值
                            if (originNode.widgets) {
                                const pw = originNode.widgets.find(x => x.name === inputName);
                                if (pw) return Number(pw.value) || 0;
                            }
                        }
                    }
                }
            }
            // 无连线 → 使用 widget 自身值
            const w = node.widgets?.find(x => x.name === inputName);
            if (w) return Number(w.value) || 0;
            return 0;
        };

        // ═══════════════════════════════════════════════════════════════════
        // 预览视频重置机制：
        //   工作流运行后，预览视频（转码后的临时文件）会覆盖播放器，
        //   导致播放条总帧数变为处理后的帧数，与原视频不一致。
        //   当分辨率/跳过帧/加载上限变化时，立即重载原视频，
        //   播放条总帧数恢复为原视频总帧数，已有 setCustomSize/setLoadRange
        //   机制会自动应用当前参数进行渲染。
        // ═══════════════════════════════════════════════════════════════════
        let _isPreviewLoaded = false;

        const _resetToSourceVideo = () => {
            if (!_isPreviewLoaded) return;
            const vw = node.widgets?.find(w => w.name === "视频");
            if (!vw?.value) return;

            // 保存当前播放头位置（按帧数）
            const fps = player._frameRate || 24;
            const savedFrame = Math.round((player._currentTime || 0) * fps);

            _isPreviewLoaded = false;
            // 延迟一帧执行 load，确保拖动的 pointerup 事件先处理完毕，
            // 避免页面重渲染导致数字输入框意外进入编辑模式
            requestAnimationFrame(() => {
                player.load(getVideoUrl(vw.value));
            });

            // 加载完成后重新应用参数并恢复播放头
            const origOnLoaded = player.onLoadedMetadata;
            player.onLoadedMetadata = function () {
                try {
                    syncCustomSize();
                    // 这里已是"重置后重新加载原视频"，只需应用加载范围，避免再次重置
                    _applyLoadRange?.();
                    // 恢复播放头（clamp 到加载范围内）
                    if (savedFrame > 0) {
                        const skip = Math.max(0, parseInt(_resolveLinkedValue("跳过帧数")) || 0);
                        const limit = Math.max(0, parseInt(_resolveLinkedValue("帧数上限")) || 0);
                        const total = player.getSourceTotalFrames ? player.getSourceTotalFrames() : 0;
                        let end = total > 0 ? total : savedFrame + 1;
                        if (limit > 0) end = Math.min(end, skip + limit);
                        const targetFrame = Math.max(skip, Math.min(savedFrame, Math.max(skip, end - 1)));
                        player.seek(targetFrame / fps);
                    }
                } finally {
                    player.onLoadedMetadata = origOnLoaded;
                    if (origOnLoaded) origOnLoaded.apply(this, arguments);
                }
            };
        };

        const syncCustomSize = () => {
            const ratioW = node.widgets?.find(w => w.name === "视频比例");
            const ratioVal = ratioW?.value;
            // 预设比例模式：根据预设值直接设置预览比例
            if (ratioVal && ratioVal !== "自定义比例") {
                if (ratioVal === "原始比例") {
                    // 清除自定义比例，使用视频原始比例
                    player.setCustomSize(0, 0);
                } else {
                    // 解析 "横屏16:9" / "竖屏9:16" / "等比1:1" 等
                    const m = String(ratioVal).match(/(\d+)\s*[:：]\s*(\d+)/);
                    if (m) {
                        player.setCustomSize(parseInt(m[1], 10), parseInt(m[2], 10));
                    }
                }
                return;
            }
            // 自定义比例：同时兼容 widget 直接输入和外部连线输入
            const cw = _resolveLinkedValue("自定义宽度");
            const ch = _resolveLinkedValue("自定义高度");
            player.setCustomSize(cw, ch);
        };
        // 暴露给右键菜单调用（尽早赋值，避免后续代码异常导致无法访问）
        node._xzgSyncCustomSize = syncCustomSize;
        [wWidget, hWidget].forEach(w => {
            if (!w) return;
            const origCb = w.callback;
            w.callback = function (value) {
                origCb?.apply(this, arguments);
                syncCustomSize();
            };
        });

        // 当连线变化时（widget 被转为 input 或外部连线接入/断开），重新同步预览比例
        const origOnConnectionsChange = node.onConnectionsChange;
        const _xzgUpstreamHooks = new Set();
        const _hookUpstreamWidget = (originNode, inputName) => {
            if (!originNode || !originNode.widgets) return;
            const pw = originNode.widgets[0] || originNode.widgets.find(x => x.name === inputName);
            if (!pw || pw._xzgHooked) return;
            pw._xzgHooked = true;
            _xzgUpstreamHooks.add(pw);
            const origPwCb = pw.callback;
            pw.callback = function (value) {
                origPwCb?.apply(this, arguments);
                // 宽高 → 同步预览比例；跳过/上限 → 同步加载范围（红蓝头）
                if (inputName === "跳过帧数" || inputName === "帧数上限") {
                    _syncLoadRange?.();
                } else {
                    syncCustomSize();
                }
            };
        };
        const _hookAllUpstream = () => {
            ["自定义宽度", "自定义高度", "跳过帧数", "帧数上限"].forEach(name => {
                const inp = node.inputs?.find(x => x.name === name);
                if (!inp || !inp.link) return;
                const graph = node.graph;
                const link = graph?.links?.[inp.link];
                if (!link) return;
                _hookUpstreamWidget(graph.getNodeById(link.origin_id), name);
            });
        };
        node.onConnectionsChange = function (side, slot, connected, link_info) {
            origOnConnectionsChange?.apply(this, arguments);
            // 仅处理 input 侧变化（side === 1 为 input，LiteGraph 约定）
            if (side === 1) {
                const inp = this.inputs?.[slot];
                if (inp && (inp.name === "自定义宽度" || inp.name === "自定义高度" ||
                            inp.name === "跳过帧数" || inp.name === "帧数上限")) {
                    setTimeout(() => { _hookAllUpstream(); syncCustomSize(); _syncLoadRange?.(); }, 0);
                }
            }
        };

        // 工作流加载后重新同步（graph configure 后连线才可用）
        const origOnAfterGraphConfigured = node.onAfterGraphConfigured;
        node.onAfterGraphConfigured = function () {
            origOnAfterGraphConfigured?.apply(this, arguments);
            setTimeout(() => { _hookAllUpstream(); syncCustomSize(); _syncLoadRange?.(); }, 0);
        };

        syncCustomSize();
        const limitWidget = node.widgets?.find(w => w.name === "帧数上限");
        const skipWidget = node.widgets?.find(w => w.name === "跳过帧数");

        // 更新控件的 min/max 边界约束
        const updateWidgetBounds = () => {
            if (!skipWidget && !limitWidget) return;
            const totalFrames = typeof player.getSourceTotalFrames === "function"
                ? player.getSourceTotalFrames()
                : (player._sourceTotalFrames || 0);
            // 支持上游连线输入：优先读取连线值（widget 转 input 后自身 value 不更新）
            const skipVal = Math.max(0, parseInt(_resolveLinkedValue("跳过帧数")) || 0);
            if (totalFrames > 0) {
                // 跳过帧数最大值 = 原始帧数 - 1
                if (skipWidget) skipWidget._xzgMax = totalFrames - 1;
                // 帧数上限：拖动时限制为剩余帧数，输入时不限制（用 BIGMAX）
                if (limitWidget) {
                    limitWidget._xzgDragMax = Math.max(0, totalFrames - skipVal);
                    // _xzgMax 保持为后端定义的最大值，不限制手动输入
                }
            }
            // 帧数上限最小值保持 0（0 表示无限制/加载全部剩余帧），不跟随跳过帧数变动
            // 约束当前值（跳过帧数严格限制，帧数上限只在拖动时限制，输入不限制）
            if (skipWidget && skipWidget._xzgMax != null && skipWidget.value > skipWidget._xzgMax) {
                skipWidget.value = skipWidget._xzgMax;
            }
        };

        // 仅应用加载范围（红蓝头定位），不重置回原视频。
        // 用于视频/预览加载完成后的 onLoadedMetadata —— 预览（合成覆盖）加载完成后若走
        // _syncLoadRange 会立即把刚盖上的预览重置回原视频（"只盖一瞬间"）。参数变化时才重置。
        _applyLoadRange = () => {
            updateWidgetBounds();
            // 支持上游连线输入：优先读取连线值（widget 转 input 后自身 value 不更新）
            const skip = Math.max(0, parseInt(_resolveLinkedValue("跳过帧数")) || 0);
            const limit = Math.max(0, parseInt(_resolveLinkedValue("帧数上限")) || 0);
            if (typeof player.setLoadRange === "function") {
                player.setLoadRange(skip, limit);
            }
        };
        _syncLoadRange = () => {
            // 参数变化（用户交互 / 上游变化）：先重置回原视频再应用加载范围
            _resetToSourceVideo();
            _applyLoadRange();
        };
        if (limitWidget) {
            const origLimitCb = limitWidget.callback;
            limitWidget.callback = function (value) {
                origLimitCb?.apply(this, arguments);
                updateFrameLimitLabel();
                _syncLoadRange();
            };
        }
        if (skipWidget) {
            const origSkipCb = skipWidget.callback;
            skipWidget.callback = function (value) {
                origSkipCb?.apply(this, arguments);
                // 跳过帧数变化时，帧数上限的 min 跟随变化
                _syncLoadRange();
            };
        }
        updateFrameLimitLabel();
        _syncLoadRange();
        // 视频比例变化时切换自定义宽度/高度的行为
        const ratioWidget = node.widgets?.find(w => w.name === "视频比例");
        if (ratioWidget) {
            const origRatioCb = ratioWidget.callback;
            ratioWidget.callback = function (value) {
                origRatioCb?.apply(this, arguments);
                _updateRatioWidgets(node);
                syncCustomSize();
            };
        }
        _updateRatioWidgets(node);

        // ═══════════════════════════════════════════════════════════════════
        // 工作流执行后自动加载预览视频到预览区（立即加载策略）
        // 核心思路：
        //   视频加载器是 OUTPUT_NODE = True，ComfyUI 在节点执行完后立即发送
        //   executed 事件，detail.output 里直接包含 ui.video_preview 数据，
        //   不需要轮询 history，也不用等下游节点执行完毕。
        //   execution_success 兜底处理节点被缓存等极端情况。
        // ═══════════════════════════════════════════════════════════════════

        let _previewLoadedForPrompt = new Set();  // 记录已经加载过 preview 的 prompt_id，避免重复

        const _loadPreviewFromOutput = (output, promptId) => {
            if (promptId && _previewLoadedForPrompt.has(promptId)) return false;
            if (!output) return false;
            const previewList = output?.video_preview;
            if (!Array.isArray(previewList) || previewList.length === 0) return false;
            const preview = previewList[0];
            const filename = preview?.filename;
            if (!filename) return false;

            const subfolder = preview?.subfolder || "";
            const type = preview?.type || "temp";
            const params = new URLSearchParams({ filename, type, subfolder });
            const url = `/view?${params.toString()}&rand=${Math.random()}`;
            console.warn("[小珠光视频加载器] (立即)加载预览视频到预览区: " + filename);
            player.load(url);
            _isPreviewLoaded = true;
            node.setDirtyCanvas(true, true);
            if (promptId) _previewLoadedForPrompt.add(promptId);
            return true;
        };

        // executed 事件：OUTPUT_NODE 执行完后立即发送，payload 自带 output
        const _onExecuted = ({ detail }) => {
            if (!detail) return;
            if (String(detail.node) !== String(node.id)) return;
            _loadPreviewFromOutput(detail.output, detail.prompt_id);
        };
        api.addEventListener("executed", _onExecuted);

        // execution_cached：节点被缓存跳过（同样会被视为已执行），也要尝试加载 preview
        const _onExecutionCached = async ({ detail }) => {
            const nodes = detail?.nodes || [];
            if (!nodes.includes(Number(node.id)) && !nodes.includes(String(node.id))) return;
            const promptId = detail?.prompt_id;
            if (!promptId) return;
            try {
                const resp = await fetch(`/api/history/${promptId}`);
                if (!resp.ok) return;
                const history = await resp.json();
                const promptHistory = history?.[promptId] || history;
                const outputs = promptHistory?.outputs || {};
                const nodeOutput = outputs[String(node.id)];
                _loadPreviewFromOutput(nodeOutput, promptId);
            } catch (_) {}
        };
        api.addEventListener("execution_cached", _onExecutionCached);

        // 兜底：execution_success 时若还没加载，从 history 再试一次（比如 OUTPUT_NODE 标记未生效的情况）
        const _onExecutionSuccess = async ({ detail }) => {
            const promptId = detail?.prompt_id;
            if (!promptId) return;
            if (_previewLoadedForPrompt.has(promptId)) return;
            try {
                const resp = await fetch(`/api/history/${promptId}`);
                if (!resp.ok) return;
                const history = await resp.json();
                const promptHistory = history?.[promptId] || history;
                const outputs = promptHistory?.outputs || {};
                const nodeOutput = outputs[String(node.id)];
                _loadPreviewFromOutput(nodeOutput, promptId);
            } catch (_) {}
        };
        api.addEventListener("execution_success", _onExecutionSuccess);

        // 开始新执行时清理旧的 prompt_id 记录（防止内存无限增长）
        const _onExecutionStart = ({ detail }) => {
            // 只保留最近 5 个 prompt_id，避免记录无限增长
            if (_previewLoadedForPrompt.size > 8) {
                const arr = Array.from(_previewLoadedForPrompt);
                _previewLoadedForPrompt = new Set(arr.slice(arr.length - 5));
            }
            // 新执行开始，若被缓存（execution_cached 在 execution_start 之前发）
            // 那 prompt_id 已经在 Set 里了，没关系，_loadPreviewFromOutput 会跳过
        };
        api.addEventListener("execution_start", _onExecutionStart);

        // 节点移除时清理所有事件监听，避免内存泄漏
        const _origOnRemoved = node.onRemoved;
        node.onRemoved = function () {
            try { api.removeEventListener("executed", _onExecuted); } catch (_) {}
            try { api.removeEventListener("execution_cached", _onExecutionCached); } catch (_) {}
            try { api.removeEventListener("execution_success", _onExecutionSuccess); } catch (_) {}
            try { api.removeEventListener("execution_start", _onExecutionStart); } catch (_) {}
            _origOnRemoved?.apply(this, arguments);
        };

        player.resize();
    });
}

app.registerExtension({
    name: "xiaozhuguang.video_loader",
    getCustomWidgets() {
        return {
            XZGINT: (node, name, data) => _xzgCreateNumberWidget(node, name, data),
            XZGFLOAT: (node, name, data) => _xzgCreateNumberWidget(node, name, data),
            XZGCOMBO: (node, name, data) => _xzgCreateComboWidget(node, name, data),
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "XiaozhuguangVideoLoader") {
            // 强制帧率：强制走自定义 number widget，从源头避免原生 combo 列表
            if (nodeData.input?.required?.["强制帧率"]) {
                nodeData.input.required["强制帧率"][1].widgetType = "XZGFLOAT";
            }
            // 注入自定义 widget 类型：INT/FLOAT → XZG 数值控件，combo(数组) → XZGCOMBO 自定义下拉
            // 完全绕过 ComfyUI 原生 combo 渲染，避免出现输入 value 框
            for (const inp of Object.values({ ...nodeData.input?.required, ...nodeData.input?.optional })) {
                if (!inp || !inp[1]) continue;
                if (["INT", "FLOAT"].includes(inp[0])) {
                    inp[1].widgetType ??= "XZG" + inp[0];
                } else if (Array.isArray(inp[0])) {
                    inp[1].widgetType ??= "XZGCOMBO";
                }
            }
            const correctOutputs = [_tr("图像"), _tr("音频"), _tr("视频信息")];
            if (nodeData.outputs && Array.isArray(nodeData.outputs)) {
                nodeData.outputs.forEach((out, i) => {
                    if (correctOutputs[i]) out.name = correctOutputs[i];
                });
            }
            if (nodeData.output_name && Array.isArray(nodeData.output_name)) {
                nodeData.output_name = nodeData.output_name.slice(0, correctOutputs.length).map((n, i) => correctOutputs[i] || n);
            }
            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = origOnNodeCreated?.apply(this, arguments);
                bindVideoLoaderInteractions(this);
                _xzgPatchCanvasPrompt();
                _applyWidgetStyles(this);
                if (this.outputs) {
                    this.outputs.forEach((out, i) => {
                        if (correctOutputs[i]) {
                            out.name = correctOutputs[i];
                            out.label = correctOutputs[i];
                        }
                    });
                }
                return r;
            };

            // 绕过状态更新（画布重绘时同步）
            const origOnDrawBackground = nodeType.prototype.onDrawBackground;
            nodeType.prototype.onDrawBackground = function (ctx) {
                if (this._xzgVideoPlayer && this._xzgUpdateBypassState) {
                    this._xzgUpdateBypassState();
                }
                return origOnDrawBackground?.apply(this, arguments);
            };
        }
    },
});
