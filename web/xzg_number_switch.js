import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.number_switch",
    async setup() {
        // 加载工作流后只更新端口显示名称，不收缩已序列化的槽位。
        const origAfterConfigure = app.graph.afterConfigure;
        app.graph.afterConfigure = function () {
            const r = origAfterConfigure?.apply(this, arguments);
            for (const node of this._nodes) {
                if (node.type === "XiaozhuguangNumberSwitch" && node.localizeValueInputs) {
                    node.localizeValueInputs();
                }
            }
            return r;
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "XiaozhuguangNumberSwitch") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            // 新建节点先只显示一个可接线口和一个后续空口。
            // 加载工作流时 configure 会恢复已保存的输入列表；不要在 afterConfigure 中收缩它，
            // 子图解包可能仍在按原槽位恢复连线。
            this.initializeInputSlots();
            return r;
        };

        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (inputType, slotIndex, isConnected, link, info) {
            const r = origOnConnectionsChange?.apply(this, arguments);
            if (inputType === LiteGraph.INPUT) {
                this.updateInputSlots(slotIndex, isConnected);
            }
            return r;
        };

        /**
         * 只在新建时精简初始端口；工作流加载/子图恢复期间保留序列化的端口。
         */
        nodeType.prototype.initializeInputSlots = function () {
            if (!this.inputs) return;

            this.localizeValueInputs();
            const valueInputs = this.inputs.filter((input) => /^value\d+$/.test(input.name || ""));
            // 初始 schema 提供了最多 50 个可选口，新节点默认显示 value0 和 value1。
            for (let i = valueInputs.length - 1; i >= 2; i--) {
                const slot = this.inputs.indexOf(valueInputs[i]);
                if (slot >= 0 && valueInputs[i].link == null) this.removeInput(slot);
            }
            this.refreshInputLayout();
        };

        nodeType.prototype.localizeValueInputs = function () {
            if (!this.inputs) return;
            for (const input of this.inputs) {
                if (!input || !/^value\d+$/.test(input.name || "")) continue;
                const index = Number(input.name.slice(5));
                input.label = xzgT(`值${index}`, `Value ${index}`);
                input.localized_name = input.label;
            }
        };

        /**
         * 与 easy-use 编号切换一致：所有现有值口都接上后才追加一个空口；
         * 断开倒数第二个值口时，仅移除末尾多余的空口。最多 50 个值口。
         */
        nodeType.prototype.updateInputSlots = function (slotIndex, isConnected) {
            if (!this.inputs) return;
            this.localizeValueInputs();

            const valueInputs = this.inputs.filter((input) => /^value\d+$/.test(input.name || ""));
            if (valueInputs.length === 0) return;

            let changed = false;
            if (isConnected && valueInputs.length < 50 && valueInputs.every((input) => input.link != null)) {
                const nextIndex = valueInputs.length;
                const input = this.addInput(`value${nextIndex}`, "*");
                if (input) {
                    input.label = xzgT(`值${nextIndex}`, `Value ${nextIndex}`);
                    input.localized_name = input.label;
                    changed = true;
                }
            } else if (!isConnected) {
                const changedInput = this.inputs[slotIndex];
                const valueIndex = valueInputs.indexOf(changedInput);
                // 当倒数第二个值口断开且末尾口为空时，移除末尾空口，保留断开的口作为新末尾。
                if (valueIndex === valueInputs.length - 2 && valueInputs.length > 2) {
                    const lastInput = valueInputs[valueInputs.length - 1];
                    if (lastInput.link == null) {
                        this.removeInput(this.inputs.indexOf(lastInput));
                        changed = true;
                    }
                }
            }

            if (changed) this.refreshInputLayout();
        };

        nodeType.prototype.refreshInputLayout = function () {
            this.setSize(this.computeSize());
            if (app.graph) app.graph.setDirtyCanvas(true, true);
        };
    },
});
