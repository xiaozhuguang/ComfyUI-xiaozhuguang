const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const topology = fs.readFileSync(path.join(__dirname, '../web/lib/xzg_encrypt_topology.js'), 'utf8')
    .replace('export function', 'function');
function fixture(edges, selectedIds) {
    const ids = [...new Set(edges.flat())];
    const graph = { _nodes: ids.map(id => ({ id })), links: Object.fromEntries(
        edges.map(([origin_id, target_id], index) => [index, { origin_id, target_id }])) };
    const selected = graph._nodes.filter(node => selectedIds.includes(node.id));
    return { graph, selected };
}
function plan(edges, selectedIds) {
    const { graph, selected } = fixture(edges, selectedIds);
    const context = vm.createContext({ graph, selected });
    return JSON.parse(vm.runInContext(topology + '\nJSON.stringify(planEncryptedGroups(graph, selected).map(g => g.map(n => n.id)))', context));
}

test('safe selections remain one encrypted node', () => {
    assert.deepEqual(plan([[1, 2], [2, 3]], [1, 2]), [[1, 2]]);
    assert.deepEqual(plan([[1, 3], [2, 3]], [1, 2]), [[1, 2]]);
});
test('one or multiple omitted middle nodes trigger safe splitting', () => {
    assert.deepEqual(plan([[1, 2], [2, 3]], [1, 3]), [[1], [3]]);
    assert.deepEqual(plan([[1, 2], [2, 3], [3, 4]], [1, 4]), [[1], [4]]);
});
test('connected selections with an external return path are rejected', () => {
    assert.throws(() => plan([[1, 4], [1, 2], [2, 3], [3, 4]], [1, 4]), /遗漏/);
});
test('cycles between contracted groups are rejected', () => {
    assert.throws(() => plan([[1, 2], [3, 4], [1, 5], [5, 4], [3, 6], [6, 2]], [1, 2, 3, 4]), /遗漏/);
});
test('mixed numeric and string node IDs are normalized', () => {
    assert.deepEqual(plan([[1, '2'], ['2', 3]], [1, 3]), [[1], [3]]);
});
test('existing cycles are rejected before contraction can hide them', () => {
    assert.throws(() => plan([[1, 2], [2, 1]], [1, 2]), /已有依赖循环/);
});

async function shortcut(edges, selectedIds, fail = false) {
    const { graph, selected } = fixture(edges, selectedIds);
    const calls = [], alerts = [];
    const app = { canvas: { graph, selected_nodes: Object.fromEntries(selected.map(n => [n.id, n])) } };
    const context = vm.createContext({ app, console: { log() {}, error() {} },
        window: { addEventListener() {}, __xzgTools: {
            adminSecret: () => 'test-password',
            async addHiddenNode(nodes) { calls.push(nodes.map(n => n.id)); return !fail; },
        } }, alert: message => alerts.push(message),
        document: { createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } },
        setTimeout() {} });
    const source = fs.readFileSync(path.join(__dirname, '../web/xzg_node_tools.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '');
    vm.runInContext(topology + '\n' + source, context);
    await vm.runInContext('encryptSelectedNodes()', context);
    return { calls: JSON.parse(JSON.stringify(calls)), alerts, app };
}
test('shortcut uses the safe plan and clears removed selections', async () => {
    const result = await shortcut([[1, 2], [2, 3], [3, 4]], [1, 4]);
    assert.deepEqual(result.calls, [[1], [4]]);
    assert.equal(Object.keys(result.app.canvas.selected_nodes).length, 0);
});
test('shortcut rejects unsafe encryption without touching the graph', async () => {
    const result = await shortcut([[1, 4], [1, 2], [2, 4]], [1, 4]);
    assert.deepEqual(result.calls, []);
    assert.match(result.alerts[0], /依赖循环/);
    assert.equal(Object.keys(result.app.canvas.selected_nodes).length, 2);
});
test('shortcut stops when a group fails', async () => {
    const result = await shortcut([[1, 2], [2, 3]], [1, 3], true);
    assert.deepEqual(result.calls, [[1]]);
    assert.match(result.alerts[0], /停止后续分组/);
});

test('menu rejects long external return paths without falling back to encryption', async () => {
    const { graph, selected } = fixture([[1, 4], [1, 2], [2, 3], [3, 4]], [1, 4]);
    const alerts = [];
    let called = false;
    const context = vm.createContext({ app: { canvas: { graph,
        selected_nodes: Object.fromEntries(selected.map(n => [n.id, n])) } },
        window: {}, console: { log() {}, warn() {} }, setInterval() {},
        alert: message => alerts.push(message), nativeCallback: () => { called = true; } });
    const source = fs.readFileSync(path.join(__dirname, '../web/xzg_compose_tool.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '');
    vm.runInContext(topology + '\n' + source, context);
    await vm.runInContext('wrapGroupCallback(nativeCallback)()', context);
    assert.equal(called, false);
    assert.match(alerts[0], /依赖循环/);
});
