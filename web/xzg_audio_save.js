/**
 * 小珠光音频保存 - 前端波形显示 + 右键保存菜单
 * 
 * 功能：
 * - 波形可视化（参考音频加载器的波纹样式）
 * - 格式选择（MP3/WAV/FLAC）+ 质量滑块
 * - 右键音轨 → 弹出保存菜单（File System Access API，首次桌面，二次上次路径）
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { downloadAudio, xzgTimestamp } from "./xzg_save_utils.js";


// ═══════════════════════════════════════════════════════════════════════
// 自定义数值 widget（VHS 同款方案）
// ═══════════════════════════════════════════════════════════════════════

function _xzgWidgetNumberMouse(event, [x, y], node) {
    const oldValue = this.value;
    const step = this._xzgStep || 1;
    const min = this._xzgMin;
    const max = this._xzgMax;

    const clamp = (v) => {
        if (min != null && v < min) v = min;
        if (max != null && v > max) v = max;
        return v;
    };

    if (event.type === 'pointermove') {
        if (event.deltaX) {
            let newVal = this.value + event.deltaX * step * 0.1;
            newVal = Math.round(newVal / step) * step;
            this.value = clamp(newVal);
            app.canvas._xzgValueDragged = true;
        }
    } else if (event.type === 'pointerup') {
        if (app.canvas._xzgValueDragged) {
            this.value = clamp(Math.round(this.value / step) * step);
        } else {
            app.canvas._xzgAllowPrompt = true;
            try {
                app.canvas?.prompt?.(this.label || this.name, this.value, (v) => {
                    this.value = clamp(Number(v));
                    if (this.callback) this.callback(this.value);
                    node.setDirtyCanvas?.(true, true);
                }, event);
            } finally {
                // 若 prompt 不存在或抛错，也清掉许可，避免后续点击误放行原生输入框。
                app.canvas._xzgAllowPrompt = false;
            }
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

function _xzgDrawWidget(ctx, node, width, y, H) {
    // 属性面板切换等触发节点 reflow 时，widget 传入的宽/高可能与 node.size 暂时不一致，
    // 强制把该行绘制限制在节点实际边界内，避免溢出节点（与波形钳制一致）
    const _nW = node?.size?.[0], _nH = node?.size?.[1];
    if (_nW != null && _nW > 0) width = Math.max(1, Math.min(width, _nW));
    if (_nH != null && _nH > 0) H = Math.max(1, Math.min(H, Math.max(0, _nH - y)));
    this._xzgDrawW = width;
    const pad = 16, r = 6, w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(pad, y + 1, w, H - 2, r); else ctx.rect(pad, y + 1, w, H - 2);
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();
    ctx.fillStyle = '#9ab';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label || this.name || '', pad + 6, y + H / 2);
    const valueText = String(this.value);
    ctx.fillStyle = this._xzgValueColor || '#fff';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(valueText, width - pad - 6, y + H / 2);
}

// 音频保存器紧凑双列字段：两列各占半行，供“格式/质量”和“文件名前缀/模式”共用。
function _xzgDrawSavePairCell(ctx, node, width, y, H, side, label, value, options = {}) {
    const nodeW = node?.size?.[0];
    if (nodeW != null && nodeW > 0) width = Math.max(1, Math.min(width, nodeW));
    const outer = 16, gap = 8;
    const cellW = Math.max(1, (width - outer * 2 - gap) / 2);
    const x = outer + side * (cellW + gap);
    const disabled = !!options.disabled;
    ctx.fillStyle = disabled ? '#222' : '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y + 1, cellW, H - 2, 6);
    else ctx.rect(x, y + 1, cellW, H - 2);
    ctx.fill();
    ctx.strokeStyle = disabled ? '#333' : '#444';
    ctx.stroke();

    const labelX = x + 7;
    ctx.font = '11px sans-serif';
    const labelW = Math.min(ctx.measureText(label).width, cellW * 0.48);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = disabled ? '#555' : '#9ab';
    ctx.fillText(label, labelX, y + H / 2, labelW);

    const arrowW = options.dropdown && !disabled ? 12 : 0;
    const valueRight = x + cellW - 7 - arrowW;
    const valueMaxW = Math.max(12, valueRight - (labelX + labelW + 6));
    let text = String(value ?? '');
    ctx.font = '12px sans-serif';
    while (text.length && ctx.measureText(text).width > valueMaxW) text = text.slice(0, -1);
    if (text !== String(value ?? '') && text.length) text = text.slice(0, -1) + '…';
    ctx.textAlign = 'right';
    ctx.fillStyle = disabled ? '#555' : (options.valueColor || '#fff');
    ctx.fillText(text, valueRight, y + H / 2);

    if (options.dropdown && !disabled) {
        const cx = x + cellW - 11, cy = y + H / 2;
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy - 1);
        ctx.lineTo(cx + 3, cy - 1);
        ctx.lineTo(cx, cy + 3);
        ctx.closePath();
        ctx.fill();
    }
}

// combo 下拉样式
function _xzgDrawComboWidget(ctx, node, width, y, H) {
    // 属性面板切换等触发节点 reflow 时，widget 传入的宽/高可能与 node.size 暂时不一致，
    // 强制把该行绘制限制在节点实际边界内，避免溢出节点（与波形钳制一致）
    const _nW = node?.size?.[0], _nH = node?.size?.[1];
    if (_nW != null && _nW > 0) width = Math.max(1, Math.min(width, _nW));
    if (_nH != null && _nH > 0) H = Math.max(1, Math.min(H, Math.max(0, _nH - y)));
    this._xzgDrawW = width;
    const pad = 16, r = 6, w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(pad, y + 1, w, H - 2, r); else ctx.rect(pad, y + 1, w, H - 2);
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();

    // 左侧标签
    const labelText = this.label || this.name || '';
    ctx.fillStyle = '#9ab';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelMaxW = width - pad * 2 - 60;
    if (ctx.measureText(labelText).width > labelMaxW) {
        let truncated = labelText;
        while (ctx.measureText(truncated + '…').width > labelMaxW && truncated.length > 0) truncated = truncated.slice(0, -1);
        ctx.fillText(truncated + '…', pad + 6, y + H / 2);
    } else {
        ctx.fillText(labelText, pad + 6, y + H / 2);
    }

    // 右侧当前值（若有 _xzgDisplayVal 则用其转换，如质量 192→中 192kbps）
    const rawVal = String(this.value ?? '');
    const displayText = this._xzgDisplayVal ? this._xzgDisplayVal(rawVal) : rawVal;
    ctx.fillStyle = '#fff';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    const valMaxW = width - pad * 2 - 54;
    if (ctx.measureText(displayText).width > valMaxW) {
        let truncated = displayText;
        while (ctx.measureText(truncated + '…').width > valMaxW && truncated.length > 0) truncated = truncated.slice(0, -1);
        ctx.fillText(truncated + '…', width - pad - 16, y + H / 2);
    } else {
        ctx.fillText(displayText, width - pad - 16, y + H / 2);
    }

    // 下拉箭头 ▼
    ctx.fillStyle = '#888';
    ctx.beginPath();
    const dx = width - pad - 8, dy = y + H / 2;
    ctx.moveTo(dx - 4, dy - 2);
    ctx.lineTo(dx + 4, dy - 2);
    ctx.lineTo(dx, dy + 3);
    ctx.closePath();
    ctx.fill();
}

// combo mouse handler
function _xzgComboMouse(event, [x, y], node) {
    if (event.type === 'pointerdown') {
        return false; // 不捕获指针
    }
    if (event.type === 'pointerup') {
        _xzgShowComboDropdown(this, node, event);
        return true;
    }
    return true;
}

function _xzgShowComboDropdown(widget, node, event) {
    const old = document.querySelector('.xzg-save-combo-dropdown');
    if (old) old.remove();

    // 主动释放画布上可能存在的指针捕获，确保 DOM 下拉列表能正常接收鼠标事件
    const canvasEl = app.canvas?.canvas;
    if (canvasEl && typeof canvasEl.hasPointerCapture === 'function' && event.pointerId != null) {
        try { canvasEl.releasePointerCapture(event.pointerId); } catch (e) {}
    }

    const values = widget.options?.values || ["mp3", "wav", "flac"];
    const displayFn = widget._xzgDisplayVal;
    const dropdown = document.createElement('div');
    dropdown.className = 'xzg-save-combo-dropdown';
    dropdown.style.cssText = `
        position: fixed; z-index: 99999; left: ${Math.max(4, event.clientX - 60)}px; top: ${event.clientY + 4}px;
        min-width: 100px; background: #2a2a2a; border: 1px solid #555; border-radius: 6px;
        padding: 4px 0; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    `;

    let selected = false;
    const doSelect = (v) => {
        if (selected) return;
        selected = true;
        widget.value = v;
        // callback 调用用 try-catch 包裹，防止报错导致下拉不消失
        try {
            if (widget.callback) widget.callback.call(widget, v);
        } catch (e) {
            console.warn('[小珠光] 格式切换 callback 报错:', e);
        }
        node.setDirtyCanvas?.(true, true);
        dropdown.remove();
        document.removeEventListener('pointerdown', close, true);
    };

    values.forEach(v => {
        const item = document.createElement('div');
        const isSelected = String(v) === String(widget.value);
        item.textContent = displayFn ? displayFn(String(v)) : v.toUpperCase();
        item.style.cssText = `padding: 4px 16px; cursor: pointer; font-size: 13px; color: ${isSelected ? '#FFD700' : '#ccc'}; background: ${isSelected ? '#333' : 'transparent'};`;
        item.onmouseenter = () => { item.style.background = '#444'; };
        item.onmouseleave = () => { item.style.background = isSelected ? '#333' : 'transparent'; };
        // 用 mousedown 触发选择（鼠标事件不受 pointer capture 影响）
        item.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            doSelect(v);
        });
        // click 作为兜底
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            doSelect(v);
        });
        dropdown.appendChild(item);
    });

    // 用 pointerdown 监听关闭：画布 pointerdown 可能 preventDefault 抑制 mousedown
    dropdown.addEventListener('pointerdown', (e) => e.stopPropagation());

    const close = (e) => {
        if (!dropdown.isConnected) return;
        if (!dropdown.contains(e.target)) {
            dropdown.remove();
            document.removeEventListener('pointerdown', close, true);
        }
    };
    document.addEventListener('pointerdown', close, true);

    document.body.appendChild(dropdown);
}


// ═══════════════════════════════════════════════════════════════════════
// 波形绘制组件（带播放控制：播放按钮 + 白色播放头 + 点击播放）
// ═══════════════════════════════════════════════════════════════════════

const XZG_AUDIO_WAVEFORM_H = 120;   // 波形固定高度
const XZG_AUDIO_WAVEFORM_WIDGET_NAME = "xzg_audio_waveform";

class XzgAudioWaveformViewer {
    constructor({ node, onContextMenu, onVolumeChange }) {
        this._node = node;
        this.onContextMenu = onContextMenu || (() => {});
        this.onVolumeChange = onVolumeChange || (() => {});
        this.peaks = [];
        this.duration = 0;
        this.sampleRate = 44100;
        this._saveUrl = "";
        this._savedFilename = "";

        // 音量（仅监听预览，不影响最终文件输出）
        this.volume = 1.0;

        // 播放状态
        this.isPlaying = false;
        this.playbackTime = 0;
        this._playheadHover = false;
        this._davinciActionBusy = false;
        this._davinciBusyLabel = "";
        this._audio = document.createElement("audio");
        this._audio.preload = "auto";
        this._audio.crossOrigin = "anonymous";
        this._audio.style.display = "none";
        document.body.appendChild(this._audio);

        // Web Audio API 用于支持 >100% 音量增益
        this._audioCtx = null;
        this._gainNode = null;
        this._sourceNode = null;
        this._audioGraphConnected = false;

        this._audio.addEventListener("ended", () => {
            // 播放头拖动中或刚结束(300ms内)时触发的 ended，不自动循环播放
            const inPlayheadDrag = this.isDragging && this.dragType === 'playhead';
            const recentlyDragged = this._lastPlayheadEnd && Date.now() - this._lastPlayheadEnd < 300;
            if (this._loopPlayback && !inPlayheadDrag && !recentlyDragged) {
                this.playbackTime = 0;
                this._audio.currentTime = 0;
                this._audio.play().catch(e => console.warn("[小珠光] 循环播放失败:", e));
                return;
            }
            this.isPlaying = false;
            this.playbackTime = 0;
            this._audio.currentTime = 0;
            this._node.setDirtyCanvas?.(true, true);
        });
        this._audio.addEventListener("play", () => {
            this.isPlaying = true;
            this._startPlaybackRaf();
        });
        this._audio.addEventListener("pause", () => {
            this.isPlaying = false;
            this._stopPlaybackRaf();
            this._node.setDirtyCanvas?.(true, true);
        });

        // 拖动状态
        this.isDragging = false;
        this.dragType = null; // 'toggle_play' | 'playhead' | 'volume'
        this._dragMoved = false;
        this._dragThreshold = 3;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._dragPlayheadX = 0; // 拖动开始时播放头的 X 位置（widget 坐标）
        this._clickTimer = null;
        this._handleWidth = 14; // 播放头拖动判定范围
        // 音量拖动起始状态
        this.dragStartVolume = 1.0;
        this.dragStartVolY = 0;
        // 双击检测
        this._lastClickTime = 0;

        // 全局鼠标监听（用于拖动）
        this._onMouseMove = (e) => this._handleMouseMove(e);
        this._onMouseUp = (e) => this._handleMouseUp(e);
        window.addEventListener("mousemove", this._onMouseMove);
        window.addEventListener("mouseup", this._onMouseUp);
        window.addEventListener("pointermove", this._onMouseMove);
        window.addEventListener("pointerup", this._onMouseUp);
        window.addEventListener("pointercancel", this._onMouseUp);

        // 左右边框总宽 14px（外 4px #353535 + 内 10px 黑色），整段为边框区，波形从 14px 起（与加载器一致）
        this._paddingX = 14;
        // #353535 可见边框条宽度（绘制在边框区最外侧）
        this._borderW = 4;

        // 绘制参数（由 drawOnNode 保存，供 handleMouse 使用）
        this._drawY = 0;
        this._drawH = 0;
        this._drawW = 0;
        this._widgetH = 0; // widget 总高度（包括波形周围黑色区域）

        // 循环/单次播放：true=循环，false=单次
        this._loopPlayback = false;
        this._loopBtn = null;

        // 播放头拖动结束时间（防止拖动到界面外后误触发播放）
        this._lastPlayheadEnd = 0;

        // 播放动画帧
        this._rafId = null;
    }

    destroy() {
        this._stopPlaybackRaf();
        if (this._audio) {
            this._audio.pause();
            this._audio.removeAttribute("src");
            this._audio.load();
            this._audio.remove();
        }
        if (this._audioCtx) {
            try { this._audioCtx.close(); } catch (e) {}
            this._audioCtx = null;
            this._gainNode = null;
            this._sourceNode = null;
            this._audioGraphConnected = false;
        }
        if (this._clickTimer) {
            clearTimeout(this._clickTimer);
            this._clickTimer = null;
        }
        window.removeEventListener("mousemove", this._onMouseMove);
        window.removeEventListener("mouseup", this._onMouseUp);
        window.removeEventListener("pointermove", this._onMouseMove);
        window.removeEventListener("pointerup", this._onMouseUp);
        window.removeEventListener("pointercancel", this._onMouseUp);
    }

    _startPlaybackRaf() {
        if (this._rafId) return;
        const loop = () => {
            if (!this.isPlaying) { this._rafId = null; return; }
            this.playbackTime = this._audio.currentTime;
            this._node.setDirtyCanvas?.(true, true);
            this._rafId = requestAnimationFrame(loop);
        };
        this._rafId = requestAnimationFrame(loop);
    }

    _stopPlaybackRaf() {
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    _getPad() {
        return Math.min(this._paddingX, Math.max(2, Math.floor(this._drawW / 8)));
    }

    setData(peaks, duration, sampleRate) {
        this.peaks = peaks || [];
        this.duration = duration || 0;
        this.sampleRate = sampleRate || 44100;
        // 换音频（或初次设置波形）：音量一律重置为 100%
        // （刷新浏览器 / 重启 ComfyUI / 换新出图音频 都应从 100% 开始）
        this.volume = 1.0;
        this._applyVolume(1.0);
        // 播放头默认在最开头
        if (this.duration > 0) {
            this.playbackTime = 0;
            // 同步音频元素的 currentTime（播放头位置始终统一）
            if (this._saveUrl && this._audio) {
                const syncCurrentTime = () => {
                    try {
                        this._audio.currentTime = this.playbackTime;
                    } catch (e) {
                        // 音频未加载完成时设置可能失败，忽略
                    }
                };
                if (this._audio.readyState >= 1) {
                    syncCurrentTime();
                } else {
                    const onLoaded = () => {
                        syncCurrentTime();
                        this._audio.removeEventListener("loadedmetadata", onLoaded);
                    };
                    this._audio.addEventListener("loadedmetadata", onLoaded);
                }
            }
        }
    }

    setSaveInfo(url, filename) {
        this._saveUrl = url || "";
        this._savedFilename = filename || "";
        if (url) {
            // 规范化 URL 比较：浏览器会把 audio.src 规范化为绝对 URL，
            // 直接和相对路径比较会始终不等，导致每次都重设 src 打断加载。
            // 这里用 new URL 规范化后再比较，避免重复设置相同 URL。
            let needUpdate = true;
            try {
                const normalizedUrl = new URL(url, window.location.href).href;
                if (this._audio.src === normalizedUrl) {
                    needUpdate = false;
                }
            } catch (e) {
                // URL 解析失败时保守处理，允许更新
            }

            if (needUpdate) {
                this._audio.src = url;
                // 不重置 playbackTime，保持 setData 设置的默认位置（最开头）
                // 音频元数据加载后同步 currentTime
                const syncTime = () => {
                    if (this.duration > 0 && this.playbackTime > 0) {
                        try {
                            this._audio.currentTime = this.playbackTime;
                        } catch (e) {
                            // 某些浏览器在加载前设置 currentTime 会失败，忽略
                        }
                    }
                };
                if (this._audio.readyState >= 1) {
                    syncTime();
                } else {
                    const onLoaded = () => {
                        syncTime();
                        this._audio.removeEventListener("loadedmetadata", onLoaded);
                    };
                    this._audio.addEventListener("loadedmetadata", onLoaded);
                }
            }
        } else {
            this._audio.pause();
            this._audio.removeAttribute("src");
            this.isPlaying = false;
            this.playbackTime = 0;
        }
    }

    togglePlay() {
        if (!this._saveUrl || this.duration <= 0) return;
        // 用 _audio.paused（同步属性）判断真实状态，避免 isPlaying 依赖异步 play/pause 事件产生时序错位
        if (!this._audio.paused) {
            this._audio.pause();
            return;
        }
        // 确保 Web Audio 图已连接（支持 >100% 音量增益）
        this._ensureAudioGraph();
        // 播放前先等 AudioContext 完全恢复，再启动播放（避免 play() 排队在挂起的上下文后面造成高延迟，与加载器一致）
        const startPlayback = () => {
            // 播放前同步音频当前时间到 playbackTime（始终从播放头位置开始播放）
            try {
                if (Math.abs(this._audio.currentTime - this.playbackTime) > 0.01) {
                    this._audio.currentTime = this.playbackTime;
                }
            } catch (e) {
                // src 刚设置、readyState 不足时设置 currentTime 可能抛 InvalidStateError，忽略以保证 play() 执行
                console.warn("[小珠光] 同步播放位置失败:", e);
            }
            const p = this._audio.play();
            if (p && p.catch) {
                p.catch(e => console.warn("[小珠光] 音频播放失败:", e));
            }
        };
        if (this._audioCtx && this._audioCtx.state === 'suspended') {
            this._audioCtx.resume().then(startPlayback).catch(() => startPlayback());
        } else {
            startPlayback();
        }
    }

    // ── Web Audio API：支持 >100% 音量增益 ──
    _ensureAudioGraph() {
        if (this._audioGraphConnected) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            this._audioCtx = new AudioContext();
            this._sourceNode = this._audioCtx.createMediaElementSource(this._audio);
            this._gainNode = this._audioCtx.createGain();
            this._gainNode.gain.value = this.volume;
            this._sourceNode.connect(this._gainNode);
            this._gainNode.connect(this._audioCtx.destination);
            this._audioGraphConnected = true;
            this._audio.volume = 1;
        } catch (e) {
            console.warn("[小珠光] Web Audio 初始化失败，使用原生音量:", e);
            this._audioGraphConnected = false;
        }
    }

    _applyVolume(v) {
        if (this._audioGraphConnected && this._gainNode) {
            this._gainNode.gain.value = v;
        } else if (this._audio) {
            this._audio.volume = Math.min(1, v);
        }
    }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(3.0, v));
        this._applyVolume(this.volume);
        this.onVolumeChange(this.volume);
        this._node.setDirtyCanvas?.(true, true);
    }

    // ── 音量线 Y 坐标计算（与加载器一致） ──
    _getVolumeY(widgetY, widgetH) {
        const barPadY = 2;
        const waveH = widgetH - barPadY * 2;
        const v = Math.max(0, Math.min(3.0, this.volume));
        let yRatio;
        if (v <= 1.0) {
            // 0~1.0 映射到 yRatio 1.0~0.5（底部到中线）
            yRatio = 1.0 - v * 0.5;
        } else {
            // 1.0~3.0 映射到 yRatio 0.5~0.0（中线到顶部）
            const t = (v - 1.0) / 2.0;
            yRatio = 0.5 - t * 0.5;
        }
        return widgetY + barPadY + waveH * yRatio;
    }

    _getVolumeFromY(y, widgetY, widgetH) {
        const barPadY = 2;
        const waveH = widgetH - barPadY * 2;
        const yRatio = Math.max(0, Math.min(1, (y - widgetY - barPadY) / waveH));
        if (yRatio >= 0.5) {
            // yRatio 0.5~1.0 → volume 0~1.0
            const t = (1.0 - yRatio) / 0.5;
            return Math.max(0, Math.min(1.0, t));
        } else {
            // yRatio 0.0~0.5 → volume 1.0~3.0
            const t = (0.5 - yRatio) / 0.5;
            return Math.max(1.0, Math.min(3.0, 1.0 + t * 2.0));
        }
    }

    seekTo(time) {
        if (!this._saveUrl || this.duration <= 0) return;
        const t = Math.max(0, Math.min(this.duration, time));
        try {
            this._audio.currentTime = t;
        } catch (e) {
            console.warn("[小珠光] 设置播放位置失败:", e);
        }
        this.playbackTime = t;
    }

    drawOnNode(ctx, widgetY, widgetW, widgetH) {
        this._drawY = widgetY;
        // 属性面板切换等触发节点 reflow 时，widget 传入的宽/高可能与 node.size 暂时不一致，
        // 强制把波形绘制限制在节点实际边界内，避免音轨超出节点
        const nodeW = this._node?.size?.[0];
        const nodeH = this._node?.size?.[1];
        this._drawW = (nodeW != null && nodeW > 0) ? Math.max(1, Math.min(widgetW, nodeW)) : widgetW;
        this._drawH = (nodeH != null && nodeH > 0) ? Math.max(1, Math.min(widgetH, Math.max(0, nodeH - widgetY))) : widgetH;

        const w = this._drawW;
        const h = this._drawH;
        const pad = this._getPad();
        const usableW = Math.max(1, w - pad * 2);

        // 背景：延伸到节点底边，左右下角带圆角（半径取 LiteGraph.ROUND_RADIUS，与节点本体完全一致，与加载器一致）
        const nodeBottom = Math.max(widgetY + h, (this._node?.size?.[1] || widgetY + h + 2));
        const _r = (typeof LiteGraph !== 'undefined' && LiteGraph.ROUND_RADIUS) ? LiteGraph.ROUND_RADIUS : 8;
        const bgRoundedPath = () => {
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(0, widgetY, w, nodeBottom - widgetY, [0, 0, _r, _r]);
            } else {
                ctx.rect(0, widgetY, w, nodeBottom - widgetY);
            }
        };
        ctx.fillStyle = '#000000';
        bgRoundedPath();
        ctx.fill();

        // 两侧边框区（总宽 pad=14px：最外 _borderW=4px #353535 + 内侧黑色）+ 下边缘 4px 横边，
        // 全部裁剪到圆角路径内（与加载器一致）
        if (pad > 0) {
            ctx.save();
            bgRoundedPath();
            ctx.clip();
            ctx.fillStyle = '#353535';
            const bw = this._borderW || 4;
            ctx.fillRect(0, widgetY, bw, nodeBottom - widgetY);          // 左外 4px
            ctx.fillRect(w - bw, widgetY, bw, nodeBottom - widgetY);     // 右外 4px（内侧 pad-bw 为黑色背景）
            ctx.fillRect(0, nodeBottom - 4, w, 4);   // 下边缘 4px 横边
            ctx.restore();
        }

        // 达芬奇导出期间在波形正中央显示大字状态，与音频加载器-化神级一致。
        if (this._davinciActionBusy) {
            ctx.save();
            ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
            bgRoundedPath();
            ctx.fill();
            const statusText = this._davinciBusyLabel || '准备导出…';
            const fontSize = Math.max(16, Math.min(24, Math.floor(h * 0.22)));
            ctx.fillStyle = '#f2fff3';
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.9)';
            ctx.shadowBlur = 5;
            ctx.fillText(statusText, w / 2, widgetY + h / 2, Math.max(80, w - pad * 2));
            ctx.restore();
            return;
        }

        if (!this.peaks || this.peaks.length === 0) {
            // 空状态提示
            ctx.fillStyle = '#555';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('🎵 暂无音频', w / 2, widgetY + h / 2);
            return;
        }

        const barPadY = 2;
        const waveH = h - barPadY * 2;
        const waveMid = widgetY + barPadY + waveH / 2;

        // 绘制波形条（与加载器一致：#307960 绿色，音量缩放）
        const volScale = this.volume;
        const numBars = this.peaks.length;
        const barWidth = usableW / numBars;
        for (let i = 0; i < numBars; i++) {
            const [minVal, maxVal] = this.peaks[i];
            const x = pad + i * barWidth;
            const bw = Math.max(1, Math.min(barWidth, w - pad - x));
            if (w - pad - x < 1) continue;
            ctx.fillStyle = '#307960';
            const top = waveMid + minVal * (waveH / 2) * volScale;
            const bottom = waveMid + maxVal * (waveH / 2) * volScale;
            const barTop = Math.max(widgetY + barPadY, top);
            const barBottom = Math.min(widgetY + h - barPadY, bottom);
            ctx.fillRect(x, barTop, bw, Math.max(1, barBottom - barTop));
        }

        // 音量线（左侧一小段，与加载器一致）
        const volY = this._getVolumeY(widgetY, h);
        const volLineW = 40;
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad, volY);
        ctx.lineTo(pad + volLineW, volY);
        ctx.stroke();

        // 音量显示（左上角）+ 时间码（紧邻音量右侧）
        const volText = `音量${Math.round(this.volume * 100)}`;
        const timeStartX = pad + 2;
        if (this.duration > 0 && this._saveUrl) {
            // 音量文字
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(volText, timeStartX, widgetY + 3);
            const volTextW = ctx.measureText(volText).width;
            // 时间码（音量右侧）
            const curStr = this._formatTime(this.playbackTime || 0);
            const durStr = this._formatTime(this.duration);
            const timeStr = `${curStr} / ${durStr}`;
            const timeX = timeStartX + volTextW + 6;
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.font = '12px sans-serif';
            ctx.fillText(timeStr, timeX, widgetY + 3);
            const timeW = ctx.measureText(timeStr).width;
            // 循环/单次播放图标（时间码后面，高度对齐，金色小符号）
            const loopSym = this._loopPlayback ? '⇆' : '→';
            const loopX = timeX + timeW + 8;
            ctx.fillStyle = '#FFD700';
            ctx.font = '12px sans-serif';
            ctx.fillText(loopSym, loopX, widgetY + 2);
            const loopW = ctx.measureText(loopSym).width;
            this._loopBtn = { x: loopX - 3, y: widgetY + 1, w: loopW + 6, h: 18 };
        } else if (this.duration > 0) {
            // 无音频URL时显示音量+总时长
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(volText, timeStartX, widgetY + 3);
            const volTextW = ctx.measureText(volText).width;
            const timeStr = this._formatTime(this.duration);
            const timeX = timeStartX + volTextW + 6;
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.fillText(timeStr, timeX, widgetY + 3);
        }

        // 采样率文字（右下角）
        if (this.sampleRate > 0) {
            const srText = this._formatSampleRate(this.sampleRate);
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText(srText, w - pad - 2, widgetY + h - 3);
        }

        // 白色播放头（竖白杠）
        if (this.duration > 0 && this._saveUrl && this.playbackTime >= 0) {
            const playX = pad + (this.playbackTime / this.duration) * usableW;
            if (playX >= pad && playX <= pad + usableW) {
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(playX, widgetY + barPadY);
                ctx.lineTo(playX, widgetY + h - barPadY);
                ctx.stroke();
                if (this._playheadHover || (this.isDragging && this.dragType === 'playhead')) {
                    // 只强调波形轨道中的播放头，避开上方音量与时间码区域。
                    ctx.strokeStyle = '#FFD34E';
                    ctx.lineWidth = 3.5;
                    ctx.beginPath();
                    ctx.moveTo(playX, widgetY + 20);
                    ctx.lineTo(playX, widgetY + h);
                    ctx.stroke();
                }
            }
        }

    }

    _formatTime(seconds) {
        if (seconds <= 0) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    _formatSampleRate(sr) {
        if (sr >= 1000) return (sr / 1000).toFixed(0) + 'kHz';
        return sr + 'Hz';
    }

    _getPlayX() {
        if (this.duration <= 0) return -1;
        const pad = this._getPad();
        const usableW = Math.max(1, this._drawW - pad * 2);
        return pad + (this.playbackTime / this.duration) * usableW;
    }

    _getTimeFromX(x) {
        if (this.duration <= 0) return 0;
        const pad = this._getPad();
        const usableW = Math.max(1, this._drawW - pad * 2);
        const ratio = Math.max(0, Math.min(1, (x - pad) / usableW));
        return ratio * this.duration;
    }

    handleMouse(event, x, y) {
        // 检查是否在可点击区域内（波形区域 + 下方黑色区域）
        // y 是相对于节点顶部的坐标，_drawY 是波形顶部 y（等于 widget 顶部）
        const areaTop = this._drawY;
        const areaBottom = this._drawY + Math.max(this._drawH, this._widgetH);
        if (y < areaTop || y > areaBottom) return false;

        if (event.type === 'pointermove' || event.type === 'mousemove') {
            const inWaveformRail = y >= this._drawY + 20 && y <= this._drawY + this._drawH;
            const hovering = inWaveformRail && Math.abs(x - this._getPlayX()) <= this._handleWidth;
            if (hovering !== this._playheadHover) {
                this._playheadHover = hovering;
                this._node.setDirtyCanvas?.(true, true);
            }
        }

        // 右键菜单
        if (event.type === 'contextmenu' || (event.type === 'pointerup' && event.button === 2)) {
            this.onContextMenu(event.clientX, event.clientY);
            return true;
        }

        // 左键按下
        if (event.type === 'pointerdown' && event.button === 0 && this._saveUrl && this.duration > 0) {
            // 右下角 resize 手柄区（与波形底部重叠）：放行给 LiteGraph 调整节点尺寸，
            // 避免此处点击被误判为播放/暂停导致无法拉伸节点宽度（与加载器一致）
            const _nd = this._node;
            if (_nd && _nd.size && x >= _nd.size[0] - 14 && y >= _nd.size[1] - 14) {
                return false;
            }
            // 两侧最外 #353535 边框条（_borderW 宽度）：非交互区，不响应点击；
            // 内侧黑色边框段（10px）允许播放/播放头拖动，仅拦最外层（与加载器一致）
            const _bw = this._borderW || 4;
            if (_bw > 0 && (x < _bw || x > this._drawW - _bw)) {
                return false;
            }
            // 提前检测双击（在 200ms 防误触守卫之前），确保双击音量线重置不被拦截
            const _now = Date.now();
            const _isDoubleClick = (this._lastClickTime && _now - this._lastClickTime < 300);
            // 播放头拖动进行中或刚结束(200ms内)：忽略新的按下，防止拖到界面外后误触发播放
            // 但双击不拦截（用于双击音量线重置）
            if (!_isDoubleClick && (this.isDragging || (this._lastPlayheadEnd && _now - this._lastPlayheadEnd < 200))) {
                return true;
            }
            // 点击循环/单次播放切换按钮（右上角）
            if (this._loopBtn) {
                const btn = this._loopBtn;
                if (x >= btn.x && x <= btn.x + btn.w && y >= btn.y && y <= btn.y + btn.h) {
                    this._lastClickTime = _now;
                    this._loopPlayback = !this._loopPlayback;
                    this._node.setDirtyCanvas?.(true, true);
                    return true;
                }
            }

            const widgetY = this._drawY;
            const widgetH = this._drawH;
            const barPadY = 2;

            // 优先判断音量线（左侧一小段范围，与加载器一致）
            const pad = this._getPad();
            const volY = this._getVolumeY(widgetY, widgetH);
            const volHandleHeight = 5;
            const volLineW = 40;
            const volLineLeft = pad;
            const volLineRight = pad + volLineW;
            const hitVolumeLine = Math.abs(y - volY) <= volHandleHeight && x >= volLineLeft && x <= volLineRight;

            // 双击处理（音量线重置到 100%）
            this._lastClickTime = _now;
            if (_isDoubleClick && hitVolumeLine) {
                this.setVolume(1.0);
                return true;
            }

            if (hitVolumeLine) {
                // 音量线拖动模式
                this.dragType = 'volume';
                this.isDragging = true;
                this._dragMoved = false;
                this._dragStartX = event.clientX;
                this._dragStartY = event.clientY;
                this.dragStartVolume = this.volume;
                this.dragStartVolY = volY;
                return true;
            }

            // 白色播放头：仅靠近命中区（±_handleWidth）才拖播放头，全高度生效；
            // 远离播放头则按单击播放/暂停（与加载器规则一致）
            const playX = this._getPlayX();
            if (Math.abs(x - playX) <= this._handleWidth) {
                // 播放头拖动模式
                this.dragType = 'playhead';
                this.isDragging = true;
                this._dragMoved = false;
                this._dragStartX = event.clientX;
                this._dragStartY = event.clientY;
                this._dragPlayheadX = x;

                // 按下瞬间立即将播放头跳到点击位置
                let t = this._getTimeFromX(x);
                t = Math.max(0, Math.min(this.duration, t));
                t = Math.round(t * 100) / 100;
                this.playbackTime = t;
                try {
                    this._audio.currentTime = t;
                } catch (e) {
                    // 音频未加载完成时设置可能失败，忽略
                }
                this._node.setDirtyCanvas?.(true, true);
            } else {
                // 单击立即播放/暂停（按下即响应，无延迟）
                this.togglePlay();
                return false;
            }

            return true;
        }

        // 松开鼠标时：由 window 上的 _handleMouseUp 统一处理清理和点击/拖动判定
        if (event.type === 'pointerup' || event.type === 'mouseup' || event.type === 'pointercancel') {
            if (this.isDragging) {
                return true;
            }
            return false;
        }

        // 拖拽中：阻止节点拖动
        if (event.type === 'pointermove' || event.type === 'mousemove') {
            if (this.isDragging) {
                return true;
            }
        }

        return false;
    }

    _handleMouseMove(e) {
        if (!this.isDragging) return;

        // 安全检测：鼠标按钮已松开但仍在拖动状态，强制结束
        if (e.buttons === 0) {
            this._handleMouseUp(e);
            return;
        }

        // 检测是否超过拖动阈值（用于区分点击和拖动）
        if (!this._dragMoved) {
            const dx = e.clientX - this._dragStartX;
            const dy = e.clientY - this._dragStartY;
            if (Math.sqrt(dx * dx + dy * dy) > this._dragThreshold) {
                this._dragMoved = true;
            }
        }

        const cv = app.canvas;
        const scale = cv?.ds?.scale || 1;

        // 音量拖动（垂直方向）
        if (this.dragType === 'volume') {
            if (!this._dragMoved) return;
            const widgetY = this._drawY;
            const widgetH = this._drawH;
            const dy = (e.clientY - this._dragStartY) / scale;
            const currentY = this.dragStartVolY + dy;
            let newVol = this._getVolumeFromY(currentY, widgetY, widgetH);
            newVol = Math.round(newVol * 100) / 100;
            this.setVolume(newVol);
            return;
        }

        // 上半区播放头拖动：播放头立即跟随鼠标
        // 增量方式：dx 是屏幕像素，需要除以画布缩放比得到 widget 逻辑像素增量
        const dx = (e.clientX - this._dragStartX) / scale;

        const newX = this._dragPlayheadX + dx;
        let t = this._getTimeFromX(newX);
        t = Math.max(0, Math.min(this.duration, t));
        t = Math.round(t * 100) / 100;
        this.playbackTime = t;
        try {
            this._audio.currentTime = t;
        } catch (e) {
            // 音频未加载完成时可能失败，playbackTime 已更新，加载后会同步
        }
        this._node.setDirtyCanvas?.(true, true);
    }

    _handleMouseUp(e) {
        if (!this.isDragging) return;
        this.isDragging = false;
        const wasDragging = this.dragType;
        this.dragType = null;
        this._dragMoved = false;
        this._hitPlayhead = false;
        if (this._clickTimer) {
            clearTimeout(this._clickTimer);
            this._clickTimer = null;
        }
        // 上半区（playhead）拖动：无论是否拖动，都不改变播放状态
        if (wasDragging === 'playhead') {
            this._lastPlayheadEnd = Date.now();
        }
    }
}


// ═══════════════════════════════════════════════════════════════════════
// 音频保存节点前端注册
// ═══════════════════════════════════════════════════════════════════════

const XZG_AUDIO_SAVE_TYPES = new Set(["XiaozhuguangAudioSave", "XiaozhuguangAudioSaveDaVinci"]);

// ═══════════════════════════════════════════════════════════════════
// 切换工作流恢复机制（参考 xzg_video_combine.js 的视频保存实现）：
// 模块级输出缓存 + queuePrompt 钩子 + executed 兜底监听。
// 场景：工作流 A 点击 Run → 切到 B → A 后台跑完 → 切回 A。
// 切走 tab 后 A 的节点实例被销毁，节点级 onExecuted 失效；这里用全局
// api executed 事件兜底，把输出写入内存缓存 + localStorage，
// 切回后由 onConfigure 读取恢复波形与保存信息（防跨工作流串台）。
// ═══════════════════════════════════════════════════════════════════

// 工作流图结构指纹：以「节点 id→type 集合」为工作流身份。
// - 跨刷新稳定：刷新后图按 JSON 还原，指纹不变 → localStorage 恢复仍命中；
// - 跨工作流可区分：不同工作流结构不同 → 指纹不同 → 键不同 → 不串台；
// - 移动节点 / 编辑 widget 值不影响指纹；增删节点会改变指纹（旧缓存自然失效）。
function _xzgAudioGraphFingerprint(graph) {
    const parts = [];
    for (const n of (graph?.nodes || [])) {
        if (n && n.id != null && n.type) parts.push(String(n.id) + ":" + n.type);
    }
    parts.sort();
    let h = 5381;
    for (const p of parts) {
        for (let i = 0; i < p.length; i++) {
            h = ((h << 5) + h + p.charCodeAt(i)) >>> 0;
        }
    }
    return String(h);
}

// 每个存活图实例的唯一运行时令牌（WeakMap 弱引用，不泄漏）。
// 内容指纹无法区分「内容相同但不同」的两个工作流（如复制得到），
// 图实例令牌让同会话内任意两个图都持有不同缓存键，杜绝按共享键串台。
const _xzgAudioGraphTokenMap = new WeakMap();
let _xzgAudioGraphTokenSeq = 0;
function _xzgAudioGraphToken(graph) {
    if (!graph) return "";
    let t = _xzgAudioGraphTokenMap.get(graph);
    if (!t) { t = String(++_xzgAudioGraphTokenSeq); _xzgAudioGraphTokenMap.set(graph, t); }
    return t;
}

// 输出缓存（两套内存键 + localStorage 三级）：
// 1) _xzgAudioOutputCache     图实例令牌|节点id —— 同会话实时（真实执行时写入）
// 2) _xzgAudioOutputCacheByFp 工作流指纹|节点id —— 节点销毁期间由模块级兜底监听写入
// 3) localStorage             工作流指纹_节点id —— 跨浏览器刷新持久化
const _xzgAudioOutputCache = new Map();
const _xzgAudioOutputCacheByFp = new Map();
const _xzgAudioOutStoreKey = (wfFp, nodeId) => `xzg_audio_save_out_${wfFp}_${nodeId}`;
function _xzgPersistAudioOutput(wfFp, nodeId, info) {
    try { localStorage.setItem(_xzgAudioOutStoreKey(wfFp, nodeId), JSON.stringify(info)); } catch (e) { /* 忽略存储失败 */ }
}
function _xzgLoadPersistedAudioOutput(wfFp, nodeId) {
    try { return JSON.parse(localStorage.getItem(_xzgAudioOutStoreKey(wfFp, nodeId))); } catch (e) { return null; }
}
const _xzgAudioDavinciStoreKey = (wfFp, nodeId) => `xzg_audio_save_davinci_${wfFp}_${nodeId}`;
function _xzgPersistAudioDavinciTarget(wfFp, nodeId, target) {
    if (!wfFp || !nodeId || !target?.directory) return;
    try {
        localStorage.setItem(_xzgAudioDavinciStoreKey(wfFp, nodeId), JSON.stringify({
            session: target.session || "",
            directory: target.directory,
            filename: target.filename || "",
        }));
    } catch (e) { /* 忽略存储失败 */ }
}
function _xzgLoadPersistedAudioDavinciTarget(wfFp, nodeId) {
    try { return JSON.parse(localStorage.getItem(_xzgAudioDavinciStoreKey(wfFp, nodeId))); } catch (e) { return null; }
}
const _xzgAudioCacheKey = (graph, nodeId) => `${_xzgAudioGraphToken(graph)}|${nodeId}`;

