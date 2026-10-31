import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";

let uploading = false;

export function xzgAddToCodex(filenames, kind, button, absToken = "") {
    return addAttachments(filenames, kind, button, "codex", "Codex", absToken);
}

export function xzgAddToDoubao(filenames, kind, button, absToken = "") {
    return addAttachments(filenames, kind, button, "doubao", xzgT("豆包", "Doubao"), absToken);
}

async function addAttachments(filenames, kind, button, target, label, absToken) {
    if (uploading) return;
    if (!filenames.length || filenames.some(name => !name)) {
        app.extensionManager?.toast?.add({ severity: "warn", summary: xzgT("请先选择素材", "Select media first"), life: 4000 });
        return;
    }
    uploading = true;
    if (button) button.disabled = true;
    try {
        const response = await api.fetchApi(`/xzg/${target}/attachments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filenames, kind, abs_token: absToken }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) {
            throw new Error(response.status === 404
                ? xzgT(`请重启 ComfyUI 以启用添加到${label}`, `Restart ComfyUI to enable ${label} attachments`)
                : result.error || `HTTP ${response.status}`);
        }
        app.extensionManager?.toast?.add({ severity: result.pasted ? "info" : "warn", summary: result.pasted
            ? xzgT(`已尝试粘贴，请在${label}确认附件已出现`, `Paste attempted; check the attachment preview in ${label}`)
            : xzgT(`原文件已复制，请在${label}输入框按 Ctrl+V`, `Original files copied; press Ctrl+V in the ${label} composer`),
            detail: result.warning || "", life: 8000 });
    } catch (error) {
        app.extensionManager?.toast?.add({ severity: "error", summary: xzgT(`添加到${label}失败`, `Could not add to ${label}`), detail: error.message, life: 10000 });
    } finally {
        uploading = false;
        if (button) button.disabled = false;
    }
}
