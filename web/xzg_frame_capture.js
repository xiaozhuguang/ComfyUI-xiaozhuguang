import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { xzgT } from "./xzg_i18n.js";
import { xzgSendAnnotatedNameToImageLoader } from "./xzg_image_save.js";
import { xzgMenuItemVisible, XZG_MENU_CAPTURE_FRAME } from "./xzg_loader_settings.js";

// ═══════════════════════════════════════════════════════════════════
// 小珠光 · 截取视频当前帧发送到图像加载器
//
// 为「小珠光视频加载-化神级」「小珠光视频保存-化神级」的节点右键菜单
// 提供「截取当前帧发送到加载器」：把播放器当前画面截为 PNG → 上传到
// ComfyUI input 目录 → 复用图像保存节点同一套流程发送到小珠光图像加载器。
//
// 设置项：两个菜单项可在 设置 → 小珠光 中分别关闭（默认开启）。
// ═══════════════════════════════════════════════════════════════════

const SETTING_LOADER_CAPTURE = "xiaozhuguang.Menu.VideoLoaderDaVinciCaptureFrame";
const SETTING_SAVE_CAPTURE = "xiaozhuguang.Menu.VideoSaveDaVinciCaptureFrame";

const SETTING_DEFS = [
    {
        id: SETTING_LOADER_CAPTURE,
        name: "[小珠光] 视频加载-化神级右键菜单：截取当前帧发送到加载器",
    },
    {
        id: SETTING_SAVE_CAPTURE,
        name: "[小珠光] 视频保存-化神级右键菜单：截取当前帧发送到加载器",
    },
];

app.registerExtension({
    name: "Xiaozhuguang.FrameCaptureMenus",
    setup() {
        try {
            const settings = app?.ui?.settings;
            if (!settings?.addSetting) return;
            for (const def of SETTING_DEFS) {
                settings.addSetting({
                    id: def.id,
                    name: def.name,
                    defaultValue: true,
                    type: "boolean",
                });
            }
        } catch (e) {
            console.warn("[小珠光视频帧截取] 注册设置项失败:", e);
        }
    },
});

// kind: "loader"（视频加载-化神级）| "save"（视频保存-化神级）
export function xzgFrameCaptureMenuEnabled(kind) {
    const id = kind === "save" ? SETTING_SAVE_CAPTURE : SETTING_LOADER_CAPTURE;
    try {
        // 新版前端已废弃 getSettingValue 的第二个参数（默认值改由设置项定义提供）
        return app?.ui?.settings?.getSettingValue?.(id) !== false;
    } catch (e) {
        return true;
    }
}

function _toast(msg, isError = false) {
    const el = document.createElement("div");
    el.style.cssText =
        "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:1000002;" +
        "padding:8px 16px;border-radius:6px;font-size:13px;color:#fff;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.4);pointer-events:none;opacity:0;" +
        "transition:opacity .25s;max-width:80vw;word-break:break-all;";
    el.style.background = isError ? "rgba(198,40,40,.95)" : "rgba(30,30,30,.95)";
    if (isError) el.style.border = "1px solid #ef9a9a";
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => {
        el.style.opacity = "1";
        setTimeout(() => {
            el.style.opacity = "0";
            setTimeout(() => el.remove(), 260);
        }, 3000);
    });
}

// 菜单项最终可见性 = 全局设置开关 且 该节点设置面板未取消勾选（与悬浮按钮同一套）
function _captureMenuVisible(node, nodeKind) {
    return xzgFrameCaptureMenuEnabled(nodeKind) && xzgMenuItemVisible(node, XZG_MENU_CAPTURE_FRAME);
}

function _xzgTimestamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return (
        d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
        "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
        "_" + p(d.getMilliseconds(), 3)
    );
}

// 播放器当前帧是否可截取（解码器已建且画面有尺寸）
function _xzgFrameReady(node) {
    const player = node?._xzgVideoPlayer;
    return !!(player?._currentDecoder && player?._canvas?.width && player?._canvas?.height);
}

