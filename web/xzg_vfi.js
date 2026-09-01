import { app } from "../../scripts/app.js";
import { xzgLang } from "./xzg_i18n.js";

// ═══════════════════════════════════════════════════════════════════════
// 小珠光VFI：中/英 双语标签
// ═══════════════════════════════════════════════════════════════════════
// 后端 INPUT_TYPES 用英文参数名（model/interpolation_factor/...），
// 这里按当前语言覆盖 widget 的显示 label：英文用语义化英文，中文用中文。
const _INPUT_LABEL = {
    "images":                 ["插值图像",           "Images"],
    "model":                  ["插值模型",           "Model"],
    "interpolation_factor":   ["补帧倍数",           "Interpolation Factor"],
    "ds_factor":              ["下采样因子",         "Downsample Factor"],
    "precision":              ["精度",               "Precision"],
    "torch_compile":          ["编译加速(首次编译慢)", "Torch Compile (slow first compile)"],
    "input_fps":              ["原始帧率",           "Input FPS"],
};
const _OUTPUT_LABEL = {
    "images":     ["插值图像", "Images"],
    "output_fps": ["输出帧率", "Output FPS"],
};
// model 下拉框的悬停提示（英文版本；中文版由后端提供含绝对路径的 tooltip）
const _MODEL_TOOLTIP_EN =
    "Model files go into: ComfyUI/models/interpolation/gimm-vfi/\n" +
    "The flow-estimator weight for this char (raft-things_fp32.safetensors / " +
    "flowformer_sintel_fp32.safetensors) goes in the same folder.\n" +
    "If missing they are auto-downloaded from HuggingFace (requires internet).";

function _label(map, name) {
    const p = map[name];
    if (!p) return name;
    return xzgLang() === "en" ? p[1] : p[0];
}

app.registerExtension({
    name: "Xiaozhuguang.VFI",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangVFI") return;

        // 英文界面时把 model 下拉悬停提示换成英文
        if (xzgLang() === "en") {
            try {
                if (nodeData.input?.required?.["model"]?.[1]) {
                    nodeData.input.required.model[1].tooltip = _MODEL_TOOLTIP_EN;
                }
            } catch (e) { /* 非致命 */ }
        }

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            try {
                if (this.inputs) {
                    for (const inp of this.inputs) {
                        const lbl = _label(_INPUT_LABEL, inp.name);
                        if (lbl) inp.label = lbl;
                    }
                }
                if (this.widgets) {
                    for (const w of this.widgets) {
                        w.label = _label(_INPUT_LABEL, w.name) || w.label;
                    }
                }
                if (this.outputs) {
                    for (const out of this.outputs) {
                        const lbl = _label(_OUTPUT_LABEL, out.name);
                        if (lbl) { out.name = lbl; out.label = lbl; }
                    }
                }
            } catch (e) { /* 非致命 */ }
            return r;
        };
    },
});