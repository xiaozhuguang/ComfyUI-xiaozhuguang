/**
 * 小珠光视频编辑器 - Canvas 帧解码器
 * 基于 mediabunny 库，用 WebCodecs API 直接解码视频帧到 canvas
 * 绕过 <video> 标签限制，实现精确按时间戳解码、帧缓存、最近帧降级
 *
 * 核心优势（对比 <video>）：
 *   - seek 无需等 keyframe，精确到任意时间点
 *   - 帧缓存命中零延迟 drawImage
 *   - 最近帧降级显示，拖动永不卡顿
 *
 * 依赖：mediabunny.min.mjs（需在 HTML 中先加载）
 * 全局变量：window.mb（mediabunny 模块）
 */
import { api } from "../../scripts/api.js";

// ═══════════════════════════════════════════════════════════════════════════
// 帧缓存（LRU 策略，保留目标帧附近的帧）
// ═══════════════════════════════════════════════════════════════════════════
const MAX_CACHE_SIZE = 120;

class FrameCache {
    constructor(maxSize = MAX_CACHE_SIZE) {
        this._map = new Map();
        this._maxSize = maxSize;
        this._targetFrame = 0;
    }

    set targetFrame(f) { this._targetFrame = f; }

    has(frameNum) { return this._map.has(frameNum); }
    get(frameNum) { return this._map.get(frameNum); }
    get size() { return this._map.size; }

    // 查找距离 target 最近的已缓存帧
    findClosest(target) {
        let best = -1, bestDist = Infinity;
        for (const key of this._map.keys()) {
            const dist = Math.abs(target - key);
            if (dist < bestDist) { bestDist = dist; best = key; }
        }
        return best;
    }

    // 添加帧到缓存（LRU：满则删除距离 targetFrame 最远的帧）
    add(frameNum, canvas) {
        if (this._map.size >= this._maxSize) {
            let oldestKey = null, oldestDist = -1;
            for (const key of this._map.keys()) {
                const dist = Math.abs(key - this._targetFrame);
                if (dist > oldestDist) { oldestDist = dist; oldestKey = key; }
            }
            if (oldestKey !== null) this._map.delete(oldestKey);
        }
        // 复制 canvas（避免 mediabunny 内部回收）
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        copy.getContext('2d').drawImage(canvas, 0, 0);
        this._map.set(frameNum, copy);
    }