// 截取播放器当前帧，返回 PNG Blob（失败/无画面返回 null）。
// 播放器基于 Canvas 解码渲染（无 <video> 元素），直接复制画面即可，
// 同源 /view 视频，canvas 不会被污染。
export async function xzgCaptureCurrentFrameBlob(node) {
    if (!_xzgFrameReady(node)) return null;
    const src = node._xzgVideoPlayer._canvas;
    // 复制到离屏画布，避免 toBlob 异步期间播放器渲染下一帧导致画面撕裂
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0);
    return await new Promise((resolve) => {
        try {
            out.toBlob((blob) => resolve(blob || null), "image/png");
        } catch (e) {
            console.warn("[小珠光视频帧截取] 导出帧失败:", e);
            resolve(null);
        }
    });
}

// 节点右键菜单公共动作：截帧 → 上传 input → 发送到图像加载器
export async function xzgSendCurrentFrameToLoader(node) {
    try {
        const blob = await xzgCaptureCurrentFrameBlob(node);
        if (!blob) {
            _toast(xzgT("没有可截取的画面，请先在播放器中加载视频", "No frame to capture. Load a video in the player first"), true);
            return;
        }
        const filename = `xzg-frame-${_xzgTimestamp()}.png`;
        const body = new FormData();
        body.append("image", blob, filename);
        body.append("type", "input");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body });
        if (!resp.ok) {
            _toast(xzgT(`当前帧上传失败（HTTP ${resp.status}）`, `Frame upload failed (HTTP ${resp.status})`), true);
            return;
        }
        const info = await resp.json().catch(() => null);
        if (!info?.name) {
            _toast(xzgT("上传接口没有返回文件名", "Upload API returned no filename"), true);
            return;
        }
        const annotated = (info.subfolder ? `${info.subfolder}/` : "") + info.name + " [input]";
        await xzgSendAnnotatedNameToImageLoader(annotated);
        _toast(xzgT("已截取当前帧并发送到图像加载器", "Frame captured and sent to Image Loader"));
    } catch (e) {
        console.warn("[小珠光视频帧截取] ", e);
        _toast(xzgT("截取当前帧失败：", "Failed to capture frame: ") + (e?.message || e), true);
    }
}

// 给节点类型挂右键菜单项（两个化神级视频节点共用）。
// nodeKind 传给 xzgFrameCaptureMenuEnabled 决定读取哪个设置开关。
// 挂载点有两个：
// ① 节点级 getExtraMenuOptions —— 右键标题栏/节点边缘等未落在播放器预览上的区域；
// ② 播放器自建右键菜单 —— 预览区的 contextmenu 被播放器 stopPropagation 拦截，
//    节点菜单收不到，需通过 node._xzgPlayerMenuItems 注入（见 xzg_video_player.js）。
export function xzgAddFrameCaptureMenu(nodeType, nodeKind) {
    const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
        if (origGetExtraMenuOptions) origGetExtraMenuOptions.call(this, canvas, options);
        if (!Array.isArray(options)) return;
        if (!_captureMenuVisible(this, nodeKind)) return;
        const ready = _xzgFrameReady(this);
        options.unshift({
            content: xzgT("✂ 截取当前帧发送到加载器", "✂ Capture Current Frame to Image Loader"),
            color: ready ? "#FFD700" : "#888",
            disabled: !ready,
            callback: () => { xzgSendCurrentFrameToLoader(this); },
        }, null);
    };

    // 播放器自建菜单的动态项提供器：挂在节点上，播放器销毁重建（内存模式切换）后依然生效
    const origOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        const r = origOnNodeCreated?.apply(this, arguments);
        if (!this._xzgPlayerMenuItems) {
            this._xzgPlayerMenuItems = () => {
                if (!_captureMenuVisible(this, nodeKind)) return [];
                const ready = _xzgFrameReady(this);
                return [{
                    // 与「📷 保存当前帧图片」同款式：图标 + 默认白色文字
                    content: xzgT("✂ 截取当前帧发送到加载器", "✂ Capture Current Frame to Image Loader"),
                    color: ready ? undefined : "#888",
                    disabled: !ready,
                    callback: () => { xzgSendCurrentFrameToLoader(this); },
                }];
            };
        }
        return r;
    };
}
