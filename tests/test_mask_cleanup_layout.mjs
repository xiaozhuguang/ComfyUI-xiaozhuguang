import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

let extension;
const source = fs.readFileSync(new URL("../web/xzg_mask_cleanup_repair.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "");
vm.runInNewContext(source, { app: { registerExtension(value) { extension = value; } } });

const current = ["erode_dilate", "tapered_corners", "cleanup_enabled", "threshold", "method", "shrink", "min_pixels", "min_frames", "edge_grow", "repair_enabled", "fill_holes", "remove_isolated_pixels", "smooth", "blur", "mask_binarize", "mask_threshold"];
class Node {
    constructor() { this.widgets = current.map(name => ({ name, value: name === "tapered_corners" || name === "mask_binarize" ? false : name === "mask_threshold" ? .5 : null })); }
    configure(info) { info.widgets_values.forEach((value, i) => { this.widgets[i].value = value; }); }
    values() { return Object.fromEntries(this.widgets.map(widget => [widget.name, widget.value])); }
}
extension.beforeRegisterNodeDef(Node, { name: "XiaozhuguangMaskCleanupRepair" });

test("old cleanup and repair switches do not overwrite expansion", () => {
    const node = new Node();
    node.configure({ widgets_values: [true, .3, "收缩重建", 4, 32, 2, 4, false, 12, 3, 2, 1, 5, true, .7, true] });
    const values = node.values();
    assert.equal(values.erode_dilate, 12);
    assert.equal(values.cleanup_enabled, true);
    assert.equal(values.repair_enabled, false);
    assert.equal(values.tapered_corners, true);
    assert.equal(values.mask_binarize, true);
    assert.equal(values.mask_threshold, .7);
    assert.equal(values.blur, 5);
});

test("workflows predating binary controls keep new defaults", () => {
    const node = new Node();
    node.configure({ widgets_values: [false, .3, "连通区域", 4, 32, 2, 4, false, -3, 0, 0, 0, 0] });
    assert.equal(node.values().erode_dilate, -3);
    assert.equal(node.values().mask_binarize, false);
    assert.equal(node.values().mask_threshold, .5);
});

test("current workflow order is unchanged on reload", () => {
    const node = new Node();
    const values = [6, true, false, .4, "连通区域", 2, 64, 3, 1, true, 2, 0, 3, 4, false, .8];
    node.configure({ widgets_values: values });
    assert.deepEqual(node.widgets.map(widget => widget.value), values);
});
