import { app } from "../../scripts/app.js";

// MP4/WebM use ComfyUI's native parsers. GIF requires reading its comment blocks.
export async function readGifWorkflow(file) {
    const bytes = new Uint8Array(await file.slice(-64 * 1024 * 1024).arrayBuffer());
    const marker = new TextEncoder().encode("XZG_WORKFLOW:");
    for (let i = bytes.length - marker.length - 4; i >= 0; i--) {
        if (bytes[i] !== 0x21 || bytes[i + 1] !== 0xfe) continue;
        const start = i + 3;
        if (!marker.every((value, index) => bytes[start + index] === value)) continue;
        const chunks = [];
        let length = 0, cursor = i + 2;
        while (cursor < bytes.length) {
            const size = bytes[cursor++];
            if (!size) {
                const payload = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.length; }
                try {
                    const metadata = JSON.parse(new TextDecoder().decode(payload).slice(marker.length));
                    if (Array.isArray(metadata.workflow?.nodes)) return metadata.workflow;
                } catch (error) { console.warn("[XZG] Invalid GIF workflow metadata", error); }
                break;
            }
            if (cursor + size > bytes.length) break;
            chunks.push(bytes.subarray(cursor, cursor + size));
            length += size;
            cursor += size;
        }
    }
    return null;
}

app.registerExtension({
    name: "Xiaozhuguang.VideoWorkflow",
    setup() {
        const original = app.handleFile;
        app.handleFile = async function (file, ...args) {
            if (file?.type === "image/gif" || /\.gif$/i.test(file?.name || "")) {
                const workflow = await readGifWorkflow(file);
                if (workflow) {
                    // Let ComfyUI load the JSON through its usual workflow-opening path.
                    const json = new File([JSON.stringify(workflow)], file.name.replace(/\.gif$/i, ".json"), { type: "application/json" });
                    return original.call(this, json, ...args);
                }
            }
            return original.call(this, file, ...args);
        };
    },
});