// 追踪「最近一次发起执行的图」：点击 Run 会走 app.queuePrompt，此刻 app.graph 即发起图。
// 全局 executed 事件会广播给所有图里 id 相同的节点实例；兜底监听必须只接受
// 「发起本次执行的图」里音频保存节点的输出，否则 A 工作流的输出会被 B 里 id 相同的
// 节点写进自己的缓存并在切回时串台到 B 的预览区。
let _xzgAudioRunningGraph = null;
let _xzgAudioRunningGraphFp = null;
let _xzgAudioRunningSaveIds = new Set();

// 由后端 audio_saved ui 项构造缓存对象（onExecuted 与模块级兜底监听共用）
function _xzgAudioBuildCacheInfo(info) {
    return {
        filename: (info && info.filename) || "",
        type: (info && info.type) || "output",
        subfolder: (info && info.subfolder) || "",
        // 绝对路径保存/预览副本通过后端会话令牌定位；切换工作流后仍需恢复，
        // 否则前端只有文件名，无法请求后端打开另存为窗口。
        davinci_abs_token: (info && (info.davinci_abs_token || info.abs_token)) || "",
        format: (info && info.format) || "",
        quality: (info && info.quality != null) ? info.quality : 128,
        duration: (info && info.duration) || 0,
        sample_rate: (info && info.sample_rate) || 44100,
        peaks: Array.isArray(info && info.peaks) ? info.peaks : [],
        preview: !!(info && info.preview),
    };
}

