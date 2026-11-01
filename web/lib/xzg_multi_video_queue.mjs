export function videoQueuePrompts(prompt, nodeId, filenames, videoWidgetIndex = 0) {
    return filenames.map((filename, queueIndex) => {
        const copy = structuredClone(prompt);
        copy.output[String(nodeId)].inputs["视频"] = filename;
        const loader = copy.output[String(nodeId)];
        // Carry the queue position through the existing VHS_VIDEOINFO link. The
        // loader reads this hidden input and appends it to its info dictionary.
        loader.inputs.xzg_video_index = String(queueIndex);
        const saved = copy.workflow?.nodes?.find(node => String(node.id) === String(nodeId));
        if (saved?.widgets_values) saved.widgets_values[videoWidgetIndex] = filename;
        return copy;
    });
}
