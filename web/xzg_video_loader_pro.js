/**
 * 小珠光视频加载-化神级 · 前端入口
 *
 * 节点交互复用 xzg_video_loader.js（两个节点名共用一个 beforeRegisterNodeDef）
 * 本文件只做: 在 Pro 节点上追加「🎬 视频编辑器」按钮, 点击打开多视频编辑器
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { XiaozhuguangVideoEditor } from "./xzg_video_editor.js";

// 与「上传视频」按钮完全一致的绘制风格（圆角 r=6, 底色 #2a2a2a, 边框 #444）
function _xzgDrawButtonWidget(ctx, node, width, y, H) {
    const pad = 16, r = 6;
    const w = width - pad * 2;
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(pad, y + 1, w, H - 2, r); } else { ctx.rect(pad, y + 1, w, H - 2); }
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label || this.name || this.value || '', width / 2, y + H / 2);
}

// 从当前节点读取 filename + type
function _xzgProGetCurrentVideo(node) {
    const w = node.widgets?.find(w => w.name === "视频");
    if (!w) return { filename: "", type: "input" };
    let name = w.value || "";
    let type = "input";
    const suffixes = [" [output]", " [input]", " [temp]"];
    for (const s of suffixes) {
        if (name.endsWith(s)) {
            type = s.trim().slice(1, -1);
            name = name.slice(0, -s.length);
            break;
        }
    }
    return { filename: name, type };
}

// 刷新 Pro 节点的视频下拉列表
async function _xzgProRefreshVideoCombo(node, selectName) {
    const videoWidget = node.widgets?.find(w => w.name === "视频");
    if (!videoWidget) return;
    try {
        const resp = await api.fetchApi("/object_info/XiaozhuguangVideoLoaderPro");
        if (!resp.ok) return;
        const info = await resp.json();
        const list = info?.XiaozhuguangVideoLoaderPro?.input?.required?.["视频"]?.[0];
        if (Array.isArray(list)) {
            videoWidget.options.values = list;
            if (selectName && list.includes(selectName)) {
                videoWidget.value = selectName;
            } else if (list.length > 0) {
                videoWidget.value = list[list.length - 1];
            }
            videoWidget.callback?.(videoWidget.value);
        }
    } catch (_) {}
}

app.registerExtension({
    name: "xiaozhuguang.video_loader_pro",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "XiaozhuguangVideoLoaderPro") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            requestAnimationFrame(() => {
                if (this.widgets?.some(w => w.name === "视频编辑器")) return;
                const btn = this.addWidget("button", "视频编辑器", "edit", () => {
                    const { filename, type } = _xzgProGetCurrentVideo(this);
                    // 打开编辑器（无论当前是否选了视频，都可进入编辑器再添加视频）
                    const editor = new XiaozhuguangVideoEditor({
                        filename: filename,
                        type: type,
                        onCancel: () => {},
                        onApplied: async (newFilename, newType) => {
                            await _xzgProRefreshVideoCombo(this, newFilename);
                            const previewWidget = this.widgets?.find(w => w.name === "xzg_video_preview");
                            if (previewWidget?.setValue) {
                                previewWidget.setValue(newFilename);
                            }
                            this.setDirtyCanvas?.(true, true);
                        },
                    });
                    editor.open();
                });
                btn.options.serialize = false;
                // 应用与「上传视频」一致的绘制风格（圆角等）
                btn.draw = _xzgDrawButtonWidget;
                // 把编辑器按钮移到「上传视频」按钮正下方
                const widgets = this.widgets || [];
                const editorIdx = widgets.indexOf(btn);
                const uploadIdx = widgets.findIndex(w => w.name === "上传视频");
                if (uploadIdx >= 0 && editorIdx > uploadIdx + 1) {
                    widgets.splice(editorIdx, 1);
                    widgets.splice(uploadIdx + 1, 0, btn);
                }
                this.setDirtyCanvas?.(true, true);
            });
            return r;
        };
    },
});
