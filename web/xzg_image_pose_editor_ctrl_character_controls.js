/**
 * VNCCS Pose Studio - Combined mesh editor and multi-pose generator
 * 
 * Combines Character Studio sliders, dynamic pose tabs, and Debug3 gizmo controls.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { downloadImage, xzgTimestamp } from "./xzg_save_utils.js";
import { xzgTh } from "./xzg_i18n.js";
import { cloudLoad, cloudSave } from "./xzg_cloud_store.js";

const POSE_CATEGORY_KEY = "xzg_pose_library_categories";
const poseCategoriesReady = cloudLoad(POSE_CATEGORY_KEY, { fallbackValue: { added: [], hidden: [] } });
import {
    POSE_STUDIO_CAPTURE_FOV,
    PoseViewerCore,
    buildEquivalentPerspectiveProjectionFrame,
} from "./pose_studio/core.js?v=20261020.capture-target1";
import { HAND_PRESETS } from "./pose_studio/hand_presets.js";
import { installCustomSelects } from "./vnccs_pose_shared/custom_select.mjs";
import { observePoseStudioI18n, translatePoseStudioSubtree } from "./pose_studio/i18n.mjs?v=20261017.2";
import {
    DEFAULT_CHARACTER_COLORS,
    MAX_POSE_STUDIO_CHARACTERS,
    cameraFramingToCharacterTransform,
    composeCameraFramingWithCharacterTransform,
    createPoseStudioCharacter,
    extractActiveCharacterTransformFromSceneAsset,
    extractActivePoseFromSceneAsset,
    nextCharacterColor,
    nextCharacterId,
    nextCharacterSlot,
    normalizeCharacterColor,
    normalizeCharacterTransform,
    normalizePoseStudioCharacters,
    normalizeSAMProjectionFrame,
    serializePoseStudioCharacter,
} from "./pose_studio/characters.mjs?v=20261017.empty1";

import { resolveCaptureCameraParams } from "./pose_studio/pose_utils.mjs?v=20261017.roll1";

const VNCCS_POSE_MORPH_WORKER_URL = new URL("./pose_studio/morph_worker.js", import.meta.url);
let VNCCS_SHARED_MORPH_WORKER = null;
let VNCCS_SHARED_MORPH_WORKER_FAILED = false;
let VNCCS_SHARED_MORPH_WORKER_WARMED = false;
let VNCCS_SHARED_MORPH_CLIENT_ID = 1;
const VNCCS_SHARED_MORPH_CLIENTS = new Map();
let VNCCS_MODAL_SEQUENCE = 1;
let VNCCS_POSE_PREVIEW_MENU = null;
let VNCCS_POSE_PREVIEW_MENU_NODE = null;
let VNCCS_BACKEND_SESSION_PROMISE = null;

function getVnccsBackendSessionId() {
    if (!VNCCS_BACKEND_SESSION_PROMISE) {
        const request = api.fetchApi("/xzg/backend-session")
            .then(response => response.ok ? response.json() : null)
            .then(result => typeof result?.session_id === "string" && result.session_id ? result.session_id : null)
            .catch(error => {
                console.warn("[VNCCS PoseStudio] Could not read backend session id:", error);
                return null;
            });
        const wrapped = request.finally(() => {
            if (VNCCS_BACKEND_SESSION_PROMISE === wrapped) VNCCS_BACKEND_SESSION_PROMISE = null;
        });
        VNCCS_BACKEND_SESSION_PROMISE = wrapped;
    }
    return VNCCS_BACKEND_SESSION_PROMISE;
}

function clearPoseStudioTransientStateOnConfigure(node, backendSessionId) {
    if (!node || !backendSessionId || node._vnccsTransientStateClearedForBoot === backendSessionId) return;
    const widget = node.widgets?.find(item => item.name === "pose_data");
    if (widget && typeof widget.value !== "string") return;
    try {
        const data = widget?.value?.trim() ? JSON.parse(widget.value) : {};
        if (!data || typeof data !== "object" || Array.isArray(data)) return;
        if (data.backend_session_id === backendSessionId) {
            node._vnccsTransientStateClearedForBoot = backendSessionId;
            node._vnccsBackendSessionId = backendSessionId;
            node._vnccsPoseCaptureGeneration = `_session_${backendSessionId}`;
            return;
        }
        const defaultMesh = {
            age: 25, gender: 0.5, weight: 0.5, muscle: 0.5, height: 0.5,
            breast_size: 0.5, firmness: 0.5, show_genitals: false,
            penis_len: 0.5, penis_circ: 0.5, penis_test: 0.5,
            head_size: 1, arm_size: 1, hand_size: 1, foot_size: 1,
            shoulder_l_length: 0.5, shoulder_r_length: 0.5,
            hip_l_length: 0.5, hip_r_length: 0.5,
            upper_arm_l_length: 0.5, upper_arm_r_length: 0.5,
            forearm_l_length: 0.5, forearm_r_length: 0.5,
            thigh_l_length: 0.5, thigh_r_length: 0.5,
            shin_l_length: 0.5, shin_r_length: 0.5, spine_length: 0.5,
        };
        data.mesh = { ...defaultMesh };
        data.poses = [{}];
        data.image_poses = [];
        data.activeTab = 0;
        data.background_url = null;
        delete data.captured_images;
        data.capture_id = `vnccs_capture_${node.id}_session_${backendSessionId}`;
        if (data.export && typeof data.export === "object") {
            data.export.background_url = null;
            data.export.cam_offset_x = 0;
            data.export.cam_offset_y = 0;
            data.export.cam_zoom = 1;
            data.export.cam_yaw_deg = 0;
            data.export.cam_pitch_deg = 0;
            data.export.cam_roll_deg = 0;
        }
        data.characters = [];
        data.active_character_id = null;
        data.backend_session_id = backendSessionId;
        if (widget) widget.value = JSON.stringify(data);
        node._vnccsTransientStateClearedForBoot = backendSessionId;
        node._vnccsBackendSessionId = backendSessionId;
        node._vnccsPoseCaptureGeneration = `_session_${backendSessionId}`;
        if (node.properties) {
            delete node.properties.xzg_pose_capture_states;
            node.properties.xzg_pose_backend_session_id = backendSessionId;
        }
    } catch (error) {
        console.warn("[VNCCS PoseStudio] Could not clear transient pose and background state:", error);
    }
}

function preparePoseStudioBackendSession(node, { refresh = false, reloadState = false } = {}) {
    if (!node) return Promise.resolve(null);
    if (!refresh && node._vnccsBackendSessionPreparation) return node._vnccsBackendSessionPreparation;
    const previousSessionId = node._vnccsBackendSessionId;
    node._vnccsBackendSessionPreparation = getVnccsBackendSessionId().then(backendSessionId => {
        if (!backendSessionId) return null;
        clearPoseStudioTransientStateOnConfigure(node, backendSessionId);
        node._vnccsBackendSessionId = backendSessionId;
        if (node.properties) {
            const storedSession = node.properties.xzg_pose_backend_session_id;
            if (storedSession && storedSession !== backendSessionId) {
                delete node.properties.xzg_pose_capture_states;
            }
            node.properties.xzg_pose_backend_session_id = backendSessionId;
        }
        if (reloadState || previousSessionId !== backendSessionId) node.studioWidget?.loadFromNode();
        return backendSessionId;
    }).catch(error => {
        node._vnccsBackendSessionPreparation = null;
        throw error;
    });
    return node._vnccsBackendSessionPreparation;
}

async function waitForPoseStudioSyncIdle(widget, timeoutMs = 5000) {
    await widget?.awaitReadyForCompositeCapture?.(Math.max(timeoutMs, 120000));
    const deadline = Date.now() + timeoutMs;
    while (widget?._isSyncing && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 16));
    }
    if (widget?._isSyncing) {
        throw new Error("Pose Studio is still synchronizing another capture.");
    }
}

async function requestPoseFromImageFile(widget, file, {
    autoUnload = false,
    applyMode = "pose",
    onProgress = () => {},
} = {}) {
    const node = widget?.node;
    if (!widget || !node || !file) {
        throw new Error(!file ? "没有读取到所选图片，请重新选择。" : "姿势编辑器尚未关联到节点，请重新打开后再试。");
    }
    const body = new FormData();
    body.append("image", file, file.name);
    const taskId = `pose-${node.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    body.append("task_id", taskId);
    if (autoUnload) body.append("auto_unload", "1");

    let requestDone = false;
    let requestError = null;
    let importResult = null;
    const requestPromise = api.fetchApi("/vnccs/sam3d/process_image_to_pose_json", {
        method: "POST",
        body,
    }).then(async response => {
        if (!response.ok) {
            let message = `姿势识别失败（HTTP ${response.status}）`;
            try {
                const error = await response.json();
                message = error?.error || message;
            } catch (_) {}
            throw new Error(message);
        }
        importResult = await response.json();
    }).catch(error => {
        requestError = error;
    }).finally(() => {
        requestDone = true;
    });

    while (!requestDone) {
        let statusError = "";
        try {
            const statusResponse = await api.fetchApi(
                `/vnccs/sam3d/import_status/${encodeURIComponent(taskId)}`,
            );
            if (statusResponse.ok) {
                const status = await statusResponse.json();
                onProgress(status.progress, status.message);
                if (status.status === "error") statusError = status.message || "姿势识别失败。";
            }
        } catch (_) {
            // The image request remains authoritative for errors.
        }
        if (statusError) throw new Error(statusError);
        if (!requestDone) await new Promise(resolve => setTimeout(resolve, 450));
    }
    await requestPromise;
    if (requestError) throw requestError;
    if (!importResult?.pose_data) throw new Error("姿势识别接口没有返回姿势数据。");

    let sourceResolution = null;
    try {
        const bitmap = await createImageBitmap(file);
        sourceResolution = { width: bitmap.width, height: bitmap.height };
        bitmap.close?.();
    } catch (_) {}
    onProgress(90, "准备人物场景");
    const syncToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await new Promise((resolve, reject) => {
        api.dispatchEvent(new CustomEvent("vnccs_apply_sam3d_pose", {
            detail: {
                node_id: node.id,
                studio_widget: widget,
                sync_token: syncToken,
                pose_data: importResult.pose_data,
                source_resolution: sourceResolution,
                apply_mode: applyMode,
                onProgress,
                onComplete: error => error ? reject(error) : resolve(),
            },
        }));
    });
    return importResult;
}

async function unloadPoseRecognitionModels() {
    const response = await api.fetchApi("/vnccs/sam3d/unload_models?wait=1", { method: "POST" });
    let result = null;
    try { result = await response.json(); } catch (_) {}
    if (!response.ok || result?.status !== "success") {
        throw new Error(result?.error || `模型卸载失败（HTTP ${response.status}）`);
    }
    return result;
}

function posePreviewMenuItem(menu, label, color, action) {
    const item = document.createElement("div");
    item.style.cssText = "padding:6px 14px;cursor:pointer;white-space:nowrap;";
    item.innerHTML = `<span style="color:${color};">${label}</span>`;
    item.addEventListener("mouseenter", () => { item.style.background = "var(--comfy-input-bg)"; });
    item.addEventListener("mouseleave", () => { item.style.background = ""; });
    item.addEventListener("click", async () => {
        const node = VNCCS_POSE_PREVIEW_MENU_NODE;
        hidePosePreviewMenu();
        try { await action(node); }
        catch (error) {
            const message = error?.message || String(error);
            app?.extensionManager?.toast?.add?.({ title: "姿势预览操作失败", message, type: "error", life: 4 });
            if (!app?.extensionManager?.toast?.add) alert(`姿势预览操作失败：${message}`);
        }
    });
    menu.appendChild(item);
}

function ensurePosePreviewMenu() {
    if (VNCCS_POSE_PREVIEW_MENU) return VNCCS_POSE_PREVIEW_MENU;
    const menu = document.createElement("div");
    menu.style.cssText = "position:fixed;z-index:1000010;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:6px;padding:4px 0;min-width:170px;display:none;box-shadow:0 4px 16px rgba(0,0,0,.4);font-size:14px;color:var(--input-text);user-select:none;";
    const separator = () => {
        const line = document.createElement("div");
        line.setAttribute("aria-hidden", "true");
        line.style.cssText = "width:82%;height:0;margin:2px auto;border-top:1px solid var(--input-text);opacity:.55;";
        menu.appendChild(line);
    };
    posePreviewMenuItem(menu, xzgTh("PNG保存", "Save PNG"), "#4CAF50", savePosePreview);
    separator();
    posePreviewMenuItem(menu, xzgTh("收藏到媒体库", "Add to Media Library"), "#FFD700", addPosePreviewToMediaLibrary);
    separator();
    posePreviewMenuItem(menu, xzgTh("发送到小珠光图片加载器", "Send to Image Loader"), "#FFD700", sendPosePreviewToImageLoader);
    document.body.appendChild(menu);
    VNCCS_POSE_PREVIEW_MENU = menu;
    const dismiss = event => {
        if (menu.style.display === "block" && !menu.contains(event.target)) hidePosePreviewMenu();
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("contextmenu", dismiss, true);
    window.addEventListener("keydown", event => {
        if (event.key === "Escape" && menu.style.display === "block") hidePosePreviewMenu();
    }, true);
    window.addEventListener("wheel", dismiss, true);
    return menu;
}

function hidePosePreviewMenu() {
    if (VNCCS_POSE_PREVIEW_MENU) VNCCS_POSE_PREVIEW_MENU.style.display = "none";
    VNCCS_POSE_PREVIEW_MENU_NODE = null;
}

function showPosePreviewMenu(node, x, y) {
    VNCCS_POSE_PREVIEW_MENU_NODE = node;
    const menu = ensurePosePreviewMenu();
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = "block";
    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
        if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
    });
}

function getPosePreviewImageSource(node) {
    const previewImage = node?._vnccsPosePreviewWidget?.image;
    const outputImage = node?.imgs?.[0];
    return previewImage?.src || outputImage?.src || outputImage?.url || "";
}

async function getPosePreviewBlob(node) {
    const source = getPosePreviewImageSource(node);
    if (!source) throw new Error(xzgTh("当前没有可用的姿势预览图", "No pose preview image is available"));
    const response = await fetch(source, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        return await new Promise((resolve, reject) => canvas.toBlob(
            blob => blob ? resolve(blob) : reject(new Error("PNG 编码失败")),
            "image/png",
        ));
    } finally {
        bitmap.close?.();
    }
}

async function savePosePreview(node) {
    const blob = await getPosePreviewBlob(node);
    const url = URL.createObjectURL(blob);
    const filename = `xzg-pose-${xzgTimestamp()}.png`;
    try { await downloadImage(url, filename); }
    finally { URL.revokeObjectURL(url); }
}

async function addPosePreviewToMediaLibrary(node) {
    const blob = await getPosePreviewBlob(node);
    const filename = `xzg-pose-${xzgTimestamp()}.png`;
    const formData = new FormData();
    formData.append("file", blob, filename);
    const response = await api.fetchApi("/xzg/media-library/upload", { method: "POST", body: formData });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    app?.extensionManager?.toast?.add?.({
        title: xzgTh("已收藏到媒体库", "Added to Media Library"),
        message: result.name || filename,
        type: "success",
        life: 2,
    });
}

function isPoseImageLoaderEnabled(node) {
    if (!node || node.type !== "XiaozhuguangImageLoader") return false;
    const modes = globalThis.LiteGraph?.NODE_MODES || {};
    // 被绕过的加载器仍可作为图片接收目标；停用节点仍排除。
    return ![2, globalThis.LiteGraph?.NEVER, modes.NEVER]
        .includes(node.mode)
        && node.disabled !== true
        && node.flags?.disabled !== true;
}

function appendPosePreviewToLoader(loader, name) {
    if (!isPoseImageLoaderEnabled(loader)) throw new Error("目标图像加载器已停用。");
    const list = loader.widgets?.find(widget => widget.name === "image_list");
    if (!list) throw new Error("目标图像加载器缺少图片列表控件。");
    const mode = loader.widgets?.find(widget => widget.name === "upload_mode")?.value === "replace" ? "replace" : "append";
    const entries = String(list.value || "").split("\n").map(value => value.trim()).filter(Boolean);
    if (mode === "replace") list.value = name;
    else {
        const duplicateIndex = entries.indexOf(name);
        if (duplicateIndex >= 0) entries.splice(duplicateIndex, 1);
        entries.push(name);
        list.value = entries.join("\n");
    }
    list.callback?.(list.value);
    const index = loader.widgets?.find(widget => widget.name === "index");
    if (index) {
        index.value = mode === "replace" ? 0 : list.value.split("\n").filter(Boolean).length - 1;
        index.callback?.(index.value);
    }
    app.graph?.setDirtyCanvas?.(true, true);
}

function showPoseImageLoaderDialog(loaders, name) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:1000011;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;";
    const dialog = document.createElement("div");
    dialog.style.cssText = "background:var(--comfy-menu-bg,#2a2a2a);border:1px solid var(--border-color,#555);border-radius:8px;padding:20px 24px;width:320px;max-width:90vw;max-height:80vh;overflow:auto;box-sizing:border-box;color:var(--input-text,#ddd);";
    const title = document.createElement("div");
    title.style.cssText = "font-size:13px;margin-bottom:14px;";
    title.textContent = xzgTh("选择目标图像加载器", "Select target Image Loader");
    dialog.appendChild(title);
    for (const loader of loaders) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${loader.title || loader.type} #${loader.id}`;
        button.style.cssText = "display:block;width:100%;margin:6px 0;padding:8px 14px;text-align:left;background:var(--comfy-input-bg,#333);color:var(--input-text,#ddd);border:1px solid var(--border-color,#555);border-radius:4px;cursor:pointer;font-size:12px;";
        button.addEventListener("click", () => {
            overlay.remove();
            try { appendPosePreviewToLoader(loader, name); }
            catch (error) {
                app?.extensionManager?.toast?.add?.({ title: "发送到图片加载器失败", message: error?.message || String(error), type: "error", life: 4 });
            }
        });
        dialog.appendChild(button);
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = xzgTh("取消", "Cancel");
    cancel.style.cssText = "margin-top:8px;width:100%;padding:6px 16px;background:var(--comfy-input-bg,#333);color:var(--input-text,#ddd);border:1px solid var(--border-color,#555);border-radius:4px;cursor:pointer;font-size:12px;";
    cancel.addEventListener("click", () => overlay.remove());
    dialog.appendChild(cancel);
    overlay.addEventListener("click", event => { if (event.target === overlay) overlay.remove(); });
    overlay.addEventListener("keydown", event => { if (event.key === "Escape") overlay.remove(); });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    cancel.focus();
}

async function sendPosePreviewToImageLoader(node) {
    const blob = await getPosePreviewBlob(node, "png");
    const file = new File([blob], `xzg-pose-${xzgTimestamp()}.png`, { type: "image/png" });
    const body = new FormData();
    body.append("image", file, file.name);
    body.append("type", "input");
    const response = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    if (!result?.name) throw new Error("图片上传没有返回文件名。");
    const loaders = (app.graph?.nodes || []).filter(isPoseImageLoaderEnabled);
    if (!loaders.length) throw new Error("未找到启用中的小珠光图片加载器。");
    const annotatedName = `${result.name} [input]`;
    if (loaders.length === 1) appendPosePreviewToLoader(loaders[0], annotatedName);
    else showPoseImageLoaderDialog(loaders, annotatedName);
}

function installPosePreviewContextMenu() {
    if (window._vnccsPosePreviewContextMenuInstalled) return;
    window._vnccsPosePreviewContextMenuInstalled = true;
    const getPoint = (canvas, event) => {
        try {
            const point = canvas.convertEventToCanvasCoordinates?.(event);
            if (Number.isFinite(point?.[0]) && Number.isFinite(point?.[1])) return point;
        } catch (_) {}
        const rect = canvas.canvas?.getBoundingClientRect?.();
        if (rect && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
            const scale = canvas.ds?.scale || 1;
            return [
                (event.clientX - rect.left) / scale - (canvas.ds?.offset?.[0] || 0),
                (event.clientY - rect.top) / scale - (canvas.ds?.offset?.[1] || 0),
            ];
        }
        return [Number(event.canvasX ?? event.x) || 0, Number(event.canvasY ?? event.y) || 0];
    };
    const getPreviewNode = (canvas, x, y, knownNode = null) => {
        const node = knownNode
            || canvas.getNodeAtPosition?.(x, y)
            || canvas.getNodeAtPos?.(x, y)
            || canvas.graph?.getNodeOnPos?.(x, y);
        if (node?.type !== "VNCCS_PoseStudio") return null;
        const preview = node._vnccsPosePreviewWidget;
        if (!getPosePreviewImageSource(node)) return null;
        const previewRect = preview?._vnccsPreviewRect;
        if (previewRect) {
            if (x >= previewRect.x && x <= previewRect.x + previewRect.width
                && y >= previewRect.y && y <= previewRect.y + previewRect.height) return node;
        }

        // Fallback for LiteGraph versions where the custom widget has not
        // drawn yet: the node's image output preview occupies the body below
        // its controls.
        const visibleWidgets = (node.widgets || []).filter(widget =>
            widget && widget.name !== "_vnccs_pose_image_preview"
                && !widget.hidden && widget.type !== "hidden"
                && widget.computeSize?.(node.size?.[0] || 400)?.[1] !== -4
        );
        const lastWidget = visibleWidgets.at(-1);
        const lastY = Number(lastWidget?.last_y);
        const widgetHeight = Number(lastWidget?.computeSize?.(node.size?.[0] || 400)?.[1]) || 24;
        const contentTop = Number.isFinite(lastY)
            ? (Number(node.pos?.[1]) || 0) + lastY + widgetHeight
            : (Number(node.pos?.[1]) || 0) + Math.max(72, (Number(node.size?.[1]) || 0) * 0.15);
        return x >= (Number(node.pos?.[0]) || 0) + 6
            && x <= (Number(node.pos?.[0]) || 0) + (Number(node.size?.[0]) || 0) - 6
            && y >= contentTop
            && y <= (Number(node.pos?.[1]) || 0) + (Number(node.size?.[1]) || 0)
            ? node : null;
    };
    const openForEvent = (canvas, event, knownNode = null) => {
        const [x, y] = getPoint(canvas, event);
        const node = getPreviewNode(canvas, x, y, knownNode);
        if (!node) return false;
        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        showPosePreviewMenu(node, event.clientX ?? 0, event.clientY ?? 0);
        return true;
    };

    window.addEventListener("contextmenu", event => {
        const canvas = app.canvas;
        const canvasEl = canvas?.canvas;
        if (!canvasEl || (event.target !== canvasEl && !canvasEl.contains?.(event.target))) return;
        openForEvent(canvas, event);
    }, true);

    const installCanvasHooks = () => {
        const CanvasClass = globalThis.LGraphCanvas || globalThis.LiteGraph?.LGraphCanvas || app.canvas?.constructor;
        const prototype = CanvasClass?.prototype;
        if (prototype?.processMouseDown && !prototype._vnccsPosePreviewMouseDownPatched) {
            prototype._vnccsPosePreviewMouseDownPatched = true;
            const original = prototype.processMouseDown;
            prototype.processMouseDown = function (event) {
                if (event?.button === 2 && openForEvent(this, event)) return true;
                return original.apply(this, arguments);
            };
        }
        if (prototype?.processContextMenu && !prototype._vnccsPosePreviewContextPatched) {
            prototype._vnccsPosePreviewContextPatched = true;
            const original = prototype.processContextMenu;
            prototype.processContextMenu = function (node, event) {
                if (openForEvent(this, event || {}, node)) return;
                return original.apply(this, arguments);
            };
        }
    };
    installCanvasHooks();
    window.addEventListener("contextmenu", installCanvasHooks, true);
}

const DEFAULT_POSE_STUDIO_MESH_PROPORTIONS = Object.freeze({
    head_size: 1.0,
    arm_size: 1.0,
    hand_size: 1.0,
    foot_size: 1.0,
    shoulder_l_length: 0.5,
    shoulder_r_length: 0.5,
    hip_l_length: 0.5,
    hip_r_length: 0.5,
    upper_arm_l_length: 0.5,
    upper_arm_r_length: 0.5,
    forearm_l_length: 0.5,
    forearm_r_length: 0.5,
    thigh_l_length: 0.5,
    thigh_r_length: 0.5,
    shin_l_length: 0.5,
    shin_r_length: 0.5,
    spine_length: 0.5,
});
const LEGACY_POSE_STUDIO_MESH_PROPORTION_KEYS = Object.freeze([
    "arm_length",
    "upper_arm_length",
    "forearm_length",
    "leg_length",
    "thigh_length",
    "shin_length",
]);
const SYMMETRIC_MESH_PROPORTION_PAIRS = Object.freeze([
    { left: "shoulder_l_length", right: "shoulder_r_length", label: "Clavicle Length" },
    { left: "hip_l_length", right: "hip_r_length", label: "Hip Offset" },
    { left: "upper_arm_l_length", right: "upper_arm_r_length", label: "Upper Arm Length" },
    { left: "forearm_l_length", right: "forearm_r_length", label: "Forearm Length" },
    { left: "thigh_l_length", right: "thigh_r_length", label: "Thigh Length" },
    { left: "shin_l_length", right: "shin_r_length", label: "Shin Length" },
]);

function normalizeSymmetricMeshProportions(mesh) {
    for (const { left, right } of SYMMETRIC_MESH_PROPORTION_PAIRS) {
        const value = (Number(mesh[left] ?? 0.5) + Number(mesh[right] ?? 0.5)) / 2;
        mesh[left] = value;
        mesh[right] = value;
    }
}

function getVNCCSSharedMorphWorker() {
    if (VNCCS_SHARED_MORPH_WORKER_FAILED || typeof Worker === "undefined") return null;
    if (VNCCS_SHARED_MORPH_WORKER) return VNCCS_SHARED_MORPH_WORKER;

    try {
        const worker = new Worker(VNCCS_POSE_MORPH_WORKER_URL, { type: "module" });
        worker.onmessage = (event) => {
            const message = event.data || {};
            const handler = VNCCS_SHARED_MORPH_CLIENTS.get(message.clientId);
            if (handler) {
                handler(message);
                return;
            }
            if (message.type === "error") {
                for (const callback of VNCCS_SHARED_MORPH_CLIENTS.values()) callback(message);
            }
        };
        worker.onerror = (event) => {
            VNCCS_SHARED_MORPH_WORKER_FAILED = true;
            console.warn("[VNCCS PoseStudio] Shared live morph worker error:", event.message || event);
            for (const callback of VNCCS_SHARED_MORPH_CLIENTS.values()) {
                callback({ type: "error", message: event.message || String(event) });
            }
            try { worker.terminate(); } catch (_) {}
            VNCCS_SHARED_MORPH_WORKER = null;
            VNCCS_SHARED_MORPH_WORKER_WARMED = false;
        };
        VNCCS_SHARED_MORPH_WORKER = worker;
    } catch (error) {
        VNCCS_SHARED_MORPH_WORKER_FAILED = true;
        console.warn("[VNCCS PoseStudio] Shared live morph worker unavailable:", error);
    }

    return VNCCS_SHARED_MORPH_WORKER;
}

// Determine the extension's base URL dynamically to support varied directory names (e.g. ComfyUI_VNCCS_Utils or vnccs-utils)
const EXTENSION_URL = new URL(".", import.meta.url).toString();
// Reference layout captured from the stable studio view: 220px side panel = 16.63%
// of the container and the 37px tab bar = 3.46% of the container height.
const POSE_STUDIO_LAYOUT_BASE_WIDTH = 220 / 0.1663;
const POSE_STUDIO_LAYOUT_BASE_HEIGHT = 37 / 0.0346;
const POSE_STUDIO_LAYOUT_REFERENCE_UI_SCALE = 1.55;

// Enable from DevTools with:
// window.__VNCCS_POSE_RESIZE_PROFILE = { enabled: true }
// Every measured phase is also emitted as a User Timing entry so it appears in
// the Performance flame chart. The profiler is a no-op while disabled.
function profilePoseStudioResize(name, callback) {
    const config = globalThis.__VNCCS_POSE_RESIZE_PROFILE;
    if (!config?.enabled || typeof performance === "undefined") return callback();

    const start = performance.now();
    try {
        return callback();
    } finally {
        const duration = performance.now() - start;
        const stats = config._stats || (config._stats = new Map());
        const current = stats.get(name) || { phase: name, calls: 0, totalMs: 0, maxMs: 0 };
        current.calls += 1;
        current.totalMs += duration;
        current.maxMs = Math.max(current.maxMs, duration);
        stats.set(name, current);

        try {
            performance.measure(`VNCCS Pose resize / ${name}`, {
                start,
                duration,
            });
        } catch (_) {}

        clearTimeout(config._reportTimer);
        config._reportTimer = setTimeout(() => {
            config._reportTimer = null;
            const rows = Array.from(config._stats?.values?.() || []).map(row => ({
                phase: row.phase,
                calls: row.calls,
                totalMs: Number(row.totalMs.toFixed(2)),
                avgMs: Number((row.totalMs / Math.max(1, row.calls)).toFixed(2)),
                maxMs: Number(row.maxMs.toFixed(2)),
            })).sort((a, b) => b.totalMs - a.totalMs);
            config._stats = new Map();
            console.groupCollapsed("VNCCS Pose Studio resize profile");
            console.table(rows);
            console.log("If measured JS phases are fast but frames are still slow, inspect GPU/Paint/Composite in the Performance trace.");
            console.groupEnd();
        }, 350);
    }
}

// === Styles ===
const STYLES = `
/* ===== VNCCS Pose Studio — Green Theme ===== */
/* Variables scoped to the node container — won't leak to other ComfyUI tabs */
.vnccs-pose-studio,
.vnccs-pose-studio *,
.vnccs-ps-fullscreen-host,
.vnccs-ps-fullscreen-host * {
    user-select: none;
    -webkit-user-select: none;
}

.vnccs-pose-studio input,
.vnccs-pose-studio textarea,
.vnccs-pose-studio [contenteditable='true'] {
    user-select: text;
    -webkit-user-select: text;
}

.vnccs-pose-studio {
    --ps-bg:            #0a0a0f;
    --ps-panel:         rgba(16, 14, 24, 0.92);
    --ps-elevated:      #1a1a26;
    --ps-surface:       rgba(30, 28, 44, 0.85);
    --ps-hover:         rgba(42, 40, 60, 0.9);
    --ps-border:        rgba(255, 255, 255, 0.06);
    --ps-border-hover:  rgba(255, 255, 255, 0.14);
    --ps-accent:        #55bb84;
    --ps-accent-hover:  #80dca8;
    --ps-accent-glow:   rgba(85, 187, 132, 0.3);
    --ps-accent-subtle: rgba(85, 187, 132, 0.1);
    --ps-accent-border: rgba(85, 187, 132, 0.22);
    --ps-accent-lavender: #b8a9e8;
    --ps-success: #00d68f;
    --ps-danger:  #ff4757;
    --ps-warning: #ffaa00;
    --ps-text:       #e8e8f0;
    --ps-text-muted: #9898a8;
    --ps-text-dim:   #5e5e70;
    --ps-input-bg:   rgba(255, 255, 255, 0.04);
    --ps-font:       'Sora', -apple-system, BlinkMacSystemFont, sans-serif;
    --ps-font-mono:  'JetBrains Mono', 'Fira Code', monospace;
    --ps-radius-sm:  8px;
    --ps-radius-md:  12px;
    --ps-radius-lg:  16px;
    --ps-transition: 0.2s ease;
    --vnccs-ps-ui-scale: 1;
    --vnccs-ps-relative-ui-scale: 1;
    --vnccs-green: #4fba80;
    --vnccs-green-bright: #78d99f;
    --vnccs-green-soft: rgba(79, 186, 128, 0.14);
    --vnccs-green-border: rgba(79, 186, 128, 0.38);
}

/* Keep all interactive accents in this editor on one green palette. */
.vnccs-pose-studio {
    --ps-accent: #4fba80 !important;
    --ps-accent-hover: #78d99f !important;
    --ps-accent-glow: rgba(79, 186, 128, 0.3) !important;
    --ps-accent-subtle: rgba(79, 186, 128, 0.14) !important;
    --ps-accent-border: rgba(79, 186, 128, 0.38) !important;
    --ps-accent-lavender: #55bb84 !important;
}
.vnccs-pose-studio .vnccs-ps-fullscreen-confirm {
    color: #082115 !important;
    background: var(--vnccs-green) !important;
    border-color: var(--vnccs-green-border) !important;
}
.vnccs-pose-studio .vnccs-ps-fullscreen-confirm:hover {
    background: var(--vnccs-green-bright) !important;
}

/* Main Container */
.vnccs-pose-studio {
    display: flex;
    flex-direction: row;
    width: 100%;
    height: 100%;
    background: var(--ps-bg);
    font-family: var(--ps-font);
    font-size: 13px;
    color: var(--ps-text);
    overflow: hidden;
    box-sizing: border-box;
    pointer-events: none;
    position: relative;
}

.vnccs-ps-fullscreen-host {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    background: var(--ps-bg, #0a0a0f);
}

.vnccs-ps-fullscreen-host > .vnccs-pose-studio {
    width: 100%;
    height: 100%;
    pointer-events: auto;
}

.vnccs-ps-fullscreen-actions {
    position: absolute;
    z-index: 2147483001;
    top: 10px;
    right: 14px;
    display: flex;
    display: flex;
    align-items: center;
    gap: 6px;
}

.vnccs-ps-fullscreen-actions > button {
    box-sizing: border-box;
    flex: 0 0 auto;
    min-width: 86px;
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 10px;
    font-family: inherit;
    font-size: 14px;
    line-height: 1;
    font-weight: 700;
    white-space: nowrap;
    color: #000 !important;
}

.vnccs-ps-fullscreen-host.vnccs-ps-library-open .vnccs-ps-fullscreen-actions {
    display: none;
}

.vnccs-ps-fullscreen-confirm {
    padding: 7px 12px;
    border: 1px solid rgba(85, 187, 132, .38);
    border-radius: 8px;
    color: #e8e8f0;
    background: rgba(10, 10, 15, .88);
    cursor: pointer;
}

.vnccs-ps-fullscreen-confirm {
    color: #ffffff;
    background: #55bb84;
    font-weight: 700;
}

.vnccs-ps-fullscreen-confirm:hover { background: #80dca8; }
.vnccs-ps-fullscreen-confirm:disabled { opacity: .65; cursor: wait; }

.vnccs-ps-fullscreen-library {
    border: 1px solid rgba(255, 152, 48, .45);
    border-radius: 8px;
    color: #ffffff;
    background: #f08a24;
    cursor: pointer;
    font-weight: 700;
}

.vnccs-ps-fullscreen-library:hover { background: #ff9f38; }

.vnccs-ps-fullscreen-save-library {
    width: 142px !important;
    min-width: 142px !important;
    flex-basis: 142px !important;
    border: 1px solid rgba(85, 187, 132, .38);
    border-radius: 8px;
    color: #082115;
    background: #55bb84;
    cursor: pointer;
    font-weight: 700;
}
.vnccs-ps-fullscreen-save-library:hover { background: #80dca8; }

.vnccs-ps-fullscreen-import {
    width: 136px !important;
    min-width: 136px !important;
    flex: 0 0 136px;
    border: 1px solid rgba(90, 163, 235, .5);
    border-radius: 8px;
    color: #fff;
    background: #3479b8;
    cursor: pointer;
    font-weight: 700;
    white-space: nowrap;
}

.vnccs-ps-fullscreen-import:hover { background: #438ed0; }
.vnccs-ps-fullscreen-import:disabled { opacity: .7; cursor: wait; }

.vnccs-ps-fullscreen-library { width: 86px; }
.vnccs-ps-fullscreen-confirm { width: 96px; }

.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-import,
.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-save-library {
    border: 1px solid #5b5b63;
    color: #ffffff !important;
    background: #3b3b42;
}

.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-import:hover,
.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-save-library:hover,
.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-import:active,
.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-save-library:active,
.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-import:focus,
.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-save-library:focus,
.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-import:disabled,
.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-save-library:disabled {
    border-color: #777780;
    color: #ffffff !important;
    background: #4b4b53;
}

.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-close {
    width: 32px;
    min-width: 32px;
    height: 32px;
    flex: 0 0 32px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: #ff4d5a !important;
    font-size: 30px;
    line-height: 30px;
    cursor: pointer;
}

.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-close:hover,
.vnccs-ps-fullscreen-actions > button.vnccs-ps-fullscreen-close:focus-visible {
    background: rgba(255, 77, 90, 0.16);
    color: #ff7882 !important;
}

/* === Left Panel === */
.vnccs-ps-left {
    width: 220px;
    zoom: var(--vnccs-ps-ui-scale);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    overflow-y: auto;
    border-right: 1px solid var(--ps-border);
    background: rgba(6, 5, 12, 0.7);
    pointer-events: auto;
}

.vnccs-ps-left::-webkit-scrollbar { width: 4px; }
.vnccs-ps-left::-webkit-scrollbar-thumb { background: var(--ps-accent-border); border-radius: 2px; }

/* === Center Panel (Canvas) === */
.vnccs-ps-center {
    flex: 1;
    min-width: 0;      /* prevent flex auto-expansion beyond node width */
    min-height: 0;     /* allow shrinking in nested flex column */
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    z-index: 2;
    pointer-events: auto;
}

/* === Right Sidebar === */
.vnccs-ps-right-sidebar {
    width: 220px;
    box-sizing: border-box;
    zoom: var(--vnccs-ps-ui-scale);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    overflow-y: auto;
    border-left: 1px solid var(--ps-border);
    pointer-events: auto;
    background: rgba(6, 5, 12, 0.7);
    position: relative;
    z-index: 1;
}

.vnccs-ps-right-sidebar::-webkit-scrollbar { width: 4px; }
.vnccs-ps-right-sidebar::-webkit-scrollbar-thumb { background: var(--ps-accent-border); border-radius: 2px; }

.vnccs-ps-fullscreen-host .vnccs-ps-right-sidebar {
    padding-top: 64px;
}

/* === Section Component — Glassmorphic === */
.vnccs-ps-section {
    background: rgba(20, 16, 30, 0.72);
    border: 1px solid var(--ps-accent-border);
    border-radius: var(--ps-radius-md);
    overflow: visible;
    flex-shrink: 0;
    position: relative;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}

/* Lighting UI Styles */
.vnccs-ps-light-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 15px;
    padding-right: 4px;
    padding-bottom: 8px;
}

/* Light Card */
.vnccs-ps-light-card {
    background: rgba(20, 16, 30, 0.7);
    border: 1px solid var(--ps-border);
    border-radius: var(--ps-radius-sm);
    overflow: hidden;
    box-shadow: 0 4px 14px rgba(0,0,0,0.25);
    transition: all var(--ps-transition);
}
.vnccs-ps-light-card:hover {
    border-color: var(--ps-border-hover);
    box-shadow: 0 6px 20px rgba(0,0,0,0.35);
    transform: translateY(-1px);
}

/* Header */
.vnccs-ps-light-header {
    background: rgba(0,0,0,0.2);
    padding: 6px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--ps-border);
}
.vnccs-ps-light-title {
    font-weight: 600;
    font-size: 10px;
    color: var(--ps-text);
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--ps-font);
}
.vnccs-ps-light-icon {
    font-size: 14px;
    opacity: 0.8;
}

/* Remove Button */
.vnccs-ps-light-remove {
    width: 20px; height: 20px;
    border-radius: 5px;
    background: transparent;
    color: var(--ps-text-dim);
    border: 1px solid transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    transition: all var(--ps-transition);
    padding: 0;
}
.vnccs-ps-light-remove:hover {
    background: rgba(255, 71, 87, 0.12);
    color: #ff4757;
    border-color: rgba(255, 71, 87, 0.3);
}

/* Body */
.vnccs-ps-light-body {
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

/* Controls Grid */
.vnccs-ps-light-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(40px, 0.75fr);
    gap: 8px;
    align-items: center;
    min-width: 0;
}

/* Input Styles */
.vnccs-ps-light-select {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    border-radius: 6px;
    color: var(--ps-text);
    font-size: 10px;
    padding: 4px 22px 4px 7px;
    font-family: var(--ps-font);
    cursor: pointer;
    transition: border-color var(--ps-transition);
    text-overflow: ellipsis;
}
.vnccs-ps-light-select:focus { border-color: var(--ps-accent-border); outline: none; }

.vnccs-ps-light-color {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    height: 22px;
    border: 1px solid var(--ps-border);
    border-radius: 6px;
    padding: 2px;
    cursor: pointer;
    background: var(--ps-input-bg);
    transition: border-color var(--ps-transition);
}

.vnccs-ps-light-color:hover { border-color: var(--ps-accent-border); }

/* Sliders */
.vnccs-ps-light-slider-row {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) 42px;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.vnccs-ps-light-slider {
    width: 100%;
    min-width: 0;
    height: 3px;
    background: rgba(255,255,255,0.1);
    border-radius: 2px;
    -webkit-appearance: none;
}
.vnccs-ps-light-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px; height: 12px;
    border-radius: 50%;
    background: var(--ps-accent);
    cursor: pointer;
    box-shadow: 0 0 5px var(--ps-accent-glow);
}

/* Position Grid */
.vnccs-ps-light-pos-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 10px;
    align-items: center;
    background: rgba(0,0,0,0.25);
    padding: 8px;
    border-radius: var(--ps-radius-sm);
    border: 1px solid var(--ps-border);
}
.vnccs-ps-light-pos-label {
    font-size: 9px;
    color: var(--ps-text-muted);
    font-weight: 700;
    width: 10px;
}
.vnccs-ps-light-value {
    width: 42px;
    min-width: 42px;
    box-sizing: border-box;
    text-align: right;
    font-size: 9px;
    color: var(--ps-accent);
    font-family: var(--ps-font-mono);
}

/* Light Radar */
.vnccs-ps-light-radar-wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: rgba(0,0,0,0.35);
    padding: 10px;
    border-radius: var(--ps-radius-sm);
    border: 1px solid var(--ps-border);
}
.vnccs-ps-light-radar-main {
    display: flex;
    align-items: center;
    gap: 12px;
    justify-content: center;
    width: 100%;
}
.vnccs-ps-light-radar-canvas {
    border-radius: 50%;
    border: 1px solid var(--ps-border);
    cursor: crosshair;
    background: rgba(8, 6, 14, 0.9);
    box-shadow: inset 0 0 12px rgba(0,0,0,0.6), 0 0 8px rgba(255,143,163,0.05);
    flex-shrink: 0;
}
.vnccs-ps-light-slider-vert-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    height: 100px;
    width: 35px;
    flex-shrink: 0;
}
.vnccs-ps-light-slider-vert {
    -webkit-appearance: slider-vertical;
    appearance: slider-vertical;
    writing-mode: vertical-lr;
    direction: rtl;
    width: 6px;
    height: 70px;
    cursor: pointer;
    background: rgba(255,255,255,0.1);
    margin: 0;
}
.vnccs-ps-light-slider-vert::-webkit-slider-runnable-track {
    background: transparent;
}
.vnccs-ps-light-slider-vert::-webkit-slider-thumb {
    width: 12px; height: 12px;
}
.vnccs-ps-light-h-val {
    font-size: 10px;
    color: var(--ps-accent);
    height: 12px;
    line-height: 12px;
    font-family: var(--ps-font-mono);
}
.vnccs-ps-light-h-label {
    font-size: 9px;
    color: var(--ps-text-dim);
    font-weight: 700;
    height: 12px;
    line-height: 12px;
}
.vnccs-ps-light-angle-readout {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-self: stretch;
    color: var(--ps-accent);
    font-size: 9px;
    line-height: 12px;
    font-family: var(--ps-font-mono);
}

/* Luminous top highlight */
.vnccs-ps-section::before {
    content: '';
    position: absolute;
    top: 0; left: 14%; right: 14%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(85, 187, 132, 0.55), transparent);
    border-radius: 1px;
    pointer-events: none;
    z-index: 1;
}

.vnccs-ps-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 10px;
    background: rgba(0, 0, 0, 0.22);
    border-bottom: 1px solid var(--ps-border);
    cursor: pointer;
    user-select: none;
    border-radius: var(--ps-radius-md) var(--ps-radius-md) 0 0;
    overflow: hidden;
}

.vnccs-ps-section-title {
    font-size: 14px;
    font-weight: 700;
    color: #78d99f !important;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    display: flex;
    align-items: center;
    gap: 7px;
}

.vnccs-ps-section-title::before {
    content: '';
    width: 3px;
    height: 10px;
    background: linear-gradient(180deg, var(--ps-accent), var(--ps-accent-lavender));
    border-radius: 2px;
    box-shadow: 0 0 6px var(--ps-accent-glow);
    flex-shrink: 0;
}

.vnccs-ps-section-toggle {
    font-size: 12px;
    color: var(--ps-text-muted);
    transition: transform var(--ps-transition);
}

.vnccs-ps-section.collapsed .vnccs-ps-section-toggle {
    transform: rotate(-90deg);
}

.vnccs-ps-section-content {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    pointer-events: auto;
}

.vnccs-ps-section.collapsed .vnccs-ps-section-content {
    display: none;
}

/* === Form Fields === */
.vnccs-ps-field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    pointer-events: auto;
}

.vnccs-ps-label {
    font-size: 11px;
    color: var(--ps-text-muted);
    text-transform: uppercase;
    font-weight: 700;
    letter-spacing: 0.8px;
}

.vnccs-ps-value {
    font-size: 11px;
    color: var(--ps-accent);
    margin-left: auto;
    font-family: var(--ps-font-mono);
}

.vnccs-ps-label-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.vnccs-ps-checkbox-field {
    flex-direction: row;
    align-items: center;
    gap: 7px;
    min-height: 20px;
}

.vnccs-ps-checkbox-field input[type="checkbox"] {
    margin: 0;
    accent-color: var(--ps-accent);
    cursor: pointer;
}

.vnccs-ps-checkbox-field .vnccs-ps-label {
    cursor: pointer;
}

/* Slider */
.vnccs-ps-slider-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    border-radius: var(--ps-radius-sm);
    padding: 4px 8px;
    pointer-events: auto;
    transition: border-color var(--ps-transition);
}

.vnccs-ps-slider-wrap:hover {
    border-color: var(--ps-border-hover);
}

.vnccs-ps-slider {
    flex: 1;
    -webkit-appearance: none;
    appearance: none;
    height: 3px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    cursor: pointer;
    pointer-events: auto;
}

.vnccs-ps-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 13px;
    height: 13px;
    background: var(--ps-accent);
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 0 6px var(--ps-accent-glow);
    transition: box-shadow var(--ps-transition);
}

.vnccs-ps-slider::-webkit-slider-thumb:hover {
    box-shadow: 0 0 12px var(--ps-accent-glow);
}

.vnccs-ps-slider::-moz-range-thumb {
    width: 13px;
    height: 13px;
    background: var(--ps-accent);
    border-radius: 50%;
    cursor: pointer;
    border: none;
    box-shadow: 0 0 6px var(--ps-accent-glow);
}

.vnccs-ps-slider-val {
    width: 35px;
    text-align: right;
    font-size: 12px;
    color: var(--ps-accent);
    background: transparent;
    border: none;
    font-family: var(--ps-font-mono);
}

/* Input */
.vnccs-ps-input {
    background: var(--ps-input-bg);
    border: 1px solid var(--ps-border);
    color: var(--ps-text);
    border-radius: var(--ps-radius-sm);
    padding: 5px 8px;
    font-family: var(--ps-font);
    font-size: 12px;
    width: 100%;
    box-sizing: border-box;
    transition: all var(--ps-transition);
}

.vnccs-ps-input:focus {
    outline: none;
    border-color: var(--ps-accent-border);
    background: rgba(85, 187, 132, 0.03);
    box-shadow: 0 0 0 2px rgba(85, 187, 132, 0.06);
}

/* Toggle */
.vnccs-ps-toggle {
    display: flex;
    gap: 2px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: var(--ps-radius-sm);
    padding: 2px;
    border: 1px solid var(--ps-border);
}

.vnccs-ps-toggle-btn {
    flex: 1;
    border: none;
    padding: 4px 8px;
    cursor: pointer;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    font-family: var(--ps-font);
    transition: all var(--ps-transition);
    background: transparent;
    color: var(--ps-text-muted);
}

.vnccs-ps-toggle-btn.active {
    background: linear-gradient(135deg, var(--ps-accent), var(--ps-accent-hover));
    color: #1a1525;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12), 0 2px 8px var(--ps-accent-glow);
}

.vnccs-ps-toggle-btn.male.active {
    background: linear-gradient(135deg, var(--ps-accent), var(--ps-accent-hover));
    box-shadow: 0 2px 8px var(--ps-accent-glow);
}

.vnccs-ps-toggle-btn.female.active {
    background: linear-gradient(135deg, var(--ps-accent), var(--ps-accent-hover));
    box-shadow: 0 2px 8px var(--ps-accent-glow);
}

.vnccs-ps-toggle-btn.list.active {
    background: linear-gradient(135deg, #64d8cb, #a0ede6);
    box-shadow: 0 2px 8px rgba(100, 216, 203, 0.3);
}

.vnccs-ps-toggle-btn.grid.active {
    background: linear-gradient(135deg, #ffb347, #ffd580);
    box-shadow: 0 2px 8px rgba(255, 179, 71, 0.3);
}

/* Input Row */
.vnccs-ps-row {
    display: flex;
    gap: 8px;
}

.vnccs-ps-row > * {
    flex: 1;
}

.vnccs-ps-dimension-presets {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    margin-top: 2px;
}

.vnccs-ps-dimension-preset-group + .vnccs-ps-dimension-preset-group {
    margin-top: 8px;
}

.vnccs-ps-dimension-preset-group-title {
    margin: 0 0 5px;
    color: var(--ps-text-muted);
    font-size: 11px;
    font-weight: 700;
}

.vnccs-ps-output-dimensions input[type="number"] {
    appearance: textfield;
    -moz-appearance: textfield;
}

.vnccs-ps-output-dimensions input[type="number"]::-webkit-inner-spin-button,
.vnccs-ps-output-dimensions input[type="number"]::-webkit-outer-spin-button {
    margin: 0;
    -webkit-appearance: none;
}

.vnccs-ps-dimension-preset {
    min-width: 0;
    padding: 6px 4px;
    font-size: 12px;
    white-space: nowrap;
}

/* === Characters === */
.vnccs-ps-character-slots {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 5px;
}

.vnccs-ps-background-section .vnccs-ps-section-title,
.vnccs-ps-characters-section .vnccs-ps-section-title {
    color: var(--ps-accent);
    letter-spacing: 0.4px;
}

.vnccs-ps-output-dimensions .vnccs-ps-section-title {
    color: var(--ps-accent);
    letter-spacing: 0.4px;
}

.vnccs-ps-character-slot {
    min-width: 0;
    height: 30px;
    border: 1px solid var(--ps-border);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.25);
    color: var(--ps-text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    font: 700 10px var(--ps-font-mono);
    transition: border-color var(--ps-transition), background var(--ps-transition), box-shadow var(--ps-transition);
}

.vnccs-ps-character-slot:hover:not(:disabled) {
    border-color: var(--ps-border-hover);
    background: rgba(85, 187, 132, 0.06);
}

.vnccs-ps-character-slot.active {
    border-color: var(--ps-accent);
    color: var(--ps-text);
    background: rgba(85, 187, 132, 0.1);
    box-shadow: 0 0 0 1px rgba(85, 187, 132, 0.18), 0 0 10px rgba(85, 187, 132, 0.12);
}

.vnccs-ps-character-slot.empty {
    border-style: dashed;
    font-size: 18px;
}

.vnccs-ps-character-slot:disabled {
    opacity: 0.32;
    cursor: default;
}

.vnccs-ps-character-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.55);
    box-shadow: 0 0 6px currentColor;
    flex: 0 0 auto;
}

.vnccs-ps-character-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 68px;
    gap: 6px;
}

.vnccs-ps-character-color-control {
    min-width: 0;
    height: 34px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 8px 4px 5px;
    border: 1px solid var(--ps-border);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.025);
    cursor: pointer;
    transition: border-color var(--ps-transition), background var(--ps-transition), box-shadow var(--ps-transition);
}

.vnccs-ps-character-color-control:hover,
.vnccs-ps-character-color-control:focus-within {
    border-color: var(--ps-accent-border);
    background: rgba(85, 187, 132, 0.045);
    box-shadow: 0 0 0 1px rgba(85, 187, 132, 0.06);
}

.vnccs-ps-character-color-input {
    width: 25px;
    height: 25px;
    flex: 0 0 25px;
    box-sizing: border-box;
    padding: 2px;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.28);
    cursor: pointer;
}

.vnccs-ps-character-color-input::-webkit-color-swatch-wrapper { padding: 0; }
.vnccs-ps-character-color-input::-webkit-color-swatch { border: 0; border-radius: 4px; }
.vnccs-ps-character-color-input::-moz-color-swatch { border: 0; border-radius: 4px; }

.vnccs-ps-character-color-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ps-text);
    font: 700 9px var(--ps-font);
    white-space: nowrap;
}

.vnccs-ps-character-remove {
    width: 68px;
    height: 34px;
    padding: 0 11px;
    border: 1px solid rgba(50, 150, 95, 0.42);
    border-radius: 8px;
    background: rgba(40, 140, 85, 0.1);
    color: #4cae78;
    cursor: pointer;
    font: 700 9px var(--ps-font);
    transition: border-color var(--ps-transition), background var(--ps-transition), color var(--ps-transition);
}

.vnccs-ps-character-remove:hover:not(:disabled) {
    border-color: rgba(65, 165, 105, 0.72);
    background: rgba(40, 140, 85, 0.18);
    color: #78cd9d;
}

.vnccs-ps-character-remove:focus-visible {
    outline: 1px solid #4cae78;
    outline-offset: 2px;
}

.vnccs-ps-character-remove:disabled {
    opacity: 0.3;
    cursor: default;
}

.vnccs-ps-characters-busy {
    opacity: 0.55;
    pointer-events: none;
}

/* === Tab Bar === */
.vnccs-ps-tabs-shell {
    position: relative;
    display: none;
    align-items: stretch;
    zoom: var(--vnccs-ps-ui-scale);
    background: rgba(0, 0, 0, 0.35);
    border-bottom: 1px solid var(--ps-border);
    flex-shrink: 0;
    min-width: 0;
}

.vnccs-ps-tabs {
    display: flex;
    align-items: flex-end;
    padding: 8px 10px 0;
    gap: 3px;
    overflow-x: auto;
    overflow-y: hidden;
    flex: 1;
    min-width: 0;
    scroll-behavior: smooth;
    scrollbar-width: none;
    -ms-overflow-style: none;
}

.vnccs-ps-tabs::-webkit-scrollbar {
    width: 0;
    height: 0;
    display: none;
}

.vnccs-ps-tab-scroll {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 30px;
    border: none;
    background: transparent;
    color: var(--ps-accent);
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    display: none;
    align-items: center;
    justify-content: center;
    transition: all var(--ps-transition);
    z-index: 4;
    box-shadow: none;
}

.vnccs-ps-tab-scroll.left {
    left: 0;
}

.vnccs-ps-tab-scroll.right {
    right: 0;
}

.vnccs-ps-tab-scroll.visible {
    display: flex;
}

.vnccs-ps-tab-scroll:disabled {
    opacity: 0.28;
    cursor: default;
    pointer-events: none;
}

.vnccs-ps-tab-scroll:hover {
    color: var(--ps-accent);
    background: transparent;
}

.vnccs-ps-tab {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--ps-border);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    color: var(--ps-text-muted);
    cursor: pointer;
    font-size: 12px;
    font-family: var(--ps-font);
    font-weight: 600;
    white-space: nowrap;
    transition: all var(--ps-transition);
}

.vnccs-ps-tab:hover {
    background: rgba(85, 187, 132, 0.08);
    color: var(--ps-text);
    border-color: var(--ps-accent-border);
}

.vnccs-ps-reset-btn {
    width: 20px;
    height: 20px;
    background: transparent;
    border: 1px solid var(--ps-border);
    color: var(--ps-text-muted);
    border-radius: 5px;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: all var(--ps-transition);
}

.vnccs-ps-reset-btn:hover {
    color: var(--ps-accent);
    border-color: var(--ps-accent-border);
    background: var(--ps-accent-subtle);
}

/* Large Add Btn */
.vnccs-ps-btn-add-large {
    width: 100%;
    padding: 8px;
    background: rgba(85, 187, 132, 0.04);
    border: 1px dashed var(--ps-accent-border);
    border-radius: var(--ps-radius-sm);
    color: var(--ps-text-dim);
    cursor: pointer;
    font-size: 13px;
    font-family: var(--ps-font);
    transition: all var(--ps-transition);
    margin-top: 5px;
}
.vnccs-ps-btn-add-large:hover {
    border-color: var(--ps-accent);
    color: var(--ps-accent);
    background: var(--ps-accent-subtle);
}

.vnccs-ps-tab.active {
    background: rgba(85, 187, 132, 0.12);
    color: var(--ps-accent);
    border-color: var(--ps-accent-border);
    border-bottom: 1px solid rgba(16, 14, 24, 0.92);
    margin-bottom: -1px;
    box-shadow: 0 -3px 10px rgba(85, 187, 132, 0.1);
}

.vnccs-ps-tab-close {
    font-size: 16px;
    line-height: 1;
    color: var(--ps-text-muted);
    cursor: pointer;
    opacity: 0.6;
    transition: all var(--ps-transition);
}

.vnccs-ps-tab-close:hover {
    color: var(--ps-danger);
    opacity: 1;
}

.vnccs-ps-tab-add {
    padding: 5px 10px;
    background: transparent;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 8px 8px 0 0;
    color: var(--ps-text-muted);
    cursor: pointer;
    font-size: 18px;
    font-family: var(--ps-font);
    transition: all var(--ps-transition);
    line-height: 1;
}

.vnccs-ps-tab-add:hover {
    background: var(--ps-accent-subtle);
    border-color: var(--ps-accent-border);
    color: var(--ps-accent);
}

/* === SAM Camera Banner === */
.vnccs-ps-sam-cam-banner {
    display: none;
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 6px 18px;
    cursor: pointer;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.02em;
    user-select: none;
    background: rgba(20, 16, 30, 0.92);
    color: #ffaa33;
    border: 1px solid rgba(255, 150, 40, 0.55);
    border-radius: 6px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.55);
    backdrop-filter: blur(6px);
    transition: color 0.15s, border-color 0.15s;
    white-space: nowrap;
    pointer-events: auto;
}
.vnccs-ps-sam-cam-banner.vnccs-sam-visible { display: flex; }
.vnccs-ps-sam-cam-banner.vnccs-sam-paused {
    color: rgba(160, 140, 120, 0.6);
    border-color: rgba(120, 100, 80, 0.35);
}
.vnccs-ps-sam-cam-banner .vnccs-sam-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #ffaa33;
    flex-shrink: 0;
    box-shadow: 0 0 6px #ffaa33;
}
.vnccs-ps-sam-cam-banner.vnccs-sam-paused .vnccs-sam-dot {
    background: #555;
    box-shadow: none;
}

/* === 3D Canvas === */
.vnccs-ps-canvas-wrap {
    flex: 1;
    position: relative;
    overflow: hidden;
    contain: paint;
    /* NOTE: no flex centering here — canvas must fill 100% of container, not be letterboxed */
    background:
        radial-gradient(circle, rgba(85, 187, 132, 0.04) 1px, transparent 1px),
        linear-gradient(180deg, #080810 0%, #0d0b18 100%);
    background-size: 22px 22px, 100% 100%;
}

.vnccs-ps-canvas-wrap canvas {
    /* NOTE: must be 100% not max-width/max-height — viewer fills full container */
    width: 100% !important;
    height: 100% !important;
    display: block;
}

/* === Action Bar === */
.vnccs-ps-actions {
    position: absolute;
    z-index: 20;
    box-sizing: border-box;
    display: flex;
    flex-wrap: nowrap;
    justify-content: center;
    align-items: center;
    zoom: var(--vnccs-ps-ui-scale);
    gap: 5px;
    padding: 7px 8px;
    border: none;
    border-radius: 0;
    background: transparent;
    pointer-events: none;
    transition: left 80ms linear, top 80ms linear, width 80ms linear;
}

.vnccs-ps-actions .vnccs-ps-btn,
.vnccs-ps-actions .vnccs-ps-btn:hover,
.vnccs-ps-actions .vnccs-ps-btn:focus-visible,
.vnccs-ps-actions .vnccs-ps-btn.primary,
.vnccs-ps-actions .vnccs-ps-btn.primary:hover,
.vnccs-ps-actions .vnccs-ps-btn.primary:focus-visible {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    transform: none;
    color: var(--ps-text);
}

.vnccs-ps-actions .vnccs-ps-btn:hover,
.vnccs-ps-actions .vnccs-ps-btn:focus-visible {
    color: var(--ps-accent);
}

.vnccs-ps-actions .vnccs-ps-btn.primary::after {
    display: none;
}

.vnccs-ps-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--ps-border);
    border-radius: var(--ps-radius-sm);
    color: var(--ps-text);
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    font-family: var(--ps-font);
    transition: all var(--ps-transition);
}

.vnccs-ps-btn:hover {
    background: rgba(255, 255, 255, 0.09);
    border-color: var(--ps-border-hover);
    transform: translateY(-1px);
}

.vnccs-ps-btn.primary {
    background: linear-gradient(135deg, var(--ps-accent) 0%, var(--ps-accent-hover) 100%);
    border-color: var(--ps-accent);
    color: #1a1525;
    font-weight: 700;
    box-shadow: 0 3px 12px var(--ps-accent-glow);
    position: relative;
    overflow: hidden;
}

.vnccs-ps-btn.primary::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.18) 45%, rgba(255,255,255,0.28) 50%, rgba(255,255,255,0.18) 55%, transparent 100%);
    transform: translateX(-120%) skewX(-15deg);
    animation: ps-btn-shimmer 3.5s ease-in-out infinite;
    pointer-events: none;
}

@keyframes ps-btn-shimmer {
    0%  { transform: translateX(-120%) skewX(-15deg); opacity: 1; }
    35% { transform: translateX(120%) skewX(-15deg); opacity: 1; }
    100%{ transform: translateX(120%) skewX(-15deg); opacity: 0; }
}

.vnccs-ps-btn.primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px var(--ps-accent-glow);
}

.vnccs-ps-btn.danger {
    background: rgba(50, 150, 95, 0.12);
    border-color: rgba(50, 150, 95, 0.3);
    color: #ff4757;
}

.vnccs-ps-btn.danger:hover {
    background: #ff4757;
    border-color: #ff4757;
    color: white;
}

.vnccs-ps-btn--sync-tabs {
    background: rgba(80, 120, 200, 0.18);
    border-color: rgba(100, 150, 255, 0.35);
    color: #8ab4ff;
}

.vnccs-ps-btn--sync-tabs:hover {
    background: rgba(80, 120, 200, 0.32);
    border-color: rgba(100, 150, 255, 0.6);
    color: #b8d0ff;
}

.vnccs-ps-btn-icon {
    font-size: 16px;
    line-height: 1;
}

/* === Modal Dialog === */
.vnccs-ps-modal-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
    pointer-events: auto;
}

.vnccs-ps-modal {
    background: rgba(18, 14, 28, 0.95);
    border: 1px solid var(--ps-accent-border);
    border-radius: var(--ps-radius-lg);
    width: 340px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(85, 187, 132, 0.05);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0;
    position: relative;
}

.vnccs-ps-modal::before {
    content: '';
    position: absolute;
    top: 0; left: 15%; right: 15%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(85, 187, 132, 0.6), transparent);
    pointer-events: none;
}

.vnccs-ps-actions .vnccs-ps-btn {
    flex: 0 0 auto;
    min-width: 40px;
    gap: calc(5px * var(--vnccs-ps-toolbar-scale, 1));
    padding: calc(6px * var(--vnccs-ps-toolbar-scale, 1)) calc(8px * var(--vnccs-ps-toolbar-scale, 1));
    font-size: calc(16px * var(--vnccs-ps-toolbar-scale, 1));
    white-space: nowrap;
    pointer-events: auto;
}

.vnccs-ps-actions .vnccs-ps-view-btn {
    flex: 0 0 auto;
    padding: calc(6px * var(--vnccs-ps-toolbar-scale, 1)) calc(8px * var(--vnccs-ps-toolbar-scale, 1));
}

.vnccs-ps-actions .vnccs-ps-btn-redo {
    margin-left: 0;
}


.vnccs-ps-actions .vnccs-ps-btn-icon {
    font-size: calc(18px * var(--vnccs-ps-toolbar-scale, 1));
}

.vnccs-ps-actions .vnccs-ps-btn-reset-view,
.vnccs-ps-actions .vnccs-ps-btn-reset-view:hover,
.vnccs-ps-actions .vnccs-ps-btn-reset-view:focus-visible {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    transform: none;
    text-shadow: none;
}

.vnccs-ps-actions .vnccs-ps-btn-reset-view:hover,
.vnccs-ps-actions .vnccs-ps-btn-reset-view:focus-visible {
    color: var(--ps-accent);
}

.vnccs-ps-actions .vnccs-ps-btn-reset-view,
.vnccs-ps-actions .vnccs-ps-btn-reset-view:hover,
.vnccs-ps-actions .vnccs-ps-btn-reset-view:focus-visible {
    color: #ffd45e !important;
    text-shadow: 0 0 6px rgba(255, 205, 74, .7), 0 0 14px rgba(255, 184, 40, .48);
}

.vnccs-ps-actions .vnccs-ps-btn-reset-view:hover,
.vnccs-ps-actions .vnccs-ps-btn-reset-view:focus-visible {
    color: #ffe69a !important;
    text-shadow: 0 0 8px rgba(255, 218, 106, .95), 0 0 18px rgba(255, 184, 40, .72);
}

/* Keep the library button from shifting into nearby controls on hover. */
.vnccs-ps-library-trigger:hover {
    transform: none !important;
}

.vnccs-ps-modal-title {
    background: rgba(0, 0, 0, 0.3);
    padding: 12px 16px;
    border-bottom: 1px solid var(--ps-border);
    font-size: 15px;
    font-weight: 700;
    color: var(--ps-accent);
    margin: 0;
    font-family: var(--ps-font);
    letter-spacing: 0.5px;
}

.vnccs-ps-modal-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
}

.vnccs-ps-modal-btn {
    padding: 10px 12px;
    border: 1px solid var(--ps-border);
    background: rgba(255, 255, 255, 0.04);
    color: var(--ps-text);
    border-radius: var(--ps-radius-sm);
    cursor: pointer;
    text-align: left;
    transition: all var(--ps-transition);
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--ps-font);
    font-size: 13px;
}

.vnccs-ps-modal-btn:hover {
    background: var(--ps-accent-subtle);
    border-color: var(--ps-accent-border);
    color: var(--ps-accent-hover);
}

.vnccs-ps-modal.vnccs-ps-category-manager {
    width: min(1120px, calc(100% - 48px));
    max-width: none;
    height: min(720px, calc(100% - 48px));
    max-height: calc(100% - 48px);
    display: flex;
    flex-direction: column;
    border-radius: 18px;
    overflow: hidden;
    font-size: 14px;
}
.vnccs-ps-category-header { display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid var(--ps-border);cursor:move;touch-action:none;user-select:none;flex-shrink:0; }
.vnccs-ps-category-resize { position:absolute;right:0;bottom:0;width:24px;height:24px;cursor:nwse-resize;touch-action:none;background:repeating-linear-gradient(135deg,transparent 0 3px,var(--ps-accent) 3px 5px);clip-path:polygon(100% 0,100% 100%,0 100%);opacity:.65; }
.vnccs-ps-category-header .vnccs-ps-modal-title { background:none;border:0;padding:0;font-size:20px; }
.vnccs-ps-category-add { display:flex;align-items:flex-end;gap:12px;padding:20px 24px 0; }
.vnccs-ps-category-add label { display:flex;flex:1;min-width:0;flex-direction:column;gap:8px;color:var(--ps-text); }
.vnccs-ps-category-add .vnccs-ps-input { width:100%;box-sizing:border-box;height:42px;font-size:14px; }
.vnccs-ps-category-manager .vnccs-ps-modal-btn { justify-content:center;white-space:nowrap;min-height:38px; }
.vnccs-ps-category-manager .vnccs-ps-modal-btn.primary { background:var(--ps-accent);color:#092016;border-color:var(--ps-accent); }
.vnccs-ps-category-manager .vnccs-ps-modal-btn.primary:hover { background:var(--ps-accent-hover); }
.vnccs-ps-category-message { padding:8px 24px;min-height:20px;color:var(--ps-accent-hover); }
.vnccs-ps-category-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));align-content:start;gap:8px;flex:1;min-height:0;overflow:auto;padding:0 24px 16px; }
.vnccs-ps-category-card { display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:2px 10px;align-items:center;padding:8px 12px;border:1px solid var(--ps-border);border-radius:8px;background:rgba(255,255,255,.025);cursor:grab;transition:border-color .12s,background .12s,opacity .12s; }
.vnccs-ps-category-card:active { cursor:grabbing; }
.vnccs-ps-category-card.is-fixed { cursor:default; }
.vnccs-ps-category-card.dragging { opacity:.4; }
.vnccs-ps-category-card.drag-over { border-color:var(--ps-accent);background:var(--ps-accent-subtle); }
.vnccs-ps-category-name { grid-column:1;grid-row:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;color:var(--ps-text); }
.vnccs-ps-category-count { grid-column:1;color:var(--ps-text-muted);font-size:12px; }
.vnccs-ps-category-drag-handle { grid-column:2;grid-row:1 / 3;color:var(--ps-text-muted);font-size:21px;cursor:grab;user-select:none; }
.vnccs-ps-category-actions { grid-column:3;grid-row:1 / 3;display:flex;align-items:center;gap:5px; }
.vnccs-ps-category-card .vnccs-ps-modal-btn { grid-column:auto;grid-row:auto;min-height:30px;padding:5px 9px; }
.vnccs-ps-category-card .category-remove { color:#f39797;border-color:rgba(240,110,110,.25); }
.vnccs-ps-category-card .category-remove:hover { background:rgba(240,110,110,.12); }
.vnccs-ps-category-card .vnccs-ps-modal-btn:disabled { opacity:.45;cursor:default; }
.vnccs-ps-category-footer { display:flex;align-items:center;gap:24px;justify-content:space-between;padding:16px 24px;border-top:1px solid var(--ps-border); }
.vnccs-ps-category-footer span { max-width:700px;color:var(--ps-text-muted);font-size:12px;line-height:1.6; }
@media(max-width:600px) {
    .vnccs-ps-modal.vnccs-ps-category-manager { width:calc(100% - 24px);height:calc(100% - 24px);max-height:calc(100% - 24px); }
    .vnccs-ps-category-header,.vnccs-ps-category-footer { padding:12px 16px; }
    .vnccs-ps-category-add { padding:16px 16px 0;flex-wrap:wrap; }
    .vnccs-ps-category-add label { flex-basis:100%; }
    .vnccs-ps-category-message { padding-left:16px;padding-right:16px; }
    .vnccs-ps-category-grid { grid-template-columns:1fr;padding-left:16px;padding-right:16px; }
}

.vnccs-ps-save-library-modal {
    --vnccs-ps-save-scale: clamp(0.72, var(--vnccs-ps-relative-ui-scale), 1.15);
    width: min(calc(380px * var(--vnccs-ps-save-scale)), calc(100% - 24px));
    max-height: calc(100% - 24px);
    border-radius: calc(14px * var(--vnccs-ps-save-scale));
}

.vnccs-ps-save-library-modal .vnccs-ps-modal-title {
    flex: 0 0 auto;
    padding: calc(11px * var(--vnccs-ps-save-scale)) calc(14px * var(--vnccs-ps-save-scale));
    font-size: calc(14px * var(--vnccs-ps-save-scale));
    line-height: 1.25;
    letter-spacing: 0;
}

.vnccs-ps-save-library-modal .vnccs-ps-modal-content {
    min-height: 0;
    gap: calc(9px * var(--vnccs-ps-save-scale));
    padding: calc(12px * var(--vnccs-ps-save-scale)) calc(14px * var(--vnccs-ps-save-scale));
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
}

.vnccs-ps-save-library-field {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: calc(4px * var(--vnccs-ps-save-scale));
}

.vnccs-ps-save-library-field > span:first-child,
.vnccs-ps-save-library-label {
    color: var(--ps-text-muted);
    font-size: calc(11px * var(--vnccs-ps-save-scale));
    font-weight: 700;
    line-height: 1.2;
}

.vnccs-ps-save-library-meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(calc(120px * var(--vnccs-ps-save-scale)), 1fr));
    gap: calc(8px * var(--vnccs-ps-save-scale));
}

.vnccs-ps-save-library-modal .vnccs-ps-input {
    box-sizing: border-box;
    width: 100%;
    min-height: calc(34px * var(--vnccs-ps-save-scale));
    padding: calc(7px * var(--vnccs-ps-save-scale)) calc(9px * var(--vnccs-ps-save-scale));
    border-radius: calc(8px * var(--vnccs-ps-save-scale));
    font-size: calc(12px * var(--vnccs-ps-save-scale));
}

.vnccs-ps-save-library-error {
    color: #f08b8b;
    font-size: calc(10px * var(--vnccs-ps-save-scale));
    line-height: 1.2;
}

.vnccs-ps-save-library-error[hidden] {
    display: none;
}

.vnccs-ps-save-library-field.invalid .vnccs-ps-input {
    border-color: rgba(240, 110, 110, 0.72);
    box-shadow: 0 0 0 1px rgba(240, 110, 110, 0.16);
}

.vnccs-ps-save-library-modal .vnccs-ps-library-system-tag {
    align-self: flex-start;
    font-size: calc(10px * var(--vnccs-ps-save-scale));
}

.vnccs-ps-save-library-check {
    display: flex;
    align-items: center;
    gap: calc(7px * var(--vnccs-ps-save-scale));
    color: var(--ps-text-muted);
    font-size: calc(11px * var(--vnccs-ps-save-scale));
    line-height: 1.3;
}

.vnccs-ps-save-library-check input[type="checkbox"] {
    width: calc(15px * var(--vnccs-ps-save-scale));
    height: calc(15px * var(--vnccs-ps-save-scale));
    margin: 0;
}

.vnccs-ps-save-library-preview-help {
    color: var(--ps-text-dim);
    font-size: calc(10px * var(--vnccs-ps-save-scale));
    line-height: 1.35;
}

.vnccs-ps-save-library-modal input[type="file"] {
    max-width: 100%;
    color: var(--ps-text-muted);
    font-size: calc(11px * var(--vnccs-ps-save-scale));
}

.vnccs-ps-save-library-actions {
    display: grid;
    flex: 0 0 auto;
    grid-template-columns: 1fr 1fr;
    gap: calc(7px * var(--vnccs-ps-save-scale));
    padding: 0 calc(14px * var(--vnccs-ps-save-scale)) calc(14px * var(--vnccs-ps-save-scale));
}

.vnccs-ps-save-library-actions .vnccs-ps-modal-btn {
    min-width: 0;
    min-height: calc(34px * var(--vnccs-ps-save-scale));
    padding: calc(7px * var(--vnccs-ps-save-scale)) calc(10px * var(--vnccs-ps-save-scale));
    border-radius: calc(8px * var(--vnccs-ps-save-scale));
    justify-content: center;
    font-size: calc(12px * var(--vnccs-ps-save-scale));
    font-weight: 700;
    line-height: 1;
    text-align: center;
}

.vnccs-ps-save-library-actions .primary {
    border-color: var(--ps-accent-border);
    background: var(--ps-accent);
    color: #24151b;
}

.vnccs-ps-save-library-actions .primary:hover:not(:disabled) {
    border-color: var(--ps-accent-hover);
    background: var(--ps-accent-hover);
    color: #24151b;
}

.vnccs-ps-save-library-actions .vnccs-ps-modal-btn:focus-visible {
    outline: 2px solid var(--ps-accent);
    outline-offset: 2px;
}

.vnccs-ps-save-library-actions .vnccs-ps-modal-btn:disabled {
    cursor: wait;
    opacity: 0.58;
}

.vnccs-ps-hand-popover {
    position: absolute;
    width: 240px;
    max-width: calc(100% - 20px);
    box-sizing: border-box;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid rgba(255, 214, 102, 0.4);
    background: rgba(12, 10, 20, 0.94);
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 214, 102, 0.06);
    backdrop-filter: blur(12px);
    z-index: 110;
    display: none;
    gap: 10px;
}

.vnccs-ps-hand-popover.visible {
    display: flex;
    flex-direction: column;
}

.vnccs-ps-hand-popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
}

.vnccs-ps-hand-popover-title {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #ffd666;
}

.vnccs-ps-hand-popover-close {
    width: 24px;
    height: 24px;
    border: 1px solid var(--ps-border);
    border-radius: 999px;
    background: rgba(255,255,255,0.04);
    color: var(--ps-text-muted);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
}

.vnccs-ps-hand-popover-close:hover {
    border-color: rgba(255, 214, 102, 0.45);
    color: #ffd666;
}

.vnccs-ps-msg-modal {
    background: rgba(18, 14, 28, 0.95);
    border: 1px solid var(--ps-accent-border);
    border-radius: var(--ps-radius-lg);
    width: 340px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.7);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0;
}

.vnccs-ps-modal-btn.cancel:hover {
    color: var(--ps-text);
    background: rgba(255, 255, 255, 0.06);
}

/* === Pose Library Panel === */
.vnccs-ps-library-btn {
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    background: linear-gradient(180deg, var(--ps-accent), var(--ps-accent-lavender));
    color: #1a1525;
    border: none;
    border-radius: 8px 0 0 8px;
    padding: 14px 7px;
    cursor: pointer;
    font-size: 18px;
    z-index: 100;
    transition: all var(--ps-transition);
    pointer-events: auto;
    box-shadow: -4px 0 20px var(--ps-accent-glow);
}

.vnccs-ps-library-btn:hover {
    padding-right: 12px;
    box-shadow: -6px 0 28px var(--ps-accent-glow);
}

/* Library Modal Overlay */
.vnccs-ps-modal-overlay {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    pointer-events: auto;
    backdrop-filter: blur(10px);
}

.vnccs-ps-library-modal {
    --vnccs-ps-library-ui-scale: 1;
    width: calc(100% - 24px);
    max-width: none;
    height: calc(100% - 24px);
    max-height: none;
    background: rgba(14, 11, 22, 0.96);
    border: 1px solid var(--ps-accent-border);
    border-radius: var(--ps-radius-lg);
    display: flex;
    flex-direction: column;
    box-shadow: 0 32px 80px rgba(0,0,0,0.85), 0 0 0 1px rgba(85,187,132,0.05);
    overflow: hidden;
    flex-shrink: 0;
    position: relative;
}

.vnccs-ps-library-modal::before {
    content: '';
    position: absolute;
    top: 0; left: 15%; right: 15%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(85, 187, 132, 0.7), transparent);
    pointer-events: none;
}

.vnccs-ps-library-modal-header {
    display: flex;
    align-items: center;
    gap: calc(24px * var(--vnccs-ps-library-ui-scale));
    padding: calc(32px * var(--vnccs-ps-library-ui-scale)) calc(44px * var(--vnccs-ps-library-ui-scale));
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid var(--ps-border);
}

.vnccs-ps-library-modal-title {
    font-size: calc(34px * var(--vnccs-ps-library-ui-scale));
    font-weight: 700;
    color: var(--ps-accent);
    display: flex;
    align-items: center;
    gap: calc(20px * var(--vnccs-ps-library-ui-scale));
    font-family: var(--ps-font);
    letter-spacing: calc(1px * var(--vnccs-ps-library-ui-scale));
    margin-right: 0;
}

.vnccs-ps-library-header-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-start;
    gap: calc(12px * var(--vnccs-ps-library-ui-scale));
    min-width: 0;
}

.vnccs-ps-library-modal-header > .vnccs-ps-library-apply-selected {
    margin-left: auto;
    flex: 0 0 auto;
}

.vnccs-ps-library-modal-header > .vnccs-ps-modal-close {
    flex: 0 0 auto;
}

.vnccs-ps-library-modal .vnccs-ps-btn.primary:not(.vnccs-ps-library-apply-selected) {
    background: rgba(255, 255, 255, 0.06);
    border-color: var(--ps-border);
    color: var(--ps-text-muted);
    font-weight: 600;
    box-shadow: none;
}

.vnccs-ps-library-inspector .vnccs-ps-btn.danger {
    background: rgba(255, 255, 255, 0.06);
    border-color: var(--ps-border);
    color: var(--ps-text-muted);
    font-weight: 600;
    box-shadow: none;
}

.vnccs-ps-library-modal .vnccs-ps-btn.primary:not(.vnccs-ps-library-apply-selected)::after {
    display: none;
}

.vnccs-ps-library-modal .vnccs-ps-btn.primary:not(.vnccs-ps-library-apply-selected):hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: var(--ps-border-hover);
    color: var(--ps-text);
    transform: none;
    box-shadow: none;
}

.vnccs-ps-library-inspector .vnccs-ps-btn.danger:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: var(--ps-border-hover);
    color: var(--ps-text);
    transform: none;
    box-shadow: none;
}

.vnccs-ps-library-save-current {
    width: auto;
    min-width: calc(300px * var(--vnccs-ps-library-ui-scale));
    padding: calc(18px * var(--vnccs-ps-library-ui-scale)) calc(28px * var(--vnccs-ps-library-ui-scale));
    justify-content: center;
}

.vnccs-ps-library-modal-header .vnccs-ps-btn,
.vnccs-ps-library-settings .vnccs-ps-btn {
    gap: calc(10px * var(--vnccs-ps-library-ui-scale));
    padding: calc(12px * var(--vnccs-ps-library-ui-scale)) calc(24px * var(--vnccs-ps-library-ui-scale));
    font-size: calc(22px * var(--vnccs-ps-library-ui-scale));
}

.vnccs-ps-library-modal-header .vnccs-ps-btn-icon,
.vnccs-ps-library-settings .vnccs-ps-btn-icon {
    font-size: calc(30px * var(--vnccs-ps-library-ui-scale));
}

.vnccs-ps-library-menu-btn {
    width: calc(76px * var(--vnccs-ps-library-ui-scale));
    height: calc(76px * var(--vnccs-ps-library-ui-scale));
    border-radius: calc(8px * var(--vnccs-ps-library-ui-scale));
    border: 1px solid var(--ps-border);
    background: var(--ps-input-bg);
    color: var(--ps-text);
    cursor: pointer;
    font-size: calc(34px * var(--vnccs-ps-library-ui-scale));
    transition: all var(--ps-transition);
}

.vnccs-ps-library-menu-btn:hover {
    border-color: var(--ps-accent-border);
    color: var(--ps-accent);
}

.vnccs-ps-library-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: calc(20px * var(--vnccs-ps-library-ui-scale));
    padding: calc(28px * var(--vnccs-ps-library-ui-scale)) calc(44px * var(--vnccs-ps-library-ui-scale)) calc(16px * var(--vnccs-ps-library-ui-scale));
    background: rgba(0, 0, 0, 0.16);
}

.vnccs-ps-library-search {
    flex: 1 1 calc(420px * var(--vnccs-ps-library-ui-scale));
    min-width: calc(260px * var(--vnccs-ps-library-ui-scale));
    height: calc(76px * var(--vnccs-ps-library-ui-scale));
    border-radius: calc(8px * var(--vnccs-ps-library-ui-scale));
    border: 1px solid var(--ps-border);
    background: rgba(255,255,255,0.055);
    color: var(--ps-text);
    padding: 0 calc(28px * var(--vnccs-ps-library-ui-scale));
    font-family: var(--ps-font);
    font-size: calc(28px * var(--vnccs-ps-library-ui-scale));
    outline: none;
}

.vnccs-ps-library-search:focus {
    border-color: var(--ps-accent-border);
    box-shadow: 0 0 0 2px rgba(85,187,132,0.12);
}

.vnccs-ps-library-size-control {
    width: calc(380px * var(--vnccs-ps-library-ui-scale));
    flex: 0 0 calc(380px * var(--vnccs-ps-library-ui-scale));
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: calc(16px * var(--vnccs-ps-library-ui-scale));
    color: var(--ps-text-muted);
    font-size: calc(22px * var(--vnccs-ps-library-ui-scale));
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: calc(1.4px * var(--vnccs-ps-library-ui-scale));
    font-family: var(--ps-font);
}

.vnccs-ps-library-size-control input {
    width: 100%;
    height: calc(28px * var(--vnccs-ps-library-ui-scale));
    accent-color: var(--ps-accent);
}

.vnccs-ps-library-size-value {
    width: calc(68px * var(--vnccs-ps-library-ui-scale));
    text-align: right;
    color: var(--ps-accent);
}

.vnccs-ps-library-categories {
    display: flex;
    gap: calc(16px * var(--vnccs-ps-library-ui-scale));
    padding: calc(8px * var(--vnccs-ps-library-ui-scale)) calc(44px * var(--vnccs-ps-library-ui-scale)) calc(24px * var(--vnccs-ps-library-ui-scale));
    overflow-x: auto;
    border-bottom: 1px solid var(--ps-border);
}

.vnccs-ps-library-category-chip {
    height: calc(60px * var(--vnccs-ps-library-ui-scale));
    padding: 0 calc(24px * var(--vnccs-ps-library-ui-scale));
    border-radius: 999px;
    border: 1px solid var(--ps-border);
    background: rgba(255,255,255,0.04);
    color: var(--ps-text-muted);
    font-family: var(--ps-font);
    font-size: calc(24px * var(--vnccs-ps-library-ui-scale));
    white-space: nowrap;
    cursor: pointer;
}

.vnccs-ps-library-category-chip.active,
.vnccs-ps-library-category-chip:hover {
    color: var(--ps-accent);
    border-color: var(--ps-accent-border);
    background: var(--ps-accent-subtle);
}

.vnccs-pose-studio .vnccs-ps-library-modal {
    container: pose-library / inline-size;
    --vnccs-ps-library-header-scale: calc(var(--vnccs-ps-library-ui-scale) * 0.62);
}

.vnccs-pose-studio .vnccs-ps-library-modal-header,
.vnccs-pose-studio .vnccs-ps-library-toolbar,
.vnccs-pose-studio .vnccs-ps-library-categories {
    --vnccs-ps-library-ui-scale: var(--vnccs-ps-library-header-scale);
    flex-shrink: 0;
}

.vnccs-pose-studio .vnccs-ps-library-modal-title {
    font-size: max(16px, calc(34px * var(--vnccs-ps-library-ui-scale)));
}

.vnccs-pose-studio .vnccs-ps-library-modal-header .vnccs-ps-btn,
.vnccs-pose-studio .vnccs-ps-library-search {
    font-size: max(14px, calc(22px * var(--vnccs-ps-library-ui-scale)));
}

.vnccs-pose-studio .vnccs-ps-library-modal-header .vnccs-ps-btn,
.vnccs-pose-studio .vnccs-ps-modal-close {
    min-height: 32px;
    min-width: 32px;
    transition: color var(--ps-transition), border-color var(--ps-transition);
}

.vnccs-pose-studio .vnccs-ps-library-modal-header .vnccs-ps-btn-icon {
    font-size: max(18px, calc(30px * var(--vnccs-ps-library-ui-scale)));
}

.vnccs-pose-studio .vnccs-ps-library-modal .vnccs-ps-modal-close {
    font-size: max(26px, calc(46px * var(--vnccs-ps-library-ui-scale)));
}

.vnccs-pose-studio .vnccs-ps-library-search,
.vnccs-pose-studio .vnccs-ps-library-menu-btn {
    box-sizing: border-box;
    height: max(32px, calc(76px * var(--vnccs-ps-library-ui-scale)));
}

.vnccs-pose-studio .vnccs-ps-library-menu-btn {
    flex-shrink: 0;
    width: max(32px, calc(76px * var(--vnccs-ps-library-ui-scale)));
    font-size: max(20px, calc(34px * var(--vnccs-ps-library-ui-scale)));
    transition: color var(--ps-transition), border-color var(--ps-transition);
}

.vnccs-pose-studio .vnccs-ps-library-size-control {
    width: max(220px, calc(380px * var(--vnccs-ps-library-ui-scale)));
    flex-basis: max(220px, calc(380px * var(--vnccs-ps-library-ui-scale)));
    height: max(32px, calc(76px * var(--vnccs-ps-library-ui-scale)));
    font-size: max(13px, calc(22px * var(--vnccs-ps-library-ui-scale)));
}

.vnccs-pose-studio .vnccs-ps-library-size-control input {
    min-width: 0;
    min-height: 24px;
}

.vnccs-pose-studio .vnccs-ps-library-category-chip {
    flex-shrink: 0;
    height: max(28px, calc(60px * var(--vnccs-ps-library-ui-scale)));
    font-size: max(13px, calc(24px * var(--vnccs-ps-library-ui-scale)));
}

.vnccs-pose-studio .vnccs-ps-library-settings {
    --vnccs-ps-library-ui-scale: 1;
    zoom: max(0.55, var(--vnccs-ps-library-header-scale));
}

.vnccs-pose-studio .vnccs-ps-library-settings-head,
.vnccs-pose-studio .vnccs-ps-library-repo-actions {
    flex-wrap: wrap;
}

.vnccs-pose-studio .vnccs-ps-library-settings-head > div {
    flex: 1 1 360px;
    min-width: 0;
}

.vnccs-pose-studio .vnccs-ps-library-settings-back {
    flex-shrink: 0;
    white-space: nowrap;
}

.vnccs-pose-studio .vnccs-ps-library-settings .vnccs-ps-input,
.vnccs-pose-studio .vnccs-ps-library-settings .vnccs-ps-btn {
    box-sizing: border-box;
    min-height: 60px;
    white-space: nowrap;
    transition: color var(--ps-transition), border-color var(--ps-transition);
}

@container pose-library (max-width: 600px) {
    .vnccs-pose-studio .vnccs-ps-library-modal-header {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
    }
    .vnccs-pose-studio .vnccs-ps-library-header-actions {
        grid-column: 1 / -1;
        grid-row: 2;
    }
    .vnccs-pose-studio .vnccs-ps-modal-close {
        grid-column: 2;
        grid-row: 1;
    }
    .vnccs-pose-studio .vnccs-ps-library-toolbar {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
    }
    .vnccs-pose-studio .vnccs-ps-library-search {
        grid-column: 1 / -1;
        min-width: 0;
        width: 100%;
    }
    .vnccs-pose-studio .vnccs-ps-library-size-control {
        width: auto;
        min-width: 0;
    }
    .vnccs-pose-studio .vnccs-ps-library-repo-card,
    .vnccs-pose-studio .vnccs-ps-library-repo-add {
        grid-template-columns: minmax(0, 1fr);
    }
}

.vnccs-ps-library-workspace {
    --vnccs-ps-library-inspector-base-width: 340px;
    --vnccs-ps-library-inspector-scale: 1;
    --vnccs-ps-library-inspector-width: calc(
        var(--vnccs-ps-library-inspector-base-width) * var(--vnccs-ps-library-inspector-scale)
    );
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--vnccs-ps-library-inspector-width);
    gap: 0;
}

.vnccs-ps-library-workspace.settings-mode {
    grid-template-columns: minmax(0, 1fr);
}

.vnccs-ps-library-workspace.settings-mode .vnccs-ps-library-modal-grid,
.vnccs-ps-library-workspace.settings-mode .vnccs-ps-library-inspector {
    display: none;
}

.vnccs-ps-library-settings {
    min-height: 0;
    overflow-y: auto;
    padding: 40px 44px;
    display: none;
    flex-direction: column;
    gap: 28px;
}

.vnccs-ps-library-workspace.settings-mode .vnccs-ps-library-settings {
    display: flex;
}

.vnccs-ps-library-settings-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
}

.vnccs-ps-library-settings-title {
    color: var(--ps-text);
    font-size: 32px;
    font-weight: 700;
    font-family: var(--ps-font);
}

.vnccs-ps-library-settings-subtitle {
    color: var(--ps-text-muted);
    font-size: 24px;
    margin-top: 8px;
}

.vnccs-ps-library-repo-add {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 16px;
}

.vnccs-ps-library-repo-notice {
    display: none;
    padding: 14px 18px;
    border: 1px solid var(--ps-accent-border);
    border-radius: 8px;
    background: var(--ps-accent-subtle);
    color: var(--ps-accent);
    font-size: 22px;
    line-height: 1.35;
}

.vnccs-ps-library-repo-notice.visible {
    display: block;
}

.vnccs-ps-library-repo-notice.error {
    border-color: rgba(50,150,95,0.45);
    background: rgba(50,150,95,0.1);
    color: var(--ps-danger);
}

.vnccs-ps-library-settings .vnccs-ps-input {
    padding: 10px 16px;
    font-size: 22px;
}

.vnccs-ps-library-repo-list {
    display: flex;
    flex-direction: column;
    gap: 20px;
}

.vnccs-ps-library-local-repo {
    margin-bottom: 20px;
}

.vnccs-ps-library-repo-card {
    border: 1px solid var(--ps-border);
    border-radius: 8px;
    background: rgba(255,255,255,0.035);
    padding: 24px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 24px;
    align-items: center;
}

.vnccs-ps-library-repo-title {
    color: var(--ps-text);
    font-weight: 700;
    font-size: 26px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.vnccs-ps-library-repo-id,
.vnccs-ps-library-repo-meta {
    color: var(--ps-text-muted);
    font-size: 22px;
    margin-top: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.vnccs-ps-library-repo-actions {
    display: flex;
    gap: 12px;
    align-items: center;
}

.vnccs-ps-library-repo-action {
    height: 60px;
    padding: 0 20px;
    border-radius: 7px;
    border: 1px solid var(--ps-border);
    background: var(--ps-input-bg);
    color: var(--ps-text-muted);
    font-size: 24px;
    cursor: pointer;
}

.vnccs-ps-library-repo-action:hover {
    color: var(--ps-accent);
    border-color: var(--ps-accent-border);
}

.vnccs-ps-library-repo-action.primary {
    background: var(--ps-accent);
    color: var(--ps-bg);
    border-color: var(--ps-accent-border);
    font-weight: 700;
}

.vnccs-ps-library-repo-action.primary:hover {
    color: var(--ps-bg);
    filter: brightness(1.05);
}

.vnccs-ps-library-repo-action.danger:hover {
    color: var(--ps-danger);
    border-color: rgba(50,150,95,0.45);
}

.vnccs-ps-library-repo-card.is-running .vnccs-ps-library-repo-action {
    opacity: 0.55;
    pointer-events: none;
}

.vnccs-ps-library-repo-progress {
    grid-column: 1 / -1;
    display: none;
    margin-top: 4px;
}

.vnccs-ps-library-repo-progress.visible {
    display: block;
}

.vnccs-ps-library-repo-progress-head {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    color: var(--ps-text-muted);
    font-size: 22px;
    line-height: 1.35;
    margin-bottom: 12px;
}

.vnccs-ps-library-repo-progress-message {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.vnccs-ps-library-repo-progress-percent {
    flex: 0 0 auto;
    color: var(--ps-accent);
    font-weight: 700;
}

.vnccs-ps-library-repo-progress-track {
    height: 16px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.1);
}

.vnccs-ps-library-repo-progress-fill {
    width: 0%;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--ps-accent), #8fe3ff);
    box-shadow: 0 0 14px rgba(85, 187, 132, 0.35);
    transition: width 0.25s ease;
}

.vnccs-ps-library-repo-progress.error .vnccs-ps-library-repo-progress-fill {
    background: var(--ps-danger);
}

.vnccs-ps-library-repo-progress.success .vnccs-ps-library-repo-progress-fill {
    background: linear-gradient(90deg, #64d8cb, #8fe3ff);
}

.vnccs-ps-modal-close {
    background: transparent;
    border: none;
    color: var(--ps-text-muted);
    font-size: 46px;
    cursor: pointer;
    transition: color var(--ps-transition);
    padding: 4px 12px;
}

.vnccs-ps-modal-close:hover { color: var(--ps-accent); }

.vnccs-ps-library-modal .vnccs-ps-modal-close {
    font-size: calc(46px * var(--vnccs-ps-library-ui-scale));
    padding: calc(4px * var(--vnccs-ps-library-ui-scale)) calc(12px * var(--vnccs-ps-library-ui-scale));
}

.vnccs-ps-library-modal-grid {
    min-height: 0;
    overflow-y: auto;
    padding: calc(20px * var(--vnccs-ps-library-ui-scale));
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--vnccs-ps-library-thumb-size, 320px), 1fr));
    gap: calc(16px * var(--vnccs-ps-library-ui-scale));
    align-content: start;
}
.vnccs-ps-library-modal-grid::-webkit-scrollbar { width: 6px; }
.vnccs-ps-library-modal-grid::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); }
.vnccs-ps-library-modal-grid::-webkit-scrollbar-thumb { background: var(--ps-accent-border); border-radius: 3px; }
.vnccs-ps-library-modal-grid::-webkit-scrollbar-thumb:hover { background: var(--ps-accent); }

.vnccs-ps-library-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--ps-border);
    background: rgba(0, 0, 0, 0.25);
}

.vnccs-ps-library-title {
    font-weight: 700;
    color: var(--ps-accent);
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 1px;
    font-family: var(--ps-font);
}

.vnccs-ps-library-close {
    background: transparent;
    border: none;
    color: var(--ps-text-muted);
    font-size: 20px;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    transition: color var(--ps-transition);
}

.vnccs-ps-library-close:hover {
    color: var(--ps-accent);
}

.vnccs-ps-library-grid {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    align-content: start;
}

.vnccs-ps-library-item {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--ps-border);
    border-radius: 9px;
    overflow: hidden;
    cursor: pointer;
    transition: all var(--ps-transition);
    position: relative;
    min-height: var(--vnccs-ps-library-thumb-height, 420px);
    display: flex;
    flex-direction: column;
}

.vnccs-ps-library-item.selected {
    border-color: var(--ps-accent);
    box-shadow: 0 0 0 1px var(--ps-accent-border), 0 10px 28px rgba(0,0,0,0.35);
}

.vnccs-ps-library-item:focus-visible {
    outline: 2px solid var(--ps-accent);
    outline-offset: 2px;
}

.vnccs-ps-library-item-delete {
    position: absolute;
    top: calc(6px * var(--vnccs-ps-library-ui-scale));
    right: calc(6px * var(--vnccs-ps-library-ui-scale));
    width: calc(22px * var(--vnccs-ps-library-ui-scale));
    height: calc(22px * var(--vnccs-ps-library-ui-scale));
    background: rgba(50, 150, 95, 0.75);
    color: white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: calc(16px * var(--vnccs-ps-library-ui-scale));
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: all var(--ps-transition);
    z-index: 10;
}

.vnccs-ps-library-item:hover .vnccs-ps-library-item-delete {
    opacity: 1;
}

.vnccs-ps-library-item-delete:hover {
    background: #ff4757;
    transform: scale(1.15);
}

.vnccs-ps-library-item:hover {
    border-color: var(--ps-accent-border);
    transform: translateY(-3px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.3), 0 0 12px var(--ps-accent-subtle);
}

.vnccs-ps-library-item.selected:hover {
    border-color: var(--ps-accent);
    box-shadow: 0 0 0 1px var(--ps-accent-border), 0 10px 28px rgba(0,0,0,0.35);
}

.vnccs-ps-library-item-preview {
    width: 100%;
    flex: 1;
    min-height: 0;
    background: rgba(8, 6, 16, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ps-text-muted);
    font-size: calc(30px * var(--vnccs-ps-library-ui-scale));
    overflow: hidden;
    border-radius: inherit;
}

.vnccs-ps-library-item-preview img {
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    display: block;
    border-radius: inherit;
}

.vnccs-ps-library-item-name {
    position: relative;
    flex: 0 0 auto;
    left: auto;
    right: auto;
    bottom: auto;
    width: 100%;
    box-sizing: border-box;
    padding: calc(9px * var(--vnccs-ps-library-ui-scale)) calc(8px * var(--vnccs-ps-library-ui-scale)) calc(10px * var(--vnccs-ps-library-ui-scale));
    background: rgba(0, 0, 0, 0.92);
    font-size: calc(13px * var(--vnccs-ps-library-ui-scale));
    text-align: center;
    color: var(--ps-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--ps-font);
    border-top: 1px solid var(--ps-border);
}

.vnccs-ps-library-item-meta {
    display: none;
}

.vnccs-ps-library-inspector {
    min-height: 0;
    overflow: hidden;
    padding: 0;
    border-left: 1px solid var(--ps-border);
    background: rgba(0,0,0,0.2);
    display: block;
    position: relative;
}

.vnccs-ps-library-inspector.visible {
    display: block;
}

.vnccs-ps-library-inspector-inner {
    width: var(--vnccs-ps-library-inspector-base-width);
    height: calc(100% / var(--vnccs-ps-library-inspector-scale));
    box-sizing: border-box;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
    transform: scale(var(--vnccs-ps-library-inspector-scale));
    transform-origin: top left;
}

.vnccs-ps-library-inspector-empty {
    color: var(--ps-text-muted);
    font-size: 14px;
    line-height: 1.5;
    padding: 24px 4px;
}

.vnccs-ps-library-inspector-preview {
    width: 100%;
    aspect-ratio: 1 / 1.25;
    border-radius: var(--ps-radius-sm);
    border: 1px solid var(--ps-border);
    overflow: hidden;
    background: rgba(8, 6, 16, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ps-text-muted);
    font-size: 36px;
}

.vnccs-ps-library-inspector-preview img,

.vnccs-ps-library-system-tag {
    align-self: flex-start;
    padding: 5px 9px;
    border: 1px solid rgba(184, 169, 232, 0.5);
    border-radius: 999px;
    background: rgba(184, 169, 232, 0.12);
    color: var(--ps-accent-lavender);
    font-size: 11px;
    letter-spacing: .7px;
    text-transform: none;
}

.vnccs-ps-library-inspector-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
}

.vnccs-ps-library-inspector .vnccs-ps-btn {
    font-size: 14px;
}

.vnccs-ps-library-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--ps-text-muted);
    font-size: 14px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.7px;
}

.vnccs-ps-library-field input[type="text"],
.vnccs-ps-library-field input[type="file"] {
    width: 100%;
    box-sizing: border-box;
    font-size: 14px;
}

.vnccs-ps-library-thumbnail-upload {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
}

.vnccs-ps-library-thumbnail-pick {
    flex: 0 0 auto;
    min-height: 34px;
    padding: 0 14px;
    border: 1px solid rgba(125, 239, 190, .72);
    background: linear-gradient(135deg, #39b981, #70dfa7);
    color: #07130d;
    font-size: 13px;
    font-weight: 800;
    box-shadow: 0 2px 10px rgba(49, 202, 133, .28);
}

.vnccs-ps-library-thumbnail-pick:hover {
    background: linear-gradient(135deg, #54d59a, #92f0bd);
    box-shadow: 0 3px 14px rgba(49, 220, 145, .42);
}

.vnccs-ps-library-thumbnail-name {
    min-width: 0;
    overflow: hidden;
    color: var(--ps-text-muted);
    font-size: 12px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.vnccs-ps-library-preview-input {
    display: none;
}

.vnccs-ps-library-save-edit {
    justify-content: center;
    margin-top: 0;
}

.vnccs-ps-library-footer {
    padding: 8px;
    border-top: 1px solid var(--ps-border);
}

.vnccs-ps-library-empty {
    grid-column: 1 / -1;
    text-align: center;
    color: var(--ps-text-muted);
    padding: 24px;
    font-size: 14px;
    font-family: var(--ps-font);
}

/* === Loading Overlay === */
.vnccs-ps-loading-overlay {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background: rgba(6, 4, 12, 0.88);
    backdrop-filter: blur(12px);
    display: none;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 20px;
    z-index: 2000;
    color: var(--ps-text);
    cursor: wait;
}

/* Dual-ring sakura spinner */
.vnccs-ps-loading-spinner {
    width: 50px;
    height: 50px;
    position: relative;
}

.vnccs-ps-loading-spinner::before,
.vnccs-ps-loading-spinner::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 3px solid transparent;
}

.vnccs-ps-loading-spinner::before {
    border-top-color: var(--ps-accent);
    border-right-color: rgba(85, 187, 132, 0.3);
    animation: ps-spin 1s linear infinite;
    box-shadow: 0 0 18px var(--ps-accent-glow);
}

.vnccs-ps-import-progress {
    width: 100%;
    height: 8px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.12);
    margin: 8px 0 2px;
}

.vnccs-ps-import-progress-fill {
    height: 100%;
    width: 0%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--ps-accent), #8fe3ff);
    box-shadow: 0 0 14px rgba(85, 187, 132, 0.45);
    transition: width 0.25s ease;
}

.vnccs-ps-import-progress-percent {
    min-height: 16px;
    font-size: 13px;
    color: var(--ps-text-muted);
    text-align: center;
}

.vnccs-ps-loading-spinner::after {
    inset: 8px;
    border-bottom-color: var(--ps-accent-lavender);
    border-left-color: rgba(184, 169, 232, 0.25);
    animation: ps-spin 1.5s linear infinite reverse;
}

@keyframes ps-spin {
    0%   { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

.vnccs-ps-loading-text {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 2px;
    color: var(--ps-accent);
    text-transform: uppercase;
    font-family: var(--ps-font);
}
`;

// Inject styles
const styleEl = document.createElement("style");
styleEl.textContent = STYLES;
document.head.appendChild(styleEl);

function enablePoseStudioCanvasNavigationForwarding(root) {
    if (!root || root._vnccsPoseCanvasNavigationForwarding) return;
    root._vnccsPoseCanvasNavigationForwarding = true;

    const canvas = () => app.canvasEl || app.canvas?.canvas || document.querySelector("canvas.litegraph");
    let panning = false;

    const markForwarded = (event) => {
        Object.defineProperty(event, "_vnccsPoseForwardedCanvasInput", { value: true });
        return event;
    };

    const cloneMouseEvent = (type, source, buttons = source.buttons) => markForwarded(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: source.detail,
        screenX: source.screenX,
        screenY: source.screenY,
        clientX: source.clientX,
        clientY: source.clientY,
        ctrlKey: source.ctrlKey,
        altKey: source.altKey,
        shiftKey: source.shiftKey,
        metaKey: source.metaKey,
        button: source.button,
        buttons,
    }));

    const clonePointerEvent = (type, source, buttons = source.buttons) => {
        const EventCtor = window.PointerEvent || window.MouseEvent;
        return markForwarded(new EventCtor(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            detail: source.detail,
            screenX: source.screenX,
            screenY: source.screenY,
            clientX: source.clientX,
            clientY: source.clientY,
            ctrlKey: source.ctrlKey,
            altKey: source.altKey,
            shiftKey: source.shiftKey,
            metaKey: source.metaKey,
            button: 1,
            buttons,
            pointerId: source.pointerId || 1,
            pointerType: source.pointerType || "mouse",
            isPrimary: source.isPrimary !== false,
        }));
    };

    const cloneWheelEvent = (source) => markForwarded(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: source.detail,
        screenX: source.screenX,
        screenY: source.screenY,
        clientX: source.clientX,
        clientY: source.clientY,
        ctrlKey: source.ctrlKey,
        altKey: source.altKey,
        shiftKey: source.shiftKey,
        metaKey: source.metaKey,
        deltaX: source.deltaX,
        deltaY: source.deltaY,
        deltaZ: source.deltaZ,
        deltaMode: source.deltaMode,
    }));

    const forwardMouse = (type, event, buttons) => {
        const canvasEl = canvas();
        if (!canvasEl) return false;
        const pointerType = type === "mousedown" ? "pointerdown" : type === "mousemove" ? "pointermove" : "pointerup";
        canvasEl.dispatchEvent(clonePointerEvent(pointerType, event, buttons));
        canvasEl.dispatchEvent(cloneMouseEvent(type, event, buttons));
        return true;
    };

    const forwardWheel = (event) => {
        const canvasEl = canvas();
        if (!canvasEl) return false;
        canvasEl.dispatchEvent(cloneWheelEvent(event));
        return true;
    };

    const hasOwnWheelHandler = (target) => {
        for (let el = target; el && el !== root; el = el.parentElement) {
            if (typeof el.onwheel === "function") return true;
        }
        return false;
    };

    const hasScrollableAncestor = (target) => {
        for (let el = target; el && el !== root; el = el.parentElement) {
            if (!(el instanceof HTMLElement)) continue;
            const style = getComputedStyle(el);
            const scrollY = /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
            const scrollX = /(auto|scroll|overlay)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
            if (scrollY || scrollX) return true;
        }
        return false;
    };

    const hasInteractiveTarget = (target) => {
        if (!(target instanceof Element)) return true;
        return Boolean(target.closest([
            "button",
            "input",
            "textarea",
            "select",
            "label",
            "a",
            "canvas",
            "[contenteditable='true']",
            "[role='button']",
            ".vnccs-ps-toggle",
            ".vnccs-ps-slider-wrap",
            ".vnccs-ps-tabs-shell",
            ".vnccs-ps-canvas-wrap",
            ".vnccs-ps-radar-wrap",
            ".vnccs-ps-hand-popover",
            ".vnccs-ps-modal-overlay",
            ".vnccs-ps-library-modal",
            ".vnccs-ps-library-grid",
            ".vnccs-ps-library-modal-grid",
            ".vnccs-ps-library-inspector",
        ].join(",")));
    };

    const canForwardFrom = (target) => {
        if (hasInteractiveTarget(target)) return false;
        if (hasOwnWheelHandler(target)) return false;
        if (hasScrollableAncestor(target)) return false;
        return true;
    };

    const finishPan = (event) => {
        if (event._vnccsPoseForwardedCanvasInput) return;
        if (!panning) return;
        panning = false;
        event.preventDefault();
        event.stopPropagation();
        forwardMouse("mouseup", event, 0);
        window.removeEventListener("mousemove", movePan, true);
        window.removeEventListener("mouseup", finishPan, true);
    };

    const movePan = (event) => {
        if (event._vnccsPoseForwardedCanvasInput) return;
        if (!panning) return;
        event.preventDefault();
        event.stopPropagation();
        forwardMouse("mousemove", event, event.buttons || 4);
    };

    root.addEventListener("mousedown", (event) => {
        if (event._vnccsPoseForwardedCanvasInput) return;
        if (event.button !== 1) return;
        if (!canForwardFrom(event.target)) return;
        if (!forwardMouse("mousedown", event, 4)) return;
        panning = true;
        event.preventDefault();
        event.stopPropagation();
        window.addEventListener("mousemove", movePan, true);
        window.addEventListener("mouseup", finishPan, true);
    }, true);

    root.addEventListener("auxclick", (event) => {
        if (event.button !== 1) return;
        if (!canForwardFrom(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
    }, true);

    root.addEventListener("wheel", (event) => {
        if (event._vnccsPoseForwardedCanvasInput) return;
        if (!canForwardFrom(event.target)) return;
        if (!forwardWheel(event)) return;
        event.preventDefault();
        event.stopPropagation();
    }, { capture: true, passive: false });
}


// === 3D Viewer (from Debug3) ===
class PoseStudioWidget {
    constructor(node, host = {}) {
        this.host = host;
        this.node = node;
        this.container = null;
        this.canvas = null;
        this.viewer = null;

        this.poses = [{
            cameraParams: {
                offset_x: 0,
                offset_y: 0,
                zoom: 1,
                yaw_deg: 0,
                pitch_deg: 0,
            },
        }];  // Array of pose data
        this.activeTab = 0;
        this.poseCaptures = []; // Cache for captured images
        this._passthroughPoseData = {};
        this.ikMode = true; // IK mode toggle (false = FK, true = IK)
        this.pendingAgeCameraFit = false;

        // Slider values
        this.meshParams = {
            age: 25, gender: 0.5, weight: 0.5,
            muscle: 0.5, height: 0.5,
            // Female-specific
            breast_size: 0.5, firmness: 0.5,
            // Male-specific
            show_genitals: false,
            penis_len: 0.5, penis_circ: 0.5, penis_test: 0.5,
            // Visual modifiers (client-side bone scaling)
            ...DEFAULT_POSE_STUDIO_MESH_PROPORTIONS,
        };

        // Export settings
        this.skinType = "naked";
        this.lightParams = this.defaultLightParams();
        this.exportParams = {
            view_width: 1024,
            view_height: 1024,
            cam_zoom: 1.0,
            cam_offset_x: 0,
            cam_offset_y: 0,
            cam_yaw_deg: 0,
            cam_pitch_deg: 0,
            cam_roll_deg: 0,
            bg_color: [0, 0, 0],
            background_url: null,
            skin_type: this.skinType,
        };
        this._outputSizeUserSet = false;

        const primaryCharacter = createPoseStudioCharacter({
            id: "character-1",
            index: 0,
            color: DEFAULT_CHARACTER_COLORS[0],
            transform: {
                x: this.exportParams.cam_offset_x,
                y: this.exportParams.cam_offset_y,
                z: 0,
                zoom: this.exportParams.cam_zoom,
            },
            initialTransform: {
                x: this.exportParams.cam_offset_x,
                y: this.exportParams.cam_offset_y,
                z: 0,
                zoom: this.exportParams.cam_zoom,
            },
            mesh: this.meshParams,
            poses: this.poses,
        });
        // Runtime references are intentionally kept live; serialization takes a
        // deep snapshot so switching characters never aliases editable data.
        primaryCharacter.mesh = this.meshParams;
        primaryCharacter.poses = this.poses;
        this.characters = [primaryCharacter];
        this.initialCharacterTransform = normalizeCharacterTransform(primaryCharacter.initialTransform);
        this._temporarilyHiddenCharacters = new Set();
        this.activeCharacterId = primaryCharacter.id;
        this.charactersSection = null;
        this.charactersSectionTitle = null;
        this.charactersContent = null;
        this._characterSwitchToken = 0;
        this._switchingCharacter = false;
        this._characterSyncTimer = null;
        this._sectionIdCounter = 0;
        this._sceneModelHydrationPromise = null;
        this._hydratingCharacterScene = false;
        this._modelLoadKey = null;
        this._fullscreenHost = null;
        this._fullscreenPlaceholder = null;
        this._fullscreenReturnFocus = null;
        this._fullscreenKeyHandler = null;
        this._fullscreenResizeHandler = null;

        this.sliders = {};
        this.exportWidgets = {};
        this.tabsContainer = null;
        this.tabsShell = null;
        this.tabScrollLeft = null;
        this.tabScrollRight = null;
        this._tabResizeObserver = null;
        this._tabScrollFrame = null;
        this.canvasContainer = null;
        this._observedContainerWidth = 0;
        this._observedContainerHeight = 0;
        this._observedCanvasWidth = 0;
        this._observedCanvasHeight = 0;
        this._uiScaleCommitTimer = null;
        this._forceNextUIScaleCommit = false;
        this._handPopoverResizeFrame = null;
        this._defaultHandPresets = HAND_PRESETS;
        this._handSliderValues = { spread: 0, grasp: 0, thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 };
        this._handSliderDefaults = { spread: 0, grasp: 0, thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 };
        this._handSliderRefs = {};
        this._handSliderValRefs = {};
        this._handBiasValues = [1.0, 1.0, 1.0];
        this._activeHandSide = null;
        this._samCameraModeActive = false;
        this._samCamBannerVisible = false;
        this._samCamDisplayActive = true;
        this._samCamPreParams = null;
        this._samCamStoredParams = null;
        this._morphWorker = null;
        this._morphWorkerFailed = false;
        this._morphSeq = 0;
        this._lastAppliedMorphSeq = 0;
        this._morphSolveInFlight = false;
        this._pendingMorphSolve = null;
        this._morphLoadTasks = new Map();
        this._morphSeqCharacterIds = new Map();
        this._modelLoadPromise = null;
        this._modelLoadKey = null;
        this._samCamStoredProjectionFrame = null;
        this._hoveredHandSide = null;
        this._handPopover = null;
        this._handPopoverTitle = null;
        this._pendingHandPopoverOutsideClick = null;
        this._boundHandleDocumentPointerDown = (event) => this._handleDocumentPointerDown(event);
        this._boundHandleDocumentPointerUp = (event) => this._handleDocumentPointerUp(event);
        this._boundHandleDocumentPointerCancel = (event) => this._handleDocumentPointerCancel(event);
        this.libraryThumbSizeStorageKey = "vnccsPoseLibraryPreviewSize";
        this.libraryThumbSize = this.loadLibraryThumbnailSize();
        this.libraryResizeObserver = null;
        this._libraryResizeFrame = null;
        this._libraryRenderFrame = null;
        this._autoRepoRefreshTimer = null;
        this.repositoryProgressStates = {};
        this._localPoseRepositoryPublishActive = false;
        this._nodeWidgetCache = null;
        this._lastCaptureUploadSnapshot = null;

        this.createUI();
        this._onCategorySettingsChanged = () => {
            this._closeLibraryCategoryManager?.();
            if (this.libraryGrid) this.renderLibrary();
        };
        window.addEventListener("xzg-pose-categories-changed", this._onCategorySettingsChanged);
    }

    dispose() {
        clearTimeout(this.lightingQuickSyncTimeout);
        clearTimeout(this.lightingSyncTimeout);
        if (this._disposed) return;
        window.removeEventListener("xzg-pose-categories-changed", this._onCategorySettingsChanged);
        this.closeFullscreen({ sync: false });
        this._disposed = true;
        if (this._selectAllShortcutHandler) {
            window.removeEventListener("keydown", this._selectAllShortcutHandler, true);
            this._selectAllShortcutHandler = null;
        }
        if (this._viewShortcutHandler && this.container) {
            document.removeEventListener("keydown", this._viewShortcutHandler, true);
            this._viewShortcutHandler = null;
        }
        this._i18nCleanup?.();
        this._i18nCleanup = null;
        if (this._poseStudioContextMenuHandler) {
            window.removeEventListener("contextmenu", this._poseStudioContextMenuHandler, true);
            this._poseStudioContextMenuHandler = null;
        }
        this._handPopoverI18nCleanup?.();
        this._handPopoverI18nCleanup = null;
        this.host = {};
        this._libraryLoadToken = (this._libraryLoadToken || 0) + 1;
        this._referenceReadToken = (this._referenceReadToken || 0) + 1;
        document.removeEventListener("pointerdown", this._boundHandleDocumentPointerDown);
        document.removeEventListener("pointerup", this._boundHandleDocumentPointerUp);
        document.removeEventListener("pointercancel", this._boundHandleDocumentPointerCancel);
        this._closeLibraryModal?.();
        this._customSelectController?.disconnect();
        this._customSelectController = null;
        if (this._containerResizeObserver) {
            this._containerResizeObserver.disconnect();
            this._containerResizeObserver = null;
        }
        if (this._tabResizeObserver) {
            this._tabResizeObserver.disconnect();
            this._tabResizeObserver = null;
        }
        if (this._tabScrollFrame) {
            cancelAnimationFrame(this._tabScrollFrame);
            this._tabScrollFrame = null;
        }
        if (this.libraryResizeObserver) {
            this.libraryResizeObserver.disconnect();
            this.libraryResizeObserver = null;
        }
        if (this._libraryRenderFrame) {
            cancelAnimationFrame(this._libraryRenderFrame);
            this._libraryRenderFrame = null;
        }
        if (this._libraryResizeFrame) {
            cancelAnimationFrame(this._libraryResizeFrame);
            this._libraryResizeFrame = null;
        }
        if (this._autoRepoRefreshTimer) {
            clearInterval(this._autoRepoRefreshTimer);
            this._autoRepoRefreshTimer = null;
        }
        if (this._uiScaleCommitTimer) {
            clearTimeout(this._uiScaleCommitTimer);
            this._uiScaleCommitTimer = null;
        }
        if (this._handPopoverResizeFrame) {
            cancelAnimationFrame(this._handPopoverResizeFrame);
            this._handPopoverResizeFrame = null;
        }
        clearTimeout(this.colorTimeout);
        clearTimeout(this._characterSyncTimer);
        this._characterSyncTimer = null;
        this._activeSaveLibraryClose?.(true);
        this._closeLibraryCategoryManager?.();
        this._pendingMorphSolve = null;
        this._morphSolveInFlight = false;
        for (const request of this._morphLoadTasks.values()) {
            clearTimeout(request.timeout);
            request.resolve?.(null);
        }
        this._morphLoadTasks.clear();
        this._morphSeqCharacterIds?.clear?.();
        if (this._morphWorker) {
            if (this._morphClientId) {
                VNCCS_SHARED_MORPH_CLIENTS.delete(this._morphClientId);
            }
            if (VNCCS_SHARED_MORPH_CLIENTS.size === 0 && VNCCS_SHARED_MORPH_WORKER) {
                try { VNCCS_SHARED_MORPH_WORKER.terminate(); } catch (_) {}
                VNCCS_SHARED_MORPH_WORKER = null;
                VNCCS_SHARED_MORPH_WORKER_WARMED = false;
            }
            this._morphWorker = null;
        }
        if (this.viewer) {
            this.viewer.dispose();
        }
    }

    async openFullscreen() {
        await preparePoseStudioBackendSession(this.node, { refresh: true });
        if (this._fullscreenHost || !this.container || this._disposed) return;
        this.viewer?.setViewportProjection("parallel");
        this._updateProjectionButton?.();
        this.applyCameraToViewer(false);
        const host = document.createElement("div");
        host.className = "vnccs-ps-fullscreen-host";
        const actions = document.createElement("div");
        actions.className = "vnccs-ps-fullscreen-actions";
        const imagePoseButton = document.createElement("button");
        imagePoseButton.className = "vnccs-ps-fullscreen-import";
        imagePoseButton.type = "button";
        imagePoseButton.textContent = "通过图片获取姿势";
        imagePoseButton.title = "上传图片识别姿势；确定姿势并返回画布后卸载识别模型";
        imagePoseButton.addEventListener("click", () => {
            if (imagePoseButton.disabled || this._disposed) return;
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.style.display = "none";
            input.addEventListener("cancel", () => input.remove(), { once: true });
            input.addEventListener("change", async () => {
                const file = input.files?.[0];
                input.remove();
                if (!file) return;
                imagePoseButton.disabled = true;
                imagePoseButton.textContent = "准备识别…";
                imagePoseButton.title = "正在识别图片姿势";
                try {
                    this.syncToNode(false, { skipCapture: true });
                    await requestPoseFromImageFile(this, file, {
                        autoUnload: false,
                        applyMode: "pose_from_image",
                        onProgress: (value, message = "") => {
                            const percent = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
                            imagePoseButton.textContent = `识别中 ${percent}%`;
                            imagePoseButton.title = message || "正在识别图片姿势";
                        },
                    });
                } catch (error) {
                    this.showMessage(`获取图片姿势失败：${error?.message || error}`, true);
                } finally {
                    imagePoseButton.disabled = false;
                    imagePoseButton.textContent = "通过图片获取姿势";
                    imagePoseButton.title = "上传图片识别姿势；确定姿势并返回画布后卸载识别模型";
                }
            }, { once: true });
            document.body.appendChild(input);
            input.click();
        });
        actions.appendChild(imagePoseButton);
        const saveLibraryButton = document.createElement("button");
        saveLibraryButton.className = "vnccs-ps-fullscreen-save-library";
        saveLibraryButton.type = "button";
        saveLibraryButton.textContent = "添加到姿势库";
        saveLibraryButton.title = "填写信息并保存当前姿势到姿势库";
        saveLibraryButton.addEventListener("click", () => this.showSaveToLibraryModal());
        actions.appendChild(saveLibraryButton);
        const libraryButton = document.createElement("button");
        libraryButton.className = "vnccs-ps-fullscreen-library";
        libraryButton.type = "button";
        libraryButton.textContent = "📚 姿势库";
        libraryButton.title = "打开姿势库";
        libraryButton.addEventListener("click", () => this.showLibraryModal());
        actions.appendChild(libraryButton);
        const confirmButton = document.createElement("button");
        confirmButton.className = "vnccs-ps-fullscreen-confirm";
        confirmButton.type = "button";
        confirmButton.textContent = "确定姿势";
        const closeButton = document.createElement("button");
        closeButton.className = "vnccs-ps-fullscreen-close";
        closeButton.type = "button";
        closeButton.textContent = "×";
        closeButton.title = "关闭姿势编辑器";
        closeButton.setAttribute("aria-label", "关闭姿势编辑器");
        closeButton.addEventListener("click", () => {
            if (!this._confirmingFullscreen) this.closeFullscreen({ sync: false });
        });
        confirmButton.addEventListener("click", async () => {
            if (confirmButton.disabled) return;
            confirmButton.disabled = true;
            this._confirmingFullscreen = true;
            closeButton.disabled = true;
            confirmButton.textContent = "正在保存…";
            try {
                await waitForPoseStudioSyncIdle(this);
                if (this._poseDataRestoreError || this._poseDataRestorePending) {
                    throw new Error(this._poseDataRestoreError || "姿势仍在恢复，请稍后重试。");
                }
                const hasCharacters = !!this.characters?.length && !!this.getActiveCharacter();
                if (!this.viewer?.isInitialized() && (hasCharacters || !this.viewer?.initialized)) {
                    throw new Error("姿势场景尚未加载完成。");
                }
                // Save the confirmed pose and capture its node preview. The
                // downstream graph should run only when the user runs workflow.
                this.syncToNode(false, { skipCapture: !hasCharacters });
                let capture = hasCharacters ? this.poseCaptures?.[this.activeTab] : null;
                if (!hasCharacters) {
                    this.viewer.clearPassiveCharacters?.();
                    this.viewer.setMannequinVisible?.(false);
                    this.applyCameraToViewer(false);
                    capture = this.viewer.capture(
                        this.exportParams.view_width || 1024,
                        this.exportParams.view_height || 1024,
                        1, [0, 0, 0], 0, 0,
                        this.exportParams.cam_yaw_deg || 0,
                        this.exportParams.cam_pitch_deg || 0,
                        { roll_deg: this.exportParams.cam_roll_deg || 0 },
                    );
                }
                if (this.host?.onConfirm) {
                    if (!capture) throw new Error("当前姿势尚未生成图片，请稍后重试。");
                    await this.host.onConfirm(capture);
                }
                const preview = this.node?._vnccsPosePreviewWidget;
                if (capture && preview) {
                    const image = new Image();
                    image.onload = () => {
                        preview.image = image;
                        this.node?.setDirtyCanvas?.(true, true);
                    };
                    image.src = capture;
                }
                this.closeFullscreen({ sync: false });
                // Wait for the backend to finish releasing GPU models after the
                // normal ComfyUI canvas is visible again.
                if (typeof unloadPoseRecognitionModels === "function") {
                    try {
                        const unload = await unloadPoseRecognitionModels();
                        console.info("[VNCCS Pose Studio] Recognition models unloaded:", unload);
                    } catch (error) {
                        console.warn("[VNCCS Pose Studio] Deferred recognition-model unload failed:", error);
                    }
                }
            } catch (error) {
                this.showMessage(`保存姿势失败：${error?.message || error}`, true);
            } finally {
                this._confirmingFullscreen = false;
                closeButton.disabled = false;
                if (confirmButton.isConnected) {
                    confirmButton.disabled = false;
                    confirmButton.textContent = "确定姿势";
                }
            }
        });
        actions.appendChild(confirmButton);
        actions.appendChild(closeButton);
        host.appendChild(actions);
        this._fullscreenPlaceholder = document.createComment("Pose Studio node editor");
        this._fullscreenImportButton = imagePoseButton;
        this._fullscreenReturnFocus = document.activeElement;
        this.container.parentNode?.insertBefore(this._fullscreenPlaceholder, this.container);
        host.appendChild(this.container);
        document.body.appendChild(host);
        this._fullscreenHost = host;
        this.container.inert = false;
        // 进入全屏后主动把焦点移入编辑器容器：否则焦点仍留在 body，
        // 键盘快捷键（1/2/3 视图、Tab 切换人物等）在首次点击前不生效。
        this.container.tabIndex = -1;
        this.container.style.outline = "none";
        try { this.container.focus({ preventScroll: true }); } catch (_) {}
        this.container.style.setProperty("--vnccs-ps-ui-scale", "1");
        this.container.style.setProperty("--vnccs-ps-relative-ui-scale", (1 / POSE_STUDIO_LAYOUT_REFERENCE_UI_SCALE).toFixed(3));
        this._fullscreenFontOriginals = new Map();
        const enforceMinimumFontSize = root => {
            const elements = [];
            if (root.nodeType === Node.ELEMENT_NODE) elements.push(root);
            elements.push(...(root.querySelectorAll?.("*") || []));
            for (const element of elements) {
                if (Number.parseFloat(getComputedStyle(element).fontSize) >= 12) continue;
                if (!this._fullscreenFontOriginals.has(element)) {
                    this._fullscreenFontOriginals.set(element, [element.style.getPropertyValue("font-size"), element.style.getPropertyPriority("font-size")]);
                }
                element.style.setProperty("font-size", "14px", "important");
            }
        };
        enforceMinimumFontSize(this.container);
        this._fullscreenFontObserver = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) enforceMinimumFontSize(node);
            }
        });
        this._fullscreenFontObserver.observe(this.container, { childList: true, subtree: true });
        requestAnimationFrame(() => {
            this.scheduleMainUIScaleCommit({ width: host.clientWidth, height: host.clientHeight, force: true });
            this.resize({ forceUIScale: true });
            this.resetToMainView();
        });
        this._fullscreenResizeHandler = () => {
            this.scheduleMainUIScaleCommit({ width: host.clientWidth, height: host.clientHeight, force: true });
            this.resize({ forceUIScale: true });
        };
        window.addEventListener("resize", this._fullscreenResizeHandler);
        this._fullscreenKeyHandler = event => {
            if (event.key !== "Escape" || this.container?.querySelector(".vnccs-ps-modal-overlay")) return;
            event.preventDefault();
            event.stopPropagation();
            if (this._confirmingFullscreen) return;
            this.closeFullscreen();
        };
        document.addEventListener("keydown", this._fullscreenKeyHandler, true);
        this.syncToNode(false, { skipCapture: true });
    }

    async getPoseFromImageFile(file, options = {}) {
        if (this._disposed) throw new Error("Pose Studio was disposed.");
        this.syncToNode(false, { skipCapture: true });
        return requestPoseFromImageFile(this, file, options);
    }

    closeFullscreen({ sync = true } = {}) {
        const host = this._fullscreenHost;
        if (!host) return;
        if (sync && !this._disposed) this.syncToNode(false, { skipCapture: true });
        if (this._fullscreenKeyHandler) {
            document.removeEventListener("keydown", this._fullscreenKeyHandler, true);
            this._fullscreenKeyHandler = null;
        }
        if (this._fullscreenResizeHandler) {
            window.removeEventListener("resize", this._fullscreenResizeHandler);
            this._fullscreenResizeHandler = null;
        }
        this._fullscreenFontObserver?.disconnect();
        this._fullscreenFontObserver = null;
        for (const [element, [fontSize, priority]] of this._fullscreenFontOriginals || []) {
            if (element.style.getPropertyValue("font-size") !== "14px" || element.style.getPropertyPriority("font-size") !== "important") continue;
            if (fontSize) element.style.setProperty("font-size", fontSize, priority);
            else element.style.removeProperty("font-size");
        }
        this._fullscreenFontOriginals = null;
        if (this._fullscreenPlaceholder?.parentNode) {
            this._fullscreenPlaceholder.parentNode.insertBefore(this.container, this._fullscreenPlaceholder);
            this._fullscreenPlaceholder.remove();
        } else if (this._nodeDOMWidgetElement?.parentNode) {
            this._nodeDOMWidgetElement.parentNode.replaceChild(this.container, this._nodeDOMWidgetElement);
        }
        this._fullscreenPlaceholder = null;
        this._fullscreenHost = null;
        this._fullscreenImportButton = null;
        host.remove();
        this._fullscreenReturnFocus?.focus?.();
        this._fullscreenReturnFocus = null;
        requestAnimationFrame(() => {
            if (this._disposed) return;
            this.scheduleMainUIScaleCommit({ width: this.container?.clientWidth, height: this.container?.clientHeight, force: true });
            this.resize({ forceUIScale: true });
        });
    }

    createUI() {
        this._createLayout();
        // Observe before building controls so the first rendered frame already
        // uses the active locale and does not shift when labels translate.
        this._i18nCleanup = observePoseStudioI18n(this.container, app);
        this._createLeftPanel();
        this._createCenterPanel();
        this._createRightSidebar();
        this._setupFinalUI();
    }

    _createLayout() {
        this.container = document.createElement("div");
        this.container.className = "vnccs-pose-studio";
        this._poseStudioContextMenuHandler = event => {
            if (this.container?.contains(event.target) || this._fullscreenHost?.contains(event.target)) {
                event.preventDefault();
            }
        };
        window.addEventListener("contextmenu", this._poseStudioContextMenuHandler, true);
        enablePoseStudioCanvasNavigationForwarding(this.container);
        // 可聚焦容器：点击编辑器空白处时把焦点收进容器，键盘快捷键即可生效；
        // 点击输入框/按钮等可聚焦控件时不抢占焦点。
        this.container.tabIndex = -1;
        this.container.style.outline = "none";
        this.container.addEventListener("pointerdown", event => {
            if (event.target?.closest?.("input, textarea, select, button, a, [contenteditable='true'], [tabindex]:not([tabindex='-1'])")) return;
            try { this.container.focus({ preventScroll: true }); } catch (_) {}
        });

        this.leftPanel = document.createElement("div");
        this.leftPanel.className = "vnccs-ps-left";
        this.container.appendChild(this.leftPanel);

        this.centerPanel = document.createElement("div");
        this.centerPanel.className = "vnccs-ps-center";
        this.container.appendChild(this.centerPanel);

        this.rightSidebar = document.createElement("div");
        this.rightSidebar.className = "vnccs-ps-right-sidebar";
        this.container.appendChild(this.rightSidebar);
    }






    formatMeshValue(key, value) {
        return key === "age" || key === "view_width" || key === "view_height"
            ? String(Math.round(Number(value) || 0))
            : Number(value || 0).toFixed(2);
    }


    applyExternalCharacterCreatorValues(values, { initial = false } = {}) {
        if (!values) return false;
        let changed = false;
        const sourceKeys = [];

        if (Number.isFinite(values.age)) {
            const age = Math.max(1, Math.min(90, Math.round(values.age)));
            if (this.meshParams.age !== age) {
                this.meshParams.age = age;
                sourceKeys.push("age");
                changed = true;
            }
        }

        if (Number.isFinite(values.gender)) {
            const gender = Math.max(0, Math.min(1, values.gender));
            if (this.meshParams.gender !== gender) {
                this.meshParams.gender = gender;
                sourceKeys.push("gender");
                changed = true;
            }
        }

        if (!changed) return false;

        for (const key of sourceKeys) {
            const main = this.sliders?.[key];
            if (main) {
                main.slider.value = this.meshParams[key];
                main.label.innerText = this.formatMeshValue(key, this.meshParams[key]);
            }
        }

        this.updateGenderUI();
        if (initial) {
            this._suppressNextAgeFitSync = true;
        }
        this.onMeshParamsChanged(sourceKeys.includes("age") ? "age" : sourceKeys[0]);
        if (!initial) {
            this.syncToNode(false)
        }
        return true;
    }



    _createLeftPanel() {
        const leftPanel = this.leftPanel;


        // --- MESH PARAMS SECTION ---
        const meshSection = this.createSection("Mesh Parameters", true);

        // Gender Toggle
        const genderField = document.createElement("div");
        genderField.className = "vnccs-ps-field";

        const genderLabel = document.createElement("div");
        genderLabel.className = "vnccs-ps-label";
        genderLabel.innerText = "Gender";
        genderField.appendChild(genderLabel);

        const genderToggle = document.createElement("div");
        genderToggle.className = "vnccs-ps-toggle";

        const btnMale = document.createElement("button");
        btnMale.className = "vnccs-ps-toggle-btn male";
        btnMale.innerText = "Male";

        const btnFemale = document.createElement("button");
        btnFemale.className = "vnccs-ps-toggle-btn female";
        btnFemale.innerText = "Female";

        this.genderBtns = { male: btnMale, female: btnFemale };

        btnMale.addEventListener("click", () => {
            this.meshParams.gender = 1.0;
            this.updateGenderUI();
            this.onMeshParamsChanged("gender");
        });

        btnFemale.addEventListener("click", () => {
            this.meshParams.gender = 0.0;
            this.updateGenderUI();
            this.onMeshParamsChanged("gender");
        });

        this.updateGenderUI();

        genderToggle.appendChild(btnMale);
        genderToggle.appendChild(btnFemale);
        genderField.appendChild(genderToggle);
        meshSection.content.appendChild(genderField);

        // Base Mesh Sliders (gender-neutral)
        const baseSliderDefs = [
            { key: "age", label: "Age", min: 1, max: 90, step: 1, def: 25 },
            { key: "weight", label: "Fatness", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "height", label: "Height", min: 0, max: 2, step: 0.01, def: 0.5 }
        ];

        for (const s of baseSliderDefs) {
            const field = this.createSliderField(s.label, s.key, s.min, s.max, s.step, s.def, this.meshParams);
            meshSection.content.appendChild(field);
        }

        // Female-only body controls. The morph runtime already maps this
        // normalized value to MakeHuman's cup-size targets.
        const breastSizeField = this.createSliderField(
            "Breast Size", "breast_size", 0, 1, 0.01, 0.5, this.meshParams
        );
        this.femaleMeshFields = [breastSizeField];
        meshSection.content.appendChild(breastSizeField);

        const genitalsField = document.createElement("div");
        genitalsField.className = "vnccs-ps-field vnccs-ps-checkbox-field";
        const genitalsToggle = document.createElement("input");
        genitalsToggle.type = "checkbox";
        genitalsToggle.checked = this.meshParams.show_genitals === true;
        this.genitalsToggle = genitalsToggle;
        const genitalsLabel = document.createElement("span");
        genitalsLabel.className = "vnccs-ps-label";
        genitalsLabel.innerText = xzgTh("Show Genitals", "Show Genitals");
        genitalsField.append(genitalsToggle, genitalsLabel);
        genitalsToggle.addEventListener("change", () => {
            this.meshParams.show_genitals = genitalsToggle.checked;
            this.updateGenderUI();
            this.onMeshParamsChanged("show_genitals");
        });
        genitalsLabel.addEventListener("click", () => {
            genitalsToggle.checked = !genitalsToggle.checked;
            genitalsToggle.dispatchEvent(new Event("change"));
        });

        const genitalSizeDefs = [
            { key: "penis_len", label: "Length" },
            { key: "penis_circ", label: "Girth" },
            { key: "penis_test", label: "Testicles" },
        ];
        this.genitalSizeFields = genitalSizeDefs.map(({ key, label }) =>
            this.createSliderField(xzgTh(label, label), key, 0, 1, 0.01, 0.5, this.meshParams)
        );
        meshSection.content.appendChild(genitalsField);
        for (const field of this.genitalSizeFields) meshSection.content.appendChild(field);
        this.maleMeshFields = [genitalsField];
        this.updateGenderUI();

        leftPanel.appendChild(meshSection.el);

        // --- MESH PROPORTIONS SECTION ---
        const proportionsSection = this.createSection("Mesh Proportions", true);
        const proportionSliderDefs = [
            { key: "head_size", label: "Head Size", min: 0.5, max: 2.0, step: 0.01, def: 1.0 },
            { key: "arm_size",  label: "Arm Size",  min: 0.5, max: 2.0, step: 0.01, def: 1.0 },
            { key: "hand_size", label: "Hand Size", min: 0.5, max: 2.0, step: 0.01, def: 1.0 },
            { key: "foot_size", label: "Foot Size", min: 0.5, max: 2.0, step: 0.01, def: 1.0 },
            { key: "shoulder_l_length", label: "Left Clavicle Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "shoulder_r_length", label: "Right Clavicle Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "hip_l_length", label: "Left Hip Offset", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "hip_r_length", label: "Right Hip Offset", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "upper_arm_l_length", label: "Left Upper Arm Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "upper_arm_r_length", label: "Right Upper Arm Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "forearm_l_length", label: "Left Forearm Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "forearm_r_length", label: "Right Forearm Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "thigh_l_length", label: "Left Thigh Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "thigh_r_length", label: "Right Thigh Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "shin_l_length", label: "Left Shin Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "shin_r_length", label: "Right Shin Length", min: 0, max: 1, step: 0.01, def: 0.5 },
            { key: "spine_length", label: "Spine Length", min: 0, max: 1, step: 0.01, def: 0.5 }
        ];

        const rightProportionKeys = new Set(SYMMETRIC_MESH_PROPORTION_PAIRS.map(pair => pair.right));
        const proportionPairs = new Map(SYMMETRIC_MESH_PROPORTION_PAIRS.map(pair => [pair.left, pair]));
        normalizeSymmetricMeshProportions(this.meshParams);

        for (const s of proportionSliderDefs) {
            if (rightProportionKeys.has(s.key)) continue;
            const pair = proportionPairs.get(s.key);
            const field = this.createSliderField(
                pair?.label || s.label,
                s.key,
                s.min,
                s.max,
                s.step,
                s.def,
                this.meshParams,
                false,
                pair?.right,
            );
            proportionsSection.content.appendChild(field);
        }

        leftPanel.appendChild(proportionsSection.el);

        const resetActivePoseBtn = document.createElement("button");
        resetActivePoseBtn.type = "button";
        resetActivePoseBtn.className = "vnccs-ps-btn";
        resetActivePoseBtn.style.width = "100%";
        resetActivePoseBtn.style.marginTop = "6px";
        resetActivePoseBtn.style.fontSize = "14px";
        resetActivePoseBtn.textContent = "恢复当前角色初始姿势";
        resetActivePoseBtn.title = "恢复当前角色的初始姿势、身体参数和身体比例，保留角色位置和当前视图";
        resetActivePoseBtn.disabled = !this.getActiveCharacter();
        resetActivePoseBtn.addEventListener("click", async () => {
            resetActivePoseBtn.disabled = true;
            try {
                await this.resetActiveCharacterPose();
            } catch (error) {
                this.showMessage(`恢复初始姿势失败：${error?.message || error}`, true);
            } finally {
                resetActivePoseBtn.disabled = !this.getActiveCharacter();
            }
        });
        this.resetActivePoseBtn = resetActivePoseBtn;
        leftPanel.appendChild(resetActivePoseBtn);

        const resetCharacterPoseTransformBtn = document.createElement("button");
        resetCharacterPoseTransformBtn.type = "button";
        resetCharacterPoseTransformBtn.className = "vnccs-ps-btn";
        resetCharacterPoseTransformBtn.style.width = "100%";
        resetCharacterPoseTransformBtn.style.marginTop = "6px";
        resetCharacterPoseTransformBtn.style.fontSize = "14px";
        resetCharacterPoseTransformBtn.textContent = "恢复角色姿势和大小位置";
        resetCharacterPoseTransformBtn.title = "恢复当前角色的初始姿势、身体参数、大小和位置，保留场景视角";
        resetCharacterPoseTransformBtn.disabled = !this.getActiveCharacter();
        resetCharacterPoseTransformBtn.addEventListener("click", async () => {
            resetCharacterPoseTransformBtn.disabled = true;
            try {
                await this.resetActiveCharacterPoseAndTransform();
            } catch (error) {
                this.showMessage(`恢复角色姿势和大小位置失败：${error?.message || error}`, true);
            } finally {
                resetCharacterPoseTransformBtn.disabled = !this.getActiveCharacter();
            }
        });
        this.resetCharacterPoseTransformBtn = resetCharacterPoseTransformBtn;
        leftPanel.appendChild(resetCharacterPoseTransformBtn);

        const resetPoseCharactersBtn = document.createElement("button");
        resetPoseCharactersBtn.className = "vnccs-ps-btn";
        resetPoseCharactersBtn.style.width = "100%";
        resetPoseCharactersBtn.style.marginTop = "6px";
        resetPoseCharactersBtn.style.fontSize = "14px";
        resetPoseCharactersBtn.innerHTML = '<span class="vnccs-ps-btn-icon">↺</span> 清空所有人物';
        resetPoseCharactersBtn.title = "清空所有人物，并恢复主视图";
        resetPoseCharactersBtn.addEventListener("click", async () => {
            resetPoseCharactersBtn.disabled = true;
            try {
                await this.clearAllCharacters();
            } catch (error) {
                this.showMessage(`清空失败：${error?.message || error}`, true);
            } finally {
                resetPoseCharactersBtn.disabled = false;
            }
        });
        leftPanel.appendChild(resetPoseCharactersBtn);

    }

    _createCenterPanel() {
        const centerPanel = this.centerPanel;

        // Tab Bar
        this.tabsShell = document.createElement("div");
        this.tabsShell.className = "vnccs-ps-tabs-shell";

        this.tabScrollLeft = document.createElement("button");
        this.tabScrollLeft.className = "vnccs-ps-tab-scroll left";
        this.tabScrollLeft.type = "button";
        this.tabScrollLeft.title = "Scroll tabs left";
        this.tabScrollLeft.textContent = "<";
        this.tabScrollLeft.addEventListener("click", () => this.scrollTabs(-1));

        this.tabsContainer = document.createElement("div");
        this.tabsContainer.className = "vnccs-ps-tabs";
        this.tabsContainer.addEventListener("scroll", () => this.updateTabScrollButtons());

        this.tabScrollRight = document.createElement("button");
        this.tabScrollRight.className = "vnccs-ps-tab-scroll right";
        this.tabScrollRight.type = "button";
        this.tabScrollRight.title = "Scroll tabs right";
        this.tabScrollRight.textContent = ">";
        this.tabScrollRight.addEventListener("click", () => this.scrollTabs(1));

        this.tabsShell.appendChild(this.tabScrollLeft);
        this.tabsShell.appendChild(this.tabsContainer);
        this.tabsShell.appendChild(this.tabScrollRight);
        centerPanel.appendChild(this.tabsShell);
        if (typeof ResizeObserver !== "undefined") {
            this._tabResizeObserver = new ResizeObserver(() => {
                if (this._tabScrollFrame) return;
                this._tabScrollFrame = requestAnimationFrame(() => {
                    this._tabScrollFrame = null;
                    this.updateTabScrollButtons();
                });
            });
            this._tabResizeObserver.observe(this.tabsContainer);
        }
        this.updateTabs();


        // Canvas Container
        this.canvasContainer = document.createElement("div");
        this.canvasContainer.className = "vnccs-ps-canvas-wrap";

        this.canvas = document.createElement("canvas");
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute("aria-label", "姿势编辑视图。按 1 吸附到最近的标准视图，按 2 切换主视图，按 3 切换左视图，按 4 切换右视图");
        this.canvas.addEventListener("pointerdown", () => {
            this.canvas.focus({ preventScroll: true });
        }, true);
        this.canvasContainer.appendChild(this.canvas);
        const canvasControlHint = document.createElement("div");
        canvasControlHint.className = "vnccs-ps-canvas-control-hint";
        const controlHintGroups = [
            ["视图控制：", [
                "左键移动视图",
                "右键旋转视图",
                "鼠标滚轮缩放视图",
                "1 吸附标准视图；2 主视图；3 左视图；4 右视图",
            ]],
            ["人物控制：", [
                "Ctrl＋左键平移人物",
                "Ctrl＋右键自由旋转人物，以中心白点为轴心",
                "Ctrl＋鼠标滚轮缩放人物",
                "单击关节选择，拖动关节圆点调整姿势",
                "双击关节锁定（红锁），双击空白解锁",
            ]],
            ["坐标控制：", [
                "大白点：箭头移动，扇形平移，弧线旋转",
                "关节：拖原点调姿势，弧线旋转",
                "右键切换屏幕坐标；重新选择后恢复",
            ]],
            ["人物选择：", ["点击人物或编号激活，Tab切换", "Ctrl＋点击多选，Ctrl＋A全选", "多选后可整体平移、旋转、缩放"]],
        ];
        for (const [title, lines] of controlHintGroups) {
            const section = document.createElement("div");
            section.style.marginBottom = "6px";
            const heading = document.createElement("div");
            heading.textContent = title;
            heading.style.fontWeight = "700";
            section.appendChild(heading);
            for (const text of lines) {
                const line = document.createElement("div");
                line.textContent = text;
                line.style.paddingLeft = "12px";
                section.appendChild(line);
            }
            canvasControlHint.appendChild(section);
        }
        Object.assign(canvasControlHint.style, {
            position: "absolute", top: "12px", left: "32px",
            zIndex: "20", pointerEvents: "none", whiteSpace: "nowrap", fontSize: "13px", lineHeight: "1.45",
            color: "rgba(220, 220, 230, .72)", textShadow: "0 1px 3px rgba(0, 0, 0, .9)",
        });
        this.canvasControlHint = canvasControlHint;
        this.canvasContainer.appendChild(canvasControlHint);
        translatePoseStudioSubtree(canvasControlHint, app);
        this._createHandPopover();
        centerPanel.appendChild(this.canvasContainer);

        // Action Bar
        const actions = document.createElement("div");
        actions.className = "vnccs-ps-actions";

        const undoBtn = document.createElement("button");
        undoBtn.className = "vnccs-ps-btn";
        undoBtn.innerHTML = '<span class="vnccs-ps-btn-icon">↩</span> Undo';
        undoBtn.onclick = () => this.viewer && this.viewer.undo();

        const redoBtn = document.createElement("button");
        redoBtn.className = "vnccs-ps-btn vnccs-ps-btn-redo";
        redoBtn.innerHTML = '<span class="vnccs-ps-btn-icon">↪</span> Redo';
        redoBtn.onclick = () => this.viewer && this.viewer.redo();

        const snapBtn = document.createElement("button");
        snapBtn.className = "vnccs-ps-btn vnccs-ps-view-btn vnccs-ps-btn-reset-view";
        snapBtn.textContent = "主视图";
        snapBtn.title = "将视口重置到画布输出视角";
        snapBtn.addEventListener("click", () => this.resetToMainView());

        const viewButtons = [
            ["left", "左视图"],
            ["right", "右视图"],
            ["back", "后视图"],
            ["top", "顶视图"],
            ["bottom", "底视图"],
        ];
        const viewButtonElements = viewButtons.map(([view, label]) => {
            const button = document.createElement("button");
            button.className = "vnccs-ps-btn vnccs-ps-view-btn";
            button.type = "button";
            button.textContent = label;
            button.title = label;
            button.addEventListener("click", () => this.viewer?.setViewportView?.(view));
            return button;
        });

        actions.appendChild(undoBtn);
        actions.appendChild(redoBtn);
        actions.appendChild(snapBtn);
        actions.append(...viewButtonElements);
        const projectionButton = document.createElement("button");
        projectionButton.className = "vnccs-ps-btn vnccs-ps-view-btn vnccs-ps-btn-reset-view";
        projectionButton.type = "button";
        const updateProjectionButton = () => {
            const parallel = !!this.viewer?.camera?.isOrthographicCamera;
            projectionButton.textContent = parallel ? "平行" : "透视";
            projectionButton.title = `切换到${parallel ? "透视" : "平行（正交）"}视图`;
            projectionButton.setAttribute("aria-pressed", String(parallel));
        };
        this._updateProjectionButton = updateProjectionButton;
        updateProjectionButton();
        projectionButton.addEventListener("click", () => {
            if (!this.viewer?.isInitialized?.()) return;
            const parallel = !this.viewer.camera.isOrthographicCamera;
            if (!this.viewer.setViewportProjection(parallel ? "parallel" : "perspective")) return;
            updateProjectionButton();
        });
        actions.appendChild(projectionButton);

        this.actionToolbar = actions;
        this.canvasContainer.appendChild(actions);
        this.updateActionToolbarPosition();

        const refInput = document.createElement("input");
        refInput.type = "file"; refInput.accept = "image/*"; refInput.style.display = "none";
        refInput.addEventListener("change", (e) => this.handleRefImport(e));
        this.fileRefInput = refInput;
        this.container.appendChild(refInput);
    }

    commitViewerPoseToCurrentEditor({ fullCapture = false, syncOptions = {} } = {}) {
        if (!this.viewer?.isInitialized?.()) return;
        const character = this.getActiveCharacter();
        if (!character) return;
        const pose = this.stripSceneCameraFromPose(this.viewer.getPose());
        pose.cameraParams = this.currentCameraParams();
        this.poses[this.activeTab] = pose;
        character.poses = this.poses;
        // The committed pose replaces whatever this tab was captured with.
if (Array.isArray(this.poseCaptures) && this.activeTab < this.poseCaptures.length) {
            this.poseCaptures[this.activeTab] = null;
        }
        this.syncToNode(fullCapture, syncOptions);
    }

    _createRightSidebar() {
        const rightSidebar = this.rightSidebar;

        const dimensionsSection = this.createSection("画布设置", true);
        dimensionsSection.el.classList.add("vnccs-ps-output-dimensions");
        const dimRow = document.createElement("div");
        dimRow.className = "vnccs-ps-row vnccs-ps-camera-dim-row";
        dimRow.appendChild(this.createInputField("Width", "view_width", "number", 64, 4096, 8));
        dimRow.appendChild(this.createInputField("Height", "view_height", "number", 64, 4096, 8));
        dimensionsSection.content.appendChild(dimRow);

        const presetGroups = [
            { title: "常用生成尺寸", sizes: [[1024, 1024]] },
            { title: "宽屏常用尺寸", sizes: [[720, 1280], [1280, 720], [1080, 1920], [1920, 1080]] },
        ];
        for (const group of presetGroups) {
            const groupElement = document.createElement("div");
            groupElement.className = "vnccs-ps-dimension-preset-group";
            const groupTitle = document.createElement("div");
            groupTitle.className = "vnccs-ps-dimension-preset-group-title";
            groupTitle.textContent = group.title;
            const dimensionPresets = document.createElement("div");
            dimensionPresets.className = "vnccs-ps-dimension-presets";
            for (const [width, height] of group.sizes) {
                const presetButton = document.createElement("button");
                presetButton.type = "button";
                presetButton.className = "vnccs-ps-btn vnccs-ps-dimension-preset";
                presetButton.textContent = `${width} × ${height}`;
                presetButton.title = `${group.title}：设置画布尺寸为 ${width} × ${height}`;
                presetButton.addEventListener("click", () => {
                    this._outputSizeUserSet = true;
                    this.exportParams.view_width = width;
                    this.exportParams.view_height = height;
                    this.invalidatePoseCapturesForOutputSizeChange();
                    if (this.exportWidgets.view_width) this.exportWidgets.view_width.value = String(width);
                    if (this.exportWidgets.view_height) this.exportWidgets.view_height.value = String(height);
                    this._lastResizeW = 0;
                    this._lastResizeH = 0;
                    this.resize();
                    this.updateCaptureCameraPreview();
                    this.syncToNode(true);
                });
                dimensionPresets.appendChild(presetButton);
            }
            groupElement.appendChild(groupTitle);
            groupElement.appendChild(dimensionPresets);
            dimensionsSection.content.appendChild(groupElement);
        }
        rightSidebar.appendChild(dimensionsSection.el);

        // Characters panel starts expanded by default.
        // existing right-sidebar rhythm intact for single-character workflows.
        const charactersSection = this.createSection("多角色设置", true);
        charactersSection.el.classList.add("vnccs-ps-characters-section");
        this.charactersSection = charactersSection.el;
        this.charactersSectionTitle = charactersSection.title;
        this.charactersContent = charactersSection.content;
        rightSidebar.appendChild(charactersSection.el);
        this.renderCharactersUI();

        const backgroundSection = this.createSection("背景设置", true);
        backgroundSection.el.classList.add("vnccs-ps-background-section");
        const backgroundControls = document.createElement("div");
        backgroundControls.className = "vnccs-ps-background-controls";
        Object.assign(backgroundControls.style, {
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: "6px",
        });
        this.appendBackgroundControls(backgroundControls);
        backgroundSection.content.appendChild(backgroundControls);
        rightSidebar.appendChild(backgroundSection.el);

    }

    _setupFinalUI() {
        this._selectAllShortcutHandler = event => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key?.toLowerCase() !== "a") return;
            if (!this._fullscreenHost?.isConnected && !this.container?.contains(event.target)) return;
            const target = event.target;
            if (target?.isContentEditable || target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (this._switchingCharacter || this._hydratingCharacterScene || this.container?.querySelector(".vnccs-ps-modal-overlay")) return;
            this._selectedCharacterIds = new Set(this.characters.filter(character => !this._temporarilyHiddenCharacters.has(character.id)).map(character => character.id));
            this.renderCharactersUI();
        };
        window.addEventListener("keydown", this._selectAllShortcutHandler, true);
        this._viewShortcutHandler = event => {
            const target = event.target;
            // 全屏编辑界面下，焦点可能仍在 document.body（尚未点击编辑器内部），
            // 此时 event.target 是 body、不含于 container；全屏时编辑器独占屏幕，
            // 快捷键应始终生效，不再依赖「先点击一次」来进入交互状态。
            const fullscreenActive = !!this._fullscreenHost?.isConnected;
            if (!fullscreenActive && !this.container?.contains(target)) return;
            if (target?.isContentEditable || target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
            if (target?.closest?.(".vnccs-ps-modal-overlay")) return;
            // 焦点在 body 时（全屏未点击状态）closest 查不到弹窗，改为显式检查编辑器内是否有弹窗
            if (fullscreenActive && this.container?.querySelector(".vnccs-ps-modal-overlay")) return;

            // Character copy/paste is an editor shortcut; leave browser/text-field
            // clipboard behavior untouched (those targets were filtered above).
            if ((event.ctrlKey || event.metaKey) && !event.altKey) {
                const key = event.key?.toLowerCase();
                const selected = [...(this._selectedCharacterIds || [])];
                const canCopyCharacter = key === "c" && selected.length === 1;
                const canPasteCharacter = key === "v" && !!this._characterClipboard;
                if (canCopyCharacter || canPasteCharacter) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (event.repeat || this._switchingCharacter || this._hydratingCharacterScene) return;
                    if (key === "c") {
                        (async () => {
                            try {
                                const source = this.characters.find(character => character.id === selected[0]);
                                if (!source) return;
                                if (source.id !== this.activeCharacterId && !await this.selectCharacter(source.id)) return;
                                this.captureActiveCharacterRuntime();
                                const active = this.getActiveCharacter();
                                if (!active) return;
                                this._characterClipboard = JSON.parse(JSON.stringify({
                                    name: active.name,
                                    mesh: active.mesh,
                                    poses: active.poses,
                                    transform: active.transform,
                                }));
                            } catch (error) {
                                console.error("Failed to copy pose character:", error);
                            }
                        })();
                    } else {
                        this.duplicateCharacterFromClipboard().catch(error => {
                            console.error("Failed to paste pose character:", error);
                        });
                    }
                    return;
                }
            }

            if (event.defaultPrevented || event.repeat || event.altKey || event.metaKey) return;
            if (event.ctrlKey) return;

            if (event.key === "Delete") {
                const selected = this._selectedCharacterIds || new Set([this.activeCharacterId]);
                const ids = this.characters.filter(character => selected.has(character.id)).map(character => character.id);
                if (!ids.length) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                if (this._switchingCharacter || this._hydratingCharacterScene || this._deletingSelectedCharacters) return;
                this._deletingSelectedCharacters = true;
                (async () => {
                    try {
                        for (const id of ids) {
                            if (this._disposed) break;
                            await this.deleteCharacter(id);
                        }
                    } catch (error) {
                        console.error("Failed to delete selected pose characters:", error);
                    } finally {
                        this._deletingSelectedCharacters = false;
                    }
                })();
                return;
            }

            if (event.key === "Tab") {
                const characters = [...(this.characters || [])]
                    .filter(character => !this._temporarilyHiddenCharacters.has(character.id))
                    .sort((a, b) => a.slot - b.slot);
                if (characters.length > 1) {
                    const activeIndex = characters.findIndex(character => character.id === this.activeCharacterId);
                    const next = characters[(activeIndex + 1 + characters.length) % characters.length];
                    if (next) {
                        event.preventDefault();
                        event.stopPropagation();
                        this.selectCharacter(next.id).catch(error => {
                            console.error("Failed to switch pose character with Tab:", error);
                        });
                    }
                }
                return;
            }

            if (event.shiftKey || !(event.key === "1" || event.key === "2" || event.key === "3" || event.key === "4")) return;

            if (event.key === "1") this.viewer?.snapToNearestViewportView?.();
            else if (event.key === "2") this.resetToMainView();
            else this.viewer?.setViewportView?.(event.key === "3" ? "left" : "right");
            event.preventDefault();
            event.stopPropagation();
        };
        document.addEventListener("keydown", this._viewShortcutHandler, true);

        // Loading Overlay
        this.loadingOverlay = document.createElement("div");
        this.loadingOverlay.className = "vnccs-ps-loading-overlay";
        this.loadingOverlay.innerHTML = `
            <div class="vnccs-ps-loading-spinner"></div>
            <div class="vnccs-ps-loading-text">Loading Model...</div>
        `;
        this.container.appendChild(this.loadingOverlay);

        // Initialize viewer
        this.viewer = new PoseViewerCore(this.canvas, {
            // Model/pose/camera restoration can finish after the initial pad draw.
            onViewportRender: () => {
                this.host.onViewportRender?.();
                this.updateActionToolbarPosition();
                this._updateProjectionButton?.();
            },
            transparentBackground: this.host.embedded === true,
            skinMode: 'naked',
            enableTextureSkinning: true,
            enableMultiPass: true,
            showSkeletonHelper: true,
            showCaptureFrame: true,
            syncMode: 'end',
            useHandControlPopover: true,
            profileResizePhase: profilePoseStudioResize,
            onHandHover: ({ side }) => {
                this._hoveredHandSide = side;
                if (!side && !this._activeHandSide) {
                    this.hideHandControlPopover();
                }
            },
            onHandActivate: ({ side }) => {
                this.showHandControlPopover(side);
            },
            onBoneSelectionChange: ({ boneName, source }) => {
                if (source === "external") return;
            },
            onCharacterTransformChange: (transform) => {
                const character = this.getActiveCharacter();
                if (!character) return;
                character.transform = normalizeCharacterTransform({ ...character.transform, ...transform });
                this.exportParams.cam_offset_x = character.transform.x;
                this.exportParams.cam_offset_y = character.transform.y;
                this.exportParams.cam_zoom = character.transform.zoom;
                this.persistActivePoseCameraParams();
                this.syncToNode(false, { skipCapture: true });
            },
            getCharacterSelection: () => this.characters
                .filter(character => (this._selectedCharacterIds || new Set([this.activeCharacterId])).has(character.id) && !this._temporarilyHiddenCharacters.has(character.id))
                .map(character => ({ id: character.id, active: character.id === this.activeCharacterId, transform: this.characterTransformForScene(character) })),
            getActiveCharacterId: () => this.activeCharacterId,
            onCharacterGroupChange: (states, commit) => this.commitCharacterGroup(states, commit),
            onCharacterPick: (id, multiple) => {
                if (this._switchingCharacter || this._hydratingCharacterScene) return;
                const targetId = id ?? this.activeCharacterId;
                const action = multiple ? this.toggleCharacterSelection(targetId) : this.selectCharacter(targetId);
                action.catch(error => console.error("Failed to select clicked character:", error));
            },
            onCharacterSelectionClear: () => {
                if (this._switchingCharacter) return;
                this._selectedCharacterIds = new Set();
                this.viewer?.transform?.detach();
                this.renderCharactersUI();
            },
            onCharacterPoseChange: () => {
                if (this._switchingCharacter || this._hydratingCharacterScene) return;
                this.updateRotationSliders();
                this.commitViewerPoseToCurrentEditor({ syncOptions: { skipCapture: true } });
            },
            captureHistoryContext: () => ({
                lights: JSON.parse(JSON.stringify(this.lightParams)),
                characters: this.captureCharacterHistory(),
                activeCharacterId: this.activeCharacterId,
                selectedCharacterIds: [...(this._selectedCharacterIds || [])],
                hiddenCharacterIds: [...this._temporarilyHiddenCharacters],
                mesh: { ...this.meshParams }, transform: { ...this.getActiveCharacter()?.transform },
                cameraParams: this.currentCameraParams(),
                group: this.characters.map(character => ({ id: character.id, transform: { ...character.transform }, pose: JSON.parse(JSON.stringify(character.id === this.activeCharacterId ? this.viewer.getPose() : this.characterPoseForScene(character))) })),
            }),
            onHistoryRestore: pose => this.restoreImageHistory(pose),
            onPoseChange: (pose) => {
                this.updateRotationSliders();
                this.hideHandControlPopover();
                // Return params request logic mapped into direct assignment beforehand 
                this.viewer.setCameraParams({
                    ...this.currentCameraParams()
                });
                this.syncToNode();
            }
        });
        this.viewer.updateLights(this.lightParams);
        this._viewerInitPromise = this.viewer.init();
        this._viewerInitPromise.then(() => this._updateProjectionButton?.()).catch(error => {
            console.warn("Could not initialize the pose viewer:", error);
        });
        this.viewer.setUseHandControlPopover?.(true);

        this._customSelectController = installCustomSelects(this.container, {
            theme: "pose-studio",
        });
        this.startResizeObserver();
    }

    // === UI Helper Methods ===

    createSection(title, expanded = true) {
        const section = document.createElement("div");
        section.className = "vnccs-ps-section" + (expanded ? "" : " collapsed");

        const header = document.createElement("div");
        header.className = "vnccs-ps-section-header";
        header.innerHTML = `
            <span class="vnccs-ps-section-title">${title}</span>
            <span class="vnccs-ps-section-toggle">▼</span>
        `;

        const content = document.createElement("div");
        content.className = "vnccs-ps-section-content";
        const sectionId = `vnccs-ps-section-${this.node?.id ?? "new"}-${++this._sectionIdCounter}`;
        content.id = sectionId;
        header.setAttribute("role", "button");
        header.tabIndex = 0;
        header.setAttribute("aria-controls", sectionId);
        header.setAttribute("aria-expanded", String(!!expanded));
        const toggle = () => {
            const collapsed = section.classList.toggle("collapsed");
            header.setAttribute("aria-expanded", String(!collapsed));
        };
        header.addEventListener("click", toggle);
        header.addEventListener("keydown", event => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggle();
        });

        section.appendChild(header);
        section.appendChild(content);

        return { el: section, header, title: header.querySelector(".vnccs-ps-section-title"), content };
    }

    getActiveCharacter() {
        return this.characters?.find(character => character.id === this.activeCharacterId)
            || this.characters?.[0]
            || null;
    }

    getInitialCharacterTransform() {
        if (this.initialCharacterTransform) {
            return normalizeCharacterTransform(this.initialCharacterTransform);
        }
        const firstCharacter = [...(this.characters || [])]
            .sort((left, right) => (left.slot ?? 0) - (right.slot ?? 0))[0];
        if (!firstCharacter) return null;
        this.initialCharacterTransform = normalizeCharacterTransform(
            firstCharacter.initialTransform || firstCharacter.transform,
        );
        return { ...this.initialCharacterTransform };
    }

    ensureCharacterRuntime(character) {
        if (!character) return null;
        if (!character.mesh || typeof character.mesh !== "object") character.mesh = {};
        normalizeSymmetricMeshProportions(character.mesh);
        if (typeof character.mesh.show_genitals !== "boolean") character.mesh.show_genitals = false;
        for (const key of ["penis_len", "penis_circ", "penis_test"]) {
            if (!Number.isFinite(Number(character.mesh[key]))) character.mesh[key] = 0.5;
        }
        character.transform = normalizeCharacterTransform(character.transform);
        character.initialTransform = normalizeCharacterTransform(character.initialTransform || character.transform);
        if (!Array.isArray(character.poses) || !character.poses.length) character.poses = [{}];
        const poseCount = Math.max(1, this.poses?.length || character.poses.length || 1);
        while (character.poses.length < poseCount) character.poses.push({});
        while (character.poses.length > poseCount) character.poses.pop();
        return character;
    }

    stripSceneCameraFromPose(pose) {
        if (!pose || typeof pose !== "object") return pose;
        delete pose.camera;
        delete pose.cameraParams;
        delete pose.sam_projection;
        delete pose.prompt;
        return pose;
    }

    captureActiveCharacterRuntime({ captureViewer = true } = {}) {
        const character = this.getActiveCharacter();
        if (!character) return null;

        if (captureViewer && this.viewer?.isInitialized?.()) {
            const pose = this.stripSceneCameraFromPose(this.viewer.getPose());
            pose.cameraParams = this.currentCameraParams();
            this.poses[this.activeTab] = pose;
        }

        character.mesh = this.meshParams;
        character.poses = this.poses;
        // Character placement is authoritative here. Legacy camera fields are
        // still mirrored for old workflows, but SAM camera fitting may change
        // them temporarily and must never overwrite a character transform.
        character.transform = normalizeCharacterTransform(character.transform);
        return character;
    }

    characterPoseForScene(character, { poseIndex = this.activeTab } = {}) {
        this.ensureCharacterRuntime(character);
        return character.poses[poseIndex] || character.poses[0] || {};
    }

    characterTransformForScene(character, { poseIndex = this.activeTab } = {}) {
        this.ensureCharacterRuntime(character);
        const cameraParams = this.cameraParamsForPose(
            character.poses[poseIndex] || character.poses[0] || {},
            character,
        );
        return normalizeCharacterTransform({
            ...character.transform,
            x: cameraParams.offset_x,
            y: cameraParams.offset_y,
            zoom: cameraParams.zoom,
        });
    }

    updateCharacterScene({ frame = null, poseIndex = this.activeTab, rebuildMissing = true } = {}) {
        if (!this.viewer?.isInitialized?.()) return;
        const active = this.getActiveCharacter();
        if (!active) {
            this.viewer.clearPassiveCharacters?.();
            this.viewer.setMannequinVisible(false);
            this.viewer.transform?.detach();
            this.viewer.requestRender();
            return;
        }
        const sceneIds = new Set(this.characters.map(character => String(character.id)));
        for (const id of [...(this.viewer.passiveCharacters?.keys?.() || [])]) {
            if (!sceneIds.has(String(id)) || String(id) === String(active.id)) {
                this.viewer.removePassiveCharacter?.(id);
            }
        }
        const activeTransform = this.characterTransformForScene(active, { frame, poseIndex });
        this.viewer.setActiveCharacterAppearance({
            color: active.color,
            transform: activeTransform,
        });
        this.viewer.setMannequinVisible(!this._temporarilyHiddenCharacters.has(active.id));

        for (const character of this.characters) {
            if (character.id === active.id) continue;
            const pose = this.characterPoseForScene(character, { frame, poseIndex });
            const transform = this.characterTransformForScene(character, { frame, poseIndex });
            if (!this.viewer.passiveCharacters?.has?.(character.id) && rebuildMissing) {
                this.viewer.upsertPassiveCharacterFromActive(character.id, {
                    pose,
                    color: character.color,
                    transform,
                });
            } else {
                this.viewer.setPassiveCharacterState(character.id, {
                    pose,
                    color: character.color,
                    transform,
                });
            }
            const entry = this.viewer.passiveCharacters?.get(character.id);
            if (entry?.mesh) entry.mesh.visible = !this._temporarilyHiddenCharacters.has(character.id);
        }
        this.viewer.requestRender();
    }

    syncCharacterEditorControls() {
        for (const [key, info] of Object.entries(this.sliders || {})) {
            if (key.startsWith("rot_") || !info?.def || this.meshParams[key] === undefined) continue;
            info.slider.value = this.meshParams[key];
            info.label.innerText = key === "age"
                ? String(Math.round(Number(this.meshParams[key]) || 0))
                : Number(this.meshParams[key] || 0).toFixed(2);
        }
        this.updateGenderUI();
        this.syncCameraWidgets();
        this.updateRotationSliders();
    }

    async addCharacter(requestedSlot = null, { rebuildScene = true } = {}) {
        if (this.characters.length >= MAX_POSE_STUDIO_CHARACTERS || this._switchingCharacter) return false;
        const addingFirstCharacter = this.characters.length === 0;
        this.captureActiveCharacterRuntime();
        const slot = nextCharacterSlot(this.characters, requestedSlot);
        if (slot < 0) return false;
        const id = nextCharacterId(this.characters);
        const spread = [0, 3, -3, 6, -6][slot] ?? slot * 3;
        // Inside UniCanvas the new mannequin starts as a copy of the active one (pose, height, depth,
        // zoom) standing beside it, so both fit together and only need a small adjustment.
        const clone = this.host?.embedded === true ? this.getActiveCharacter() : null;
        const initialTransform = clone
            ? { x: spread, y: clone.transform?.y ?? 0, z: clone.transform?.z ?? 0, zoom: clone.transform?.zoom ?? 1 }
            : { x: spread, y: 0, z: 0, zoom: 1 };
        const poses = Array.from({ length: Math.max(1, this.poses.length) }, (_, index) => {
            const sceneCamera = this.cameraParamsForPose(this.poses[index]);
            return {
                ...(clone ? JSON.parse(JSON.stringify(this.poses[index] || {})) : {}),
                cameraParams: {
                    offset_x: initialTransform.x,
                    offset_y: initialTransform.y,
                    zoom: initialTransform.zoom,
                    yaw_deg: sceneCamera.yaw_deg,
                    pitch_deg: sceneCamera.pitch_deg,
                },
            };
        });
        const characterMesh = JSON.parse(JSON.stringify(this.meshParams));
        characterMesh.show_genitals = false;
        const character = createPoseStudioCharacter({
            id,
            index: slot,
            slot,
            name: `Character ${slot + 1}`,
            color: nextCharacterColor(this.characters),
            transform: initialTransform,
            initialTransform: this.getInitialCharacterTransform() || initialTransform,
            mesh: characterMesh,
            poses,
            poseCount: poses.length,
        });
        this.characters.push(character);
        this.characters.sort((left, right) => left.slot - right.slot);
        if (this.viewer?.isInitialized?.()) {
            this.viewer.upsertPassiveCharacterFromActive(character.id, {
                pose: this.characterPoseForScene(character),
                color: character.color,
                transform: this.characterTransformForScene(character),
            });
        }
        this.renderCharactersUI();
        const selected = await this.selectCharacter(character.id, { rebuildScene });
        if (!selected) return false;
        // Align against the new character's actual pose, after it has been
        // loaded into the active rig. Center its vertical bounds in the frame
        // and keep the rearmost point of every limb on the frame plane.
        const frameCenteredY = this.viewer?.getFrameCenteredCharacterY?.(character.transform.zoom);
        if (Number.isFinite(frameCenteredY)) character.transform.y = frameCenteredY;
        const backAlignedZ = this.viewer?.getBackAlignedCharacterZ?.(character.transform.zoom);
        if (Number.isFinite(backAlignedZ)) character.transform.z = backAlignedZ;
        character.transform = normalizeCharacterTransform(character.transform);
        if (addingFirstCharacter) {
            this.initialCharacterTransform = normalizeCharacterTransform(character.transform);
        }
        character.initialTransform = this.getInitialCharacterTransform() || normalizeCharacterTransform(character.transform);
        const activePose = character.poses[this.activeTab] || character.poses[0];
        if (activePose) {
            activePose.cameraParams = {
                ...this.cameraParamsForPose(activePose, character),
                offset_x: character.transform.x,
                offset_y: character.transform.y,
                zoom: character.transform.zoom,
            };
        }
        this.exportParams.cam_offset_x = character.transform.x;
        this.exportParams.cam_offset_y = character.transform.y;
        this.exportParams.cam_zoom = character.transform.zoom;
        this.viewer?.setActiveCharacterAppearance?.({ color: character.color, transform: character.transform });
        if (rebuildScene) this.updateCharacterScene();
        if (addingFirstCharacter) this.resetToMainView();
        this.persistActivePoseCameraParams();
        this.syncToNode(false, { skipCapture: true });
        return true;
    }

    async duplicateCharacterFromClipboard({ rebuildScene = true } = {}) {
        if (
            !this._characterClipboard
            || this.characters.length >= MAX_POSE_STUDIO_CHARACTERS
            || this._switchingCharacter
            || this._hydratingCharacterScene
        ) return false;
        const slot = nextCharacterSlot(this.characters);
        if (slot < 0) return false;

        const source = JSON.parse(JSON.stringify(this._characterClipboard));
        const sourceTransform = normalizeCharacterTransform(source.transform);
        const spacing = Math.max(2.5, sourceTransform.zoom * 2.5);
        const occupiedX = this.characters.map(character => this.characterTransformForScene(character).x);
        let targetX = sourceTransform.x + spacing;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (targetX > 48) targetX = sourceTransform.x - spacing * (attempt + 1);
            if (targetX < -48) targetX = sourceTransform.x + spacing * (attempt + 1);
            if (occupiedX.every(x => Math.abs(x - targetX) >= spacing * 0.8)) break;
            targetX += spacing;
        }
        const deltaX = targetX - sourceTransform.x;
        const transform = normalizeCharacterTransform({ ...sourceTransform, x: targetX });
        const poses = (Array.isArray(source.poses) ? source.poses : [{}]).map(poseValue => {
            const pose = JSON.parse(JSON.stringify(poseValue || {}));
            const camera = this.cameraParamsForPose(pose, { transform: sourceTransform });
            pose.cameraParams = {
                ...camera,
                offset_x: camera.offset_x + deltaX,
                offset_y: camera.offset_y,
                zoom: camera.zoom,
            };
            return pose;
        });
        const character = createPoseStudioCharacter({
            id: nextCharacterId(this.characters),
            index: slot,
            slot,
            name: `${source.name || `Character ${slot}`} 副本`,
            color: nextCharacterColor(this.characters),
            transform,
            initialTransform: this.getInitialCharacterTransform() || transform,
            mesh: source.mesh,
            poses,
            poseCount: Math.max(1, this.poses?.length || poses.length),
        });
        this.characters.push(character);
        this.characters.sort((left, right) => left.slot - right.slot);
        if (this.viewer?.isInitialized?.()) {
            this.viewer.upsertPassiveCharacterFromActive(character.id, {
                pose: this.characterPoseForScene(character),
                color: character.color,
                transform: this.characterTransformForScene(character),
            });
        }
        this.renderCharactersUI();
        return this.selectCharacter(character.id, { rebuildScene });
    }

    captureCharacterHistory() {
        this.captureActiveCharacterRuntime();
        return JSON.parse(JSON.stringify(this.characters));
    }

    async deleteCharacter(id, { rebuildScene = true } = {}) {
        if (this._switchingCharacter || this.viewer?._restoringHistory) return false;
        const characters = this.characters;
        const index = this.characters.findIndex(character => character.id === id);
        if (index < 0) return false;
        this._finishPoseGesture?.();
        const historyState = this.viewer?.getHistoryPose?.();
        const history = this.viewer?.history.slice() || [];
        const deletingActive = this.activeCharacterId === id;
        const fallback = this.characters[index === 0 ? 1 : index - 1];
        if (deletingActive && fallback && !await this.selectCharacter(fallback.id, { rebuildScene })) return false;
        if (this._disposed || characters !== this.characters) return false;
        const currentIndex = this.characters.findIndex(character => character.id === id);
        if (currentIndex >= 0) this.characters.splice(currentIndex, 1);
        this._temporarilyHiddenCharacters.delete(id);
        this._selectedCharacterIds?.delete(id);
        this.viewer?.removePassiveCharacter?.(id);
        if (!this.characters.length) {
            this.activeCharacterId = null;
            this._selectedCharacterIds = new Set();
            this.poses = this.poses.map(() => ({}));
            this.poseCaptures = [];
            this.hideHandControlPopover();
        }
        if (this.viewer && historyState) {
            this.viewer.history = [...history, JSON.stringify(historyState)].slice(-this.viewer.maxHistory);
            this.viewer.future = [];
        }
        this.renderCharactersUI();
        this.updateCharacterScene();
        this.syncToNode(false, { skipCapture: true });
        return true;
    }

    async waitForMorphIdle(timeoutMs = 120000) {
        const deadline = Date.now() + timeoutMs;
        while (
            (this._morphSolveInFlight || this._pendingMorphSolve || this._morphLoadTasks?.size)
            && Date.now() < deadline
        ) {
            await new Promise(resolve => setTimeout(resolve, 16));
        }
        if (this._morphSolveInFlight || this._pendingMorphSolve || this._morphLoadTasks?.size) {
            throw new Error("Pose Studio model morph is still in progress.");
        }
        if (this._morphWorkerFailed) throw new Error("Pose Studio body update failed. Reload ComfyUI to retry.");
    }

    async awaitReadyForCompositeCapture(timeoutMs = 120000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this._disposed) throw new Error("Pose Studio was disposed");
            if (this._referenceReadPromise) await this._referenceReadPromise;
            if (this._referenceReadError) throw new Error(this._referenceReadError);
            const hydration = this._sceneModelHydrationPromise;
            if (hydration) {
                await hydration;
                continue;
            }
            const modelLoad = this._modelLoadPromise;
            if (modelLoad) {
                await modelLoad;
                continue;
            }
            if (this._switchingCharacter) {
                await new Promise(resolve => setTimeout(resolve, 16));
                continue;
            }
            await this.waitForMorphIdle(Math.max(1, deadline - Date.now()));
            await this.viewer?.waitForCaptureReady?.();
            if (
                !this._sceneModelHydrationPromise
                && !this._modelLoadPromise
                && !this._switchingCharacter
                && !this._morphSolveInFlight
                && !this._pendingMorphSolve
            ) {
                return true;
            }
        }
        throw new Error("Pose Studio character scene is still loading.");
    }

    commitCharacterGroup(states, commit) {
        for (const state of states) {
            const character = this.characters.find(character => character.id === state.id);
            if (!character) continue;
            character.transform = normalizeCharacterTransform(state.transform);
            const pose = character.id === this.activeCharacterId ? this.stripSceneCameraFromPose(this.viewer.getPose()) : this.characterPoseForScene(character);
            pose.modelRotation = state.modelRotation;
            pose.cameraParams = { ...this.cameraParamsForPose(pose, character), offset_x: state.transform.x, offset_y: state.transform.y, zoom: state.transform.zoom };
            character.poses[this.activeTab] = pose;
        }
        const active = this.getActiveCharacter();
        if (active) {
            this.exportParams.cam_offset_x = active.transform.x;
            this.exportParams.cam_offset_y = active.transform.y;
            this.exportParams.cam_zoom = active.transform.zoom;
        }
        if (commit) {
            this.captureActiveCharacterRuntime();
            this.updateRotationSliders();
            this.syncToNode(false, { skipCapture: true });
        }
    }

    async toggleCharacterSelection(id) {
        if (this._switchingCharacter || this._hydratingCharacterScene) return;
        const selected = new Set(this._selectedCharacterIds || [this.activeCharacterId]);
        if (selected.has(id)) {
            selected.delete(id);
            if (id === this.activeCharacterId && selected.size) await this.selectCharacter(selected.values().next().value, { preserveSelection: true });
        } else {
            selected.add(id);
            if (selected.size === 1 && id !== this.activeCharacterId) await this.selectCharacter(id, { preserveSelection: true });
        }
        this._selectedCharacterIds = selected;
        this.renderCharactersUI();
    }

    async selectCharacter(id, { sync = true, rebuildScene = true, preserveSelection = false } = {}) {
        const target = this.characters.find(character => character.id === id);
        if (target && !preserveSelection) {
            this._selectedCharacterIds = new Set([id]);
            this.renderCharactersUI();
        }
        const previous = this.activeCharacterId ? this.getActiveCharacter() : null;
        if (!target || target.id === this.activeCharacterId || this._switchingCharacter) return false;
        this._finishPoseGesture?.();
        if (rebuildScene) this._libraryLoadToken = (this._libraryLoadToken || 0) + 1;
        const token = ++this._characterSwitchToken;
        const restoreToken = this._poseDataRestoreToken;
        const isCurrent = () => !this._disposed && token === this._characterSwitchToken
            && restoreToken === this._poseDataRestoreToken && this.characters.includes(target);
        this._switchingCharacter = true;
        this.setCharactersBusy(true);
        try {
            if (this._modelLoadPromise) await this._modelLoadPromise;
            if (!isCurrent()) return false;
            await this.waitForMorphIdle();
            if (!isCurrent()) return false;
            if (previous) this.captureActiveCharacterRuntime();
            if (previous && this.viewer?.isInitialized?.()) {
                this.viewer.upsertPassiveCharacterFromActive(previous.id, {
                    pose: this.characterPoseForScene(previous),
                    color: previous.color,
                    transform: this.characterTransformForScene(previous),
                });
            }

            this.ensureCharacterRuntime(target);
            this.activeCharacterId = target.id;
            this.meshParams = target.mesh;
            this.updateGenderUI();
            this.poses = target.poses;
            target.transform = this.characterTransformForScene(target, { poseIndex: this.activeTab });
            this.exportParams.cam_offset_x = target.transform.x;
            this.exportParams.cam_offset_y = target.transform.y;
            this.exportParams.cam_zoom = target.transform.zoom;
            const targetCamera = this.cameraParamsForPose(target.poses[this.activeTab], target);
            this.exportParams.cam_yaw_deg = targetCamera.yaw_deg;
            this.exportParams.cam_pitch_deg = targetCamera.pitch_deg;
            this.exportParams.cam_roll_deg = targetCamera.roll_deg || 0;
            this.viewer?.removePassiveCharacter?.(target.id);

            const meshChanged = !previous || JSON.stringify(previous.mesh || {}) !== JSON.stringify(target.mesh || {});
            if (meshChanged && (!this.viewer?.isInitialized?.() || previous)) {
                if (this._viewerInitPromise) await this._viewerInitPromise;
                if (!isCurrent()) return false;
                await this.loadModel(false, false, { updateScene: rebuildScene });
            }
            if (!isCurrent()) return false;

            const pose = this.characterPoseForScene(target);
            this.viewer?.setPose?.(pose, true);
            if (this.viewer) {
                this.viewer.history = [];
                this.viewer.future = [];
            }
            this.viewer?.setActiveCharacterAppearance?.({
                color: target.color,
                transform: target.transform,
            });
            this.syncCharacterEditorControls();
            if (rebuildScene) this.updateCharacterScene();
            this.renderCharactersUI();
            if (sync) this.syncToNode(false, { skipCapture: true });
            return true;
        } finally {
            this._switchingCharacter = false;
            if (!this._disposed) {
                this.setCharactersBusy(false);
                this.renderCharactersUI();
            }
        }
    }

    hydrateCharacterSceneModels({ showOverlay = true, recenterViewport = true, cameraTarget = null } = {}) {
        const restoreToken = this._poseDataRestoreToken;
        if (this._sceneModelHydrationPromise) {
            if (this._sceneModelHydrationToken === restoreToken) return this._sceneModelHydrationPromise;
            return this._sceneModelHydrationPromise.catch(() => false).then(() => {
                if (this._disposed || restoreToken !== this._poseDataRestoreToken) return false;
                return this.hydrateCharacterSceneModels({ showOverlay, recenterViewport, cameraTarget });
            });
        }
        this._sceneModelHydrationToken = restoreToken;
        const preferredActiveId = this.activeCharacterId;
        const run = async () => {
            this._hydratingCharacterScene = true;
            this.setCharactersBusy(true);
            if (showOverlay && this.loadingOverlay) this.loadingOverlay.style.display = "flex";
            try {
                if (this._viewerInitPromise) await this._viewerInitPromise;
                if (this._disposed || restoreToken !== this._poseDataRestoreToken) return false;
                this.viewer?.clearPassiveCharacters?.();
                this.viewer?.resetSceneCameraTarget?.(cameraTarget);
                await this.loadModel(false, false, { updateScene: false });
                if (this._disposed || restoreToken !== this._poseDataRestoreToken) return false;
                await this.viewer?.waitForCaptureReady?.();
                if (this._disposed || restoreToken !== this._poseDataRestoreToken) return false;
                for (const character of [...this.characters]) {
                    if (character.id === preferredActiveId) continue;
                    await this.selectCharacter(character.id, { sync: false, rebuildScene: false });
                    if (this._disposed || restoreToken !== this._poseDataRestoreToken) return false;
                }
                if (this.activeCharacterId !== preferredActiveId) {
                    await this.selectCharacter(preferredActiveId, { sync: false, rebuildScene: false });
                    if (this._disposed || restoreToken !== this._poseDataRestoreToken) return false;
                }
                this.updateCharacterScene();
                if (recenterViewport) {
                    this.applyCameraToViewer(true);
                    this.resetToMainView();
                }
                await this.viewer?.waitForCaptureReady?.();
                return true;
            } finally {
                this._hydratingCharacterScene = false;
                this.setCharactersBusy(false);
                if (this.loadingOverlay) this.loadingOverlay.style.display = "none";
                this.renderCharactersUI();
            }
        };
        const promise = run().finally(() => {
            if (this._sceneModelHydrationPromise === promise) {
                this._sceneModelHydrationPromise = null;
            }
        });
        this._sceneModelHydrationPromise = promise;
        return promise;
    }

    setCharactersBusy(busy) {
        if (!this.charactersContent) return;
        const effectiveBusy = !!busy || this._hydratingCharacterScene;
        this.charactersContent.classList.toggle("vnccs-ps-characters-busy", effectiveBusy);
        this.charactersContent.setAttribute("aria-busy", String(effectiveBusy));
        this.charactersContent.inert = effectiveBusy;
    }

    scheduleCharacterSync({ immediate = false } = {}) {
        clearTimeout(this._characterSyncTimer);
        this._characterSyncTimer = null;
        const commit = () => {
            this._characterSyncTimer = null;
            this.syncToNode(false, { skipCapture: true });
        };
        if (immediate) commit();
        else this._characterSyncTimer = setTimeout(commit, 180);
    }

    toggleCharacterTemporaryVisibility(id) {
        if (this._switchingCharacter || this._hydratingCharacterScene) return;
        if (!this.characters.some(character => character.id === id)) return;
        this._libraryLoadToken = (this._libraryLoadToken || 0) + 1;
        if (this._temporarilyHiddenCharacters.has(id)) this._temporarilyHiddenCharacters.delete(id);
        else this._temporarilyHiddenCharacters.add(id);
        this.poseCaptures = [];
        this._executionCaptureSnapshot = null;
        this._lastCaptureUploadSnapshot = null;
        this.updateCharacterScene();
        this.renderCharactersUI();
        this.syncToNode(false, { skipCapture: true, skipCaptureUpload: true });
    }

    renderCharactersUI() {
        const selected = this._selectedCharacterIds || new Set([this.activeCharacterId]);
        const selectedCount = this.characters.filter(character => selected.has(character.id) && !this._temporarilyHiddenCharacters.has(character.id)).length;
        this.viewer?.setMultiCharacterSelection?.(selectedCount > 1, selectedCount > 0);
        if (this.resetActivePoseBtn) {
            this.resetActivePoseBtn.disabled = !this.getActiveCharacter() || this._hydratingCharacterScene || this._switchingCharacter;
        }
        if (this.resetCharacterPoseTransformBtn) {
            this.resetCharacterPoseTransformBtn.disabled = !this.getActiveCharacter() || this._hydratingCharacterScene || this._switchingCharacter;
        }
        const content = this.charactersContent;
        if (!content) return;
        const active = this.getActiveCharacter();
        if (this.charactersSectionTitle) {
            this.charactersSectionTitle.textContent = `多角色设置 · ${this.characters.length}/${MAX_POSE_STUDIO_CHARACTERS}`;
        }
        content.innerHTML = "";

        const slots = document.createElement("div");
        slots.className = "vnccs-ps-character-slots";
        const charactersBySlot = new Map(this.characters.map(character => [character.slot, character]));
        for (let index = 0; index < MAX_POSE_STUDIO_CHARACTERS; index += 1) {
            const character = charactersBySlot.get(index);
            const button = document.createElement("button");
            button.type = "button";
            button.className = "vnccs-ps-character-slot";
            if (character) {
                const isActive = character.id === active?.id;
                const slotLabel = `Character ${index + 1}`;
                const isSelected = (this._selectedCharacterIds || new Set([this.activeCharacterId])).has(character.id);
                button.classList.toggle("active", isSelected);
                button.title = isActive ? `${slotLabel} selected` : `Select ${slotLabel}`;
                if (this._temporarilyHiddenCharacters.has(character.id)) {
                    button.style.opacity = "0.45";
                    button.style.borderStyle = "dashed";
                    button.title += "（已临时隐藏）";
                }
                button.setAttribute("aria-label", button.title);
                button.setAttribute("aria-pressed", String(isSelected));
                button.title += " · Ctrl+点击多选";
                const dot = document.createElement("span");
                dot.className = "vnccs-ps-character-dot";
                dot.style.background = normalizeCharacterColor(character.color);
                dot.style.color = normalizeCharacterColor(character.color);
                const number = document.createElement("span");
                number.textContent = String(index + 1);
                button.append(dot, number);
                button.addEventListener("click", event => {
                    if (event.ctrlKey) this.toggleCharacterSelection(character.id);
                    else this.selectCharacter(character.id);
                });
            } else {
                button.classList.add("empty");
                button.textContent = "+";
                button.title = `Add Character ${index + 1}`;
                button.setAttribute("aria-label", button.title);
                button.disabled = this.characters.length >= MAX_POSE_STUDIO_CHARACTERS;
                button.addEventListener("click", () => this.addCharacter(index));
            }
            slots.appendChild(button);
        }
        content.appendChild(slots);
        if (!active) return;

        const toolbar = document.createElement("div");
        toolbar.className = "vnccs-ps-character-toolbar";
        const colorField = document.createElement("label");
        colorField.className = "vnccs-ps-character-color-control";
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "vnccs-ps-character-color-input";
        colorInput.value = normalizeCharacterColor(active.color);
        colorInput.title = `Character ${active.slot + 1} model color`;
        colorInput.setAttribute("aria-label", colorInput.title);
        const colorLabel = document.createElement("span");
        colorLabel.className = "vnccs-ps-character-color-label";
        colorLabel.textContent = "Model color";
        colorInput.addEventListener("input", () => {
            active.color = normalizeCharacterColor(colorInput.value);
            this.viewer?.setActiveCharacterAppearance?.({ color: active.color, transform: active.transform });
            const activeDot = slots.querySelector(".vnccs-ps-character-slot.active .vnccs-ps-character-dot");
            if (activeDot) {
                activeDot.style.background = active.color;
                activeDot.style.color = active.color;
            }
            this.scheduleCharacterSync();
        });
        colorInput.addEventListener("change", () => {
            this.scheduleCharacterSync({ immediate: true });
        });
        colorField.append(colorInput, colorLabel);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "vnccs-ps-character-remove";
        remove.textContent = "Remove";
        remove.title = `Remove Character ${active.slot + 1}`;
        remove.setAttribute("aria-label", remove.title);
        remove.addEventListener("click", () => {
            this.deleteCharacter(active.id).catch(error => console.error("Failed to remove pose character:", error));
        });
        toolbar.append(colorField, remove);
        if (this.characters.length > 1 || this._temporarilyHiddenCharacters.has(active.id)) {
            const visibility = document.createElement("button");
            visibility.type = "button";
            visibility.className = "vnccs-ps-btn";
            visibility.style.gridColumn = "1 / -1";
            const hidden = this._temporarilyHiddenCharacters.has(active.id);
            visibility.textContent = hidden ? "显示当前角色" : "临时隐藏当前角色";
            visibility.title = "隐藏角色不参与画布显示和输出；姿势数据保留，重新打开工作流后恢复显示";
            visibility.setAttribute("aria-pressed", String(hidden));
            visibility.addEventListener("click", () => this.toggleCharacterTemporaryVisibility(active.id));
            toolbar.appendChild(visibility);
        }
        content.appendChild(toolbar);
    }

    persistActivePoseCameraParams() {
        const character = this.getActiveCharacter();
        if (!character) return;
        const previousTransform = { ...character.transform };
        const nextTransform = normalizeCharacterTransform({
            ...character.transform,
            x: this.exportParams.cam_offset_x,
            y: this.exportParams.cam_offset_y,
            zoom: this.exportParams.cam_zoom,
        });
        this.exportParams.cam_offset_x = nextTransform.x;
        this.exportParams.cam_offset_y = nextTransform.y;
        this.exportParams.cam_zoom = nextTransform.zoom;
        const cameraParams = this.currentCameraParams();
        character.transform = nextTransform;
        {
            const pose = this.poses?.[this.activeTab] || {};
            pose.cameraParams = { ...cameraParams };
            this.poses[this.activeTab] = pose;
            character.poses = this.poses;

            // Camera angles describe the shared scene view. Keep them identical
            // for every character on this pose tab while leaving each
            // character's own position and zoom untouched.
            for (const sceneCharacter of this.characters || []) {
                if (sceneCharacter.id === character.id) continue;
                this.ensureCharacterRuntime(sceneCharacter);
                const scenePose = sceneCharacter.poses[this.activeTab] || {};
                const existing = this.cameraParamsForPose(scenePose, sceneCharacter);
                scenePose.cameraParams = {
                    ...existing,
                    yaw_deg: cameraParams.yaw_deg,
                    pitch_deg: cameraParams.pitch_deg,
                    roll_deg: cameraParams.roll_deg || 0,
                };
                sceneCharacter.poses[this.activeTab] = scenePose;
            }
        }

        this.viewer?.setActiveCharacterAppearance?.({
            color: character.color,
            transform: nextTransform,
        });
        this.viewer?.setCameraParams?.(cameraParams);
        this.syncCameraWidgets();
    }

    currentCameraParams() {
        return {
            offset_x: this.exportParams.cam_offset_x,
            offset_y: this.exportParams.cam_offset_y,
            zoom: this.exportParams.cam_zoom,
            yaw_deg: this.exportParams.cam_yaw_deg || 0,
            roll_deg: this.exportParams.cam_roll_deg || 0,
            pitch_deg: this.exportParams.cam_pitch_deg || 0
        };
    }

    cameraParamsForPose(
        pose = this.poses?.[this.activeTab],
        character = this.getActiveCharacter(),
    ) {
        const transform = normalizeCharacterTransform(character?.transform || {});
        return resolveCaptureCameraParams(pose?.cameraParams, {
            offset_x: transform.x,
            offset_y: transform.y,
            zoom: transform.zoom,
            yaw_deg: this.exportParams.cam_yaw_deg || 0,
            roll_deg: this.exportParams.cam_roll_deg || 0,
            pitch_deg: this.exportParams.cam_pitch_deg || 0,
        });
    }

    ensurePoseCameraParams() {
        const active = this.getActiveCharacter();
        const orderedCharacters = [
            ...(active ? [active] : []),
            ...(this.characters || []).filter(character => character !== active),
        ];
        for (const character of orderedCharacters) {
            this.ensureCharacterRuntime(character);
            for (let index = 0; index < character.poses.length; index += 1) {
                const pose = character.poses[index] || {};
                if (!pose.cameraParams || typeof pose.cameraParams !== "object") {
                    const params = this.cameraParamsForPose(pose, character);
                    if (active && character !== active) {
                        const activeCamera = this.cameraParamsForPose(
                            active.poses[index] || active.poses[0] || {},
                            active,
                        );
                        params.yaw_deg = activeCamera.yaw_deg;
                        params.pitch_deg = activeCamera.pitch_deg;
                    }
                    pose.cameraParams = params;
                    character.poses[index] = pose;
                }
            }
        }
    }

    restoreActivePoseCameraParams({ updateViewer = true } = {}) {
        const character = this.getActiveCharacter();
        if (!character) return this.currentCameraParams();
        const params = this.cameraParamsForPose(
            this.poses?.[this.activeTab],
            character,
        );
        this.exportParams.cam_offset_x = params.offset_x;
        this.exportParams.cam_offset_y = params.offset_y;
        this.exportParams.cam_zoom = params.zoom;
        this.exportParams.cam_yaw_deg = params.yaw_deg;
        this.exportParams.cam_pitch_deg = params.pitch_deg;
        this.exportParams.cam_roll_deg = params.roll_deg || 0;
        character.transform = normalizeCharacterTransform({
            ...character.transform,
            x: params.offset_x,
            y: params.offset_y,
            zoom: params.zoom,
        });
        this.syncCameraWidgets();
        if (updateViewer) {
            this.viewer?.setActiveCharacterAppearance?.({
                color: character.color,
                transform: character.transform,
            });
            this.applyCameraToViewer(true);
            this.viewer?.setCameraParams?.(params);
        }
        return params;
    }









    setPoseCapture(index, capture, requireCapture = false) {
        if (typeof capture !== "string" || !capture) {
            if (requireCapture) throw new Error(`Pose capture failed for frame ${index + 1}.`);
            return false;
        }
        if (!this.poseCaptures) this.poseCaptures = [];
        this.poseCaptures[index] = capture;
        return true;
    }

    invalidatePoseCapturesForOutputSizeChange() {
        if (Array.isArray(this.poseCaptures)) this.poseCaptures.fill(null);
        this._lastCaptureUploadSnapshot = null;
        this._executionCaptureSnapshot = null;
    }












    applyCameraToViewer(snap = true) {
        if (!this.viewer) return;
        const args = [
            this.exportParams.view_width,
            this.exportParams.view_height,
            // Position and zoom now belong to each character mesh. The scene
            // camera is shared and therefore always uses a neutral framing.
            1.0,
            0,
            0,
            this.exportParams.cam_yaw_deg || 0,
            this.exportParams.cam_pitch_deg || 0,
            this.exportParams.cam_roll_deg || 0
        ];
        if (snap && this.viewer.snapToCaptureCamera) this.viewer.snapToCaptureCamera(...args);
        else if (this.viewer.updateCaptureCamera) this.viewer.updateCaptureCamera(...args);
    }

    resetToMainView() {
        if (!this.viewer?.isInitialized?.()) return false;
        this.applyCameraToViewer(true);
        const canvasRect = this.canvasContainer?.getBoundingClientRect?.();
        const toolbarRect = this.actionToolbar?.getBoundingClientRect?.();
        const topInset = canvasRect?.height && toolbarRect
            ? Math.max(0.12, Math.min(0.34, (toolbarRect.bottom - canvasRect.top + 14) / canvasRect.height))
            : 0.18;
        // The viewer fills the center column between the sidebars, so its
        // camera aspect already reflects the actual remaining canvas width.
        return this.viewer.fitCaptureFrameInViewport?.({
            margin: 0.96,
            insets: { left: 0.025, right: 0.025, top: topInset, bottom: 0.035 },
        }) ?? false;
    }

    syncCameraWidgets() {
        for (const key of ['cam_zoom', 'cam_offset_x', 'cam_offset_y', 'cam_yaw_deg', 'cam_pitch_deg']) {
            const widget = this.exportWidgets[key];
            if (widget) {
                if (!(widget.type === "number" && document.activeElement === widget)) widget.value = this.exportParams[key];
                if (widget._vnccsValueSpan) {
                    widget._vnccsValueSpan.innerText = Number(this.exportParams[key] || 0).toFixed(2);
                }
            }
        }
    }

    clearSAMCameraMode() {
        this.viewer?.clearSAMProjectionCameraFrame?.();
        this._samCameraModeActive = false;
        this._samCamBannerVisible = false;
        this._samCamDisplayActive = true;
        this._samCamPreParams = null;
        this._samCamStoredParams = null;
        this._samCamStoredProjectionFrame = null;
        this._updateSAMCameraBanner();
    }

    _updateSAMCameraBanner() {
        if (!this._samCamBanner) return;
        const show = this._samCamBannerVisible;
        if (!show) {
            this._samCamBanner.classList.remove('vnccs-sam-visible', 'vnccs-sam-paused');
            return;
        }
        this._samCamBanner.classList.add('vnccs-sam-visible');
        const label = this._samCamBanner.querySelector('.vnccs-sam-label');
        if (this._samCamDisplayActive) {
            this._samCamBanner.classList.remove('vnccs-sam-paused');
            if (label) label.textContent = 'SAM Camera Applied';
        } else {
            this._samCamBanner.classList.add('vnccs-sam-paused');
            if (label) label.textContent = 'SAM Camera (paused)';
        }
    }

    _toggleSAMCameraDisplay() {
        if (!this._samCamBannerVisible) return;
        this._samCamDisplayActive = !this._samCamDisplayActive;
        if (this._samCamDisplayActive) {
            this.viewer?.setSAMProjectionCameraFrame?.(this._samCamStoredProjectionFrame || null);
            this._samCameraModeActive = !!this._samCamStoredProjectionFrame;
            if (this._samCamStoredParams) {
                Object.assign(this.exportParams, this._samCamStoredParams);
                this.persistActivePoseCameraParams();
                this.syncCameraWidgets();
                this.applyCameraToViewer(true);
                this.viewer?.setCameraParams(this.currentCameraParams());
            }
        } else {
            this.viewer?.setSAMProjectionCameraFrame?.(null);
            this._samCameraModeActive = false;
            if (this._samCamPreParams) {
                Object.assign(this.exportParams, this._samCamPreParams);
                this.persistActivePoseCameraParams();
                this.syncCameraWidgets();
                this.applyCameraToViewer(true);
                this.viewer?.setCameraParams(this.currentCameraParams());
            }
        }
        this._updateSAMCameraBanner();
    }

    resetCameraParams({ keepAngles = false } = {}) {
        this.exportParams.cam_zoom = 1.0;
        this.exportParams.cam_offset_x = 0;
        this.exportParams.cam_offset_y = 0;
        if (!keepAngles) {
            this.exportParams.cam_yaw_deg = 0;
            this.exportParams.cam_pitch_deg = 0;
            this.exportParams.cam_roll_deg = 0;
        }
        this.persistActivePoseCameraParams();
        this.syncCameraWidgets();
    }

    updateCaptureCameraPreview() {
        this.applyCameraToViewer(false);
    }

    applyAgeCameraFit() {
        if (!this.viewer?.computeModelFitFraming) return false;
        if (!this.viewer?.isInitialized?.()) return false;

        const activeCharacter = this.getActiveCharacter();
        if (activeCharacter) {
            // Age changes alter the mesh proportions, but must not reframe the
            // character or overwrite its manually adjusted placement.
            this.renderCharactersUI();
            return true;
        }

        const originalTab = this.activeTab;
        let changed = false;

        for (let i = 0; i < this.poses.length; i++) {
            const pose = this.poses[i] || {};
            const camera = pose.cameraParams || {};

            this.viewer.setPose(pose, true);
            const zoom = this.viewer.computeModelFitZoom(
                this.exportParams.view_width || 1024,
                this.exportParams.view_height || 1024,
                camera.offset_x ?? this.exportParams.cam_offset_x ?? 0,
                camera.offset_y ?? this.exportParams.cam_offset_y ?? 0,
                camera.yaw_deg ?? this.exportParams.cam_yaw_deg ?? 0,
                camera.pitch_deg ?? this.exportParams.cam_pitch_deg ?? 0,
                0.08
            );
            if (!Number.isFinite(zoom)) continue;

            this.poses[i] = {
                ...pose,
                cameraParams: {
                    offset_x: camera.offset_x ?? this.exportParams.cam_offset_x ?? 0,
                    offset_y: camera.offset_y ?? this.exportParams.cam_offset_y ?? 0,
                    yaw_deg: camera.yaw_deg ?? this.exportParams.cam_yaw_deg ?? 0,
                    pitch_deg: camera.pitch_deg ?? this.exportParams.cam_pitch_deg ?? 0,
                    zoom: Math.max(0.1, Math.min(7.0, zoom))
                }
            };
            changed = true;
        }

        this.activeTab = originalTab;
        this.viewer.setPose(this.poses[this.activeTab] || {}, true);
        const activeCamera = this.poses[this.activeTab]?.cameraParams;
        if (activeCamera) {
            this.exportParams.cam_zoom = activeCamera.zoom ?? this.exportParams.cam_zoom;
            this.exportParams.cam_offset_x = activeCamera.offset_x ?? this.exportParams.cam_offset_x;
            this.exportParams.cam_offset_y = activeCamera.offset_y ?? this.exportParams.cam_offset_y;
            this.exportParams.cam_yaw_deg = activeCamera.yaw_deg ?? this.exportParams.cam_yaw_deg;
            this.exportParams.cam_pitch_deg = activeCamera.pitch_deg ?? this.exportParams.cam_pitch_deg;
        }
        this.syncCameraWidgets();
        this.applyCameraToViewer(true);
        this.updateRotationSliders();
        return changed;
    }

    trackPoseGesture(control, { recordPose = false } = {}) {
        let active = false;
        let pointer = false;
        let key = false;
        const begin = () => {
            if (active) return;
            this._finishPoseGesture?.();
            this._libraryLoadToken = (this._libraryLoadToken || 0) + 1;
            if (this.pendingAgeCameraFit) {
                this.pendingAgeCameraFit = false;
            }
            active = true;
            this._poseGestureActive = true;
            this._finishPoseGesture = finish;
            if (recordPose) this.viewer?.recordState?.();
        };
        const finish = () => {
            if (!active) return;
            active = pointer = key = false;
            this._poseGestureActive = false;
            this._finishPoseGesture = null;
            this.syncToNode(false);
        };
        control.addEventListener("pointerdown", event => {
            if (event.button !== 0) return;
            begin(); pointer = true;
        });
        control.addEventListener("keydown", event => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
                begin(); key = true;
            }
        });
        control.addEventListener("input", begin);
        control.addEventListener("change", () => { if (!pointer && !key) finish(); });
        control.addEventListener("pointerup", finish);
        control.addEventListener("pointercancel", finish);
        control.addEventListener("lostpointercapture", finish);
        control.addEventListener("keyup", () => { if (key) finish(); });
        control.addEventListener("blur", finish);
    }

    createSliderField(label, key, min, max, step, defaultValue, target, isExport = false, mirrorKey = null) {
        const field = document.createElement("div");
        field.className = "vnccs-ps-field";

        const labelRow = document.createElement("div");
        labelRow.className = "vnccs-ps-label-row";
        labelRow.style.display = "flex";
        labelRow.style.justifyContent = "space-between";
        labelRow.style.alignItems = "center";

        const value = target[key];
        const displayVal = key === 'age' ? Math.round(value) : value.toFixed(2);
        const valueRow = document.createElement("div");
        valueRow.style.display = "flex";
        valueRow.style.alignItems = "center";
        valueRow.style.gap = "6px";

        const valueSpan = document.createElement("span");
        valueSpan.className = "vnccs-ps-value";
        valueSpan.innerText = displayVal;

        const resetBtn = document.createElement("button");
        resetBtn.className = "vnccs-ps-reset-btn";
        resetBtn.innerHTML = "↺";
        resetBtn.title = `Reset to ${defaultValue}`;

        valueRow.appendChild(valueSpan);
        valueRow.appendChild(resetBtn);

        // Label Side
        const labelEl = document.createElement("span");
        labelEl.className = "vnccs-ps-label";
        labelEl.innerText = label;

        labelRow.innerHTML = '';
        labelRow.appendChild(labelEl);
        labelRow.appendChild(valueRow);

        const wrap = document.createElement("div");
        wrap.className = "vnccs-ps-slider-wrap";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.className = "vnccs-ps-slider";
        slider.min = min;
        slider.max = max;
        slider.step = step;
        slider.value = value;
        slider._vnccsValueSpan = valueSpan;
        this.trackPoseGesture(slider, { recordPose: true });
        const isLiveMorphSlider = !isExport && this.isLiveMorphKey?.(key);

        // Reset logic
        resetBtn.onclick = (e) => {
            e.stopPropagation();
            slider.value = defaultValue;
            slider.dispatchEvent(new Event('input'));
            slider.dispatchEvent(new Event('change'));
        };

        slider.addEventListener("input", () => {
            const val = parseFloat(slider.value);
            valueSpan.innerText = key === 'age' ? Math.round(val) : val.toFixed(2);

            if (isExport) {
                this.exportParams[key] = val;
                // Live preview for camera params - sync viewport too
                const isCamParam = ['cam_zoom', 'cam_offset_x', 'cam_offset_y', 'cam_yaw_deg', 'cam_pitch_deg'].includes(key);
                if (isCamParam) {
                    this.pendingAgeCameraFit = false;
                    this.persistActivePoseCameraParams();
                }
                if (isCamParam && this.viewer) {
                    this.applyCameraToViewer(true);
                }
                this.syncToNode(false, { skipCapture: true });
            } else {
                if (key === 'head_size') {
                    if (this.viewer) this.viewer.updateHeadScale(val);
                    this.meshParams[key] = val;
                    this.syncToNode(false);
                } else if (key === 'arm_size') {
                    if (this.viewer) this.viewer.updateArmScale(val);
                    this.meshParams[key] = val;
                    this.syncToNode(false);
                } else if (key === 'hand_size') {
                    if (this.viewer) this.viewer.updateHandScale(val);
                    this.meshParams[key] = val;
                    this.syncToNode(false);
                } else if (key === 'foot_size') {
                    if (this.viewer) this.viewer.updateFootScale(val);
                    this.meshParams[key] = val;
                    this.syncToNode(false);
                } else if (key.endsWith('_length')) {
                    const group = key.replace('_length', '');
                    if (this.viewer) this.viewer.updateBoneLengthScale(group, val);
                    this.meshParams[key] = val;
                    if (mirrorKey) {
                        this.meshParams[mirrorKey] = val;
                        this.viewer?.updateBoneLengthScale(mirrorKey.replace('_length', ''), val);
                    }
                    this.syncToNode(false);
                } else {
                    // Directly update meshParams and trigger mesh rebuild
                    this.meshParams[key] = val;
                    this.onMeshParamsChanged(key, isLiveMorphSlider ? { liveOnly: true } : {});
                }
            }
        });

        slider.addEventListener("change", () => {
            if (isExport) {
                const needsFull = ['view_width', 'view_height', 'cam_zoom', 'cam_offset_x', 'cam_offset_y', 'cam_yaw_deg', 'cam_pitch_deg'].includes(key);
                this.syncToNode(needsFull);
            } else if (isLiveMorphSlider) {
                this.onMeshParamsChanged(key, { finalize: true });
            }
        });

        if (!isExport) {
            this.sliders[key] = { slider, label: valueSpan, def: { key, label, min, max, step } };
        } else {
            this.exportWidgets[key] = slider;
        }

        wrap.appendChild(slider);
        field.appendChild(labelRow);
        field.appendChild(wrap);
        return field;
    }

    createInputField(label, key, type, min, max, step) {
        const field = document.createElement("div");
        field.className = "vnccs-ps-field";

        const labelEl = document.createElement("div");
        labelEl.className = "vnccs-ps-label";
        labelEl.innerText = label;

        const input = document.createElement("input");
        input.type = type;
        input.className = "vnccs-ps-input";
        input.min = min;
        input.max = max;
        input.step = step;
        input.value = this.exportParams[key];

        const isDimension = (key === 'view_width' || key === 'view_height');
        if (!isDimension) this.trackPoseGesture(input, { recordPose: true });
        input.addEventListener("input", () => {
            if (input.value === "" || !Number.isFinite(Number(input.value))) return;
            let val = Number(input.value);
            val = Math.max(min, Math.min(max, val));

            // Pixel dimensions are integers.
            if (isDimension) val = Math.round(val);

            this.exportParams[key] = val;
            if (isDimension) {
                this._outputSizeUserSet = true;
                this.invalidatePoseCapturesForOutputSizeChange();
                this._lastResizeW = 0;
                this._lastResizeH = 0;
                this.resize();
                this.updateCaptureCameraPreview();
            }
            this.syncToNode(isDimension);
        });
        input.addEventListener("change", () => { input.value = this.exportParams[key]; });

        this.exportWidgets[key] = input;

        field.appendChild(labelEl);
        field.appendChild(input);
        return field;
    }

    resetHandSliders() {
        if (!this._handSliderValues) return;

        const defaults = this._handSliderDefaults || { spread: 0, grasp: 0, thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 };
        for (const [key, value] of Object.entries(defaults)) {
            this._handSliderValues[key] = value;
            if (this._handSliderRefs[key]) this._handSliderRefs[key].value = String(value);
            if (this._handSliderValRefs[key]) this._handSliderValRefs[key].textContent = value.toFixed(2);
        }
    }

    _getPresetDataForSide(preset, side) {
        return side === "r" ? preset?.preset_r : preset?.preset_l;
    }

    _lerpHandPresetData(poseA, poseB, t, side) {
        const dataA = this._getPresetDataForSide(poseA, side);
        const dataB = this._getPresetDataForSide(poseB, side);
        const result = {};
        if (!dataA || !dataB) return result;

        for (const key of Object.keys(dataA)) {
            const a = dataA[key];
            const b = dataB[key];
            if (!a || !b) continue;
            const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
            const bFlip = dot < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
            const r = [
                a[0] * (1 - t) + bFlip[0] * t,
                a[1] * (1 - t) + bFlip[1] * t,
                a[2] * (1 - t) + bFlip[2] * t,
                a[3] * (1 - t) + bFlip[3] * t,
            ];
            const len = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
            result[key] = [r[0] / len, r[1] / len, r[2] / len, r[3] / len];
        }

        return result;
    }

    _sampleCurrentHandPose(side) {
        if (!this.viewer?.bones || !this.viewer?.THREE) return null;
        const result = {};
        for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
            for (const segment of ["01", "02", "03"]) {
                const bone = this.viewer.bones[`${prefix}_${segment}_${side}`];
                if (!bone) continue;
                result[`${prefix}_${segment}`] = [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w];
            }
        }
        return result;
    }

    _quatAngularDistance(a, b) {
        const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
        const clamped = Math.max(-1, Math.min(1, dot));
        return 2 * Math.acos(clamped);
    }

    _estimateHandInterpolationValue(currentData, startData, endData, keys) {
        let bestT = 0;
        let bestScore = Number.POSITIVE_INFINITY;

        for (let step = 0; step <= 100; step++) {
            const t = step / 100;
            const sampled = this._lerpHandPresetData({ preset_l: startData, preset_r: startData }, { preset_l: endData, preset_r: endData }, t, "l");
            let score = 0;
            for (const key of keys) {
                const current = currentData[key];
                const target = sampled[key];
                if (!current || !target) continue;
                score += this._quatAngularDistance(current, target);
            }
            if (score < bestScore) {
                bestScore = score;
                bestT = t;
            }
        }

        return bestT;
    }

    calibrateHandSliderDefaults(side) {
        if (!this.viewer || !this._defaultHandPresets || !side) return;
        const { OPEN, CHOP, FIST } = this._defaultHandPresets;
        if (!OPEN || !CHOP || !FIST) return;

        const currentData = this._sampleCurrentHandPose(side);
        if (!currentData) return;

        const allKeys = Object.keys(currentData);
        const spread = this._estimateHandInterpolationValue(
            currentData,
            this._getPresetDataForSide(CHOP, side),
            this._getPresetDataForSide(OPEN, side),
            allKeys,
        );

        const spreadBaseData = this._lerpHandPresetData(CHOP, OPEN, spread, side);
        const fistData = this._getPresetDataForSide(FIST, side);
        const perFinger = {};
        for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
            const keys = ["01", "02", "03"].map((segment) => `${prefix}_${segment}`);
            perFinger[prefix] = this._estimateHandInterpolationValue(currentData, spreadBaseData, fistData, keys);
        }

        const grasp = (perFinger.thumb + perFinger.index + perFinger.middle + perFinger.ring + perFinger.pinky) / 5;
        this._handSliderDefaults = {
            spread,
            grasp,
            thumb: perFinger.thumb,
            index: perFinger.index,
            middle: perFinger.middle,
            ring: perFinger.ring,
            pinky: perFinger.pinky,
        };

        this.resetHandSliders();
    }

    _createHandPopover() {
        const panel = document.createElement("div");
        panel.className = "vnccs-ps-hand-popover";

        const header = document.createElement("div");
        header.className = "vnccs-ps-hand-popover-header";

        const title = document.createElement("div");
        title.className = "vnccs-ps-hand-popover-title";
        title.textContent = "Hand Control";

        const closeBtn = document.createElement("button");
        closeBtn.className = "vnccs-ps-hand-popover-close";
        closeBtn.type = "button";
        closeBtn.textContent = "✕";
        closeBtn.addEventListener("click", () => this.hideHandControlPopover());

        header.append(title, closeBtn);
        panel.appendChild(header);

        const mkSliderRow = (label, onInput) => {
            const row = document.createElement("div");
            row.style.cssText = "display:grid;grid-template-columns:44px 1fr 34px;gap:6px;align-items:center;margin-bottom:6px;";

            const lbl = document.createElement("span");
            lbl.style.cssText = "font-size: 12px;color:var(--ps-text-muted);";
            lbl.textContent = label;

            const slider = document.createElement("input");
            slider.type = "range";
            slider.min = "0";
            slider.max = "1";
            slider.step = "0.01";
            slider.value = "0";
            slider.className = "vnccs-ps-slider";

            const value = document.createElement("span");
            value.style.cssText = "font-size: 12px;color:var(--ps-accent);text-align:right;font-family:var(--ps-font-mono);";
            value.textContent = "0.00";

            this.trackPoseGesture(slider, { recordPose: true });
            slider.addEventListener("input", () => {
                const numericValue = parseFloat(slider.value);
                value.textContent = numericValue.toFixed(2);
                onInput(numericValue);
            });

            row.append(lbl, slider, value);
            return { row, slider, value };
        };

        const mkTrackedHandSlider = (label, key, initialValue) => {
            const { row, slider, value } = mkSliderRow(label, (numericValue) => {
                if (key === "grasp") {
                    const oldGrasp = this._handSliderValues.grasp;
                    this._handSliderValues.grasp = numericValue;
                    const epsilon = 1e-9;
                    for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
                        const current = this._handSliderValues[prefix];
                        let nextValue;
                        if (numericValue >= oldGrasp) {
                            const denom = 1 - oldGrasp;
                            nextValue = denom < epsilon ? 1 : current + (numericValue - oldGrasp) * (1 - current) / denom;
                        } else {
                            nextValue = oldGrasp < epsilon ? 0 : current * (numericValue / oldGrasp);
                        }
                        nextValue = Math.max(0, Math.min(1, nextValue));
                        this._handSliderValues[prefix] = nextValue;
                        if (this._handSliderRefs[prefix]) this._handSliderRefs[prefix].value = String(nextValue);
                        if (this._handSliderValRefs[prefix]) this._handSliderValRefs[prefix].textContent = nextValue.toFixed(2);
                    }
                } else {
                    this._handSliderValues[key] = numericValue;
                }
                this.applyActiveHandSliders();
            });

            slider.value = String(initialValue);
            value.textContent = initialValue.toFixed(2);
            this._handSliderRefs[key] = slider;
            this._handSliderValRefs[key] = value;
            return row;
        };

        panel.appendChild(mkTrackedHandSlider("Spread", "spread", 0));
        panel.appendChild(mkTrackedHandSlider("Grasp", "grasp", 0));
        for (const [label, key] of [["Thumb", "thumb"], ["Index", "index"], ["Middle", "middle"], ["Ring", "ring"], ["Pinky", "pinky"]]) {
            panel.appendChild(mkTrackedHandSlider(label, key, 1));
        }

        const resetBtn = document.createElement("button");
        resetBtn.className = "vnccs-ps-btn";
        resetBtn.style.width = "100%";
        resetBtn.textContent = "Reset Hand Sliders";
        resetBtn.addEventListener("click", () => {
            this.resetHandSliders();
            this._handBiasValues = [1.0, 1.0, 1.0];
            this.applyActiveHandSliders();
        });
        panel.appendChild(resetBtn);

        this._handPopover = panel;
        this._handPopoverTitle = title;
        this._handPopoverHost().appendChild(panel);
        // Embedded hosts can place this popover outside the main editor container.
        this._handPopoverI18nCleanup?.();
        this._handPopoverI18nCleanup = observePoseStudioI18n(panel, app);
        document.addEventListener("pointerdown", this._boundHandleDocumentPointerDown);
        document.addEventListener("pointerup", this._boundHandleDocumentPointerUp);
        document.addEventListener("pointercancel", this._boundHandleDocumentPointerCancel);
    }

    // Where the hand popover lives and what it positions/clamps against. Standalone keeps the
    // centerPanel; an embedded host (UniCanvas pose editor) hides the centerPanel and sets
    // `handPopoverHost` to its visible viewport, so hands stay editable there.
    _handPopoverHost() {
        return this.handPopoverHost || this.centerPanel || this.canvasContainer;
    }

    _handleDocumentPointerDown(event) {
        if (!this._handPopover || !this._handPopover.classList.contains("visible")) return;
        if (event.button !== 0) {
            this._pendingHandPopoverOutsideClick = null;
            return;
        }
        if (this._handPopover.contains(event.target)) {
            this._pendingHandPopoverOutsideClick = null;
            return;
        }

        this._pendingHandPopoverOutsideClick = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            clickedCanvas: this.canvas ? event.target === this.canvas : false,
            activeHandSide: this._activeHandSide,
        };
    }

    _handleDocumentPointerUp(event) {
        this._finishPoseGesture?.();
        const pending = this._pendingHandPopoverOutsideClick;
        this._pendingHandPopoverOutsideClick = null;

        if (!pending || !this._handPopover || !this._handPopover.classList.contains("visible")) return;
        if (event.button !== 0 || event.pointerId !== pending.pointerId) return;
        if (this._handPopover.contains(event.target)) return;

        const movedX = event.clientX - pending.startX;
        const movedY = event.clientY - pending.startY;
        if ((movedX * movedX + movedY * movedY) > 9) return;

        if (pending.clickedCanvas && (this._hoveredHandSide || this._activeHandSide !== pending.activeHandSide)) {
            return;
        }

        this.hideHandControlPopover();
    }

    _handleDocumentPointerCancel() {
        this._finishPoseGesture?.();
        this._pendingHandPopoverOutsideClick = null;
    }

    applyActiveHandSliders() {
        if (!this.viewer || !this._defaultHandPresets || !this._activeHandSide) return;
        const { OPEN, CHOP, FIST } = this._defaultHandPresets;
        if (!OPEN || !CHOP || !FIST) return;

        const side = this._activeHandSide;

        this.viewer.interpolateHandPose(CHOP, OPEN, this._handSliderValues.spread, side);
        for (const prefix of ["thumb", "index", "middle", "ring", "pinky"]) {
            const spreadBaseData = this._lerpHandPresetData(CHOP, OPEN, this._handSliderValues.spread, side);
            const fistData = side === "r" ? FIST.preset_r : FIST.preset_l;
            const startPose = { preset_l: spreadBaseData, preset_r: spreadBaseData };
            const endPose = { preset_l: fistData, preset_r: fistData };
            this.viewer.interpolateFingerPose(startPose, endPose, this._handSliderValues[prefix], side, prefix, this._handBiasValues);
        }

        this.syncToNode(false);
    }

    showHandControlPopover(side) {
        if (!side || !this._handPopover) return;
        this._activeHandSide = side;
        this.calibrateHandSliderDefaults(side);
        if (this._handPopoverTitle) {
            this._handPopoverTitle.textContent = side === "l" ? "Left Hand" : "Right Hand";
        }
        this._handPopover.classList.add("visible");
        this.positionHandControlPopover(side);
        requestAnimationFrame(() => {
            if (this._activeHandSide === side) {
                this.positionHandControlPopover(side, true);
            }
        });
    }

    hideHandControlPopover() {
        if (!this._handPopover) return;
        this._activeHandSide = null;
        this._pendingHandPopoverOutsideClick = null;
        this._handPopover.classList.remove("visible");
    }

    _projectWorldToCenterPanel(worldVector, centerWidth, centerHeight, canvasLeft, canvasTop, canvasWidth, canvasHeight) {
        const projected = worldVector.clone().project(this.viewer.camera);
        return {
            x: canvasLeft + (projected.x * 0.5 + 0.5) * canvasWidth,
            y: canvasTop + (-projected.y * 0.5 + 0.5) * canvasHeight,
        };
    }

    _getHandScreenMetrics(side, centerWidth, centerHeight, canvasLeft, canvasTop, canvasWidth, canvasHeight) {
        const handBone = this.viewer.bones?.[`hand_${side}`];
        const centerBone = this.viewer.bones?.[`middle_01_${side}`] || handBone;
        if (!handBone || !centerBone) return null;

        const points = [];
        const centerPos = new this.viewer.THREE.Vector3();
        centerBone.getWorldPosition(centerPos);
        const centerPoint = this._projectWorldToCenterPanel(centerPos, centerWidth, centerHeight, canvasLeft, canvasTop, canvasWidth, canvasHeight);
        points.push(centerPoint);

        const wristPos = new this.viewer.THREE.Vector3();
        handBone.getWorldPosition(wristPos);
        points.push(this._projectWorldToCenterPanel(wristPos, centerWidth, centerHeight, canvasLeft, canvasTop, canvasWidth, canvasHeight));

        for (const name of ["thumb_03", "index_03", "middle_03", "ring_03", "pinky_03"]) {
            const bone = this.viewer.bones?.[`${name}_${side}`];
            if (!bone) continue;
            const pos = new this.viewer.THREE.Vector3();
            bone.getWorldPosition(pos);
            points.push(this._projectWorldToCenterPanel(pos, centerWidth, centerHeight, canvasLeft, canvasTop, canvasWidth, canvasHeight));
        }

        let radius = 0;
        for (const point of points) {
            const dx = point.x - centerPoint.x;
            const dy = point.y - centerPoint.y;
            radius = Math.max(radius, Math.hypot(dx, dy));
        }

        return {
            x: centerPoint.x,
            y: centerPoint.y,
            radius: Math.max(36, radius + 18),
        };
    }

    positionHandControlPopover(side, useMeasuredBounds = false) {
        const host = this._handPopoverHost();
        if (!this.viewer || !this._handPopover || !this.canvasContainer || !host || !side) return;
        if (!this.viewer.camera || !this.viewer.THREE) return;

        const centerWidth = host.clientWidth;
        const centerHeight = host.clientHeight;
        // Embedded host: the popover and the canvas share the same box, so the projection
        // lands directly in host coordinates.
        const embeddedHost = host === this.canvasContainer;
        const canvasLeft = embeddedHost ? 0 : this.canvasContainer.offsetLeft;
        const canvasTop = embeddedHost ? 0 : this.canvasContainer.offsetTop;
        const canvasWidth = embeddedHost ? centerWidth : this.canvasContainer.clientWidth;
        const canvasHeight = embeddedHost ? centerHeight : this.canvasContainer.clientHeight;

        const measuredRect = useMeasuredBounds ? this._handPopover.getBoundingClientRect() : null;
        const panelWidth = Math.min(centerWidth - 20, measuredRect?.width || this._handPopover.offsetWidth || 240);
        const panelHeight = Math.min(centerHeight - 20, measuredRect?.height || this._handPopover.offsetHeight || 280);
        const minLeft = 10;
        const minTop = 10;
        const maxLeft = centerWidth - panelWidth - 10;
        const maxTop = centerHeight - panelHeight - 10;
        const gap = 18;

        const handMetrics = this._getHandScreenMetrics(side, centerWidth, centerHeight, canvasLeft, canvasTop, canvasWidth, canvasHeight);
        if (!handMetrics) return;

        const candidates = [
            { left: handMetrics.x + handMetrics.radius + gap, top: handMetrics.y - panelHeight * 0.5 },
            { left: handMetrics.x - handMetrics.radius - gap - panelWidth, top: handMetrics.y - panelHeight * 0.5 },
            { left: handMetrics.x - panelWidth * 0.5, top: handMetrics.y - handMetrics.radius - gap - panelHeight },
            { left: handMetrics.x - panelWidth * 0.5, top: handMetrics.y + handMetrics.radius + gap },
        ];

        const preferredOrder = side === "l" ? [0, 1, 2, 3] : [1, 0, 2, 3];
        let chosen = null;

        for (const index of preferredOrder) {
            const candidate = candidates[index];
            const fitsHorizontally = candidate.left >= minLeft && candidate.left <= maxLeft;
            const fitsVertically = candidate.top >= minTop && candidate.top <= maxTop;
            if (fitsHorizontally && fitsVertically) {
                chosen = candidate;
                break;
            }
        }

        if (!chosen) {
            let bestScore = -Infinity;
            for (const candidate of candidates) {
                const clampedLeft = Math.max(minLeft, Math.min(maxLeft, candidate.left));
                const clampedTop = Math.max(minTop, Math.min(maxTop, candidate.top));
                const dx = Math.abs(clampedLeft - candidate.left);
                const dy = Math.abs(clampedTop - candidate.top);
                const overlapPenalty = dx + dy;
                const distanceFromHand = Math.hypot((clampedLeft + panelWidth * 0.5) - handMetrics.x, (clampedTop + panelHeight * 0.5) - handMetrics.y);
                const score = distanceFromHand - overlapPenalty * 4;
                if (score > bestScore) {
                    bestScore = score;
                    chosen = { left: clampedLeft, top: clampedTop };
                }
            }
        }

        const left = Math.max(minLeft, Math.min(maxLeft, chosen.left));
        const top = Math.max(minTop, Math.min(maxTop, chosen.top));

        this._handPopover.style.left = `${left}px`;
        this._handPopover.style.top = `${top}px`;
    }

    updateTabs() {
        const fragment = document.createDocumentFragment();

        // Show/hide Sync Tabs button based on tab count
        if (this.syncTabsBtn) {
            this.syncTabsBtn.style.display = this.poses.length > 1 ? "flex" : "none";
        }

        for (let i = 0; i < this.poses.length; i++) {
            const tab = document.createElement("button");
            tab.className = "vnccs-ps-tab" + (i === this.activeTab ? " active" : "");

            const text = document.createElement("span");
            text.innerText = `Pose ${i + 1}`;
            tab.appendChild(text);

            if (this.poses.length > 1) {
                const close = document.createElement("span");
                close.className = "vnccs-ps-tab-close";
                close.innerText = "×";

                close.onclick = (e) => {
                    e.stopPropagation();
                    this.deleteTab(i);
                };
                tab.appendChild(close);
            }

            tab.addEventListener("click", () => this.switchTab(i));
            fragment.appendChild(tab);
        }

        const addBtn = document.createElement("button");
        addBtn.className = "vnccs-ps-tab-add";
        addBtn.innerText = "+";
        addBtn.addEventListener("click", () => this.addTab());
        fragment.appendChild(addBtn);
        this.tabsContainer.replaceChildren(fragment);

        requestAnimationFrame(() => {
            this.updateTabScrollButtons();
            this.scrollActiveTabIntoView();
        });
    }

    refreshTabActiveState({ scroll = true } = {}) {
        const tabs = Array.from(this.tabsContainer?.querySelectorAll(".vnccs-ps-tab") || []);
        if (tabs.length !== this.poses.length) {
            this.updateTabs();
            return;
        }
        tabs.forEach((tab, index) => tab.classList.toggle("active", index === this.activeTab));
        requestAnimationFrame(() => {
            this.updateTabScrollButtons();
            if (scroll) this.scrollActiveTabIntoView();
        });
    }

    updateTabScrollButtons() {
        if (!this.tabsContainer || !this.tabScrollLeft || !this.tabScrollRight) return;
        const tabsRect = this.tabsContainer.getBoundingClientRect();
        const viewportRight = tabsRect.right;
        const children = Array.from(this.tabsContainer.children);
        const lastChild = children[children.length - 1];
        const lastRight = lastChild?.getBoundingClientRect().right || viewportRight;
        const maxScroll = Math.max(0, lastRight - viewportRight + this.tabsContainer.scrollLeft);
        const overflow = maxScroll > 1;
        const atStart = this.tabsContainer.scrollLeft <= 1;
        const atEnd = this.tabsContainer.scrollLeft >= maxScroll - 1;
        this.tabScrollLeft.classList.toggle("visible", overflow);
        this.tabScrollRight.classList.toggle("visible", overflow);
        this.tabScrollLeft.disabled = !overflow || atStart;
        this.tabScrollRight.disabled = !overflow || atEnd;
    }

    scrollTabs(direction) {
        if (!this.tabsContainer) return;
        const amount = Math.max(120, Math.round(this.tabsContainer.clientWidth * 0.72));
        this.tabsContainer.scrollBy({ left: amount * direction, behavior: "smooth" });
        requestAnimationFrame(() => this.updateTabScrollButtons());
        setTimeout(() => this.updateTabScrollButtons(), 260);
        setTimeout(() => this.updateTabScrollButtons(), 520);
    }

    scrollActiveTabIntoView() {
        if (!this.tabsContainer) return;
        const active = this.tabsContainer.querySelector('.vnccs-ps-tab.active');
        if (!active) return;
        active.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }

    restoreMeshHistory(mesh) {
        const shapeChanged = Object.keys(mesh).some(key => this.isLiveMorphKey(key)
            && mesh[key] !== this.meshParams[key]);
        Object.assign(this.meshParams, mesh);
        this.meshParams.muscle = 0.5;
        this.applyCurrentMeshProportions();
        if (shapeChanged) {
            // An older shape may finish while the restored shape is being solved.
            this._lastAppliedMorphSeq = this._morphSeq;
            this.onMeshParamsChanged(null);
        }
    }

    async restoreImageHistory(pose) {
        this.pendingAgeCameraFit = false;
        const context = pose.editorState;
        if (Array.isArray(context?.lights)) {
            this.lightParams = this.normalizeUserLights(context.lights);
            this.refreshLightUI();
            this.viewer.updateLights(this.lightParams);
        }
        if (Array.isArray(context?.characters)
            && (context.activeCharacterId !== this.activeCharacterId
                || JSON.stringify(context.characters.map(item => item.id)) !== JSON.stringify(this.characters.map(item => item.id)))) {
            this.characters = JSON.parse(JSON.stringify(context.characters));
            this.activeCharacterId = context.activeCharacterId;
            this._selectedCharacterIds = new Set(context.selectedCharacterIds || []);
            this._temporarilyHiddenCharacters = new Set(context.hiddenCharacterIds || []);
            const active = this.getActiveCharacter();
            if (active) {
                this.meshParams = active.mesh;
                this.poses = active.poses;
                await this.loadModel(false, false);
                this.viewer.setPose(this.characterPoseForScene(active), true);
                const { history, future } = this.viewer;
                try {
                    await this.hydrateCharacterSceneModels({ showOverlay: false, recenterViewport: false });
                } finally {
                    this.viewer.history = history;
                    this.viewer.future = future;
                }
            }
            this.renderCharactersUI();
            this.updateCharacterScene();
        }
        const character = this.getActiveCharacter();
        if (context?.mesh) {
            this.restoreMeshHistory(context.mesh);
            this.viewer.setPose(pose, true);
        }
        const camera = context?.cameraParams || pose.cameraParams;
        if (camera) {
            this.exportParams.cam_offset_x = camera.offset_x;
            this.exportParams.cam_offset_y = camera.offset_y;
            this.exportParams.cam_zoom = camera.zoom;
            this.exportParams.cam_yaw_deg = camera.yaw_deg || 0;
            this.exportParams.cam_pitch_deg = camera.pitch_deg || 0;
            this.exportParams.cam_roll_deg = camera.roll_deg || 0;
            if (character && context?.transform) character.transform = { ...context.transform };
            this.persistActivePoseCameraParams();
            this.applyCameraToViewer(false);
        }
        if (Array.isArray(context?.group)) {
            for (const saved of context.group) {
                const target = this.characters.find(item => item.id === saved.id);
                if (!target) continue;
                target.transform = normalizeCharacterTransform(saved.transform);
                target.poses[this.activeTab] = JSON.parse(JSON.stringify(saved.pose));
                if (target.id === this.activeCharacterId) {
                    target.poses[this.activeTab].cameraParams = { ...this.currentCameraParams() };
                    this.viewer.setPose(target.poses[this.activeTab], true);
                }
            }
            this.updateCharacterScene();
        }
        this.syncCharacterEditorControls();
    }

    clearPoseHistory() {
        this._libraryLoadToken = (this._libraryLoadToken || 0) + 1;
        this.pendingAgeCameraFit = false;
        if (!this.viewer) return;
        this.viewer.history = [];
        this.viewer.future = [];
        this.hideHandControlPopover();
    }

    switchTab(index) {
        if (index === this.activeTab) return;
        this._finishPoseGesture?.();
        this.clearPoseHistory();

        // Save current pose & capture
        if (this.viewer && this.viewer.isInitialized()) {
            const savedPose = this.stripSceneCameraFromPose(this.viewer.getPose());
            savedPose.cameraParams = this.currentCameraParams();
            this.poses[this.activeTab] = savedPose;
            this.syncToNode(false);
        }

        this.activeTab = index;
        this.refreshTabActiveState();
        this.clearSAMCameraMode();

        // Load new pose
        const newPose = this.poses[this.activeTab] || {};
        this.restoreActivePoseCameraParams({ updateViewer: false });
        if (this.viewer && this.viewer.isInitialized()) {
            this.viewer.setPose(newPose, true);
            this.updateCharacterScene({ poseIndex: this.activeTab });
            this.updateRotationSliders();
        }

        // Force Camera Snap
        if (this.viewer) {
            this.updateCaptureCameraPreview();
        }

        this.syncToNode(false);
    }

    addTab(options = {}) {
        this._finishPoseGesture?.();
        this.clearPoseHistory();
        // Save current & capture
        if (this.viewer && this.viewer.isInitialized()) {
            const savedPose = this.stripSceneCameraFromPose(this.viewer.getPose());
            savedPose.cameraParams = this.currentCameraParams();
            this.poses[this.activeTab] = savedPose;
            this.syncToNode(false);
        }

        const previousPoseCount = this.poses.length;
        for (const character of this.characters) {
            if (!Array.isArray(character.poses)) character.poses = [];
            while (character.poses.length < previousPoseCount) character.poses.push({});
            const transform = normalizeCharacterTransform(character.transform || {});
            character.poses.push({
                cameraParams: {
                    offset_x: transform.x,
                    offset_y: transform.y,
                    zoom: transform.zoom,
                    yaw_deg: 0,
                    pitch_deg: 0,
                },
            });
        }
        this.poses = this.getActiveCharacter()?.poses || [...this.poses, {}];
        this.activeTab = this.poses.length - 1;
        this.updateTabs();
        this.clearSAMCameraMode();
        this.resetCameraParams();

        if (this.viewer && this.viewer.isInitialized()) {
            this.viewer.resetPose();
            this.updateCharacterScene({ poseIndex: this.activeTab });
        }
        this.updateCaptureCameraPreview();

        this.syncToNode(false, { skipCapture: options.capturePreview ? false : undefined });
    }

    deleteTab(targetIndex = -1) {
        if (this.poses.length <= 1) return;
        this._finishPoseGesture?.();
        this.clearPoseHistory();
        const idx = targetIndex === -1 ? this.activeTab : targetIndex;

        // Remove capture
        if (this.poseCaptures && this.poseCaptures.length > idx) {
            this.poseCaptures.splice(idx, 1);
        }

        for (const character of this.characters) {
            if (!Array.isArray(character.poses)) character.poses = [{}];
            if (character.poses.length > idx) character.poses.splice(idx, 1);
            if (!character.poses.length) character.poses.push({});
        }
        const active = this.getActiveCharacter();
        if (!active) this.poses.splice(idx, 1);
        else this.poses = active.poses;

        // Adjust active tab logic
        if (idx < this.activeTab) {
            this.activeTab--;
        } else if (idx === this.activeTab) {
            if (this.activeTab >= this.poses.length) {
                this.activeTab = this.poses.length - 1;
            }
        }

        this.restoreActivePoseCameraParams({ updateViewer: false });
        if (this.viewer && this.viewer.isInitialized()) {
            this.viewer.setPose(this.poses[this.activeTab] || {}, true);
            this.updateCharacterScene({ poseIndex: this.activeTab });
            this.updateRotationSliders();
            this.applyCameraToViewer(true);
        }

        this.updateTabs();
        this.syncToNode(false);
    }



    fitActiveRestPoseToFrame() {
        const active = this.getActiveCharacter();
        if (!active) throw new Error("Cannot fit rest pose without an active character.");
        if (!this.viewer?.isInitialized?.() || !this.viewer.sceneCameraTarget) {
            throw new Error("Cannot fit rest pose before the model camera target is ready.");
        }

        const previousTransform = { ...active.transform };
        const neutralTransform = { x: 0, y: 0, z: 0, zoom: 1 };
        try {
            this.viewer.setActiveCharacterAppearance({
                color: active.color,
                transform: neutralTransform,
            });
            const framing = this.viewer.computeModelFitFraming(
                this.exportParams.view_width || 1024,
                this.exportParams.view_height || 1024,
                this.exportParams.cam_yaw_deg || 0,
                this.exportParams.cam_pitch_deg || 0,
                0.08,
            );
            if (!framing) throw new Error("Cannot measure rest-pose framing.");

            const transform = cameraFramingToCharacterTransform({
                zoom: framing.zoom,
                offset_x: framing.offsetX,
                offset_y: framing.offsetY,
            }, this.viewer.sceneCameraTarget);
            active.transform = { ...transform };
            this.exportParams.cam_offset_x = transform.x;
            this.exportParams.cam_offset_y = transform.y;
            this.exportParams.cam_zoom = transform.zoom;
            this.viewer.setActiveCharacterAppearance({
                color: active.color,
                transform,
            });
            this.persistActivePoseCameraParams();
            this.applyCameraToViewer(true);
            this.syncCameraWidgets();
            return transform;
        } catch (error) {
            active.transform = previousTransform;
            this.viewer.setActiveCharacterAppearance({ color: active.color, transform: previousTransform });
            this.applyCameraToViewer(false);
            throw error;
        }
    }

    async resetCurrentPose() {
        this._poseDataRestoreError = null;
        this._finishPoseGesture?.();
        this._libraryLoadToken = (this._libraryLoadToken || 0) + 1;
        this.pendingAgeCameraFit = false;
        this.viewer?.recordState?.();
        Object.assign(this.meshParams, {
            age: 25,
            weight: 0.5,
            muscle: 0.5,
            height: 0.5,
            breast_size: 0.5,
            firmness: 0.5,
            show_genitals: false,
            penis_len: 0.5,
            penis_circ: 0.5,
            penis_test: 0.5,
        });
        this.resetMeshProportions();
        this.applyDefaultMeshSliders();
        this.onMeshParamsChanged();
        this.clearSAMCameraMode();
        Object.assign(this.exportParams, {
            cam_zoom: 1.0,
            cam_offset_x: 0,
            cam_offset_y: 0,
            cam_yaw_deg: 0,
            cam_pitch_deg: 0,
            cam_roll_deg: 0,
            bg_color: [0, 0, 0],
            background_url: null,
        });
        this.syncCameraWidgets();
        const active = this.getActiveCharacter();
        if (active) {
            active.mesh = this.meshParams;
            active.transform = normalizeCharacterTransform({ x: 0, y: 0, z: 0, zoom: 1 });
        }
        await this.awaitReadyForCompositeCapture();
        if (this.viewer) {
            this.viewer.resetPose();
            if (active) this.viewer.setActiveCharacterAppearance({ color: active.color, transform: active.transform });
            this.fitActiveRestPoseToFrame();
            this.updateCharacterScene({ poseIndex: this.activeTab });
            this.updateRotationSliders();
            this.applyCameraToViewer(true);
        }
        this.poses[this.activeTab] = { cameraParams: this.currentCameraParams() };
        if (active) active.poses = this.poses;
        if (Array.isArray(this.poseCaptures) && this.activeTab < this.poseCaptures.length) {
            this.poseCaptures[this.activeTab] = null;
        }
        this.syncToNode(true, { skipCaptureUpload: true });
    }

    async resetActiveCharacterPose({ restoreTransform = false } = {}) {
        const active = this.getActiveCharacter();
        if (!active || !this.viewer?.isInitialized?.()) return false;
        this._finishPoseGesture?.();
        this._libraryLoadToken = (this._libraryLoadToken || 0) + 1;
        await this.awaitReadyForCompositeCapture();
        if (this._disposed || active.id !== this.activeCharacterId || !this.viewer?.isInitialized?.()) return false;

        const cameraParams = this.currentCameraParams();
        this.viewer.recordState?.();
        Object.assign(this.meshParams, {
            age: 25,
            gender: 0.5,
            weight: 0.5,
            muscle: 0.5,
            height: 0.5,
            breast_size: 0.5,
            firmness: 0.5,
            show_genitals: false,
            penis_len: 0.5,
            penis_circ: 0.5,
            penis_test: 0.5,
        });
        this.resetMeshProportions();
        this.applyDefaultMeshSliders();
        this.updateGenderUI();
        active.mesh = this.meshParams;
        this.onMeshParamsChanged();
        await this.awaitReadyForCompositeCapture();
        if (this._disposed || active.id !== this.activeCharacterId || !this.viewer?.isInitialized?.()) return false;

        this.viewer.resetPose();
        const pose = this.stripSceneCameraFromPose(this.viewer.getPose());
        pose.cameraParams = cameraParams;
        this.poses[this.activeTab] = pose;
        active.poses = this.poses;
        if (restoreTransform) {
            active.transform = normalizeCharacterTransform(active.initialTransform || active.transform);
            this.exportParams.cam_offset_x = active.transform.x;
            this.exportParams.cam_offset_y = active.transform.y;
            this.exportParams.cam_zoom = active.transform.zoom;
            this.viewer.setActiveCharacterAppearance({ color: active.color, transform: active.transform });
            this.persistActivePoseCameraParams();
            for (const characterPose of active.poses || []) {
                if (!characterPose || typeof characterPose !== "object") continue;
                const savedCamera = this.cameraParamsForPose(characterPose, active);
                characterPose.cameraParams = {
                    ...savedCamera,
                    offset_x: active.transform.x,
                    offset_y: active.transform.y,
                    zoom: active.transform.zoom,
                };
            }
        }
        this.updateCharacterScene({ poseIndex: this.activeTab });
        this.updateRotationSliders();
        if (Array.isArray(this.poseCaptures) && this.activeTab < this.poseCaptures.length) {
            this.poseCaptures[this.activeTab] = null;
        }
        this.syncToNode(true, { skipCaptureUpload: true });
        return true;
    }

    async resetActiveCharacterPoseAndTransform() {
        return this.resetActiveCharacterPose({ restoreTransform: true });
    }

    async clearAllCharacters() {
        this._finishPoseGesture?.();
        if (this._sceneModelHydrationPromise) await this._sceneModelHydrationPromise;
        if (this._modelLoadPromise) await this._modelLoadPromise;
        await this.waitForMorphIdle();
        if (this._disposed || this._switchingCharacter) return;
        this.characters = [];
        this.activeCharacterId = null;
        this._selectedCharacterIds = new Set();
        this._temporarilyHiddenCharacters.clear();
        this.initialCharacterTransform = null;
        this.poses = this.poses.map(() => ({}));
        this.poseCaptures = [];
        this.clearPoseHistory();
        if (this.viewer) {
            this.viewer.history = [];
            this.viewer.future = [];
        }
        this.updateCharacterScene();
        this.renderCharactersUI();
        this.resetToMainView();
        this.syncToNode(false, { skipCapture: true });
    }

    applyCurrentMeshProportions() {
        for (const key of Object.keys(DEFAULT_POSE_STUDIO_MESH_PROPORTIONS)) {
            const value = this.meshParams[key];
            const slider = this.sliders?.[key];
            if (slider) {
                slider.slider.value = value;
                slider.label.innerText = this.formatMeshValue(key, value);
            }
            const widget = this.getNodeWidget(key);
            if (widget) widget.value = value;
        }
        if (this.viewer) {
            this.applyMeshProportionsToViewer(this.meshParams);
            this.viewer.updateHeadScale?.(this.meshParams.head_size);
            this.viewer.updateArmScale?.(this.meshParams.arm_size);
            this.viewer.updateHandScale?.(this.meshParams.hand_size);
            this.viewer.updateFootScale?.(this.meshParams.foot_size);
            for (const key of Object.keys(DEFAULT_POSE_STUDIO_MESH_PROPORTIONS)) {
                const value = this.meshParams[key];
                if (key.endsWith("_length")) {
                    this.viewer.updateBoneLengthScale?.(key.replace("_length", ""), value);
                }
            }
        }

    }

    applyDefaultMeshSliders() {
        for (const [key, info] of Object.entries(this.sliders)) {
            if (key.startsWith("rot_")) continue;
            const value = this.meshParams[key];
            if (value === undefined) continue;
            info.slider.value = value;
            info.label.innerText = this.formatMeshValue(key, value);
        }
    }

    resetMeshProportions() {
        for (const key of LEGACY_POSE_STUDIO_MESH_PROPORTION_KEYS) {
            delete this.meshParams[key];
        }
        Object.assign(this.meshParams, DEFAULT_POSE_STUDIO_MESH_PROPORTIONS);
        const active = this.getActiveCharacter();
        if (active) active.mesh = this.meshParams;

        this.applyCurrentMeshProportions();

        // Proportions affect every pose preview for the active character.
        this.poseCaptures = [];
    }

    resetSelectedBone() {
        if (this.viewer && this.viewer.isInitialized()) {
            this.viewer.resetSelectedBone();
            this.syncToNode(false);
        }
    }

    copyPose() {
        if (this.viewer && this.viewer.isInitialized()) {
            const pose = this.stripSceneCameraFromPose(this.viewer.getPose());
            pose.cameraParams = this.currentCameraParams();
            this.poses[this.activeTab] = pose;
        }
        this._clipboard = JSON.parse(JSON.stringify(this.poses[this.activeTab]));
    }

    pastePose() {
        if (!this._clipboard) return;
        this._libraryLoadToken = (this._libraryLoadToken || 0) + 1;
        this.clearSAMCameraMode();
        this.viewer?.recordState?.();
        this.poses[this.activeTab] = JSON.parse(JSON.stringify(this._clipboard));
        this.restoreActivePoseCameraParams({ updateViewer: false });
        this.persistActivePoseCameraParams();
        if (this.viewer && this.viewer.isInitialized()) {
            this.viewer.setPose(this.poses[this.activeTab], true);
            this.updateRotationSliders();
            this.hideHandControlPopover();
            this.updateCharacterScene({ poseIndex: this.activeTab });
            this.applyCameraToViewer(true);
        }
        this.syncToNode();
    }

    async fetchSAM3DRenderMesh(poseData, { signal = null } = {}) {
        const response = await api.fetchApi("/vnccs/sam3d/render_mesh_overlay", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                pose_data: poseData,
                body_preset: {},
                pose_adjust: 0.0,
            }),
            signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
        return result.mesh;
    }

    buildSAM3DFittedPoseData(poseData, meshData) {
        const fittedJointCoords = meshData?.fitted_joint_coords;
        if (!poseData || !Array.isArray(fittedJointCoords)) return poseData;
        return {
            ...poseData,
            joint_coords: fittedJointCoords,
            sam3d_pose_fit_source: "render_mesh_overlay",
        };
    }

    async prepareSAM3DRenderFit(poseData, { signal = null, reportError = true } = {}) {
        try {
            const meshData = await this.fetchSAM3DRenderMesh(poseData, { signal });
            return {
                meshData,
                poseData: this.buildSAM3DFittedPoseData(poseData, meshData),
            };
        } catch (err) {
            if (err?.name === "AbortError") throw err;
            console.error("[VNCCS] Failed to build SAM render fit:", err);
            if (reportError) this.showMessage?.(`Failed to build SAM render fit: ${err?.message || err}`, true);
            return null;
        }
    }


    applySAM3DMeshOverlayFit(meshData, poseData, options = {}) {
        if (!meshData || !this.viewer?.setSAMMeshOverlayData) return false;
        const ok = this.viewer.setSAMMeshOverlayData(meshData, poseData);
        this.viewer.setSAMMeshOverlayVisible?.(false);
        if (ok && this.viewer.fitCurrentPoseToSAMMeshOverlay) {
            return this.viewer.fitCurrentPoseToSAMMeshOverlay(
                0,
                { dispatchPoseChange: options.dispatchPoseChange !== false },
            );
        }
        return ok;
    }

    applySAM3DStandardCameraFit(poseData, meshData = null, standardTargetFrame = null) {
        const character = this.getActiveCharacter();
        const pivot = this.viewer?.sceneCameraTarget;
        if (!character || !pivot) return false;

        // The standard-camera solver returns framing for the mesh transform it
        // measures. Always measure a neutral character and convert that result
        // once to the character-space transform used by Pose Studio. Measuring
        // the previous crop and then multiplying it back in made every import
        // state-dependent and could shrink compact seated poses repeatedly.
        const previousTransform = normalizeCharacterTransform(character.transform);
        const previousAngles = {
            yaw_deg: Number(this.exportParams.cam_yaw_deg) || 0,
            pitch_deg: Number(this.exportParams.cam_pitch_deg) || 0,
        };
        const neutralTransform = { x: 0, y: 0, z: 0, zoom: 1 };
        this.viewer.setActiveCharacterAppearance({
            color: character.color,
            transform: neutralTransform,
        });
        this.exportParams.cam_yaw_deg = 0;
        this.exportParams.cam_pitch_deg = 0;
        this.applyCameraToViewer(true);

        const framing = this.viewer?.fitSAM3DToStandardCamera?.(
            poseData,
            this.exportParams.view_width || 1024,
            this.exportParams.view_height || 1024,
            meshData,
            standardTargetFrame,
        );
        if (!framing) {
            this.exportParams.cam_yaw_deg = previousAngles.yaw_deg;
            this.exportParams.cam_pitch_deg = previousAngles.pitch_deg;
            this.viewer.setActiveCharacterAppearance({
                color: character.color,
                transform: previousTransform,
            });
            this.applyCameraToViewer(true);
            return false;
        }

        let transform = cameraFramingToCharacterTransform(framing, pivot);
        // PerspectiveCamera.zoom and scaling a posed mesh are not exactly
        // equivalent when the body spans a large depth range. Apply the first
        // estimate, measure the visible viewport crop, and converge on the
        // fixed SAM target without changing FOV or revealing off-frame limbs.
        for (let iteration = 0; iteration < 4; iteration += 1) {
            this.viewer.setActiveCharacterAppearance({
                color: character.color,
                transform,
            });
            const correction = this.viewer?.computeSAM3DFrameCameraParams?.(
                poseData,
                this.exportParams.view_width || 1024,
                this.exportParams.view_height || 1024,
                meshData,
                true,
                standardTargetFrame,
            );
            if (!correction) break;
            if (
                Math.abs(Number(correction.zoom) - 1) < 1e-3
                && Math.abs(Number(correction.offset_x)) < 1e-3
                && Math.abs(Number(correction.offset_y)) < 1e-3
            ) break;
            transform = composeCameraFramingWithCharacterTransform(
                transform,
                correction,
                pivot,
            );
        }
        this.applyLibraryPoseTransform(transform, {
            yaw_deg: 0,
            pitch_deg: 0,
        });
        this.updateRotationSliders();
        return true;
    }

    applySAM3DFrameCameraParams(poseData, meshData = null, forceSourceFrame = false) {
        const frameParams = this.viewer?.computeSAM3DFrameCameraParams?.(
            poseData,
            this.exportParams.view_width || 1024,
            this.exportParams.view_height || 1024,
            meshData,
            forceSourceFrame,
        );
        if (!frameParams) {
            this.viewer?.setSAMProjectionCameraFrame?.(null);
            this._samCameraModeActive = false;
            return false;
        }
        if (frameParams.sam_projection && !forceSourceFrame) {
            const equivalentProjection = buildEquivalentPerspectiveProjectionFrame(
                frameParams.sam_projection,
                POSE_STUDIO_CAPTURE_FOV,
            );
            if (equivalentProjection) {
                this.viewer?.setSAMProjectionCameraFrame?.(equivalentProjection);
                this._samCameraModeActive = true;
                this._samCamStoredProjectionFrame = equivalentProjection;
                this.exportParams.cam_yaw_deg = 0;
                this.exportParams.cam_pitch_deg = 0;
                this.persistActivePoseCameraParams();
                this._samCamStoredParams = {
                    cam_zoom: this.exportParams.cam_zoom,
                    cam_offset_x: this.exportParams.cam_offset_x,
                    cam_offset_y: this.exportParams.cam_offset_y,
                    cam_yaw_deg: 0,
                    cam_pitch_deg: 0,
            cam_roll_deg: 0,
                };
                this.syncCameraWidgets();
                this.applyCameraToViewer(true);
                this.viewer.setCameraParams(this.currentCameraParams());
                return true;
            }
        }
        this.viewer?.setSAMProjectionCameraFrame?.(null);
        this._samCameraModeActive = false;
        this._samCamStoredParams = null;
        this._samCamStoredProjectionFrame = null;
        return this.applySAM3DStandardCameraFit(
            poseData,
            meshData,
            // For multiple people, retain the detected person's image-space
            // frame instead of fitting the centered projection of an isolated crop.
            forceSourceFrame ? null : (frameParams.sam_standard_target || null),
        );
    }

    loadReference() {
        if (this.exportParams.background_url || this._referenceReadPromise || this.viewer?.hasReferenceImage?.()) return;
        if (this.fileRefInput) {
            this.fileRefInput.click();
        }
    }

    updateBackgroundControls() {
        if (!this._backgroundUploadButton) return;
        this._backgroundUploadButton.disabled = !!(this.exportParams.background_url
            || this._referenceReadPromise || this.viewer?.hasReferenceImage?.());
    }

    appendBackgroundControls(actions, className = "vnccs-ps-btn") {
        const upload = document.createElement("button");
        upload.type = "button";
        upload.className = className;
        upload.textContent = "添加背景";
        upload.title = "添加背景图片；更换背景前请先移除现有背景";
        this._backgroundUploadButton = upload;
        upload.addEventListener("click", () => this.loadReference());
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = className;
        remove.textContent = "移除背景";
        remove.addEventListener("click", () => {
            this._referenceReadToken = (this._referenceReadToken || 0) + 1;
            this._referenceReadPromise = null;
            if (this.fileRefInput) this.fileRefInput.value = "";
            this._referenceReadError = null;
            this.exportParams.background_url = null;
            this.viewer?.removeReferenceImage();
            this.updateBackgroundControls();
            this.poseCaptures = [];
            this.updateCaptureCameraPreview();
            this.syncToNode(false);
        });
        actions.append(upload, remove);
        this.updateBackgroundControls();
    }

    handleRefImport(e) {
        const file = e.target.files[0];
        if (!file) return;
        const token = this._referenceReadToken = (this._referenceReadToken || 0) + 1;
        this._referenceReadError = null;
        this._referenceReadPromise = (async () => {
            try {
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(new Error("无法读取背景图片，请重新上传。"));
                    reader.onabort = () => reject(new Error("背景图片读取已取消，请重新上传。"));
                    reader.readAsDataURL(file);
                });
                if (this._disposed || token !== this._referenceReadToken) return;
                const image = await new Promise((resolve, reject) => {
                    const image = new Image();
                    image.onload = () => resolve(image);
                    image.onerror = () => reject(new Error("背景图片无法解码，请选择有效图片。"));
                    image.src = dataUrl;
                });
                if (this._disposed || token !== this._referenceReadToken) return;
                const width = image.naturalWidth;
                const height = image.naturalHeight;
                if (!width || !height) throw new Error("背景图片分辨率无效。");
                this._outputSizeUserSet = true;
                this.exportParams.view_width = width;
                this.exportParams.view_height = height;
                for (const [key, value] of [["view_width", width], ["view_height", height]]) {
                    const input = this.exportWidgets[key];
                    if (input) {
                        input.min = "1";
                        input.max = String(Math.max(4096, value));
                        input.step = "1";
                        input.value = String(value);
                    }
                }
                this.invalidatePoseCapturesForOutputSizeChange();
                this._lastResizeW = 0;
                this._lastResizeH = 0;
                this.resize();
                this.exportParams.background_url = dataUrl;
                this.viewer?.loadReferenceImage(dataUrl);
                await this.viewer?.waitForCaptureReady?.();
                if (this._disposed || token !== this._referenceReadToken) return;
                this.poseCaptures = [];
                this.updateCaptureCameraPreview();
                this.syncToNode(false);
            } catch (error) {
                if (this._disposed || token !== this._referenceReadToken) return;
                this._referenceReadError = error?.message || "背景图片加载失败，请重新上传或移除背景。";
                this.showMessage(this._referenceReadError, true);
            } finally {
                if (token === this._referenceReadToken) {
                    this._referenceReadPromise = null;
                    e.target.value = "";
                    this.updateBackgroundControls();
                }
            }
        })();
        this.updateBackgroundControls();
    }

    // === Pose Library Methods ===

    getLibraryThumbnailBounds() {
        return { min: 160, max: 520, defaultSize: 320 };
    }

    loadLibraryThumbnailSize() {
        const bounds = this.getLibraryThumbnailBounds();
        try {
            const preference = localStorage.getItem(this.libraryThumbSizeStorageKey);
            const stored = preference === null ? bounds.defaultSize : Number(preference);
            if (Number.isFinite(stored)) {
                return Math.max(bounds.min, Math.min(bounds.max, stored));
            }
        } catch (_err) {
            // localStorage can be unavailable in restricted browser contexts.
        }
        return bounds.defaultSize;
    }

    saveLibraryThumbnailSize(size) {
        const bounds = this.getLibraryThumbnailBounds();
        const value = Math.max(bounds.min, Math.min(bounds.max, Number(size) || bounds.defaultSize));
        this.libraryThumbSize = value;
        try {
            localStorage.setItem(this.libraryThumbSizeStorageKey, String(value));
        } catch (_err) {}
        this.applyLibraryThumbnailSize();
        return value;
    }

    applyLibraryThumbnailSize(root = null) {
        const target = root || this.libraryWorkspace || this.libraryGrid;
        if (!target) return;
        const size = this.libraryThumbSize || this.getLibraryThumbnailBounds().defaultSize;
        target.style.setProperty("--vnccs-ps-library-thumb-size", `${size}px`);
        target.style.setProperty("--vnccs-ps-library-thumb-height", `${Math.round(size * 1.3125)}px`);
        if (this.librarySizeValue) this.librarySizeValue.textContent = `${Math.round(size)}`;
    }

    showLibraryModal() {
        this._closeLibraryModal?.();
        this._fullscreenHost?.classList.add("vnccs-ps-library-open");
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay vnccs-ps-library-overlay';

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-library-modal';
        modal.innerHTML = `
            <div class="vnccs-ps-library-modal-header">
                <div class="vnccs-ps-library-modal-title">📚 Pose Library</div>
                <div class="vnccs-ps-library-header-actions">
                    <a class="vnccs-ps-btn primary vnccs-ps-library-download" href="https://pan.quark.cn/s/9a332350f6fc" target="_blank" rel="noopener noreferrer" style="white-space:nowrap;text-decoration:none">${xzgTh("下载姿势库", "Download Pose Library")}</a>
                    <button class="vnccs-ps-btn primary vnccs-ps-library-transfer" style="white-space:nowrap">${xzgTh("导入／导出姿势库", "Import / Export Pose Library")}</button>
                </div>
                <button class="vnccs-ps-btn primary vnccs-ps-library-apply-selected" disabled>${xzgTh("应用姿势", "Apply Pose")}</button>
                <button class="vnccs-ps-modal-close">✕</button>
            </div>
            <div class="vnccs-ps-library-toolbar">
                <input class="vnccs-ps-library-search" type="search" placeholder="Search poses and tags...">
                <label class="vnccs-ps-library-size-control" title="Preview size">
                    <span>Thumbnail</span>
                    <input class="vnccs-ps-library-size-slider" type="range" min="160" max="520" step="10">
                    <span class="vnccs-ps-library-size-value"></span>
                </label>
            </div>
            <div class="vnccs-ps-library-categories"></div>
            <div class="vnccs-ps-library-workspace">
                <div class="vnccs-ps-library-modal-grid"></div>
                <aside class="vnccs-ps-library-inspector"><div class="vnccs-ps-library-inspector-empty">Select a pose to preview and edit it.</div></aside>
            </div>
        `;

        this.libraryModal = modal;
        this.libraryGrid = modal.querySelector('.vnccs-ps-library-modal-grid');
        this.libraryInspector = modal.querySelector('.vnccs-ps-library-inspector');
        this.libraryApplyButton = modal.querySelector('.vnccs-ps-library-apply-selected');
        this.libraryWorkspace = modal.querySelector('.vnccs-ps-library-workspace');
        this.librarySearchInput = modal.querySelector('.vnccs-ps-library-search');
        this.librarySizeInput = modal.querySelector('.vnccs-ps-library-size-slider');
        this.librarySizeValue = modal.querySelector('.vnccs-ps-library-size-value');
        this.libraryCategoriesEl = modal.querySelector('.vnccs-ps-library-categories');
        this.librarySettingsEl = null;
        this.librarySettingsMode = false;
        this.librarySelectedName = null;
        this.libraryActiveCategory = "All";
        if (this.librarySizeInput) {
            this.librarySizeInput.value = String(this.libraryThumbSize);
            this.librarySizeInput.addEventListener('input', () => this.saveLibraryThumbnailSize(this.librarySizeInput.value));
        }
        this.applyLibraryThumbnailSize(this.libraryWorkspace);

        let closed = false;
        const closeLibraryModal = () => {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onLibraryKeyDown);
            if (this.libraryResizeObserver) {
                this.libraryResizeObserver.disconnect();
                this.libraryResizeObserver = null;
            }
            if (this._libraryRenderFrame) {
                cancelAnimationFrame(this._libraryRenderFrame);
                this._libraryRenderFrame = null;
            }
            if (this._libraryResizeFrame) {
                cancelAnimationFrame(this._libraryResizeFrame);
                this._libraryResizeFrame = null;
            }
            this.libraryModal = null;
            this.libraryGrid = this.libraryInspector = this.libraryWorkspace = null;
            this.libraryApplyButton = null;
            this.librarySearchInput = this.librarySizeInput = this.librarySizeValue = null;
            this.libraryCategoriesEl = null;
            this._libraryInspectorLoadToken = (this._libraryInspectorLoadToken || 0) + 1;
            this._closeLibraryModal = null;
            this._fullscreenHost?.classList.remove("vnccs-ps-library-open");
            overlay.remove();
        };
        const onLibraryKeyDown = (event) => {
            if (event.key !== 'Escape' || this._activeSaveLibraryOverlay) return;
            event.preventDefault();
            closeLibraryModal();
        };
        document.addEventListener('keydown', onLibraryKeyDown);
        this._closeLibraryModal = closeLibraryModal;
        modal.querySelector('.vnccs-ps-modal-close').onclick = closeLibraryModal;
        this.libraryApplyButton.onclick = async () => {
            const pose = (this.libraryPoses || []).find(item => this.getLibraryPoseId(item) === this.librarySelectedName);
            if (!pose) return;
            const close = this._closeLibraryModal;
            this.libraryApplyButton.disabled = true;
            try {
                await this.loadFromLibrary(pose);
                close?.();
            } finally {
                if (this.libraryModal === modal && this.libraryApplyButton) this.libraryApplyButton.disabled = false;
            }
        };
        modal.querySelector('.vnccs-ps-library-transfer').onclick = async () => {
            try {
                if (!window.XZGThemePanel?.openPoseLibraryTransferDialog) await import("./xzg_theme_panel.js");
                window.XZGThemePanel.openPoseLibraryTransferDialog({
                    onImported: async () => {
                        if (this.libraryModal === modal) await this.refreshLibrary(false);
                    },
                });
            } catch (error) {
                this.showMessage(`${xzgTh("打开姿势库导入导出失败：", "Could not open pose library transfer: ")}${error?.message || error}`, true);
            }
        };
        this.librarySearchInput.addEventListener('input', () => this.scheduleLibraryRender());
        overlay.onclick = (e) => { if (e.target === overlay) closeLibraryModal(); };

        overlay.appendChild(modal);
        this.container.appendChild(overlay);
        this.startLibraryResizeObserver();

        this.refreshLibrary(false);
    }

    startLibraryResizeObserver() {
        if (!this.libraryWorkspace || this.libraryResizeObserver) {
            this.updateLibraryLayoutScale();
            return;
        }
        if (typeof ResizeObserver !== "undefined") {
            this.libraryResizeObserver = new ResizeObserver(() => {
                if (this._libraryResizeFrame) return;
                this._libraryResizeFrame = requestAnimationFrame(() => {
                    this._libraryResizeFrame = null;
                    this.updateLibraryLayoutScale();
                });
            });
            if (this.libraryModal) this.libraryResizeObserver.observe(this.libraryModal);
            this.libraryResizeObserver.observe(this.libraryWorkspace);
        }
        this.updateLibraryLayoutScale();
    }

    updateLibraryLayoutScale() {
        if (this.libraryModal) {
            const modalWidth = this.libraryModal.clientWidth || this.libraryModal.getBoundingClientRect().width || 1600;
            const modalHeight = this.libraryModal.clientHeight || this.libraryModal.getBoundingClientRect().height || 1000;
            const scale = Math.max(0.5, Math.min(1.4, modalWidth / 1600));
            this.libraryModal.style.setProperty("--vnccs-ps-library-ui-scale", scale.toFixed(3));
            const headerScale = Math.max(0.5, Math.min(1.4, modalWidth / 1600, modalHeight / 1000)) * 0.62;
            this.libraryModal.style.setProperty("--vnccs-ps-library-header-scale", headerScale.toFixed(3));
        }
        this.updateLibraryInspectorScale();
    }

    updateLibraryInspectorScale() {
        if (!this.libraryWorkspace) return;
        const baseWidth = 340;
        const baseHeight = 900;
        const workspaceWidth = this.libraryWorkspace.clientWidth || baseWidth;
        const workspaceHeight = this.libraryWorkspace.clientHeight || baseHeight;
        const availableWidth = Math.max(260, Math.min(baseWidth, workspaceWidth * 0.38));
        const availableHeight = Math.max(420, workspaceHeight - 2);
        const scale = Math.max(0.45, Math.min(1, availableWidth / baseWidth, availableHeight / baseHeight));
        this.libraryWorkspace.style.setProperty("--vnccs-ps-library-inspector-scale", scale.toFixed(3));
    }

    async refreshLibrary(forceFull = false) {
        if (this._disposed) return;
        await poseCategoriesReady;
        if (this._disposed) return;
        const token = this._libraryRefreshToken = (this._libraryRefreshToken || 0) + 1;
        try {
            const res = await fetch(`/vnccs/pose_library/list?full=${forceFull === true}`);
            const data = await res.json();
            if (this._disposed || token !== this._libraryRefreshToken) return;
            if (!res.ok || !Array.isArray(data?.poses)) {
                throw new Error(data?.error || "Library items could not be loaded.");
            }
            this.libraryPoses = data.poses; // Cache for random selection
            this.renderLibrary();
        } catch (err) {
            if (this._disposed || token !== this._libraryRefreshToken) return;
            console.error("Failed to load library:", err);
            if (this.libraryGrid) {
                if (this.libraryPoses?.length) this.showMessage(`Failed to load library: ${err?.message || err}`, true);
                else this.libraryGrid.innerHTML = '<div class="vnccs-ps-library-empty">Failed to load library.</div>';
            }
        }
    }

    async autoRefreshEnabledPoseRepositories() {
        if (this._disposed || this._autoRepoRefreshStarted) return;
        this._autoRepoRefreshStarted = true;
        try {
            const res = await fetch('/vnccs/pose_library/repositories/auto_refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: 'pose_studio_initial_load', force: true }),
            });
            const data = await res.json().catch(() => ({}));
            if (this._disposed) return;
            const taskId = data.task_id;
            if (!taskId || (!data.started && !data.running)) return;

            const startedAt = Date.now();
            const poll = async () => {
                try {
                    const statusRes = await fetch(`/vnccs/pose_library/repositories/progress/${encodeURIComponent(taskId)}`);
                    if (!statusRes.ok) return false;
                    const status = await statusRes.json();
                    if (status.status === 'success') {
                        await this.refreshLibrary(false);
                        if (this.librarySettingsMode) await this.refreshPoseRepositories();
                        return true;
                    }
                    if (status.status === 'error') {
                        console.warn("[VNCCS PoseStudio] Background pose repository refresh failed:", status.message);
                        return true;
                    }
                    return false;
                } catch (err) {
                    console.warn("[VNCCS PoseStudio] Background pose repository refresh poll failed:", err);
                    return true;
                }
            };

            this._autoRepoRefreshTimer = setInterval(async () => {
                if (Date.now() - startedAt > 10 * 60 * 1000 || await poll()) {
                    clearInterval(this._autoRepoRefreshTimer);
                    this._autoRepoRefreshTimer = null;
                }
            }, 2500);
        } catch (err) {
            console.warn("[VNCCS PoseStudio] Failed to start background pose repository refresh:", err);
        }
    }

    async toggleLibrarySettings(force = null) {
        this.librarySettingsMode = force === null ? !this.librarySettingsMode : !!force;
        if (this.libraryWorkspace) {
            this.libraryWorkspace.classList.toggle('settings-mode', this.librarySettingsMode);
        }
        if (this.libraryCategoriesEl) this.libraryCategoriesEl.style.display = this.librarySettingsMode ? 'none' : '';
        if (this.librarySearchInput) {
            this.librarySearchInput.disabled = this.librarySettingsMode;
            this.librarySearchInput.placeholder = this.librarySettingsMode ? "Repository settings" : "Search poses and tags...";
        }
        if (this.librarySettingsMode) {
            await this.refreshPoseRepositories();
        } else {
            this.renderLibrary();
        }
    }

    async refreshPoseRepositories(forceRepoId = "") {
        if (this._disposed || !this.librarySettingsEl) return;
        const panel = this.librarySettingsEl;
        const token = this._repositoryRefreshToken = (this._repositoryRefreshToken || 0) + 1;
        const isCurrent = () => !this._disposed && panel === this.librarySettingsEl && token === this._repositoryRefreshToken;
        panel.innerHTML = '<div class="vnccs-ps-library-empty">Loading repositories...</div>';
        try {
            const url = '/vnccs/pose_library/repositories';
            const res = await fetch(url);
            const data = await res.json();
            if (!isCurrent()) return;
            if (!res.ok || !Array.isArray(data?.repositories)) {
                throw new Error(data?.error || "Repositories could not be loaded.");
            }
            this.localPoseRepository = data.local_repository || null;
            this.poseRepositories = data.repositories || [];
            this.renderPoseRepositorySettings();
            if (forceRepoId) await this.refreshSinglePoseRepository(forceRepoId);
        } catch (err) {
            if (isCurrent()) panel.innerHTML = `<div class="vnccs-ps-library-empty">Failed to load repositories.<br>${this.escapeHtml(err?.message || err)}</div>`;
        }
    }

    renderPoseRepositorySettings() {
        if (!this.librarySettingsEl) return;
        this.librarySettingsEl.innerHTML = `
            <div class="vnccs-ps-library-settings-head">
                <div>
                    <div class="vnccs-ps-library-settings-title">${xzgTh("本地姿势库", "Local Pose Library")}</div>
                    <div class="vnccs-ps-library-settings-subtitle">${xzgTh("姿势库仅使用本机保存的数据。", "Only poses stored locally on this ComfyUI installation are shown.")}</div>
                </div>
                <button class="vnccs-ps-btn vnccs-ps-library-settings-back">${xzgTh("返回姿势库", "Back to library")}</button>
            </div>
            <div class="vnccs-ps-library-local-repo"></div>
            <div class="vnccs-ps-library-empty">${xzgTh("远程姿势库已关闭。可通过配置备份导出和导入本地姿势。", "Remote pose repositories are disabled. Export or import local poses with a configuration backup.")}</div>
        `;
        this.librarySettingsEl.querySelector('.vnccs-ps-library-settings-back').onclick = () => this.toggleLibrarySettings(false);
        this.renderLocalPoseRepositorySettings();
    }

    renderLocalPoseRepositorySettings() {
        const holder = this.librarySettingsEl?.querySelector('.vnccs-ps-library-local-repo');
        if (!holder) return;
        const repo = this.localPoseRepository || {};
        holder.innerHTML = `
            <div class="vnccs-ps-library-repo-card">
                <div>
                    <div class="vnccs-ps-library-repo-title">${xzgTh("本地姿势", "Local Poses")}</div>
                    <div class="vnccs-ps-library-repo-id">${this.escapeHtml(repo.repo_id || "local_user_poses")}</div>
                    <div class="vnccs-ps-library-repo-meta">${Number(repo.pose_count || 0)} ${xzgTh("个姿势，保存在当前 ComfyUI 用户数据目录。", "poses stored in this ComfyUI user data directory.")}</div>
                </div>
            </div>
        `;
    }

    showRepositoryNotice(message, isError = false) {
        const notice = this.librarySettingsEl?.querySelector('.vnccs-ps-library-repo-notice');
        if (!notice) return;
        notice.textContent = message;
        notice.classList.toggle('error', !!isError);
        notice.classList.add('visible');
    }

    clearRepositoryNotice() {
        const notice = this.librarySettingsEl?.querySelector('.vnccs-ps-library-repo-notice');
        if (!notice) return;
        notice.textContent = "";
        notice.classList.remove('visible', 'error');
    }

    async publishLocalPoseRepository(forceConfigure = false) {
        this.showMessage("Remote publishing is disabled by the VNCCS security policy.", true);
        return;

        const repo = this.localPoseRepository || {};
        if (forceConfigure || !repo.publish_repo_id || !repo.publishing_enabled) {
            this.showPublishLocalRepositoryModal(forceConfigure);
            return;
        }
        await this.runLocalPoseRepositoryPublish({
            repo_id: repo.publish_repo_id,
            create: false,
        });
    }

    showPublishLocalRepositoryModal(forceConfigure = false) {
        const current = this.localPoseRepository || {};
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-modal';
        modal.style.maxWidth = "420px";
        modal.innerHTML = `
            <div class="vnccs-ps-modal-title">Publish Local Pose Repository</div>
            <div class="vnccs-ps-modal-content">
                <label class="vnccs-ps-library-field">
                    <span>Target</span>
                    <select class="vnccs-ps-input vnccs-ps-publish-mode">
                        <option value="create">Create new repository</option>
                        <option value="existing">Use existing repository</option>
                    </select>
                </label>
                <label class="vnccs-ps-library-field">
                    <span>Hugging Face repo</span>
                    <input class="vnccs-ps-input vnccs-ps-publish-repo" type="text" placeholder="owner/repository" value="${this.escapeHtml(current.publish_repo_id || "")}">
                </label>
                <label class="vnccs-ps-library-field vnccs-ps-publish-private-row">
                    <span>Visibility</span>
                    <label style="display:flex;align-items:center;gap:8px;color:var(--ps-text-muted);font-size: 14px;">
                        <input class="vnccs-ps-publish-private" type="checkbox"> Private repository
                    </label>
                </label>
                <p class="vnccs-ps-library-field">Remote publishing is disabled by the VNCCS security policy.</p>
            </div>
            <button class="vnccs-ps-modal-btn primary" style="justify-content:center;">Publish</button>
            <button class="vnccs-ps-modal-btn cancel">Cancel</button>
        `;

        const modeEl = modal.querySelector('.vnccs-ps-publish-mode');
        const repoEl = modal.querySelector('.vnccs-ps-publish-repo');
        const privateRow = modal.querySelector('.vnccs-ps-publish-private-row');
        let previousMode = current.publish_repo_id ? "existing" : "create";
        let existingRepoDraft = current.publish_repo_id || "";
        let newRepoDraft = "";
        const syncMode = () => {
            if (previousMode === "existing") existingRepoDraft = repoEl.value.trim();
            else newRepoDraft = repoEl.value.trim();
            repoEl.value = modeEl.value === "create" ? newRepoDraft : existingRepoDraft;
            repoEl.placeholder = modeEl.value === "create" ? "owner/new-repository" : "owner/repository";
            privateRow.style.display = modeEl.value === "create" ? "" : "none";
            previousMode = modeEl.value;
        };
        modeEl.value = previousMode;
        modeEl.onchange = syncMode;
        syncMode();

        modal.querySelector('.vnccs-ps-modal-btn.primary').onclick = async () => {
            const repoId = modal.querySelector('.vnccs-ps-publish-repo').value.trim();
            if (!repoId) {
                const repoInput = modal.querySelector('.vnccs-ps-publish-repo');
                repoInput.style.borderColor = "rgba(50,150,95,0.7)";
                repoInput.placeholder = "Repository id is required";
                repoInput.focus();
                return;
            }
            overlay.remove();
            await this.runLocalPoseRepositoryPublish({
                repo_id: repoId,
                create: modeEl.value === "create",
                private: modal.querySelector('.vnccs-ps-publish-private').checked,
            });
        };
        modal.querySelector('.vnccs-ps-modal-btn.cancel').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        overlay.appendChild(modal);
        this.container.appendChild(overlay);
        modal.querySelector('.vnccs-ps-publish-repo').focus();
    }

    async runLocalPoseRepositoryPublish(payload) {
        const repoId = String(payload?.repo_id || "").trim();
        if (!repoId) {
            this.showRepositoryNotice("Repository id is required.", true);
            return;
        }
        if (this._localPoseRepositoryPublishActive) {
            this.showRepositoryNotice("A local Pose Library publish is already running.", true);
            return;
        }

        this._localPoseRepositoryPublishActive = true;
        const progressKey = "local:publish";
        const taskId = this.createRepositoryTaskId("repo-publish");
        const progress = this.createInlineRepositoryProgress(progressKey, `Publishing local library to ${repoId}...`);
        this.setRepositoryProgressState(progressKey, { repoId });
        this.renderPoseRepositorySettings();
        let pollTimer = null;
        try {
            pollTimer = setInterval(() => this.pollRepositoryProgress(taskId, progress), 350);
            const res = await fetch('/vnccs/pose_library/repositories/local/publish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, repo_id: repoId, task_id: taskId }),
            });
            await this.pollRepositoryProgress(taskId, progress);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            this.localPoseRepository = data.local_repository || this.localPoseRepository;
            this.renderPoseRepositorySettings();
            const result = data.result || {};
            progress.update({
                status: "success",
                progress: 100,
                message: `Published ${Number(result.uploaded_count || 0)} files. Deleted ${Number(result.deleted_count || 0)} stale files. ${Number(result.skipped_count || 0)} library items unchanged.`,
            });
        } catch (err) {
            progress.update({
                status: "error",
                progress: 100,
                message: `Failed to publish local library: ${err?.message || err}`,
            });
            this.renderPoseRepositorySettings();
        } finally {
            if (pollTimer) clearInterval(pollTimer);
            this._localPoseRepositoryPublishActive = false;
            this.renderPoseRepositorySettings();
            progress.close();
        }
    }

    normalizePoseRepositoryInput(value) {
        const raw = String(value || "").trim();
        if (!/^https?:\/\//i.test(raw)) return raw.replace(/^\/+|\/+$/g, "");
        try {
            const url = new URL(raw);
            if (!['huggingface.co', 'www.huggingface.co'].includes(url.hostname.toLowerCase())) return "";
            const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
            if (parts.length < 2 || parts[0] === 'datasets' || parts[0] === 'spaces') return "";
            return `${parts[0]}/${parts[1]}`;
        } catch (_err) {
            return "";
        }
    }

    async addPoseRepository() {
        const input = this.librarySettingsEl?.querySelector('.vnccs-ps-library-repo-input');
        const repoId = this.normalizePoseRepositoryInput(input?.value);
        if (!repoId) return;
        const previousRepositories = [...(this.poseRepositories || [])];
        const taskId = this.createRepositoryTaskId("repo-add");
        const progressKey = `repo:${repoId}`;
        this.poseRepositories = [
            ...previousRepositories,
            {
                repo_id: repoId,
                title: repoId,
                enabled: true,
                status: "syncing",
                pose_count: 0,
            },
        ];
        this.renderPoseRepositorySettings();
        const progress = this.createInlineRepositoryProgress(progressKey, `Adding and downloading ${repoId}...`);
        let pollTimer = null;
        try {
            pollTimer = setInterval(() => this.pollRepositoryProgress(taskId, progress), 350);
            const res = await fetch('/vnccs/pose_library/repositories/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_id: repoId, task_id: taskId }),
            });
            await this.pollRepositoryProgress(taskId, progress);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            if (input) input.value = '';
            this.poseRepositories = data.repositories || [];
            this.renderPoseRepositorySettings();
            const refreshed = data.refreshed || {};
            if (refreshed.status === "error") {
                const message = refreshed.last_error || `Failed to download ${repoId}`;
                progress.update({ status: "error", progress: 100, message });
                this.showRepositoryNotice(`Repository was added, but its data could not be downloaded: ${message}`, true);
            } else {
                progress.update({
                    status: "success",
                    progress: 100,
                    message: `${repoId} added: ${Number(refreshed.downloaded_count || 0)} downloaded, ${Number(refreshed.skipped_count || 0)} unchanged.`,
                    transport: refreshed.transport || "",
                });
                this.clearRepositoryNotice();
            }
            await this.refreshLibrary(false);
            if (refreshed.status !== "error") {
                await this.toggleLibrarySettings(false);
            }
        } catch (err) {
            this.poseRepositories = previousRepositories;
            this.renderPoseRepositorySettings();
            this.showRepositoryNotice(`Failed to add repository: ${err?.message || err}`, true);
        } finally {
            if (pollTimer) clearInterval(pollTimer);
            progress.close();
        }
    }

    createRepositoryTaskId(prefix = "repo") {
        return (
            globalThis.crypto?.randomUUID?.()
            || `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
        );
    }

    repositoryProgressMarkup() {
        return `
            <div class="vnccs-ps-library-repo-progress">
                <div class="vnccs-ps-library-repo-progress-head">
                    <span class="vnccs-ps-library-repo-progress-message"></span>
                    <span class="vnccs-ps-library-repo-progress-percent">0%</span>
                </div>
                <div class="vnccs-ps-library-repo-progress-track">
                    <div class="vnccs-ps-library-repo-progress-fill"></div>
                </div>
            </div>
        `;
    }

    findRepositoryProgressCard(key) {
        const cards = this.librarySettingsEl?.querySelectorAll('[data-repo-progress-key]') || [];
        return Array.from(cards).find((card) => card.dataset.repoProgressKey === key) || null;
    }

    setRepositoryProgressState(key, patch) {
        this.repositoryProgressStates[key] = {
            ...(this.repositoryProgressStates[key] || {}),
            ...patch,
        };
        this.updateRepositoryProgressUi(key);
    }

    updateRepositoryProgressUi(key) {
        const card = this.findRepositoryProgressCard(key);
        if (!card) return;
        const state = this.repositoryProgressStates[key];
        const progress = card.querySelector('.vnccs-ps-library-repo-progress');
        if (!progress || !state) {
            card.classList.remove('is-running');
            progress?.classList.remove('visible', 'error', 'success');
            return;
        }
        const percent = Math.max(0, Math.min(100, Number(state.progress) || 0));
        progress.classList.add('visible');
        progress.classList.toggle('error', state.status === 'error');
        progress.classList.toggle('success', state.status === 'success');
        card.classList.toggle('is-running', state.status === 'running');
        const messageEl = progress.querySelector('.vnccs-ps-library-repo-progress-message');
        const percentEl = progress.querySelector('.vnccs-ps-library-repo-progress-percent');
        const fillEl = progress.querySelector('.vnccs-ps-library-repo-progress-fill');
        if (messageEl) messageEl.textContent = state.message || "Working...";
        if (percentEl) percentEl.textContent = `${Math.round(percent)}%`;
        if (fillEl) fillEl.style.width = `${percent}%`;
    }

    createInlineRepositoryProgress(key, initialText = "Starting...") {
        const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        this.setRepositoryProgressState(key, {
            token,
            status: "running",
            message: initialText,
            progress: 1,
        });
        return {
            setText: (message) => this.setRepositoryProgressState(key, { message }),
            setProgress: (progress) => this.setRepositoryProgressState(key, { progress }),
            update: (status) => {
                if (!status) return;
                const patch = {};
                if (status.status) patch.status = status.status;
                if (status.message) patch.message = status.message;
                if (status.progress !== undefined) patch.progress = status.progress;
                if (Object.prototype.hasOwnProperty.call(status, "transport")) patch.transport = status.transport || "";
                this.setRepositoryProgressState(key, patch);
            },
            close: (delay = 1600) => {
                setTimeout(() => {
                    if (this.repositoryProgressStates[key]?.token !== token) return;
                    delete this.repositoryProgressStates[key];
                    this.updateRepositoryProgressUi(key);
                }, delay);
            },
        };
    }

    async pollRepositoryProgress(taskId, progress, titleText) {
        if (!taskId || !progress) return;
        try {
            const res = await fetch(`/vnccs/pose_library/repositories/progress/${encodeURIComponent(taskId)}`);
            if (!res.ok) return;
            const status = await res.json();
            if (status.current_file && status.file_index && status.total_files) {
                status.message = `${status.message || status.current_file} · file ${status.file_index}/${status.total_files}`;
            }
            progress.update(status);
            if (status.status === "success" || status.status === "error") {
                progress.setProgress(status.progress ?? 100);
            }
        } catch (_err) {
            // Progress polling is best-effort; the POST response remains authoritative.
        }
    }

    async togglePoseRepository(repoId, enabled) {
        const taskId = this.createRepositoryTaskId("repo-toggle");
        const progressKey = `repo:${repoId}`;
        const progress = this.createInlineRepositoryProgress(progressKey, `${enabled ? "Enabling" : "Disabling"} ${repoId}...`);
        let pollTimer = null;
        try {
            progress.setText(`${enabled ? "Enabling" : "Disabling"} ${repoId}...`);
            progress.setProgress(1);
            pollTimer = setInterval(() => this.pollRepositoryProgress(taskId, progress), 350);
            const res = await fetch('/vnccs/pose_library/repositories/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_id: repoId, enabled, task_id: taskId }),
            });
            await this.pollRepositoryProgress(taskId, progress);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                progress.update({ status: "error", progress: 100, message: data?.error || `Failed to update ${repoId}` });
                return;
            }
            this.poseRepositories = data.repositories || [];
            this.renderPoseRepositorySettings();
            progress.update({
                status: "success",
                progress: 100,
                message: `${repoId} ${enabled ? "enabled" : "disabled"}.`,
            });
            await this.refreshLibrary(false);
            if (enabled) {
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
                await this.refreshSinglePoseRepository(repoId);
            }
        } finally {
            if (pollTimer) clearInterval(pollTimer);
            progress.close();
        }
    }

    async refreshSinglePoseRepository(repoId) {
        const taskId = this.createRepositoryTaskId("repo-refresh");
        const progressKey = `repo:${repoId}`;
        const progress = this.createInlineRepositoryProgress(progressKey, `Checking ${repoId}...`);
        let pollTimer = null;
        try {
            progress.setText(`Checking ${repoId}...`);
            progress.setProgress(1);
            pollTimer = setInterval(() => this.pollRepositoryProgress(taskId, progress), 350);
            const res = await fetch('/vnccs/pose_library/repositories/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo_id: repoId, task_id: taskId }),
            });
            await this.pollRepositoryProgress(taskId, progress);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                progress.update({ status: "error", progress: 100, message: data?.error || `Failed to refresh ${repoId}` });
                return;
            }
            this.poseRepositories = data.repositories || [];
            this.renderPoseRepositorySettings();
            const refreshed = data.refreshed?.[0] || {};
            progress.update({
                status: refreshed.status === "error" ? "error" : "success",
                progress: 100,
                message: refreshed.status === "error"
                    ? `Error: ${refreshed.last_error || "refresh failed"}`
                    : `Repository sync complete: ${Number(refreshed.downloaded_count || 0)} downloaded, ${Number(refreshed.skipped_count || 0)} unchanged, ${Number(refreshed.removed_count || 0)} removed.`,
                transport: refreshed.transport || "",
            });
            await this.refreshLibrary(false);
        } finally {
            if (pollTimer) clearInterval(pollTimer);
            progress.close();
        }
    }

    async removePoseRepository(repoId) {
        const res = await fetch(`/vnccs/pose_library/repositories/delete/${encodeURIComponent(repoId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            this.showRepositoryNotice(data?.error || `Failed to remove ${repoId}`, true);
            return;
        }
        this.poseRepositories = data.repositories || [];
        this.renderPoseRepositorySettings();
        this.clearRepositoryNotice();
        this.showRepositoryNotice(`Removed ${repoId}. Deleted ${Number(data.removed_count || 0)} cached files.`);
        await this.refreshLibrary(false);
    }

    getLibraryPoseMeta(pose) {
        const dataMeta = pose?.data?._library || {};
        const sourceCategory = this.normalizeLibraryCategory(pose?.category || dataMeta.category || "Uncategorized");
        const category = this.resolveLibraryCategory(sourceCategory);
        const rawTags = Array.isArray(pose?.tags) ? pose.tags : (Array.isArray(dataMeta.tags) ? dataMeta.tags : []);
        const tags = rawTags.map(tag => String(tag).trim()).filter(Boolean);
        const repository = (pose?.repository || dataMeta.repository || "local_user_poses").trim() || "local_user_poses";
        return { repository, category, sourceCategory, tags };
    }

    getLibraryPoseName(poseOrName) {
        return typeof poseOrName === 'string' ? poseOrName : (poseOrName?.name || "");
    }

    getLibraryPoseId(pose) {
        if (!pose) return "";
        const meta = this.getLibraryPoseMeta(pose);
        return pose.id || `${meta.repository}/poses/${meta.sourceCategory}/${pose.name}`;
    }

    getLibraryPoseQuery(poseOrName) {
        if (!poseOrName || typeof poseOrName === 'string') return "";
        const meta = this.getLibraryPoseMeta(poseOrName);
        const params = new URLSearchParams();
        params.set("repository", meta.repository);
        params.set("category", meta.sourceCategory);
        params.set("asset_type", "pose");
        return `?${params.toString()}`;
    }

    getLibraryPreviewUrl(pose) {
        if (!pose?.has_preview) return "";
        const meta = this.getLibraryPoseMeta(pose);
        const params = new URLSearchParams();
        params.set("repository", meta.repository);
        params.set("category", meta.sourceCategory);
        params.set("asset_type", "pose");
        if (pose.preview_mtime) params.set("v", String(pose.preview_mtime));
        return `/vnccs/pose_library/preview/${encodeURIComponent(pose.name)}?${params.toString()}`;
    }

    getFilteredLibraryPoses() {
        const poses = this.libraryPoses || [];
        const query = (this.librarySearchInput?.value || "").trim().toLowerCase();
        return poses.filter((pose) => {
            const meta = this.getLibraryPoseMeta(pose);
            if (this.libraryActiveCategory && this.libraryActiveCategory !== "All" && this.normalizeLibraryCategory(meta.category) !== this.normalizeLibraryCategory(this.libraryActiveCategory)) {
                return false;
            }
            if (!query) return true;
            const haystack = [
                pose.name,
                meta.repository,
                meta.category,
                ...meta.tags,
            ].join(" ").toLowerCase();
            return haystack.includes(query);
        });
    }

    scheduleLibraryRender() {
        if (this._libraryRenderFrame) return;
        this._libraryRenderFrame = requestAnimationFrame(() => {
            this._libraryRenderFrame = null;
            this.renderLibrary();
        });
    }

    getLibraryCategorySettings() {
        try {
            const value = JSON.parse(localStorage.getItem("xzg_pose_library_categories") || "{}");
            return {
                added: Array.isArray(value.added) ? value.added.filter(v => typeof v === "string") : [],
                hidden: Array.isArray(value.hidden) ? value.hidden.filter(v => typeof v === "string") : [],
                order: Array.isArray(value.order) ? value.order.filter(v => typeof v === "string") : [],
                renamed: value.renamed && typeof value.renamed === "object" && !Array.isArray(value.renamed) ? value.renamed : {},
                geometry: value.geometry && typeof value.geometry === "object" ? value.geometry : null,
            };
        } catch (_) { return { added: [], hidden: [], order: [], renamed: {}, geometry: null }; }
    }

    normalizeLibraryCategory(category) {
        const value = String(category || "").trim();
        return !value || value === "未分类" || value.toLowerCase() === "uncategorized" ? "Uncategorized" : value;
    }

    resolveLibraryCategory(category, settings = this.getLibraryCategorySettings()) {
        let value = this.normalizeLibraryCategory(category);
        const visited = new Set();
        while (settings.renamed[value] && !visited.has(value)) {
            visited.add(value);
            value = this.normalizeLibraryCategory(settings.renamed[value]);
        }
        return value;
    }

    getLibraryCategories() {
        const settings = this.getLibraryCategorySettings();
        const hidden = new Set(settings.hidden.map(category => this.resolveLibraryCategory(category, settings)));
        const categories = Array.from(new Set(["Uncategorized", ...settings.added,
            ...(this.libraryPoses || []).map(pose => this.getLibraryPoseMeta(pose).category),
        ].map(category => this.resolveLibraryCategory(category, settings)))).filter(category => category !== "All" && !hidden.has(category));
        const uncategorized = categories.includes("Uncategorized") ? ["Uncategorized"] : [];
        const available = new Set(categories.filter(category => category !== "Uncategorized"));
        const ordered = [];
        for (const category of settings.order) {
            const resolved = this.resolveLibraryCategory(category, settings);
            if (available.has(resolved) && !ordered.includes(resolved)) ordered.push(resolved);
        }
        const remaining = [...available].filter(category => !ordered.includes(category)).sort((a, b) => a.localeCompare(b));
        return [...uncategorized, ...ordered, ...remaining];
    }

    libraryCategoryOptions(selected = "Uncategorized") {
        selected = this.normalizeLibraryCategory(selected);
        return this.getLibraryCategories().map(category =>
            `<option value="${this.escapeHtml(category)}"${category === selected ? " selected" : ""}>${this.escapeHtml(category)}</option>`
        ).join("");
    }

    async showLibraryCategoryManager() {
        await poseCategoriesReady;
        if (this._disposed) return;
        this._closeLibraryCategoryManager?.();
        const overlay = document.createElement("div");
        overlay.className = "vnccs-ps-modal-overlay";
        const modal = document.createElement("div");
        modal.className = "vnccs-ps-modal vnccs-ps-category-manager";
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");
        modal.innerHTML = `<div class="vnccs-ps-category-header"><div class="vnccs-ps-modal-title">${xzgTh("设置分类", "Manage categories")}</div><button class="vnccs-ps-modal-btn" data-action="close" aria-label="${xzgTh("关闭", "Close")}">×</button></div>
            <div class="vnccs-ps-category-add">
                <label>${xzgTh("新增分类", "New category")}<input class="vnccs-ps-input" maxlength="64" placeholder="${xzgTh("输入分类名称，按 Enter 新增", "Enter a category name, then press Enter")}"></label>
                <button class="vnccs-ps-modal-btn primary" data-action="add">${xzgTh("＋ 新增分类", "+ Add category")}</button>
            </div>
            <div class="vnccs-ps-category-message" data-role="message" role="status" aria-live="polite"></div>
            <div class="vnccs-ps-category-grid" data-role="categories"></div>
            <div class="vnccs-ps-category-footer"><span>${xzgTh("移除分类不会删除姿势，仍可在“全部”中查看。分类设置自动持久化，并纳入小珠光统一导出／导入备份。", "Removing categories keeps their poses under All. Category settings are persisted and included in XZG export/import backups.")}</span><button class="vnccs-ps-modal-btn primary" data-action="done">${xzgTh("完成", "Done")}</button></div>`;
        const input = modal.querySelector("input");
        const list = modal.querySelector('[data-role="categories"]');
        const message = modal.querySelector('[data-role="message"]');
        const commit = settings => {
            try { localStorage.setItem(POSE_CATEGORY_KEY, JSON.stringify(settings)); }
            catch (error) { message.textContent = xzgTh("分类设置保存失败", "Could not save categories"); return false; }
            cloudSave(POSE_CATEGORY_KEY, settings);
            this.renderLibrary();
            render();
            return true;
        };
        const renameCategory = oldCategory => {
            const rawName = window.prompt(xzgTh("重命名分类", "Rename category"), oldCategory);
            if (rawName == null) return;
            const newCategory = this.normalizeLibraryCategory(rawName);
            if (!rawName.trim() || ["All", "全部", "所有", "Uncategorized"].includes(newCategory)) {
                message.textContent = xzgTh("请输入有效的分类名称。", "Enter a valid category name.");
                return;
            }
            if (newCategory.toLowerCase() === oldCategory.toLowerCase()) return;
            if (this.getLibraryCategories().some(value => value.toLowerCase() === newCategory.toLowerCase())) {
                message.textContent = xzgTh("该分类已存在。", "This category already exists.");
                return;
            }
            const settings = this.getLibraryCategorySettings();
            settings.renamed = { ...settings.renamed };
            const rawCategories = new Set([
                ...settings.added,
                ...Object.keys(settings.renamed),
                ...(this.libraryPoses || []).map(pose => pose?.category || pose?.data?._library?.category || "Uncategorized"),
            ].map(category => this.normalizeLibraryCategory(category)));
            for (const category of rawCategories) {
                if (this.resolveLibraryCategory(category, settings) === oldCategory) {
                    settings.renamed[category] = newCategory;
                }
            }
            settings.order = settings.order.map(category =>
                this.resolveLibraryCategory(category, settings) === oldCategory ? newCategory : category
            );
            settings.hidden = settings.hidden.map(category =>
                this.resolveLibraryCategory(category, settings) === oldCategory ? newCategory : category
            );
            if (this.libraryActiveCategory === oldCategory) this.libraryActiveCategory = newCategory;
            if (commit(settings)) message.textContent = xzgTh("分类已重命名。", "Category renamed.");
        };
        const render = () => {
            list.replaceChildren();
            const active = this.getLibraryCategories();
            for (const category of active) {
                const row = document.createElement("div");
                row.className = "vnccs-ps-category-card";
                row.dataset.category = category;
                row.draggable = category !== "Uncategorized";
                row.classList.toggle("is-fixed", category === "Uncategorized");
                const label = document.createElement("span");
                label.className = "vnccs-ps-category-name";
                label.textContent = category;
                label.title = category;
                const count = document.createElement("span");
                count.className = "vnccs-ps-category-count";
                const total = (this.libraryPoses || []).filter(pose => this.normalizeLibraryCategory(this.getLibraryPoseMeta(pose).category) === category).length;
                count.textContent = `${total} ${xzgTh("个姿势", "poses")}`;
                const dragHandle = document.createElement("span");
                dragHandle.className = "vnccs-ps-category-drag-handle";
                dragHandle.textContent = category === "Uncategorized" ? "" : "⠿";
                dragHandle.title = xzgTh("拖动分类排序", "Drag to reorder categories");
                dragHandle.setAttribute("aria-hidden", "true");
                const actions = document.createElement("div");
                actions.className = "vnccs-ps-category-actions";
                const rename = document.createElement("button");
                rename.className = "vnccs-ps-modal-btn category-rename";
                rename.textContent = xzgTh("重命名", "Rename");
                rename.disabled = category === "Uncategorized";
                rename.title = xzgTh("重命名分类", "Rename category");
                rename.onclick = () => renameCategory(category);
                const remove = document.createElement("button");
                remove.className = "vnccs-ps-modal-btn";
                remove.textContent = xzgTh("移除", "Remove");
                remove.classList.add("category-remove");
                remove.disabled = category === "Uncategorized";
                remove.onclick = () => {
                    const settings = this.getLibraryCategorySettings();
                    settings.added = settings.added.filter(value => this.resolveLibraryCategory(value, settings) !== category);
                    // Suppress categories supplied by repositories so refreshing
                    // their manifests cannot recreate an explicitly removed entry.
                    settings.hidden = [...new Set([...settings.hidden, category])];
                    if (commit(settings)) message.textContent = xzgTh("分类已移除。", "Category removed.");
                };
                if (category === "Uncategorized") remove.textContent = xzgTh("默认分类", "Default");
                actions.append(rename, remove);
                row.append(label, count, dragHandle, actions);
                list.appendChild(row);
            }
        };
        let draggedCategory = null;
        list.addEventListener("dragstart", event => {
            const row = event.target.closest(".vnccs-ps-category-card");
            if (!row || row.dataset.category === "Uncategorized") { event.preventDefault(); return; }
            draggedCategory = row.dataset.category;
            row.classList.add("dragging");
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", draggedCategory);
        });
        list.addEventListener("dragover", event => {
            const row = event.target.closest(".vnccs-ps-category-card");
            if (!draggedCategory || !row || row.dataset.category === "Uncategorized" || row.dataset.category === draggedCategory) return;
            event.preventDefault();
            for (const card of list.querySelectorAll(".drag-over")) card.classList.remove("drag-over");
            row.classList.add("drag-over");
        });
        list.addEventListener("drop", event => {
            const row = event.target.closest(".vnccs-ps-category-card");
            if (!draggedCategory || !row || row.dataset.category === "Uncategorized" || row.dataset.category === draggedCategory) return;
            event.preventDefault();
            const order = this.getLibraryCategories().filter(category => category !== "Uncategorized");
            const from = order.indexOf(draggedCategory);
            const target = order.indexOf(row.dataset.category);
            if (from < 0 || target < 0) return;
            const rect = row.getBoundingClientRect();
            const deltaY = event.clientY - (rect.top + rect.height / 2);
            const deltaX = event.clientX - (rect.left + rect.width / 2);
            // The cards wrap into a grid, so use the horizontal midpoint for
            // same-row drops and the vertical midpoint for drops above/below.
            const after = Math.abs(deltaY) > rect.height * 0.35 ? deltaY > 0 : deltaX > 0;
            order.splice(from, 1);
            let insertion = target + (after ? 1 : 0);
            if (from < insertion) insertion--;
            order.splice(Math.max(0, Math.min(insertion, order.length)), 0, draggedCategory);
            const settings = this.getLibraryCategorySettings();
            settings.order = order;
            if (commit(settings)) message.textContent = xzgTh("分类顺序已保存。", "Category order saved.");
        });
        list.addEventListener("dragend", () => {
            draggedCategory = null;
            for (const card of list.querySelectorAll(".dragging, .drag-over")) {
                card.classList.remove("dragging", "drag-over");
            }
        });
        modal.querySelector('[data-action="add"]').onclick = () => {
            const category = this.normalizeLibraryCategory(input.value);
            if (!input.value.trim()) { message.textContent = xzgTh("请输入有效的分类名称。", "Enter a valid category name."); input.focus(); return; }
            if (!category || ["All", "全部", "所有"].includes(category)) { message.textContent = xzgTh("请输入有效的分类名称。", "Enter a valid category name."); input.focus(); return; }
            if (this.getLibraryCategories().some(value => value.toLowerCase() === category.toLowerCase())) { message.textContent = xzgTh("该分类已存在。", "This category already exists."); input.focus(); return; }
            const settings = this.getLibraryCategorySettings();
            settings.added = [...new Set([...settings.added, category])];
            settings.hidden = settings.hidden.filter(value => this.resolveLibraryCategory(value, settings) !== category);
            settings.order = [
                ...this.getLibraryCategories().filter(value => value !== "Uncategorized"),
                category,
            ];
            if (commit(settings)) { input.value = ""; message.textContent = xzgTh("分类已添加。", "Category added."); input.focus(); }
        };
        input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); modal.querySelector('[data-action="add"]').click(); } });
        const close = () => {
            window.removeEventListener("resize", onViewportResize);
            if (gesture) saveGeometry();
            overlay.remove();
            document.removeEventListener("keydown", onKeyDown, true);
            if (this._closeLibraryCategoryManager === close) this._closeLibraryCategoryManager = null;
        };
        const onKeyDown = event => {
            if (event.key !== "Escape") return;
            event.preventDefault(); event.stopImmediatePropagation(); close();
        };
        modal.querySelector('[data-action="close"]').onclick = close;
        modal.querySelector('[data-action="done"]').onclick = close;
        overlay.onclick = event => { if (event.target === overlay) close(); };
        document.addEventListener("keydown", onKeyDown, true);
        this._closeLibraryCategoryManager = close;
        overlay.appendChild(modal);
        this.container.appendChild(overlay);
        const header = modal.querySelector(".vnccs-ps-category-header");
        const resizeHandle = document.createElement("div");
        resizeHandle.className = "vnccs-ps-category-resize";
        resizeHandle.title = xzgTh("拖动调整窗口大小", "Drag to resize window");
        modal.appendChild(resizeHandle);
        let gesture = null;
        const bounds = () => {
            const rect = overlay.getBoundingClientRect();
            return { rect, width: overlay.clientWidth, height: overlay.clientHeight,
                sx: rect.width / (overlay.clientWidth || 1), sy: rect.height / (overlay.clientHeight || 1) };
        };
        const applyGeometry = geometry => {
            const b = bounds();
            const width = Math.min(Math.max(480, Number(geometry.width) || 1120), Math.max(0, b.width - 24));
            const height = Math.min(Math.max(360, Number(geometry.height) || 720), Math.max(0, b.height - 24));
            const x = Math.max(12, Math.min(Number.isFinite(geometry.x) ? geometry.x : (b.width - width) / 2, b.width - width - 12));
            const y = Math.max(12, Math.min(Number.isFinite(geometry.y) ? geometry.y : (b.height - height) / 2, b.height - height - 12));
            Object.assign(modal.style, { position: "absolute", left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`, maxHeight: "none", margin: "0", transform: "none" });
        };
        const currentGeometry = () => {
            const b = bounds(), rect = modal.getBoundingClientRect();
            return { x: (rect.left - b.rect.left) / b.sx, y: (rect.top - b.rect.top) / b.sy, width: rect.width / b.sx, height: rect.height / b.sy };
        };
        const saveGeometry = () => {
            const settings = this.getLibraryCategorySettings();
            settings.geometry = currentGeometry();
            cloudSave(POSE_CATEGORY_KEY, settings);
        };
        for (const [handle, mode] of [[header, "move"], [resizeHandle, "resize"]]) {
            handle.addEventListener("pointerdown", event => {
                if (event.button !== 0 || event.target.closest("button")) return;
                event.preventDefault(); event.stopPropagation();
                gesture = { pointerId: event.pointerId, mode, x: event.clientX, y: event.clientY, geometry: currentGeometry() };
                handle.setPointerCapture(event.pointerId);
            });
            handle.addEventListener("pointermove", event => {
                if (!gesture || gesture.pointerId !== event.pointerId) return;
                const b = bounds(), dx = (event.clientX - gesture.x) / b.sx, dy = (event.clientY - gesture.y) / b.sy;
                const g = gesture.geometry;
                applyGeometry(gesture.mode === "move" ? { ...g, x: g.x + dx, y: g.y + dy } : { ...g, width: Math.min(g.width + dx, b.width - g.x - 12), height: Math.min(g.height + dy, b.height - g.y - 12) });
            });
            const endGesture = event => {
                if (!gesture || gesture.pointerId !== event.pointerId) return;
                gesture = null;
                saveGeometry();
                if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
            };
            handle.addEventListener("pointerup", endGesture);
            handle.addEventListener("pointercancel", endGesture);
            handle.addEventListener("lostpointercapture", endGesture);
        }
        const onViewportResize = () => applyGeometry(currentGeometry());
        window.addEventListener("resize", onViewportResize);
        applyGeometry(this.getLibraryCategorySettings().geometry || {});
        render();
        input.focus();
    }

    renderLibraryCategories() {
        if (!this.libraryCategoriesEl) return;
        if (this.libraryActiveCategory) this.libraryActiveCategory = this.normalizeLibraryCategory(this.libraryActiveCategory);
        const categories = this.getLibraryCategories();
        const uncategorized = categories.find(category => category.toLowerCase() === "uncategorized");
        const all = [
            "All",
            ...(uncategorized ? [uncategorized] : []),
            ...categories.filter(category => category !== uncategorized),
        ];
        if (!all.includes(this.libraryActiveCategory)) this.libraryActiveCategory = "All";
        const fragment = document.createDocumentFragment();
        for (const category of all) {
            const btn = document.createElement('button');
            btn.className = 'vnccs-ps-library-category-chip';
            if (category === this.libraryActiveCategory) btn.classList.add('active');
            btn.textContent = category;
            btn.onclick = () => {
                this.libraryActiveCategory = category;
                this.renderLibrary();
            };
            fragment.appendChild(btn);
        }
        const manage = document.createElement("button");
        manage.className = "vnccs-ps-library-category-chip";
        manage.textContent = xzgTh("设置分类", "Manage categories");
        manage.setAttribute("aria-label", xzgTh("分类管理", "Manage categories"));
        manage.title = xzgTh("新增或移除分类", "Add or remove categories");
        manage.style.color = "#e4bc59";
        manage.onclick = () => this.showLibraryCategoryManager();
        fragment.appendChild(manage);
        this.libraryCategoriesEl.replaceChildren(fragment);
    }

    renderLibrary() {
        if (!this.libraryGrid) {
            this.libraryGrid = document.querySelector('.vnccs-ps-library-modal-grid');
        }
        if (!this.libraryGrid) return;

        this.renderLibraryCategories();
        this.libraryGrid.innerHTML = '';
        const filtered = this.getFilteredLibraryPoses();

        if ((this.libraryPoses || []).length === 0) {
            this.libraryGrid.innerHTML = '<div class="vnccs-ps-library-empty">No saved poses.<br>Use Add to Pose Library to add one.</div>';
            this.renderLibraryInspector(null);
            return;
        }
        if (filtered.length === 0) {
            this.libraryGrid.innerHTML = '<div class="vnccs-ps-library-empty">No library items match this search.</div>';
            this.renderLibraryInspector(null);
            return;
        }

        if (this.librarySelectedName && !filtered.some(pose => this.getLibraryPoseId(pose) === this.librarySelectedName)) {
            this.librarySelectedName = null;
        }

        const fragment = document.createDocumentFragment();
        for (const pose of filtered) {
            const item = document.createElement('div');
            item.className = 'vnccs-ps-library-item';
            item.dataset.poseId = this.getLibraryPoseId(pose);
            item.tabIndex = 0;
            item.setAttribute('role', 'button');
            item.setAttribute('aria-pressed', String(this.getLibraryPoseId(pose) === this.librarySelectedName));
            if (this.getLibraryPoseId(pose) === this.librarySelectedName) item.classList.add('selected');

            const preview = document.createElement('div');
            preview.className = 'vnccs-ps-library-item-preview';
            if (pose.has_preview) {
                const previewUrl = this.getLibraryPreviewUrl(pose);
                preview.innerHTML = `<img src="${previewUrl}" alt="${this.escapeHtml(pose.name)}" loading="lazy" decoding="async">`;
            } else {
                preview.innerHTML = '<span>🦴</span>';
            }

            const name = document.createElement('div');
            name.className = 'vnccs-ps-library-item-name';
            name.innerText = pose.name;

            item.onclick = () => this.selectLibraryPose(pose);
            item.addEventListener('dblclick', async event => {
                event.preventDefault();
                event.stopPropagation();
                const closeLibraryModal = this._closeLibraryModal;
                await this.loadFromLibrary(pose);
                closeLibraryModal?.();
            });
            item.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                this.selectLibraryPose(pose);
            });

            item.appendChild(preview);
            item.appendChild(name);
            translatePoseStudioSubtree(item, app);
            fragment.appendChild(item);
        }
        this.libraryGrid.appendChild(fragment);

        const selected = (this.libraryPoses || []).find(pose => this.getLibraryPoseId(pose) === this.librarySelectedName) || null;
        this.renderLibraryInspector(selected);
    }

    selectLibraryPose(pose) {
        this.librarySelectedName = this.getLibraryPoseId(pose);
        if (this.libraryApplyButton) this.libraryApplyButton.disabled = false;
        this.libraryGrid?.querySelectorAll('.vnccs-ps-library-item').forEach((item) => {
            const selected = item.dataset.poseId === this.librarySelectedName;
            item.classList.toggle('selected', selected);
            item.setAttribute('aria-pressed', String(selected));
        });
        this.renderLibraryInspector(pose);
    }

    async renderLibraryInspector(pose) {
        if (!this.libraryInspector) return;
        const token = this._libraryInspectorLoadToken = (this._libraryInspectorLoadToken || 0) + 1;
        if (!pose) {
            if (this.libraryApplyButton) this.libraryApplyButton.disabled = true;
            this.libraryInspector.innerHTML = '<div class="vnccs-ps-library-inspector-empty">Select a pose to preview and edit it.</div>';
            this.updateLibraryInspectorScale();
            return;
        }
        if (!pose.data) {
            this.libraryInspector.textContent = "Loading library item...";
            try {
                const response = await fetch(`/vnccs/pose_library/get/${encodeURIComponent(pose.name)}${this.getLibraryPoseQuery(pose)}`);
                const result = await response.json();
                if (token !== this._libraryInspectorLoadToken || this._disposed) return;
                if (!response.ok || !result.pose || typeof result.pose !== "object") {
                    throw new Error(result.error || "Library item could not be loaded.");
                }
                pose.data = result.pose;
            } catch (error) {
                if (token === this._libraryInspectorLoadToken && !this._disposed) {
                    this.libraryInspector.textContent = `Failed to load library item: ${error?.message || error}`;
                }
                return;
            }
        }
        const meta = this.getLibraryPoseMeta(pose);
        const localCopy = meta.repository !== "local_user_poses";
        this.libraryInspector.innerHTML = `
            <div class="vnccs-ps-library-inspector-inner">
                <div class="vnccs-ps-library-inspector-actions">
                    <button class="vnccs-ps-btn danger vnccs-ps-library-delete">Delete</button>
                    <button class="vnccs-ps-btn primary vnccs-ps-library-save-edit">${localCopy ? "Save Local Copy" : "Save Changes"}</button>
                </div>
                <label class="vnccs-ps-library-field">
                    <span>Name</span>
                    <input class="vnccs-ps-input vnccs-ps-library-edit-name" type="text" value="${this.escapeHtml(pose.name)}">
                </label>
                <label class="vnccs-ps-library-field">
                    <span>Category</span>
                    <select class="vnccs-ps-input vnccs-ps-library-edit-category">${this.libraryCategoryOptions(meta.category)}</select>
                </label>
                <label class="vnccs-ps-library-field">
                    <span>Tags</span>
                    <input class="vnccs-ps-input vnccs-ps-library-edit-tags" type="text" value="${this.escapeHtml(meta.tags.join(', '))}" placeholder="standing, hands, portrait">
                </label>
                <div class="vnccs-ps-library-field">
                    <span>Custom Thumbnail</span>
                    <div class="vnccs-ps-library-thumbnail-upload">
                        <button type="button" class="vnccs-ps-btn primary vnccs-ps-library-thumbnail-pick">${xzgTh("上传缩略图", "Upload thumbnail")}</button>
                        <span class="vnccs-ps-library-thumbnail-name">${xzgTh("未选择文件", "No file selected")}</span>
                        <input class="vnccs-ps-library-preview-input" type="file" accept="image/*">
                    </div>
                </div>
            </div>
        `;
        requestAnimationFrame(() => this.updateLibraryInspectorScale());

        let pendingPreview = null;
        const closeLibraryModal = this._closeLibraryModal;
        this.libraryInspector.querySelector('.vnccs-ps-library-delete').onclick = () => this.showDeleteConfirmModal(pose);
        const thumbnailInput = this.libraryInspector.querySelector('.vnccs-ps-library-preview-input');
        const thumbnailName = this.libraryInspector.querySelector('.vnccs-ps-library-thumbnail-name');
        this.libraryInspector.querySelector('.vnccs-ps-library-thumbnail-pick').onclick = () => thumbnailInput.click();
        thumbnailInput.onchange = async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            thumbnailName.textContent = file.name;
            thumbnailName.title = file.name;
            try {
                pendingPreview = await this.compressLibraryImage(file);
            } catch (error) {
                pendingPreview = null;
                event.target.value = "";
                thumbnailName.textContent = xzgTh("未选择文件", "No file selected");
                thumbnailName.removeAttribute("title");
                this.showMessage(error?.message || String(error), true);
            }
        };
        this.libraryInspector.querySelector('.vnccs-ps-library-save-edit').onclick = async () => {
            const newName = this.libraryInspector.querySelector('.vnccs-ps-library-edit-name').value.trim();
            const category = this.libraryInspector.querySelector('.vnccs-ps-library-edit-category').value.trim() || "Uncategorized";
            const tags = this.libraryInspector.querySelector('.vnccs-ps-library-edit-tags').value
                .split(',')
                .map(tag => tag.trim())
                .filter(Boolean);
            if (!newName) {
                this.showMessage("Pose name is required.", true);
                return;
            }
            const updatedPoseData = typeof structuredClone === "function"
                ? structuredClone(pose.data || {})
                : JSON.parse(JSON.stringify(pose.data || {}));
            delete updatedPoseData.prompt;
            try {
                const result = await this.saveLibraryPoseRecord({
                    oldName: pose.name,
                    oldRepository: meta.repository,
                    oldCategory: meta.sourceCategory,
                    name: newName,
                    pose: updatedPoseData,
                    repository: "local_user_poses",
                    category,
                    tags,
                    preview: pendingPreview,
                });
                this.librarySelectedName = result.id || `local_user_poses/${category}/${newName}`;
                await this.refreshLibrary(false);
            } catch (error) {
                this.showMessage(`Failed to save library item: ${error?.message || error}`, true);
            }
        };
    }

    escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    compressLibraryImage(fileOrDataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const maxSide = 768;
                const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                let dataUrl;
                try {
                    dataUrl = canvas.toDataURL('image/webp', 0.76);
                } catch (_err) {
                    dataUrl = canvas.toDataURL('image/jpeg', 0.78);
                }
                if (!dataUrl || dataUrl === 'data:,') dataUrl = canvas.toDataURL('image/jpeg', 0.78);
                resolve(dataUrl);
            };
            img.onerror = reject;
            if (typeof fileOrDataUrl === 'string') {
                img.src = fileOrDataUrl;
            } else {
                const reader = new FileReader();
                reader.onload = () => { img.src = reader.result; };
                reader.onerror = reject;
                reader.readAsDataURL(fileOrDataUrl);
            }
        });
    }

    hasPoseToSave() {
        const poseHasMotion = pose => {
            if (!pose || typeof pose !== "object") return false;
            if (Object.values(pose.bones || {}).some(rotation =>
                Array.isArray(rotation) && rotation.slice(0, 3).some(value => Math.abs(Number(value) || 0) > 1e-3))) return true;
            if (Array.isArray(pose.modelRotation) && pose.modelRotation.some(value => Math.abs(Number(value) || 0) > 1e-3)) return true;
            for (const [name, position] of Object.entries(pose.bonePositions || {})) {
                if (!Array.isArray(position) || position.length < 3) continue;
                const rest = this.viewer?.shapedBoneRestPositions?.[name]
                    || this.viewer?.initialBoneStates?.[name]?.position;
                if (!rest) return true;
                if (Math.hypot(position[0] - rest.x, position[1] - rest.y, position[2] - rest.z) > 1e-4) return true;
            }
            return false;
        };
        const defaultMeshParams = {
            age: 25,
            gender: 0.5,
            weight: 0.5,
            muscle: 0.5,
            height: 0.5,
            breast_size: 0.5,
            firmness: 0.5,
            show_genitals: false,
            penis_len: 0.5,
            penis_circ: 0.5,
            penis_test: 0.5,
            ...DEFAULT_POSE_STUDIO_MESH_PROPORTIONS,
        };
        const meshHasChanges = mesh => Object.entries(defaultMeshParams).some(([key, defaultValue]) => {
            const value = mesh?.[key];
            if (value === undefined || value === null) return false;
            if (typeof defaultValue === "boolean") return value !== defaultValue;
            const numericValue = Number(value);
            return Number.isFinite(numericValue) && Math.abs(numericValue - defaultValue) > 1e-4;
        });
        const livePose = this.viewer?.getPose?.();
        if (poseHasMotion(livePose)) return true;
        const active = this.getActiveCharacter();
        if (meshHasChanges(this.meshParams) || (active && meshHasChanges(active.mesh))) return true;
        return (this.characters || []).some(character =>
            meshHasChanges(character.mesh) || (character.poses || []).some(poseHasMotion));
    }

    showSaveToLibraryModal() {
        if (!this.hasPoseToSave()) {
            this.showMessage(xzgTh("当前没有可保存的姿势或人物参数，请先调整姿势、年龄或身材比例。", "There is no pose or character change to save yet. Adjust the pose, age, or body proportions first."), true);
            return;
        }
        this._activeSaveLibraryClose?.(true);
        const dialogId = `vnccs-save-library-${VNCCS_MODAL_SEQUENCE++}`;
        const previousFocus = document.activeElement;
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay';
        overlay.setAttribute('role', 'presentation');

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-modal vnccs-ps-save-library-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', `${dialogId}-title`);
        modal.innerHTML = `
            <div class="vnccs-ps-modal-title" id="${dialogId}-title">${xzgTh("保存姿势场景", "Save Scene")}</div>
            <div class="vnccs-ps-modal-content">
                <label class="vnccs-ps-save-library-field vnccs-ps-save-library-name-field">
                    <span>Name</span>
                    <input data-role="name" type="text" placeholder="${xzgTh("姿势场景名称", "Scene name")}" class="vnccs-ps-input" maxlength="96" autocomplete="off">
                    <span class="vnccs-ps-save-library-error" hidden>${xzgTh("名称不能为空。", "Name is required.")}</span>
                </label>
                <div class="vnccs-ps-save-library-meta">
                    <label class="vnccs-ps-save-library-field">
                        <span>Category</span>
                        <select data-role="category" class="vnccs-ps-input">${this.libraryCategoryOptions()}</select>
                    </label>
                    <label class="vnccs-ps-save-library-field">
                        <span>Tags</span>
                        <input data-role="tags" type="text" placeholder="Comma separated" class="vnccs-ps-input" autocomplete="off">
                    </label>
                </div>
                <div class="vnccs-ps-save-library-field">
                    <button data-role="thumbnail-pick" type="button" class="vnccs-ps-btn primary vnccs-ps-library-thumbnail-pick">${xzgTh("上传缩略图", "Upload thumbnail")}</button>
                    <input data-role="thumbnail" type="file" accept="image/*" hidden style="display:none">
                </div>
                <img data-role="thumbnail-preview" alt="" hidden style="display:none;width:100%;max-height:140px;object-fit:contain;border-radius:6px;">
            </div>
            <div class="vnccs-ps-save-library-actions">
                <button type="button" class="vnccs-ps-modal-btn cancel">Cancel</button>
                <button type="button" class="vnccs-ps-modal-btn primary">Save</button>
            </div>
        `;

        const nameField = modal.querySelector('.vnccs-ps-save-library-name-field');
        const nameError = modal.querySelector('.vnccs-ps-save-library-error');
        const nameInput = modal.querySelector('[data-role="name"]');
        const categoryInput = modal.querySelector('[data-role="category"]');
        const tagsInput = modal.querySelector('[data-role="tags"]');
        const thumbnailInput = modal.querySelector('[data-role="thumbnail"]');
        const thumbnailPreview = modal.querySelector('[data-role="thumbnail-preview"]');
        const thumbnailPick = modal.querySelector('[data-role="thumbnail-pick"]');
        thumbnailPick.onclick = () => thumbnailInput.click();
        let customPreview = null;
        let thumbnailReadToken = 0;
        let thumbnailLoading = false;
        thumbnailInput.onchange = async () => {
            const token = ++thumbnailReadToken;
            const file = thumbnailInput.files?.[0];
            if (!file) return;
            thumbnailLoading = true;
            saveButton.disabled = true;
            try {
                const preview = await this.compressLibraryImage(file);
                if (closed || token !== thumbnailReadToken) return;
                customPreview = preview;
                thumbnailPreview.src = preview;
                thumbnailPreview.hidden = false;
                thumbnailPreview.style.display = "block";
            } catch (error) {
                if (!closed && token === thumbnailReadToken) {
                    thumbnailInput.value = "";
                    this.showMessage(`${xzgTh("读取缩略预览图失败", "Could not read thumbnail image")}: ${error?.message || error}`, true);
                }
            } finally {
                if (token === thumbnailReadToken) {
                    thumbnailLoading = false;
                    if (!closed && !saving) saveButton.disabled = false;
                }
            }
        };
        const saveButton = modal.querySelector('.vnccs-ps-modal-btn.primary');
        const cancelButton = modal.querySelector('.vnccs-ps-modal-btn.cancel');

        let closed = false;
        let saving = false;
        const close = (force = false) => {
            if (closed || (saving && !force)) return;
            closed = true;
            document.removeEventListener('keydown', onKeyDown);
            if (this._activeSaveLibraryOverlay === overlay) {
                this._activeSaveLibraryOverlay = null;
                this._activeSaveLibraryClose = null;
            }
            overlay.remove();
            if (previousFocus?.isConnected) previousFocus.focus?.();
        };
        const focusableElements = () => Array.from(modal.querySelectorAll(
            'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)',
        ));
        const onKeyDown = event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
                return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                saveButton.click();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = focusableElements();
            if (!focusable.length) return;
            const activeIndex = focusable.indexOf(document.activeElement);
            const nextIndex = event.shiftKey
                ? (activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1)
                : (activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1);
            event.preventDefault();
            focusable[nextIndex].focus();
        };
        document.addEventListener('keydown', onKeyDown);

        nameInput.addEventListener('input', () => {
            nameField.classList.remove('invalid');
            nameError.hidden = true;
            nameError.textContent = xzgTh("名称不能为空。", "Name is required.");
        });

        saveButton.onclick = async () => {
            if (saving || thumbnailLoading || closed) return;
            const name = nameInput.value.trim();
            if (!name) {
                nameField.classList.add('invalid');
                nameError.hidden = false;
                nameInput.focus();
                return;
            }
            const saveButtonLabel = saveButton.textContent;
            saving = true;
            saveButton.disabled = true;
            cancelButton.disabled = true;
            thumbnailInput.disabled = true;
            thumbnailPick.disabled = true;
            saveButton.textContent = xzgTh("正在保存……", "Saving…");
            try {
                const saved = await this.saveToLibrary(name, true, {
                    category: categoryInput.value.trim() || "Uncategorized",
                    tags: tagsInput.value.split(',').map(tag => tag.trim()).filter(Boolean),
                    preview: customPreview,
                    onError: error => {
                        const message = String(error?.message || "");
                        const duplicate = error?.code === "DUPLICATE_NAME"
                            || error?.status === 409
                            || /duplicate|already exists|same name|同名|名称.{0,8}(重复|存在)|已存在/i.test(message);
                        if (!duplicate) return false;
                        nameField.classList.add('invalid');
                        nameError.textContent = xzgTh("该名称已存在，请使用其他名称。", "This name already exists. Choose another name.");
                        nameError.hidden = false;
                        nameInput.focus();
                        nameInput.select();
                        return true;
                    },
                });
                if (saved) close(true);
            } finally {
                saving = false;
                if (!closed) {
                    saveButton.disabled = false;
                    cancelButton.disabled = false;
                    thumbnailInput.disabled = false;
                    thumbnailPick.disabled = false;
                    saveButton.textContent = saveButtonLabel;
                }
            }
        };

        cancelButton.onclick = () => close();
        overlay.onclick = event => { if (event.target === overlay) close(); };

        overlay.appendChild(modal);
        this._activeSaveLibraryOverlay = overlay;
        this._activeSaveLibraryClose = close;
        this.container.appendChild(overlay);
        requestAnimationFrame(() => nameInput.focus());
    }

    async saveLibraryPoseRecord({ oldName = "", oldRepository = "", oldCategory = "", name, pose, repository = "local_user_poses", category = "Uncategorized", tags = [], preview = null }) {
        const response = await fetch('/vnccs/pose_library/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                old_name: oldName,
                old_repository: oldRepository,
                old_category: oldCategory,
                name,
                pose,
                repository,
                preview,
                category,
                tags,
            })
        });
        const result = await response.json().catch(() => ({}));
        if (result?.duplicate || result?.code === "DUPLICATE_NAME") {
            const error = new Error(result?.error || result?.message || "Duplicate pose name");
            error.code = "DUPLICATE_NAME";
            error.status = response.status;
            throw error;
        }
        if (!response.ok) {
            const error = new Error(result?.error || result?.message || `HTTP ${response.status}`);
            error.status = response.status;
            error.code = result?.code;
            throw error;
        }
        return result;
    }

    async saveToLibrary(name, includePreview = true, metadata = {}) {
        if (!this.viewer) return false;
        if (!this.hasPoseToSave()) {
            this.showMessage(xzgTh("当前没有可保存的姿势或人物参数，请先调整姿势、年龄或身材比例。", "There is no pose or character change to save yet. Adjust the pose, age, or body proportions first."), true);
            return false;
        }
        let preview = null;
        try {
            this.captureActiveCharacterRuntime();
            const savedSAMProjection = (
                this._samCameraModeActive && this._samCamDisplayActive
            ) ? normalizeSAMProjectionFrame(this._samCamStoredProjectionFrame) : null;
            const sceneCharacters = this.characters.map(character => {
                this.ensureCharacterRuntime(character);
                const serialized = serializePoseStudioCharacter(character);
                const selectedPose = serialized.poses[this.activeTab] || serialized.poses[0] || {};
                serialized.poses = [selectedPose];
                return serialized;
            });
            const pose = this.stripSceneCameraFromPose(this.viewer.getPose());
            pose.cameraParams = this.currentCameraParams();
            if (savedSAMProjection) pose.sam_projection = JSON.parse(JSON.stringify(savedSAMProjection));
            const assetData = {
                ...pose,
                type: "scene_pose",
                schema_version: 3,
                active_character_id: this.activeCharacterId,
                characters: sceneCharacters,
                lights: JSON.parse(JSON.stringify(this.lightParams)),
                activeTab: 0,
                camera: {
                    yaw_deg: this.exportParams.cam_yaw_deg || 0,
                    roll_deg: this.exportParams.cam_roll_deg || 0,
                    pitch_deg: this.exportParams.cam_pitch_deg || 0,
                },
            };

            if (includePreview && metadata.preview) {
                preview = metadata.preview;
            } else if (includePreview) {
                this.updateCharacterScene({ poseIndex: this.activeTab });
                preview = this.viewer.capture(
                    this.exportParams.view_width,
                    this.exportParams.view_height,
                    1,
                    [0, 0, 0],
                    0,
                    0,
                    this.exportParams.cam_yaw_deg || 0,
                    this.exportParams.cam_pitch_deg || 0,
                    { roll_deg: this.exportParams.cam_roll_deg || 0, hideReference: true },
                );
                preview = await this.compressLibraryImage(preview);
            }

            const result = await this.saveLibraryPoseRecord({
                name,
                pose: assetData,
                preview,
                repository: "local_user_poses",
                category: metadata.category || "Uncategorized",
                tags: metadata.tags || [],
            });
            this.librarySelectedName = result.id || `local_user_poses/${metadata.category || "Uncategorized"}/${name}`;
            this.refreshLibrary(false);
            return true;
        } catch (err) {
            console.error("Failed to save pose:", err);
            if (metadata.onError?.(err) !== true) {
                this.showMessage(`Failed to save pose: ${err?.message || err}`, true);
            }
            return false;
        }
    }
    applyLibraryPoseFraming(cameraParams, { centerInFrame = false } = {}) {
        if (!this.viewer?.sceneCameraTarget) {
            throw new Error("Cannot apply pose framing before the model camera target is ready.");
        }
        const transform = cameraFramingToCharacterTransform(
            cameraParams,
            this.viewer.sceneCameraTarget,
        );
        this.applyLibraryPoseTransform(transform, cameraParams, { centerInFrame });
    }

    applyLibraryPoseTransform(transformSource, cameraParams = {}, { centerInFrame = false } = {}) {
        const character = this.getActiveCharacter();
        if (!character) throw new Error("Cannot apply pose transform without an active character.");
        const transform = normalizeCharacterTransform(transformSource);
        if (centerInFrame) {
            transform.x = 0;
            const frameCenteredY = this.viewer?.getFrameCenteredCharacterY?.(transform.zoom);
            if (Number.isFinite(frameCenteredY)) transform.y = frameCenteredY;
            const backAlignedZ = this.viewer?.getBackAlignedCharacterZ?.(transform.zoom);
            if (Number.isFinite(backAlignedZ)) transform.z = backAlignedZ;
        }
        const yaw = Number(cameraParams.yaw_deg ?? 0);
        const pitch = Number(cameraParams.pitch_deg ?? 0);
        if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
            throw new TypeError("Pose framing requires finite camera angles.");
        }
        character.transform = transform;

        character.transform = transform;

        this.exportParams.cam_offset_x = transform.x;
        this.exportParams.cam_offset_y = transform.y;
        this.exportParams.cam_zoom = transform.zoom;
        this.exportParams.cam_yaw_deg = yaw;
        this.exportParams.cam_pitch_deg = pitch;
        this.persistActivePoseCameraParams();

        this.viewer.setActiveCharacterAppearance({
            color: character.color,
            transform,
        });
        this.syncCameraWidgets();
        this.applyCameraToViewer(true);
        this.viewer.setCameraParams(this.currentCameraParams());
    }

    applyLibrarySAMProjection(frameSource) {
        const frame = normalizeSAMProjectionFrame(frameSource);
        if (!frame) throw new TypeError("Library pose contains an invalid SAM projection camera.");
        const cameraParams = this.currentCameraParams();
        const storedParams = {
            cam_zoom: cameraParams.zoom,
            cam_offset_x: cameraParams.offset_x,
            cam_offset_y: cameraParams.offset_y,
            cam_yaw_deg: cameraParams.yaw_deg,
            cam_pitch_deg: cameraParams.pitch_deg,
        };
        this._samCamPreParams = { ...storedParams };
        this._samCamStoredParams = { ...storedParams };
        this._samCamStoredProjectionFrame = frame;
        this._samCameraModeActive = true;
        this._samCamBannerVisible = true;
        this._samCamDisplayActive = true;
        this.viewer.setSAMProjectionCameraFrame(frame);
        this._updateSAMCameraBanner();
        this.applyCameraToViewer(true);
        this.viewer.setCameraParams(this.currentCameraParams());
    }

    async loadCharacterSceneLibraryAsset(asset) {
        if (!asset || !Array.isArray(asset.characters) || !asset.characters.length) {
            throw new Error("Library scene does not contain characters.");
        }
        const token = this._libraryLoadToken;
        const restoreToken = this._poseDataRestoreToken;
        if (this._sceneModelHydrationPromise) await this._sceneModelHydrationPromise;
        if (this._disposed || token !== this._libraryLoadToken || restoreToken !== this._poseDataRestoreToken) return;
        this._poseDataRestoreError = null;
        this._pendingMorphSolve = null;
        ++this._morphSeq;
        this.clearSAMCameraMode();
        this.captureActiveCharacterRuntime();

        const normalized = normalizePoseStudioCharacters(asset, { mesh: this.meshParams });
        if (this.characters.length + normalized.characters.length > MAX_POSE_STUDIO_CHARACTERS) {
            throw new Error("角色槽位不足，无法添加此姿势库场景。");
        }
        const importedActiveId = normalized.activeCharacterId;
        this.viewer?.resetJointSelectionLock?.();
        for (const character of normalized.characters) {
            const originalId = character.id;
            character.id = nextCharacterId(this.characters);
            character.slot = nextCharacterSlot(this.characters);
            character.color = nextCharacterColor(this.characters);
            this.characters.push(character);
            if (originalId === importedActiveId) this.activeCharacterId = character.id;
        }
        this._selectedCharacterIds = new Set([this.activeCharacterId]);
        this.characters.sort((left, right) => left.slot - right.slot);
        const poseCount = Math.max(1, ...this.characters.map(character => character.poses.length));
        for (const character of this.characters) {
            while (character.poses.length < poseCount) character.poses.push({});
        }
        const active = this.getActiveCharacter();
        this.activeTab = Math.max(0, Math.min(
            Math.floor(Number(asset.activeTab) || 0),
            Math.max(0, (active?.poses?.length || 1) - 1),
        ));
        this.meshParams = active.mesh;
        this.poses = active.poses;
        this.exportParams.cam_offset_x = active.transform.x;
        this.exportParams.cam_offset_y = active.transform.y;
        this.exportParams.cam_zoom = active.transform.zoom;
        if (asset.camera && typeof asset.camera === "object") {
            this.exportParams.cam_yaw_deg = Number(asset.camera.yaw_deg) || 0;
            this.exportParams.cam_pitch_deg = Number(asset.camera.pitch_deg) || 0;
        }
        this.ensurePoseCameraParams();
        this.restoreActivePoseCameraParams({ updateViewer: false });

        const characters = this.characters;
        await this.hydrateCharacterSceneModels({ showOverlay: true, recenterViewport: false });
        if (this._disposed || token !== this._libraryLoadToken || characters !== this.characters || restoreToken !== this._poseDataRestoreToken) return;
        this.viewer?.setPose?.(this.poses[this.activeTab] || {}, true);
        this.updateCharacterScene({ poseIndex: this.activeTab });
        this.updateTabs();
        this.syncCharacterEditorControls();
        this.renderCharactersUI();
        this.syncToNode(false, { skipCapture: true });
    }
    loadPoseSetAsset(asset) {
        const sourcePoses = Array.isArray(asset) ? asset : asset?.poses;
        if (!Array.isArray(sourcePoses) || !sourcePoses.length) {
            throw new Error("Pose set does not contain poses.");
        }
        this._poseDataRestoreError = null;

        
        this.clearSAMCameraMode();
        const activeCharacter = this.getActiveCharacter();
        this.poses = sourcePoses.map(sourcePose => {
            const pose = JSON.parse(JSON.stringify(sourcePose || {}));
            const savedCamera = pose.cameraParams;
            this.stripSceneCameraFromPose(pose);
            pose.cameraParams = resolveCaptureCameraParams(
                savedCamera,
                this.currentCameraParams(),
            );
            return pose;
        });
        if (activeCharacter) activeCharacter.poses = this.poses;
        for (const character of this.characters) {
            if (character === activeCharacter) continue;
            if (!Array.isArray(character.poses)) character.poses = [];
            while (character.poses.length < this.poses.length) character.poses.push({});
        }
        const poseCount = Math.max(this.poses.length, ...this.characters.map(character => character.poses.length));
        for (const character of this.characters) {
            while (character.poses.length < poseCount) character.poses.push({});
        }
        this.poseCaptures = [];
        this.activeTab = 0;
        this.ensurePoseCameraParams();
        this.restoreActivePoseCameraParams({ updateViewer: false });
        this.updateTabs();
        if (this.viewer?.isInitialized?.()) {
            this.viewer.setPose(this.poses[0], true);
            this.updateCharacterScene({ poseIndex: 0 });
            this.updateRotationSliders();
        }
        this.updateCaptureCameraPreview();
        this.syncToNode(true);
    }

    async loadFromLibrary(poseOrName) {
        const token = this._libraryLoadToken = (this._libraryLoadToken || 0) + 1;
        const characterId = this.activeCharacterId;
        const tab = this.activeTab;
        const name = this.getLibraryPoseName(poseOrName);
        try {
            const res = await fetch(`/vnccs/pose_library/get/${encodeURIComponent(name)}${this.getLibraryPoseQuery(poseOrName)}`);
            const data = await res.json();
            if (this._disposed || token !== this._libraryLoadToken || characterId !== this.activeCharacterId || tab !== this.activeTab) return;
            if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            this.viewer?.resetJointSelectionLock?.();
            this.viewer?.recordState?.();

            if (!data.pose || !this.viewer) return;
            const isScene = Array.isArray(data.pose.characters) && data.pose.characters.length
                && data.pose.type !== "pose_set";
            if (!isScene) {
                const added = await this.addCharacter(null, { rebuildScene: false });
                if (!added) throw new Error("无法新增角色，请检查角色槽位是否已满或正在切换角色。");
                if (this._disposed || token !== this._libraryLoadToken) return;
            }
            this.clearSAMCameraMode();
            if (Array.isArray(data.pose.lights)) {
                this.lightParams = this.normalizeUserLights(data.pose.lights);
                this.refreshLightUI();
                this.applyLighting();
            }
            if (data.pose?.type === "pose_set" && Array.isArray(data.pose.poses)) {
                this.loadPoseSetAsset(data.pose);
            } else if (Array.isArray(data.pose.characters) && data.pose.characters.length) {
                await this.loadCharacterSceneLibraryAsset(data.pose);
            } else {
                const activeScenePose = extractActivePoseFromSceneAsset(data.pose);
                const activeSceneTransform = activeScenePose
                    ? extractActiveCharacterTransformFromSceneAsset(data.pose)
                    : null;
                const poseSource = JSON.parse(JSON.stringify(activeScenePose || data.pose));
                const savedFraming = poseSource.cameraParams && typeof poseSource.cameraParams === "object"
                    ? { ...poseSource.cameraParams }
                    : null;
                const savedSAMProjection = normalizeSAMProjectionFrame(
                    poseSource.sam_projection
                    ?? data.pose?.sam_projection
                    ?? data.pose?.camera?.sam_projection,
                );
                const savedAngles = {
                    yaw_deg: savedFraming?.yaw_deg ?? data.pose?.camera?.yaw_deg ?? 0,
                    pitch_deg: savedFraming?.pitch_deg ?? data.pose?.camera?.pitch_deg ?? 0,
                };
                const pose = this.stripSceneCameraFromPose(poseSource);
                this.viewer.setPose(pose, true);
                if (this.host?.embedded !== true) {
                    if (activeSceneTransform) this.applyLibraryPoseTransform(activeSceneTransform, savedAngles, { centerInFrame: true });
                    else if (savedFraming) this.applyLibraryPoseFraming(savedFraming, { centerInFrame: true });
                    if (savedSAMProjection) this.applyLibrarySAMProjection(savedSAMProjection);
                }
                this.updateRotationSliders();
                this.commitViewerPoseToCurrentEditor();
            }
        } catch (err) {
            if (this._disposed || token !== this._libraryLoadToken) return;
            console.error("Failed to load pose:", err);
            this.showMessage(`Failed to load pose: ${err?.message || err}`, true);
        }
    }
    showMessage(text, isError = false) {
        const modelDownloadUrl = "https://pan.quark.cn/s/9a332350f6fc";
        const missingModel = String(text).includes(modelDownloadUrl);
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay';
        if (missingModel) {
            Object.assign(overlay.style, { position: "fixed", inset: "0", zIndex: "2147483647" });
        }

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-modal';
        modal.style.maxWidth = missingModel ? "560px" : "300px";

        const title = document.createElement('div');
        title.className = 'vnccs-ps-modal-title';
        title.textContent = isError ? '⚠️ Error' : 'ℹ️ Information';

        const content = document.createElement('div');
        content.className = 'vnccs-ps-modal-content';
        content.style.textAlign = 'center';
        content.textContent = text;
        if (missingModel) {
            title.textContent = "缺少识别模型";
            content.style.whiteSpace = "pre-wrap";
            content.style.overflowWrap = "anywhere";
            const parts = String(text).split(modelDownloadUrl);
            content.replaceChildren(document.createTextNode(parts[0]));
            for (const part of parts.slice(1)) {
                const link = document.createElement("a");
                link.href = modelDownloadUrl;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.textContent = modelDownloadUrl;
                link.style.color = "#69dba6";
                link.style.textDecoration = "underline";
                content.append(link, document.createTextNode(part));
            }
        }

        const okBtn = document.createElement('button');
        okBtn.className = 'vnccs-ps-modal-btn';
        okBtn.style.justifyContent = 'center';
        okBtn.textContent = 'OK';
        okBtn.onclick = () => overlay.remove();

        modal.appendChild(title);
        modal.appendChild(content);
        modal.appendChild(okBtn);
        overlay.appendChild(modal);

        (missingModel ? document.body : this.canvasContainer).appendChild(overlay);
    }

    showDeleteConfirmModal(poseOrName) {
        const poseName = this.getLibraryPoseName(poseOrName);
        const itemType = "Pose";
        const overlay = document.createElement('div');
        overlay.className = 'vnccs-ps-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'vnccs-ps-modal';

        const title = document.createElement('div');
        title.className = 'vnccs-ps-modal-title';
        title.textContent = `⚠️ Delete ${itemType}`;

        const content = document.createElement('div');
        content.className = 'vnccs-ps-modal-content';
        content.style.textAlign = 'center';

        const message = document.createElement('div');
        message.innerHTML = `Delete ${itemType.toLowerCase()} "<strong>${this.escapeHtml(poseName)}</strong>"?<br>This cannot be undone.`;
        content.appendChild(message);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'vnccs-ps-modal-btn danger';
        deleteBtn.style.justifyContent = 'center';
        deleteBtn.textContent = '🗑️ Delete';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'vnccs-ps-modal-btn cancel';
        cancelBtn.textContent = 'Cancel';

        modal.appendChild(title);
        modal.appendChild(content);
        modal.appendChild(deleteBtn);
        modal.appendChild(cancelBtn);

        deleteBtn.onclick = () => {
            this.deleteFromLibrary(poseOrName);
            overlay.remove();
        };

        cancelBtn.onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        overlay.appendChild(modal);
        this.container.appendChild(overlay);
    }

    async deleteFromLibrary(poseOrName) {
        const name = this.getLibraryPoseName(poseOrName);
        const itemType = "pose";
        try {
            const response = await fetch(`/vnccs/pose_library/delete/${encodeURIComponent(name)}${this.getLibraryPoseQuery(poseOrName)}`, { method: 'DELETE' });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
            if (typeof poseOrName === 'string' && this.librarySelectedName === name) this.librarySelectedName = null;
            if (typeof poseOrName !== 'string' && this.librarySelectedName === this.getLibraryPoseId(poseOrName)) this.librarySelectedName = null;
            this.refreshLibrary(false);
        } catch (err) {
            console.error(`Failed to delete ${itemType}:`, err);
            this.showMessage(`Failed to delete ${itemType}: ${err?.message || err}`, true);
        }
    }

    modelDataFromMorphMessage(message) {
        const staticData = message?.staticData;
        const bonePositions = message?.bonePositions;
        if (!staticData || !bonePositions || !message?.vertices) {
            throw new Error("Pose Studio MakeHuman worker returned incomplete model data.");
        }
        const bones = (staticData.bones || []).map((bone, index) => {
            const offset = index * 6;
            const headPos = Array.from(bonePositions.subarray(offset, offset + 3));
            const tailPos = Array.from(bonePositions.subarray(offset + 3, offset + 6));
            const dx = tailPos[0] - headPos[0];
            const dy = tailPos[1] - headPos[1];
            const dz = tailPos[2] - headPos[2];
            return {
                name: bone.name,
                parent: bone.parent || null,
                headPos,
                tailPos,
                length: Math.hypot(dx, dy, dz),
            };
        });
        return {
            status: "success",
            vertices: message.vertices,
            uvs: staticData.uvs,
            indices: staticData.indices,
            bones,
            skinIndices: staticData.skinIndices,
            skinWeights: staticData.skinWeights,
            landmarks: message.landmarks || {},
            landmark_indices: message.landmarkIndices || {},
        };
    }

    requestStaticMorphModel() {
        const worker = this.ensureMorphWorker();
        if (!worker) return Promise.reject(new Error("Pose Studio MakeHuman worker is unavailable."));
        const seq = ++this._morphSeq;
        this._morphSeqCharacterIds.set(seq, this.activeCharacterId);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._morphLoadTasks.delete(seq);
                this._morphSeqCharacterIds.delete(seq);
                reject(new Error("Timed out while loading the Pose Studio MakeHuman asset."));
            }, 120000);
            this._morphLoadTasks.set(seq, { resolve, reject, timeout });
            try {
                worker.postMessage({
                    type: "solve",
                    seq,
                    clientId: this._morphClientId,
                    params: { ...this.meshParams },
                    includeStatic: true,
                });
            } catch (error) {
                clearTimeout(timeout);
                this._morphLoadTasks.delete(seq);
                this._morphSeqCharacterIds.delete(seq);
                reject(error);
            }
        });
    }

    applyMeshProportionsToViewer(mesh = this.meshParams) {
        if (!this.viewer) return;
        const value = (key, fallback) => {
            const number = Number(mesh?.[key]);
            return Number.isFinite(number) ? number : fallback;
        };
        this.viewer.headScale = value("head_size", 1);
        this.viewer.armScale = value("arm_size", 1);
        this.viewer.handScale = value("hand_size", 1);
        this.viewer.footScale = value("foot_size", 1);
        const legacyArm = value("arm_length", 0.5);
        const legacyUpperArm = value("upper_arm_length", legacyArm);
        const legacyForearm = value("forearm_length", legacyArm);
        const legacyLeg = value("leg_length", 0.5);
        const legacyThigh = value("thigh_length", legacyLeg);
        const legacyShin = value("shin_length", legacyLeg);
        this.viewer.boneLengthParams = {
            shoulder_l: value("shoulder_l_length", 0.5),
            shoulder_r: value("shoulder_r_length", 0.5),
            hip_l: value("hip_l_length", 0.5),
            hip_r: value("hip_r_length", 0.5),
            upper_arm_l: value("upper_arm_l_length", legacyUpperArm),
            upper_arm_r: value("upper_arm_r_length", legacyUpperArm),
            forearm_l: value("forearm_l_length", legacyForearm),
            forearm_r: value("forearm_r_length", legacyForearm),
            thigh_l: value("thigh_l_length", legacyThigh),
            thigh_r: value("thigh_r_length", legacyThigh),
            shin_l: value("shin_l_length", legacyShin),
            shin_r: value("shin_r_length", legacyShin),
            spine: value("spine_length", 0.5),
        };
    }

    loadModel(showOverlay = true, recenterViewport = true) {
        if (this._disposed) return Promise.resolve(false);
        const {
            invalidatePosePositions = false,
            updateScene = true,
        } = arguments[2] || {};
        const requestedCharacterId = String(this.activeCharacterId || "");
        const requestedMeshSignature = JSON.stringify(this.meshParams || {});
        const requestKey = `${requestedCharacterId}\u0000${requestedMeshSignature}`;
        if (this._modelLoadPromise) {
            if (this._modelLoadKey === requestKey) return this._modelLoadPromise;
            return this._modelLoadPromise.catch(() => false).then(() => (
                this.loadModel(showOverlay, recenterViewport, {
                    invalidatePosePositions,
                    updateScene,
                })
            ));
        }
        this._modelLoadKey = requestKey;
        if (showOverlay && this.loadingOverlay) this.loadingOverlay.style.display = "flex";

        // Sync skin type to viewer before loading
        if (this.viewer) {
            this.viewer.setSkinTexture(this.skinType || "naked");
            this.applyMeshProportionsToViewer(this.meshParams);
        }

        const promise = this.requestStaticMorphModel().then((message) => {
            if (this._disposed) return false;
            const currentKey = `${String(this.activeCharacterId || "")}\u0000${JSON.stringify(this.meshParams || {})}`;
            if (currentKey !== requestKey) return false;
            const d = this.modelDataFromMorphMessage(message);
            if (this.viewer) {
                // Reload mesh data without implicit camera math; if we need a reset,
                // do the same explicit snap the Preview button uses.
                this.viewer.loadData(d, true);
                this.updateCaptureCameraPreview();

                if (invalidatePosePositions) {
                    // A deliberate body-shape edit can invalidate absolute IK
                    // positions. Identity switches and scene restore preserve them.
                    for (let i = 0; i < this.poses.length; i++) {
                        if (this.poses[i]) {
                            delete this.poses[i].hipBonePosition;
                            delete this.poses[i].bonePositions;
                            delete this.poses[i].ikEffectorPositions;
                            delete this.poses[i].poleTargetPositions;
                        }
                    }
                }

                // Apply pose immediately (no timeout/flicker)
                if (this.viewer.isInitialized()) {
                    this.viewer.setPose(this.poses[this.activeTab] || {}, true);
                    this.updateRotationSliders();

                    const activeCharacter = this.getActiveCharacter();
                    if (activeCharacter) {
                        this.viewer.setActiveCharacterAppearance({
                            color: activeCharacter.color,
                            transform: activeCharacter.transform,
                        });
                    }
                    if (updateScene) this.updateCharacterScene();

                    if (recenterViewport) {
                        this.applyCameraToViewer(true);
                        this.resetToMainView();
                    }

                    // Full recapture needed because mesh changed
                    if (!this._switchingCharacter && !this._hydratingCharacterScene) this.syncToNode(true);
                    // Static worker responses resolve through the load-request
                    // path and do not visit handleMorphWorkerMessage's live
                        }
            }
            return true;
        }).finally(() => {
            if (this._modelLoadPromise === promise) {
                this._modelLoadPromise = null;
                this._modelLoadKey = null;
            }
            if (this.loadingOverlay) this.loadingOverlay.style.display = "none";
        });
        this._modelLoadPromise = promise;
        return promise;
    }

    isLiveMorphKey(key) {
        return [
            "age", "gender", "weight", "muscle", "height",
            "breast_size", "firmness",
            "show_genitals", "penis_len", "penis_circ", "penis_test",
        ].includes(key);
    }

    ensureMorphWorker() {
        if (this._morphWorkerFailed) return null;
        if (this._morphWorker) return this._morphWorker;
        const worker = getVNCCSSharedMorphWorker();
        if (!worker) {
            this._morphWorkerFailed = true;
            return null;
        }

        if (!this._morphClientId) this._morphClientId = VNCCS_SHARED_MORPH_CLIENT_ID++;
        VNCCS_SHARED_MORPH_CLIENTS.set(this._morphClientId, (message) => this.handleMorphWorkerMessage(message));
        if (!VNCCS_SHARED_MORPH_WORKER_WARMED) {
            VNCCS_SHARED_MORPH_WORKER_WARMED = true;
            worker.postMessage({ type: "warmup", clientId: this._morphClientId });
        }
        this._morphWorker = worker;
        return this._morphWorker;
    }

    handleMorphWorkerMessage(message) {
        if (message.seq != null && !this._morphSeqCharacterIds.has(message.seq)) return;
        if (message.type === "error") {
            console.warn("[VNCCS PoseStudio] Live morph worker failed:", message.message);
            this._morphWorkerFailed = true;
            this._morphSolveInFlight = false;
            this._pendingMorphSolve = null;
            this._morphSeqCharacterIds.clear();
            for (const [seq, request] of this._morphLoadTasks) {
                clearTimeout(request.timeout);
                this._morphLoadTasks.delete(seq);
                request.reject(new Error(message.message || "Pose Studio MakeHuman worker failed."));
            }
            this.showMessage?.(`Pose Studio body update failed: ${message.message || "MakeHuman worker unavailable"}. Reload ComfyUI to retry.`, true);
            return;
        }
        if (message.type !== "result" || message.seq == null) return;
        const requestCharacterId = this._morphSeqCharacterIds.get(message.seq);
        this._morphSeqCharacterIds.delete(message.seq);
        const loadRequest = this._morphLoadTasks.get(message.seq);
        if (loadRequest) {
            clearTimeout(loadRequest.timeout);
            this._morphLoadTasks.delete(message.seq);
            this._lastAppliedMorphSeq = Math.max(this._lastAppliedMorphSeq, message.seq);
            loadRequest.resolve(message);
            this.flushPendingMorphSolve();
            return;
        }
        this._morphSolveInFlight = false;
        if (requestCharacterId && requestCharacterId !== this.activeCharacterId) {
            this.flushPendingMorphSolve();
            return;
        }
        const isLatest = message.seq > this._lastAppliedMorphSeq;
        // Display completed intermediate work during continuous input. A queued
        // request must not starve the viewport; older applied results never win.
        if (isLatest && this.viewer?.updateBodyVertices?.(
            message.vertices,
            message.bonePositions,
            message.landmarks,
            message.landmarkIndices,
            message.indices,
        )) {
            this._lastAppliedMorphSeq = message.seq;
            let ageFitChanged = false;
            let suppressAgeFitSync = false;
            if (this.pendingAgeCameraFit) {
                this.pendingAgeCameraFit = message.seq < this._morphSeq;
                suppressAgeFitSync = this._suppressNextAgeFitSync === true;
                this._suppressNextAgeFitSync = false;
                ageFitChanged = this.applyAgeCameraFit();
            }
            // Schedule only after AGE has rewritten every pose camera, and
            // always restart at card zero to keep one coherent generation.
            if (ageFitChanged && !suppressAgeFitSync) {
                this.syncToNode(false);
            }
        }
        this.flushPendingMorphSolve();
    }

    flushPendingMorphSolve() {
        if (this._morphSolveInFlight || !this._pendingMorphSolve || !this._morphWorker) return;
        const next = this._pendingMorphSolve;
        this._pendingMorphSolve = null;
        this._morphSolveInFlight = true;
        try {
            this._morphWorker.postMessage(next);
        } catch (error) {
            this._morphSolveInFlight = false;
            this._morphWorkerFailed = true;
            console.warn("[VNCCS PoseStudio] Failed to queue live morph:", error);
        }
    }

    requestLiveMorph(changedKey = null) {
        if (changedKey && !this.isLiveMorphKey(changedKey)) return false;
        const worker = this.ensureMorphWorker();
        if (!worker || !this.viewer?.isInitialized?.()) return false;
        const seq = ++this._morphSeq;
        if (this._pendingMorphSolve?.seq != null) {
            this._morphSeqCharacterIds.delete(this._pendingMorphSolve.seq);
        }
        this._morphSeqCharacterIds.set(seq, this.activeCharacterId);
        this._pendingMorphSolve = {
            type: "solve",
            seq,
            clientId: this._morphClientId,
            params: { ...this.meshParams },
        };
        this.flushPendingMorphSolve();
        return true;
    }

    queueFullMeshUpdate(changedKey = null) {
        if (changedKey === "age") {
            this.pendingAgeCameraFit = true;
        }

        this.pendingMeshUpdate = true;

        if (this.isMeshUpdating) return;
        this.isMeshUpdating = true;
        this.pendingMeshUpdate = false;

        // Keep the current viewport framing while rebuilding the mesh. In
        // particular, age edits should preserve the character's current pose
        // placement instead of snapping it back to the center.
        const preserveCurrentView = changedKey === "age" || changedKey === "show_genitals";
        this.loadModel(false, !preserveCurrentView, {
            // Genital visibility only changes mesh topology; the pose and
            // camera framing remain valid and should survive the rebuild.
            invalidatePosePositions: changedKey !== "show_genitals",
        }).finally(() => {
            const hasPendingMeshUpdate = this.pendingMeshUpdate;
            this.isMeshUpdating = false;
            if (hasPendingMeshUpdate) {
                this.queueFullMeshUpdate();
                return;
            }
            if (this.pendingAgeCameraFit) {
                this.pendingAgeCameraFit = false;
                const suppressAgeFitSync = this._suppressNextAgeFitSync === true;
                this._suppressNextAgeFitSync = false;
                if (this.applyAgeCameraFit()) {
                    if (!suppressAgeFitSync) {
                        this.syncToNode(false);
                    }
                }
            }
        });
    }

    processMeshUpdate() {
        if (this.isMeshUpdating) return;
        this.isMeshUpdating = true;
        this.pendingMeshUpdate = false;

        this.loadModel(true, true, { invalidatePosePositions: true }).finally(() => {
            this.isMeshUpdating = false;
            if (this.pendingMeshUpdate) {
                this.processMeshUpdate();
            }
        });
    }

    defaultLightParams() {
        return [
            { type: "directional", color: "#ffffff", intensity: 2, x: 27, y: 26, z: 10 },
            { type: "directional", color: "#ffffff", intensity: 1.3, x: -41, y: 100, z: -39 },
        ];
    }

    normalizeUserLights(lights) {
        if (!Array.isArray(lights)) return this.defaultLightParams();
        return lights
            .filter(light => light?.type === "directional")
            .map(light => ({ ...light, type: "directional" }));
    }

    createLightRadar(light, onPositionChange) {
        const size = 100;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        canvas.className = "vnccs-ps-light-radar-canvas";
        const ctx = canvas.getContext("2d");

        let isDragging = false;
        const range = (light.type === 'point') ? 10.0 : 100;

        const draw = () => {
            ctx.fillStyle = "#111";
            ctx.fillRect(0, 0, size, size);

            const cx = size / 2;
            const cy = size / 2;

            // Grid
            ctx.beginPath();
            ctx.strokeStyle = "#222";
            ctx.lineWidth = 1;
            ctx.moveTo(cx, 0); ctx.lineTo(cx, size);
            ctx.moveTo(0, cy); ctx.lineTo(size, cy);
            ctx.stroke();

            // Circles
            ctx.beginPath();
            ctx.strokeStyle = "#1a1a1a";
            ctx.arc(cx, cy, size / 4, 0, Math.PI * 2);
            ctx.arc(cx, cy, size / 2 - 2, 0, Math.PI * 2);
            ctx.stroke();

            // Dot (X and Z)
            const dotX = cx + ((light.x ?? 0) / range) * (size / 2);
            const dotY = cy + ((light.z ?? 5) / range) * (size / 2);
            const hex = this.parseColorToHex(light.color);

            // Shadow/Glow
            const grad = ctx.createRadialGradient(dotX, dotY, 2, dotX, dotY, 12);
            grad.addColorStop(0, hex + "66");
            grad.addColorStop(1, "transparent");
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(dotX, dotY, 12, 0, Math.PI * 2);
            ctx.fill();

            // Core
            ctx.beginPath();
            ctx.fillStyle = hex;
            ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 1;
            ctx.stroke();

            // Labels
            ctx.fillStyle = "#444";
            ctx.font = "8px monospace";
            ctx.textAlign = "center";
            ctx.fillText("BACK", cx, 10);
            ctx.fillText("FRONT", cx, size - 4);
        };

        const updateFromMouse = (e) => {
            const rect = canvas.getBoundingClientRect();
            const pointer = { x: (e.clientX - rect.left) * size / rect.width, y: (e.clientY - rect.top) * size / rect.height };
            const mouseX = pointer.x;
            const mouseY = pointer.y;
            const cx = size / 2;
            const cy = size / 2;

            let dx = (mouseX - cx);
            let dy = (mouseY - cy);

            const maxDrag = (size / 2) - 2;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > maxDrag) {
                dx *= maxDrag / dist;
                dy *= maxDrag / dist;
            }

            light.x = (dx / (size / 2)) * range;
            light.z = (dy / (size / 2)) * range;

            draw();
            onPositionChange?.();
            this.applyLighting();
        };

        canvas.addEventListener("pointerdown", (e) => {
            canvas.setPointerCapture(e.pointerId);
            isDragging = true;
            updateFromMouse(e);
        });

        canvas.addEventListener("pointermove", (e) => {
            if (isDragging) updateFromMouse(e);
        });

        canvas.addEventListener("pointerup", (e) => {
            if (isDragging) {
                if (canvas.hasPointerCapture(e.pointerId)) {
                    canvas.releasePointerCapture(e.pointerId);
                }
                isDragging = false;
                this.syncToNode(false, { skipCapture: true });
            }
        });

        canvas.addEventListener("pointercancel", () => { isDragging = false; });
        canvas.addEventListener("lostpointercapture", () => { isDragging = false; });
        draw();
        return canvas;
    }


    parseColorToHex(c) {
        if (!c) return "#ffffff";
        if (typeof c === 'string') return c.startsWith('#') ? c : "#ffffff";
        if (Array.isArray(c)) {
            const r = Math.round(c[0]).toString(16).padStart(2, '0');
            const g = Math.round(c[1]).toString(16).padStart(2, '0');
            const b = Math.round(c[2]).toString(16).padStart(2, '0');
            return `#${r}${g}${b}`;
        }
        return "#ffffff";
    }

    refreshLightUI() {
        if (!this.lightListContainer) return;
        this.lightListContainer.innerHTML = '';

        this.lightParams.forEach((light, index) => {
            const item = document.createElement('div');
            item.className = 'vnccs-ps-light-card';

            // --- Header ---
            const header = document.createElement('div');
            header.className = 'vnccs-ps-light-header';

            const title = document.createElement('span');
            title.className = 'vnccs-ps-light-title';

            // Icon
            let iconChar = '💡';
            if (light.type === 'directional') iconChar = '☀️';
            else if (light.type === 'ambient') iconChar = '☁️';

            title.innerHTML = `<span class="vnccs-ps-light-icon">${iconChar}</span> ${xzgTh("光源", "Light")} ${index + 1}`;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'vnccs-ps-light-remove';
            removeBtn.innerHTML = '×';
            removeBtn.title = xzgTh("移除光源", "Remove Light");
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                this.lightParams.splice(index, 1);
                this.refreshLightUI();
                this.applyLighting();
            };

            header.appendChild(title);
            header.appendChild(removeBtn);
            item.appendChild(header);

            // --- Body ---
            const body = document.createElement('div');
            body.className = 'vnccs-ps-light-body';

            // Grid 1: Type & Color
            const grid1 = document.createElement('div');
            grid1.className = 'vnccs-ps-light-grid';

            // Type
            const typeLabel = document.createElement('span');
            typeLabel.className = 'vnccs-ps-light-select';
            typeLabel.textContent = xzgTh("平行光", "Directional");
            grid1.appendChild(typeLabel);

            // Color
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.className = 'vnccs-ps-light-color';
            colorInput.value = this.parseColorToHex(light.color);
            colorInput.oninput = (e) => {
                light.color = colorInput.value;
                this.applyLighting();
            };
            grid1.appendChild(colorInput);
            body.appendChild(grid1);

            // Intensity
            const intensityRow = document.createElement('div');
            intensityRow.className = 'vnccs-ps-light-slider-row';

            const intLabel = document.createElement('span');
            intLabel.className = 'vnccs-ps-light-pos-label';
            intLabel.innerText = xzgTh("强度", "Int");

            const isAmbient = light.type === 'ambient';
            const intSlider = document.createElement('input');
            intSlider.type = 'range';
            intSlider.className = 'vnccs-ps-light-slider';
            intSlider.min = 0;
            intSlider.max = isAmbient ? 2 : 5;
            intSlider.step = isAmbient ? 0.01 : 0.1;
            intSlider.value = light.intensity ?? (isAmbient ? 0.5 : 1);

            const intValue = document.createElement('span');
            intValue.className = 'vnccs-ps-light-value';
            intValue.innerText = parseFloat(intSlider.value).toFixed(2);

            intSlider.oninput = () => {
                light.intensity = parseFloat(intSlider.value);
                intValue.innerText = light.intensity.toFixed(2);
                this.applyLighting();
            };

            intensityRow.appendChild(intLabel);
            intensityRow.appendChild(intSlider);
            intensityRow.appendChild(intValue);
            body.appendChild(intensityRow);

            // Radius Slider (Point Light Only)
            if (light.type === 'point') {
                const radiusRow = document.createElement('div');
                radiusRow.className = 'vnccs-ps-light-slider-row';

                const radLabel = document.createElement('span');
                radLabel.className = 'vnccs-ps-light-pos-label';
                radLabel.innerText = xzgTh("范围", "Rad");

                const radSlider = document.createElement('input');
                radSlider.type = 'range';
                radSlider.className = 'vnccs-ps-light-slider';
                radSlider.min = 5; radSlider.max = 300; radSlider.step = 1;
                radSlider.value = light.radius ?? 100;

                const radValue = document.createElement('span');
                radValue.className = 'vnccs-ps-light-value';
                radValue.innerText = radSlider.value;

                radSlider.oninput = () => {
                    light.radius = parseFloat(radSlider.value);
                    radValue.innerText = radSlider.value;
                    this.applyLighting();
                };

                radiusRow.appendChild(radLabel);
                radiusRow.appendChild(radSlider);
                radiusRow.appendChild(radValue);
                body.appendChild(radiusRow);
            }

            // Position Controls (if not Ambient)
            if (light.type !== 'ambient') {
                const radarWrap = document.createElement('div');
                radarWrap.className = 'vnccs-ps-light-radar-wrap';

                const radarMain = document.createElement('div');
                radarMain.className = 'vnccs-ps-light-radar-main';

                const angleReadout = document.createElement('div');
                angleReadout.className = 'vnccs-ps-light-angle-readout';
                angleReadout.title = xzgTh(
                    "方位角以人物正前方为 0°，向人物右侧递增；仰角相对水平面计算。",
                    "Azimuth starts at the character's front and increases toward their right; elevation is measured from the horizon."
                );
                const updateAngleReadout = () => {
                    const x = Number(light.x ?? 0);
                    const y = Number(light.y ?? 0);
                    const z = Number(light.z ?? 0);
                    const horizontal = Math.hypot(x, z);
                    const azimuth = horizontal < 0.5
                        ? "—"
                        : `${((Math.round(Math.atan2(x, z) * 180 / Math.PI) + 360) % 360)}°`;
                    const elevation = `${Math.round(Math.atan2(y, horizontal) * 180 / Math.PI)}°`;
                    angleReadout.replaceChildren();
                    const angles = document.createElement('span');
                    angles.textContent = `${xzgTh("方位", "Azimuth")} ${azimuth} · ${xzgTh("仰角", "Elevation")} ${elevation}`;
                    const plane = document.createElement('span');
                    plane.textContent = `X ${Math.round(x)} · Z ${Math.round(z)}`;
                    angleReadout.append(angles, plane);
                };
                updateAngleReadout();

                // Radar (X and Z - Top Down)
                const radar = this.createLightRadar(light, updateAngleReadout);
                radarMain.appendChild(radar);

                // Height Slider (Y) - Vertical
                const hVertWrap = document.createElement('div');
                hVertWrap.className = 'vnccs-ps-light-slider-vert-wrap';

                const hLabel = document.createElement('span');
                hLabel.className = 'vnccs-ps-light-h-label';
                hLabel.innerText = xzgTh("高度", "Y-HGT");

                const hVal = document.createElement('span');
                hVal.className = 'vnccs-ps-light-h-val';
                hVal.innerText = light.y || 0;

                const hSlider = document.createElement('input');
                hSlider.type = 'range';
                hSlider.className = 'vnccs-ps-light-slider-vert';
                hSlider.setAttribute('orient', 'vertical'); // Firefox support
                const isPoint = light.type === 'point';
                hSlider.min = isPoint ? -10 : -100;
                hSlider.max = isPoint ? 10 : 100;
                hSlider.step = isPoint ? 0.1 : 1;
                hSlider.value = light.y || 0;

                hSlider.oninput = () => {
                    light.y = parseFloat(hSlider.value);
                    hVal.innerText = hSlider.value;
                    updateAngleReadout();
                    this.applyLighting();
                };

                hVertWrap.appendChild(hVal);
                hVertWrap.appendChild(hSlider);
                hVertWrap.appendChild(hLabel);

                radarMain.appendChild(hVertWrap);
                radarWrap.appendChild(radarMain);
                radarWrap.appendChild(angleReadout);
                body.appendChild(radarWrap);
            }

            item.appendChild(body);
            this.lightListContainer.appendChild(item);
        });

        // Add Light Button (Big)
        const addBtn = document.createElement('button');
        addBtn.className = 'vnccs-ps-btn-add-large';
        addBtn.textContent = xzgTh("+ 添加平行光", "+ Add Directional Light");
        addBtn.onclick = () => {
            this.lightParams.push({
                type: 'directional',
                color: '#ffffff',
                intensity: 1.0,
                x: 0, y: 0, z: 5
            });
            this.refreshLightUI();
            this.applyLighting();
        };
        this.lightListContainer.appendChild(addBtn);
    }

    applyLighting() {
        if (this.viewer && this.viewer.isInitialized()) {
            this.viewer.updateLights(this.lightParams);
        }

        // Persist lighting without capturing a PNG on every drag event.
        clearTimeout(this.lightingQuickSyncTimeout);
        this.lightingQuickSyncTimeout = setTimeout(() => {
            this.syncToNode(false, { skipCapture: true });
        }, 100);

        // Interactive lighting changes are captured immediately before execution.
        // A synchronous 1024px PNG capture here blocks the UI after every drag,
        // and a full capture repeats that work for every pose.
        clearTimeout(this.lightingSyncTimeout);
        this.lightingSyncTimeout = null;
    }

    updateRotationSliders() {
        if (!this.viewer) return;
        const rArray = this.viewer.isInitialized() ? this.viewer.getPose().modelRotation : [0, 0, 0];
        const r = { x: rArray[0], y: rArray[1], z: rArray[2] };
        ['x', 'y', 'z'].forEach(axis => {
            const info = this.sliders[`rot_${axis}`];
            if (info) {
                info.slider.value = r[axis];
                info.label.innerText = `${r[axis]}°`;
            }
        });
    }

    updateGenderUI() {
        if (!this.genderBtns) return;
        const isFemale = this.meshParams.gender < 0.5;
        if (this.genitalsToggle) this.genitalsToggle.checked = this.meshParams.show_genitals === true;
        this.genderBtns.male.classList.toggle("active", !isFemale);
        this.genderBtns.female.classList.toggle("active", isFemale);
        for (const field of this.femaleMeshFields || []) {
            field.style.display = isFemale ? "" : "none";
        }
        for (const field of this.maleMeshFields || []) {
            field.style.display = isFemale ? "none" : "";
        }
        for (const field of this.genitalSizeFields || []) {
            field.style.display = !isFemale && this.meshParams.show_genitals === true ? "" : "none";
        }
    }

    onMeshParamsChanged(changedKey = null, options = {}) {
        // Update node widgets
        for (const [key, value] of Object.entries(this.meshParams)) {
            const widget = this.getNodeWidget(key);
            if (widget) {
                widget.value = value;
            }
        }

        // Toggling genitals changes the mesh index topology, so rebuild the
        // mesh with the requested genital faces instead of relying on a live
        // vertex-only morph update.
        if (changedKey === "show_genitals") {
            this.syncToNode(false, { skipCapture: true });
            this.queueFullMeshUpdate(changedKey);
            return;
        }

        const liveRequested = this.requestLiveMorph(changedKey);
        if (liveRequested) {
            if (changedKey === "age") {
                this.pendingAgeCameraFit = true;
            }
            this.syncToNode(false, { skipCapture: true });
            return;
        }

        this.syncToNode(false, { skipCapture: true });
        if (this._morphWorkerFailed) return;
        this.queueFullMeshUpdate(changedKey);
    }

    resize({ forceUIScale = false } = {}) {
        this.scheduleMainUIScaleCommit({ force: forceUIScale });
        this.performViewerResize();
    }

    performViewerResize(width = this._observedCanvasWidth, height = this._observedCanvasHeight) {
        if (!this.viewer || !this.canvasContainer) return;
        const targetW = Math.round(Number(width) || 0);
        const targetH = Math.round(Number(height) || 0);
        if (targetW <= 1 || targetH <= 1) return;

        if (targetW === this._lastResizeW && targetH === this._lastResizeH) return;

        this._lastResizeW = targetW;
        this._lastResizeH = targetH;
        profilePoseStudioResize("PoseViewer resize total", () => {
            this.viewer.resize(targetW, targetH);
        });
    }

    updateActionToolbarPosition() {
        const toolbar = this.actionToolbar;
        const canvas = this.canvasContainer;
        if (!toolbar || !canvas) return;

        const canvasWidth = canvas.clientWidth;
        const canvasHeight = canvas.clientHeight;
        if (canvasWidth <= 0 || canvasHeight <= 0) return;

        // Keep the toolbar fixed to the canvas viewport, independent of the
        // capture-frame position and zoom. Scale controls with available width.
        const toolbarWidth = Math.max(0, Math.min(canvasWidth - 16, 1100));
        const toolbarScale = Math.max(0.55, Math.min(1, toolbarWidth / 760));
        toolbar.style.setProperty("--vnccs-ps-toolbar-scale", toolbarScale.toFixed(3));
        toolbar.style.width = `${toolbarWidth}px`;
        const toolbarHeight = toolbar.offsetHeight || 42;
        const left = Math.max(8, (canvasWidth - toolbarWidth) / 2);
        const top = Math.max(4, Math.min(32, canvasHeight - toolbarHeight - 4));
        toolbar.style.left = `${left}px`;
        toolbar.style.top = `${top}px`;
    }

    updateMainUIScale({
        force = false,
        width = this._observedContainerWidth,
        height = this._observedContainerHeight,
    } = {}) {
        // Fullscreen establishes its own stable 1x layout. Ignore delayed
        // ResizeObserver scale commits while it is open to prevent a first-open
        // jump after the initial frame.
        if (!this.container || this.host?.embedded || this.host?.standalone || this._fullscreenHost) return;
        const resolvedWidth = Number(width) || Number(this.node?.size?.[0]) || 900;
        const resolvedHeight = Number(height) || Number(this.node?.size?.[1]) || 740;
        const scale = Math.max(0.35, Math.min(2.5, Math.min(
            resolvedWidth / POSE_STUDIO_LAYOUT_BASE_WIDTH,
            resolvedHeight / POSE_STUDIO_LAYOUT_BASE_HEIGHT,
        )));
        const next = scale.toFixed(3);
        const relativeNext = (scale / POSE_STUDIO_LAYOUT_REFERENCE_UI_SCALE).toFixed(3);
        const previous = Number.parseFloat(this.container.style.getPropertyValue("--vnccs-ps-ui-scale"));
        if (!force && Number.isFinite(previous) && Math.abs(scale - previous) < 0.005) {
            return false;
        }
        if (this.container.style.getPropertyValue("--vnccs-ps-ui-scale") !== next) {
            this.container.style.setProperty("--vnccs-ps-ui-scale", next);
        }
        if (this.container.style.getPropertyValue("--vnccs-ps-relative-ui-scale") !== relativeNext) {
            this.container.style.setProperty("--vnccs-ps-relative-ui-scale", relativeNext);
        }
        return true;
    }

    scheduleMainUIScaleCommit({ width = null, height = null, force = false } = {}) {
        const nextWidth = Number(width);
        const nextHeight = Number(height);
        if (Number.isFinite(nextWidth) && nextWidth > 0) {
            this._observedContainerWidth = nextWidth;
        }
        if (Number.isFinite(nextHeight) && nextHeight > 0) {
            this._observedContainerHeight = nextHeight;
        }
        this._forceNextUIScaleCommit ||= force;

        clearTimeout(this._uiScaleCommitTimer);
        this._uiScaleCommitTimer = setTimeout(() => {
            this._uiScaleCommitTimer = null;
            const shouldForce = this._forceNextUIScaleCommit;
            this._forceNextUIScaleCommit = false;
            profilePoseStudioResize("UI scale/style update", () => {
                this.updateMainUIScale({
                    force: shouldForce,
                    width: this._observedContainerWidth,
                    height: this._observedContainerHeight,
                });
            });

            // Popover positioning reads several layout metrics. Keep it out of the
            // resize hot path and run it only after the settled layout was painted.
            if (this._activeHandSide) {
                if (this._handPopoverResizeFrame) {
                    cancelAnimationFrame(this._handPopoverResizeFrame);
                }
                this._handPopoverResizeFrame = requestAnimationFrame(() => {
                    this._handPopoverResizeFrame = requestAnimationFrame(() => {
                        this._handPopoverResizeFrame = null;
                        if (this._activeHandSide) {
                            this.positionHandControlPopover(this._activeHandSide);
                        }
                    });
                });
            }
        }, 120);
    }

    startResizeObserver() {
        if (this._containerResizeObserver || !this.canvasContainer) return;

        this._containerResizeObserver = new ResizeObserver((entries) => {
            profilePoseStudioResize("ResizeObserver callback", () => {
                let canvasWidth = 0;
                let canvasHeight = 0;

                for (const entry of entries) {
                    const contentBox = Array.isArray(entry.contentBoxSize)
                        ? entry.contentBoxSize[0]
                        : entry.contentBoxSize;
                    const width = Number(contentBox?.inlineSize ?? entry.contentRect?.width) || 0;
                    const height = Number(contentBox?.blockSize ?? entry.contentRect?.height) || 0;

                    if (entry.target === this.container) {
                        this.scheduleMainUIScaleCommit({ width, height });
                    } else if (entry.target === this.canvasContainer) {
                        this._observedCanvasWidth = width;
                        this._observedCanvasHeight = height;
                        canvasWidth = width;
                        canvasHeight = height;
                    }
                }

                if (canvasWidth > 0 && canvasHeight > 0) {
                    this.performViewerResize(canvasWidth, canvasHeight);
                }
            });
        });

        if (this.container) this._containerResizeObserver.observe(this.container);
        this._containerResizeObserver.observe(this.canvasContainer);
    }

    /**
     */
    syncMeshProportionSlidersFromViewer() {
        if (!this.viewer?.boneLengthParams) return;
        const mapping = {
            shoulder_l_length: 'shoulder_l',
            shoulder_r_length: 'shoulder_r',
            hip_l_length: 'hip_l',
            hip_r_length: 'hip_r',
            upper_arm_l_length: 'upper_arm_l',
            upper_arm_r_length: 'upper_arm_r',
            forearm_l_length: 'forearm_l',
            forearm_r_length: 'forearm_r',
            thigh_l_length: 'thigh_l',
            thigh_r_length: 'thigh_r',
            shin_l_length: 'shin_l',
            shin_r_length: 'shin_r',
            spine_length: 'spine',
        };
        for (const [sliderKey, groupKey] of Object.entries(mapping)) {
            const value = this.viewer.boneLengthParams[groupKey];
            if (!Number.isFinite(Number(value))) continue;
            this.meshParams[sliderKey] = Number(value);
            const info = this.sliders?.[sliderKey];
            if (info?.slider) info.slider.value = value;
            if (info?.label) info.label.innerText = Number(value).toFixed(2);
        }
    }

    getNodeWidget(name) {
        const widgets = this.node?.widgets || [];
        if (
            !this._nodeWidgetCache
            || this._nodeWidgetCache.source !== widgets
            || this._nodeWidgetCache.length !== widgets.length
        ) {
            this._nodeWidgetCache = {
                source: widgets,
                length: widgets.length,
                byName: new Map(widgets.map(widget => [widget?.name, widget])),
            };
        }
        return this._nodeWidgetCache.byName.get(name);
    }

    queueCaptureUpload(captureId) {
        const captures = this.poseCaptures || [];
        if (
            !captureId
            || captures.length === 0
            || !captures.every(capture => typeof capture === "string" && capture.length > 0)
        ) return;
        const previous = this._lastCaptureUploadSnapshot;
        const unchanged = previous
            && previous.captureId === captureId
            && previous.captures.length === captures.length
            && previous.captures.every((capture, index) => capture === captures[index]);
        if (unchanged) return;

        const snapshot = {
            captureId,
            captures: captures.slice(),
        };
        this._lastCaptureUploadSnapshot = snapshot;
        fetch('/vnccs/pose_captures_upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                capture_id: captureId,
                captured_images: snapshot.captures,
            })
        }).then(response => {
            if (!response.ok) {
                const error = new Error(`HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }
        }).catch(error => {
            // A 413 is deterministic for this exact snapshot. Keep it marked
            // as attempted so ordinary UI state changes do not hammer the same
            // oversized request again; a new capture produces a new snapshot.
            if (error?.status !== 413 && this._lastCaptureUploadSnapshot === snapshot) {
                this._lastCaptureUploadSnapshot = null;
            }
            console.warn("[VNCCS PoseStudio] Capture upload failed:", error);
        });
    }

    syncToNode(fullCapture = false, options = {}) {
        if (this._disposed) return;
        if (this._poseDataRestoreError || this._poseDataRestorePending || this.node?._vnccsPoseAwaitingRestore) {
            if (options.executionCapture) throw new Error(this._poseDataRestoreError || "Pose Studio is still restoring the workflow.");
            return;
        }
        if (this._isSyncing) return;
        this._isSyncing = true;
        try {
        this.captureActiveCharacterRuntime();
        const captureExplicitlyRequested = options.executionCapture === true
            || options.skipCapture === false;
        const skipCapture = options.skipCapture === true
            || !captureExplicitlyRequested;
        const capturePoses = this.poses;
        const outputCount = this.poses.length;
        if (fullCapture && captureExplicitlyRequested
            && outputCount * (this.exportParams.view_width || 1024)
                * (this.exportParams.view_height || 1024) > 64 * 1024 * 1024) {
            throw new Error("Captured sequence is too large. Reduce resolution or frame count.");
        }

        // Save current pose before syncing (only if we are NOT in a sub-sync loop)
        if (!fullCapture && this.getActiveCharacter() && this.viewer && this.viewer.isInitialized()) {
            const syncPose = this.stripSceneCameraFromPose(this.viewer.getPose());
            syncPose.cameraParams = this.currentCameraParams();
            this.poses[this.activeTab] = syncPose;
        }

        // Cache Handling
        if (!this.poseCaptures) this.poseCaptures = [];

        if (options.executionCapture === true) {
            this._executionCaptureSnapshot = null;
        }

        while (this.poseCaptures.length < outputCount) this.poseCaptures.push(null);
        while (this.poseCaptures.length > outputCount) this.poseCaptures.pop();

        // Capture Image (CSR)
        if (!skipCapture && this.viewer && this.viewer.isInitialized()) {
            this.viewer.updateLights(this.lightParams);
            const w = this.exportParams.view_width || 1024;
            const h = this.exportParams.view_height || 1024;
            const bg = [0, 0, 0];

                const currentCaptureCamera = {
                zoom: 1,
                offset_x: 0,
                offset_y: 0,
                yaw_deg: this.exportParams.cam_yaw_deg || 0,
                roll_deg: this.exportParams.cam_roll_deg || 0,
                pitch_deg: this.exportParams.cam_pitch_deg || 0,
            };
            if (fullCapture) {
                const originalTab = this.activeTab;
                const previousCaptures = this.poseCaptures.slice();
                let captureBatchStarted = false;

                try {
                    captureBatchStarted = this.viewer.beginCaptureBatch?.(w, h) === true;
                    for (let i = 0; i < capturePoses.length; i++) {
                        this.activeTab = i;
                        this.viewer.setPose(capturePoses[i], true);
                        this.updateCharacterScene({ poseIndex: i });
                        const poseCamera = resolveCaptureCameraParams(
                            capturePoses[i]?.cameraParams,
                            currentCaptureCamera,
                        );
                        this.setPoseCapture(i, this.viewer.capture(
                            w,
                            h,
                            currentCaptureCamera.zoom,
                            bg,
                            currentCaptureCamera.offset_x,
                            currentCaptureCamera.offset_y,
                            poseCamera.yaw_deg,
                            poseCamera.pitch_deg,
                            { roll_deg: poseCamera.roll_deg || 0 },
                        ), true);
                    }                } catch (error) {
                    this.poseCaptures = previousCaptures;
                    throw error;
                } finally {
                    this.activeTab = originalTab;
                    try {
                        // Restore original state and UI
                        this.activeTab = originalTab;
                        this.viewer.setPose(this.poses[this.activeTab], true);
                        this.restoreActivePoseCameraParams({ updateViewer: false });
                        this.updateCharacterScene({ poseIndex: this.activeTab });
                        this.refreshTabActiveState({ scroll: false });
                        this.updateRotationSliders();

                        // Restore Camera Visualization
                        const yaw = this.exportParams.cam_yaw_deg || 0;
                        const pitch = this.exportParams.cam_pitch_deg || 0;
                        this.viewer.updateCaptureCamera(w, h, 1, 0, 0, yaw, pitch, this.exportParams.cam_roll_deg || 0);
                    } finally {
                        if (captureBatchStarted || this.viewer._captureBatch) this.viewer.endCaptureBatch?.();
                    }
                }

            } else {
                // Capture only ACTIVE
                const activeCamera = resolveCaptureCameraParams(
                    this.poses[this.activeTab]?.cameraParams,
                    currentCaptureCamera,
                );
                this.updateCharacterScene({ poseIndex: this.activeTab });
                this.setPoseCapture(this.activeTab, this.viewer.capture(
                    w,
                    h,
                    1,
                    bg,
                    0,
                    0,
                    activeCamera.yaw_deg,
                    activeCamera.pitch_deg,
                    { roll_deg: activeCamera.roll_deg || 0 },
                ));
            }
        }

        // Update hidden pose_data widget
        // Exclude background_url and captured images
        // from the widget to avoid inflating workflow drafts. Heavy data is
        // uploaded separately and the widget stores compact cache references.
        const exportToSave = { ...this.exportParams };
        exportToSave._vnccs_canvas_size_user_set = this._outputSizeUserSet === true;
        delete exportToSave.interface_mode;
        delete exportToSave.manager_auto_analyze_proportions;
        delete exportToSave.background_url;
        delete exportToSave.debugPortraitMode;
        delete exportToSave.prompt_template;
        delete exportToSave.user_prompt;

        // captured_images are excluded from the widget to avoid inflating workflow size
        // (each 1024×1024 PNG is ~500KB base64; multiple poses exceed ComfyUI localStorage limit)
        // They are kept in this.poseCaptures (JS memory) and also uploaded to server-side LRU cache.
        // Only capture_id is stored in the widget so Python can fallback to the cache if needed.
        const hasCompleteCaptures = this.poseCaptures.length === outputCount
            && outputCount > 0
            && this.poseCaptures.every(capture => typeof capture === "string" && capture.length > 0);
        const captureId = `vnccs_capture_${this.node.id}${this.node._vnccsPoseCaptureGeneration || ""}`;

        const serializedCharacters = (this.characters || []).map(character => {
            this.ensureCharacterRuntime(character);
            return serializePoseStudioCharacter(character);
        });
        const primaryCharacter = serializedCharacters[0] || null;
        if (primaryCharacter) {
            exportToSave.cam_offset_x = primaryCharacter.transform.x;
            exportToSave.cam_offset_y = primaryCharacter.transform.y;
            exportToSave.cam_zoom = primaryCharacter.transform.zoom;
        }
        const data = {
            ...this._passthroughPoseData,
            schema_version: 3,
            backend_session_id: this.node?._vnccsBackendSessionId || null,
            active_character_id: this.activeCharacterId,
            scene_camera_target: (this.viewer?.sceneCameraTarget || this.viewer?.meshCenter)?.toArray?.() || null,
            scene_projection: this._samCameraModeActive && this._samCamDisplayActive
                ? normalizeSAMProjectionFrame(this._samCamStoredProjectionFrame) : null,
            initial_character_transform: this.getInitialCharacterTransform(),
            characters: serializedCharacters,
            lights: this.lightParams,
            // Legacy mirrors keep older Pose Studio builds able to open the
            // primary character without understanding the v3 scene schema.
            mesh: primaryCharacter?.mesh || this.meshParams,
            export: exportToSave,
            poses: primaryCharacter?.poses || this.poses,
            activeTab: this.activeTab,
            capture_id: captureId,
            background_url: this.exportParams.background_url || null
        };

        // Upload captures only when pose content changed. State-only
        // actions such as Reset must not retry a previously rejected large PNG
        // payload merely because the pose JSON changed.
        if (!this.host?.embedded && !this.host?.standalone && options.skipCaptureUpload !== true) {
            this.queueCaptureUpload(captureId);
        }

        const widget = this.getNodeWidget("pose_data");
        if (widget) {
            const nextWidgetValue = JSON.stringify(data);
            if (widget.value !== nextWidgetValue) {
                widget.value = nextWidgetValue;
            }
        }

        if (options.notify !== false) this.host?.onStateChange?.(data);
        } finally {
            this._isSyncing = false;
        }
    }

    loadFromNode({ preserveViewport = false } = {}) {
        this._temporarilyHiddenCharacters.clear();
        const restoreToken = this._poseDataRestoreToken = (this._poseDataRestoreToken || 0) + 1;
        this.node._vnccsPoseAwaitingRestore = false;
        this.clearPoseHistory();
        this._referenceReadToken = (this._referenceReadToken || 0) + 1;
        this.clearSAMCameraMode();
        // Load from pose_data widget
        const widget = this.getNodeWidget("pose_data");
        if (!widget || !widget.value) {
            this._poseDataRestoreError = null;
            this._poseDataRestorePending = false;
            this.characters = [];
            this.initialCharacterTransform = null;
            this.activeCharacterId = null;
            this.poses = [{}];
            this.activeTab = 0;
            this.viewer?.clearPassiveCharacters?.();
            this.viewer?.setMannequinVisible?.(false);
            this.viewer?.transform?.detach?.();
            this.viewer?.requestRender?.();
            this.updateTabs();
            this.renderCharactersUI();
            if (this.container) this.container.inert = false;
            return;
        }

        try {
            const data = JSON.parse(widget.value);
            if (!data || typeof data !== "object" || Array.isArray(data)) {
                throw new Error("pose_data must be an object");
            }
            if (data.schema_version !== undefined && ![1, 2, 3].includes(data.schema_version)) {
                throw new Error("Unsupported Pose Studio schema version");
            }
            for (const key of ["mesh", "export"]) {
                if (data[key] != null && (typeof data[key] !== "object" || Array.isArray(data[key]))) {
                    throw new Error(`pose_data.${key} must be an object`);
                }
            }
            for (const key of ["poses", "image_poses", "characters", "lights"]) {
                if (data[key] != null && !Array.isArray(data[key])) {
                    throw new Error(`pose_data.${key} must be an array`);
                }
            }
            this._poseDataRestorePending = true;
            if (this.container) this.container.inert = true;
            const knownRootKeys = new Set([
                "schema_version", "backend_session_id", "scene_camera_target", "scene_projection", "mesh", "export", "poses", "image_poses",
                "captured_images", "node_id", "characters", "active_character_id", "initial_character_transform", "pose_prompts", "prompt", "lights",
            ]);
            this._passthroughPoseData = Object.fromEntries(
                Object.entries(data).filter(([key]) => !knownRootKeys.has(key)),
            );

            if (data.mesh) {
                this.meshParams = { ...this.meshParams, ...data.mesh };
                normalizeSymmetricMeshProportions(this.meshParams);
                this.meshParams.muscle = 0.5;
                // Update sliders
                for (const [key, info] of Object.entries(this.sliders)) {
                    if (key.startsWith('rot_')) continue; // Skip rotation sliders here
                    if (info.def && this.meshParams[key] !== undefined) {
                        info.slider.value = this.meshParams[key];
                        const val = this.meshParams[key];
                        info.label.innerText = key === 'age' ? Math.round(val) : val.toFixed(2);
                    }
                }
                // Update gender switch
                if (this.updateGenderUI) this.updateGenderUI();

                // Sync bone scales
                if (this.viewer && this.meshParams.head_size !== undefined) {
                    this.viewer.updateHeadScale(this.meshParams.head_size);
                }
                if (this.viewer && this.meshParams.arm_size !== undefined) {
                    this.viewer.updateArmScale(this.meshParams.arm_size);
                }
                if (this.viewer && this.meshParams.hand_size !== undefined) {
                    this.viewer.updateHandScale(this.meshParams.hand_size);
                }
                if (this.viewer && this.meshParams.foot_size !== undefined) {
                    this.viewer.updateFootScale(this.meshParams.foot_size);
                }
                if (data.mesh.arm_length !== undefined) {
                    if (data.mesh.upper_arm_l_length === undefined) this.meshParams.upper_arm_l_length = data.mesh.arm_length;
                    if (data.mesh.upper_arm_r_length === undefined) this.meshParams.upper_arm_r_length = data.mesh.arm_length;
                    if (data.mesh.forearm_l_length === undefined) this.meshParams.forearm_l_length = data.mesh.arm_length;
                    if (data.mesh.forearm_r_length === undefined) this.meshParams.forearm_r_length = data.mesh.arm_length;
                }
                if (data.mesh.upper_arm_length !== undefined) {
                    if (data.mesh.upper_arm_l_length === undefined) this.meshParams.upper_arm_l_length = data.mesh.upper_arm_length;
                    if (data.mesh.upper_arm_r_length === undefined) this.meshParams.upper_arm_r_length = data.mesh.upper_arm_length;
                }
                if (data.mesh.forearm_length !== undefined) {
                    if (data.mesh.forearm_l_length === undefined) this.meshParams.forearm_l_length = data.mesh.forearm_length;
                    if (data.mesh.forearm_r_length === undefined) this.meshParams.forearm_r_length = data.mesh.forearm_length;
                }
                if (data.mesh.leg_length !== undefined) {
                    if (data.mesh.thigh_l_length === undefined) this.meshParams.thigh_l_length = data.mesh.leg_length;
                    if (data.mesh.thigh_r_length === undefined) this.meshParams.thigh_r_length = data.mesh.leg_length;
                    if (data.mesh.shin_l_length === undefined) this.meshParams.shin_l_length = data.mesh.leg_length;
                    if (data.mesh.shin_r_length === undefined) this.meshParams.shin_r_length = data.mesh.leg_length;
                }
                if (data.mesh.thigh_length !== undefined) {
                    if (data.mesh.thigh_l_length === undefined) this.meshParams.thigh_l_length = data.mesh.thigh_length;
                    if (data.mesh.thigh_r_length === undefined) this.meshParams.thigh_r_length = data.mesh.thigh_length;
                }
                if (data.mesh.shin_length !== undefined) {
                    if (data.mesh.shin_l_length === undefined) this.meshParams.shin_l_length = data.mesh.shin_length;
                    if (data.mesh.shin_r_length === undefined) this.meshParams.shin_r_length = data.mesh.shin_length;
                }
                const lengthKeys = [
                    'shoulder_l_length', 'shoulder_r_length',
                    'hip_l_length', 'hip_r_length',
                    'upper_arm_l_length', 'upper_arm_r_length',
                    'forearm_l_length', 'forearm_r_length',
                    'thigh_l_length', 'thigh_r_length',
                    'shin_l_length', 'shin_r_length',
                    'spine_length',
                ];
                for (const key of lengthKeys) {
                    if (this.viewer && this.meshParams[key] !== undefined) {
                        this.viewer.updateBoneLengthScale(key.replace('_length', ''), this.meshParams[key]);
                    }
                }
            }

            if (data.export) {
                this.exportParams = { ...this.exportParams, ...data.export, bg_color: [0, 0, 0] };
                this._outputSizeUserSet = data.export._vnccs_canvas_size_user_set === true;
                delete this.exportParams.grid_columns;
                delete this.exportParams.capture_image_size;
                delete this.exportParams.samApplyCamera;
                delete this.exportParams.hand_controls_v2;
                delete this.exportParams.debugMode;
                delete this.exportParams.debugShowSAMHelper;
                delete this.exportParams.debugShowSAMMeshOverlay;
                this.skinType = "naked";
                this.exportParams.skin_type = this.skinType;
                delete this.exportParams.interface_mode;
                delete this.exportParams.manager_auto_analyze_proportions;
                delete this.exportParams.debugPortraitMode;
                delete this.exportParams.prompt_template;
                delete this.exportParams.user_prompt;
                if (false) {
                    this.exportParams.editor_mode = data.export.content_mode;
                }
                

                // Update export widgets
                for (const [key, widget] of Object.entries(this.exportWidgets)) {
                    if (this.exportParams[key] !== undefined) {
                        if (widget.update) {
                            widget.update(this.exportParams[key]);
                        } else {
                            widget.value = this.exportParams[key];
                        }
                    }
                }
                this.syncCameraWidgets();
            }
            this.viewer?.setKpFigureVisible?.(false);
            this.viewer?.setUseHandControlPopover?.(true);
            this.lightParams = this.normalizeUserLights(data.lights);
            this.refreshLightUI();
            this.viewer?.updateLights(this.lightParams);

            if (Array.isArray(data.characters) && data.characters.length > MAX_POSE_STUDIO_CHARACTERS) {
                console.warn(`[VNCCS PoseStudio] Scene contains ${data.characters.length} characters; only the first ${MAX_POSE_STUDIO_CHARACTERS} can be loaded.`);
            }
            this.viewer?.clearPassiveCharacters?.();
            this._pendingMorphSolve = null;
            this._lastAppliedMorphSeq = ++this._morphSeq;
            const normalizedScene = normalizePoseStudioCharacters(data, {
                mesh: data.mesh || this.meshParams,
                color: DEFAULT_CHARACTER_COLORS[0],
            });
            this.initialCharacterTransform = data.initial_character_transform
                ? normalizeCharacterTransform(data.initial_character_transform)
                : null;
            // Keep genitals hidden whenever an editor session is opened. The
            // saved size values remain intact, so users can still enable and
            // adjust them explicitly during the session.
            for (const character of normalizedScene.characters) {
                const mesh = character.mesh || (character.mesh = {});
                mesh.show_genitals = false;
            }
            this.characters = normalizedScene.characters;
            if (!this.initialCharacterTransform) this.getInitialCharacterTransform();
            this.activeCharacterId = normalizedScene.activeCharacterId;
            const restoredActiveCharacter = this.getActiveCharacter();
            if (restoredActiveCharacter) {
                this.meshParams = { ...this.meshParams, ...restoredActiveCharacter.mesh };
                restoredActiveCharacter.mesh = this.meshParams;
                this.poses = restoredActiveCharacter.poses;
                restoredActiveCharacter.transform = normalizeCharacterTransform(restoredActiveCharacter.transform);
                this.exportParams.cam_offset_x = restoredActiveCharacter.transform.x;
                this.exportParams.cam_offset_y = restoredActiveCharacter.transform.y;
                this.exportParams.cam_zoom = restoredActiveCharacter.transform.zoom;
                if (typeof data.activeTab === "number") {
                    this.activeTab = Math.max(0, Math.min(data.activeTab, this.poses.length - 1));
                }
            }

            const savedImagePoses = Array.isArray(data.image_poses) ? data.image_poses : data.poses;
            if (!Array.isArray(data.characters) && Array.isArray(savedImagePoses) && savedImagePoses.length) {
                this.poses = savedImagePoses;
                if (restoredActiveCharacter) restoredActiveCharacter.poses = this.poses;
            }

            // Restore background image if present
            const bgUrl = data.background_url ?? data.export?.background_url ?? null;
            if (bgUrl && this.viewer) {
                this.exportParams.background_url = bgUrl;
                this.viewer.loadReferenceImage(bgUrl);
                if (this.refBtn) {
                    this.refBtn.innerHTML = '<span class="vnccs-ps-btn-icon">🗑️</span> Remove Background';
                    this.refBtn.classList.add('danger');
                }
            } else {
                this.exportParams.background_url = null;
                this.viewer?.removeReferenceImage?.();
                if (this.refBtn) {
                    this.refBtn.innerHTML = '<span class="vnccs-ps-btn-icon">🖼️</span> Background';
                    this.refBtn.classList.remove('danger');
                }
            }

            this.updateBackgroundControls();
            if (typeof data.activeTab === 'number') {
                this.activeTab = Math.max(0, Math.min(data.activeTab, this.poses.length - 1));
            }
            this.ensurePoseCameraParams();
            this.restoreActivePoseCameraParams({ updateViewer: false });

            // captured_images are no longer persisted in widget (stored in server-side LRU cache).
            // poseCaptures will be regenerated on the next syncToNode(true) call.

            this.updateTabs();
            this.renderCharactersUI();
            this.syncCharacterEditorControls();


            // Auto-load model
            // Restore skin type on the viewer before loading model
            this.viewer?.setSkinTexture(this.skinType || "naked");

            if (!this.characters.length) {
                this.viewer?.clearPassiveCharacters?.();
                this.viewer?.setMannequinVisible?.(false);
                this.viewer?.transform?.detach?.();
                this.viewer?.requestRender?.();
                this._poseDataRestorePending = false;
                if (this.container) this.container.inert = false;
            } else {
                void this.hydrateCharacterSceneModels({
                    recenterViewport: !preserveViewport,
                    cameraTarget: data.scene_camera_target,
                }).then(() => {
                    if (this._disposed || restoreToken !== this._poseDataRestoreToken) return;
                    if (data.scene_projection) this.applyLibrarySAMProjection(data.scene_projection);
                    this._poseDataRestorePending = false;
                    if (this.container) this.container.inert = false;
                }).catch(error => {
                    if (this._disposed || restoreToken !== this._poseDataRestoreToken) return;
                    this._poseDataRestorePending = false;
                    if (this.container) this.container.inert = false;
                    this._poseDataRestoreError = `Pose Studio restoration failed; original state preserved: ${error?.message || error}`;
                    console.error("Failed to restore Pose Studio character scene:", error);
                    this.showMessage?.(this._poseDataRestoreError, true);
                });
            }
            this._poseDataRestoreError = null;

        } catch (e) {
            this._poseDataRestorePending = false;
            if (this.container) this.container.inert = false;
            this._poseDataRestoreError = `Pose Studio restoration failed; original state preserved. Import a valid pose or reset the pose to continue: ${e?.message || e}`;
            this.showMessage?.(this._poseDataRestoreError, true);
            console.error("Failed to parse pose_data:", e);
        }
    }

    clearTransientStateForCurrentBoot() {
        return preparePoseStudioBackendSession(this.node);
    }


}


// === ComfyUI Extension Registration ===
async function runPoseStudioToDownstreamOutput(node, { openEditorAfterImport = false, uploadedImageName = null } = {}) {
    const nodeId = String(node.id);
    const originalQueuePrompt = api.queuePrompt;
    const queuePromptForNode = async function (number, prompt, ...args) {
        const source = prompt?.output;
        if (!source?.[nodeId]) {
            api.queuePrompt = originalQueuePrompt;
            throw new Error("当前工作流中找不到此节点。");
        }

        if (uploadedImageName) {
            // Add a temporary LoadImage node to this execution only, so an
            // uploaded file uses the same pose_image analysis path as a graph input.
            const imageNodeId = `__vnccs_uploaded_pose_image_${nodeId}_${Date.now()}`;
            source[imageNodeId] = {
                class_type: "LoadImage",
                inputs: { image: uploadedImageName },
            };
            source[nodeId] = {
                ...source[nodeId],
                inputs: { ...(source[nodeId].inputs || {}), pose_image: [imageNodeId, 0] },
            };
        }

        const downstream = new Map();
        const addConsumerLinks = (value, consumerId) => {
            if (!Array.isArray(value)) return;
            const upstreamId = value.length ? String(value[0]) : "";
            if (source[upstreamId]) {
                if (!downstream.has(upstreamId)) downstream.set(upstreamId, new Set());
                downstream.get(upstreamId).add(consumerId);
                return;
            }
            value.forEach(item => addConsumerLinks(item, consumerId));
        };
        for (const [consumerId, promptNode] of Object.entries(source)) {
            for (const value of Object.values(promptNode.inputs || {})) addConsumerLinks(value, String(consumerId));
        }

        const reachable = new Set([nodeId]);
        const queue = [nodeId];
        while (queue.length) {
            const currentId = queue.shift();
            for (const consumerId of downstream.get(currentId) || []) {
                if (reachable.has(consumerId)) continue;
                reachable.add(consumerId);
                queue.push(consumerId);
            }
        }

        // Initial upstream-image analysis should execute only this node: it
        // prepares the pose and opens the editor, but must not run consumers
        // before the user confirms the pose. Confirmation selects a downstream
        // output node so consumers run exactly once with the edited capture.
        let target;
        if (openEditorAfterImport) {
            // Pose Studio is deliberately not a global OUTPUT_NODE, so normal
            // workflows retain ComfyUI lazy evaluation. For this explicit
            // button action, add a temporary built-in PreviewImage sink to the
            // submitted prompt. It makes only this node's ancestry executable
            // and does not schedule the real downstream consumers.
            const sinkId = `__vnccs_pose_preview_${nodeId}_${Date.now()}`;
            source[sinkId] = {
                class_type: "PreviewImage",
                inputs: { images: [nodeId, 0] },
            };
            target = { id: sinkId };
        } else {
            target = app.graph._nodes?.find(candidate =>
                String(candidate.id) !== nodeId
                && reachable.has(String(candidate.id))
                && candidate.constructor?.nodeData?.output_node
                && source[String(candidate.id)]
            );
        }
        if (!target) {
            api.queuePrompt = originalQueuePrompt;
            throw new Error("请将 images 输出连接到下游预览图像或保存图像节点，再执行。");
        }

        const output = {};
        const visited = new Set();
        const addNode = id => {
            id = String(id);
            if (visited.has(id) || !source[id]) return;
            visited.add(id);
            output[id] = source[id];
            const visitInput = value => {
                if (!Array.isArray(value)) return;
                if (value.length && source[String(value[0])]) {
                    addNode(value[0]);
                    return;
                }
                value.forEach(visitInput);
            };
            Object.values(source[id].inputs || {}).forEach(visitInput);
        };
        addNode(String(target.id));
        if (openEditorAfterImport) {
            const poseDataInput = output[nodeId]?.inputs?.pose_data;
            const poseData = JSON.parse(typeof poseDataInput === "string" ? poseDataInput : "{}");
            poseData._vnccs_open_editor_after_import = true;
            poseData._vnccs_request_id = `${Date.now()}-${Math.random()}`;
            output[nodeId].inputs.pose_data = JSON.stringify(poseData);
        }
        prompt.output = output;
        api.queuePrompt = originalQueuePrompt;
        return originalQueuePrompt.call(api, number, prompt, ...args);
    };

    try {
        api.queuePrompt = queuePromptForNode;
        await app.queuePrompt(0);
    } finally {
        if (api.queuePrompt === queuePromptForNode) api.queuePrompt = originalQueuePrompt;
    }
}

try {
app.registerExtension({
    name: "VNCCS.PoseStudio.HandPopoverI18n20261015",

    setup() {
        installPosePreviewContextMenu();
        (() => {
            if (window.__vnccsPoseStudioCharacterCreatorSync) {
                return window.__vnccsPoseStudioCharacterCreatorSync;
            }

            const parseSource = (node) => {
                if (!node || node.type !== "CharacterCreatorV2") return null;
                const dataWidget = node.widgets?.find(w => w.name === "widget_data");
                if (dataWidget?.value) {
                    try {
                        const parsed = JSON.parse(dataWidget.value);
                        const info = parsed?.character_info || {};
                        const age = Number(info.age);
                        const sex = String(info.sex || "").toLowerCase();
                        const gender = sex === "male" ? 1.0 : (sex === "female" ? 0.0 : NaN);
                        return {
                            age: Number.isFinite(age) ? age : NaN,
                            gender,
                            signature: `${Number.isFinite(age) ? Math.round(age) : "?"}|${Number.isFinite(gender) ? gender : "?"}`
                        };
                    } catch (_) {
                        // Fall back to ordinary widgets below.
                    }
                }

                const ageWidget = node.widgets?.find(w => w.name === "age");
                const sexWidget = node.widgets?.find(w => w.name === "sex" || w.name === "gender");
                const age = Number(ageWidget?.value);
                const sex = String(sexWidget?.value || "").toLowerCase();
                const gender = sex === "male" ? 1.0 : (sex === "female" ? 0.0 : NaN);
                if (!Number.isFinite(age) && !Number.isFinite(gender)) return null;
                return {
                    age: Number.isFinite(age) ? age : NaN,
                    gender,
                    signature: `${Number.isFinite(age) ? Math.round(age) : "?"}|${Number.isFinite(gender) ? gender : "?"}`
                };
            };

            const api = {
                studios: new Set(),
                sourceSignatures: new WeakMap(),
                findSourceNode() {
                    const nodes = app.graph?._nodes || [];
                    return nodes.find(n => n?.type === "CharacterCreatorV2") || null;
                },
                applyToStudio(studio, values, options = {}) {
                    if (!studio || !values) return;
                    studio.applyExternalCharacterCreatorValues?.(values, options);
                },
                applySource(node, options = {}) {
                    const values = parseSource(node);
                    if (!values) return;
                    if (!options.initial) {
                        const previous = this.sourceSignatures.get(node);
                        if (previous === values.signature) return;
                    }
                    this.sourceSignatures.set(node, values.signature);
                    for (const studio of this.studios) {
                        this.applyToStudio(studio, values, options);
                    }
                },
                registerStudio(studio) {
                    if (!studio) return;
                    this.studios.add(studio);
                    this.scan();
                    const source = this.findSourceNode();
                    if (source) this.applyToStudio(studio, parseSource(source), { initial: true });
                },
                unregisterStudio(studio) {
                    this.studios.delete(studio);
                },
                hookNode(node) {
                    if (!node || node.type !== "CharacterCreatorV2") return;
                    const dataWidget = node.widgets?.find(w => w.name === "widget_data");
                    if (dataWidget && !dataWidget._vnccsPoseStudioValueHooked) {
                        let currentValue = dataWidget.value;
                        Object.defineProperty(dataWidget, "value", {
                            configurable: true,
                            get() {
                                return currentValue;
                            },
                            set: (value) => {
                                currentValue = value;
                                queueMicrotask(() => this.applySource(node));
                            }
                        });
                        dataWidget._vnccsPoseStudioValueHooked = true;
                    }

                    for (const name of ["age", "sex", "gender"]) {
                        const widget = node.widgets?.find(w => w.name === name);
                        if (!widget || widget._vnccsPoseStudioCallbackHooked) continue;
                        const original = widget.callback;
                        widget.callback = (...args) => {
                            const result = original?.apply(widget, args);
                            queueMicrotask(() => this.applySource(node));
                            return result;
                        };
                        widget._vnccsPoseStudioCallbackHooked = true;
                    }

                    this.applySource(node, { initial: true });
                },
                scan() {
                    const nodes = app.graph?._nodes || [];
                    for (const node of nodes) this.hookNode(node);
                }
            };

            window.__vnccsPoseStudioCharacterCreatorSync = api;
            return api;
        })();

        const poseStudioSyncGuard = (node, { allowCharacterSwitch = false } = {}) => {
            const widget = node.studioWidget;
            const restoreToken = widget._poseDataRestoreToken;
            const loadToken = widget._libraryLoadToken;
            const characterId = widget.activeCharacterId;
            const tab = widget.activeTab;
            return () => {
                if (widget._disposed || node.studioWidget !== widget
                    || restoreToken !== widget._poseDataRestoreToken || loadToken !== widget._libraryLoadToken
                    || (!allowCharacterSwitch && characterId !== widget.activeCharacterId)
                    || tab !== widget.activeTab) {
                    throw new Error("Pose Studio scene changed while execution was preparing. Run the workflow again.");
                }
            };
        };

        const normalizePoseCaptureSize = async (capture, width, height) => {
            if (typeof capture !== "string" || !capture) {
                throw new Error("Pose capture is empty; cannot produce the requested output resolution.");
            }
            const image = new Image();
            image.src = capture;
            await image.decode();
            if (image.naturalWidth === width && image.naturalHeight === height) return capture;

            console.warn(
                `[VNCCS PoseStudio] Capture size ${image.naturalWidth}x${image.naturalHeight} `
                + `did not match requested ${width}x${height}; fitting capture to requested canvas.`
            );
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Could not create a canvas for output-size normalization.");
            context.fillStyle = "#000000";
            context.fillRect(0, 0, width, height);
            const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
            const drawWidth = image.naturalWidth * scale;
            const drawHeight = image.naturalHeight * scale;
            context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
            return canvas.toDataURL("image/png");
        };

        const uploadPoseStudioSync = async (node, nodeId, syncToken = "") => {
            const poseWidget = node.widgets.find(w => w.name === "pose_data");
            if (!poseWidget) return;
            const widget = node.studioWidget;
            const assertCurrent = poseStudioSyncGuard(node);
            const widgetData = JSON.parse(poseWidget.value);
            const syncFileId = syncToken ? `${nodeId}_${syncToken}` : nodeId;
            let capturedImages = (widget._executionCaptureSnapshot
                || widget.poseCaptures
                || []).slice();
            widget._executionCaptureSnapshot = null;
            // Live editor settings are authoritative. The serialized widget can
            // lag behind an interaction when ComfyUI starts execution quickly.
            const outputWidth = Math.max(64, Math.min(4096, Math.round(Number(widget.exportParams?.view_width) || 1024)));
            const outputHeight = Math.max(64, Math.min(4096, Math.round(Number(widget.exportParams?.view_height) || 1024)));
            widgetData.export = { ...(widgetData.export || {}), view_width: outputWidth, view_height: outputHeight };
            capturedImages = await Promise.all(capturedImages.map(capture =>
                normalizePoseCaptureSize(capture, outputWidth, outputHeight)
            ));
            widget.poseCaptures = capturedImages;
            const payload = {
                ...widgetData,
                node_id: syncFileId,
                sync_token: syncToken || undefined,
                captured_images: capturedImages
            };

            return fetch('/vnccs/pose_sync/upload_capture', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        };

        const requirePoseStudioSyncResponse = async (response) => {
            if (!response.ok) {
                let message = `Pose Studio sync failed (HTTP ${response.status})`;
                try {
                    const errorPayload = await response.json();
                    if (errorPayload?.error) message = String(errorPayload.error);
                } catch (_) { }
                throw new Error(message);
            }
        };

        const reportPoseStudioSyncFailure = async (nodeId, syncToken, error) => {
            const syncFileId = syncToken ? `${nodeId}_${syncToken}` : nodeId;
            try {
                await fetch('/vnccs/pose_sync/upload_capture', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        node_id: syncFileId,
                        sync_token: syncToken || undefined,
                        sync_error: String(error?.message || error || "Pose Studio sync failed").slice(0, 2048),
                    }),
                });
            } catch (_) { }
        };

        api.addEventListener("vnccs_req_pose_sync", async (event) => {
            const nodeId = event.detail.node_id;
            const syncToken = String(event.detail.sync_token ?? "");
            const node = app.graph.getNodeById(nodeId);
            if (node && node.studioWidget) {
                try {
                    const widget = node.studioWidget;
                    const assertCurrent = poseStudioSyncGuard(node);
                    // Safe mode: ensure viewer is initialized
                    if (!widget.viewer || !widget.viewer.isInitialized()) {
                        await widget.loadModel();
                        assertCurrent();
                    }
                    await waitForPoseStudioSyncIdle(widget);
                    assertCurrent();
                    widget.syncToNode(true, {
                        executionCapture: true,
                    });

                    // Build payload from widget metadata + in-memory captures
                    // (captured_images are no longer stored in the widget to keep workflow size small)
                    const response = await uploadPoseStudioSync(node, nodeId, syncToken);
                    await requirePoseStudioSyncResponse(response);
                } catch (e) {
                    await reportPoseStudioSyncFailure(nodeId, syncToken, e);
                    console.error("[VNCCS] Batch Sync Error:", e);
                }
            }
        });

        api.addEventListener("vnccs_apply_sam3d_pose", async (event) => {
            const nodeId = event.detail.node_id;
            const posePayload = event.detail.pose_data;
            const syncToken = String(event.detail.sync_token ?? "");
            const requestedWidget = event.detail.studio_widget;
            const requestedNode = requestedWidget?.node;
            const node = requestedNode && String(requestedNode.id) === String(nodeId)
                ? requestedNode
                : app.graph.getNodeById(nodeId);
            const widget = requestedWidget
                ? (!requestedWidget._disposed ? requestedWidget : null)
                : node?.studioWidget;
            if (node && widget && node.studioWidget !== widget) node.studioWidget = widget;
            if (!node || !widget || widget._disposed || !posePayload) {
                event.detail.onComplete?.(new Error("姿势编辑器节点已关闭。"));
                return;
            }

            try {
                const assertCurrent = poseStudioSyncGuard(node, { allowCharacterSwitch: true });
                event.detail.onProgress?.(91, "准备人物场景");
                const appendCharacters = event.detail.apply_mode === "pose_from_image";
                const existingCharacterCount = widget.characters.length;
                const availableSlots = appendCharacters
                    ? Math.max(0, MAX_POSE_STUDIO_CHARACTERS - existingCharacterCount)
                    : MAX_POSE_STUDIO_CHARACTERS;
                const candidatePeople = Array.isArray(posePayload.people) && posePayload.people.length
                    ? posePayload.people
                    : [posePayload];
                const detectedPeople = candidatePeople.slice(0, availableSlots);
                if (appendCharacters && detectedPeople.length === 0) {
                    throw new Error(`最多支持 ${MAX_POSE_STUDIO_CHARACTERS} 个人物；当前已满，请先删除人物再获取。`);
                }
                if (!appendCharacters && widget.characters.length > detectedPeople.length) {
                    for (const extra of [...widget.characters].sort((a, b) => b.slot - a.slot)) {
                        if (widget.characters.length <= detectedPeople.length) break;
                        await widget.deleteCharacter(extra.id, { rebuildScene: false });
                    }
                }
                const sourceResolution = event.detail.source_resolution;
                const preserveOutputSize = !!widget.exportParams.background_url
                    || widget.viewer?.hasReferenceImage?.() === true;
                if (!preserveOutputSize && sourceResolution && Number.isFinite(Number(sourceResolution.width)) && Number.isFinite(Number(sourceResolution.height))) {
                    const width = Math.max(64, Math.min(4096, Math.round(Number(sourceResolution.width))));
                    const height = Math.max(64, Math.min(4096, Math.round(Number(sourceResolution.height))));
                    widget.exportParams.view_width = width;
                    widget.exportParams.view_height = height;
                    // Without a background, both image-pose entry points adopt
                    // the recognition image size, including after manual edits.
                    widget._outputSizeUserSet = false;
                    if (widget.exportWidgets.view_width) widget.exportWidgets.view_width.value = String(width);
                    if (widget.exportWidgets.view_height) widget.exportWidgets.view_height.value = String(height);
                    widget._lastResizeW = 0;
                    widget._lastResizeH = 0;
                    widget.resize();
                    widget.updateCaptureCameraPreview();
                }
                if (!widget.viewer || !widget.viewer.isInitialized()) {
                    await widget.loadModel();
                    assertCurrent();
                }

                const importCharacters = appendCharacters
                    ? []
                    : [...widget.characters]
                        .sort((a, b) => a.slot - b.slot)
                        .slice(0, detectedPeople.length);
                while (importCharacters.length < detectedPeople.length) {
                    const added = await widget.addCharacter(null, { rebuildScene: false });
                    assertCurrent();
                    if (!added) throw new Error("没有足够的角色槽位来导入所有识别结果。");
                    importCharacters.push(widget.getActiveCharacter());
                }

                for (let personIndex = 0; personIndex < detectedPeople.length; personIndex += 1) {
                    assertCurrent();
                    event.detail.onProgress?.(
                        91 + Math.round(7 * personIndex / Math.max(1, detectedPeople.length)),
                        `整理第 ${personIndex + 1}/${detectedPeople.length} 个人物`,
                    );
                    const character = importCharacters[personIndex];
                    if (character.id !== widget.activeCharacterId) {
                        if (!await widget.selectCharacter(character.id, { rebuildScene: false })) {
                            throw new Error(`无法切换到第 ${personIndex + 1} 个角色。`);
                        }
                        assertCurrent();
                    }

                    const personPose = detectedPeople[personIndex];
                    const fitData = await widget.prepareSAM3DRenderFit(personPose);
                    assertCurrent();
                    const poseForImport = fitData?.poseData || personPose;
                    const ok = widget.viewer.applySAM3DImport(
                        poseForImport,
                        widget._shoulderYOffset || 0,
                        { dispatchPoseChange: false },
                    );
                    if (!ok) throw new Error(`第 ${personIndex + 1} 个人的姿势导入失败。`);
                    if (fitData?.meshData) {
                        widget.applySAM3DMeshOverlayFit(fitData.meshData, poseForImport, {
                            dispatchPoseChange: false,
                        });
                    }
                    widget.syncMeshProportionSlidersFromViewer();
                    // Every imported person has a separate character transform.
                    // Fit each one against its own source-image box; leaving later
                    // appended characters at their default transform breaks both
                    // their original scale and their image-space placement.
                    widget.applySAM3DFrameCameraParams(
                        poseForImport,
                        fitData?.meshData || null,
                        detectedPeople.length > 1,
                    );
                    widget.commitViewerPoseToCurrentEditor({
                        syncOptions: { skipCapture: true, skipCaptureUpload: true },
                    });
                }

                const firstCharacter = appendCharacters
                    ? importCharacters[0]
                    : [...widget.characters].sort((a, b) => a.slot - b.slot)[0];
                if (firstCharacter && firstCharacter.id !== widget.activeCharacterId) {
                    await widget.selectCharacter(firstCharacter.id, { rebuildScene: false });
                }
                widget.updateTabs();
                event.detail.onProgress?.(99, "更新节点预览");
                await waitForPoseStudioSyncIdle(widget);
                assertCurrent();
                widget.syncToNode(true, { executionCapture: true });
                const response = await uploadPoseStudioSync(node, nodeId, syncToken);
                await requirePoseStudioSyncResponse(response);
                if (posePayload.truncated || (appendCharacters && Number(posePayload.detected_people_count) > detectedPeople.length)) {
                    const importedCount = appendCharacters ? existingCharacterCount + detectedPeople.length : detectedPeople.length;
                    widget.showMessage?.(`检测到 ${posePayload.detected_people_count} 人，本次导入 ${detectedPeople.length} 人；当前共 ${importedCount} 人，最多 ${MAX_POSE_STUDIO_CHARACTERS} 人。`, true);
                }
                if (event.detail.apply_mode === "pose_and_open_editor") widget.openFullscreen();
                event.detail.onProgress?.(100, "识别完成");
                event.detail.onComplete?.();
            } catch (e) {
                await reportPoseStudioSyncFailure(nodeId, syncToken, e);
                console.error("[VNCCS] SAM3D pose_image apply error:", e);
                event.detail.onComplete?.(e);
            }
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name !== "VNCCS_PoseStudio") return;

        const setImageOutput = node => {
            const output = node?.outputs?.[0];
            if (!output) return;
            output.type = "IMAGE";
            output.name = "images";
            output.label = "images";
            output.shape = globalThis.LiteGraph?.GRID_SHAPE ?? output.shape;
            node.setDirtyCanvas?.(true, true);
        };
        const removePoseImageInput = (node) => {
            if (!node) return;
            const inputIndex = node.inputs?.findIndex(input => input?.name === "pose_image") ?? -1;
            if (inputIndex >= 0) node.removeInput?.(inputIndex);
            node.setDirtyCanvas?.(true, true);
        };

        const drawPoseStudioButton = function (ctx, _node, width, y, height) {
            const disabled = this.disabled === true;
            const left = 16;
            const top = y + 1;
            const buttonWidth = width - 32;
            const buttonHeight = height - 2;
            ctx.fillStyle = disabled ? "#242424" : "#2a2a2a";
            ctx.strokeStyle = disabled ? "#333" : "#444";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.rect(left, top, buttonWidth, buttonHeight);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = disabled ? "#555" : "#fff";
            ctx.font = "13px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(this.name, left + buttonWidth / 2, top + buttonHeight / 2);
        };

        const hideInternalWidget = (node, name) => {
            const widget = node?.widgets?.find(candidate => candidate.name === name);
            if (!widget) return;
            if (name === "pose_data") {
                widget.options = { ...widget.options, dynamicPrompts: false };
            }
            widget.type = "hidden";
            widget.computeSize = () => [0, -4];
            widget.hidden = true;
            widget.serialize = false;
            if (widget.element) widget.element.style.display = "none";
        };

        const createPosePreviewWidget = (node) => {
            const preview = {
                name: "_vnccs_pose_image_preview",
                type: "custom",
                image: null,
                computeSize(width) {
                    // Reserve a stable minimum regardless of whether an image
                    // has arrived; preview updates must never resize the node.
                    return [width, 120];
                },
                draw(ctx, drawNode, width, y) {
                    if (!this.image) return;
                    const box = this.computeSize(width);
                    const padding = 8;
                    const boxWidth = Math.max(1, width - padding * 2);
                    const nodeHeight = Number(drawNode?.size?.[1]) || (y + box[1]);
                    const boxHeight = Math.max(1, nodeHeight - y - padding * 2 - 4);
                    this._vnccsPreviewRect = {
                        x: (Number(drawNode?.pos?.[0]) || 0) + padding,
                        y: (Number(drawNode?.pos?.[1]) || 0) + y + padding,
                        width: boxWidth,
                        height: boxHeight,
                    };
                    ctx.fillStyle = "#161616";
                    ctx.fillRect(padding, y + padding, boxWidth, boxHeight);
                    ctx.strokeStyle = "#444";
                    ctx.strokeRect(padding, y + padding, boxWidth, boxHeight);
                    if (!this.image.complete || !this.image.naturalWidth) return;
                    const scale = Math.min(boxWidth / this.image.naturalWidth, boxHeight / this.image.naturalHeight);
                    const drawWidth = this.image.naturalWidth * scale;
                    const drawHeight = this.image.naturalHeight * scale;
                    ctx.drawImage(this.image, padding + (boxWidth - drawWidth) / 2, y + padding + (boxHeight - drawHeight) / 2, drawWidth, drawHeight);
                },
            };
            node._vnccsPosePreviewWidget = node.addCustomWidget(preview);
            return preview;
        };

        const updatePosePreview = (node, message) => {
            const preview = node?._vnccsPosePreviewWidget;
            const info = message?.images?.[0];
            if (!preview || !info?.filename) return;
            // ComfyUI's default IMAGE output preview also renders `node.imgs`
            // under the widgets. This node already draws the same output in
            // its size-aware custom widget, so keep the connector but hide the
            // redundant built-in thumbnail.
            node.imgs = [];
            const url = api.apiURL(`/view?filename=${encodeURIComponent(info.filename)}&type=${encodeURIComponent(info.type || "temp")}&subfolder=${encodeURIComponent(info.subfolder || "")}${app.getPreviewFormatParam?.() || ""}${app.getRandParam?.() || ""}`);
            const image = new Image();
            const captureGeneration = node._vnccsPoseCaptureGeneration;
            image.onload = () => {
                if (node._vnccsPoseCaptureGeneration !== captureGeneration) return;
                preview.image = image;
                node.setDirtyCanvas?.(true, true);
            };
            image.src = url;
        };

        const removeDefaultImagePreview = (node) => {
            if (Array.isArray(node?.imgs) && node.imgs.length) node.imgs = [];
            const widgets = node?.widgets;
            if (!Array.isArray(widgets)) return;
            const index = widgets.findIndex(widget => widget?.name === "$$canvas-image-preview");
            if (index < 0) return;
            const [widget] = widgets.splice(index, 1);
            try { widget?.onRemove?.(); } catch (_) {}
        };

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onCreated) onCreated.apply(this, arguments);
            this._vnccsPoseAwaitingRestore = true;
            setImageOutput(this);

            // pose_data is internal state, never user-facing UI. Hide it before
            // constructing the DOM widget so a later initialization exception
            // cannot expand megabytes of JSON across the ComfyUI canvas.
            hideInternalWidget(this, "pose_data");


            this.setSize([400, 420]);

            // Create widget

            this.studioWidget = new PoseStudioWidget(this);
            this.studioWidget.container.inert = true;
            this._vnccsRemovePoseImageInput = () => removePoseImageInput(this);
            this._vnccsRemovePoseImageInput();

            const openEditorButton = this.addWidget("button", "打开姿势编辑器", null, () => {
                this.studioWidget?.openFullscreen();
            });
            openEditorButton.options = { ...openEditorButton.options, serialize: false };
            openEditorButton.draw = drawPoseStudioButton;
            this._vnccsPoseOpenEditorButton = openEditorButton;
            createPosePreviewWidget(this);

            this.setSize([400, 420]);

            // Pre-load library for random functionality
            this._vnccsPoseLibraryWarmupTimer = setTimeout(() => {
                if (this.studioWidget) {
                    this.studioWidget.refreshLibrary(false);
                }
            }, 1000);

            // Load model after initialization
            this._vnccsPoseInitTimer = setTimeout(async () => {
                try {
                    await preparePoseStudioBackendSession(this);
                    if (!this.studioWidget) return;
                    this._vnccsRemovePoseImageInput?.();
                    window.__vnccsPoseStudioCharacterCreatorSync?.registerStudio(this.studioWidget);
                    const modelReady = this.studioWidget.characters.length
                        ? this.studioWidget.loadModel()
                        : Promise.resolve(false);
                    await modelReady;
                    if (this.studioWidget.viewer) {
                        if (!this.studioWidget.characters.length) this.studioWidget.viewer.setMannequinVisible?.(false);
                        this.studioWidget.updateCaptureCameraPreview();
                        this.studioWidget.resize();
                    }
                    this.onResize(this.size);
                } catch (error) {
                    console.warn("[VNCCS PoseStudio] Could not prepare editor backend session:", error);
                }
            }, 800);
        };

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const result = onResize?.apply(this, arguments);
            if (this.studioWidget?._fullscreenHost) this.studioWidget._fullscreenResizeHandler?.();
            return result;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = onExecuted?.apply(this, arguments);
            updatePosePreview(this, message);
            removeDefaultImagePreview(this);
            return result;
        };

        // Newer ComfyUI frontends may append a second $$canvas-image-preview
        // widget after handling ui.images. This node has its own size-aware
        // preview widget, so keep the output socket while removing that extra
        // built-in rendering on every canvas draw.
        const onDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function () {
            removeDefaultImagePreview(this);
            const result = onDrawBackground?.apply(this, arguments);
            removeDefaultImagePreview(this);
            return result;
        };

        // Save state on configure
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (onConfigure) onConfigure.apply(this, arguments);

            if (this.studioWidget) {
                clearTimeout(this._vnccsPoseInitTimer);
                clearTimeout(this._vnccsPoseConfigureTimer);
                this._vnccsPoseConfigureTimer = setTimeout(async () => {
                    try {
                        await preparePoseStudioBackendSession(this, { refresh: true, reloadState: true });
                        if (!this.studioWidget) return;
                        this._vnccsRemovePoseImageInput?.();
                        window.__vnccsPoseStudioCharacterCreatorSync?.registerStudio(this.studioWidget);
                        if (this.studioWidget.characters.length) await this.studioWidget.loadModel();
                        else this.studioWidget.viewer?.setMannequinVisible?.(false);
                        this.studioWidget.refreshLibrary(false); // Pre-load library meta only
                        this.onResize(this.size); // Force correct aspect ratio on config
                    } catch (error) {
                        console.warn("[VNCCS PoseStudio] Could not restore backend session state:", error);
                    }
                }, 500);
            }
        };

        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (workflow) {
            const result = onSerialize?.apply(this, arguments);
            const poseWidget = this.widgets?.find(widget => widget.name === "pose_data");
            if (poseWidget && this.studioWidget) {
                const previous = poseWidget.value;
                this.studioWidget.syncToNode(false, {
                    skipCapture: true, skipCaptureUpload: true,
                    notify: false,
                });
                if (Array.isArray(workflow?.widgets_values)) {
                    workflow.widgets_values = workflow.widgets_values.map(value => value === previous ? poseWidget.value : value);
                }
            }
            return result;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            window.__vnccsPoseStudioCharacterCreatorSync?.unregisterStudio(this.studioWidget);
            clearTimeout(this.resizeTimer);
            clearTimeout(this._vnccsPoseLibraryWarmupTimer);
            clearTimeout(this._vnccsPoseInitTimer);
            clearTimeout(this._vnccsPoseConfigureTimer);
            if (this._vnccsPoseWidthFrame) {
                cancelAnimationFrame(this._vnccsPoseWidthFrame);
                this._vnccsPoseWidthFrame = null;
            }
            if (this.studioWidget) {
                this.studioWidget.dispose();
            }
            if (onRemoved) onRemoved.apply(this, arguments);
        };
    },

    nodeCreated(node) {
        window.__vnccsPoseStudioCharacterCreatorSync?.hookNode(node);
        if (node?.type === "CharacterCreatorV2") {
            setTimeout(() => window.__vnccsPoseStudioCharacterCreatorSync?.hookNode(node), 0);
            setTimeout(() => window.__vnccsPoseStudioCharacterCreatorSync?.hookNode(node), 500);
        }
    },

    loadedGraphNode(node) {
        window.__vnccsPoseStudioCharacterCreatorSync?.hookNode(node);
    },

    loadedGraph() {
        window.__vnccsPoseStudioCharacterCreatorSync?.scan();
    }
});
} catch (error) {
    if (!/already registered/i.test(String(error?.message || error))) throw error;
    console.debug("Pose Studio extension is already registered; reusing the existing ComfyUI hooks.");
}

// Shared editor surface for hosts such as UniCanvas. Node registration stays unchanged.
export { PoseStudioWidget };
