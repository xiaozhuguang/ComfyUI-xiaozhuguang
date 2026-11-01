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
