import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../web/xzg_group.js', import.meta.url), 'utf8');
function harness() {
    const root = { extra: {}, _nodes: [] };
    const app = { graph: root, canvas: { graph: root }, registerExtension() {} };
    const context = vm.createContext({ app, window: {}, console: { log() {} },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } });
    vm.runInContext(source.replace(/^import .*;\r?\n/gm, '') + '\nglobalThis.group = XZGGroup;', context);
    const group = context.group;
    group.rebuildAllEls = () => {};
    group.applyBypassStates = () => {};
    group.calcBounds = () => ({ x: 0, y: 0, w: 300, h: 200 });
    group._installGroupGraphHooks = () => {};
    return { root, app, group };
}
const backup = () => ({ id: 'parent', title: 'Main group', nodeIds: [1], bounds: { x: 10, y: 20, w: 600, h: 400 } });

test('entering a subgraph does not restore parent groups from any node backup', () => {
    for (const field of ['_xzgGroupData', '_xzgGroup', 'properties']) {
        const { root, app, group } = harness();
        const node = { id: 1, _xzgGroupId: 'parent' };
        node[field] = field === 'properties' ? { _xzgGroup: backup() } : backup();
        root.extra.xzgGroups = { parent: backup() };
        group._activateGroupGraph(root);
        const sub = { id: 'sub', extra: {}, _nodes: [node] };
        app.canvas.graph = sub;
        group.restoreGroups();
        assert.equal(Object.keys(group.groups).length, 0);
        assert.equal(root.extra.xzgGroups.parent.title, 'Main group');
        group._saveGraphGroups(sub);
        assert.equal(Object.keys(sub.extra.xzgGroups).length, 0);
        app.canvas.graph = root;
        group._switchGraph();
        assert.equal(group.groups.parent.title, 'Main group');
    }
});

test('root workflows retain legacy node backup recovery', () => {
    const { root, group } = harness();
    root._nodes = [{ id: 1, _xzgGroupId: 'parent', _xzgGroupData: backup() }];
    group.restoreGroups();
    assert.equal(group.groups.parent.title, 'Main group');
});

test('subgraph-owned groups remain recoverable and isolated across nested navigation', () => {
    const { root, app, group } = harness();
    const sub = { id: 'sub', extra: { xzgGroups: { parent: backup() } },
        _nodes: [{ id: 1, _xzgGroupId: 'parent', _xzgGroupData: backup() }] };
    app.canvas.graph = sub;
    group.restoreGroups();
    assert.equal(group.groups.parent.title, 'Main group');
    app.canvas.graph = { id: 'nested', extra: {}, _nodes: [] };
    group._switchGraph();
    assert.equal(Object.keys(group.groups).length, 0);
    app.canvas.graph = sub;
    group._switchGraph();
    assert.equal(group.groups.parent.title, 'Main group');
    assert.equal(root.extra.xzgGroups, undefined);
});

test('partial subgraph conversion clears every parent backup field', () => {
    const { root, group } = harness();
    group._activateGroupGraph(root);
    group.groups = { parent: { ...backup(), nodeIds: [1, 2] } };
    const node = { id: 1, _xzgGroupId: 'parent', _xzgGroupData: backup(),
        _xzgGroup: backup(), properties: { _xzgGroup: backup(), _xzgGroupId: 'parent' } };
    const sub = { extra: {}, _nodes: [node] };
    group._onSubgraphConverted({ id: 3, graph: root, subgraph: sub });
    assert.equal(node._xzgGroupId, null);
    assert.equal(node._xzgGroupData, null);
    assert.equal(node.properties._xzgGroup, undefined);
    assert.deepEqual(Array.from(group.groups.parent.nodeIds), [2, 3]);
    assert.equal(Object.keys(sub.extra.xzgGroups).length, 0);
});
