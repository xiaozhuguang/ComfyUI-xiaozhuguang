import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { videoQueuePrompts } from "../web/lib/xzg_multi_video_queue.mjs";

const source = (await readFile(new URL("../web/xzg_multi_video_queue.js", import.meta.url), "utf8"))
    .replace(/^import .*;\r?\n/gm, "")
    .replace("export function bindMultiVideoQueue", "function bindMultiVideoQueue");

function fixture(failAt = -1) {
    const calls = [];
    const listeners = {};
    const node = { id: 7, type: "XiaozhuguangVideoLoaderDaVinci", mode: 0,
        properties: { xzgMultiVideo: true, xzgVideoQueue: ["a.mp4", "b.mp4", "c.mp4"] },
        widgets: [{ name: "视频", value: "a.mp4", options: { values: [] } }],
        _xzgSetVideoQueueStatus() {} };
    let extension;
    const api = { async queuePrompt(index, prompt) {
        calls.push({ index, prompt });
        if (calls.length === failAt) throw new Error("submission failed");
        return { prompt_id: `job-${calls.length}` };
    }, addEventListener(name, callback) { listeners[name] = callback; } };
    const app = { graph: { _nodes: [node] }, registerExtension(value) { extension = value; } };
    vm.runInNewContext(source, { app, api, videoQueuePrompts, console, setTimeout, clearTimeout });
    extension.setup();
    const prompt = { output: { "7": { class_type: node.type, inputs: { "视频": "original.mp4", "跳过帧数": 12 } },
        "8": { class_type: "Output", inputs: { images: ["7", 0] } } },
        workflow: { nodes: [{ id: 7, widgets_values: ["original.mp4", 12] }] } };
    return { api, node, prompt, calls, listeners };
}

{
    const f = fixture();
    await f.api.queuePrompt(-1, f.prompt);
    assert.deepEqual(f.calls.map(call => call.prompt.output["7"].inputs["视频"]), ["a.mp4", "b.mp4", "c.mp4"]);
    assert.deepEqual(f.calls.map(call => call.index), [0, 0, 0]);
    assert.equal(f.prompt.output["7"].inputs["视频"], "original.mp4");
    assert.equal(f.calls[1].prompt.workflow.nodes[0].widgets_values[0], "b.mp4");
    assert.equal(f.calls[1].prompt.output["7"].inputs["跳过帧数"], 12);
    assert.ok(f.calls[1].prompt.output["8"]);
    assert.equal(f.node._xzgVideoQueuePending, 3);
    await assert.rejects(f.api.queuePrompt(0, f.prompt), /尚未执行完/);
    for (let i = 1; i <= 3; i++) f.listeners.execution_success({ detail: { prompt_id: `job-${i}` } });
    assert.equal(f.node._xzgVideoQueuePending, 0);
}
{
    const f = fixture(2);
    await assert.rejects(f.api.queuePrompt(0, f.prompt), /submission failed/);
    assert.equal(f.calls.length, 2);
    assert.equal(f.node._xzgVideoQueuePending, 1);
}
{
    const f = fixture();
    f.node.properties.xzgMultiVideo = false;
    await f.api.queuePrompt(0, f.prompt);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].prompt, f.prompt);
}
{
    const f = fixture();
    f.prompt.output["9"] = { class_type: "XiaozhuguangVideoScheduler" };
    await assert.rejects(f.api.queuePrompt(0, f.prompt), /场景逐段/);
    assert.equal(f.calls.length, 0);
}
console.log("Multi-video queue: ordering, snapshots, failure handling, completion and single-video compatibility passed.");
