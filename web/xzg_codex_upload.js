import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";

let copying = false;

export async function xzgCopyFiles(filenames, kind, button, absToken = "") {
    if (copying) return;
    if (!filenames.length || filenames.some(name => !name)) {
        app.extensionManager?.toast?.add({ severity: "warn", summary: xzgT("请先选择素材", "Select media first"), life: 2000 });
        return;
    }
    copying = true;
    if (button) button.disabled = true;
    try {
        const response = await api.fetchApi("/xzg/clipboard/files", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filenames, kind, abs_token: absToken }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok || !result.copied) {
            throw new Error(response.status === 404
                ? xzgT("请重启 ComfyUI 以启用文件复制", "Restart ComfyUI to enable file copying")
                : result.error || `HTTP ${response.status}`);
        }
        app.extensionManager?.toast?.add({ severity: "info",
            summary: xzgT("原文件已复制到剪贴板，请在目标应用按 Ctrl+V", "Original files copied; press Ctrl+V in the target app"), life: 2000 });
    } catch (error) {
        app.extensionManager?.toast?.add({ severity: "error", summary: xzgT("复制到剪贴板失败", "Could not copy files"), detail: error.message, life: 5000 });
    } finally {
        copying = false;
        if (button) button.disabled = false;
    }
}

// Keep older imports functional while browser assets are refreshed.
export const xzgAddToCodex = xzgCopyFiles;
export const xzgAddToDoubao = xzgCopyFiles;
