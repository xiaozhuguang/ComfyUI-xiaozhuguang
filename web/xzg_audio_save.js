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
            app.canvas?.prompt?.(this.label || this.name, this.value, (v) => {
                this.value = clamp(Number(v));
                if (this.callback) this.callback(this.value);
                node.setDirtyCanvas?.(true, true);
            }, event);
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

// combo 下拉样式
function _xzgDrawComboWidget(ctx, node, width, y, H) {
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

const XZG_AUDIO_WAVEFORM_MIN_H = 40;
const XZG_AUDIO_WAVEFORM_MAX_H = 120;
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

        // 左右留白（与加载器一致）
        this._paddingX = 14;

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
        } else {
            // 确保 Web Audio 图已连接（支持 >100% 音量增益）
            this._ensureAudioGraph();
            if (this._audioCtx && this._audioCtx.state === 'suspended') {
                this._audioCtx.resume();
            }
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
        this._drawH = widgetH;
        this._drawW = widgetW;

        const w = widgetW;
        const h = widgetH;
        const pad = this._getPad();
        const usableW = Math.max(1, w - pad * 2);

        // 背景（与加载器一致：纯黑）
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, widgetY, w, h);

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

        // 分区线：上1/3处半透明白线，以上=拖动跳转，以下=播放/暂停
        const divY = widgetY + barPadY + waveH / 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pad, divY);
        ctx.lineTo(w - pad, divY);
        ctx.stroke();
        ctx.setLineDash([]);

        // 音量显示（左上角）+ 时间码（紧邻音量右侧）
        const volText = `音量${Math.round(this.volume * 100)}`;
        const timeStartX = pad + 2;
        const hintText = '线上拖动跳转 线下播放/暂停 双击音量线重置';
        if (this.duration > 0 && this._saveUrl) {
            // 音量文字
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.font = '6px sans-serif';
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
            ctx.font = '6px sans-serif';
            ctx.fillText(timeStr, timeX, widgetY + 3);
            const timeW = ctx.measureText(timeStr).width;
            // 循环/单次播放图标（时间码后面，高度对齐，暗白色小符号）
            const loopSym = this._loopPlayback ? '⇆' : '→';
            const loopX = timeX + timeW + 8;
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.font = '7px sans-serif';
            ctx.fillText(loopSym, loopX, widgetY + 2);
            const loopW = ctx.measureText(loopSym).width;
            this._loopBtn = { x: loopX - 3, y: widgetY + 1, w: loopW + 6, h: 10 };
            // 小字注释（循环图标右侧）
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.font = '5px sans-serif';
            ctx.fillText(hintText, loopX + loopW + 6, widgetY + 4);
        } else if (this.duration > 0) {
            // 无音频URL时显示音量+总时长，注释同样显示
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.font = '6px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(volText, timeStartX, widgetY + 3);
            const volTextW = ctx.measureText(volText).width;
            const timeStr = this._formatTime(this.duration);
            const timeX = timeStartX + volTextW + 6;
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.fillText(timeStr, timeX, widgetY + 3);
            const timeW = ctx.measureText(timeStr).width;
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.font = '5px sans-serif';
            ctx.fillText(hintText, timeX + timeW + 6, widgetY + 4);
        }

        // 采样率文字（右下角）
        if (this.sampleRate > 0) {
            const srText = this._formatSampleRate(this.sampleRate);
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = '6px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText(srText, w - pad - 2, widgetY + h - 3);
        }

        // 白色播放头（竖白杠）
        if (this.duration > 0 && this._saveUrl && this.playbackTime >= 0) {
            const playX = pad + (this.playbackTime / this.duration) * usableW;
            if (playX >= pad && playX <= pad + usableW) {
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(playX, widgetY + barPadY);
                ctx.lineTo(playX, widgetY + h - barPadY);
                ctx.stroke();
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

        // 右键菜单
        if (event.type === 'contextmenu' || (event.type === 'pointerup' && event.button === 2)) {
            this.onContextMenu(event.clientX, event.clientY);
            return true;
        }

        // 左键按下
        if (event.type === 'pointerdown' && event.button === 0 && this._saveUrl && this.duration > 0) {
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
            const waveH = widgetH - barPadY * 2;
            const waveMid = widgetY + barPadY + waveH / 3;
            const isUpperHalf = y < waveMid;

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

            if (isUpperHalf) {
                // 上半区：播放头拖动模式
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
                // 下半区：单击立即播放/暂停（按下即响应，无延迟）
                // 不进入拖动模式，允许节点正常拖动
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

const XZG_AUDIO_SAVE_TYPE = "XiaozhuguangAudioSave";

// 判断 canvas 坐标是否命中某个音频保存节点的波形区域（命中返回 node，否则 null）
function _xzgAudioSaveHitWaveform(canvasX, canvasY) {
    const nodes = app.graph?.nodes || [];
    for (const n of nodes) {
        if (n.type !== XZG_AUDIO_SAVE_TYPE) continue;
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

app.registerExtension({
    name: "xiaozhuguang.audio_save",
    setup() {
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
        if (nodeData?.name !== XZG_AUDIO_SAVE_TYPE) return;

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

            // ─── 创建波形组件 ──────────────────────────────────────
            let saveUrl = "";      // 后端返回的音频 URL（供右键下载）
            let savedFilename = "";
            // 当前音频的落盘信息（供右键「发送到小珠光音频加载器」用）
            let savedType = "output";   // "output"（保存模式）| "temp"（预览模式）
            let savedSubfolder = "";

            const waveformViewer = new XzgAudioWaveformViewer({
                node,
                onContextMenu(cx, cy) {
                    if (!saveUrl || !savedFilename) return;
                    const fmtWidget = node.widgets?.find(w => w.name === '格式');
                    const fmtVal = fmtWidget ? String(fmtWidget.value) : 'mp3';
                    _xzgShowSaveMenu(cx, cy, saveUrl, savedFilename, fmtVal, savedType, savedSubfolder);
                },
                onVolumeChange(vol) {
                    const volWidget = node.widgets?.find(w => w.name === '音量');
                    if (volWidget) {
                        volWidget.value = Math.round(vol * 100) / 100;
                    }
                },
            });
            node._xzgWaveformViewer = waveformViewer;

            // 波形 canvas widget（直接在节点画布上绘制，与加载器一致的自适应高度）
            const waveformWidget = {
                name: XZG_AUDIO_WAVEFORM_WIDGET_NAME,
                type: "custom",
                value: "",
                options: { serialize: true },
                _xzgDrawW: 0,
                draw: function(ctx, node, width, y, H) {
                    this._xzgDrawW = width;
                    // 边界保护：确保 actualH 不为负，防止波形超出节点边界
                    const actualH = Math.max(0, node.size[1] - y - 8);
                    const h = Math.max(XZG_AUDIO_WAVEFORM_MIN_H, Math.min(XZG_AUDIO_WAVEFORM_MAX_H, actualH));
                    // 整个波形区域（含下方黑色区域）填充黑色背景，不超过节点边界
                    const fillH = Math.min(Math.max(h, actualH), node.size[1] - y);
                    ctx.fillStyle = '#000000';
                    ctx.fillRect(0, y, width, fillH);
                    // 波形从 widget 顶部开始绘制
                    waveformViewer._widgetH = fillH; // 保存可点击区域总高度
                    waveformViewer.drawOnNode(ctx, y, width, h);
                },
                mouse: function(event, [x, y], node) {
                    return waveformViewer.handleMouse(event, x, y);
                },
                computeSize: function(width) {
                    return [width, XZG_AUDIO_WAVEFORM_MIN_H];
                },
                computeLayoutSize: function(width) {
                    return { minHeight: XZG_AUDIO_WAVEFORM_MIN_H, minWidth: 0 };
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

            for (const w of this.widgets || []) {
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
                    // 模式：保存/预览 切换开关
                    w.value = String(w.value ?? "保存");
                    w.options = w.options || {};
                    w.options.values = ["保存", "预览"];
                    w.draw = function(ctx, nd, width, y, H) {
                        this._xzgDrawW = width;
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
                }
            }

            // ─── 节点尺寸限制 ──────────────────────────────────────
            node.resizable = true;
            node.minWidth = 320;
            node.minHeight = 216;   // 默认波形高度 120px（y≈88 + 120 + 8）

            // 计算波形 widget 的 y 位置（用于最大高度限制）
            const _getWaveformY = () => {
                let y = 0;
                for (const w of node.widgets || []) {
                    if (w.name === XZG_AUDIO_WAVEFORM_WIDGET_NAME) break;
                    const sz = w.computeSize ? w.computeSize(node.size[0]) : [0, 20];
                    y += sz[1] || 20;
                }
                return y;
            };

            const origSetSize = node.setSize;
            node.setSize = function(size) {
                size[0] = Math.max(size[0], this.minWidth || 320);
                size[1] = Math.max(size[1], this.minHeight || 216);
                // 最大高度限制：波形高度达到 120px 时不再继续拉高
                const waveY = _getWaveformY();
                const maxH = waveY + XZG_AUDIO_WAVEFORM_MAX_H + 8; // +8 是底部留白
                if (maxH > this.minHeight) {
                    size[1] = Math.min(size[1], maxH);
                }
                return origSetSize?.apply(this, arguments);
            };
            // 默认节点高度 = 波形 120px（y + 120 + 8）
            node.setSize([320, _getWaveformY() + XZG_AUDIO_WAVEFORM_MAX_H + 8]);

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
                    saveUrl = api.apiURL(
                        `/view?filename=${encodeURIComponent(info.filename)}&type=${info.type}&subfolder=${encodeURIComponent(info.subfolder || '')}${app.getRandParam()}`
                    );
                    savedFilename = info.filename;
                    savedType = info.type || "output";
                    savedSubfolder = info.subfolder || "";

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

                    // 执行完成 → 换新音频：音量 widget 强制重置为 100%（与 viewer 重置同步）
                    const volW2 = node.widgets?.find(w => w.name === '音量');
                    if (volW2) {
                        volW2.value = 1.0;
                    }

                    node.setDirtyCanvas(true, true);
                }
            };

            // ─── onConfigure：工作流重载后恢复样式和尺寸 ──────────
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function(info) {
                origOnConfigure?.apply(this, arguments);
                requestAnimationFrame(() => {
                    node.onResize?.(node.size);

                    // 从 widget value 恢复波形数据（刷新/加载工作流后）
                    if (waveformWidget && waveformWidget.value && typeof waveformWidget.value === 'string') {
                        try {
                            const data = JSON.parse(waveformWidget.value);
                            if (data.peaks && data.duration) {
                                // setData 内部会把 volume 重置到 100%
                                waveformViewer.setData(data.peaks, data.duration, data.sampleRate);
                                if (data.saveUrl && data.filename) {
                                    waveformViewer.setSaveInfo(data.saveUrl, data.filename);
                                    // 恢复落盘信息（右键「发送到音频加载器」需要 type/subfolder）
                                    savedFilename = data.filename;
                                    savedType = data.type || "output";
                                    savedSubfolder = data.subfolder || "";
                                }
                                // 播放头默认在最开头
                                if (data.duration > 0) {
                                    waveformViewer.playbackTime = 0;
                                }
                            }
                            // 音量：刷新/重启 ComfyUI 时一律从 100% 开始，不再恢复之前的 volume
                            const volWidget = node.widgets?.find(w => w.name === '音量');
                            const defaultVol = 1.0;
                            waveformViewer.volume = defaultVol;
                            waveformViewer._applyVolume(defaultVol);
                            if (volWidget) volWidget.value = defaultVol;
                        } catch (e) {
                            // 解析失败忽略
                        }
                    }

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


function _xzgShowSaveMenu(cx, cy, url, filename, formatVal, type, subfolder) {
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
    item.innerHTML = `<span style="margin-right:6px;">●</span>保存为 ${fmtLabel}`;

    item.onmouseenter = () => { item.style.background = '#444'; };
    item.onmouseleave = () => { item.style.background = 'transparent'; };

    item.addEventListener('pointerdown', (e) => e.stopPropagation());
    item.onclick = async (e) => {
        e.stopPropagation();
        menu.remove();

        // 使用统一的 downloadAudio（首次桌面，二次上次路径）
        await downloadAudio(url, filename);
    };

    menu.appendChild(item);

    // 发送到音频加载器（所有音频都能发：保存模式 output、预览模式 temp 都支持）
    if (filename && type) {
        const sep = document.createElement('div');
        sep.style.cssText = `height: 1px; background: #555; margin: 4px 0;`;
        menu.appendChild(sep);

        const sendItem = document.createElement('div');
        sendItem.style.cssText = `padding: 6px 20px; cursor: pointer; font-size: 13px; color: #88ccff; background: transparent;`;
        sendItem.innerHTML = `<span style="margin-right:6px;">➤</span>发送到音频加载器`;

        sendItem.onmouseenter = () => { sendItem.style.background = '#444'; };
        sendItem.onmouseleave = () => { sendItem.style.background = 'transparent'; };

        sendItem.addEventListener('pointerdown', (e) => e.stopPropagation());
        sendItem.onclick = (e) => {
            e.stopPropagation();
            menu.remove();
            // 构建标注文件名：subfolder 非空时 "sub/a.mp3 [output]"，否则 "a.mp3 [output]"
            let name = filename;
            if (subfolder) name = subfolder + "/" + name;
            _xzgSendToAudioLoader(name + " [" + type + "]");
        };
        menu.appendChild(sendItem);
    }

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

