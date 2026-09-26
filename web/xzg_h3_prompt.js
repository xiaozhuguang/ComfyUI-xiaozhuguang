import { app } from "../../scripts/app.js";
import { xzgLang } from "./xzg_i18n.js";
import { cloudLoad, cloudSave } from "./xzg_cloud_store.js";

const H3_PREFIX = "Minimax-H3 ";
const H3_GEN_MODES = [
    "Text to Video (T2VA)", "Image to Video (I2VA)", "First+Last Frame (FL2VA)",
    "Last Frame (L2VA)", "Full Reference (Ref2VA)",
].map(value => `${H3_PREFIX}${value}`);
const QWEN_IMAGE_TARGET = "Qwen-Image-2.1 图像";
const QWEN_IMAGE_TARGET_EN = "Qwen-Image-2.1 Image";
const SKILL_PRESETS_KEY = "xzg_prompt_skill_presets";
let skillPresetsRestorePromise = null;
const QWEN_IMAGE_MODES = [
    "Qwen-Image-2.1 文生图",
    "Qwen-Image-2.1 图像编辑",
    "Qwen-Image-2.1 多参考图",
];
const TARGET_LABELS = {
    zh: { h3: "MiniMax-H3", qwen: "QWEN", custom: "自定义 Skill" },
    en: { h3: "MiniMax-H3", qwen: "QWEN", custom: "Custom Skill" },
};
const QWEN_MODE_LABELS = {
    zh: ["Qwen-Image-2.1 文生图", "Qwen-Image-2.1 图像编辑", "Qwen-Image-2.1 多参考图"],
    en: ["Text to Image", "Image Editing", "Multi-Reference Image"],
};
app.registerExtension({
    name: "Xiaozhuguang.H3Prompt",
    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        // ── 小珠光通用提示词 ──
        if (nodeData.name === "XiaozhuguangNinimaxH3Prompt" || nodeData.name === "XiaozhuguangNinimaxH3PromptNoSkill") {
            const supportsCustomSkill = nodeData.name === "XiaozhuguangNinimaxH3Prompt";
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

            nodeType.prototype._addComboControlInputs = function () {
                const labels = xzgLang() === "zh"
                    ? { target_model: "提示词类型", generation_mode: "提示词细分" }
                    : { target_model: "Prompt Type", generation_mode: "Prompt Subtype" };
                for (const [name, label] of Object.entries(labels)) {
                    if (this.inputs?.some(input => input.name === name)) continue;
                    const input = this.addInput(name, "*", {
                        tooltip: "Connect STRING or TEXT to override this selection",
                    });
                    input.label = label;
                }
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated?.apply(this, arguments);
                this.setSize([300, 400]);
                this._addComboControlInputs();
                this._hideExtraImageInputs();
                this._ensureTargetModelCombo();
                this._syncTargetModel();
                if (supportsCustomSkill) {
                    this._addSkillPresetControls();
                    this._restoreSkillPresets();
                }
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

            // Qwen-Image-2.1 使用图像生成/编辑模式；H3 保持视频生成模式。
            nodeType.prototype._ensureTargetModelCombo = function () {
                const ensureCombo = (name, flag, fallback, values) => {
                    let widget = this.widgets?.find(w => w.name === name);
                    if (!widget) return null;
                    if (widget.type !== "combo" && !this[flag]) {
                        const index = this.widgets.indexOf(widget);
                        const value = widget.value ?? fallback;
                        const callback = widget.callback;
                        this.widgets.splice(index, 1);
                        const combo = this.addWidget("combo", name, value, function (...args) {
                            return callback?.apply(this, args);
                        }, { values });
                        const newIndex = this.widgets.indexOf(combo);
                        this.widgets.splice(newIndex, 1);
                        this.widgets.splice(index, 0, combo);
                        widget = combo;
                        this[flag] = true;
                    }
                    widget.options = widget.options || {};
                    return widget;
                };
                const lang = xzgLang();
                const labels = TARGET_LABELS[lang] || TARGET_LABELS.zh;
                const targetValues = supportsCustomSkill ? [labels.h3, labels.qwen, labels.custom] : [labels.h3, labels.qwen];
                ensureCombo("target_model", "_xzgTargetComboRebuilt", labels.h3, targetValues);
                ensureCombo("generation_mode", "_xzgGenerationModeComboRebuilt", H3_GEN_MODES[0], [...H3_GEN_MODES]);
            };

            nodeType.prototype._syncTargetModel = function () {
                this._ensureTargetModelCombo();
                const targetWidget = this.widgets?.find(w => w.name === "target_model");
                const gmWidget = this.widgets?.find(w => w.name === "generation_mode");
                if (!gmWidget?.options) return;
                const lang = xzgLang();
                const labels = TARGET_LABELS[lang] || TARGET_LABELS.zh;
                if (targetWidget?.options) {
                    let presets = {};
                    if (supportsCustomSkill) {
                        try { presets = JSON.parse(localStorage.getItem(SKILL_PRESETS_KEY) || "{}"); } catch (_) {}
                    }
                    const oldValue = targetWidget.value || "";
                    const isQwen = oldValue === QWEN_IMAGE_TARGET || oldValue === QWEN_IMAGE_TARGET_EN || oldValue === "QWEN";
                    const isCustom = supportsCustomSkill && (oldValue === "自定义 Skill" || oldValue === "Custom Skill");
                    const values = supportsCustomSkill ? [labels.h3, labels.qwen, labels.custom] : [labels.h3, labels.qwen];
                    targetWidget.options.values = values;
                    targetWidget.value = isCustom ? labels.custom : isQwen ? labels.qwen : labels.h3;
                    const presetNames = presets && typeof presets === "object" && !Array.isArray(presets)
                        ? Object.keys(presets).sort((a, b) => a.localeCompare(b)) : [];
                    if (gmWidget?.options) {
                        if (isCustom) {
                            gmWidget.options.values = presetNames.length ? presetNames : [lang === "zh" ? "（请先保存 Skill 预设）" : "(Save a Skill preset first)"];
                            const wanted = gmWidget.value;
                            gmWidget.value = presetNames.includes(wanted) ? wanted : (presetNames[0] || gmWidget.options.values[0]);
                        } else if (isQwen) {
                            const oldMode = gmWidget.value;
                            gmWidget.options.values = QWEN_MODE_LABELS[lang] || QWEN_MODE_LABELS.zh;
                            const canonical = ({
                                "Qwen-Image-2.1 文生图": 0, "Text to Image": 0,
                                "Qwen-Image-2.1 图像编辑": 1, "Image Editing": 1,
                                "Qwen-Image-2.1 多参考图": 2, "Multi-Reference Image": 2,
                            })[oldMode];
                            gmWidget.value = gmWidget.options.values[canonical ?? 0];
                        } else {
                            gmWidget.options.values = H3_GEN_MODES;
                            gmWidget.value = H3_GEN_MODES.includes(gmWidget.value) ? gmWidget.value : H3_GEN_MODES[0];
                        }
                    }
                }
            };

            nodeType.prototype._restoreSkillPresets = function () {
                if (!skillPresetsRestorePromise) {
                    skillPresetsRestorePromise = cloudLoad(SKILL_PRESETS_KEY, { fallbackValue: {} })
                        .then(data => data && typeof data === "object" && !Array.isArray(data) ? data : {})
                        .catch(() => ({}));
                }
                skillPresetsRestorePromise.then(() => this._refreshSkillPresetTypes());
            };

            nodeType.prototype._refreshSkillPresetTypes = function () {
                for (const node of app.graph?._nodes || []) {
                    if (node?.type === "XiaozhuguangNinimaxH3Prompt" || node?.constructor?.name === "XiaozhuguangNinimaxH3Prompt" || node?.type === "XiaozhuguangNinimaxH3PromptNoSkill" || node?.constructor?.name === "XiaozhuguangNinimaxH3PromptNoSkill") {
                        node._syncTargetModel?.();
                    }
                }
                window.XZGRefreshSkillPresetTypes = () => {
                    for (const node of app.graph?._nodes || []) node?._syncTargetModel?.();
                };
            };

            nodeType.prototype._addSkillPresetControls = function () {
                if (this._xzgSkillPresetControlsAdded) return;
                this._xzgSkillPresetControlsAdded = true;
                const storageKey = SKILL_PRESETS_KEY;
                const getPresets = () => {
                    try {
                        const parsed = JSON.parse(localStorage.getItem(storageKey) || "{}");
                        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
                    } catch (_) { return {}; }
                };
                this.addWidget("button", xzgLang() === "zh" ? "Skill 预设管理" : "Manage Skill Presets", null, () => {
                    if (this._xzgSkillPresetDialog) return;
                    const zh = xzgLang() === "zh";
                    const overlay = document.createElement("div");
                    overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.72);display:flex;align-items:stretch;justify-content:stretch;padding:8px;box-sizing:border-box;";
                    const panel = document.createElement("div");
                    panel.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column;background:#202124;color:#eee;border:1px solid #555;border-radius:8px;box-shadow:0 16px 48px #0009;font:13px Arial,sans-serif;overflow:hidden;";
                    panel.innerHTML = `<div style="display:flex;align-items:center;padding:13px 16px;border-bottom:1px solid #444;font-size:15px;font-weight:600;flex:none"><span style="flex:1">${zh ? "Skill 预设管理" : "Skill Preset Manager"}</span><button data-close style="background:none;border:0;color:#bbb;font-size:21px;cursor:pointer">×</button></div><div style="padding:12px 16px 8px;display:flex;gap:8px;flex:none"><input data-name maxlength="80" placeholder="${zh ? "预设名称" : "Preset name"}" style="flex:1;min-width:0;background:#151617;color:#eee;border:1px solid #555;border-radius:5px;padding:8px"><button data-import style="background:#343b49;color:#ddd;border:1px solid #555;border-radius:5px;padding:0 12px;cursor:pointer">${zh ? "导入 .txt / .md" : "Import .txt / .md"}</button><input data-file type="file" accept=".txt,.md,text/plain,text/markdown" style="display:none"><button data-save style="background:#3a7653;color:white;border:0;border-radius:5px;padding:0 14px;cursor:pointer">${zh ? "保存预设" : "Save Preset"}</button></div><textarea data-skill spellcheck="false" placeholder="${zh ? "在这里编写或编辑 Skill，也可以拖入 .txt / .md 文件" : "Write or edit the Skill here, or drop a .txt / .md file"}" style="box-sizing:border-box;width:calc(100% - 32px);flex:1;min-height:120px;resize:none;margin:4px 16px 12px;padding:10px;background:#151617;color:#eee;border:1px solid #555;border-radius:5px;font:12px/1.5 Consolas,monospace"></textarea><div data-list style="flex:1;overflow:auto;padding:0 16px 14px;min-height:70px"></div><div style="padding:10px 16px;border-top:1px solid #444;color:#999;font-size:11px;flex:none">${zh ? "点击预设名称加载和应用；同名保存会更新。预设随小珠光配置导出。" : "Click a preset to load and apply it. Saving with the same name updates it. Presets are included in Xiaozhuguang config exports."}</div>`;
                    overlay.appendChild(panel);
                    document.body.appendChild(overlay);
                    this._xzgSkillPresetDialog = overlay;
                    const close = () => { overlay.remove(); this._xzgSkillPresetDialog = null; };
                    panel.querySelector("[data-close]").onclick = close;
                    overlay.addEventListener("mousedown", e => { if (e.target === overlay) close(); });
                    const editor = panel.querySelector("[data-skill]");
                    const nameInput = panel.querySelector("[data-name]");
                    const selectedTarget = this.widgets?.find(w => w.name === "target_model")?.value || "";
                    const selectedMode = this.widgets?.find(w => w.name === "generation_mode")?.value || "";
                    if (selectedTarget === TARGET_LABELS[zh ? "zh" : "en"].custom) {
                        nameInput.value = selectedMode;
                        const selectedPreset = getPresets()[selectedMode];
                        if (selectedPreset?.skill) editor.value = selectedPreset.skill;
                    }
                    const fileInput = panel.querySelector("[data-file]");
                    panel.querySelector("[data-import]").onclick = () => fileInput.click();
                    fileInput.onchange = async () => {
                        const file = fileInput.files?.[0];
                        if (!file) return;
                        if (!/\.(txt|md)$/i.test(file.name)) {
                            editor.placeholder = zh ? "只支持 .txt 和 .md 文件" : "Only .txt and .md files are supported";
                            fileInput.value = "";
                            return;
                        }
                        editor.value = await file.text();
                        if (!nameInput.value.trim()) nameInput.value = file.name.replace(/\.(txt|md)$/i, "");
                        fileInput.value = "";
                    };
                    editor.addEventListener("dragover", e => { e.preventDefault(); editor.style.borderColor = "#68b38a"; });
                    editor.addEventListener("dragleave", () => { editor.style.borderColor = "#555"; });
                    editor.addEventListener("drop", async e => {
                        e.preventDefault();
                        editor.style.borderColor = "#555";
                        const file = e.dataTransfer?.files?.[0];
                        if (!file) return;
                        if (!/\.(txt|md)$/i.test(file.name)) {
                            editor.placeholder = zh ? "只支持 .txt 和 .md 文件" : "Only .txt and .md files are supported";
                            return;
                        }
                        editor.value = await file.text();
                        if (!nameInput.value.trim()) nameInput.value = file.name.replace(/\.(txt|md)$/i, "");
                    });
                    const renderList = () => {
                        const list = panel.querySelector("[data-list]");
                        const presets = getPresets();
                        const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
                        list.replaceChildren();
                        if (!names.length) {
                            const empty = document.createElement("div");
                            empty.textContent = zh ? "暂无预设。填写 Skill 后，可在上方保存。" : "No presets yet. Enter a Skill and save it above.";
                            empty.style.cssText = "padding:22px 8px;text-align:center;color:#999";
                            list.appendChild(empty);
                            return;
                        }
                        for (const name of names) {
                            const row = document.createElement("div");
                            row.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 2px;border-bottom:1px solid #383838";
                            const apply = document.createElement("button");
                            apply.textContent = name;
                            apply.title = presets[name]?.skill || "";
                            apply.style.cssText = "flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:transparent;color:#ddd;border:0;padding:5px;cursor:pointer";
                            apply.onclick = () => {
                                editor.value = presets[name]?.skill || "";
                                const targetWidget = this.widgets?.find(w => w.name === "target_model");
                                const labels = TARGET_LABELS[xzgLang()] || TARGET_LABELS.zh;
                                targetWidget.value = labels.custom;
                                targetWidget.callback?.(labels.custom);
                                const modeWidget = this.widgets?.find(w => w.name === "generation_mode");
                                if (modeWidget?.options?.values?.includes(name)) modeWidget.value = name;
                                modeWidget?.callback?.(modeWidget.value);
                                nameInput.value = name;
                                this.setDirtyCanvas(true, true);
                            };
                            const remove = document.createElement("button");
                            remove.textContent = zh ? "删除" : "Delete";
                            remove.style.cssText = "background:#492d2d;color:#f2baba;border:1px solid #694141;border-radius:4px;padding:5px 9px;cursor:pointer";
                            remove.onclick = () => {
                                const updated = getPresets();
                                delete updated[name];
                                cloudSave(storageKey, updated).catch(() => {});
                                const targetWidget = this.widgets?.find(w => w.name === "target_model");
                                const modeWidget = this.widgets?.find(w => w.name === "generation_mode");
                                const labels = TARGET_LABELS[xzgLang()] || TARGET_LABELS.zh;
                                if (targetWidget?.value === labels.custom && modeWidget?.value === name) {
                                    modeWidget.value = Object.keys(updated).sort((a, b) => a.localeCompare(b))[0] || (zh ? "（请先保存 Skill 预设）" : "(Save a Skill preset first)");
                                }
                                this._syncTargetModel();
                                this._refreshSkillPresetTypes();
                                renderList();
                            };
                            row.append(apply, remove);
                            list.appendChild(row);
                        }
                    };
                    panel.querySelector("[data-save]").onclick = () => {
                        const name = nameInput.value.trim();
                        const value = editor.value.trim();
                        if (!name || !value) {
                            nameInput.placeholder = zh ? "请填写预设名称，且 Skill 不能为空" : "Enter a name and a non-empty Skill";
                            return;
                        }
                        const presets = getPresets();
                        presets[name] = { skill: value, updatedAt: new Date().toISOString() };
                        cloudSave(storageKey, presets).catch(() => {});
                        this._syncTargetModel();
                        this._refreshSkillPresetTypes();
                        const targetWidget = this.widgets?.find(w => w.name === "target_model");
                        const labels = TARGET_LABELS[xzgLang()] || TARGET_LABELS.zh;
                        targetWidget.value = labels.custom;
                        targetWidget.callback?.(labels.custom);
                        const modeWidget = this.widgets?.find(w => w.name === "generation_mode");
                        if (modeWidget?.options?.values?.includes(name)) modeWidget.value = name;
                        modeWidget?.callback?.(modeWidget.value);
                        renderList();
                    };
                    renderList();
                });
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
            // 规则：已连接的接口左移填补空位，末尾保留一个空接口，最少 1 个，最多 10 个
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

                    // 目标数量 = 已连接 + 1 个空位，最少 1，最多 10
                    const desiredLen = Math.min(connectedCount + 1, 10);

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

            // 调整图片接口
            const origConfigure = nodeType.prototype.configure;
            nodeType.prototype.configure = function (info) {
                const callArgs = [...arguments];
                const r = origConfigure?.apply(this, callArgs);
                // configure 会在 onNodeCreated 之后恢复 widget 值；恢复后重建细分列表。
                this._ensureTargetModelCombo();
                this._syncTargetModel();
                if (supportsCustomSkill) {
                    this._addSkillPresetControls();
                    this._restoreSkillPresets();
                }
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
