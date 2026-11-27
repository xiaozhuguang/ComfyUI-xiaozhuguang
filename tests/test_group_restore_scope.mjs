import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../web/xzg_group.js', import.meta.url), 'utf8');
function harness() {
    const root = { extra: {}, _nodes: [] };
    const app = { graph: root, canvas: { graph: root }, registerExtension() {} };
    const frames = [];
    const context = vm.createContext({ app, window: {}, performance: { now: () => 0 }, console: { log() {} },
        requestAnimationFrame(callback) { frames.push(callback); },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } });
    vm.runInContext(source.replace(/^import .*;\r?\n/gm, '') + '\nglobalThis.group = XZGGroup;', context);
    const group = context.group;
    group.rebuildAllEls = () => {};
    group.applyBypassStates = () => {};
    group.calcBounds = () => ({ x: 0, y: 0, w: 300, h: 200 });
    group._installGroupGraphHooks = () => {};
    return { root, app, group, frames, clock: context.performance };
}
const backup = () => ({ id: 'parent', title: 'Main group', nodeIds: [1], bounds: { x: 10, y: 20, w: 600, h: 400 } });

test('canvas redraw commits group geometry and opacity together during zoom', () => {
    const { app, group, frames, clock } = harness();
    const canvas = app.canvas;
    const ds = canvas.ds = { scale: 1, offset: [0, 0] };
    canvas.canvas = {
        addEventListener() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 })
    };
    let dirty = false;
    canvas.setDirty = () => { dirty = true; };
    const fills = [];
    canvas.ctx = {
        globalAlpha: 1,
        save() {},
        beginPath() {},
        roundRect(x, y, width, height) { this.rect = [x, y, width, height]; },
        fill() { fills.push({ opacity: this.globalAlpha, rect: this.rect }); },
        restore() { this.globalAlpha = 1; }
    };
    group._switchGraph = () => {};
    group._setupImmediateSync = () => {};
    group.syncNodeMembership = () => {};
    group.updateGroupStyle = () => {};
    const style = {};
    const parent = { ...backup(), fadeEnabled: true, bgColor: 'rgba(20, 30, 40, 0.5)' };
    group.overlay = {};
    group.syncOverlayPosition = () => {};
    group.groups = { parent };
    group.groupEls = { parent: { style, _xzgRefs: {}, querySelector: () => null } };
    group.setupCanvasBgDraw();
    group.startSyncLoop();
    const draw = () => {
        dirty = false;
        canvas.onDrawBackground(canvas.ctx);
    };
    draw();
    assert.equal(style.width, '600px');
    assert.equal(style.opacity, '1');

    ds.scale = 0.5;
    frames.shift()();
    assert.equal(dirty, true);
    assert.equal(style.width, '600px');
    draw();
    assert.equal(style.width, '300px');
    assert.equal(style.opacity, '0');
    assert.equal(fills.length, 1);

    frames.shift()();
    assert.equal(dirty, true);
    draw();
    clock.now = () => 500;
    draw();
    assert.equal(style.opacity, '0.5');
    assert.deepEqual(fills.at(-1), { opacity: 0.5, rect: [10, 38, 600, 382] });

    parent.fadeEnabled = false;
    draw();
    assert.equal(style.opacity, '1');
    assert.equal(fills.at(-1).opacity, 1);
});

test('plain group keeps its screen bounds in sync when the canvas background skips a frame', () => {
    const { app, group, frames } = harness();
    const ds = app.canvas.ds = { scale: 0.56, offset: [200, -80] };
    app.canvas.canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }) };
    group._switchGraph = () => {};
    group._setupImmediateSync = () => {};
    group.syncNodeMembership = () => {};
    group.updateGroupStyle = () => {};
    const style = {};
    group.groups = { parent: backup() };
    group.groupEls = { parent: { style, _xzgRefs: {}, querySelector: () => null } };
    group.updatePositions();
    assert.equal(style.width, 600 * 0.56 + 'px');

    group.startSyncLoop();
    ds.scale = 0.83;
    ds.offset[0] = 100;
    frames.shift()();
    assert.equal(style.width, 600 * 0.83 + 'px');
    assert.equal(style.left, 110 * 0.83 + 'px');
    assert.deepEqual(group.groups.parent.bounds, backup().bounds);
});

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
