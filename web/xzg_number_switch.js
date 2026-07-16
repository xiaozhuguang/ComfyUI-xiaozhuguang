import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.number_switch",
    async setup() {
        // 加载工作流后，调整所有编号切换节点的输入口数量
        const origAfterConfigure = app.graph.afterConfigure;
        app.graph.afterConfigure = function () {
            const r = origAfterConfigure?.apply(this, arguments);
            for (const node of this._nodes) {
                if (node.type === "XiaozhuguangNumberSwitch" && node.adjustInputSlots) {
                    node.adjustInputSlots();
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
            // 新创建的节点（非加载）立即修剪口数量
            this.adjustInputSlots();
            return r;
        };

        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (inputType, slotIndex, isConnected, link, info) {
            const r = origOnConnectionsChange?.apply(this, arguments);
            if (inputType === LiteGraph.INPUT) {
                this.adjustInputSlots();
            }
            return r;
        };

        /**
         * 动态调整「值*」输入口数量：
         * 只保留「最后一个有连接的值口 + 1个空口」，
         * 最多 50，最少 1 个。
         * 忽略「选择」口（forceInput 产生的端口不参与计数）。
         */
        nodeType.prototype.adjustInputSlots = function () {
            if (!this.inputs) return;

            // 只统计 值* 的输入口
            let lastConnected = -1;
            let valueCount = 0;
            for (const inp of this.inputs) {
                if (!inp.name.startsWith("value")) continue;
                if (inp.link != null) lastConnected = valueCount;
                valueCount++;
            }

            // 目标 值* 数量 = 最后一个连接下标 + 2（多一个空口）
            const desiredLen = Math.min(Math.max(lastConnected + 2, 1), 50);

            if (valueCount < desiredLen) {
                for (let i = valueCount; i < desiredLen; i++) {
                    this.addInput(`value${i}`, "*");
                }
                this.setSize(this.computeSize());
                if (app.graph) app.graph.setDirtyCanvas(true, true);
            } else if (valueCount > desiredLen) {
                // 从末尾移除多余的无连接 值* 口
                let removed = 0;
                for (let i = this.inputs.length - 1; i >= 0 && removed < valueCount - desiredLen; i--) {
                    if (this.inputs[i] && this.inputs[i].link == null && this.inputs[i].name.startsWith("value")) {
                        this.removeInput(i);
                        removed++;
                    }
                }
                if (removed > 0) {
                    this.setSize(this.computeSize());
                    if (app.graph) app.graph.setDirtyCanvas(true, true);
                }
            }
        };
    },
});
