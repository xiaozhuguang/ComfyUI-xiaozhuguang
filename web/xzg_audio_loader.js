import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    downloadAudio,
    xzgTimestamp,
} from "./xzg_save_utils.js";

const AUDIO_EXTS = [
    "mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "opus",
    "amr", "ac3", "aiff", "au", "mka", "mp2", "ra", "voc", "w64"
];
const AUDIO_WAVEFORM_WIDGET_NAME = "xzg_audio_waveform";
const AUDIO_CONTROLS_WIDGET_NAME = "xzg_audio_controls";
const AUDIO_WAVEFORM_MIN_H = 40;
const AUDIO_WAVEFORM_MAX_H = 120;
const AUDIO_CONTROLS_H = 0;

// 音频下载 → 统一走 File System Access API（首次桌面，二次上次路径）
async function xzgDownloadAudio(url, filename) {
    await downloadAudio(url, filename || `xzg-audio-${xzgTimestamp()}.mp3`);
}

// ═══════════════════════════════════════════════════════════════════════
// 通用 widget 绘制函数
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
            app.canvas?.prompt?.(
                this.label || this.name,
                this.value,
                (v) => {
                    this.value = clamp(Number(v));
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

function _xzgDrawWidget(ctx, node, width, y, H) {
    this._xzgDrawW = width;
    const pad = 16;
    const r = 6;
    const w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(pad, y + 1, w, H - 2, r); } else { ctx.rect(pad, y + 1, w, H - 2); }
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

// 仅点击弹出输入框，不支持拖动修改（用于起始时间/时长，由波形区拖动代替）
function _xzgWidgetNumberClickOnly(event, [x, y], node) {
    if (event.type === 'pointerup') {
        app.canvas._xzgAllowPrompt = true;
        app.canvas?.prompt?.(
            this.label || this.name,
            this.value,
            (v) => {
                const step = this._xzgStep || 1;
                const min = this._xzgMin;
                const max = this._xzgMax;
                let newVal = Number(v);
                if (min != null && newVal < min) newVal = min;
                if (max != null && newVal > max) newVal = max;
                this.value = newVal;
                if (this.callback) this.callback(this.value);
                node.setDirtyCanvas?.(true, true);
            },
            event
        );
        return true;
    }
    // pointermove 什么也不做，不支持拖动修改
    return true;
}

function _xzgDrawComboWidget(ctx, node, width, y, H) {
    this._xzgDrawW = width;
    const pad = 16, r = 6;
    const w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(pad, y + 1, w, H - 2, r); } else { ctx.rect(pad, y + 1, w, H - 2); }
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();
    ctx.fillStyle = '#9ab';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelText = this.label || this.name || '';
    ctx.fillText(labelText, pad + 6, y + H / 2);
    const displayText = String(this.value ?? '');
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
    ctx.fillStyle = '#888';
    ctx.beginPath();
    const dx = width - pad - 8, dy = y + H / 2;
    ctx.moveTo(dx - 4, dy - 2);
    ctx.lineTo(dx + 4, dy - 2);
    ctx.lineTo(dx, dy + 3);
    ctx.closePath();
    ctx.fill();
}

function _xzgDrawButtonWidget(ctx, node, width, y, H) {
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
// 波形显示 + 音频播放控件（时间码、音量、播放头合二为一，紧凑界面）
// ═══════════════════════════════════════════════════════════════════════
class XiaozhuguangWaveformViewer {
    constructor({ node, onRangeChange, onVolumeChange, onRequestRedraw, onUpload }) {
        this._node = node || null;
        this.onRangeChange = onRangeChange;
        this.onVolumeChange = onVolumeChange || (() => {});
        this.onRequestRedraw = onRequestRedraw || (() => {});
        this.onUpload = onUpload || (() => {});
        this.peaks = [];
        this.duration = 0;
        this.startTime = 0;
        this.endTime = 0;
        this.isDragging = false;
        this.dragType = null;
        this.dragStartX = 0;
        this.dragStartTime = 0;
        this.dragEndTime = 0;
        this.isPlaying = false;
        this.playbackTime = 0;
        this._audioUrl = "";
        this._rafId = null;
        this._currentFile = "";
        this._lastClickTime = 0;
        this._clickTimer = null;
        this._dragThreshold = 5;
        this.volume = 1.0;
        // 循环/单次播放：true=循环，false=单次
        this._loopPlayback = false;
        this._loopBtn = null;
        // 播放头拖动结束时间（防止拖动到界面外后误触发播放）
        this._lastPlayheadEnd = 0;
        // 显示模式：'full' 全览，'crop' 细节
        this._displayMode = 'full';
        // 左右留白：确保标记三角形完全可见
        this._paddingX = 14;

        // 绘制参数（由 drawOnNode 保存，供 handleMouse 使用）
        this._drawY = 0;
        this._drawH = 0;
        this._drawW = 0;

        // 隐藏的 audio 元素（放到 body，不受 widget 销毁影响）
        this._audio = document.createElement("audio");
        this._audio.style.display = "none";
        this._audio.preload = "auto";
        this._audio.crossOrigin = "anonymous";
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
            if (this._loopPlayback && !inPlayheadDrag && !recentlyDragged && this.endTime >= this.duration - 0.05) {
                this._audio.currentTime = this.startTime;
                this._audio.play().catch(e => console.warn("[小珠光] 循环播放失败:", e));
            }
        });
        this._audio.addEventListener("play", () => {
            this.isPlaying = true;
            this._updatePlayButton();
            this._startPlaybackAnimation();
        });
        this._audio.addEventListener("pause", () => {
            this.isPlaying = false;
            this._updatePlayButton();
            this._stopPlaybackAnimation();
        });

        // 全局鼠标事件（拖拽时需要监听 window，同时监听 mouse 和 pointer 事件确保兼容）
        this._onMouseMove = (e) => this._handleMouseMove(e);
        this._onMouseUp = (e) => this._handleMouseUp(e);
        window.addEventListener("mousemove", this._onMouseMove);
        window.addEventListener("mouseup", this._onMouseUp);
        window.addEventListener("pointermove", this._onMouseMove);
        window.addEventListener("pointerup", this._onMouseUp);
        window.addEventListener("pointercancel", this._onMouseUp);

        // === 右键上下文菜单 ===
        this._contextMenu = document.createElement("div");
        this._contextMenu.style.cssText =
            "position:fixed;display:none;z-index:99999;min-width:150px;" +
            "background:#2a2a2a;border:1px solid #444;border-radius:6px;" +
            "box-shadow:0 4px 12px rgba(0,0,0,0.5);padding:4px 0;pointer-events:auto;";
        const menuItemStyle =
            "padding:6px 16px;color:#ddd;cursor:pointer;font-size:12px;white-space:nowrap;";

        this._contextMenuSave = document.createElement("div");
        this._contextMenuSave.style.cssText = menuItemStyle;
        this._contextMenuSave.innerHTML =
            '<span style="display:inline-block;width:18px;">📥</span> 保存音频';
        this._contextMenuSave.addEventListener("click", (e) => {
            e.stopPropagation();
            this._hideContextMenu();
            this.saveAudio();
        });
        this._contextMenu.addEventListener("mouseleave", () => this._hideContextMenu());
        this._contextMenuSave.addEventListener("mouseenter", () => {
            this._contextMenuSave.style.background = "#3a3a3a";
        });
        this._contextMenuSave.addEventListener("mouseleave", () => {
            this._contextMenuSave.style.background = "";
        });

        this._contextMenu.appendChild(this._contextMenuSave);
        document.body.appendChild(this._contextMenu);

        this._onDocClick = () => this._hideContextMenu();
        this._onDocKeyDown = (e) => { if (e.key === "Escape") this._hideContextMenu(); };
        document.addEventListener("click", this._onDocClick);
        document.addEventListener("keydown", this._onDocKeyDown);
    }

    _showContextMenu(x, y) {
        const menu = this._contextMenu;
        if (!menu) return;
        menu.style.left = x + "px";
        menu.style.top = y + "px";
        menu.style.display = "block";
        // 超出视口则反方向弹出
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + "px";
            if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + "px";
        });
    }

    _hideContextMenu() {
        if (this._contextMenu) this._contextMenu.style.display = "none";
    }

    setAudioUrl(url) {
        if (this._audioUrl === url) return;
        this._audioUrl = url || "";
        this._audio.src = url || "";
        if (url) {
            this._audio.load();
        }
    }

    setFilename(name) {
        this._filename = name || "";
    }

    saveAudio() {
        if (!this._audioUrl || !this._filename) return;
        xzgDownloadAudio(this._audioUrl, this._filename);
    }

    setData(peaks, duration) {
        this.peaks = peaks || [];
        this.duration = duration || 0;
        this.startTime = 0;
        this.endTime = this.duration;
        this.playbackTime = this.duration / 2;
        this.volume = 1.0;
        this._applyVolume(1.0);
        // 同步音频元素的 currentTime 到 playbackTime（播放头位置始终统一）
        if (this.duration > 0 && this._audio && this._audioUrl) {
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
        this._updateTimeDisplay();
        this.onRequestRedraw();
    }

    setRange(startTime, endTime) {
        this.startTime = Math.max(0, startTime || 0);
        this.endTime = Math.min(this.duration, endTime || this.duration);
        if (this.startTime > this.endTime) {
            [this.startTime, this.endTime] = [this.endTime, this.startTime];
        }
        this._updateTimeDisplay();
        this.onRequestRedraw();
    }

    _updateTimeDisplay() {
        this.onRequestRedraw();
    }

    _updatePlayButton() {
        this.onRequestRedraw();
    }

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

    togglePlay() {
        if (!this._audioUrl || this.duration <= 0) return;
        if (this.isPlaying) {
            this._audio.pause();
        } else {
            this._ensureAudioGraph();
            if (this._audioCtx && this._audioCtx.state === 'suspended') {
                this._audioCtx.resume();
            }
            const startTime = this.startTime;
            const endTime = this.endTime;
            // 播放前同步到 playbackTime（始终从当前播放头位置开始播放）
            const targetTime = this.playbackTime || startTime;
            if (targetTime < startTime || targetTime >= endTime - 0.05) {
                this._audio.currentTime = startTime;
                this.playbackTime = startTime;
            } else {
                this._audio.currentTime = targetTime;
            }
            this._audio.play().catch(e => console.warn("[小珠光] 播放失败:", e));
        }
    }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(3.0, v));
        this._applyVolume(this.volume);
        this.onVolumeChange(this.volume);
        this.onRequestRedraw();
    }

    _startPlaybackAnimation() {
        if (this._rafId) return;
        const loop = () => {
            if (!this.isPlaying) return;
            this.playbackTime = this._audio.currentTime;
            if (this._loopPlayback) {
                // 循环模式：到达被裁切区间末尾立即跳回起点
                if (this._audio.currentTime >= this.endTime - 0.02) {
                    this._audio.currentTime = this.startTime;
                    this.playbackTime = this.startTime;
                }
            } else {
                // 单次模式：到达被裁切末端立即停止，不继续播放整个音频
                if (this._audio.currentTime >= this.endTime - 0.02) {
                    this.playbackTime = this.endTime;
                    this._audio.pause();
                    this._updateTimeDisplay();
                    this.onRequestRedraw();
                    return;
                }
            }
            this._updateTimeDisplay();
            this.onRequestRedraw();
            this._rafId = requestAnimationFrame(loop);
        };
        this._rafId = requestAnimationFrame(loop);
    }

    _stopPlaybackAnimation() {
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    // ── 动态 padding：宽度小时缩小留白 ──
    _getPad() {
        return Math.min(this._paddingX, Math.max(2, Math.floor(this._drawW / 8)));
    }

    // ── 时间↔X坐标转换（基于 _drawW，支持裁剪模式） ──
    _getTimeFromX(localX) {
        if (this.duration <= 0) return 0;
        const w = this._drawW;
        const pad = this._getPad();
        const usableW = Math.max(1, w - pad * 2);
        const px = localX - pad;
        const cropDur = this.endTime - this.startTime;
        const isCropMode = this._displayMode === 'crop' && cropDur > 0;
        if (isCropMode) {
            const ratio = Math.max(0, Math.min(1, px / usableW));
            return this.startTime + ratio * cropDur;
        }
        return Math.max(0, Math.min(this.duration, (px / usableW) * this.duration));
    }

    _getXFromTime(t) {
        if (this.duration <= 0) return this._getPad();
        const w = this._drawW;
        const pad = this._getPad();
        const usableW = Math.max(1, w - pad * 2);
        const cropDur = this.endTime - this.startTime;
        const isCropMode = this._displayMode === 'crop' && cropDur > 0;
        if (isCropMode) {
            const ratio = Math.max(0, Math.min(1, (t - this.startTime) / cropDur));
            return pad + ratio * usableW;
        }
        return pad + (t / this.duration) * usableW;
    }

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

    // ── 在节点画布上绘制波形 ──
    drawOnNode(ctx, widgetY, widgetW, widgetH) {
        this._drawY = widgetY;
        this._drawH = widgetH;
        this._drawW = widgetW;

        const w = widgetW;
        const h = widgetH;
        const pad = this._getPad();
        const usableW = Math.max(1, w - pad * 2);

        // 背景
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, widgetY, w, h);

        if (!this.peaks || this.peaks.length === 0) {
            // 空状态提示
            ctx.fillStyle = '#555';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('拖入音频或点击上传', w / 2, widgetY + h / 2);
            return;
        }

        const barPadY = 2;
        const waveH = h - barPadY * 2;
        const waveMid = widgetY + barPadY + waveH / 2;
        const cropDur = this.endTime - this.startTime;
        const isCropMode = this._displayMode === 'crop' && cropDur > 0;

        let startX, endX, playX;
        if (isCropMode) {
            startX = pad;
            endX = w - pad;
            playX = this.playbackTime != null && this.playbackTime >= this.startTime && this.playbackTime <= this.endTime
                ? pad + ((this.playbackTime - this.startTime) / cropDur) * usableW : -1;
        } else {
            startX = this.duration > 0 ? pad + (this.startTime / this.duration) * usableW : pad;
            endX = this.duration > 0 ? pad + (this.endTime / this.duration) * usableW : w - pad;
            playX = this.duration > 0 && this.playbackTime != null && this.playbackTime >= 0
                ? pad + (this.playbackTime / this.duration) * usableW : -1;
        }

        // 波形条
        const volScale = this.volume;
        const numBars = this.peaks.length;
        if (isCropMode) {
            const startIdx = Math.floor((this.startTime / this.duration) * numBars);
            const endIdx = Math.ceil((this.endTime / this.duration) * numBars);
            const cropNumBars = Math.max(1, endIdx - startIdx);
            const barWidth = usableW / cropNumBars;
            for (let i = 0; i < cropNumBars; i++) {
                const peakIdx = startIdx + i;
                if (peakIdx < 0 || peakIdx >= numBars) continue;
                const [minVal, maxVal] = this.peaks[peakIdx];
                const x = pad + i * barWidth;
                const bw = Math.max(1, Math.min(barWidth, w - pad - x));
                if (w - pad - x < 1) continue;
                const grad = ctx.createLinearGradient(0, widgetY + barPadY, 0, widgetY + h - barPadY);
                grad.addColorStop(0, '#307960');
                grad.addColorStop(0.5, '#307960');
                grad.addColorStop(1, '#307960');
                ctx.fillStyle = grad;
                const top = waveMid + minVal * (waveH / 2) * volScale;
                const bottom = waveMid + maxVal * (waveH / 2) * volScale;
                const barTop = Math.max(widgetY + barPadY, top);
                const barBottom = Math.min(widgetY + h - barPadY, bottom);
                ctx.fillRect(x, barTop, bw, Math.max(1, barBottom - barTop));
            }
        } else {
            const barWidth = usableW / numBars;
            for (let i = 0; i < numBars; i++) {
                const [minVal, maxVal] = this.peaks[i];
                const x = pad + i * barWidth;
                const bw = Math.max(1, Math.min(barWidth, w - pad - x));
                if (w - pad - x < 1) continue;
                const inRange = x >= startX && x <= endX;
                if (inRange) {
                    const grad = ctx.createLinearGradient(0, widgetY + barPadY, 0, widgetY + h - barPadY);
                    grad.addColorStop(0, '#307960');
                    grad.addColorStop(0.5, '#307960');
                    grad.addColorStop(1, '#307960');
                    ctx.fillStyle = grad;
                } else {
                    ctx.fillStyle = '#444';
                }
                const top = waveMid + minVal * (waveH / 2) * volScale;
                const bottom = waveMid + maxVal * (waveH / 2) * volScale;
                const barTop = Math.max(widgetY + barPadY, top);
                const barBottom = Math.min(widgetY + h - barPadY, bottom);
                ctx.fillRect(x, barTop, bw, Math.max(1, barBottom - barTop));
            }
            // 未选中区域遮罩
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.fillRect(pad, widgetY + barPadY, startX - pad, waveH);
            ctx.fillRect(endX, widgetY + barPadY, w - pad - endX, waveH);
        }

        // 音量线（仅左侧一小段）
        const volY = this._getVolumeY(widgetY, h);
        const volLineW = 40; // 音量线长度
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

        // 标记线
        if (this.duration > 0) {
            // 起始标记线（红色）
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(startX, widgetY);
            ctx.lineTo(startX, widgetY + h);
            ctx.stroke();
            ctx.fillStyle = '#ef4444';
            ctx.beginPath();
            ctx.moveTo(startX - 4, widgetY);
            ctx.lineTo(startX + 4, widgetY);
            ctx.lineTo(startX, widgetY + 5);
            ctx.closePath();
            ctx.fill();

            // 结束标记线（蓝色）
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(endX, widgetY);
            ctx.lineTo(endX, widgetY + h);
            ctx.stroke();
            ctx.fillStyle = '#3b82f6';
            ctx.beginPath();
            ctx.moveTo(endX - 4, widgetY);
            ctx.lineTo(endX + 4, widgetY);
            ctx.lineTo(endX, widgetY + 5);
            ctx.closePath();
            ctx.fill();

            // 播放进度线（白色，与音频保存一致）
            if (playX >= 0) {
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(playX, widgetY);
                ctx.lineTo(playX, widgetY + h);
                ctx.stroke();
            }
        }

        // 音量显示（左上角）
        const volText = `音量${Math.round(this.volume * 100)}`;
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = '6px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(volText, pad + 2, widgetY + 3);
        // 时间码显示（紧邻音量右侧）
        const fmt = (t) => {
            const m = Math.floor(t / 60);
            const s = Math.floor(t % 60);
            return `${m}:${s.toString().padStart(2, '0')}`;
        };
        const curTime = fmt(this.playbackTime || this.startTime);
        const rangeStr = `${fmt(this.startTime)}-${fmt(this.endTime)}`;
        const timeText = `${curTime} / ${rangeStr}`;
        const volTextW = ctx.measureText(volText).width;
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = '6px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const timeX = pad + 2 + volTextW + 6;
        ctx.fillText(timeText, timeX, widgetY + 3);
        const timeTextW = ctx.measureText(timeText).width;
        // 循环/单次播放图标（时间码后面，高度对齐，暗白色小符号）
        const loopSym = this._loopPlayback ? '⇆' : '→';
        const loopX = timeX + timeTextW + 8;
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '7px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(loopSym, loopX, widgetY + 2);
        const loopW = ctx.measureText(loopSym).width;
        this._loopBtn = { x: loopX - 3, y: widgetY + 1, w: loopW + 6, h: 10 };
        // 小字注释（循环图标右侧）
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '5px sans-serif';
        ctx.fillText('线上拖动跳转 线下播放/暂停', loopX + loopW + 6, widgetY + 4);

        // 显示模式切换按钮（右上角）
        const btnW = 22;
        const btnX = w - pad - btnW - 10;
        const btnY = widgetY + 3;
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = '6px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(isCropMode ? '细节' : '全览', btnX + btnW, btnY);
        this._modeBtn = { x: btnX, y: btnY, w: btnW, h: 14 };

        // 帮助按钮（全览/细节左侧）
        const helpIconW = 12;
        const helpIconX = btnX - helpIconW - 4;
        const helpIconY = widgetY + 3;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('📝', helpIconX + helpIconW / 2, helpIconY - 1);
        this._helpBtn = { x: helpIconX, y: helpIconY, w: helpIconW, h: 14 };
    }

    // ── LiteGraph widget 鼠标事件 ──
    handleMouse(event, localX, localY) {
        if (this.duration <= 0) {
            if (event.type === 'pointerdown' || event.type === 'mousedown') {
                // 右键：弹出保存菜单
                if (event.button === 2 && this._audioUrl) {
                    this._showContextMenu(event.clientX, event.clientY);
                    return true;
                }
                const widgetY = this._drawY;
                const widgetH = this._drawH;
                if (localY >= widgetY && localY <= widgetY + widgetH) {
                    const now = Date.now();
                    const isDoubleClick = (now - this._lastClickTime) < 300;
                    this._lastClickTime = now;
                    if (isDoubleClick) {
                        if (this._clickTimer) {
                            clearTimeout(this._clickTimer);
                            this._clickTimer = null;
                        }
                        this.onUpload();
                    } else {
                        if (this._clickTimer) clearTimeout(this._clickTimer);
                        this._clickTimer = setTimeout(() => {
                            this.onUpload();
                            this._clickTimer = null;
                        }, 250);
                    }
                    return true;
                }
            }
            return false;
        }

        const widgetY = this._drawY;
        const widgetH = this._drawH;

        // 松开鼠标时：即使鼠标在波形区域外，只要正在拖动，也返回true阻止默认行为
        // 实际清理工作由 window 上的 _handleMouseUp 统一处理
        if (event.type === 'pointerup' || event.type === 'mouseup' || event.type === 'pointercancel') {
            if (this.isDragging) {
                return true;
            }
        }

        // 检查鼠标是否在波形区域内
        if (localY < widgetY || localY > widgetY + widgetH) return false;

        if (event.type === 'pointerdown' || event.type === 'mousedown') {
            // 播放头拖动进行中或刚结束(200ms内)：忽略新的按下，防止拖到界面外后误触发播放
            if (this.isDragging || (this._lastPlayheadEnd && Date.now() - this._lastPlayheadEnd < 200)) {
                return true;
            }
            // 右键：弹出保存菜单
            if (event.button === 2) {
                if (this._audioUrl) {
                    this._showContextMenu(event.clientX, event.clientY);
                }
                return true;
            }
            // 检测帮助按钮
            if (this._helpBtn) {
                const btn = this._helpBtn;
                if (localX >= btn.x && localX <= btn.x + btn.w && localY >= btn.y && localY <= btn.y + btn.h) {
                    if (typeof showAudioHelpDialog === 'function') {
                        showAudioHelpDialog();
                    }
                    return true;
                }
            }
            // 检测模式切换按钮
            if (this._modeBtn) {
                const btn = this._modeBtn;
                if (localX >= btn.x && localX <= btn.x + btn.w && localY >= btn.y && localY <= btn.y + btn.h) {
                    this._displayMode = this._displayMode === 'crop' ? 'full' : 'crop';
                    this.onRequestRedraw();
                    return true;
                }
            }
            // 检测循环/单次播放切换按钮
            if (this._loopBtn) {
                const btn = this._loopBtn;
                if (localX >= btn.x && localX <= btn.x + btn.w && localY >= btn.y && localY <= btn.y + btn.h) {
                    this._loopPlayback = !this._loopPlayback;
                    this.onRequestRedraw();
                    return true;
                }
            }

            const now = Date.now();
            const isDoubleClick = (now - this._lastClickTime) < 300;
            this._lastClickTime = now;

            const startX = this._getXFromTime(this.startTime);
            const endX = this._getXFromTime(this.endTime);
            const playX = this._getXFromTime(this.playbackTime || 0);

            const volY = this._getVolumeY(widgetY, widgetH);
            const barPadY = 2;
            const waveH = widgetH - barPadY * 2;
            const waveMid = widgetY + barPadY + waveH / 3; // 上1/3处作为分区界限，以上=拖动跳转，以下=播放/暂停

            const handleWidth = 14;
            const volHandleHeight = 5;
            const volLineW = 40; // 音量线长度
            const w = this._drawW;
            const pad = this._getPad();
            let hitHandle = false;
            let isUpperHalf = localY < waveMid; // 是否在分区线上方

            // 优先判断音量线（仅左侧一小段范围）
            const volLineLeft = pad;
            const volLineRight = pad + volLineW;
            if (Math.abs(localY - volY) <= volHandleHeight && localX >= volLineLeft && localX <= volLineRight) {
                this.dragType = 'volume';
                hitHandle = true;
            }
            // 然后判断蓝色（结束）标记（全高度范围可拖）
            else if (Math.abs(localX - endX) <= handleWidth) {
                this.dragType = 'end';
                hitHandle = true;
            } else if (Math.abs(localX - startX) <= handleWidth) {
                this.dragType = 'start';
                hitHandle = true;
            } else if (isUpperHalf) {
                // 上半区：拖动播放头模式
                this.dragType = 'playhead';
                hitHandle = true;
            } else {
                // 下半区：双击上传文件，单击立即播放/暂停（按下即响应，无延迟）
                // 不进入拖动模式，允许节点正常拖动
                if (isDoubleClick) {
                    if (this._clickTimer) {
                        clearTimeout(this._clickTimer);
                        this._clickTimer = null;
                    }
                    this.onUpload();
                    return true;
                }
                // 立即切换播放/暂停（按下即响应）
                this.togglePlay();
                // 返回 false：不拦截事件，允许节点拖动
                return false;
            }

            // 双击处理（下半区、音量、start/end标记）
            if (isDoubleClick) {
                if (this._clickTimer) {
                    clearTimeout(this._clickTimer);
                    this._clickTimer = null;
                }
                // 双击音量线：重置到 100% 音量
                if (this.dragType === 'volume') {
                    this.setVolume(1.0);
                } else {
                    // 双击其他区域：上传文件
                    this.onUpload();
                }
                return true;
            }

            this.isDragging = true;
            this._dragMoved = false;
            this._dragDirection = null;
            this.dragStartX = event.clientX;
            this.dragStartY = event.clientY;
            this.dragStartTime = this.startTime;
            this.dragEndTime = this.endTime;
            this.dragStartVolume = this.volume;
            this.dragStartVolY = this._getVolumeY(widgetY, widgetH);
            this.dragPlayheadTime = this.playbackTime || 0;
            this._hitPlayheadHandle = hitHandle;
            if (this.dragType === 'playhead') {
                // 上半区按下瞬间立即将播放头跳到点击位置
                this.dragPlayheadX = localX;
                let t = this._getTimeFromX(localX);
                t = Math.max(this.startTime, Math.min(this.endTime, t));
                t = Math.round(t * 100) / 100;
                this.playbackTime = t;
                try {
                    this._audio.currentTime = t;
                } catch (e) {
                    // 音频未加载完成时设置可能失败，忽略
                }
                this._updateTimeDisplay();
                this.onRequestRedraw();
            }

            // 下半区拖动始终不改变播放状态（仅调整播放头位置）
            return true;
        }

        // 松开鼠标时：由 window 上的 _handleMouseUp 统一处理清理和点击/拖动判定
        // 这里只返回 true 表示事件已被处理，阻止节点被拖动等默认行为
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

        const cv = app.canvas;
        const scale = cv?.ds?.scale || 1;

        // 检测是否超过拖动阈值（用于区分点击和拖动）
        if (!this._dragMoved) {
            const dx = e.clientX - this.dragStartX;
            const dy = e.clientY - this.dragStartY;
            if (Math.sqrt(dx * dx + dy * dy) > this._dragThreshold) {
                this._dragMoved = true;
            }
        }

        // 音量拖动（垂直方向）
        if (this.dragType === 'volume') {
            if (!this._dragMoved) return;
            const widgetY = this._drawY;
            const widgetH = this._drawH;
            const dy = (e.clientY - this.dragStartY) / scale;
            const currentY = this.dragStartVolY + dy;
            let newVol = this._getVolumeFromY(currentY, widgetY, widgetH);
            newVol = Math.round(newVol * 100) / 100;
            this.setVolume(newVol);
            return;
        }

        // 起始/结束标记拖动需要超过阈值才响应
        if ((this.dragType === 'start' || this.dragType === 'end') && !this._dragMoved) {
            return;
        }

        // 上半区播放头拖动：播放头立即跟随鼠标
        if (this.dragType === 'playhead') {
            // 将屏幕坐标转换为widget本地坐标，需要考虑画布缩放
            // 由于无法直接获取鼠标在widget中的本地X坐标，使用增量方式计算
            // dragPlayheadX是按下时的本地X，加上鼠标位移（除以缩放比）得到当前本地X
            const dx = (e.clientX - this.dragStartX) / scale;
            const newX = this.dragPlayheadX + dx;
            let t = this._getTimeFromX(newX);
            t = Math.max(this.startTime, Math.min(this.endTime, t));
            t = Math.round(t * 100) / 100;
            this.playbackTime = t;
            try {
                this._audio.currentTime = t;
            } catch (e) {
                // 音频未加载完成时设置可能失败，忽略
            }
            this._updateTimeDisplay();
            this.onRequestRedraw();
            return;
        }

        const w = this._drawW;
        const pad = this._getPad();
        const usableW = Math.max(1, w - pad * 2);

        // 增量方式：dx 是屏幕像素，需要除以画布缩放比得到 widget 逻辑像素增量
        const dx = (e.clientX - this.dragStartX) / scale;
        const dt = (dx / usableW) * this.duration;

        if (this.dragType === 'start') {
            this.startTime = Math.max(0, Math.min(this.endTime - 0.01, this.dragStartTime + dt));
            this.startTime = Math.round(this.startTime * 100) / 100;
        } else if (this.dragType === 'end') {
            this.endTime = Math.min(this.duration, Math.max(this.startTime + 0.01, this.dragEndTime + dt));
            this.endTime = Math.round(this.endTime * 100) / 100;
        }

        this._updateTimeDisplay();
        this.onRequestRedraw();
    }

    _handleMouseUp(e) {
        if (!this.isDragging) return;
        this.isDragging = false;
        const wasDragging = this.dragType;
        this.dragType = null;
        this._dragMoved = false;
        this._dragDirection = null;
        this._hitPlayheadHandle = false;
        if (this._clickTimer) {
            clearTimeout(this._clickTimer);
            this._clickTimer = null;
        }
        // 上半区（playhead）和音量拖动：无论是否拖动，都不改变播放状态
        // 松开时统一通知一次（仅针对范围调整）
        if (wasDragging === 'playhead') {
            this._lastPlayheadEnd = Date.now();
        }
        if (wasDragging === 'start' || wasDragging === 'end') {
            this._notifyChange();
        }
    }

    _notifyChange() {
        if (this.onRangeChange) {
            this.onRangeChange(this.startTime, this.endTime);
        }
    }

    destroy() {
        this._stopPlaybackAnimation();
        window.removeEventListener("mousemove", this._onMouseMove);
        window.removeEventListener("mouseup", this._onMouseUp);
        window.removeEventListener("pointermove", this._onMouseMove);
        window.removeEventListener("pointerup", this._onMouseUp);
        window.removeEventListener("pointercancel", this._onMouseUp);
        // 清理右键菜单
        document.removeEventListener("click", this._onDocClick);
        document.removeEventListener("keydown", this._onDocKeyDown);
        if (this._contextMenu) {
            this._contextMenu.remove();
            this._contextMenu = null;
        }
        this._contextMenuSave = null;
        if (this._audio) {
            this._audio.pause();
            this._audio.src = "";
            this._audio.remove();
        }
        if (this._audioCtx) {
            try { this._audioCtx.close(); } catch (e) {}
            this._audioCtx = null;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════════════
function isAudioFilename(name) {
    if (!name) return false;
    const ext = name.split(".").pop().toLowerCase();
    return AUDIO_EXTS.includes(ext);
}

function getAudioUrl(filename) {
    if (!filename) return "";
    let name = filename;
    let type = "input";
    const suffixes = [" [output]", " [input]", " [temp]"];
    for (const s of suffixes) {
        if (name.endsWith(s)) {
            type = s.trim().slice(1, -1);
            name = name.slice(0, -s.length);
            break;
        }
    }
    const params = new URLSearchParams({ filename: name, type });
    return `/view?${params.toString()}&rand=${Math.random()}`;
}

async function uploadAudioFiles(files) {
    const uploaded = [];
    for (const file of files) {
        try {
            const body = new FormData();
            body.append("image", file);
            body.append("overwrite", "true");
            body.append("type", "input");
            const resp = await api.fetchApi("/upload/image", { method: "POST", body });
            if (resp.status === 200) {
                const data = await resp.json();
                if (data && data.name) {
                    uploaded.push(data.name);
                }
            }
        } catch (e) {
            console.warn("[小珠光] 音频上传失败:", e);
        }
    }
    return uploaded;
}

async function refreshAudioCombo(audioWidget, selectName) {
    try {
        const resp = await api.fetchApi("/object_info/XiaozhuguangAudioLoader");
        if (!resp.ok) return;
        const info = await resp.json();
        const list = info?.XiaozhuguangAudioLoader?.input?.required?.["音频"]?.[0];
        if (Array.isArray(list)) {
            audioWidget.options.values = list;
            if (selectName && list.includes(selectName)) {
                audioWidget.value = selectName;
            } else if (list.length > 0) {
                audioWidget.value = list[list.length - 1];
            }
            audioWidget.callback?.(audioWidget.value);
        }
    } catch (_) {}
}

async function fetchWaveformData(filename) {
    try {
        const resp = await api.fetchApi(`/xzg/audio_waveform?filename=${encodeURIComponent(filename)}`);
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        console.warn("[小珠光] 获取波形数据失败:", e);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 使用说明弹窗
// ═══════════════════════════════════════════════════════════════════════
function showAudioHelpDialog() {
    const existing = document.querySelector(".xzg-audio-help-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "xzg-audio-help-overlay";
    overlay.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999; font-family: sans-serif;
    `;

    const dialog = document.createElement("div");
    dialog.style.cssText = `
        background: var(--comfy-menu-bg, #1e1e1e); color: #ddd;
        border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        width: 420px; max-width: 90vw; max-height: 80vh;
        display: flex; flex-direction: column;
        border: 1px solid rgba(255,255,255,0.1);
    `;

    dialog.innerHTML = `
        <div style="padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center;">
            <div style="font-size: 14px; font-weight: bold; color: #FFD700;">小珠光音频加载器 · 使用说明</div>
            <button class="xzg-audio-help-close" style="background:none; border:none; color:#999; font-size:18px; cursor:pointer; padding:0 4px;">×</button>
        </div>
        <div style="padding: 14px 18px; overflow-y: auto; font-size: 12px; line-height: 1.6;">
            <div style="margin-bottom: 12px;">
                <div style="font-weight: bold; color: #FFD700; margin-bottom: 4px;">📁 添加音频</div>
                <ul style="margin: 0; padding-left: 18px;">
                    <li>点击"上传音频"按钮选择文件</li>
                    <li>双击波形区域上传</li>
                    <li>直接拖拽音频文件到波形区域</li>
                </ul>
            </div>
            <div style="margin-bottom: 12px;">
                <div style="font-weight: bold; color: #FFD700; margin-bottom: 4px;">▶️ 播放控制</div>
                <ul style="margin: 0; padding-left: 18px;">
                    <li>音轨上 1/3 处有半透明白色虚线分界</li>
                    <li>分界线上方（上 1/3）：点击跳转、拖动调整播放头</li>
                    <li>分界线下方（下 2/3）：单击播放 / 暂停</li>
                    <li>循环/单次：时间码右侧小符号 ⇆ / → 点击切换</li>
                </ul>
            </div>
            <div style="margin-bottom: 12px;">
                <div style="font-weight: bold; color: #FFD700; margin-bottom: 4px;">🔴🔵 截取范围</div>
                <ul style="margin: 0; padding-left: 18px;">
                    <li>红色线：起始时间（可拖动）</li>
                    <li>蓝色线：结束时间（可拖动）</li>
                    <li>选中区域：绿色波形（有效片段）</li>
                    <li>未选中区域：灰色波形 + 半透明遮罩</li>
                </ul>
            </div>
            <div style="margin-bottom: 12px;">
                <div style="font-weight: bold; color: #FFD700; margin-bottom: 4px;">🔊 音量调节</div>
                <ul style="margin: 0; padding-left: 18px;">
                    <li>白色横线：当前音量线，可上下拖动</li>
                    <li>音量范围：0% ~ 300%</li>
                    <li>波形高度随音量变化，直观反映增益大小</li>
                    <li>双击音量线：重置到 100%</li>
                    <li>100% 以下为正常音量，100% 以上为增益放大</li>
                </ul>
            </div>
            <div style="margin-bottom: 12px;">
                <div style="font-weight: bold; color: #FFD700; margin-bottom: 4px;">👁️ 显示模式</div>
                <ul style="margin: 0; padding-left: 18px;">
                    <li>全览：显示完整音频，截取部分高亮</li>
                    <li>细节：仅显示截取区间，铺满整个波形区</li>
                    <li>点击右上角"全览/细节"文字切换</li>
                </ul>
            </div>
            <div>
                <div style="font-weight: bold; color: #FFD700; margin-bottom: 4px;">💡 小提示</div>
                <ul style="margin: 0; padding-left: 18px;">
                    <li>时长设为 0 表示使用全部音频时长</li>
                    <li>拖动节点右下角可调整波形高度（40~120px）</li>
                    <li>右键波形区域弹出保存菜单，可保存音频到本地</li>
                    <li>支持格式：mp3, wav, ogg, flac, aac, m4a 等</li>
                </ul>
            </div>
        </div>
        <div style="padding: 12px 18px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: flex-end;">
            <button class="xzg-audio-help-ok" style="padding: 6px 16px; background: #FFD700; color: #333; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold;">知道了</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
    };

    dialog.querySelector(".xzg-audio-help-close").addEventListener("click", close);
    dialog.querySelector(".xzg-audio-help-ok").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close();
    });

    const onKey = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    };
    document.addEventListener("keydown", onKey, true);

    dialog.addEventListener("mousedown", (e) => e.stopPropagation());
    dialog.addEventListener("pointerdown", (e) => e.stopPropagation());
    dialog.addEventListener("click", (e) => e.stopPropagation());
}

function bindAudioLoaderInteractions(node) {
    node.resizable = true;
    node.minWidth = 320;
    node.minHeight = 110;
    node.maxHeight = 190;

    const origSetSize = node.setSize;
    node.setSize = function(size) {
        size[0] = Math.max(size[0], this.minWidth || 320);
        size[1] = Math.max(size[1], this.minHeight || 110);
        size[1] = Math.min(size[1], this.maxHeight || 190);
        return origSetSize?.apply(this, arguments);
    };
    node.setSize([320, 110]);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = false;
    fileInput.accept = AUDIO_EXTS.map(e => "." + e).join(",");
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    const triggerUpload = () => {
        app.canvas.node_widget = null;
        fileInput.value = "";
        fileInput.click();
    };

    // 上传音频按钮（放在最上面）
    const uploadBtn = node.addWidget("button", "上传音频", "upload", triggerUpload);
    uploadBtn.options.serialize = false;

    // 创建波形查看器（HTML 控件 + 音频播放）
    const waveformViewer = new XiaozhuguangWaveformViewer({
        node: node,
        onRangeChange: (start, end) => {
            const startWidget = node.widgets?.find(w => w.name === "起始时间(秒)");
            const durWidget = node.widgets?.find(w => w.name === "时长(秒)");
            if (startWidget) {
                startWidget.value = Math.round(start * 100) / 100;
                startWidget.callback?.(startWidget.value);
            }
            if (durWidget) {
                durWidget.value = Math.round((end - start) * 100) / 100;
                durWidget.callback?.(durWidget.value);
            }
        },
        onVolumeChange: (vol) => {
            const volWidget = node.widgets?.find(w => w.name === "音量");
            if (volWidget) {
                volWidget.value = Math.round(vol * 100) / 100;
                volWidget.callback?.(volWidget.value);
            }
        },
        onRequestRedraw: () => node.setDirtyCanvas?.(true, true),
        onUpload: triggerUpload,
    });
    node._xzgWaveformViewer = waveformViewer;

    // 波形 canvas widget（直接在节点画布上绘制，宽度 = 节点宽度）
    const waveformWidget = {
        name: AUDIO_WAVEFORM_WIDGET_NAME,
        type: "custom",
        value: "",
        options: { serialize: false },
        _xzgDrawW: 0,
        draw: function(ctx, node, width, y, H) {
            this._xzgDrawW = width;
            const actualH = node.size[1] - y - 8;
            const h = Math.max(AUDIO_WAVEFORM_MIN_H, Math.min(AUDIO_WAVEFORM_MAX_H, actualH));
            waveformViewer.drawOnNode(ctx, y, width, h);
        },
        mouse: function(event, [x, y], node) {
            return waveformViewer.handleMouse(event, x, y);
        },
        computeSize: function(width) {
            return [width, AUDIO_WAVEFORM_MIN_H];
        },
        computeLayoutSize: function(width) {
            return { minHeight: AUDIO_WAVEFORM_MIN_H, minWidth: 0 };
        },
    };
    node.widgets.push(waveformWidget);

    // 拖放支持：在画布上接收拖入，判断是否拖到本节点
    const canvasEl = app.canvas?.canvas;
    if (canvasEl && !canvasEl._xzgAudioDragDrop) {
        canvasEl._xzgAudioDragDrop = true;
        canvasEl.addEventListener('dragover', (e) => {
            const nd = app.canvas.getNodeAtPos(e.offsetX, e.offsetY);
            if (nd?._xzgWaveformViewer) {
                e.preventDefault();
                e.stopPropagation();
            }
        });
        canvasEl.addEventListener('drop', (e) => {
            const nd = app.canvas.getNodeAtPos(e.offsetX, e.offsetY);
            if (!nd?._xzgWaveformViewer) return;
            e.preventDefault();
            e.stopPropagation();
            const files = Array.from(e.dataTransfer?.files || []).filter(f => isAudioFilename(f.name));
            if (files.length === 0) return;
            const dt = new DataTransfer();
            files.forEach(f => dt.items.add(f));
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    async function loadWaveformForFile(filename) {
        if (!filename) {
            waveformViewer.setData([], 0);
            waveformViewer.setAudioUrl("");
            waveformViewer.setFilename("");
            return;
        }
        const data = await fetchWaveformData(filename);
        const audioUrl = getAudioUrl(filename);
        waveformViewer.setAudioUrl(audioUrl);
        // 提取纯文件名（去掉 [output]/[input]/[temp] 后缀）
        let pureName = filename;
        const suffixes = [" [output]", " [input]", " [temp]"];
        for (const s of suffixes) {
            if (pureName.endsWith(s)) {
                pureName = pureName.slice(0, -s.length);
                break;
            }
        }
        waveformViewer.setFilename(pureName);
        if (data) {
            waveformViewer.setData(data.peaks, data.duration);
            _syncWidgetsFromViewer();
        }
    }

    const _syncWidgetsFromViewer = () => {
        const startWidget = node.widgets?.find(w => w.name === "起始时间(秒)");
        const durWidget = node.widgets?.find(w => w.name === "时长(秒)");
        const volWidget = node.widgets?.find(w => w.name === "音量");
        const duration = waveformViewer.duration || 0;
        if (startWidget && duration > 0) {
            startWidget.value = 0;
            startWidget._xzgMax = duration - 0.01;
            startWidget.callback?.(startWidget.value);
        }
        if (durWidget && duration > 0) {
            durWidget.value = 0;
            durWidget._xzgMax = duration;
            durWidget.callback?.(durWidget.value);
        }
        if (volWidget) {
            volWidget.value = 1.0;
            volWidget.callback?.(volWidget.value);
        }
    };

    const syncRangeFromWidgets = () => {
        const startWidget = node.widgets?.find(w => w.name === "起始时间(秒)");
        const durWidget = node.widgets?.find(w => w.name === "时长(秒)");
        const startVal = startWidget?.value || 0;
        const durVal = durWidget?.value || 0;
        const duration = waveformViewer.duration || 0;

        const clampedStart = Math.max(0, Math.min(duration > 0 ? duration - 0.01 : Infinity, startVal));
        if (startWidget && clampedStart !== startVal) {
            startWidget.value = Math.round(clampedStart * 100) / 100;
        }

        const maxDur = duration > 0 ? duration - clampedStart : Infinity;
        // 时长为0代表最大时长（等于音频总时长 - 起始时间）
        const clampedDur = durVal === 0 ? maxDur : Math.max(0.01, Math.min(maxDur, durVal || 0));
        if (durWidget && clampedDur !== durVal && durVal !== 0) {
            durWidget.value = Math.round(clampedDur * 100) / 100;
        }

        if (startWidget && duration > 0) {
            startWidget._xzgMax = duration - 0.01;
        }
        if (durWidget && duration > 0) {
            durWidget._xzgMax = duration - clampedStart;
        }

        const endVal = clampedDur > 0 ? Math.min(duration, clampedStart + clampedDur) : duration;
        waveformViewer.setRange(clampedStart, endVal);
    };

    const syncVolumeFromWidget = () => {
        const volWidget = node.widgets?.find(w => w.name === "音量");
        if (volWidget) {
            const vol = Math.max(0, Math.min(3.0, volWidget.value || 0));
            waveformViewer.setVolume(vol);
        }
    };

    // 节点尺寸变化时触发重绘（波形高度由 draw 内 node.size[1]-y 实时计算）
    const origOnResize = node.onResize;
    node.onResize = function (size) {
        const r = origOnResize?.apply(this, arguments);
        this.setDirtyCanvas?.(true, true);
        return r;
    };

    // 拦截波形区域的鼠标事件，防止拖动下半部分时节点被移动
    const origOnMouseDown = node.onMouseDown;
    node.onMouseDown = function (e, localPos, canvas) {
        const [lx, ly] = localPos;
        const wy = waveformViewer._drawY;
        const wh = waveformViewer._drawH;
        if (wy > 0 && wh > 0 && ly >= wy && ly <= wy + wh) {
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
        if (wy > 0 && wh > 0 && ly >= wy && ly <= wy + wh) {
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
        if (wy > 0 && wh > 0 && ly >= wy && ly <= wy + wh) {
            const result = waveformViewer.handleMouse(e, lx, ly);
            if (result) return true;
        }
        return origOnMouseUp?.apply(this, arguments);
    };

    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        waveformViewer.destroy();
        fileInput.remove();
        return origOnRemoved?.apply(this, arguments);
    };

    const origOnConfigure = node.onConfigure;
    node.onConfigure = function (info) {
        origOnConfigure?.apply(this, arguments);
        requestAnimationFrame(() => {
            _applyAudioWidgetStyles(node);
            syncVolumeFromWidget();
            const w = node.widgets?.find(w => w.name === "音频");
            if (w && w.value) {
                loadWaveformForFile(w.value);
            }
        });
    };

    const origOnExecuted = node.onExecuted;
    node.onExecuted = function (output) {
        origOnExecuted?.apply(this, arguments);
        if (!output) return;
        let audioInfo = null;
        if (output.ui?.audio_info && Array.isArray(output.ui.audio_info)) {
            audioInfo = output.ui.audio_info[0];
        }
        if (audioInfo && audioInfo.full_peaks) {
            waveformViewer.peaks = audioInfo.full_peaks;
            waveformViewer.duration = audioInfo.total_duration;
            const start = audioInfo.start_time || 0;
            const end = start + (audioInfo.duration || audioInfo.actual_duration || audioInfo.total_duration);
            waveformViewer.setRange(start, end);
        }
    };

    fileInput.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []).filter(f => isAudioFilename(f.name));
        if (files.length === 0) return;
        const uploaded = await uploadAudioFiles(files);
        if (uploaded.length > 0) {
            const audioWidget = node.widgets?.find(w => w.name === "音频");
            if (audioWidget) {
                await refreshAudioCombo(audioWidget, uploaded[0]);
                loadWaveformForFile(audioWidget.value);
            }
        }
        fileInput.value = "";
        node.setDirtyCanvas?.(true, true);
    });

    const origProcessDrop = node.processDrop;
    node.processDrop = function (e) {
        const files = Array.from(e.dataTransfer?.files || []).filter(f => isAudioFilename(f.name));
        if (files.length > 0) {
            e.preventDefault?.();
            e.stopPropagation?.();
            const dt = new DataTransfer();
            files.forEach(f => dt.items.add(f));
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }
        return origProcessDrop?.apply(this, arguments);
    };

    requestAnimationFrame(() => {
        // 初始化时触发一次 resize 计算波形高度
        node.onResize?.(node.size);

        const audioWidget = node.widgets?.find(w => w.name === "音频");
        if (audioWidget) {
            const origCb = audioWidget.callback;
            audioWidget.callback = function (value) {
                origCb?.apply(this, arguments);
                loadWaveformForFile(value);
            };
            if (audioWidget.value) {
                loadWaveformForFile(audioWidget.value);
            }
        }

        const startWidget = node.widgets?.find(w => w.name === "起始时间(秒)");
        const durWidget = node.widgets?.find(w => w.name === "时长(秒)");

        if (startWidget) {
            const origCb = startWidget.callback;
            startWidget.callback = function (value) {
                origCb?.apply(this, arguments);
                syncRangeFromWidgets();
            };
        }
        if (durWidget) {
            const origCb = durWidget.callback;
            durWidget.callback = function (value) {
                origCb?.apply(this, arguments);
                syncRangeFromWidgets();
            };
        }

        syncRangeFromWidgets();
    });
}

function _applyAudioWidgetStyles(node) {
    for (const w of node.widgets || []) {
        if (w.name === AUDIO_WAVEFORM_WIDGET_NAME) continue;
        if (w.name === '音频') {
            w.draw = _xzgDrawComboWidget;
        } else if (w.name === '上传音频') {
            w.draw = _xzgDrawButtonWidget;
        } else if (w.name === '起始时间(秒)') {
            w._xzgValueColor = '#FF4444';
            w._xzgStep = 0.01;
            // 隐藏该 widget（由波形区拖动代替），但保留 value 用于后端传参
            w.hidden = true;
            w.computeSize = () => [0, 0];
        } else if (w.name === '时长(秒)') {
            w._xzgValueColor = '#6699FF';
            w._xzgStep = 0.01;
            w.hidden = true;
            w.computeSize = () => [0, 0];
        } else if (w.name === '音量') {
            w._xzgValueColor = '#ffffff';
            w._xzgStep = 0.01;
            w._xzgMin = 0;
            w._xzgMax = 3.0;
            w.hidden = true;
            w.computeSize = () => [0, 0];
        }
    }
}

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

// Hook contextmenu + processMouseDown：右键点击波形区域时拦截，阻止弹出原生节点菜单
function _xzgPatchProcessMouseDown(retryCount = 0) {
    const canvasEl = app.canvas?.canvas;
    if (!canvasEl) {
        if (retryCount < 30) {
            setTimeout(() => _xzgPatchProcessMouseDown(retryCount + 1), 100);
        }
        return;
    }

    // 防止重复安装
    if (window._xzgAudioCtxMenuPatched) return;
    window._xzgAudioCtxMenuPatched = true;

    // 1. window 捕获阶段拦截 contextmenu：优先级最高，确保在任何其他监听器之前执行
    window.addEventListener('contextmenu', (e) => {
        // 只处理 canvas 上的右键
        const target = e.target;
        if (target !== canvasEl && !canvasEl.contains?.(target)) return;

        const canvas = app.canvas;
        const rect = canvasEl.getBoundingClientRect();

        // 转换为画布坐标
        let x, y;
        if (canvas.convertEventToCanvasCoordinates) {
            try {
                const p = canvas.convertEventToCanvasCoordinates(e);
                if (p) { x = p[0]; y = p[1]; }
            } catch (_) {}
        }
        if (x === undefined || y === undefined) {
            x = (e.clientX - rect.left) / canvas.ds.scale - canvas.ds.offset[0];
            y = (e.clientY - rect.top) / canvas.ds.scale - canvas.ds.offset[1];
        }

        // 找到点击的节点
        let nd = null;
        if (canvas.getNodeAtPosition) {
            nd = canvas.getNodeAtPosition(x, y);
        } else if (canvas.getNodeAtPos) {
            nd = canvas.getNodeAtPos(x, y);
        } else if (canvas.graph?.getNodeOnPos) {
            nd = canvas.graph.getNodeOnPos(x, y);
        }

        if (nd?._xzgWaveformViewer) {
            const viewer = nd._xzgWaveformViewer;
            const wy = viewer._drawY;
            const wh = viewer._drawH;
            const nodeLocalY = y - nd.pos[1];
            if (wy > 0 && wh > 0 && nodeLocalY >= wy && nodeLocalY <= wy + wh) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (viewer._audioUrl) {
                    viewer._showContextMenu(e.clientX, e.clientY);
                }
                return false;
            }
        }
    }, true);

    // 2. hook processMouseDown：右键波形区域时直接弹出保存菜单，阻止原生菜单
    let LGraphCanvas = null;
    try {
        if (typeof LGraphCanvas !== 'undefined' && LGraphCanvas?.prototype) {
            LGraphCanvas = LGraphCanvas;
        }
    } catch (_) {}
    if (!LGraphCanvas) LGraphCanvas = window.LGraphCanvas || null;
    if (!LGraphCanvas && window.LiteGraph?.LGraphCanvas) LGraphCanvas = window.LiteGraph.LGraphCanvas;
    if (!LGraphCanvas && app.canvas?.constructor) LGraphCanvas = app.canvas.constructor;

    if (LGraphCanvas?.prototype?.processMouseDown && !LGraphCanvas.prototype._xzgAudioPatched) {
        LGraphCanvas.prototype._xzgAudioPatched = true;
        console.log("[小珠光] 音频加载器：processMouseDown hook 已安装");
        const origProcessMouseDown = LGraphCanvas.prototype.processMouseDown;
        LGraphCanvas.prototype.processMouseDown = function (e) {
            if (e.button === 2) {
                const cx = e.canvasX ?? e.x ?? 0;
                const cy = e.canvasY ?? e.y ?? 0;
                let nd = null;
                if (this.getNodeAtPosition) nd = this.getNodeAtPosition(cx, cy);
                else if (this.getNodeAtPos) nd = this.getNodeAtPos(cx, cy);
                else if (this.graph?.getNodeOnPos) nd = this.graph.getNodeOnPos(cx, cy);

                if (nd?._xzgWaveformViewer) {
                    const viewer = nd._xzgWaveformViewer;
                    const wy = viewer._drawY;
                    const wh = viewer._drawH;
                    const localY = cy - nd.pos[1];
                    if (wy > 0 && wh > 0 && localY >= wy && localY <= wy + wh) {
                        e.preventDefault?.();
                        e.stopPropagation?.();
                        // 直接弹出保存菜单
                        if (viewer._audioUrl) {
                            viewer._showContextMenu(e.clientX, e.clientY);
                        }
                        return true;
                    }
                }
            }
            return origProcessMouseDown.apply(this, arguments);
        };
    } else {
        console.warn("[小珠光] 音频加载器：无法找到 LGraphCanvas.prototype.processMouseDown，hook 失败");
    }

    // 3. hook processContextMenu：新版 LiteGraph 通过此方法显示右键菜单
    if (LGraphCanvas?.prototype?.processContextMenu && !LGraphCanvas.prototype._xzgAudioCtxPatched) {
        LGraphCanvas.prototype._xzgAudioCtxPatched = true;
        console.log("[小珠光] 音频加载器：processContextMenu hook 已安装");
        const origProcessContextMenu = LGraphCanvas.prototype.processContextMenu;
        LGraphCanvas.prototype.processContextMenu = function (node, e) {
            // 如果点击的是音频加载器节点的波形区域，拦截并显示自定义菜单
            if (node?._xzgWaveformViewer) {
                const viewer = node._xzgWaveformViewer;
                const wy = viewer._drawY;
                const wh = viewer._drawH;
                const cx = e?.canvasX ?? e?.x ?? 0;
                const cy = e?.canvasY ?? e?.y ?? 0;
                const localY = cy - node.pos[1];
                if (wy > 0 && wh > 0 && localY >= wy && localY <= wy + wh) {
                    if (viewer._audioUrl) {
                        viewer._showContextMenu(e?.clientX ?? 0, e?.clientY ?? 0);
                        return; // 阻止原生菜单
                    }
                    // 非音频加载器节点（如音频保存节点）：不拦截，交给其他 hook 处理
                }
            }
            return origProcessContextMenu.apply(this, arguments);
        };
    }
}

app.registerExtension({
    name: "xiaozhuguang.audio_loader",
    setup() {
        // canvas 就绪后安装 processMouseDown hook
        _xzgPatchProcessMouseDown();
    },
    getCustomWidgets() {
        return {
            XZGFLOAT: (node, name, data) => {
                const opts = data[1] || {};
                const w = {
                    name: name,
                    type: 'xzg-float',
                    value: opts.default ?? 0,
                    options: {},
                    _xzgStep: opts.step || 0.01,
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
            },
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "XiaozhuguangAudioLoader") {
            for (const inp of Object.values({ ...nodeData.input?.required, ...nodeData.input?.optional })) {
                if (["FLOAT"].includes(inp[0]) && inp[1]) {
                    inp[1].widgetType ??= "XZGFLOAT";
                }
            }
            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = origOnNodeCreated?.apply(this, arguments);
                bindAudioLoaderInteractions(this);
                _xzgPatchCanvasPrompt();
                _applyAudioWidgetStyles(this);
                return r;
            };
        }
    },
});
