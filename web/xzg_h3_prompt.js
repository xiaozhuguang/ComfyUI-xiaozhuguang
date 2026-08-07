import { app } from "../../scripts/app.js";
import { xzgLang } from "./xzg_i18n.js";

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
                return r;
            };

            // 根据语言环境翻译下拉选项并去重
            nodeType.prototype._translateStylePreset = function () {
                const lang = xzgLang();

                if (lang === "zh") {
                    // 中文环境：生成模式统一用英文（便于上游输入字符串匹配），风格预设保留中文
                    const enGenModes = new Set([
                        "Text to Video (T2VA)", "Image to Video (I2VA)", "First+Last Frame (FL2VA)", "Last Frame (L2VA)", "Full Reference (Ref2VA)"
                    ]);
                    const zhStyles = new Set([
                        "无 (默认)", "极简产品广告", "3D动画短片", "纸艺定格科普",
                        "品牌宣传短片", "音乐美学MV", "双人游戏开场", "纸拼贴讲解", "手绘实拍融合"
                    ]);

                    // 生成模式：保持英文，仅过滤掉历史中文值
                    const gmWidget = this.widgets?.find(w => w.name === "generation_mode");
                    if (gmWidget && gmWidget.options) {
                        gmWidget.options.values = gmWidget.options.values.filter(v => enGenModes.has(v));
                        // 历史中文值映射为英文
                        const zhToEn = {
                            "文生视频 (T2VA)": "Text to Video (T2VA)",
                            "图生视频 (I2VA)": "Image to Video (I2VA)",
                            "首尾帧 (FL2VA)": "First+Last Frame (FL2VA)",
                            "尾帧 (L2VA)": "Last Frame (L2VA)",
                            "全参考 (Ref2VA)": "Full Reference (Ref2VA)",
                        };
                        gmWidget.value = zhToEn[gmWidget.value] || (enGenModes.has(gmWidget.value) ? gmWidget.value : "Text to Video (T2VA)");
                    }

                    // 风格预设
                    const spWidget = this.widgets?.find(w => w.name === "style_preset");
                    if (spWidget && spWidget.options) {
                        spWidget.options.values = spWidget.options.values.filter(v => zhStyles.has(v));
                        const enToZh = {
                            "None (Default)": "无 (默认)",
                            "Minimalist Product Ad": "极简产品广告",
                            "3D Animated Short": "3D动画短片",
                            "Papercraft Stop-Motion": "纸艺定格科普",
                            "Brand Promo Video": "品牌宣传短片",
                            "Music Video": "音乐美学MV",
                            "Co-op Game Intro": "双人游戏开场",
                            "Paper Collage Explainer": "纸拼贴讲解",
                            "Hand-drawn + Live-action": "手绘实拍融合",
                        };
                        spWidget.value = enToZh[spWidget.value] || spWidget.value;
                    }
                } else {
                    // 英文环境：只保留英文选项
                    const enGenModes = new Set([
                        "Text to Video (T2VA)", "Image to Video (I2VA)", "First+Last Frame (FL2VA)", "Last Frame (L2VA)", "Full Reference (Ref2VA)"
                    ]);
                    const enStyles = new Set([
                        "None (Default)", "Minimalist Product Ad", "3D Animated Short", "Papercraft Stop-Motion",
                        "Brand Promo Video", "Music Video", "Co-op Game Intro", "Paper Collage Explainer", "Hand-drawn + Live-action"
                    ]);

                    // 生成模式
                    const gmWidget = this.widgets?.find(w => w.name === "generation_mode");
                    if (gmWidget && gmWidget.options) {
                        gmWidget.options.values = gmWidget.options.values.filter(v => enGenModes.has(v));
                        const zhToEn = {
                            "文生视频 (T2VA)": "Text to Video (T2VA)",
                            "图生视频 (I2VA)": "Image to Video (I2VA)",
                            "首尾帧 (FL2VA)": "First+Last Frame (FL2VA)",
                            "尾帧 (L2VA)": "Last Frame (L2VA)",
                            "全参考 (Ref2VA)": "Full Reference (Ref2VA)",
                        };
                        gmWidget.value = zhToEn[gmWidget.value] || gmWidget.value;
                    }

                    // 风格预设
                    const spWidget = this.widgets?.find(w => w.name === "style_preset");
                    if (spWidget && spWidget.options) {
                        spWidget.options.values = spWidget.options.values.filter(v => enStyles.has(v));
                        const zhToEn = {
                            "无 (默认)": "None (Default)",
                            "极简产品广告": "Minimalist Product Ad",
                            "3D动画短片": "3D Animated Short",
                            "纸艺定格科普": "Papercraft Stop-Motion",
                            "品牌宣传短片": "Brand Promo Video",
                            "音乐美学MV": "Music Video",
                            "双人游戏开场": "Co-op Game Intro",
                            "纸拼贴讲解": "Paper Collage Explainer",
                            "手绘实拍融合": "Hand-drawn + Live-action",
                        };
                        spWidget.value = zhToEn[spWidget.value] || spWidget.value;
                    }
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
                try { this._adjustImageInputs(); }
                catch (e) { /* 子图操作时可能状态不一致，忽略 */ }
                return r;
            };
        }
    },
});