// 由缓存对象恢复 /view URL。预览 temp 可能已被清理，但仍尝试恢复：
// 若文件还在，刷新后仍可播放/右键保存；若文件已清理，下载时会明确提示重新执行节点。
function _xzgAudioRestoreUrl(cacheInfo) {
    if (!cacheInfo || !cacheInfo.filename) return "";
    return api.apiURL(
        `/view?filename=${encodeURIComponent(cacheInfo.filename)}&type=${encodeURIComponent(cacheInfo.type || "output")}&subfolder=${encodeURIComponent(cacheInfo.subfolder || "")}`
    );
}

// 判断 canvas 坐标是否命中某个音频保存节点的波形区域（命中返回 node，否则 null）
function _xzgAudioSaveHitWaveform(canvasX, canvasY) {
    const nodes = app.graph?.nodes || [];
    for (const n of nodes) {
        if (!XZG_AUDIO_SAVE_TYPES.has(n.type)) continue;
        const viewer = n._xzgWaveformViewer;
        if (!viewer || !viewer._saveUrl) continue;
        const nx = n.pos[0], ny = n.pos[1];
        const ns = n.size || [0, 0];
        if (canvasX < nx || canvasX > nx + ns[0]) continue;
        if (canvasY < ny || canvasY > ny + ns[1]) continue;
        const wy = viewer._drawY;
        const wh = viewer._drawH;
        const wH = viewer._widgetH || wh;
        const areaBottom = wy + Math.max(wh, wH);
        const localY = canvasY - ny;
        if (wy > 0 && localY >= wy && localY <= areaBottom) return n;
    }
    return null;
}

