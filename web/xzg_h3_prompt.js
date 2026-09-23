import { app } from "../../scripts/app.js";
import { xzgLang } from "./xzg_i18n.js";

const H3_PREFIX = "Minimax-H3 ";
const H3_GEN_MODES = [
    "Text to Video (T2VA)", "Image to Video (I2VA)", "First+Last Frame (FL2VA)",
    "Last Frame (L2VA)", "Full Reference (Ref2VA)",
].map(value => `${H3_PREFIX}${value}`);
const QWEN_IMAGE_TARGET = "Qwen-Image-2.1 图像";
const QWEN_IMAGE_MODES = [
    "Qwen-Image-2.1 文生图",
    "Qwen-Image-2.1 图像编辑",
    "Qwen-Image-2.1 多参考图",
];
const H3_ZH_STYLES = [
    "无 (默认)", "极简产品广告", "3D动画短片", "纸艺定格科普",
    "品牌宣传短片", "音乐美学MV", "双人游戏开场", "纸拼贴讲解", "手绘实拍融合",
].map((value, index) => index === 0 ? value : `${H3_PREFIX}${value}`);
const H3_EN_STYLES = [
    "None (Default)", "Minimalist Product Ad", "3D Animated Short", "Papercraft Stop-Motion",
    "Brand Promo Video", "Music Video", "Co-op Game Intro", "Paper Collage Explainer", "Hand-drawn + Live-action",
].map((value, index) => index === 0 ? value : `${H3_PREFIX}${value}`);
const H3_LEGACY_GEN_MODE_MAP = {
    "Text to Video (T2VA)": H3_GEN_MODES[0], "Image to Video (I2VA)": H3_GEN_MODES[1],
    "First+Last Frame (FL2VA)": H3_GEN_MODES[2], "Last Frame (L2VA)": H3_GEN_MODES[3],
    "Full Reference (Ref2VA)": H3_GEN_MODES[4],
    "文生视频 (T2VA)": H3_GEN_MODES[0], "图生视频 (I2VA)": H3_GEN_MODES[1],
    "首尾帧 (FL2VA)": H3_GEN_MODES[2], "尾帧 (L2VA)": H3_GEN_MODES[3], "全参考 (Ref2VA)": H3_GEN_MODES[4],
};
const H3_ZH_STYLE_MAP = {
    "None (Default)": H3_ZH_STYLES[0], "Minimalist Product Ad": H3_ZH_STYLES[1],
    "3D Animated Short": H3_ZH_STYLES[2], "Papercraft Stop-Motion": H3_ZH_STYLES[3],
    "Brand Promo Video": H3_ZH_STYLES[4], "Music Video": H3_ZH_STYLES[5],
    "Co-op Game Intro": H3_ZH_STYLES[6], "Paper Collage Explainer": H3_ZH_STYLES[7],
    "Hand-drawn + Live-action": H3_ZH_STYLES[8],
    "无 (默认)": H3_ZH_STYLES[0], "极简产品广告": H3_ZH_STYLES[1], "3D动画短片": H3_ZH_STYLES[2],
    "纸艺定格科普": H3_ZH_STYLES[3], "品牌宣传短片": H3_ZH_STYLES[4], "音乐美学MV": H3_ZH_STYLES[5],
    "双人游戏开场": H3_ZH_STYLES[6], "纸拼贴讲解": H3_ZH_STYLES[7], "手绘实拍融合": H3_ZH_STYLES[8],
};
const H3_EN_STYLE_MAP = {
    "None (Default)": H3_EN_STYLES[0], "Minimalist Product Ad": H3_EN_STYLES[1],
    "3D Animated Short": H3_EN_STYLES[2], "Papercraft Stop-Motion": H3_EN_STYLES[3],
    "Brand Promo Video": H3_EN_STYLES[4], "Music Video": H3_EN_STYLES[5],
    "Co-op Game Intro": H3_EN_STYLES[6], "Paper Collage Explainer": H3_EN_STYLES[7],
    "Hand-drawn + Live-action": H3_EN_STYLES[8],
    "无 (默认)": H3_EN_STYLES[0], "极简产品广告": H3_EN_STYLES[1], "3D动画短片": H3_EN_STYLES[2],
    "纸艺定格科普": H3_EN_STYLES[3], "品牌宣传短片": H3_EN_STYLES[4], "音乐美学MV": H3_EN_STYLES[5],
    "双人游戏开场": H3_EN_STYLES[6], "纸拼贴讲解": H3_EN_STYLES[7], "手绘实拍融合": H3_EN_STYLES[8],
};
// 同一工作流在中英文界面间切换时，也保留已带前缀的选项。
H3_EN_STYLES.forEach((value, index) => { H3_ZH_STYLE_MAP[value] = H3_ZH_STYLES[index]; });
H3_ZH_STYLES.forEach((value, index) => { H3_EN_STYLE_MAP[value] = H3_EN_STYLES[index]; });
H3_ZH_STYLE_MAP[`${H3_PREFIX}无 (默认)`] = H3_ZH_STYLES[0];
H3_ZH_STYLE_MAP[`${H3_PREFIX}None (Default)`] = H3_ZH_STYLES[0];
H3_EN_STYLE_MAP[`${H3_PREFIX}无 (默认)`] = H3_EN_STYLES[0];
H3_EN_STYLE_MAP[`${H3_PREFIX}None (Default)`] = H3_EN_STYLES[0];

