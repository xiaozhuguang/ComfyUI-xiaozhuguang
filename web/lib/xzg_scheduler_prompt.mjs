// Internal scheduler phases share a batch token; only preparation receives upstream inputs.
export function prepareSchedulerPrompt(prompt, nodeId, batch) {
    const entry = prompt.output?.[String(nodeId)];
    if (!entry) throw new Error("提交中缺少分段节点");
    entry.inputs["当前段"] = 1000000;
    entry.inputs["段表"] = "";
    entry.inputs["缓存批次"] = batch;
}

export function useSchedulerCache(prompt, nodeId, batch) {
    const entry = prompt.output?.[String(nodeId)];
    if (!entry) throw new Error("提交中缺少分段节点");
    if (!batch) throw new Error("缺少本轮素材缓存标识，请重新运行工作流");
    entry.inputs["缓存批次"] = batch;
    for (const name of ["图像", "音频", "帧率", "遮罩"]) delete entry.inputs[name];
}

export function prepareMergePrompt(prompt, nodeId, downstreamIds) {
    const out = prompt.output;
    const id = String(nodeId);
    const merge = out?.[id];
    if (!merge?.inputs) throw new Error("提交中缺少合并节点");
    const fpsLink = merge.inputs["帧率"];
    const sameLink = value => Array.isArray(fpsLink) && Array.isArray(value)
        && String(value[0]) === String(fpsLink[0]) && value[1] === fpsLink[1];
    for (const downstreamId of downstreamIds) {
        if (String(downstreamId) === id) continue;
        for (const [name, value] of Object.entries(out[String(downstreamId)]?.inputs || {})) {
            // Preserve the actual processed rate, including interpolation/retiming.
            // Following the old producer here would execute its image processing again.
            if (sameLink(value)) out[String(downstreamId)].inputs[name] = [id, 2];
        }
    }
    merge.inputs["执行合并"] = true;
    for (const name of ["图像", "音频", "帧率"]) delete merge.inputs[name];
}