// LiteGraph 有些版本会把同一行右侧单元格的 pointerup 继续派给左侧 STRING widget，
// 触发原生 Value 文本框。以 window capture 按实际画布坐标先截获模式单元格点击。
function _xzgAudioSaveModeHit(event) {
    const canvas = app.canvas;
    const canvasEl = canvas?.canvas;
    if (!canvasEl || (event?.target !== canvasEl && !canvasEl.contains?.(event?.target))) return null;
    let point = null;
    try { point = canvas.convertEventToCanvasCoordinates?.(event); } catch (_) {}
    if (!point) {
        const rect = canvasEl.getBoundingClientRect();
        const scale = canvas.ds?.scale || 1;
        const offset = canvas.ds?.offset || [0, 0];
        point = [(event.clientX - rect.left) / scale - offset[0], (event.clientY - rect.top) / scale - offset[1]];
    }
    const graphX = point[0], graphY = point[1];
    for (const node of app.graph?.nodes || []) {
        if (node.type !== "XiaozhuguangAudioSaveDaVinci" && node.type !== "XiaozhuguangAudioSave") continue;
        const prefix = node.widgets?.find(w => w.name === "文件名前缀");
        const y = prefix?._xzgPairY, h = prefix?._xzgPairH;
        if (!Number.isFinite(y) || !Number.isFinite(h)) continue;
        const x = graphX - node.pos[0], localY = graphY - node.pos[1];
        const width = Math.max(1, Math.min(node.size?.[0] || 320, prefix._xzgPairDrawW || node.size?.[0] || 320));
        const outer = 16, gap = 8;
        const cellWidth = Math.max(1, (width - outer * 2 - gap) / 2);
        const modeLeft = outer + cellWidth + gap;
        const modeRight = modeLeft + cellWidth;
        if (localY >= y && localY <= y + h && x >= modeLeft && x <= modeRight) return node;
    }
    return null;
}

function _xzgPatchAudioSaveModePointer() {
    if (window._xzgAudioSaveModePointerPatched) return;
    window._xzgAudioSaveModePointerPatched = true;
    let pendingNode = null;
    window.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        pendingNode = _xzgAudioSaveModeHit(event);
        if (pendingNode) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        }
    }, true);
    window.addEventListener("pointerup", (event) => {
        if (!pendingNode) return;
        const node = pendingNode;
        pendingNode = null;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (_xzgAudioSaveModeHit(event) !== node) return;
        const modeWidget = node.widgets?.find(w => w.name === "模式");
        if (!modeWidget) return;
        modeWidget.value = modeWidget.value === "预览" ? "保存" : "预览";
        modeWidget.callback?.(modeWidget.value);
        node.setDirtyCanvas?.(true, true);
    }, true);
    window.addEventListener("pointercancel", () => { pendingNode = null; }, true);
}

