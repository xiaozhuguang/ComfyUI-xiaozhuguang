import { app } from "../../scripts/app.js";

const NODE_TYPE = "XiaozhuguangLoopStart";
const END_TYPE = "XiaozhuguangLoopEnd";
const MAX_CHANNELS = 20;

function keepInitialChannelOnly(nodeData, inputNames, outputCount) {
    const optional = nodeData.input?.optional;
    if (optional) {
        for (const name of inputNames) delete optional[name];
    }
    for (const key of ["output", "output_name", "output_is_list", "output_tooltips"]) {
        if (Array.isArray(nodeData[key])) nodeData[key].splice(outputCount);
    }
}

function channelLayout(node) {
    return node.type === END_TYPE
        ? { firstInput: "data", prefix: "data_", inputLabel: "循环结束 ", firstOutput: 0, outputLabel: "输出 " }
        : { firstInput: "state", prefix: "state_", inputLabel: "输入数据 ", firstOutput: 2, outputLabel: "循环开始 " };
}

function syncChannels(node) {
    const { firstInput, prefix, firstOutput } = channelLayout(node);
    let connectedInputPrefix = 0;
    let connectedOutputPrefix = 0;
    for (let channel = 1; channel <= MAX_CHANNELS; channel++) {
        const key = channel === 1 ? firstInput : prefix + channel;
        const input = node.inputs?.find((slot) => slot.name === key);
        if (input?.link != null && connectedInputPrefix === channel - 1)
            connectedInputPrefix = channel;
        const output = node.outputs?.[firstOutput + channel - 1];
        if (output?.links?.length && connectedOutputPrefix === channel - 1)
            connectedOutputPrefix = channel;
    }
    const visibleChannels = Math.min(
        MAX_CHANNELS,
        Math.max(connectedInputPrefix, connectedOutputPrefix) + 1,
    );
    updateExtraPorts(node, visibleChannels, visibleChannels);
}

function updateExtraPorts(node, visibleInputs, visibleOutputs) {
    const { prefix, inputLabel, firstOutput, outputLabel } = channelLayout(node);
    let changed = false;
    for (let channel = MAX_CHANNELS; channel >= 2; channel--) {
        const input = node.inputs?.findIndex((slot) => slot.name === prefix + channel);
        if (channel > visibleInputs && input >= 0 && node.inputs[input].link == null) {
            node.removeInput(input);
            changed = true;
        }
        const outputIndex = firstOutput + channel - 1;
        const output = node.outputs?.[outputIndex];
        if (channel > visibleOutputs && output?.name === outputLabel + channel && !output.links?.length) {
            node.removeOutput(outputIndex);
            changed = true;
        }
    }
    for (let channel = 2; channel <= visibleInputs; channel++) {
        const key = prefix + channel;
        const label = inputLabel + channel;
        if (!node.inputs?.some((slot) => slot.name === key)) {
            node.addInput(key, "*", { label });
            changed = true;
        }
    }
    for (let channel = 2; channel <= visibleOutputs; channel++) {
        const name = outputLabel + channel;
        const index = firstOutput + channel - 1;
        if (!node.outputs?.[index]) {
            node.addOutput(name, "*");
            changed = true;
        }
        const output = node.outputs[index];
        output.name = output.label = output.localized_name = name;
    }
    if (changed) {
        const [width, height] = node.computeSize();
        node.setSize([Math.max(node.size[0], width), height]);
        node.setDirtyCanvas?.(true, true);
    }
}

function updateEndPorts(node) {
    const obsoleteIndex = node.inputs?.findIndex((slot) => slot.name === "round_action");
    if (obsoleteIndex >= 0) node.removeInput(obsoleteIndex);
    const flowIndex = node.inputs?.findIndex((slot) => slot.name === "flow");
    const start = flowIndex >= 0 ? node.getInputNode(flowIndex) : null;
    const startMode = start?.widgets?.find((widget) => widget.name === "mode")?.value;
    const mode = startMode;
    const output = node.outputs?.[0];
    if (!output) return;

    const traversal = mode === "遍历数据";
    const legacy = node.outputs[1];
    if (legacy?.name === "最终状态") {
        const links = (legacy.links || []).map((id) => [id, node.graph?.getLink?.(id) ?? node.graph?.links?.[id]]);
        if (links.some(([, link]) => !link)) return;
        for (const [id, link] of links) {
            link.origin_slot = 0;
            (output.links ??= []).push(id);
        }
        legacy.links = null;
        node.removeOutput(1);
    }
    const name = "输出 1";
    output.name = output.label = output.localized_name = name;
    output.shape = traversal ? 6 : undefined;

    const dataIndex = node.inputs.findIndex((slot) => ["data", "next_state", "product"].includes(slot.name));
    const data = dataIndex < 0 ? node.addInput("data", "*") : node.inputs[dataIndex];
    if (data.name !== "data") data.name = "data";
    data.label = data.localized_name = "循环结束 1";
    const stopIndex = node.inputs.findIndex((slot) => slot.name === "stop");
    if (stopIndex > 1) {
        const slots = node.inputs.slice(1, stopIndex + 1);
        slots.unshift(slots.pop());
        const links = slots.map((slot) => slot.link == null ? null
            : node.graph?.getLink?.(slot.link) ?? node.graph?.links?.[slot.link]);
        if (slots.every((slot, index) => slot.link == null || links[index])) {
            node.inputs.splice(1, slots.length, ...slots);
            links.forEach((link, index) => {
                if (link) link.target_slot = index + 1;
            });
        }
    }
    syncChannels(node);

    node.setDirtyCanvas?.(true, true);
}

