import { xzgT } from "./xzg_i18n.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;
const MAX_SIDE = 8192;
const fits = (width, height) => width > 0 && height > 0 &&
    Math.max(width, height) <= MAX_SIDE && width * height <= MAX_PIXELS;
const sizeError = () => new Error(xzgT(
    "图片编辑支持最多 2400 万像素、单边 8192 像素、文件 64 MiB。",
    "The editor supports up to 24 megapixels, 8192 pixels per side, and 64 MiB per file.",
));
let activeEditor = false;

const editorStyles = `
    .xzg-image-editor { overflow: auto !important; }
    .xzg-image-editor__surface {
        position: relative;
        width: 100%;
        height: 100%;
        min-width: 760px;
        background: #323232;
    }
    .xzg-image-editor__frame {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        clip-path: polygon(38px 0, 100% 0, 100% 100%, 0 100%, 0 66px, 38px 66px);
    }
    .xzg-image-editor__actions {
        position: absolute;
        inset: 0 204px auto 574px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        padding: 0 8px;
        background: #323232;
    }
    .xzg-image-editor__actions button {
        padding: 3px 7px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: #ffd700;
        font: inherit;
        font-size: 16px;
        font-weight: 400;
        line-height: 1.2;
        box-shadow: none;
        opacity: 1;
        white-space: nowrap;
        cursor: pointer;
    }
    .xzg-image-editor__actions button:hover:not(:disabled) { background: rgb(255 255 255 / 10%); }
    .xzg-image-editor__actions button:focus-visible { outline: 1px solid currentColor; }
    .xzg-image-editor__actions button:disabled { color: #ffd700; opacity: .45; cursor: default; }
    .xzg-image-editor__status:not(:empty) {
        position: absolute;
        top: 38px;
        right: 12px;
        max-width: min(420px, 65%);
        padding: 6px 10px;
        border-radius: 4px;
        background: #262626;
        color: #ffd700;
        font-size: 14px;
        pointer-events: none;
    }
    @media (max-width: 1050px) {
        .xzg-image-editor__actions { right: 0; }
    }
    @media (max-width: 800px) {
        .xzg-image-editor__actions button { font-size: 14px; padding-inline: 4px; }
    }
`;