app.registerExtension({
    name: "xiaozhuguang.audio_save",
    init() {
        // 记录「发起执行的图」：点击 Run 走 app.queuePrompt，此刻 app.graph 即发起图。
        // 包 app.queuePrompt 而非 api.queuePrompt（与视频保存一致，避免被其它模块临时包装影响）。
        if (!app._xzgAudioSaveQueueHookInstalled && typeof app.queuePrompt === "function") {
            app._xzgAudioSaveQueueHookInstalled = true;
            const _xzgOrigAudioQueuePrompt = app.queuePrompt;
            app.queuePrompt = function (...args) {
                const g = app.graph;
                const r = _xzgOrigAudioQueuePrompt.apply(this, args);
                if (g) {
                    _xzgAudioRunningGraph = g;
                    _xzgAudioRunningGraphFp = _xzgAudioGraphFingerprint(g);
                    _xzgAudioRunningSaveIds = new Set(
                        (g.nodes || [])
                            .filter(n => n && n.id != null && XZG_AUDIO_SAVE_TYPES.has(n.type))
                            .map(n => String(n.id))
                    );
                }
                return r;
            };
        }

        // 模块级 executed 兜底监听（仅做持久化写入，不直接操作任何波形组件 —— 不存在串台加载）：
        // 切走工作流 tab 后节点实例可能被销毁，节点级 onExecuted 失效；原工作流后台跑完时
        // 新输出无人写入缓存 —— 切回后重建节点只能读到旧值（用户反馈的"切回原工作流预览不刷新"）。
        // 在 queuePrompt 时刻捕获的「发起图指纹 + 音频保存节点 id 集合」约束下，
        // 把输出按「指纹|节点id」写入内存缓存与 localStorage，切回重建后由 onConfigure 恢复。
        // 铁律：只接受「发起本次执行的图」里音频保存节点的输出，绝不跨工作流写入。
        if (!app._xzgAudioSaveGlobalExecutedInstalled && typeof api?.addEventListener === "function") {
            app._xzgAudioSaveGlobalExecutedInstalled = true;
            api.addEventListener("executed", (event) => {
                try {
                    const detail = event.detail;
                    if (!detail || !detail.output) return;
                    if (!_xzgAudioRunningGraphFp || _xzgAudioRunningSaveIds.size === 0) return;
                    const execNode = String(detail.node || detail.display_node || "");
                    const localId = execNode.split(":").pop();
                    if (!_xzgAudioRunningSaveIds.has(localId)) return;
                    const ui = detail.output.ui || detail.output;
                    const audioSaved = ui?.audio_saved;
                    if (!Array.isArray(audioSaved) || audioSaved.length === 0) return;
                    const cacheInfo = _xzgAudioBuildCacheInfo(audioSaved[0]);
                    if (!cacheInfo.filename) return;
                    _xzgAudioOutputCacheByFp.set(`${_xzgAudioRunningGraphFp}|${localId}`, cacheInfo);
                    _xzgPersistAudioOutput(_xzgAudioRunningGraphFp, localId, cacheInfo);
                } catch (e) { /* 兜底监听不影响主流程 */ }
            });
        }
    },
    setup() {
        _xzgPatchAudioSaveModePointer();
        // 1. window 捕获阶段 contextmenu：命中波形区就彻底拦截原生菜单（优先级最高）
        window.addEventListener('contextmenu', (e) => {
            const canvasEl = app.canvas?.canvas;
            if (!canvasEl) return;
            if (e.target !== canvasEl && !canvasEl.contains?.(e.target)) return;

            const canvas = app.canvas;
            let x, y;
            if (canvas.convertEventToCanvasCoordinates) {
                try {
                    const p = canvas.convertEventToCanvasCoordinates(e);
                    if (p) { x = p[0]; y = p[1]; }
                } catch (_) {}
            }
            if (x === undefined || y === undefined) {
                const rect = canvasEl.getBoundingClientRect();
                x = (e.clientX - rect.left) / canvas.ds.scale - canvas.ds.offset[0];
                y = (e.clientY - rect.top) / canvas.ds.scale - canvas.ds.offset[1];
            }

            const node = _xzgAudioSaveHitWaveform(x, y);
            if (node) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                node._xzgWaveformViewer.onContextMenu(e.clientX, e.clientY);
                return false;
            }
        }, true);

        // 2. hook processMouseDown：右键命中波形区时返回 true，阻止 LiteGraph 继续派发
        let LGraphCanvas = null;
        try { if (typeof LGraphCanvas !== 'undefined' && LGraphCanvas?.prototype) LGraphCanvas = LGraphCanvas; } catch (_) {}
        if (!LGraphCanvas) LGraphCanvas = window.LGraphCanvas || null;
        if (!LGraphCanvas && window.LiteGraph?.LGraphCanvas) LGraphCanvas = window.LiteGraph.LGraphCanvas;
        if (!LGraphCanvas && app.canvas?.constructor) LGraphCanvas = app.canvas.constructor;

        if (LGraphCanvas?.prototype?.processMouseDown && !LGraphCanvas.prototype._xzgAudioSaveMousePatched) {
            LGraphCanvas.prototype._xzgAudioSaveMousePatched = true;
            const orig = LGraphCanvas.prototype.processMouseDown;
            LGraphCanvas.prototype.processMouseDown = function (e) {
                if (e.button === 2) {
                    const cx = e.canvasX ?? e.x ?? 0;
                    const cy = e.canvasY ?? e.y ?? 0;
                    const node = _xzgAudioSaveHitWaveform(cx, cy);
                    if (node) {
                        e.preventDefault?.();
                        e.stopPropagation?.();
                        node._xzgWaveformViewer.onContextMenu(e.clientX ?? 0, e.clientY ?? 0);
                        return true;
                    }
                }
                return orig.apply(this, arguments);
            };
        }

        // 3. hook processContextMenu（新版 LiteGraph）：命中波形区时返回 true 拦截原生
        if (LGraphCanvas?.prototype?.processContextMenu && !LGraphCanvas.prototype._xzgAudioSaveCtxPatched) {
            LGraphCanvas.prototype._xzgAudioSaveCtxPatched = true;
            const origProcessContextMenu = LGraphCanvas.prototype.processContextMenu;
            LGraphCanvas.prototype.processContextMenu = function (node, e) {
                if (node?._xzgWaveformViewer && node._xzgWaveformViewer._saveUrl) {
                    const viewer = node._xzgWaveformViewer;
                    const wy = viewer._drawY;
                    const wh = viewer._drawH;
                    const wH = viewer._widgetH || wh;
                    const areaBottom = wy + Math.max(wh, wH);
                    const cx = e?.canvasX ?? e?.x ?? 0;
                    const cy = e?.canvasY ?? e?.y ?? 0;
                    const localY = cy - node.pos[1];
                    if (wy > 0 && localY >= wy && localY <= areaBottom) {
                        viewer.onContextMenu(e?.clientX ?? 0, e?.clientY ?? 0);
                        return true;
                    }
                }
                return origProcessContextMenu.apply(this, arguments);
            };
        }
    },
    getCustomWidgets() {
        return {
            XZGINT: (node, name, data) => {
                const opts = data[1] || {};
                const w = {
                    name, type: 'xzg-number', value: opts.default ?? 0, options: {},
                    _xzgStep: opts.step || 1, _xzgMin: opts.min, _xzgMax: opts.max,
                    computeSize(width) { return [width, 20]; },
                    draw: _xzgDrawWidget, mouse: _xzgWidgetNumberMouse,
                    callback(v) { if (this._xzgCb) this._xzgCb(v); },
                };
                if (!node.widgets) node.widgets = [];
                node.widgets.push(w);
                return w;
            },
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!XZG_AUDIO_SAVE_TYPES.has(nodeData?.name)) return;

        // 给 INT/FLOAT widget 设置自定义类型
        for (const inp of Object.values({ ...nodeData.input?.required, ...nodeData.input?.optional })) {
            if (["INT", "FLOAT"].includes(inp[0]) && inp[1]) {
                inp[1].widgetType ??= "XZG" + inp[0];
            }
        }
        // 给 combo widget（格式、模式）设置 XZGINT 类型，避免原生 combo 双列表
        for (const [key, inp] of Object.entries({ ...nodeData.input?.required, ...nodeData.input?.optional })) {
            if (Array.isArray(inp[0]) && typeof inp[1] === 'object') {
                inp[1].widgetType = "XZGINT";
            }
        }

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            const node = this;

            // 工作流图指纹：跨工作流隔离预览缓存的关键（写入/恢复键的一部分）。
            // 加载工作流时 configure 逐个创建节点、图此时未建全，这里只作兜底，
            // 由 onConfigure 的 rAF 阶段（整图就绪）重算覆盖；用户手动新建节点时图已就绪。
            node._xzgWfFp = _xzgAudioGraphFingerprint(node.graph);

            // ─── 创建波形组件 ──────────────────────────────────────
            let saveUrl = "";      // 后端返回的音频 URL（供右键下载）
            let savedFilename = "";
            // 当前音频的落盘信息（供右键「发送到小珠光音频加载器」用）
            let savedType = "output";   // "output"（保存模式）| "temp"（预览模式）
            let savedSubfolder = "";
            let savedDavinciToken = "";

            const waveformViewer = new XzgAudioWaveformViewer({
                node,
                onContextMenu(cx, cy) {
                    if (!saveUrl || !savedFilename) return;
                    const fmtWidget = node.widgets?.find(w => w.name === '格式');
                    const fmtVal = fmtWidget ? String(fmtWidget.value) : 'mp3';
                    _xzgShowSaveMenu(cx, cy, saveUrl, savedFilename, fmtVal, savedType, savedSubfolder, node);
                },
                onVolumeChange(vol) {
                    const volWidget = node.widgets?.find(w => w.name === '音量');
                    if (volWidget) {
                        volWidget.value = Math.round(vol * 100) / 100;
                    }
                },
            });
            node._xzgWaveformViewer = waveformViewer;

            // 「发送到快剪」「导出到达芬奇」悬浮按钮仅化神级节点创建；
            // 精简版（XiaozhuguangAudioSave）无此高级功能，不创建按钮
            if (node.type === "XiaozhuguangAudioSaveDaVinci") {
                _ensureAudioSaveOutputSettings(node);
                // 波纹区悬浮「发送到快剪」按钮（♪ 图标=自动发送开关，文字=手动发送）
                _createQuickCutFloatButton(node, waveformViewer, () => ({
                    filename: savedFilename,
                    type: savedType,
                    subfolder: savedSubfolder,
                    davinci_abs_token: savedDavinciToken,
                }));

                // 波纹区悬浮「导出到达芬奇」按钮（🎬 图标=自动导出开关，文字=手动导出），
                // 贴波纹区右缘（最右），「发送到快剪」在其左侧；getSavedInfo 共用
                _createDavinciFloatButton(node, waveformViewer, () => ({
                    filename: savedFilename,
                    type: savedType,
                    subfolder: savedSubfolder,
                    davinci_abs_token: savedDavinciToken,
                }));
                _createAudioSaveOutputButton(node, waveformViewer);
            }

            // 波形 canvas widget（直接在节点画布上绘制，与加载器一致的自适应高度）
            const waveformWidget = {
                name: XZG_AUDIO_WAVEFORM_WIDGET_NAME,
                type: "custom",
                value: "",
                options: { serialize: true },
                _xzgDrawW: 0,
                draw: function(ctx, node, width, y, H) {
                    this._xzgDrawW = width;
                    // 波形固定高度 120px，不随节点拉伸变化（与加载器一致）
                    waveformViewer._widgetH = XZG_AUDIO_WAVEFORM_H;
                    waveformViewer.drawOnNode(ctx, y, width, XZG_AUDIO_WAVEFORM_H);
                    // 底部边框自校正：按实际布局 y 精确锁定节点高度（波形底 + 2px 紧贴边框），
                    // 消除估算 minHeight 与真实 widget 布局的偏差导致的底部留白
                    const targetH = Math.round(y + XZG_AUDIO_WAVEFORM_H + 2);
                    if (targetH > 60 && Math.abs(node.size[1] - targetH) > 0.5) {
                        node._xzgFixedH = targetH;
                        node.size[1] = targetH;
                        node.setDirtyCanvas?.(true, true);
                    }
                    // 悬浮「发送到快剪」「导出到达芬奇」按钮跟随波纹区屏幕位置
                    // （平移/缩放/拖动节点时同步；快剪按钮先同步，达芬奇按钮以其为左移基准）
                    node._xzgDvSyncBtn?.();
                    node._xzgQcSyncBtn?.();
                    node._xzgOutSyncBtn?.();
                },
                mouse: function(event, [x, y], node) {
                    return waveformViewer.handleMouse(event, x, y);
                },
                computeSize: function(width) {
                    return [width, XZG_AUDIO_WAVEFORM_H];
                },
                computeLayoutSize: function(width) {
                    return { minHeight: XZG_AUDIO_WAVEFORM_H, minWidth: 0 };
                },
                callback: function(v) {
                    // value 变化时恢复波形数据（刷新/加载工作流时触发）
                    if (v && typeof v === 'string') {
                        try {
                            const data = JSON.parse(v);
                            if (data.peaks && data.duration) {
                                // setData 内部会重置音量到 100%
                                waveformViewer.setData(data.peaks, data.duration, data.sampleRate);
                                if (data.saveUrl && data.filename) {
                                    waveformViewer.setSaveInfo(data.saveUrl, data.filename);
                                }
                                // 播放头默认在最开头
                                if (data.duration > 0) {
                                    waveformViewer.playbackTime = 0;
                                }
                                node.setDirtyCanvas?.(true, true);
                            }
                            // 音量：刷新/加载工作流后一律回到 100%，不复用旧值
                            const defaultVol = 1.0;
                            waveformViewer.volume = defaultVol;
                            waveformViewer._applyVolume(defaultVol);
                            const volW = node.widgets?.find(w => w.name === '音量');
                            if (volW) volW.value = defaultVol;
                        } catch (e) {
                            // 解析失败忽略
                        }
                    }
                },
            };
            node.widgets.push(waveformWidget);

            // ─── 自定义绘制 widget ──────────────────────────────
            let formatWidget = null;
            let qualityWidget = null;
            let prefixWidget = null;
            let modeWidget = null;

            for (const w of this.widgets || []) {
                // 这些绘制栏会随属性面板开/关改变绘制宽度（同「视频」栏修复）：
                // 统一将 width 定义为只读访问器，始终跟随节点实际宽度，忽略污染性写入。
                if (!w._xzgWidthFixed) {
                    w._xzgWidthFixed = true;
                    try {
                        Object.defineProperty(w, 'width', {
                            configurable: true,
                            get() { return node.size?.[0] || 0; },
                            set(_) { /* 忽略外部写入，防止行绘制/命中区溢出节点 */ },
                        });
                    } catch (_) {}
                }
                if (w.name === '格式') {
                    formatWidget = w;
                    // 格式：combo 下拉样式（参考视频保存节点）
                    w.draw = _xzgDrawComboWidget;
                    w.mouse = _xzgComboMouse;
                    w.value = String(w.value ?? "mp3");
                    w.options = w.options || {};
                    w.options.values = ["mp3", "wav", "flac"];
                    // 格式切换时触发重绘（以便质量widget显示/隐藏）
                    // 注意：不调用原始 callback（XZGINT 的 callback 依赖 _xzgCb，会报错）
                    w.callback = function(v) {
                        node.setDirtyCanvas?.(true, true);
                    };
                } else if (w.name === '模式') {
                    modeWidget = w;
                    // 模式：保存/预览 切换开关
                    w.value = String(w.value ?? "保存");
                    w.options = w.options || {};
                    w.options.values = ["保存", "预览"];
                    w.draw = function(ctx, nd, width, y, H) {
                        this._xzgDrawW = width;
                        // 边界钳制（属性面板 reflow 时防止溢出节点）
                        const _nW = nd?.size?.[0], _nH = nd?.size?.[1];
                        if (_nW != null && _nW > 0) width = Math.max(1, Math.min(width, _nW));
                        if (_nH != null && _nH > 0) H = Math.max(1, Math.min(H, Math.max(0, _nH - y)));
                        const pad = 16, r = 6, wr = width - pad * 2;
                        ctx.fillStyle = '#2a2a2a';
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(pad, y + 1, wr, H - 2, r); else ctx.rect(pad, y + 1, wr, H - 2);
                        ctx.fill();
                        ctx.strokeStyle = '#444';
                        ctx.stroke();
                        // 左侧标签
                        ctx.fillStyle = '#9ab';
                        ctx.font = '12px sans-serif';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.fillText('模式', pad + 6, y + H / 2);
                        // 右侧状态：保存=金色，预览=蓝色
                        const isSave = this.value !== '预览';
                        ctx.fillStyle = isSave ? '#FFD700' : '#88ccff';
                        ctx.font = '13px sans-serif';
                        ctx.textAlign = 'right';
                        ctx.fillText(this.value || '保存', width - pad - 6, y + H / 2);
                    };
                    w.mouse = function(event, [x, y], node) {
                        if (event.type === 'pointerdown') {
                            return false;
                        }
                        if (event.type === 'pointerup') {
                            this.value = (this.value === '预览') ? '保存' : '预览';
                            node.setDirtyCanvas?.(true, true);
                            return true;
                        }
                        return true;
                    };
                } else if (w.name === '质量') {
                    qualityWidget = w;
                    // 质量：combo 下拉，压缩格式显示高中低三档，无损格式禁用（灰显但不消失）
                    w.value = String(w.value ?? "128");
                    w.options = w.options || {};
                    w.options.values = ["320", "192", "128"];
                    // 显示值映射：320→高(320kbps)，192→中(192kbps)，128→低(128kbps)
                    w._xzgDisplayVal = (v) => {
                        const map = { "320": "高 320kbps", "192": "中 192kbps", "128": "低 128kbps" };
                        return map[v] || v;
                    };
                    // 无损格式判定
                    const _isLossless = () => {
                        const fmt = formatWidget ? String(formatWidget.value) : "mp3";
                        return fmt === "wav" || fmt === "flac";
                    };
                    // 始终占据空间（不隐藏），高度与其他widget统一
                    w.computeSize = function(width) {
                        return [width, 20];
                    };
                    w.draw = function(ctx, nd, width, y, H) {
                        if (_isLossless()) {
                            // 无损格式：灰显，显示"无损"
                            // 边界钳制（属性面板 reflow 时防止溢出节点）
                            const _nW = nd?.size?.[0], _nH = nd?.size?.[1];
                            if (_nW != null && _nW > 0) width = Math.max(1, Math.min(width, _nW));
                            if (_nH != null && _nH > 0) H = Math.max(1, Math.min(H, Math.max(0, _nH - y)));
                            this._xzgDrawW = width;
                            const pad = 16, r = 6, wr = width - pad * 2;
                            ctx.fillStyle = '#222';
                            ctx.beginPath();
                            if (ctx.roundRect) ctx.roundRect(pad, y + 1, wr, H - 2, r); else ctx.rect(pad, y + 1, wr, H - 2);
                            ctx.fill();
                            ctx.strokeStyle = '#333';
                            ctx.stroke();
                            ctx.fillStyle = '#555';
                            ctx.font = '12px sans-serif';
                            ctx.textAlign = 'left';
                            ctx.textBaseline = 'middle';
                            ctx.fillText('质量', pad + 6, y + H / 2);
                            ctx.fillStyle = '#555';
                            ctx.font = '12px sans-serif';
                            ctx.textAlign = 'right';
                            ctx.fillText('无损', width - pad - 16, y + H / 2);
                        } else {
                            _xzgDrawComboWidget.call(this, ctx, nd, width, y, H);
                        }
                    };
                    w.mouse = function(event, [x, y], node) {
                        if (_isLossless()) return false; // 无损格式不响应点击
                        return _xzgComboMouse.call(this, event, [x, y], node);
                    };
                } else if (w.name === '文件名前缀') {
                    prefixWidget = w;
                    w.draw = _xzgDrawWidget;
                    if (!w._xzgValueColor) w._xzgValueColor = '#fff';
                } else if (w.name === '音量') {
                    // 音量：隐藏原生 widget（由波形区音量线拖动代替），仅保留 value 用于序列化
                    w._xzgValueColor = '#ffffff';
                    w._xzgStep = 0.01;
                    w._xzgMin = 0;
                    w._xzgMax = 3.0;
                    w.hidden = true;
                    w.computeSize = () => [0, 0];
                    // 新建节点 / 重载：音量一律强制 100%（刷新/重启 ComfyUI 不保留旧值）
                    w.value = 1.0;
                    waveformViewer.volume = 1.0;
                    waveformViewer._applyVolume(1.0);
                    // widget 值变化时同步到 viewer（外部调用或回调手动触发时保证同步；
                    //  但不按 w.value 初始化，始终强制 1.0）
                    const _origVolCb = w.callback;
                    w.callback = function(v) {
                        if (typeof _origVolCb === 'function') _origVolCb.apply(this, arguments);
                        const vol = Math.max(0, Math.min(3.0, Number(v) || 0));
                        if (waveformViewer.volume !== vol) {
                            waveformViewer.volume = vol;
                            waveformViewer._applyVolume(vol);
                            node.setDirtyCanvas?.(true, true);
                        }
                    };
                    // 初始化音量值
                    const initVol = Math.max(0, Math.min(3.0, Number(w.value) || 1.0));
                    w.value = initVol;
                    waveformViewer.volume = initVol;
                } else if (w.name === '自动发送到快剪' || w.name === '自动导出到达芬奇') {
                    // 隐藏开关行（与视频保存-化神级一致）：交互入口在悬浮按钮图标上
                    // （自动发送=♪ 图标 / 自动导出=🎬 图标），widget 仅保留 value 随工作流
                    // 序列化；标准隐藏手法 converted-widget 仍参与序列化，computeSize 折叠不占高度
                    w.type = "converted-widget";
                    w.computeSize = () => [0, -4];
                    w.hidden = true;
                    w._xzgHidden = true;
                }
            }

            // 两行双列：格式 | 质量，文件名前缀 | 模式。
            // 每行仅由左侧 widget 占据高度，右侧 widget 保留值/序列化但折叠高度。
            const pairRowHeight = 20;
            if (formatWidget && qualityWidget) {
                formatWidget.computeSize = (width) => [width, pairRowHeight];
                formatWidget.draw = function(ctx, nd, width, y, H) {
                    _xzgDrawSavePairCell(ctx, nd, width, y, H, 0, '格式', String(this.value || 'mp3').toUpperCase(), { dropdown: true });
                    const lossless = ['wav', 'flac'].includes(String(formatWidget.value).toLowerCase());
                    const qualityText = lossless ? '无损' : (qualityWidget._xzgDisplayVal?.(String(qualityWidget.value)) || String(qualityWidget.value));
                    _xzgDrawSavePairCell(ctx, nd, width, y, H, 1, '质量', qualityText, { dropdown: !lossless, disabled: lossless });
                };
                formatWidget.mouse = function(event, [x, y], nd) {
                    if (event.type === 'pointerdown') return false;
                    if (event.type === 'pointerup') {
                        const isLeftCell = x < (nd?.size?.[0] || this._xzgDrawW || 320) / 2;
                        const target = isLeftCell ? formatWidget : qualityWidget;
                        if (target === qualityWidget && ['wav', 'flac'].includes(String(formatWidget.value).toLowerCase())) return true;
                        return _xzgComboMouse.call(target, event, [x, y], nd);
                    }
                    return true;
                };
                // 抵消 LiteGraph 每个 widget 默认追加的 4px 行距，避免折叠后仍留下空行。
                qualityWidget.computeSize = () => [0, -4];
                qualityWidget.draw = () => {};
                qualityWidget.mouse = () => false;
            }
            if (prefixWidget && modeWidget) {
                prefixWidget.computeSize = (width) => [width, pairRowHeight];
                prefixWidget.draw = function(ctx, nd, width, y, H) {
                    this._xzgPairY = y;
                    this._xzgPairH = H;
                    this._xzgPairDrawW = Math.min(width, nd?.size?.[0] || width);
                    const modeIsPreview = String(modeWidget.value) === '预览';
                    _xzgDrawSavePairCell(ctx, nd, width, y, H, 0, '文件名前缀', this.value || '', {});
                    _xzgDrawSavePairCell(ctx, nd, width, y, H, 1, '模式', modeWidget.value || '保存', {
                        valueColor: modeIsPreview ? '#88ccff' : '#FFD700',
                    });
                };
                prefixWidget.mouse = function(event, [x, y], nd) {
                    // 必须消费 pointerdown，防止 LiteGraph 将 STRING widget 的原生 prompt
                    // 作为未处理事件继续触发；真正动作只在 pointerup 按左右半区判断。
                    if (event.type === 'pointerdown') return true;
                    if (event.type !== 'pointerup') return true;
                    // 使用与自绘单元格相同的内边距/间距计算模式按钮热区；优先从原始
                    // pointer 坐标换算节点局部 x，避免 LiteGraph 版本间 mouse 参数坐标系差异。
                    const rowWidth = Math.max(1, Math.min(
                        nd?.size?.[0] || 320,
                        this._xzgDrawW || nd?.size?.[0] || 320,
                    ));
                    let localX = x;
                    const canvas = app.canvas;
                    if (event?.clientX != null && canvas?.convertEventToCanvasCoordinates) {
                        try {
                            const point = canvas.convertEventToCanvasCoordinates(event);
                            if (point) localX = point[0] - (nd?.pos?.[0] || 0);
                        } catch (_) {}
                    } else if (event?.canvasX != null) {
                        localX = event.canvasX - (nd?.pos?.[0] || 0);
                    }
                    const outer = 16, gap = 8;
                    const cellWidth = Math.max(1, (rowWidth - outer * 2 - gap) / 2);
                    const prefixEnd = outer + cellWidth;
                    const modeStart = prefixEnd + gap;
                    const modeEnd = modeStart + cellWidth;
                    if (localX >= modeStart && localX <= modeEnd) {
                        modeWidget.value = (modeWidget.value === '预览') ? '保存' : '预览';
                        if (modeWidget.callback) modeWidget.callback(modeWidget.value);
                        nd.setDirtyCanvas?.(true, true);
                        return true;
                    }
                    if (localX < outer || localX > prefixEnd) return true; // 空隙和边缘不触发前缀编辑
                    app.canvas._xzgAllowPrompt = true;
                    try {
                        app.canvas?.prompt?.('文件名前缀', this.value, (v) => {
                            this.value = String(v ?? '');
                            if (this.callback) this.callback(this.value);
                            nd.setDirtyCanvas?.(true, true);
                        }, event);
                    } finally {
                        app.canvas._xzgAllowPrompt = false;
                    }
                    return true;
                };
                modeWidget.computeSize = () => [0, -4];
                modeWidget.draw = () => {};
                modeWidget.mouse = () => false;
            }

            // ─── 节点尺寸限制 ──────────────────────────────────────
            node.resizable = true;
            node.minWidth = 320;
            node.minHeight = 178;   // 两行双列控件 + 120px 波形，折叠行距后压缩多余高度

            const origSetSize = node.setSize;
            node.setSize = function(size) {
                size[0] = Math.max(size[0], this.minWidth || 320);
                // 高度固定：初始用估算值，首次绘制后由 waveformWidget.draw 按实际 y 自校正为 _xzgFixedH
                size[1] = this._xzgFixedH || this.minHeight || 178;
                return origSetSize?.apply(this, arguments);
            };
            node.setSize([320, 178]);
            // 化神级：最小宽度与默认宽度均为 500（仅影响新建节点；已保存工作流按保存尺寸恢复）
            if (node.type === "XiaozhuguangAudioSaveDaVinci") {
                node.minWidth = 360;
                node.setSize([360, 178]);
            }

            // 节点尺寸变化时触发重绘（波形高度由 draw 内 node.size[1]-y 实时计算）
            const origOnResize = node.onResize;
            node.onResize = function(size) {
                const r = origOnResize?.apply(this, arguments);
                this.setDirtyCanvas?.(true, true);
                return r;
            };

            // ─── onExecuted：执行完成后更新波形和保存 URL ──────────
            const origOnExecuted = node.onExecuted;
            node.onExecuted = function(output) {
                origOnExecuted?.apply(this, arguments);

                if (!output) return;

                // 兼容不同 ComfyUI 版本的 output 结构
                const audioSaved = output.ui?.audio_saved || output.audio_saved;
                if (Array.isArray(audioSaved) && audioSaved.length > 0) {
                    const info = audioSaved[0];
                    
                    // 保存模式 & 预览模式：统一构建 /view URL
                    // - 保存模式：type=output + 持久化到 output 目录
                    // - 预览模式：type=temp   + 编码到 temp 目录（不落盘 output，可播放/右键另存）
                    if (info.abs_token) {
                        // 绝对路径自定义输出：文件在 output 之外，/view 无法服务，走令牌拉流
                        saveUrl = api.apiURL(
                            `/xzg/davinci/view-abs?token=${encodeURIComponent(info.abs_token)}${app.getRandParam()}`
                        );
                    } else {
                        saveUrl = api.apiURL(
                            `/view?filename=${encodeURIComponent(info.filename)}&type=${info.type}&subfolder=${encodeURIComponent(info.subfolder || '')}${app.getRandParam()}`
                        );
                    }
                    savedFilename = info.filename;
                    savedType = info.type || "output";
                    savedSubfolder = info.subfolder || "";
                    savedDavinciToken = info.davinci_abs_token || "";

                    // 更新波形显示和播放信息（setSaveInfo 内部会绑定 <audio> src = saveUrl）
                    waveformViewer.setData(info.peaks, info.duration, info.sample_rate);
                    waveformViewer.setSaveInfo(saveUrl, savedFilename);

                    // 序列化到 widget value（刷新后可恢复波形）：
                    // 注意：不序列化 volume——刷新/重启 ComfyUI 时音量必须从 100% 开始。
                    if (waveformWidget && info.peaks && info.duration) {
                        const saveData = {
                            peaks: info.peaks,
                            duration: info.duration,
                            sampleRate: info.sample_rate,
                            // 预览模式不落盘 saveUrl：temp 文件可能已被 ComfyUI 清理，
                            // 刷新后避免伪 404 链接，只保留波形可视化
                            saveUrl: info.preview ? "" : saveUrl,
                            filename: info.preview ? "" : savedFilename,
                            type: info.preview ? "" : (info.type || "output"),
                            subfolder: info.preview ? "" : (info.subfolder || ""),
                        };
                        waveformWidget.value = JSON.stringify(saveData);
                    }

                    // 写入模块级缓存 + localStorage（切换工作流后切回恢复用，参考视频保存机制）：
                    // 键含工作流指纹/图实例令牌，跨工作流天然隔离；切走 tab 节点销毁期间，
                    // 由模块级 executed 兜底监听（init 中注册）按指纹键补写最新输出。
                    const cacheInfo = _xzgAudioBuildCacheInfo(info);
                    const wfFp = node._xzgWfFp || _xzgAudioGraphFingerprint(node.graph);
                    if (node.graph) {
                        _xzgAudioOutputCache.set(_xzgAudioCacheKey(node.graph, String(node.id)), cacheInfo);
                    }
                    if (wfFp) {
                        _xzgAudioOutputCacheByFp.set(`${wfFp}|${String(node.id)}`, cacheInfo);
                        _xzgPersistAudioOutput(wfFp, String(node.id), cacheInfo);
                    }

                    // 执行完成 → 换新音频：音量 widget 强制重置为 100%（与 viewer 重置同步）
                    const volW2 = node.widgets?.find(w => w.name === '音量');
                    if (volW2) {
                        volW2.value = 1.0;
                    }

                    // 自动发送到快剪只针对持久化保存文件；预览 temp 可由用户在清理前手动发送。
                    const autoQcW = node.widgets?.find(w => w.name === '自动发送到快剪');
                    if (autoQcW && autoQcW.value && info.type === 'output') {
                        try { _xzgAudioSendQuickCut(info.filename, info.subfolder || ''); } catch (e) {}
                    }

                    // 自动导出到达芬奇：开关开启且为保存模式（output）时，把音频导入达芬奇
                    // （与视频保存-化神级一致：仅保存模式有真实磁盘文件；后端已按同名开关
                    //  自动导出并回传 davinci 结果 —— 若 ui 里带 davinci 信息则跳过前端重复导出）
                    const autoDvW = node.widgets?.find(w => w.name === '自动导出到达芬奇');
                    if (autoDvW && autoDvW.value && info.type === 'output' && !info.davinci) {
                        try {
                            _xzgAudioExportDavinci(info.filename, info.subfolder || '', {
                                node, token: info.davinci_abs_token || info.abs_token,
                            });
                        } catch (e) {}
                    }

                    node.setDirtyCanvas(true, true);
                }
            };

            // ─── onConfigure：工作流重载后恢复样式和尺寸 ──────────
            // 恢复优先级：模块缓存（图实例令牌键，同会话真实执行）→ 指纹缓存
            // （节点销毁期间模块级兜底监听写入）→ localStorage（跨刷新）→ widget.value（旧兜底）。
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function(info) {
                origOnConfigure?.apply(this, arguments);
                requestAnimationFrame(() => {
                    node.onResize?.(node.size);
                    // 工作流加载后同步自动发送/自动导出开关图标状态（widget 值此时才恢复）
                    node._xzgQcRenderAuto?.();
                    node._xzgDvRenderAuto?.();

                    // 工作流加载/切 tab 重建时，configure 逐个节点执行，同步阶段图可能未建全；
                    // rAF 阶段整图已就绪，重算指纹（覆盖 onNodeCreated 兜底）
                    node._xzgWfFp = _xzgAudioGraphFingerprint(node.graph);
                    const wfFp = node._xzgWfFp;
                    const davinciTarget = wfFp ? _xzgLoadPersistedAudioDavinciTarget(wfFp, String(node.id)) : null;
                    if (davinciTarget?.directory) {
                        node._xzgAudioDavinciSession = davinciTarget.session || "";
                        node._xzgAudioDavinciOutputDir = davinciTarget.directory;
                        node._xzgAudioDavinciOutputName = davinciTarget.filename || "";
                    }
                    const moduleCached = node.graph ? _xzgAudioOutputCache.get(_xzgAudioCacheKey(node.graph, String(node.id))) : null;
                    const fpCached = wfFp ? _xzgAudioOutputCacheByFp.get(`${wfFp}|${String(node.id)}`) : null;
                    const persisted = wfFp ? _xzgLoadPersistedAudioOutput(wfFp, String(node.id)) : null;
                    const cached = moduleCached || fpCached || persisted;

                    let restored = false;
                    // 缓存优先：覆盖「切走期间后台跑完」的最新输出（节点级 onExecuted 已失效的场景）
                    if (cached && Array.isArray(cached.peaks) && cached.peaks.length > 0 && cached.duration > 0) {
                        // setData 内部会把 volume 重置到 100%
                        waveformViewer.setData(cached.peaks, cached.duration, cached.sample_rate);
                        const restoreUrl = _xzgAudioRestoreUrl(cached);
                        if (restoreUrl && cached.filename) {
                            waveformViewer.setSaveInfo(restoreUrl, cached.filename);
                            // 恢复落盘信息（右键「保存/发送到音频加载器」需要 type/subfolder）
                            savedFilename = cached.filename;
                            savedType = cached.type || "output";
                            savedSubfolder = cached.subfolder || "";
                            savedDavinciToken = cached.davinci_abs_token || "";
                        }
                        // 播放头默认在最开头
                        if (cached.duration > 0) {
                            waveformViewer.playbackTime = 0;
                        }
                        restored = true;
                        node.setDirtyCanvas?.(true, true);
                    }

                    // widget.value 兜底（浏览器刷新/加载工作流后，缓存为空时）
                    if (!restored && waveformWidget && waveformWidget.value && typeof waveformWidget.value === 'string') {
                        try {
                            const data = JSON.parse(waveformWidget.value);
                            if (data.peaks && data.duration) {
                                waveformViewer.setData(data.peaks, data.duration, data.sampleRate);
                                if (data.saveUrl && data.filename) {
                                    waveformViewer.setSaveInfo(data.saveUrl, data.filename);
                                    savedFilename = data.filename;
                                    savedType = data.type || "output";
                                    savedSubfolder = data.subfolder || "";
                                }
                                if (data.duration > 0) {
                                    waveformViewer.playbackTime = 0;
                                }
                            }
                        } catch (e) {
                            // 解析失败忽略
                        }
                    }

                    // 音量：刷新/重启 ComfyUI 时一律从 100% 开始，不再恢复之前的 volume
                    const volWidget = node.widgets?.find(w => w.name === '音量');
                    const defaultVol = 1.0;
                    waveformViewer.volume = defaultVol;
                    waveformViewer._applyVolume(defaultVol);
                    if (volWidget) volWidget.value = defaultVol;

                    node.setDirtyCanvas?.(true, true);
                });
            };

            // ─── 节点级鼠标事件（覆盖波形+下方黑色区域）──────────
            // widget 的 computeSize 高度只有 40px，下方黑色区域收不到 widget 鼠标事件
            // 因此用节点级事件拦截波形区域的鼠标操作
            const origOnMouseDown = node.onMouseDown;
            node.onMouseDown = function (e, localPos, canvas) {
                const [lx, ly] = localPos;
                const wy = waveformViewer._drawY;
                const wh = waveformViewer._drawH;
                const wH = waveformViewer._widgetH || wh; // 可点击区域总高度
                const areaBottom = wy + Math.max(wh, wH);
                if (wy > 0 && ly >= wy && ly <= areaBottom) {
                    // 右键由 processMouseDown hook 处理，这里跳过
                    if (e.button === 2) return true;
                    const result = waveformViewer.handleMouse(e, lx, ly);
                    if (result) return true;
                }
                return origOnMouseDown?.apply(this, arguments);
            };
            const origOnMouseMove = node.onMouseMove;
            node.onMouseMove = function (e, localPos, canvas) {
                const [lx, ly] = localPos;
                const wy = waveformViewer._drawY;
                const wh = waveformViewer._drawH;
                const wH = waveformViewer._widgetH || wh;
                const areaBottom = wy + Math.max(wh, wH);
                if (wy > 0 && ly >= wy && ly <= areaBottom) {
                    const result = waveformViewer.handleMouse(e, lx, ly);
                    if (result) return true;
                } else if (waveformViewer._playheadHover) {
                    waveformViewer._playheadHover = false;
                    node.setDirtyCanvas?.(true, true);
                }
                return origOnMouseMove?.apply(this, arguments);
            };
            const origOnMouseUp = node.onMouseUp;
            node.onMouseUp = function (e, localPos, canvas) {
                const [lx, ly] = localPos;
                const wy = waveformViewer._drawY;
                const wh = waveformViewer._drawH;
                const wH = waveformViewer._widgetH || wh;
                const areaBottom = wy + Math.max(wh, wH);
                if (wy > 0 && ly >= wy && ly <= areaBottom) {
                    const result = waveformViewer.handleMouse(e, lx, ly);
                    if (result) return true;
                }
                return origOnMouseUp?.apply(this, arguments);
            };

            // Patch prompt dialog for custom widgets
            _xzgPatchCanvasPrompt();

            // 初始化时触发一次 resize 计算波形高度
            requestAnimationFrame(() => {
                node.onResize?.(node.size);
            });

            // 节点移除时（切换工作流/刷新浏览器）立即停止音频播放
            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                waveformViewer.destroy();
                origOnRemoved?.apply(this, arguments);
            };
        };
    },
});


