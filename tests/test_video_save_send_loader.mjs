import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../web/xzg_video_save_davinci.js", import.meta.url), "utf8")
    .replace(/^import\s[\s\S]*?;\r?\n/gm, "");

test("send saved video updates only enabled Godlike loader and preserves output path", async () => {
    const calls = [];
    const widget = { name: "视频", options: { values: [] }, callback: value => calls.push(value) };
    const target = { type: "XiaozhuguangVideoLoaderDaVinci", widgets: [widget] };
    const node = { _xzgVideoOutput: { filename: "clip.mp4", subfolder: "renders", type: "output" },
        graph: { nodes: [target, { type: target.type, mode: 4 }, { type: "XiaozhuguangVideoLoader" }] } };
    let enabled = true;
    let visible = true;
    let selection;
    const context = vm.createContext({ app: { registerExtension() {}, ui: { settings: { getSettingValue: () => enabled } } },
        xzgMenuItemVisible: () => visible,
        xzgShowLoaderTargetSelector: (targets, options) => { selection = { targets, options }; }, node });
    vm.runInContext(source + '\n_toast = () => {};', context);
    const items = vm.runInContext("_savedVideoMenu(node)", context);
    await items[0].callback();
    assert.equal(widget.value, "renders/clip.mp4 [output]");
    assert.deepEqual(calls, [widget.value]);
    assert.ok(widget.options.values.includes(widget.value));
    const second = { type: target.type, widgets: [{ name: "视频" }] };
    node.graph.nodes.push(second);
    vm.runInContext("_savedVideoMenu(node)[0].callback()", context);
    assert.deepEqual(Array.from(selection.targets), [target, second]);
    assert.equal(selection.options.title, "选择目标视频加载器-化神级");
    await selection.options.onSelect(second);
    assert.equal(second.widgets[0].value, "renders/clip.mp4 [output]");
    enabled = false;
    assert.equal(vm.runInContext("_savedVideoMenu(node).length", context), 0);
    enabled = true; visible = false;
    assert.equal(vm.runInContext("_savedVideoMenu(node).length", context), 0);
    visible = true; delete node._xzgVideoOutput;
    assert.equal(vm.runInContext("_savedVideoMenu(node)[0].disabled", context), true);
});
