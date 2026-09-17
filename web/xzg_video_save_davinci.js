import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// 小珠光视频保存-化神级（XiaozhuguangVideoSaveDaVinci）
// 复用「小珠光视频保存」的全部交互（预览/缓存/恢复见父类 xzg_video_combine.js 注册器），
// 额外在预览区叠加「导出到达芬奇」悬浮按钮：把该节点最近一次保存的视频导入达芬奇
// （进当前媒体池 + 新建视频轨道 + 对齐播放头所在最上层片段前端，不推移/不分割）。
const SAVE_DAVINCI_NODE = "XiaozhuguangVideoSaveDaVinci";

const _tr = (s) => s;

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

// 从节点最近一次保存的输出信息里取 filename/subfolder（预览缓存与 properties 都是信息的来源）
function _getSavedVideoInfo(node) {
    const info = node._xzgVideoOutput || node.properties?._xzgVideoOutput;
    if (info && info.filename) return { filename: info.filename, subfolder: info.subfolder || "", type: info.type || "output" };
    const player = node._xzgVideoPlayer;
    if (player && player._videoInfo && player._videoInfo.filename) {
        return { filename: player._videoInfo.filename, subfolder: player._videoInfo.subfolder || "", type: player._videoInfo.type || "output" };
    }
    return null;
}

async function _exportToDavinci(node, btn, labelSpan, label) {
    const info = _getSavedVideoInfo(node);
    if (!info || !info.filename) {
        _toast("[导出到达芬奇] 当前节点还没有已保存的视频，请先执行一次「保存」模式。", true);
        return;
    }
    btn.disabled = true;
    if (labelSpan) labelSpan.textContent = "正在导出到达芬奇…";
    try {
        const resp = await api.fetchApi("/xzg/davinci/save-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: info.filename, subfolder: info.subfolder }),
        });
        const data = await resp.json();
        if (!data?.ok) {
            _toast("[导出到达芬奇] " + (data?.error || "导入失败"), true);
            return;
        }
        const clip = data.clip ? `「${data.clip}」` : "";
        const track = data.track != null ? `V${data.track}` : "";
        _toast(`已导出至达芬奇${clip} ${track} ${data.record_frame != null ? `@帧${data.record_frame}` : ""}`.trim());
    } catch (e) {
        _toast("[导出到达芬奇] " + String(e), true);
    } finally {
        btn.disabled = false;
        if (labelSpan) labelSpan.textContent = label;
    }
}

function _createExportDavinciButton(node) {
    if (node._xzgDavinciSaveBtn) return node._xzgDavinciSaveBtn;
    const pc = node._xzgPreviewContainer;
    if (!pc) return null;

    const btn = document.createElement("button");
    btn.title = "把当前节点保存的视频导入达芬奇（进媒体池 + 复用空白轨道/无则新建 + 对齐播放头片段前端）";
    btn.style.cssText =
        "position:absolute;top:6px;left:6px;z-index:102;" +
        "display:inline-flex;align-items:center;gap:4px;" +
        "padding:2px 6px;font-size:11px;line-height:1;" +
        "background:transparent;color:#3ef558;border:none;" +
        "cursor:pointer;pointer-events:auto;" +
        "transition:color 0.15s,opacity 0.2s;opacity:0;";
    btn.innerHTML = '<span style="font-size:13px;">🎬</span><span>导出到达芬奇</span>';
    const labelSpan = btn.querySelector("span:last-child");
    pc.appendChild(btn);

    const onOver = () => { btn.style.opacity = "1"; };
    const onOut = (e) => {
        if (!pc.contains(e.relatedTarget) && !btn.disabled) btn.style.opacity = "0";
    };
    pc.addEventListener("mouseover", onOver);
    pc.addEventListener("mouseout", onOut);

    btn.addEventListener("mouseenter", () => { if (!btn.disabled) btn.style.color = "#fff"; });
    btn.addEventListener("mouseleave", () => { if (!btn.disabled) btn.style.color = "#3ef558"; });
    btn.onclick = () => { if (!btn.disabled) _exportToDavinci(node, btn, labelSpan, "导出到达芬奇"); };

    node._xzgDavinciSaveBtn = btn;
    return btn;
}

app.registerExtension({
    name: "Xiaozhuguang.VideoSave.DaVinci",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData?.name !== SAVE_DAVINCI_NODE) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            // 父类注册器已在本节点的 onNodeCreated 里创建好预览容器；
            // 这里在其基础上叠加「导出到达芬奇」悬浮按钮。父类注册器是同一扩展，
            // 需等它执行完（onNodeCreated 内 addDOMWidget）。用 rAF 确保容器已就绪。
            requestAnimationFrame(() => {
                _createExportDavinciButton(this);
            });
            return r;
        };
    },
});