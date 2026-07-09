import { app } from "../../scripts/app.js";

const MODEL_DIR = "models/LLM/Qwen-VL";

function createTooltip() {
    const tip = document.createElement("div");
    tip.style.cssText = `
        position: fixed;
        z-index: 99999;
        background: rgba(30, 30, 30, 0.95);
        color: #fff;
        padding: 6px 10px;
        border-radius: 4px;
        font-size: 12px;
        font-family: sans-serif;
        pointer-events: none;
        display: none;
        border: 1px solid #555;
        white-space: nowrap;
    `;
    document.body.appendChild(tip);
    return tip;
}

let tooltipEl = null;

function showTooltip(text, x, y) {
    if (!tooltipEl) tooltipEl = createTooltip();
    tooltipEl.textContent = text;
    tooltipEl.style.display = "block";
    const rect = tooltipEl.getBoundingClientRect();
    let left = x + 12;
    let top = y + 12;
    if (left + rect.width > window.innerWidth) left = x - rect.width - 12;
    if (top + rect.height > window.innerHeight) top = y - rect.height - 12;
    tooltipEl.style.left = left + "px";
    tooltipEl.style.top = top + "px";
}

function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
}

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.qwen",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "XiaozhuguangQwenVLInstruct") {
            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (origOnNodeCreated) origOnNodeCreated.apply(this, arguments);
                const node = this;

                requestAnimationFrame(() => {
                    const widget = node.widgets?.find(w => w.name === "model");
                    if (!widget || !widget.element) return;

                    const combo = widget.element;
                    combo.addEventListener("mouseenter", (e) => {
                        const val = widget.value || "";
                        const path = `${MODEL_DIR}/${val}`;
                        showTooltip(`模型路径：${path}`, e.clientX, e.clientY);
                    });
                    combo.addEventListener("mousemove", (e) => {
                        const val = widget.value || "";
                        const path = `${MODEL_DIR}/${val}`;
                        showTooltip(`模型路径：${path}`, e.clientX, e.clientY);
                    });
                    combo.addEventListener("mouseleave", () => {
                        hideTooltip();
                    });
                });
            };
        }
    },
});
