// ═══════════════════════════════════════════════════════════════════════
// 小珠光统一保存工具模块
// - File System Access API（showSaveFilePicker）优先，首次默认桌面，二次默认上次路径
// - 不支持时降级为普通 a.download 下载（浏览器默认下载目录）
// - 按文件类型分别记忆文件夹 handle（image / video / audio），互不干扰
// ═══════════════════════════════════════════════════════════════════════

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

/**
 * 时间戳：格式 yyyyMMdd_HHmmss，用于保存文件名避免重复
 */
export function xzgTimestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ─── MIME 类型映射表 ────────────────────────────────────────────────
export const IMAGE_MIME_MAP = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
};

export const VIDEO_MIME_MAP = {
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
    mov: "video/quicktime", avi: "video/x-msvideo", gif: "image/gif",
};

export const AUDIO_MIME_MAP = {
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
    aac: "audio/aac", m4a: "audio/mp4", wma: "audio/x-ms-wma", opus: "audio/opus",
    amr: "audio/amr", ac3: "audio/ac3", aiff: "audio/aiff", au: "audio/basic",
    mka: "audio/x-matroska", mp2: "audio/mpeg", ra: "audio/x-pn-realaudio",
    voc: "audio/voc", w64: "audio/x-w64",
};

// ─── 按文件类型记忆文件夹 handle（仅内存，浏览器刷新后重置） ──────────
const LAST_FOLDER = { image: null, video: null, audio: null };

/**
 * 通用下载函数：File System Access API + 降级方案
 * @param {string} url - 资源 URL
 * @param {string} filename - 建议文件名（含扩展名）
 * @param {'image'|'video'|'audio'} fileType - 文件类型，用于记忆文件夹和设置 MIME
 */
export async function xzgDownload(url, filename, fileType = "image") {
    if (!url) return;

    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const blob = await resp.blob();

        const ext = (filename || "").split(".").pop()?.toLowerCase() || "png";
        const mimeMaps = { image: IMAGE_MIME_MAP, video: VIDEO_MIME_MAP, audio: AUDIO_MIME_MAP };
        const defaultMimes = { image: "image/png", video: "video/mp4", audio: "audio/mpeg" };
        const descMap = { image: "图片文件", video: "视频文件", audio: "音频文件" };

        const mimeType = blob.type || (mimeMaps[fileType]?.[ext]) || defaultMimes[fileType] || "application/octet-stream";
        const description = descMap[fileType] || "文件";

        // ─── File System Access API（优先） ──────────────────────
        if (typeof window.showSaveFilePicker === "function") {
            try {
                const pickerOpts = {
                    suggestedName: filename || `xzg-save.${ext}`,
                    types: [{
                        description,
                        accept: { [mimeType]: ["." + ext] },
                    }],
                };

                // 路径记忆：有上次 handle → 用上次；首次 → 桌面
                const lastHandle = LAST_FOLDER[fileType];
                if (lastHandle) {
                    pickerOpts.startIn = lastHandle;
                } else {
                    pickerOpts.startIn = "desktop";
                }

                const handle = await window.showSaveFilePicker(pickerOpts);
                // 记住文件夹（用于下次 startIn），从 file handle 获取 parent directory handle
                try {
                    LAST_FOLDER[fileType] = await handle.parent;
                } catch (_) {
                    // 某些浏览器不支持 .parent，直接存当前 handle 也可作为 startIn
                    LAST_FOLDER[fileType] = handle;
                }

                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                return;
            } catch (e) {
                // 用户取消对话框 → 静默返回，不降级
                if (e?.name === "AbortError") return;
                // 其他错误（权限不足等）→ 继续降级
            }
        }

        // ─── 降级：普通 a.download ──────────────────────────────
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename || `xzg-save.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (e) {
        if (e?.name === "AbortError") return; // 用户取消
        console.warn(`[小珠光] ${fileType} 下载失败:`, e);
    }
}

/**
 * 快捷方法：下载图片（PNG）
 */
export async function downloadImage(url, filename) {
    await xzgDownload(url, filename || `xzg-save-${xzgTimestamp()}.png`, "image");
}

/**
 * 快捷方法：下载图片（JPG）
 */
export async function downloadJpgImage(url, filename) {
    await xzgDownload(url, filename || `xzg-save-${xzgTimestamp()}.jpg`, "image");
}

/**
 * 快捷方法：下载视频
 */
export async function downloadVideo(url, filename) {
    await xzgDownload(url, filename || `xzg-video-${xzgTimestamp()}.mp4`, "video");
}

/**
 * 快捷方法：下载音频
 */
export async function downloadAudio(url, filename) {
    await xzgDownload(url, filename || `xzg-audio-${xzgTimestamp()}.mp3`, "audio");
}

// ═══════════════════════════════════════════════════════════════════════
// 懒编码：请求后端临时编码全分辨率 PNG（仅右键时触发，不拖慢执行）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 通过 token 和 index 从后端获取真实分辨率图片 URL
 * @param {{ real_token: string, real_index?: number }[]} imgData - 单元素数组或含 token/index 的对象
 */
export async function xzgGetRealUrl(imgData) {
    if (!imgData || !imgData.real_token) return null;

    try {
        const resp = await api.fetchApi("/xzg_save_real", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: imgData.real_token, index: imgData.real_index }),
        });
        if (!resp.ok) return null;
        const info = await resp.json();
        if (info && info.filename) {
            return api.apiURL(
                `/view?filename=${encodeURIComponent(info.filename)}&type=${info.type}&subfolder=${encodeURIComponent(info.subfolder)}${app.getRandParam()}`
            );
        }
    } catch (_) {}

    return null;
}

/**
 * 下载图片（支持懒编码 PNG）
 */
export async function downloadLazyImage(imgData) {
    if (!imgData) return;

    // 优先使用已有真实 URL
    let url = imgData.real_url || await xzgGetRealUrl(imgData);
    if (url) {
        await downloadImage(url, `xzg-save-${xzgTimestamp()}.png`);
    }
}

/**
 * 下载 JPG（直接使用压缩预览图，无需懒编码）
 */
export async function downloadLazyJpg(imgData) {
    if (!imgData || !imgData.url) return;
    await downloadJpgImage(imgData.url, `xzg-save-${xzgTimestamp()}.jpg`);
}
