export function videoQueuePrompts(prompt, nodeId, filenames, videoWidgetIndex = 0) {
    return filenames.map(filename => {
        const copy = structuredClone(prompt);
        copy.output[String(nodeId)].inputs["视频"] = filename;
        const saved = copy.workflow?.nodes?.find(node => String(node.id) === String(nodeId));
        if (saved?.widgets_values) saved.widgets_values[videoWidgetIndex] = filename;
        return copy;
    });
}