// ═══════════════════════════════════════════════════════════════════════
// 右键保存菜单（拦截 ComfyUI 原生菜单，显示自定义格式列表）
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// 发送到小珠光音频加载器（与图像保存节点的发送功能同构）
// ═══════════════════════════════════════════════════════════════════════

// 查找画布中所有小珠光音频加载器节点（不过滤绕过状态：用户可能就是想发给全部节点，绕过自己切换）
function _xzgFindAudioLoaders() {
    const loaders = [];
    const nodes = app.graph?.nodes || [];
    for (const n of nodes) {
        if (n && n.type === "XiaozhuguangAudioLoader") {
            loaders.push(n);
        }
    }
    return loaders;
}

// 将音频发送到指定加载器节点：设置音频 widget 值并触发回调（内部会解码显示波形）
function _xzgSendToAudioLoaderNode(loaderNode, annotatedName) {
    const audioWidget = loaderNode.widgets?.find((w) => w.name === "音频");
    if (!audioWidget) {
        console.warn("[小珠光音频保存] 目标加载器缺少音频 widget，发送取消");
        return;
    }
    audioWidget.value = annotatedName;
    audioWidget.callback?.(annotatedName);
    app.graph.setDirtyCanvas(true);
}

// 主入口：发送当前音频到画布中所有小珠光音频加载器
//   annotatedName 形如 "a.mp3 [output]"（subfolder 非空时 "sub/a.mp3 [output]"）
function _xzgSendToAudioLoader(annotatedName) {
    if (!annotatedName) return;
    const loaders = _xzgFindAudioLoaders();

    if (loaders.length === 0) {
        const msg = "未找到小珠光音频加载器节点，请先添加一个";
        console.warn("[小珠光音频保存] " + msg);
        alert(msg);
        return;
    }

    for (const n of loaders) _xzgSendToAudioLoaderNode(n, annotatedName);
}


