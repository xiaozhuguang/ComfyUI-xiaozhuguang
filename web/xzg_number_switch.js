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
            // 新建节点先只显示值0；连上后再由连接回调追加下一个空口。
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
            // 初始 schema 提供了最多 50 个可选口，新节点默认仅显示 value0。
            for (let i = valueInputs.length - 1; i >= 1; i--) {
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
         * 断开后清除多余末尾空口，并保留已连接口后的一个空口；仅值0未连接时不留额外空口。
         * 最多 50 个值口。
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
                // 保留所有已连接口，并确保其后恰有一个空口；若只剩未连接的值0，则不留额外空口。
                let lastConnectedIndex = -1;
                for (let i = 0; i < valueInputs.length; i++) {
                    if (valueInputs[i].link != null) lastConnectedIndex = i;
                }
                const desiredCount = lastConnectedIndex < 0 ? 1 : lastConnectedIndex + 2;
                while (valueInputs.length > desiredCount) {
                    this.removeInput(this.inputs.indexOf(valueInputs.pop()));
                    changed = true;
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