async function readImage(sourceUrl, infoUrl, signal) {
    const info = await fetch(infoUrl, { signal });
    if (!info.ok) throw new Error(xzgT("无法读取原图尺寸", "Could not read source image dimensions"));
    const { width, height } = await info.json();
    if (!fits(width, height)) throw sizeError();
    const response = await fetch(sourceUrl, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(xzgT("无法读取原图", "Could not load the original image"));
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
        await response.body.cancel();
        throw sizeError();
    }
    if (response.headers.has("content-length") && !response.headers.has("content-encoding")) {
        const blob = await response.blob();
        if (blob.size > MAX_BYTES) throw sizeError();
        return blob;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) {
                await reader.cancel();
                throw sizeError();
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return new Blob(chunks, { type: response.headers.get("content-type") || "" });
}

async function checkPng(blob) {
    if (blob.size > MAX_BYTES) throw sizeError();
    const header = new DataView(await blob.slice(0, 24).arrayBuffer());
    if (header.byteLength < 24 || header.getUint32(0) !== 0x89504e47 ||
        header.getUint32(4) !== 0x0d0a1a0a || header.getUint32(12) !== 0x49484452) {
        throw new Error(xzgT("无法读取导出的 PNG", "Could not read the exported PNG"));
    }
    if (!fits(header.getUint32(16), header.getUint32(20))) throw sizeError();
}

export async function editImage({ name, sourceUrl, infoUrl, signal, apply }) {
    if (activeEditor) throw new Error(xzgT("请先关闭已打开的图片编辑器", "Close the current image editor first"));
    signal.throwIfAborted();
    activeEditor = true;
    try {
        await new Promise((resolve) => {
            const work = new AbortController();
            const dialog = document.createElement("dialog");
            dialog.className = "xzg-image-editor";
            const editorLabel = xzgT("图片编辑", "Image editor");
            dialog.setAttribute("aria-label", editorLabel);
            dialog.style.cssText = "position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:#323232;color:var(--input-text,#eee)";
            const styles = document.createElement("style");
            styles.textContent = editorStyles;
            const contents = document.createElement("div");
            contents.className = "xzg-image-editor__surface";
            const toolbar = document.createElement("div");
            toolbar.className = "xzg-image-editor__actions";
            const status = document.createElement("span");
            status.className = "xzg-image-editor__status";
            status.setAttribute("role", "status");
            const button = (label) => {
                const element = document.createElement("button");
                element.type = "button";
                element.textContent = label;
                return element;
            };
            const applyButton = button(xzgT("应用到加载器", "Apply to loader"));
            const cancelButton = button(xzgT("取消", "Cancel"));
            applyButton.disabled = true;
            const frame = document.createElement("iframe");
            frame.className = "xzg-image-editor__frame";
            frame.title = editorLabel;
            frame.allow = "clipboard-read; clipboard-write";
            const editorUrl = new URL("./photocraft/index.html", import.meta.url);
            editorUrl.searchParams.set("xzgLang", xzgT("zh-hans", "en"));
            const sourceName = name.replace(/ \[(?:input|output|temp)\]$/, "").split(/[\\/]/).at(-1);
            let exportTimer = 0;
            let observer;
            status.textContent = xzgT("正在启动编辑器…", "Starting the editor…");
            toolbar.append(cancelButton, applyButton);
            contents.append(frame, toolbar, status);
            dialog.append(styles, contents);

            const finish = () => {
                signal.removeEventListener("abort", finish);
                work.abort();
                clearTimeout(exportTimer);
                observer?.disconnect();
                if (frame.contentDocument) {
                    frame.contentWindow.dispatchEvent(new Event("xzg-image-editor-dispose"));
                    frame.contentWindow.dispatchEvent(new Event("xzg-photocraft-dispose"));
                }
                frame.remove();
                dialog.close();
                dialog.remove();
                resolve();
            };
            cancelButton.onclick = finish;
            dialog.addEventListener("cancel", (event) => {
                event.preventDefault();
                finish();
            });
            signal.addEventListener("abort", finish, { once: true });

            const showError = (error) => {
                if (!work.signal.aborted) status.textContent = error.message;
            };
            const exportFailed = (error) => {
                clearTimeout(exportTimer);
                exportTimer = 0;
                showError(error);
                if (!work.signal.aborted) applyButton.disabled = false;
            };
            applyButton.onclick = () => {
                if (applyButton.disabled) return;
                applyButton.disabled = true;
                status.textContent = xzgT("正在导出当前图片…", "Exporting the current image…");
                exportTimer = setTimeout(() => exportFailed(new Error(xzgT(
                    "未收到导出图片。请确认图片已打开，并完成编辑器中的对话框后重试。",
                    "No image was exported. Make sure an image is open, finish any active dialog, then retry.",
                ))), 15000);
                try {
                    const editor = frame.contentWindow;
                    const exportImage = editor?.xzgExportImage ?? editor?.xzgPhotoCraftExport;
                    if (typeof exportImage !== "function") {
                        throw new Error(xzgT(
                            "图片编辑器的导出接口未加载。请刷新 ComfyUI 页面后重试。",
                            "The image export interface did not load. Refresh ComfyUI and try again.",
                        ));
                    }
                    exportImage();
                } catch (error) {
                    exportFailed(error);
                }
            };

            frame.addEventListener("load", () => {
                observer?.disconnect();
                const doc = frame.contentDocument;
                const canvas = doc?.getElementById("photocraft_canvas");
                if (!canvas) {
                    showError(new Error(xzgT("无法启动图片编辑器", "Could not start the image editor")));
                    return;
                }
                // The bundled release writes exports through a temporary Blob download link.
                doc.addEventListener("click", async (event) => {
                    const link = event.target.closest?.("a[download]");
                    if (!exportTimer || !link?.href.startsWith("blob:") || !/\.png$/i.test(link.download)) return;
                    event.preventDefault();
                    clearTimeout(exportTimer);
                    exportTimer = 0;
                    status.textContent = xzgT("正在写回图片…", "Saving to the loader…");
                    try {
                        const response = await fetch(link.href, { signal: work.signal });
                        if (!response.ok) throw new Error(xzgT("无法读取导出的 PNG", "Could not read the exported PNG"));
                        const blob = await response.blob();
                        await checkPng(blob);
                        work.signal.throwIfAborted();
                        const filename = `xzg_edit_${crypto.randomUUID?.() || Date.now()}.png`;
                        await apply(new File([blob], filename, { type: "image/png" }), work.signal);
                        finish();
                    } catch (error) {
                        exportFailed(error);
                    }
                }, { capture: true, signal: work.signal });

                const importSource = async () => {
                    observer?.disconnect();
                    status.textContent = xzgT("正在打开原图…", "Opening the original image…");
                    try {
                        const blob = await readImage(sourceUrl, infoUrl, work.signal);
                        work.signal.throwIfAborted();
                        if (canvas.ownerDocument !== frame.contentDocument) return;
                        const transfer = new DataTransfer();
                        transfer.items.add(new File([blob], sourceName, { type: blob.type }));
                        canvas.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
                        status.textContent = "";
                        applyButton.disabled = false;
                    } catch (error) {
                        showError(error);
                    }
                };
                if (doc.getElementById("photocraft_loading")) {
                    observer = new MutationObserver(() => {
                        if (!doc.getElementById("photocraft_loading")) void importSource();
                    });
                    observer.observe(doc.body, { childList: true });
                } else {
                    void importSource();
                }
            }, { signal: work.signal });
            frame.src = editorUrl.href;
            document.body.append(dialog);
            dialog.showModal();
        });
    } finally {
        activeEditor = false;
    }
}