    clear() { this._map.clear(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// 单个视频的帧解码器
// ═══════════════════════════════════════════════════════════════════════════
class VideoDecoderInstance {
    constructor() {
        this._input = null;
        this._track = null;
        this._canvasSink = null;
        this._previewSink = null;
        this._audioTrack = null;
        this._audioBufferSink = null;
        this._audioSampleRate = 0;
        this._audioChannels = 0;
        this._duration = 0;
        this._width = 0;
        this._height = 0;
        this._fps = 30;
        this._frameCount = 0;
        this._previewWidth = 0;
        this._previewHeight = 0;
        this._blobUrl = null;
        this._fileBlob = null;
        this._cache = new FrameCache();
        this._isDecoding = false;
        this._targetFrame = -1;
        this._displayedFrame = -1;
        this._renderRafId = null;
        this._onFrame = null;  // 帧渲染回调
        this._hasAudio = false;
    }

    get width() { return this._width; }
    get height() { return this._height; }
    get fps() { return this._fps; }
    get duration() { return this._duration; }
    get frameCount() { return this._frameCount; }
    get previewWidth() { return this._previewWidth || this._width; }
    get previewHeight() { return this._previewHeight || this._height; }
    get hasAudio() { return this._hasAudio; }
    get audioSampleRate() { return this._audioSampleRate; }
    get audioChannels() { return this._audioChannels; }

    /**
     * 从 URL 加载视频文件
     * @param {string} url - 视频文件 URL
     * @param {number} maxPreviewSide - 预览最大边长（默认 1280）
     * @param {(receivedBytes:number, totalBytes:number)=>void} [onProgress] - fetch 进度回调
     * @param {number} [knownTotal] - 已知文件总字节数（probe 获取，避免无 Content-Length 时进度不准）
     */
    async openFromUrl(url, maxPreviewSide = 1280, onProgress = null, knownTotal = 0) {
        this.close();
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);

            // 始终流式读取以跟踪进度
            // 总大小优先级：Content-Length 头 > knownTotal（probe 获取）
            const headerTotal = parseInt(resp.headers.get('Content-Length')) || 0;
            const total = headerTotal || knownTotal || 0;
            let received = 0;
            const chunks = [];
            const reader = resp.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    chunks.push(value);
                    received += value.length;
                    if (onProgress) {
                        // total 为 0 时（无 Content-Length 且无 knownTotal）用已接收值兜底
                        onProgress(received, total || received);
                    }
                }
            }
            const blob = new Blob(chunks, { type: resp.headers.get('Content-Type') || 'video/mp4' });
            this._fileBlob = blob;
            return await this._openBlob(blob, maxPreviewSide);
        } catch (e) {
            console.error("[xzg-decoder] openFromUrl 失败:", e);
            this.close();
            throw e;
        }
    }

    /**
     * 从 Blob 加载视频（内部）
     */
    async _openBlob(blob, maxPreviewSide) {
        const mb = window.mb;
        if (!mb) throw new Error("mediabunny 未加载");

        const src = new mb.BlobSource(new File([blob], "video.mp4", { type: blob.type }));
        this._input = new mb.Input({ source: src, formats: mb.ALL_FORMATS });
        const vt = await this._input.getPrimaryVideoTrack();
        if (!vt) throw new Error("未找到视频轨道");
        this._track = vt;
        this._width = await vt.getDisplayWidth();
        this._height = await vt.getDisplayHeight();

        let dur = await vt.getDurationFromMetadata();
        if (!dur || dur <= 0) {
            try { dur = await vt.computeDuration(); } catch (_) {}
        }
        this._duration = dur || 0;

        this._canvasSink = new mb.CanvasSink(vt);

        // 帧率：优先用 packet stats，否则 30
        let fps = 30;
        try {
            const stats = await vt.computePacketStats(100);
            if (stats?.averagePacketRate > 0) fps = stats.averagePacketRate;
        } catch (_) {}
        this._fps = fps;

        // 帧数：duration × fps
        this._frameCount = Math.round(this._duration * fps);

        // 预览缩放 sink（高分辨率视频自动降级解码，加速 seek）
        if (this._width > maxPreviewSide || this._height > maxPreviewSide) {
            const ratio = Math.min(maxPreviewSide / this._width, maxPreviewSide / this._height);
            this._previewWidth = Math.round(this._width * ratio);
            this._previewHeight = Math.round(this._height * ratio);
            this._previewSink = new mb.CanvasSink(vt, {
                width: this._previewWidth,
                height: this._previewHeight,
                fit: 'contain',
            });
        }

        // 音频轨道
        try {
            const at = await this._input.getPrimaryAudioTrack();
            if (at) {
                this._audioTrack = at;
                this._audioBufferSink = new mb.AudioBufferSink(at);
                this._audioSampleRate = await at.getSampleRate();
                this._audioChannels = await at.getNumberOfChannels();
                this._hasAudio = true;
            }
        } catch (_) {}

        return {
            duration: this._duration,
            width: this._width,
            height: this._height,
            fps: this._fps,
            frameCount: this._frameCount,
            hasAudio: this._hasAudio,
            audioSampleRate: this._audioSampleRate,
            audioChannels: this._audioChannels,
        };
    }

    /**
     * 解码指定时间的帧到 canvas
     * @param {number} time - 时间戳（秒）
     * @returns {Promise<HTMLCanvasElement|null>}
     */
    async getCanvas(time) {
        const sink = this._previewSink || this._canvasSink;
        if (!sink) return null;
        try {
            let wc = await sink.getCanvas(time);
            if (wc) wc = await sink.getCanvas(time);  // 二次确认
            return wc?.canvas || null;
        } catch (_) { return null; }
    }

    /**
     * 创建播放迭代器（从指定时间开始顺序解码）
     * @param {number} startTime - 起始时间（秒）
     */
    createPlaybackIterator(startTime = 0) {
        const sink = this._previewSink || this._canvasSink;
        if (!sink) return null;
        return sink.canvases(startTime);
    }

    /**
     * 创建音频播放迭代器
     */
    createAudioIterator(startTime = 0) {
        if (!this._audioTrack) return null;
        try {
            if (this._audioBufferSink) {
                try { this._audioBufferSink.close(); } catch (_) {}
            }
            this._audioBufferSink = new mb.AudioBufferSink(this._audioTrack);
            return this._audioBufferSink.buffers(startTime);
        } catch (_) { return null; }
    }

    /**
     * 解码完整音频缓冲（用于播放）
     */
    async decodeFullAudio() {
        if (!this._hasAudio) return null;
        try {
            if (this._audioBufferSink) {
                try { this._audioBufferSink.close(); } catch (_) {}
            }
            const mb = window.mb;
            const sink = new mb.AudioBufferSink(this._audioTrack);
            this._audioBufferSink = sink;
            const sr = this._audioSampleRate;
            const ch = this._audioChannels;
            const total = Math.ceil(sr * this._duration);
            const ctx = new OfflineAudioContext(ch, total, sr);
            const buf = ctx.createBuffer(ch, total, sr);
            let offset = 0;
            const it = sink.buffers(0);
            while (true) {
                const r = await it.next();
                if (r.done) break;
                const w = r.value;
                if (!w?.buffer) continue;
                const bl = w.buffer.length;
                if (offset + bl > total) break;
                for (let c = 0; c < Math.min(ch, w.buffer.numberOfChannels); c++) {
                    buf.getChannelData(c).set(w.buffer.getChannelData(c), offset);
                }
                offset += bl;
            }
            if (offset < total) {
                const t = ctx.createBuffer(ch, offset, sr);
                for (let c = 0; c < ch; c++) {
                    t.getChannelData(c).set(buf.getChannelData(c).subarray(0, offset));
                }
                return t;
            }
            return buf;
        } catch (e) {
            console.error("[xzg-decoder] 解码音频失败:", e);
            return null;
        }
    }

    /**
     * 渲染指定帧到目标 canvas（带缓存 + 最近帧降级）
     * @param {number} frameNum - 帧号
     * @param {HTMLCanvasElement} targetCanvas - 目标 canvas
     * @param {boolean} showClosest - 未命中时是否显示最近缓存帧
     */
    async renderFrame(frameNum, targetCanvas, showClosest = false) {
        if (!this._track || this._frameCount <= 0) return;
        // clamp 到有效范围 [0, frameCount-1]，确保最右侧也能完整渲染最后一帧
        this._targetFrame = Math.max(0, Math.min(Math.round(frameNum), this._frameCount - 1));
        this._cache.targetFrame = this._targetFrame;
        this._onFrame = targetCanvas;

        // 缓存命中：直接 drawImage
        const cached = this._cache.get(this._targetFrame);
        if (cached) {
            this._drawToCanvas(cached, targetCanvas);
            this._displayedFrame = this._targetFrame;
            return;
        }

        // 未命中 + showClosest：显示最近缓存帧（不卡顿）
        if (showClosest) {
            const closest = this._cache.findClosest(this._targetFrame);
            if (closest >= 0 && closest !== this._displayedFrame) {
                const cc = this._cache.get(closest);
                if (cc) {
                    this._drawToCanvas(cc, targetCanvas);
                    this._displayedFrame = closest;
                }
            }
        }

        // 异步解码目标帧
        this._scheduleRender(targetCanvas);
    }

    /**
     * 调度异步解码（RAF 节流，避免堆积）
     */
    _scheduleRender(targetCanvas) {
        if (this._renderRafId) return;
        this._renderRafId = requestAnimationFrame(() => {
            this._renderRafId = null;
            this._doRender(targetCanvas);
        });
    }

    async _doRender(targetCanvas) {
        if (!this._track) return;
        if (this._targetFrame === this._displayedFrame) return;
        if (this._isDecoding) { this._scheduleRender(targetCanvas); return; }

        // 再次检查缓存（可能在等待期间已解码）
        const cached = this._cache.get(this._targetFrame);
        if (cached) {
            this._drawToCanvas(cached, targetCanvas);
            this._displayedFrame = this._targetFrame;
            return;
        }

        this._isDecoding = true;
        const frameToDecode = this._targetFrame;
        try {
            const time = frameToDecode / this._fps;
            const canvas = await this.getCanvas(time);
            if (canvas) {
                this._cache.add(frameToDecode, canvas);
                if (frameToDecode === this._targetFrame) {
                    const c = this._cache.get(frameToDecode);
                    if (c) {
                        this._drawToCanvas(c, targetCanvas);
                        this._displayedFrame = frameToDecode;
                    }
                }
            }
        } catch (e) {
            console.error("[xzg-decoder] 解码帧失败:", e);
        } finally {
            this._isDecoding = false;
            if (this._targetFrame !== this._displayedFrame) {
                this._scheduleRender(targetCanvas);
            }
        }
    }

    /**
     * 绘制 canvas 到目标（自适应尺寸）
     */
    _drawToCanvas(srcCanvas, targetCanvas) {
        const ctx = targetCanvas.getContext('2d');
        const pw = this.previewWidth;
        const ph = this.previewHeight;
        if (targetCanvas.width !== pw || targetCanvas.height !== ph) {
            targetCanvas.width = pw;
            targetCanvas.height = ph;
        }
        ctx.drawImage(srcCanvas, 0, 0, pw, ph);
    }

    clearCache() { this._cache.clear(); this._displayedFrame = -1; }

    close() {
        if (this._renderRafId) cancelAnimationFrame(this._renderRafId);
        this._renderRafId = null;
        this._cache.clear();
        if (this._canvasSink) { try { this._canvasSink.close(); } catch (_) {} this._canvasSink = null; }
        if (this._previewSink) { try { this._previewSink.close(); } catch (_) {} this._previewSink = null; }
        if (this._audioBufferSink) { try { this._audioBufferSink.close(); } catch (_) {} this._audioBufferSink = null; }
        this._audioTrack = null;
        this._track = null;
        if (this._input) { try { this._input.dispose(); } catch (_) {} this._input = null; }
        this._fileBlob = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 解码器池：管理多个视频的解码器实例（key = filename|type）
// ═══════════════════════════════════════════════════════════════════════════
class DecoderPool {
    constructor() {
        this._decoders = new Map();  // key -> VideoDecoderInstance
        this._loading = new Map();    // key -> Promise（防止重复加载）
    }

    _key(filename, type) { return `${filename}|${type || "input"}`; }

    /**
     * 获取或创建解码器（带缓存，避免重复加载）
     * @param {string} filename
     * @param {string} type
     * @param {string} videoUrl
     * @param {(receivedBytes:number, totalBytes:number)=>void} [onProgress] - 加载进度回调（仅首次加载触发）
     * @param {number} [knownTotal] - 已知文件总字节数（probe 获取）
     */
    async get(filename, type, videoUrl, onProgress = null, knownTotal = 0) {
        const key = this._key(filename, type);
        if (this._decoders.has(key)) {
            return this._decoders.get(key);
        }
        if (this._loading.has(key)) {
            return this._loading.get(key);
        }
        const promise = (async () => {
            const decoder = new VideoDecoderInstance();
            await decoder.openFromUrl(videoUrl, 1280, onProgress, knownTotal);
            this._decoders.set(key, decoder);
            this._loading.delete(key);
            return decoder;
        })();
        this._loading.set(key, promise);
        return promise;
    }

    /**
     * 预加载解码器（不阻塞，后台加载）
     */
    preload(filename, type, videoUrl) {
        const key = this._key(filename, type);
        if (this._decoders.has(key) || this._loading.has(key)) return;
        this.get(filename, type, videoUrl).catch(e => {
            console.warn(`[xzg-decoder] 预加载失败 ${filename}:`, e.message);
        });
    }

    /**
     * 获取已缓存的解码器（无则返回 null）
     */
    getCached(filename, type) {
        return this._decoders.get(this._key(filename, type)) || null;
    }

    /**
     * 关闭并移除指定解码器
     */
    close(filename, type) {
        const key = this._key(filename, type);
        const dec = this._decoders.get(key);
        if (dec) {
            dec.close();
            this._decoders.delete(key);
        }
    }

    /**
     * 关闭所有解码器
     */
    closeAll() {
        for (const dec of this._decoders.values()) dec.close();
        this._decoders.clear();
        this._loading.clear();
    }
}

// 全局单例
export const decoderPool = new DecoderPool();
export { VideoDecoderInstance, FrameCache };