app.registerExtension({
    name: "Xiaozhuguang.H3Prompt",
    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        // ── 小珠光 Minimax-H3 提示词 ──
        if (nodeData.name === "XiaozhuguangNinimaxH3Prompt") {
            // 获取图片接口名称（始终使用 image_N 格式，本地化通过 locale 文件处理）
            nodeType.prototype._xzgImgName = function (num) {
                return `image_${num}`;
            };

            // 判断是否为动态图片接口
            nodeType.prototype._isXzgImg = function (inp) {
                if (!inp || !inp.name) return false;
                return inp.name.startsWith("image_");
            };

            // 从名称中提取编号
            nodeType.prototype._xzgImgNum = function (name) {
                if (name.startsWith("image_")) return parseInt(name.split("_")[1]);
                return NaN;
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated?.apply(this, arguments);
                this.setSize([300, this.size[1]]);
                this._hideExtraImageInputs();
                this._translateStylePreset();
                this._syncTargetModel();
                const targetWidget = this.widgets?.find(w => w.name === "target_model");
                if (targetWidget) {
                    const originalCallback = targetWidget.callback;
                    targetWidget.callback = (...args) => {
                        const result = originalCallback?.apply(targetWidget, args);
                        this._syncTargetModel();
                        return result;
                    };
                }
                return r;
            };

            // 根据语言环境显示带 Minimax-H3 前缀的下拉项，并迁移旧工作流值。
            nodeType.prototype._translateStylePreset = function () {
                const lang = xzgLang();
                const gmWidget = this.widgets?.find(w => w.name === "generation_mode");
                if (gmWidget && gmWidget.options) {
                    gmWidget.options.values = H3_GEN_MODES;
                    gmWidget.value = H3_LEGACY_GEN_MODE_MAP[gmWidget.value]
                        || (H3_GEN_MODES.includes(gmWidget.value) ? gmWidget.value : H3_GEN_MODES[0]);
                }

                const spWidget = this.widgets?.find(w => w.name === "style_preset");
                if (spWidget && spWidget.options) {
                    const styleValues = lang === "zh" ? H3_ZH_STYLES : H3_EN_STYLES;
                    const styleMap = lang === "zh" ? H3_ZH_STYLE_MAP : H3_EN_STYLE_MAP;
                    spWidget.options.values = styleValues;
                    spWidget.value = styleMap[spWidget.value]
                        || (styleValues.includes(spWidget.value) ? spWidget.value : styleValues[0]);
                }
            };

            // Qwen-Image-2.1 使用图像生成/编辑模式；H3 保持视频生成模式。
            nodeType.prototype._syncTargetModel = function () {
                const targetWidget = this.widgets?.find(w => w.name === "target_model");
                const gmWidget = this.widgets?.find(w => w.name === "generation_mode");
                if (!gmWidget?.options) return;
                if (targetWidget?.value === QWEN_IMAGE_TARGET) {
                    gmWidget.options.values = QWEN_IMAGE_MODES;
                    if (!QWEN_IMAGE_MODES.includes(gmWidget.value)) gmWidget.value = QWEN_IMAGE_MODES[0];
                } else {
                    gmWidget.options.values = H3_GEN_MODES;
                    gmWidget.value = H3_LEGACY_GEN_MODE_MAP[gmWidget.value]
                        || (H3_GEN_MODES.includes(gmWidget.value) ? gmWidget.value : H3_GEN_MODES[0]);
                }
            };

            nodeType.prototype._hideExtraImageInputs = function () {
                for (let i = this.inputs.length - 1; i >= 0; i--) {
                    const inp = this.inputs[i];
                    if (inp && this._isXzgImg(inp)) {
                        const num = this._xzgImgNum(inp.name);
                        if (num === 1) continue; // 永远保留第一个图片接口
                        this.removeInput(i);
                    }
                }
            };

            // 核心：统一调整图片输入接口（参照 number_switch 的简洁模式）
            // 规则：已连接的接口左移填补空位，末尾保留一个空接口，最少 1 个，最多 9 个
            nodeType.prototype._adjustImageInputs = function () {
                if (!this.inputs) return;
                if (this._adjustingImageInputs) return;
                this._adjustingImageInputs = true;
                try {
                    // 收集所有图片接口
                    let imgInputs = [];
                    for (const inp of this.inputs) {
                        if (this._isXzgImg(inp)) imgInputs.push(inp);
                    }

                    // 统计已连接数量
                    let connectedCount = 0;
                    for (const inp of imgInputs) {
                        if (inp.link != null) connectedCount++;
                    }

                    // 紧凑化：将已连接的 link 左移填补空位
                    let writeIdx = 0;
                    for (let readIdx = 0; readIdx < imgInputs.length; readIdx++) {
                        const inp = imgInputs[readIdx];
                        if (inp.link != null) {
                            if (readIdx > writeIdx) {
                                const target = imgInputs[writeIdx];
                                target.link = inp.link;
                                inp.link = null;
                                // 更新 link 对象的 target_slot
                                const linkObj = this.graph && this.graph.links[target.link];
                                if (linkObj) {
                                    const targetSlot = this.inputs.indexOf(target);
                                    if (targetSlot >= 0) linkObj.target_slot = targetSlot;
                                }
                            }
                            writeIdx++;
                        }
                    }

                    // 重新统计（紧凑化后）
                    imgInputs = [];
                    for (const inp of this.inputs) {
                        if (this._isXzgImg(inp)) imgInputs.push(inp);
                    }
                    connectedCount = 0;
                    for (const inp of imgInputs) {
                        if (inp.link != null) connectedCount++;
                    }

                    // 目标数量 = 已连接 + 1 个空位，最少 1，最多 9
                    const desiredLen = Math.min(connectedCount + 1, 9);

                    if (imgInputs.length < desiredLen) {
                        // 添加不足的接口
                        for (let i = imgInputs.length; i < desiredLen; i++) {
                            this.addInput(this._xzgImgName(i + 1), "IMAGE", {
                                optional: true,
                                tooltip: `可选：参考图片${i + 1} / Reference image ${i + 1}`,
                            });
                        }
                        // 仅在高度不足时增大，保持当前宽度不变
                        const computed = this.computeSize();
                        if (computed[1] > this.size[1]) {
                            this.setSize([this.size[0], computed[1]]);
                        }
                        if (app.graph) app.graph.setDirtyCanvas(true, true);
                    } else if (imgInputs.length > desiredLen) {
                        // 从末尾移除多余的空图片接口
                        let removed = 0;
                        const toRemove = imgInputs.length - desiredLen;
                        for (let i = this.inputs.length - 1; i >= 0 && removed < toRemove; i--) {
                            if (this.inputs[i] && this.inputs[i].link == null && this._isXzgImg(this.inputs[i])) {
                                this.removeInput(i);
                                removed++;
                            }
                        }
                        if (removed > 0) {
                            if (app.graph) app.graph.setDirtyCanvas(true, true);
                        }
                    }

                    // 重编号为 image_1, image_2, ...
                    let num = 1;
                    for (const inp of this.inputs) {
                        if (this._isXzgImg(inp)) {
                            const expected = this._xzgImgName(num);
                            if (inp.name !== expected) inp.name = expected;
                            num++;
                        }
                    }
                } finally {
                    this._adjustingImageInputs = false;
                }
            };

            // 连接/断连时延迟调用 _adjustImageInputs
            // 用 setTimeout 合并连续的连接/断连事件，跳过子图操作的中间状态
            const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (slotType, slotIndex, connected, link, _info) {
                const r = origOnConnectionsChange?.apply(this, arguments);
                if (slotType === LiteGraph.INPUT) {
                    clearTimeout(this._adjustImgTimer);
                    this._adjustImgTimer = setTimeout(() => {
                        if (!this.graph || this._removed) return;
                        try { this._adjustImageInputs(); }
                        catch (e) { /* 节点状态不一致时忽略 */ }
                    }, 100);
                }
                return r;
            };

            // 从工作流加载时调整图片接口
            const origConfigure = nodeType.prototype.configure;
            nodeType.prototype.configure = function (info) {
                const r = origConfigure?.apply(this, arguments);
                // 子图解包时 configure 早于连线恢复；此刻增删/重编号端口会让恢复目标槽位消失。
                // 等到当前批次的连接变更全部完成后再统一整理。
                clearTimeout(this._adjustImgTimer);
                this._adjustImgTimer = setTimeout(() => {
                    if (!this.graph || this._removed) return;
                    try { this._adjustImageInputs(); }
                    catch (e) { /* 子图操作时可能状态不一致，忽略 */ }
                }, 350);
                return r;
            };
        }
    },
});
