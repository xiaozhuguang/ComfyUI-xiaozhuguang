import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../web/xzg_image_mask_convert.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "");
const context = vm.createContext({ app: { registerExtension() {} }, xzgT: zh => zh, queueMicrotask });
vm.runInContext(source, context);
const { syncGraph, outputType } = vm.runInContext("({ syncGraph, outputType })", context);
const TYPE = "XiaozhuguangImageMaskConvert";

function graphFor(nodes) {
    const graph = {
        _nodes: nodes, links: {},
        getNodeById(id) { return nodes.find(node => node.id === id); },
        removeLink(id) {
            const link = this.links[id];
            const output = this.getNodeById(link.origin_id).outputs[link.origin_slot];
            output.links = output.links.filter(value => value !== id);
            this.getNodeById(link.target_id).inputs[link.target_slot].link = null;
            delete this.links[id];
        },
    };
    for (const node of nodes) {
        node.graph = graph;
        node.removeInput = function (index) {
            if (this.inputs[index].link != null) graph.removeLink(this.inputs[index].link);
            this.inputs.splice(index, 1);
            for (const link of Object.values(graph.links)) if (link.target_id === this.id && link.target_slot > index) link.target_slot--;
        };
        node.removeOutput = function (index) {
            for (const id of [...(this.outputs[index].links || [])]) graph.removeLink(id);
            this.outputs.splice(index, 1);
            for (const link of Object.values(graph.links)) if (link.origin_id === this.id && link.origin_slot > index) link.origin_slot--;
        };
    }
    return graph;
}

function converter(id) {
    return { id, type: TYPE, inputs: [{ name: "source", type: "IMAGE,MASK", link: null }], outputs: [{ type: "IMAGE,MASK", links: [] }] };
}

function connect(graph, from, to, inputSlot = 0, outputSlot = 0) {
    const id = Object.keys(graph.links).length + 1;
    graph.links[id] = { origin_id: from.id, origin_slot: outputSlot, target_id: to.id, target_slot: inputSlot };
    from.outputs[outputSlot].links ||= [];
    from.outputs[outputSlot].links.push(id);
    to.inputs[inputSlot].link = id;
    return id;
}

test("opposite types propagate through a converter chain regardless of node order", () => {
    const source = { id: 1, type: "Loader", outputs: [{ type: "IMAGE", links: [] }] };
    const first = converter(2), second = converter(3);
    const graph = graphFor([second, first, source]);
    connect(graph, source, first);
    connect(graph, first, second);
    syncGraph(graph);
    assert.equal(first.outputs[0].type, "MASK");
    assert.equal(second.outputs[0].type, "IMAGE");
    source.outputs[0].type = "MASK";
    syncGraph(graph);
    assert.equal(first.outputs[0].type, "IMAGE");
    assert.equal(second.outputs[0].type, "MASK");
});

test("changing direction removes only incompatible downstream links", () => {
    const source = { id: 1, type: "Loader", outputs: [{ type: "MASK", links: [] }] };
    const node = converter(2);
    const imageTarget = { id: 3, inputs: [{ type: "IMAGE" }] };
    const maskTarget = { id: 4, inputs: [{ type: "MASK" }] };
    const graph = graphFor([source, node, imageTarget, maskTarget]);
    connect(graph, source, node);
    const valid = connect(graph, node, imageTarget), invalid = connect(graph, node, maskTarget);
    syncGraph(graph);
    assert.ok(graph.links[valid]);
    assert.equal(graph.links[invalid], undefined);
});

test("legacy mask input and second output migrate together to slot zero", () => {
    const source = { id: 1, type: "Loader", outputs: [{ type: "MASK", links: [] }] };
    const node = { id: 2, type: TYPE, title: "小珠光图像↔遮罩",
        inputs: [{ name: "image", link: null }, { name: "mask", link: null }],
        outputs: [{ type: "MASK", links: [] }, { type: "IMAGE", links: [] }] };
    const target = { id: 3, inputs: [{ type: "IMAGE" }] };
    const graph = graphFor([source, node, target]);
    const inputLink = connect(graph, source, node, 1);
    const outputLink = connect(graph, node, target, 0, 1);
    syncGraph(graph);
    assert.equal(node.inputs.length, 1);
    assert.equal(node.inputs[0].name, "source");
    assert.equal(node.outputs.length, 1);
    assert.equal(graph.links[inputLink].target_slot, 0);
    assert.equal(graph.links[outputLink].origin_slot, 0);
    assert.equal(node.outputs[0].type, "IMAGE");
    assert.equal(node.title, "小珠光图像遮罩智能互转");
});

test("unconnected inputs and cycles keep an unresolved union type", () => {
    const a = converter(1), b = converter(2);
    const graph = graphFor([a, b]);
    assert.equal(outputType(a), "IMAGE,MASK");
    connect(graph, a, b);
    connect(graph, b, a);
    syncGraph(graph);
    assert.equal(a.outputs[0].type, "IMAGE,MASK");
});
