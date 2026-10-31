import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { videoQueuePrompts } from "./lib/xzg_multi_video_queue.mjs";

const NODE_TYPE = "XiaozhuguangVideoLoaderDaVinci";
const jobs = new Map();
let submitting = false;

function selectVideo(node, filename) {
    const widget = node.widgets?.find(w => w.name === "视频");
    if (!widget) return;
    widget.options ||= {};
    const values = widget.options.values;
    if (Array.isArray(values) && !values.includes(filename)) values.push(filename);
    widget.value = filename;
    widget.callback?.(filename);
    node.setDirtyCanvas?.(true, true);
    node._xzgRenderVideoQueue?.();
}

export function bindMultiVideoQueue(node) {
    node.properties ||= {};
    const host = node._xzgVideoPreviewHost;
    const preview = node._xzgVideoPreviewContainer;
    if (!host || !preview || node._xzgRenderVideoQueue) return;
    const panel = document.createElement("div");
    panel.style.cssText = "flex:0 0 108px;min-width:0;min-height:0;max-height:100%;overflow-y:auto;pointer-events:auto;" +
        "box-sizing:border-box;background:#171a20;padding:5px;display:none;font:11px sans-serif;color:#eee;";
    panel.addEventListener("wheel", event => {
        const canvas = app.canvas?.canvas;
        if (!canvas) return;
        event.preventDefault();
        event.stopPropagation();
        canvas.dispatchEvent(new WheelEvent("wheel", {
            deltaY: event.deltaY, deltaX: event.deltaX, deltaMode: event.deltaMode,
            clientX: event.clientX, clientY: event.clientY,
            ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey,
            bubbles: true, cancelable: true,
        }));
    }, { passive: false });
    const divider = document.createElement("div");
    divider.title = "拖动调整列表与预览宽度";
    divider.style.cssText = "flex:0 0 6px;background:#353b44;cursor:col-resize;" +
        "pointer-events:auto;touch-action:none;display:none;align-self:stretch;";
    host.prepend(panel, divider);
    const applySplit = () => {
        const ratio = Math.max(0.15, Math.min(0.6, Number(node.properties.xzgVideoListRatio) || 0.24));
        panel.style.flex = `0 0 ${ratio * 100}%`;
        node._xzgVideoPlayer?.resize();
    };
    let dragPointer = null;
    divider.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        dragPointer = event.pointerId;
        divider.setPointerCapture(event.pointerId);
        divider.style.background = "#ffd76a";
    });
    divider.addEventListener("pointermove", event => {
        if (event.pointerId !== dragPointer) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = host.getBoundingClientRect();
        if (!rect.width) return;
        node.properties.xzgVideoListRatio = Math.max(0.15, Math.min(0.6, (event.clientX - rect.left) / rect.width));
        applySplit();
    });
    const finishDrag = event => {
        if (event.pointerId !== dragPointer) return;
        event.stopPropagation();
        dragPointer = null;
        if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
        divider.style.background = "#353b44";
        node.setDirtyCanvas?.(true, true);
    };
    divider.addEventListener("pointerup", finishDrag);
    divider.addEventListener("pointercancel", finishDrag);
    divider.addEventListener("lostpointercapture", finishDrag);
    const entries = () => node.properties.xzgVideoQueue ||= [];
    const states = new Map();
    const render = () => {
        const enabled = !!node.properties.xzgMultiVideo;
        panel.style.display = enabled ? "block" : "none";
        divider.style.display = enabled ? "block" : "none";
        host.style.display = enabled ? "flex" : "";
        preview.style.flex = enabled ? "1 1 0" : "";
        preview.style.minWidth = "0";
        if (enabled) applySplit();
        panel.replaceChildren();
        const heading = document.createElement("div");
        heading.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:4px;padding:4px 0 8px;color:#ffd76a;font-weight:bold";
        const title = document.createElement("span");
        title.textContent = `视频队列（${entries().length}）`;
        const clear = document.createElement("button");
        clear.textContent = "清空";
        clear.disabled = !!node._xzgVideoQueuePending || !entries().length;
        clear.title = "清空列表（不删除文件）";
        clear.style.cssText = "flex-shrink:0;background:#222b;color:#eee;border:1px solid #444;border-radius:3px;padding:2px 5px;cursor:pointer";
        clear.onclick = event => {
            event.stopPropagation();
            entries().length = 0;
            states.clear();
            render();
            node.setDirtyCanvas?.(true, true);
        };
        heading.append(title, clear);
        panel.appendChild(heading);
        entries().forEach((filename, index) => {
            const card = document.createElement("div");
            const selected = node.widgets?.find(w => w.name === "视频")?.value === filename;
            card.style.cssText = `position:relative;margin-bottom:7px;border:1px solid ${selected ? "#ffd76a" : "#444"};border-radius:4px;overflow:hidden;cursor:pointer`;
            card.title = filename;
            const caption = document.createElement("div");
            caption.style.cssText = "padding:6px 18px 4px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
            caption.textContent = `${index + 1}. ${filename.split(/[\\/]/).pop()}`;
            const status = document.createElement("div");
            status.style.cssText = "padding:0 4px 4px;color:#8acbff";
            status.textContent = states.get(index) || "待运行";
            const remove = document.createElement("button");
            remove.textContent = "×";
            remove.disabled = !!node._xzgVideoQueuePending;
            remove.title = "从列表移除（不删除文件）";
            remove.style.cssText = "position:absolute;right:0;top:0;background:#222b;color:white;border:0;cursor:pointer";
            remove.onclick = event => {
                event.stopPropagation();
                entries().splice(index, 1);
                states.clear();
                render();
                node.setDirtyCanvas?.(true, true);
            };
            card.append(caption, status, remove);
            card.onclick = () => selectVideo(node, filename);
            panel.appendChild(card);
        });
    };
    node._xzgRenderVideoQueue = render;
    node._xzgSetVideoQueueStatus = (index, text) => { states.set(index, text); render(); };
    node._xzgAppendVideoQueue = filenames => {
        if (!node.properties.xzgMultiVideo) return;
        entries().push(...filenames);
        render();
        node.setDirtyCanvas?.(true, true);
    };
    const toggle = node.addWidget("toggle", "多视频队列", !!node.properties.xzgMultiVideo, value => {
        node.properties.xzgMultiVideo = !!value;
        if (value && !node._xzgVideoQueuePending) {
            const current = node.widgets?.find(widget => widget.name === "视频")?.value;
            if (current && current !== "xzg_fallback_reference.mp4") {
                node.properties.xzgVideoQueue = [current, ...entries().filter(filename => filename !== current)];
                states.clear();
            }
        }
        render();
        node._xzgVideoPlayer?.resize();
    }, { serialize: false });
    toggle.serialize = false;
    const positionToggle = () => {
        const current = node.widgets.indexOf(toggle);
        if (current >= 0) node.widgets.splice(current, 1);
        const upload = node.widgets.findIndex(widget => widget.name === "上传视频");
        node.widgets.splice(upload >= 0 ? upload : node.widgets.length, 0, toggle);
    };
    positionToggle();
    const configure = node.onConfigure;
    node.onConfigure = function () {
        const result = configure?.apply(this, arguments);
        toggle.value = !!node.properties.xzgMultiVideo;
        positionToggle();
        render();
        return result;
    };
    render();
}

