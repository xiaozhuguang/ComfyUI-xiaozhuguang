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

test('repeated sidebar renders preserve the workflow item receiving a click', () => {
    const { manager, app } = harness();
    let render;
    app.extensionManager.registerSidebarTab = tab => { render = tab.render; };
    let creates = 0;
    let opens = 0;
    let refreshes = 0;
    manager.enabled = true;
    manager.observeSidebarForIcon = () => {};
    manager.observePanelOpen = () => {};
    manager.onPanelOpen = () => { opens++; };
    manager.loadWorkflows = () => { refreshes++; };
    manager.createPanel = el => { creates++; el.panel = {}; };
    const container = () => ({ style: {}, querySelector() { return this.panel; } });
    const first = container();
    manager.registerSidebarTab();
    render(first);
    const pressedItem = first.panel;
    render(first);
    assert.equal(first.panel, pressedItem);
    assert.equal(creates, 1);
    assert.equal(opens, 1);
    assert.equal(refreshes, 1);

    let disconnected = false;
    manager._panelObserver = { disconnect() { disconnected = true; } };
    const remounted = container();
    render(remounted);
    assert.equal(creates, 2);
    assert.equal(manager._panelEl, remounted);
    assert.equal(disconnected, true);

    delete remounted.panel;
    render(remounted);
    assert.equal(creates, 3);
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
        assert.equal(workflow, 'missing.json');
        assert.equal(data.nodes.length, 0);
        loaded = true;
    };
    await manager.loadWorkflow('missing');
    assert.equal(loaded, true);
});

test('opening a renamed workflow missing from the index preserves its current path and name', async () => {
    const { manager, app } = harness();
    app.loadGraphData = async (data, clean, restore, workflow) => {
        assert.equal(workflow, '分类/重命名后的工作流.json');
    };
    await manager.loadWorkflow('分类/重命名后的工作流');
});

test('deleting the last tab creates a valid blank workflow before unloading its tracker', async () => {
    const { manager, app, store, workflows } = harness();
    const deleted = workflows[0];
    deleted.changeTracker = { deactivate() {} };
    store.activeWorkflow = deleted;
    store.openWorkflows = [deleted];
    app.extensionManager.command = { async execute(command) {
        assert.equal(command, 'Comfy.NewBlankWorkflow');
        store.activeWorkflow.changeTracker.deactivate();
        const blank = { path: 'workflows/Unsaved.json', changeTracker: { deactivate() {} } };
        store.openWorkflows.push(blank);
        store.activeWorkflow = blank;
    } };
    store.closeWorkflow = async workflow => {
        assert.notEqual(store.activeWorkflow, workflow);
        workflow.changeTracker = null;
        store.openWorkflows = store.openWorkflows.filter(w => w !== workflow);
    };
    await manager._closeDeletedWorkflowTabs([deleted]);
    await app.extensionManager.command.execute('Comfy.NewBlankWorkflow');
    assert.equal(store.openWorkflows.includes(deleted), false);
});

test('deleting active tabs switches to a surviving workflow before closing them', async () => {
    const { manager, store, workflows } = harness();
    store.activeWorkflow = workflows[0];
    store.openWorkflows = workflows;
    manager._activateOwnedWorkflowTab = async workflow => { store.activeWorkflow = workflow; };
    const closed = [];
    store.closeWorkflow = async workflow => {
        assert.notEqual(store.activeWorkflow, workflow);
        closed.push(workflow);
    };
    await manager._closeDeletedWorkflowTabs(workflows.slice(0, 2));
    assert.equal(store.activeWorkflow, workflows[2]);
    assert.deepEqual(closed, workflows.slice(0, 2));
});
