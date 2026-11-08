import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

for (const mode of ["button", "shortcut", "points-shortcut"]) {
    const points = mode === "points-shortcut";
    test(`${mode}: explicitly requests tracking preview without changing the saved graph`, async () => {
        const source = fs.readFileSync(new URL(mode === "button" ? "../web/xzg_points_editor.js" : "../web/xzg_shortcuts.js", import.meta.url), "utf8");
        const start = source.indexOf(mode === "button" ? "const runUpstream = async () => {" : "async function executeNodes(nodes) {");
        const end = source.indexOf(mode === "button" ? "// 右键菜单追加" : "/** 获取鼠标所在", start);
        const code = source.slice(start, end);
        const original = {
            load: { class_type: "Loader", inputs: {} },
            track: { class_type: points ? "XiaozhuguangPointsEditor" : "VideoWatermarkDetector", inputs: { image: ["load", 0] } },
            unused: { class_type: "SaveImage", inputs: {} },
        };
        let submitted;
        const send = async (_, prompt) => { submitted = prompt; };
        const api = { queuePrompt: send };
        const app = { queuePrompt: async () => api.queuePrompt(0, { output: original }) };
        const context = vm.createContext({ api, app, node: { id: "track" }, queueingUpstream: false, console, hideProgress() {} });
        vm.runInContext(code + (mode === "button" ? "globalThis.run = runUpstream;" : "globalThis.run = executeNodes;"), context);
        await context.run([{ id: "track", mode: 0 }]);
        assert.deepEqual(Object.keys(submitted.output).sort(), ["load", "track"]);
        assert.equal(submitted.output.track.class_type, points ? "XZGPointsEditorLoadPreview" : "XZGManualTrackingLoadPreview");
        assert.equal(original.track.class_type, points ? "XiaozhuguangPointsEditor" : "VideoWatermarkDetector");
        assert.equal(submitted.xzgExecuteToNode, "track");
        assert.equal(api.queuePrompt, send);
    });
}
