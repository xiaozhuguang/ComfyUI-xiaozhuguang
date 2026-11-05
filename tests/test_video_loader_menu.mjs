import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../web/xzg_video_loader_davinci.js", import.meta.url), "utf8")
    .replace(/^import\s[\s\S]*?;\r?\n/gm, "");

test("preview clear menu preserves frame capture and clears selection and queue", () => {
    const context = vm.createContext({ app: { registerExtension() {} }, xzgT: zh => zh });
    vm.runInContext(source, context);
    const calls = [];
    const capture = { content: "截取当前帧" };
    const toggle = { name: "多视频队列", value: true, callback: v => calls.push(v) };
    const node = {
        properties: { xzgVideoQueue: ["a.mp4"], xzgMultiVideo: true },
        widgets: [toggle],
        _xzgPlayerMenuItems: () => [capture],
        _xzgClearLoadedVideo: () => calls.push("clear"),
        _xzgRenderVideoQueue: () => calls.push("render"),
    };
    context.node = node;
    vm.runInContext("_installClearVideoPlayerMenu(node)", context);
    // Use the actual player collection method, as used when opening its menu.
    const playerSource = fs.readFileSync(new URL("../web/xzg_video_player.js", import.meta.url), "utf8")
        .replace(/^import\s[\s\S]*?;\r?\n/gm, "")
        .replace("export class XiaozhuguangVideoPlayer", "class XiaozhuguangVideoPlayer");
    vm.runInContext(playerSource, context);
    const items = vm.runInContext("XiaozhuguangVideoPlayer.prototype._collectNodeMenuItems.call({_node: node})", context);
    assert.equal(items[0], capture);
    assert.equal(items[1].content, "清除加载视频");
    assert.equal(items[1].disabled, false);
    items[1].callback();
    assert.equal(node.properties.xzgVideoQueue.length, 0);
    assert.equal(node.properties.xzgMultiVideo, false);
    assert.equal(toggle.value, false);
    assert.deepEqual(calls, [false, "clear", "render"]);
    node._xzgVideoQueuePending = 1;
    assert.equal(node._xzgPlayerMenuItems()[1].disabled, true);
});