// ═══════════════════════════════════════════════════════════════════════
// 发送到快剪媒体库（与视频保存-化神级的「发送到快剪」联动同一入口）：
// 快剪已打开 → 媒体库 + A1 音乐轨追加；未打开 → 仅加入媒体库（下次打开可见）
// ═══════════════════════════════════════════════════════════════════════

function _xzgToast(msg, isError = false) {
    const el = document.createElement("div");
    el.style.cssText =
        "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:1000002;" +
        "padding:8px 16px;border-radius:6px;font-size:13px;color:#fff;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.4);pointer-events:none;opacity:0;" +
        "transition:opacity .25s;max-width:80vw;word-break:break-all;";
    el.style.background = isError ? "rgba(198,40,40,.95)" : "rgba(30,30,30,.95)";
    if (isError) el.style.border = "1px solid #ef9a9a";
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => {
        el.style.opacity = "1";
        setTimeout(() => {
            el.style.opacity = "0";
            setTimeout(() => el.remove(), 260);
        }, 3000);
    });
}

function _xzgAudioSendQuickCut(filename, subfolder, type = "output") {
    if (!filename) return;
    if (typeof window._xzgVideoEditorReceiveMedia !== "function") {
        _xzgToast("[发送到快剪] 快剪模块未加载，请刷新页面。", true);
        return;
    }
    // 带子目录时拼完整相对路径（sub/a.mp3），编辑器内部会拆分为 subfolder + filename
    const name = subfolder ? subfolder + "/" + filename : filename;
    Promise.resolve(window._xzgVideoEditorReceiveMedia(name, type))
        .then(() => {
            _xzgToast("已加入快剪媒体库（打开快剪即可拖入轨道使用）");
        })
        .catch((e) => {
            _xzgToast("[发送到快剪] " + String(e), true);
        });
}

// ═══════════════════════════════════════════════════════════════════════
// 导出到达芬奇（与视频保存-化神级同一后端桥接，action=import_audio）：
// ImportMedia 进媒体池 + 复用空白音频轨道/无则新建 + 对齐播放头片段前端
// ═══════════════════════════════════════════════════════════════════════
async function _xzgAudioExportDavinci(filename, subfolder, opts = {}) {
    if (!filename) return;
    const btn = opts.btn, labelSpan = opts.labelSpan, label = opts.label || "导出到达芬奇";
    const node = opts.node;
    const waveformViewer = node?._xzgWaveformViewer;
    const setBusy = (busy, status = "") => {
        if (!waveformViewer) return;
        waveformViewer._davinciActionBusy = busy;
        waveformViewer._davinciBusyLabel = busy ? status : "";
        waveformViewer._node?.setDirtyCanvas?.(true, true);
    };
    if (btn) btn.disabled = true;
    setBusy(true, "准备导出…");
    try {
        // 与音频加载器-化神级共用后端会话标识：浏览器刷新或 ComfyUI 重启后，
        // 节点第一次手动导出会重新弹出 Windows 原生保存对话框。
        const sessionResp = await api.fetchApi(`/xzg/davinci/audio-loader-session?_=${Date.now()}`, { cache: "no-store" });
        const sessionInfo = await sessionResp.json();
        if (!sessionResp.ok || !sessionInfo?.session) {
            throw new Error(sessionInfo?.error || "无法确认 ComfyUI 会话状态");
        }
        const session = sessionInfo.session;
        const sameSession = node?._xzgAudioDavinciSession === session && !!node?._xzgAudioDavinciOutputDir;
        const status = sameSession ? "正在导出到达芬奇…" : "选择保存位置…";
        setBusy(true, status);
        if (labelSpan) labelSpan.textContent = status;
        const resp = await api.fetchApi("/xzg/davinci/audio-save-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                filename,
                subfolder: subfolder || "",
                type: opts.type || "output",
                ...(opts.token ? { abs_token: opts.token } : {}),
                target_dir: sameSession ? node._xzgAudioDavinciOutputDir : "",
                target_name: sameSession ? node._xzgAudioDavinciOutputName : "",
            }),
        });
        const data = await resp.json();
        if (data?.save_directory) {
            node._xzgAudioDavinciSession = session;
            node._xzgAudioDavinciOutputDir = data.save_directory;
            node._xzgAudioDavinciOutputName = data.save_filename || node._xzgAudioDavinciOutputName;
            _xzgPersistAudioDavinciTarget(node._xzgWfFp || _xzgAudioGraphFingerprint(node.graph), String(node.id), {
                session,
                directory: data.save_directory,
                filename: node._xzgAudioDavinciOutputName,
            });
        }
        if (data?.cancelled) {
            _xzgToast("已取消导出到达芬奇。");
            return;
        }
        if (!data?.ok) {
            _xzgToast("[导出到达芬奇] " + (data?.error || "导入失败"), true);
            return;
        }
        if (data?.duplicate) {
            _xzgToast("[导出到达芬奇] " + (data?.message || "该位置已存在相同片段，未重复导入"));
            return;
        }
        const clip = data.clip ? `「${data.clip}」` : "";
        const track = data.track != null ? `A${data.track}` : "";
        _xzgToast(`已导出至达芬奇${clip} ${track} ${data.record_frame != null ? `@帧${data.record_frame}` : ""}`.trim());
    } catch (e) {
        _xzgToast("[导出到达芬奇] " + String(e), true);
    } finally {
        setBusy(false);
        if (btn) btn.disabled = false;
        if (labelSpan) labelSpan.textContent = label;
    }
}

// 音符 SVG（stroke=currentColor 可随 CSS 变色，用于自动发送开关状态色）
const _MUSIC_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'style="display:block">' +
    '<path d="M9 18V5l12-2v13"/>' +
    '<circle cx="6" cy="18" r="3"/>' +
    '<circle cx="18" cy="16" r="3"/>' +
    '</svg>';

// 悬浮在波纹区上方的 DOM 按钮不属于 LiteGraph 画布；转发滚轮使画布缩放连续。
function _xzgForwardCanvasWheel(e) {
    const canvas = app.canvas?.canvas;
    if (!canvas) return;
    e.preventDefault();
    e.stopPropagation();
    canvas.dispatchEvent(new WheelEvent("wheel", {
        deltaY: e.deltaY, deltaX: e.deltaX,
        clientX: e.clientX, clientY: e.clientY,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
        bubbles: true, cancelable: true,
    }));
}

function _ensureAudioSaveOutputSettings(node) {
    const find = (name) => node.widgets?.find(w => w.name === name);
    const add = (type, name, value) => node.addWidget(type, name, value, () => {});
    const hide = (w) => { w.type = "hidden"; w.hidden = true; w.draw = () => {}; w.computeSize = () => [0, 0]; };
    const settings = [find("use_default_output") || add("toggle", "use_default_output", true),
        find("base_dir") || add("text", "base_dir", ""),
        find("filename_custom") || add("text", "filename_custom", "xzg-audio"),
        find("add_date_stamp") || add("toggle", "add_date_stamp", false),
        find("add_time_stamp") || add("toggle", "add_time_stamp", false)];
    settings.forEach(hide);
    [node._xzgDefaultOutputWidget, node._xzgBaseDirWidget, node._xzgPrefixCustomWidget,
        node._xzgDateStampWidget, node._xzgTimeStampWidget] = settings;
}

function _audioOutputOptions(node) {
    return { use_default_output: node._xzgDefaultOutputWidget?.value !== false,
        base_dir: node._xzgBaseDirWidget?.value || "", filename_prefix: node._xzgPrefixCustomWidget?.value || "xzg-audio",
        add_date_stamp: !!node._xzgDateStampWidget?.value, add_time_stamp: !!node._xzgTimeStampWidget?.value };
}

// 场记板 SVG（与视频保存-化神级「导出到达芬奇」同款，stroke=currentColor 可染色）
const _CLAPPER_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'style="display:block">' +
    '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/>' +
    '<path d="m6.2 5.3 3.1 3.9"/>' +
    '<path d="m12.4 3.4 3.1 4"/>' +
    '<path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>' +
    '</svg>';

// 齿轮 SVG（输出设置按钮）：与 ♪ 图标同为 15x15、currentColor 描边，保证三按钮盒高/基线一致
const _GEAR_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'style="display:block">' +
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
    '</svg>';

// ═══════════════════════════════════════════════════════════════════════
// 波纹区悬浮「发送到快剪」按钮：场记板图标常亮金色，按钮只执行手动发送。
// 波形是画布直绘（无 DOM 容器），按钮位置由波形 widget 绘制帧同步：
// 用节点 pos + 画布 ds 变换把波纹区换算到屏幕坐标，按钮贴波纹区右上角内侧；
// 鼠标悬停波纹区显示、离开隐藏。
// ═══════════════════════════════════════════════════════════════════════
function _createQuickCutFloatButton(node, waveformViewer, getSavedInfo) {
    if (node._xzgQcFloatBtn) return node._xzgQcFloatBtn;

    const btn = document.createElement("button");
    btn.title = "发送到快剪媒体库（打开快剪后可手动拖入轨道使用）";
    btn.style.cssText =
        "position:fixed;z-index:100001;" +
        "display:inline-flex;align-items:center;gap:5px;" +
        "padding:2px 8px;font-size:12px;line-height:1;" +
        "background:transparent;color:#FFD700;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;opacity:0;" +
        "text-shadow:0 1px 2px rgba(0,0,0,.8);";
    btn.innerHTML = `<span style="display:inline-flex;color:#FFD700;">${_CLAPPER_SVG}</span><span>发送</span>`;
    document.body.appendChild(btn);
    const iconSpan = btn.querySelector("span:first-child");
    const labelSpan = btn.querySelector("span:last-child");

    // 保留工作流恢复时的同步入口；悬浮按钮不再切换自动发送状态。
    const renderAuto = () => {
        iconSpan.style.color = "#FFD700";
        iconSpan.title = "点击发送到快剪";
        btn.style.color = "#FFD700";
    };
    renderAuto();
    iconSpan.addEventListener("pointerdown", (e) => e.stopPropagation());

    btn.addEventListener("mouseenter", () => {
        if (btn.disabled) return;
        btn.style.color = "#fff";
        iconSpan.style.color = "#fff";
    });
    btn.addEventListener("mouseleave", () => {
        btn.style.color = "#FFD700";
        iconSpan.style.color = "#FFD700";
    });
    btn.addEventListener("wheel", _xzgForwardCanvasWheel, { passive: false });
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.onclick = (e) => {
        const info = getSavedInfo ? getSavedInfo() : null;
        if (!info || !info.filename || (info.type !== "output" && info.type !== "temp")) {
            _xzgToast("[发送到快剪] 当前没有可发送的音频，请先执行一次节点。", true);
            return;
        }
        _xzgAudioSendQuickCut(info.filename, info.subfolder || "", info.type);
    };

    // 位置同步：波纹区节点本地坐标（waveformViewer._drawY/_drawW/_drawH，绘制帧更新）
    //   → 屏幕坐标（节点 pos + 画布 ds 缩放/平移），按钮贴波纹区右上角内侧
    const _lastMouse = { x: -1, y: -1 };
    let _hoverRect = null;
    const onMove = (e) => { _lastMouse.x = e.clientX; _lastMouse.y = e.clientY; };
    document.addEventListener("pointermove", onMove, true);

    const syncBtn = () => {
        try {
            const canvas = app?.canvas;
            const cv = canvas?.canvas;
            const ds = canvas?.ds;
            const npos = node.pos, nsize = node.size;
            const drawW = waveformViewer._drawW || 0;
            const drawH = waveformViewer._drawH || 0;
            if (!cv || !ds || !npos || drawW <= 0 || drawH <= 0) {
                _hoverRect = null;
                btn.style.opacity = "0";
                return;
            }
            const rect = cv.getBoundingClientRect();
            const scale = ds.scale || 1;
            const x0 = (npos[0] + ds.offset[0]) * scale + rect.left;
            const y0 = (npos[1] + ds.offset[1] + waveformViewer._drawY) * scale + rect.top;
            const w = drawW * scale, h = drawH * scale;
            _hoverRect = { x: x0, y: y0, w, h };
            // 字体/尺寸随画布缩放：transform 整体缩放（固定 11px 字号在缩小画布时会显得过大）。
            // 锚定用 top left：视觉盒 = left..left+bw*s（transform 不改变 offsetWidth），
            // left 显式扣掉缩放后宽度 → 视觉右缘恒定 = 节点右缘 - 10*scale，
            // 任意 zoom 下按钮相对波纹区的位置与大小都稳定
            const s = scale; // 完全跟随画布缩放（不再夹取区间）
            btn.style.transformOrigin = "top left";
            btn.style.transform = `scale(${s})`;
            const bw = btn.offsetWidth || 90;
            // 左移基准：达芬奇按钮的 left（其 sync 在本帧已先执行，贴右缘）；兜底自算右缘
            const dv = node._xzgDvFloatBtn;
            let dvLeft = dv ? parseFloat(dv.style.left) : NaN;
            if (!isFinite(dvLeft)) dvLeft = x0 + w - 10 * scale - (dv?.offsetWidth || 90) * s;
            btn.style.left = Math.round(dvLeft - 6 * scale - bw * s) + "px";
            // 垂直对齐：与加载器音轨顶栏文字一致（波纹区顶部 + 2px，节点本地坐标）。
            // 按钮文字视觉顶 = top + 上内边距(2px)*s，故 top = y0 + 2*scale - 2*s
            btn.style.top = Math.round(y0 + 2 * scale - 2 * s) + "px";
            // 悬停波纹区显示、离开隐藏（节点在视口外时不显示）
            const inside = _lastMouse.x >= x0 && _lastMouse.x <= x0 + w &&
                           _lastMouse.y >= y0 && _lastMouse.y <= y0 + h &&
                           x0 + w > rect.left && x0 < rect.right &&
                           y0 + h > rect.top && y0 < rect.bottom;
            const overBtn = btn.matches(":hover");
            btn.style.opacity = (inside || overBtn) ? "1" : "0";
        } catch (e) { /* 画布未就绪等场景忽略 */ }
    };
    node._xzgQcSyncBtn = syncBtn;

    // 节点移除时清理按钮与监听
    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        document.removeEventListener("pointermove", onMove, true);
        try { btn.remove(); } catch (e) {}
        node._xzgQcFloatBtn = null;
        node._xzgQcSyncBtn = null;
        return origOnRemoved?.apply(this, arguments);
    };

    node._xzgQcFloatBtn = btn;
    node._xzgQcRenderAuto = renderAuto;
    return btn;
}

