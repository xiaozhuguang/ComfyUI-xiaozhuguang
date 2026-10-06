const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const path = require('node:path');

function harness({ render = false } = {}) {
    class Graph {
        constructor(id) { this.id = id; this._nodes = []; this.extra = {}; }
        serialize() { return { nodes: this._nodes.map(n => ({ id: n.id })), extra: { ...this.extra } }; }
        asSerialisable() { return { nodes: this._nodes.map(n => ({ id: n.id })), extra: { ...this.extra } }; }
        configure(data) { this.clear(); this.extra = data.extra || {}; this._nodes = data.nodes || []; }
        clear() { this._nodes = []; this.extra = {}; }
        _unpackSubgraphImpl(container) {
            this._nodes = this._nodes.filter(n => n !== container);
            for (const source of container.subgraph._nodes) {
                this._nodes.push({ ...source, id: Number(source.id) + 100,
                    pos: [source.pos[0] + 100, source.pos[1] + 200] });
            }
        }
        setDirtyCanvas() {}
    }
    const root = new Graph('root');
    const app = { graph: root, canvas: { graph: root }, registerExtension() {},
        async graphToPrompt(graph = root) { return { workflow: graph.serialize() }; },
        async loadGraphData(data) { root.configure(data); },
        async queuePrompt(...args) { app.queued = args; return true; } };
    const storage = new Map();
    const frames = [];
    const context = vm.createContext({ app, window: { LiteGraph: { LGraph: Graph } },
        LiteGraph: { NEVER: 2 }, console: { log() {}, warn() {}, error() {} },
        localStorage: { getItem: k => storage.get(k) ?? null,
            setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
        document: { removeEventListener() {}, getElementById() { return null; } },
        setTimeout() {}, setInterval() { return 1; },
        requestAnimationFrame(callback) { frames.push(callback); return frames.length; } });
    const source = fs.readFileSync(path.join(__dirname, '../web/xzg_group.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '');
    vm.runInContext(source + '\nglobalThis.manager = XZGGroup;', context);
    const manager = context.manager;
    if (render) {
        manager.overlay = { appendChild() {} };
        manager.buildGroupEl = () => ({ style: {}, remove() {} });
        manager.updateGroupStyle = () => {};
    } else manager.rebuildAllEls = () => {};
    manager.setupSerializationHooks();
    manager._switchGraph();
    return { manager, app, root, Graph, storage, frames };
}

function group(id, nodeIds = [1]) {
    return { id, title: id, nodeIds, bounds: { x: 0, y: 0, w: 300, h: 200 } };
}
function output(id) {
    return { id, mode: 0, pos: [20, 20], size: [100, 60], boundingRect: [20, 20, 100, 60], constructor: { nodeData: { output_node: true } } };
}

test('same local node IDs stay isolated while entering and leaving subgraphs', () => {
    const { manager, app, root, Graph, storage } = harness();
    const sub = new Graph('sub');
    root._nodes = [output(1)]; sub._nodes = [output(1)];
    manager.groups.main = group('main');
    app.canvas.graph = sub; manager._switchGraph();
    assert.equal(manager.groups.main, undefined);
    manager.groups.inner = group('inner'); manager.syncGroupsToExtra();
    assert.ok(storage.has('xzg_groups_backup:sub'));
    assert.ok(storage.has('xzg_groups_backup'));
    assert.equal(root.extra.xzgGroups.inner, undefined);
    app.canvas.graph = root; manager._switchGraph();
    assert.ok(manager.groups.main); assert.equal(manager.groups.inner, undefined);
    app.canvas.graph = sub; manager._switchGraph();
    assert.ok(manager.groups.inner);
    assert.equal(manager.getGroupNodes('inner').length, 1);
    assert.equal(manager.getGroupNodes('inner')[0], sub._nodes[0]);
});

test('serializing and saving from inside a subgraph preserves both owners', async () => {
    const { manager, app, root, Graph } = harness();
    const sub = new Graph('sub');
    root._nodes = [output(1)]; sub._nodes = [output(1)];
    manager.groups.main = group('main');
    app.canvas.graph = sub; manager._switchGraph();
    manager.groups.inner = group('inner');
    manager._setupExtraBasedPersistence();
    const saved = await app.graphToPrompt();
    assert.deepEqual(Object.keys(saved.workflow.extra.xzgGroups), ['main']);
    assert.deepEqual(Object.keys(sub.serialize().extra.xzgGroups), ['inner']);
    const exportedSub = await app.graphToPrompt(sub);
    assert.deepEqual(Object.keys(exportedSub.workflow.extra.xzgGroups), ['inner']);
});

test('clearing and configuring an inactive subgraph leaves visible groups untouched', () => {
    const { manager, root, Graph } = harness();
    root._nodes = [output(1)]; manager.groups.main = group('main');
    const sub = new Graph('sub');
    sub.clear(); assert.ok(manager.groups.main);
    sub.configure({ nodes: [output(1)], extra: { xzgGroups: { inner: group('inner') } } });
    assert.ok(manager.groups.main);
    assert.deepEqual(Object.keys(sub.serialize().extra.xzgGroups), ['inner']);
});

test('nested output paths use container IDs and native partial execution', async () => {
    const { manager, app, root, Graph } = harness();
    const sub = new Graph('sub'); const nested = new Graph('nested');
    nested._nodes = [output(3)];
    const container = { id: 2, mode: 0, pos: [20, 20], size: [100, 60], boundingRect: [20, 20, 100, 60], subgraph: nested };
    sub._nodes = [container];
    root._nodes = [{ id: 10, mode: 0, pos: [20, 20], size: [100, 60], boundingRect: [20, 20, 100, 60], subgraph: sub }];
    manager.groups.main = group('main', [10]);
    assert.deepEqual(Array.from(manager.getGroupOutputExecutionIds('main')), ['10:2:3']);
    app.canvas.graph = sub; manager._switchGraph(); manager.groups.inner = group('inner', [2]);
    assert.equal(await manager.queueGroupOutputNodes('inner'), true);
    assert.deepEqual(Array.from(app.queued[2]), ['10:2:3']);
    container.mode = 4;
    assert.deepEqual(Array.from(manager.getGroupOutputExecutionIds('inner')), []);
});

test('subgraph undo restores its serialized groups and root clear removes visible subgraph state', () => {
    const { manager, app, root, Graph } = harness();
    const sub = new Graph('sub'); sub._nodes = [output(1)];
    app.canvas.graph = sub; manager._switchGraph(); manager.groups.inner = group('inner');
    sub.configure({ nodes: [output(1)], extra: { xzgGroups: { restored: group('restored') } } });
    assert.deepEqual(Object.keys(manager.groups), ['restored']);
    root.clear();
    assert.deepEqual(Object.keys(manager.groups), []);
    assert.equal(manager._activeGraph, root);
});

test('conversion moves full groups and keeps partially converted groups around the container', () => {
    const { manager, root, Graph } = harness();
    const sub = new Graph('sub');
    sub._nodes = [output(1), output(2)];
    const container = { id: 10, graph: root, subgraph: sub };
    root._nodes = [output(3), container];
    manager.groups.full = group('full', [1]);
    manager.groups.partial = group('partial', [2, 3]);
    sub._nodes[0]._xzgGroupId = 'full';
    sub._nodes[1]._xzgGroupId = 'partial';
    manager._onSubgraphConverted(container);
    assert.equal(manager.groups.full, undefined);
    assert.ok(sub.extra.xzgGroups.full);
    assert.deepEqual(Array.from(manager.groups.partial.nodeIds), [3, 10]);
    assert.equal(sub._nodes[1]._xzgGroupId, null);
});

test('unpacking remaps IDs, shifts bounds and keeps repeated instances independent', () => {
    const { manager, root } = harness();
    manager.groups.outer = group('outer', [10]);
    const sourceNodes = [{ id: 1, pos: [20, 20] }];
    const newNodes = [output(101)]; newNodes[0].pos = [120, 220];
    manager._restoreUnpackedGroups(root, 10, sourceNodes, { inner: group('inner') }, newNodes);
    const restored = Object.values(manager.groups).find(g => g.id !== 'outer');
    assert.deepEqual(Array.from(restored.nodeIds), [101]);
    assert.equal(restored.bounds.x, 100); assert.equal(restored.bounds.y, 200);
    assert.deepEqual(Array.from(manager.groups.outer.nodeIds), [101]);
    const second = [output(102)];
    manager._restoreUnpackedGroups(root, 11, sourceNodes, { inner: group('inner') }, second);
    assert.notEqual(newNodes[0]._xzgGroupId, second[0]._xzgGroupId);
});

test('canonical snapshots immediately capture active group changes without waiting for backup timers', () => {
    const { manager, app, root, Graph } = harness();
    root._nodes = [output(1)]; manager.groups.main = group('main');
    assert.ok(root.asSerialisable().extra.xzgGroups.main);
    const sub = new Graph('sub'); sub._nodes = [output(1)];
    app.canvas.graph = sub; manager._switchGraph(); manager.groups.inner = group('inner');
    manager.groups.inner.title = 'edited';
    assert.equal(sub.asSerialisable().extra.xzgGroups.inner.title, 'edited');
    assert.equal(root.asSerialisable().extra.xzgGroups.inner, undefined);
});

test('running inside a shared definition targets the instance used to open it', () => {
    const { manager, app, root, Graph } = harness();
    const sub = new Graph('shared'); sub._nodes = [output(1)];
    const first = { id: 10, mode: 0, subgraph: sub };
    const second = { id: 20, mode: 0, subgraph: sub };
    root._nodes = [first, second];
    app.canvas.graph = sub; manager._switchGraph(); manager.groups.inner = group('inner');
    manager._onSubgraphOpened({ subgraph: sub, closingGraph: root, fromNode: second });
    assert.deepEqual(Array.from(manager.getGroupOutputExecutionIds('inner')), ['20:1']);
});

test('native unpack hook migrates groups before the caller records its final snapshot', () => {
    const { manager, root, Graph } = harness();
    const sub = new Graph('sub'); sub._nodes = [output(1)];
    sub.extra.xzgGroups = { inner: group('inner') };
    const container = { id: 10, subgraph: sub };
    root._nodes = [container];
    root._unpackSubgraphImpl(container);
    const snapshot = root.asSerialisable();
    const restored = Object.values(snapshot.extra.xzgGroups)[0];
    assert.deepEqual(Array.from(restored.nodeIds), [101]);
    assert.equal(restored.bounds.x, 100);
    assert.equal(root._nodes[0]._xzgGroupId, restored.id);
});

test('converting only outer direct members keeps the outer group with its remaining child group', () => {
    const { manager, root, Graph } = harness();
    const sub = new Graph('sub'); sub._nodes = [output(1)];
    const container = { id: 10, graph: root, subgraph: sub };
    manager.groups.outer = group('outer', [1]);
    manager.groups.child = group('child', [2]);
    manager.groups.child.bounds = { x: 20, y: 20, w: 100, h: 100 };
    manager._onSubgraphConverted(container);
    assert.ok(manager.groups.outer); assert.ok(manager.groups.child);
    assert.equal(sub.extra.xzgGroups.outer, undefined);
    assert.deepEqual(Array.from(manager.groups.outer.nodeIds), [10]);
    assert.equal(container._xzgGroupId, 'outer');
});

test('startup hydration on the same graph restores extra-only groups before saving', () => {
    const { manager, root } = harness();
    root._nodes = [output(1)];
    root.extra = { xzgGroups: { restored: group('restored') } };
    manager._switchGraph();
    assert.ok(manager.groups.restored);
    manager.syncGroupsToExtra();
    assert.ok(root.extra.xzgGroups.restored);
});

test('a snapshot cannot overwrite late-loaded groups with the initial empty state', () => {
    const { manager, root } = harness();
    root._nodes = [output(1)];
    root.extra = { xzgGroups: { restored: group('restored') } };
    const snapshot = root.asSerialisable();
    assert.ok(snapshot.extra.xzgGroups.restored);
    assert.ok(manager.groups.restored);
});

test('loading suspends restoration and writes until the workflow has finished hydrating', async () => {
    const { manager, app, root } = harness();
    root._nodes = [output(1)]; manager.groups.old = group('old'); manager.syncGroupsToExtra();
    let finish;
    const loading = new Promise(resolve => { finish = resolve; });
    app.loadGraphData = async data => {
        await loading;
        root.extra = data.extra;
        root._nodes = data.nodes;
    };
    manager._setupExtraBasedPersistence();
    const pending = app.loadGraphData({ nodes: [output(1)], extra: { xzgGroups: { restored: group('restored') } } });
    manager.syncGroupsToExtra();
    manager._switchGraph();
    assert.ok(root.extra.xzgGroups.old);
    assert.equal(manager.groups.restored, undefined);
    finish(); await pending;
    assert.deepEqual(Object.keys(manager.groups), ['restored']);
    assert.equal(manager._graphLoading, false);
});

test('deleting the last group stays deleted rather than recovering the previously saved copy', () => {
    const { manager, root } = harness();
    root._nodes = [output(1)]; manager.groups.only = group('only'); manager.syncGroupsToExtra();
    manager.killGroup('only'); manager.syncGroupsToExtra(); manager._switchGraph();
    assert.deepEqual(Object.keys(manager.groups), []);
    assert.deepEqual(Object.keys(root.extra.xzgGroups), []);
});

test('switching workflows from a subgraph does not return to the detached old layer', () => {
    const { manager, app, root, Graph } = harness();
    const oldSub = new Graph('old-sub'); oldSub._nodes = [output(1)];
    root.subgraphs = new Map([[oldSub.id, oldSub]]);
    app.canvas.graph = oldSub; manager._switchGraph(); manager.groups.old = group('old');
    app.canvas.setGraph = graph => { app.canvas.graph = graph; };
    root.clear();
    root.subgraphs = new Map();
    root.configure({ nodes: [output(1)], extra: { xzgGroups: { next: group('next') } } });
    manager._switchGraph();
    assert.equal(manager._activeGraph, root);
    assert.equal(app.canvas.graph, root);
    assert.deepEqual(Object.keys(manager.groups), ['next']);
});

test('direct workflow switching A to B to A restores only the active workflow groups', () => {
    const { manager, root } = harness();
    for (const name of ['A', 'B', 'A']) {
        root.clear();
        root.configure({ nodes: [output(1)], extra: { xzgGroups: { [name]: group(name) } } });
        manager._switchGraph(); manager.syncGroupsToExtra();
        assert.deepEqual(Object.keys(manager.groups), [name]);
        assert.deepEqual(Object.keys(root.extra.xzgGroups), [name]);
    }
});

test('tab switching restores and positions frames even when the static canvas does not redraw', () => {
    const { manager, app, root, frames } = harness({ render: true });
    manager.syncOverlayPosition = manager._updateRunButtonHover = manager._checkCanvasMovement =
        manager._setupImmediateSync = () => {};
    let positioned = 0;
    manager.updatePositions = () => { positioned++; manager._positionsPending = false; };
    manager.startSyncLoop();
    app.configuringGraph = true;
    root.configure({ nodes: [output(1)], extra: { xzgGroups: { restored: group('restored') } } });
    frames.shift()();
    assert.equal(positioned, 0);
    app.configuringGraph = false;
    frames.shift()();
    assert.ok(manager.groupEls.restored);
    assert.equal(positioned, 1);
    assert.equal(manager._positionsPending, false);
    frames.shift()();
    assert.equal(positioned, 1);
});