function updateLinkedEnds(start) {
    for (const id of start.outputs?.[0]?.links || []) {
        const link = start.graph?.getLink?.(id) ?? start.graph?.links?.[id];
        const end = link && start.graph.getNodeById(link.target_id);
        if (end?.type === END_TYPE) updateEndPorts(end);
    }
}

function updateCountWidget(node) {
    const mode = node.widgets?.find((widget) => widget.name === "mode")?.value;
    const count = node.widgets?.find((widget) => widget.name === "count");
    if (!count) return;

    const enabled = mode === "循环";
    count.type = enabled ? count._xzgOriginalType : "hidden";
    count.computeSize = enabled ? count._xzgOriginalComputeSize : () => [0, -4];
    count.disabled = !enabled;
    count.options ||= {};
    count.options.disabled = !enabled;
    node.setSize(node.computeSize());
    node.setDirtyCanvas?.(true, true);
}

function updateStateInput(node) {
    const mode = node.widgets?.find((widget) => widget.name === "mode")?.value;
    const input = node.inputs?.find((slot) => slot.name === "state");
    if (!input) return;
    input.label = input.localized_name = "输入数据";
    input.type = "*";
    node.setDirtyCanvas?.(true, true);
}

function updateModeOutputs(node) {
    if (node.outputs?.[2]?.type === "INT" && node.outputs[1]?.type !== "INT") {
        const slots = [node.outputs[2], node.outputs[1]];
        const links = slots.map((slot) => (slot.links || []).map(
            (id) => node.graph?.getLink?.(id) ?? node.graph?.links?.[id],
        ));
        if (links.some((group) => group.some((link) => !link))) return;
        slots.forEach((slot, index) => {
            node.outputs[index + 1] = slot;
            for (const link of links[index]) link.origin_slot = index + 1;
        });
    }
    const output = node.outputs?.[2];
    if (!output) return;
    const legacy = node.outputs[3];
    if (legacy?.name === "本轮状态") {
        for (const id of legacy.links || []) {
            const link = node.graph?.getLink?.(id) ?? node.graph?.links?.[id];
            if (!link) return;
        }
        for (const id of legacy.links || []) {
            const link = node.graph?.getLink?.(id) ?? node.graph.links[id];
            link.origin_slot = 2;
            (output.links ??= []).push(id);
        }
        legacy.links = null;
        node.removeOutput(3);
    }
    const name = "循环开始 1";
    output.name = output.label = output.localized_name = name;
    const iteration = node.outputs?.[1];
    if (iteration) iteration.name = iteration.label = iteration.localized_name = "索引";
    syncChannels(node);
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "Xiaozhuguang.LoopMode",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === END_TYPE) {
            keepInitialChannelOnly(nodeData, Array.from(
                { length: MAX_CHANNELS - 1 }, (_, index) => `data_${index + 2}`,
            ), 1);
            for (const hook of ["onNodeCreated", "onConfigure", "onConnectionsChange"]) {
                const original = nodeType.prototype[hook];
                nodeType.prototype[hook] = function (...args) {
                    const result = original?.apply(this, args);
                    queueMicrotask(() => updateEndPorts(this));
                    return result;
                };
            }
            return;
        }
        if (nodeData.name !== NODE_TYPE) return;
        keepInitialChannelOnly(nodeData, Array.from(
            { length: MAX_CHANNELS - 1 }, (_, index) => `state_${index + 2}`,
        ), 3);
        const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (...args) {
            const result = originalConnectionsChange?.apply(this, args);
            queueMicrotask(() => {
                updateModeOutputs(this);
                updateLinkedEnds(this);
            });
            return result;
        };
        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalCreated?.apply(this, arguments);
            const mode = this.widgets?.find((widget) => widget.name === "mode");
            const count = this.widgets?.find((widget) => widget.name === "count");
            const state = this.inputs?.find((slot) => slot.name === "state");
            if (!mode || !count || !state) return result;

            count._xzgOriginalType = count.type;
            count._xzgOriginalComputeSize = count.computeSize;
            const originalCallback = mode.callback;
            const node = this;
            mode.callback = function () {
                originalCallback?.apply(this, arguments);
                updateCountWidget(node);
                updateStateInput(node);
                updateModeOutputs(node);
                updateLinkedEnds(node);
            };
            queueMicrotask(() => {
                updateCountWidget(this);
                updateStateInput(this);
                updateModeOutputs(this);
                updateLinkedEnds(this);
            });
            return result;
        };

        const originalConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = originalConfigure?.apply(this, arguments);
            queueMicrotask(() => {
                updateCountWidget(this);
                updateStateInput(this);
                updateModeOutputs(this);
                updateLinkedEnds(this);
            });
            return result;
        };
    },
});
