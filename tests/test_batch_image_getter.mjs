import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

for (const type of ["XiaozhuguangBatchImageGetter", "XiaozhuguangBatchMaskGetter"]) {
test(`${type}: output count controls sockets on creation, adjustment and restore`, () => {
    const source = fs.readFileSync(new URL("../web/xzg_batch_image_getter.js", import.meta.url), "utf8")
        .replace(/^import .*;\r?\n/gm, "");
    let extension;
    const context = vm.createContext({ app: { graph: {}, registerExtension(value) { extension = value; } } });
    vm.runInContext(source, context);
    class Node {
        constructor() {
            this.type = type;
            this.outputs = Array.from({ length: 7 }, (_, i) => ({ name: String(i + 1), type: "IMAGE" }));
            this.widgets = [{ name: "输出数量", value: 7 }];
        }
        addOutput(name, type) { this.outputs.push({ name, type }); }
        removeOutput(index) { this.outputs.splice(index, 1); }
        computeSize() { return [200, 800]; }
        setSize() {}
    }
    extension.beforeRegisterNodeDef(Node, { name: type });
    const node = new Node();
    node.onNodeCreated();
    const socketType = type.includes("Mask") ? "MASK" : "IMAGE";
    assert.equal(node.outputs.length, 7);
    assert.ok(node.outputs.every(output => output.type === socketType));
    // Easy Use reload creates a fresh node, then assigns values without callbacks.
    node.widgets[0].value = 12;
    assert.equal(node.outputs.length, 12);
    node.outputs[11].links = [456];
    node.widgets[0].value = 12;
    assert.deepEqual(node.outputs[11].links, [456]);
    node.outputs[0].links = [123];
    node.widgets[0].value = 1;
    assert.equal(node.outputs.length, 1);
    node.widgets[0].callback();
    assert.equal(node.outputs.length, 1);
    node.onConfigure({ widgets_values: [3] });
    assert.equal(node.outputs.length, 3);
    assert.deepEqual(node.outputs[0].links, [123]);
    assert.equal(node.outputs[2].name, "3");
    assert.equal(node.outputs[2].type, socketType);
    node.widgets[0].value = 20;
    node.widgets[0].callback();
    assert.equal(node.outputs.length, 20);
});
}
