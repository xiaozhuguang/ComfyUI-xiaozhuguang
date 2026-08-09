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

// ─── 按文件类型记忆文件夹 handle（IndexedDB 持久化，刷新后仍有效） ─────
const LAST_FOLDER = { image: null, video: null, audio: null };

// IndexedDB 存取目录 handle（FileSystemDirectoryHandle 可结构化克隆）
const _xzgDBName = "xzg_save_handles";
const _xzgStoreName = "folder_handles";

function _xzgOpenDB() {
    return new Promise((resolve, reject) => {
        try {
            const req = indexedDB.open(_xzgDBName, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(_xzgStoreName);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        } catch (e) { reject(e); }
    });
}

async function _xzgSaveDirHandle(fileType, handle) {
    try {
        const db = await _xzgOpenDB();
        const tx = db.transaction(_xzgStoreName, "readwrite");
        tx.objectStore(_xzgStoreName).put(handle, fileType);
        await new Promise((resolve) => { tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); });
    } catch (_) {}
}

async function _xzgLoadDirHandle(fileType) {
    try {
        const db = await _xzgOpenDB();
        const tx = db.transaction(_xzgStoreName, "readonly");
        return await new Promise((resolve) => {
            const req = tx.objectStore(_xzgStoreName).get(fileType);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch (_) { return null; }
}

// 启动时从 IndexedDB 恢复目录 handle
(async () => {
    for (const ft of ["image", "video", "audio"]) {
        const h = await _xzgLoadDirHandle(ft);
        if (h) LAST_FOLDER[ft] = h;
    }
})();

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

                // 路径记忆策略：
                // 1. id 属性 — 浏览器原生记忆同一 id 上次使用的目录（最可靠，跨刷新有效）
                // 2. startIn + IndexedDB 存储的 directory handle — 补充记忆
                pickerOpts.id = "xzg_" + fileType;

                const lastHandle = LAST_FOLDER[fileType];
                if (lastHandle && lastHandle.kind === "directory") {
                    pickerOpts.startIn = lastHandle;
                } else {
                    pickerOpts.startIn = "desktop";
                }

                const handle = await window.showSaveFilePicker(pickerOpts);

                // 保存文件后，尝试获取父目录 handle 持久化到 IndexedDB
                // FileSystemFileHandle 没有标准的 .parent，但可通过 showDirectoryPicker + resolve 验证
                // 这里用最简方案：保存 file handle 本身，下次作为 startIn 也能定位到同目录
                try {
                    LAST_FOLDER[fileType] = handle;
                    _xzgSaveDirHandle(fileType, handle);
                } catch (_) {}

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
 * 优先级：
 *   1) 保存模式下已保存到 output 目录的 PNG → 直接引用，无需懒编码（最快）
 *   2) 已有 real_url 或可懒编码获取 → 走懒编码
 */
export async function downloadLazyImage(imgData) {
    if (!imgData) return;

    // 1) 优先：output 目录已有 PNG 文件，直接构造 /view URL 下载
    if (imgData.saved_filename && imgData.saved_type) {
        const savedUrl = api.apiURL(
            `/view?filename=${encodeURIComponent(imgData.saved_filename)}`
            + `&type=${encodeURIComponent(imgData.saved_type)}`
            + `&subfolder=${encodeURIComponent(imgData.saved_subfolder || "")}`
            + `${app.getRandParam()}`
        );
        await downloadImage(savedUrl, imgData.saved_filename || `xzg-save-${xzgTimestamp()}.png`);
        return;
    }

    // 2) 回退：懒编码获取全分辨率 PNG
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
