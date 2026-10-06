const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function harness() {
    const calls = [];
    const workflows = ['a', 'b', 'c'].map(name => ({
        path: `workflows/${name}.json`, isLoaded: true,
        content: JSON.stringify({ nodes: [{ id: name }] }),
        activeState: { nodes: [{ id: `${name}-edited` }] }
    }));
    const store = {
        getWorkflowByPath: path => workflows.find(w => w.path === path),
        isActive: () => false, isOpen: () => false,
        openWorkflow() { throw new Error('Must use a single graph loading entry point'); }
    };
    const app = { extensionManager: { workflow: store }, canvas: {} };
    const context = vm.createContext({ app, console, alert: message => { throw new Error(message); },
        xzgT: text => text, api: { async fetchApi() { return { ok: true, async json() { return { nodes: [] }; } }; } } });
    const source = fs.readFileSync(require('node:path').join(__dirname, '../web/xzg_workflows.js'), 'utf8');
    vm.runInContext(source.slice(source.indexOf('class XZGWorkflowsManager'), source.indexOf('workflowsInstance = new XZGWorkflowsManager();')) + '\nglobalThis.Manager = XZGWorkflowsManager;', context);
    const manager = Object.create(context.Manager.prototype);
    Object.assign(manager, { _loading: false, _loadQueue: [], workflows: [],
        getWorkflowMeta: () => ({}), saveMeta() {}, renderWorkflowList() {}, centerCanvasOnNodes() {} });
    return { manager, app, store, workflows, calls };
}

test('single click awaits canvas loading and preserves edited open workflow state', async () => {
    const { manager, app, workflows } = harness();
    let finish;
    app.loadGraphData = (data, clean, restore, workflow) => {
        assert.equal(data, workflows[0].activeState);
        assert.equal(workflow, workflows[0]);
        assert.equal(restore, true);
        return new Promise(resolve => { finish = resolve; });
    };
    const pending = manager.loadWorkflow('a');
    assert.equal(manager._loading, true);
    finish();
    await pending;
    assert.equal(manager._loading, false);
});

test('rapid clicks wait for the current load and then open only the last target', async () => {
    const { manager, app, calls } = harness();
    let finish;
    app.loadGraphData = async (data, clean, restore, workflow) => {
        calls.push(workflow.path);
        if (calls.length === 1) await new Promise(resolve => { finish = resolve; });
    };
    const pending = manager.loadWorkflow('a');
    await manager.loadWorkflow('b');
    await manager.loadWorkflow('c');
    assert.deepEqual(calls, ['workflows/a.json']);
    finish();
    await pending;
    assert.deepEqual(calls, ['workflows/a.json', 'workflows/c.json']);
});

test('workflow missing from official index loads through the same canvas entry point', async () => {
    const { manager, app } = harness();
    let loaded = false;
    app.loadGraphData = async (data, clean, restore, workflow) => {
        assert.equal(workflow, undefined);
        assert.equal(data.nodes.length, 0);
        loaded = true;
    };
    await manager.loadWorkflow('missing');
    assert.equal(loaded, true);
});
