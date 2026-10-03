import { api } from "../../scripts/api.js";
import { xzgGetRealUrl } from "./xzg_save_utils.js";
import { xzgTh } from "./xzg_i18n.js";

async function fullResolutionPng(imgData) {
    if (!imgData) throw new Error(xzgTh("没有可复制的图片", "No image is available to copy"));
    let url;
    if (imgData.real_token) {
        url = await xzgGetRealUrl(imgData, { format: "png" });
    } else if (imgData.saved_filename) {
        url = api.apiURL(`/view?${new URLSearchParams({
            filename: imgData.saved_filename,
            subfolder: imgData.saved_subfolder || "",
            type: imgData.saved_type || "output",
        })}`);
    }
    // Never copy the reduced canvas preview or its display background.
    if (!url) throw new Error(xzgTh("高清原图不可用，请重启 ComfyUI 并重新执行对应节点（只刷新页面无法加载后端更新）", "Full-resolution source is unavailable. Restart ComfyUI and re-run the node; refreshing the page does not load backend updates."));
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(xzgTh("读取原图失败", "Could not load the original image") + ` (HTTP ${response.status})`);
    const blob = await response.blob();
    if (blob.type === "image/png") return blob;

    // Older workflows may only have a saved JPG. Convert at original dimensions.
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    try {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error(xzgTh("无法转换图片为 PNG", "Could not convert the image to PNG"));
        ctx.drawImage(bitmap, 0, 0);
        return await new Promise((resolve, reject) => {
            canvas.toBlob((png) => png ? resolve(png) : reject(new Error(xzgTh("图片 PNG 编码失败", "PNG encoding failed"))), "image/png");
        });
    } finally {
        bitmap.close();
        canvas.width = canvas.height = 0;
    }
}

// Call directly from the menu click: write must start before async encoding/fetch.
export async function xzgCopyImageToClipboard(imgData) {
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(window.location?.hostname);
    const windowsClient = /Windows/i.test(navigator.userAgent || "");
    if (imgData?.has_alpha && imgData.real_token && localHost && windowsClient) {
        const response = await api.fetchApi("/xzg_copy_image_clipboard", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: imgData.real_token, index: imgData.real_index ?? 0 }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(response.status === 404 && !result.error
                ? xzgTh("请重启 ComfyUI 以启用透明图片复制", "Restart ComfyUI to enable transparent image copying.")
                : result.error || `HTTP ${response.status}`);
        }
        if (!result.copied) throw new Error(xzgTh("原生剪贴板没有确认复制成功", "Native clipboard did not confirm the copy."));
        return { native: true };
    }
    if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error(xzgTh("浏览器不支持图片复制，请使用 localhost 或 HTTPS 地址，并使用支持图片剪贴板的浏览器", "Image clipboard is unavailable. Use localhost or HTTPS and a browser supporting image clipboard."));
    }
    const png = fullResolutionPng(imgData);
    // Handle a fetch failure even if clipboard permissions are rejected first.
    png.catch(() => {});
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return { native: false };
}