// ═══════════════════════════════════════════════════════════════════════
// 波纹区悬浮「导出到达芬奇」按钮：彩色三叶草常亮，按钮只执行手动导出。
// 位置贴「发送到快剪」按钮左侧（顶栏右三），同步逻辑与快剪按钮一致
// ═══════════════════════════════════════════════════════════════════════

// 达芬奇三叶草图标：outline=true → 灰色线框；否则彩色三叶草
function _xzgDvToggleClover(outline) {
    const id = "xzg-dv-toggle-clover-style";
    if (!document.getElementById(id)) {
        const st = document.createElement("style");
        st.id = id;
        st.textContent =
            ".xzg-dv-tclover{position:relative;display:inline-block;width:16px;height:15px;flex:0 0 16px;vertical-align:middle;outline:none;box-shadow:none;}" +
            ".xzg-dv-tclover>i{position:absolute;width:8px;height:8px;box-sizing:border-box;border-radius:50%;}" +
            ".xzg-dv-tclover .c-blue{top:0;left:4px;background:linear-gradient(135deg,#47e7ff,#22c9e9 45%,#3f91d7 78%,#d8f6b3);}" +
            ".xzg-dv-tclover .c-green{top:6.93px;left:0;background:linear-gradient(135deg,#fbf264,#dfee4c 52%,#9ac83a);}" +
            ".xzg-dv-tclover .c-red{top:6.93px;left:8px;background:linear-gradient(135deg,#f14c69,#ed5968 52%,#ee9250);}" +
            "@keyframes xzg-dv-clover-spin{to{transform:rotate(360deg);}}" +
            ".xzg-dv-tclover.spinning{transform-origin:50% 50%;animation:xzg-dv-clover-spin .8s linear infinite;}" +
            ".xzg-dv-tclover.outline>i{background:transparent;border:1.3px solid #6b7280;}";
        document.head.appendChild(st);
    }
    return '<span class="xzg-dv-tclover' + (outline ? " outline" : "") + '" aria-hidden="true">' +
        '<i class="c-blue"></i><i class="c-green"></i><i class="c-red"></i></span>';
}

function _createDavinciFloatButton(node, waveformViewer, getSavedInfo) {
    if (node._xzgDvFloatBtn) return node._xzgDvFloatBtn;

    const btn = document.createElement("button");
    btn.title = "把当前节点保存的音频导入达芬奇（进媒体池 + 复用空白音频轨道/无则新建 + 对齐播放头片段前端）";
    btn.style.cssText =
        "position:fixed;z-index:100001;" +
        "display:inline-flex;align-items:center;gap:5px;" +
        "padding:2px 8px;font-size:12px;line-height:1;" +
        "background:transparent;color:#3ef558;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;opacity:0;" +
        "text-shadow:0 1px 2px rgba(0,0,0,.8);outline:none;-webkit-tap-highlight-color:transparent;box-shadow:none;";
    btn.innerHTML = `<span style="display:inline-flex;">${_xzgDvToggleClover(false)}</span><span>导出</span>`;
    document.body.appendChild(btn);
    const iconSpan = btn.querySelector("span:first-child");
    const labelSpan = btn.querySelector("span:last-child");
    iconSpan.title = "点击导出到达芬奇";
    // 保留工作流恢复时的同步入口，但悬浮按钮始终显示彩色三叶草，不再切换自动导出状态。
    const renderAuto = () => {
        iconSpan.innerHTML = _xzgDvToggleClover(false);
        iconSpan.title = "点击导出到达芬奇";
        btn.style.color = "#3ef558";
    };

    btn.addEventListener("mouseenter", () => {
        if (btn.disabled) return;
        btn.style.color = "#fff";
        iconSpan.querySelector(".xzg-dv-tclover")?.classList.add("spinning");
    });
    btn.addEventListener("mouseleave", () => {
        btn.style.color = "#3ef558";
        iconSpan.querySelector(".xzg-dv-tclover")?.classList.remove("spinning");
    });
    btn.addEventListener("wheel", _xzgForwardCanvasWheel, { passive: false });
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.onclick = (e) => {
        const info = getSavedInfo ? getSavedInfo() : null;
        if (!info || !info.filename || (info.type !== "output" && info.type !== "temp" && !info.davinci_abs_token)) {
            _xzgToast("[导出到达芬奇] 请先执行一次音频保存节点。", true);
            return;
        }
        _xzgAudioExportDavinci(info.filename, info.subfolder || "", {
            node, btn, labelSpan, label: "导出", token: info.davinci_abs_token, type: info.type,
        });
    };

    // 位置同步：与快剪按钮同一波纹区矩形，落在其左侧（预留 6px 间隙）
    const _lastMouse = { x: -1, y: -1 };
    let _hoverRect = null;
    const onMove = (e) => { _lastMouse.x = e.clientX; _lastMouse.y = e.clientY; };
    document.addEventListener("pointermove", onMove, true);

    const syncBtn = () => {
        try {
            const canvas = app?.canvas;
            const cv = canvas?.canvas;
            const ds = canvas?.ds;
            const npos = node.pos, nsize = node.size;
            const drawW = waveformViewer._drawW || 0;
            const drawH = waveformViewer._drawH || 0;
            if (!cv || !ds || !npos || drawW <= 0 || drawH <= 0) {
                _hoverRect = null;
                btn.style.opacity = "0";
                return;
            }
            const rect = cv.getBoundingClientRect();
            const scale = ds.scale || 1;
            const x0 = (npos[0] + ds.offset[0]) * scale + rect.left;
            const y0 = (npos[1] + ds.offset[1] + waveformViewer._drawY) * scale + rect.top;
            const w = drawW * scale, h = drawH * scale;
            _hoverRect = { x: x0, y: y0, w, h };
            const s = scale; // 完全跟随画布缩放（不再夹取区间）
            btn.style.transformOrigin = "top left";
            btn.style.transform = `scale(${s})`;
            const bw = btn.offsetWidth || 90;
            // 达芬奇贴波纹区右缘（最右）：视觉右缘 = 节点右缘 - 10*scale
            btn.style.left = Math.round(x0 + w - 10 * scale - bw * s) + "px";
            btn.style.top = Math.round(y0 + 2 * scale - 2 * s) + "px";
            // 悬停波纹区显示、离开隐藏（节点在视口外时不显示）
            const inside = _lastMouse.x >= x0 && _lastMouse.x <= x0 + w &&
                           _lastMouse.y >= y0 && _lastMouse.y <= y0 + h &&
                           x0 + w > rect.left && x0 < rect.right &&
                           y0 + h > rect.top && y0 < rect.bottom;
            const overBtn = btn.matches(":hover");
            btn.style.opacity = (inside || overBtn) ? "1" : "0";
        } catch (e) { /* 画布未就绪等场景忽略 */ }
    };
    node._xzgDvSyncBtn = syncBtn;

    // 节点移除时清理按钮与监听
    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        document.removeEventListener("pointermove", onMove, true);
        try { btn.remove(); } catch (e) {}
        node._xzgDvFloatBtn = null;
        node._xzgDvSyncBtn = null;
        return origOnRemoved?.apply(this, arguments);
    };

    node._xzgDvFloatBtn = btn;
    node._xzgDvRenderAuto = renderAuto;
    return btn;
}

function _createAudioSaveOutputButton(node, waveformViewer) {
    if (node._xzgOutFloatBtn) return node._xzgOutFloatBtn;

    const btn = document.createElement("button");
    btn.title = "设置导出到达芬奇前的音频副本目录";
    // 与「发送到快剪」「导出到达芬奇」完全同款盒模型（inline-flex + 15px 图标 + 12px 文字、
    // 相同 padding/line-height），保证三个按钮高度与文字基线一致；opacity 同样 0.2s 过渡，
    // 悬停波纹区时三个按钮同时淡入淡出。
    btn.style.cssText =
        "position:fixed;z-index:100001;" +
        "display:inline-flex;align-items:center;gap:5px;" +
        "padding:2px 8px;font-size:12px;line-height:1;" +
        "background:transparent;color:#8ab4f8;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;opacity:0;" +
        "text-shadow:0 1px 2px rgba(0,0,0,.8);";
    btn.innerHTML =
        `<span style="display:inline-flex;">${_GEAR_SVG}</span><span>设置</span>`;
    document.body.appendChild(btn);

    btn.addEventListener("mouseenter", () => { if (!btn.disabled) btn.style.color = "#fff"; });
    btn.addEventListener("mouseleave", () => { if (!btn.disabled) btn.style.color = "#8ab4f8"; });
    btn.addEventListener("wheel", _xzgForwardCanvasWheel, { passive: false });
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.onclick = () => {
        if (window._xzgShowDirBrowser) window._xzgShowDirBrowser(node);
        else _xzgToast("输出设置弹窗不可用，请刷新页面。", true);
    };

    // 位置/显隐以「发送到快剪」为左锚（其 sync 在本帧先执行）：left 接在它左侧，top 直接取
    // 锚点值；盒模型一致 → 文字基线对齐。opacity 目标值与锚点同帧写入，配合相同 0.2s 过渡同步显隐。
    node._xzgOutSyncBtn = () => {
        const anchor = node._xzgQcFloatBtn;
        if (!anchor?.style?.left) return;
        const scale = app.canvas?.ds?.scale || 1;
        const left = parseFloat(anchor.style.left), top = parseFloat(anchor.style.top);
        const bw = btn.offsetWidth || 90;
        if (!Number.isFinite(left) || !Number.isFinite(top)) return;
        btn.style.transformOrigin = "top left";
        btn.style.transform = `scale(${scale})`;
        btn.style.left = Math.round(left - (bw + 6) * scale) + "px";
        btn.style.top = top + "px";
        btn.style.opacity = anchor.matches(":hover") || btn.matches(":hover") ? "1" : anchor.style.opacity;
    };

    // 节点移除时清理按钮（与快剪/达芬奇按钮一致），避免 DOM 残留
    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        try { btn.remove(); } catch (e) {}
        node._xzgOutFloatBtn = null;
        node._xzgOutSyncBtn = null;
        return origOnRemoved?.apply(this, arguments);
    };

    node._xzgOutFloatBtn = btn;
    return btn;
}


function _xzgShowSaveMenu(cx, cy, url, filename, formatVal, type, subfolder, node) {
    const old = document.querySelector('.xzg-audio-save-menu');
    if (old) old.remove();

    // 当前格式（与节点第一行格式保持一致）
    const fmt = String(formatVal || "mp3").toLowerCase();
    const fmtLabelMap = { "mp3": "MP3", "wav": "WAV（无损）", "flac": "FLAC（无损）" };
    const fmtLabel = fmtLabelMap[fmt] || fmt.toUpperCase();

    const menu = document.createElement('div');
    menu.className = 'xzg-audio-save-menu';

    // 根据屏幕位置自动调整菜单位置
    let left = cx;
    let top = cy;
    menu.style.cssText = `
        position: fixed; z-index: 99999; left: ${left}px; top: ${top}px;
        background: #2a2a2a; border: 1px solid #555; border-radius: 6px;
        padding: 4px 0; box-shadow: 0 4px 16px rgba(0,0,0,0.5); min-width: 140px;
    `;

    // 只显示一个保存项（当前格式）
    const item = document.createElement('div');
    item.style.cssText = `padding: 6px 20px; cursor: pointer; font-size: 13px; color: #FFD700; background: transparent;`;
    item.innerHTML = `<span style="margin-right:6px;">●</span>保存音频（${fmtLabel}）`;

    item.onmouseenter = () => { item.style.background = '#444'; };
    item.onmouseleave = () => { item.style.background = 'transparent'; };

    item.addEventListener('pointerdown', (e) => e.stopPropagation());
    item.onclick = async (e) => {
        e.stopPropagation();
        menu.remove();

        // 使用统一的 downloadAudio（首次桌面，二次上次路径）
        try {
            await downloadAudio(url, filename, {
                onError: (err) => _xzgToast(type === "temp"
                    ? "预览音频临时文件已失效，请重新执行节点后再保存。"
                    : `保存音频失败：${err?.message || err}`, true),
            });
        } catch (err) {
            const expiredPreview = type === "temp";
            _xzgToast(expiredPreview
                ? "预览音频临时文件已失效，请重新执行节点后再保存。"
                : `保存音频失败：${err?.message || err}`, true);
        }
    };

    menu.appendChild(item);
    // 自动调整菜单位置（避免超出屏幕）
    document.body.appendChild(menu);
    
    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            menu.style.left = (cx - rect.width) + 'px';
        }
        if (rect.bottom > window.innerHeight) {
            menu.style.top = (cy - rect.height) + 'px';
        }
    });

    // 点击其他地方关闭菜单
    const close = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('pointerdown', close, true);
        }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
}


// ═══════════════════════════════════════════════════════════════════════
// Patch prompt dialog for custom widgets（与加载器一致）
// ═══════════════════════════════════════════════════════════════════════

function _xzgPatchCanvasPrompt() {
    if (app.canvas._xzgPromptPatched) return;
    const origPrompt = app.canvas.prompt;
    app.canvas.prompt = function () {
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