app.registerExtension({
    name: "XZG.MultiVideoQueue",
    setup() {
        const queuePrompt = api.queuePrompt;
        api.queuePrompt = async function (index, prompt, ...rest) {
            const nodes = (app.graph?._nodes || []).filter(node => node.type === NODE_TYPE
                && node.mode !== 4 && node.properties?.xzgMultiVideo
                && prompt?.output?.[String(node.id)]);
            if (prompt?.xzgExecuteToNode || !nodes.length) return queuePrompt.call(this, index, prompt, ...rest);
            if (submitting) throw new Error("视频队列正在提交，请等待提交完成。");
            if (nodes.length > 1) throw new Error("一次运行仅支持一个开启多视频队列的加载器。");
            if (Object.values(prompt.output).some(n => n.class_type === "XiaozhuguangVideoScheduler")) {
                throw new Error("多视频队列暂不能与场景逐段批处理同时使用，请关闭多视频队列或移除分段节点。");
            }
            const node = nodes[0];
            if (node._xzgVideoQueuePending) throw new Error("该视频队列尚未执行完，请先等待完成或在任务队列中取消。");
            const filenames = [...(node.properties.xzgVideoQueue || [])];
            if (!filenames.length) throw new Error("视频队列为空，请先上传或从达芬奇导入视频。");
            if (Array.isArray(prompt.output[String(node.id)].inputs["视频"])) {
                throw new Error("多视频队列需要使用加载器自身的视频选择，请断开视频文件名输入连线。");
            }
            const widgetIndex = node.widgets.filter(w => w.serialize !== false).findIndex(w => w.name === "视频");
            const prompts = videoQueuePrompts(prompt, node.id, filenames, Math.max(0, widgetIndex));
            submitting = true;
            let first;
            try {
                for (let i = 0; i < prompts.length; i++) {
                    // ComfyUI's back queue executes complete prompts serially, in list order.
                    const result = await queuePrompt.call(this, 0, prompts[i], ...rest);
                    if (!result?.prompt_id) throw new Error(`第 ${i + 1} 个视频提交失败，后续视频未提交。`);
                    jobs.set(result.prompt_id, { node, index: i, filename: filenames[i] });
                    node._xzgVideoQueuePending = (node._xzgVideoQueuePending || 0) + 1;
                    node._xzgSetVideoQueueStatus?.(i, "已排队");
                    first ||= result;
                }
                return first;
            } finally {
                submitting = false;
            }
        };
        for (const [event, label] of [["execution_start", "运行中"], ["execution_success", "已完成"],
            ["execution_error", "失败"], ["execution_interrupted", "已中断"]]) {
            api.addEventListener(event, ({ detail }) => {
                const job = jobs.get(detail?.prompt_id);
                if (!job) return;
                if (event === "execution_start") selectVideo(job.node, job.filename);
                else {
                    jobs.delete(detail.prompt_id);
                    job.node._xzgVideoQueuePending = Math.max(0, (job.node._xzgVideoQueuePending || 0) - 1);
                }
                job.node._xzgSetVideoQueueStatus?.(job.index, label);
            });
        }
        let queueCheck;
        api.addEventListener("status", () => {
            clearTimeout(queueCheck);
            if (!jobs.size) return;
            queueCheck = setTimeout(async () => {
                if (submitting) return;
                try {
                    const response = await api.fetchApi("/queue");
                    if (!response.ok) return;
                    const queue = await response.json();
                    const active = new Set([...(queue.queue_running || []), ...(queue.queue_pending || [])]
                        .map(entry => entry[1]));
                    for (const [id, job] of jobs) {
                        if (active.has(id)) continue;
                        jobs.delete(id);
                        job.node._xzgVideoQueuePending = Math.max(0, (job.node._xzgVideoQueuePending || 0) - 1);
                        job.node._xzgSetVideoQueueStatus?.(job.index, "已结束 / 已移除");
                    }
                } catch (error) {
                    console.warn("[小珠光视频队列] 队列状态读取失败", error);
                }
            }, 500);
        });
    },
});
