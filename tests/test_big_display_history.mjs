import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const history = fs.readFileSync(new URL('../web/xzg_display_history.js', import.meta.url), 'utf8');
const display = fs.readFileSync(new URL('../web/xzg_big_display.js', import.meta.url), 'utf8');
function harness(load = Promise.resolve([])) {
    const saves = [];
    const context = vm.createContext({cloudLoad: () => load, cloudSave: async (key, value) => saves.push(JSON.parse(JSON.stringify(value))), nodeType: function Node() { this.inputs = [{name:"input_b"}]; this.outputs = [{name:"A"},{name:"B"}]; }, DEFAULT_CFG: {}, hideNodeHeader() {}, hideNodeInputDecoration() {}});
    vm.runInContext(history.replace(/^import .*;\r?\n/gm, '').replace(/export /g, ''), context);
    vm.runInContext(display.slice(display.indexOf('        const origConfigure ='), display.indexOf('        const origOnMouseDown =')), context);
    return {context, saves, run: code => vm.runInContext(code, context)};
}
test('properties-only workflow switches retain B; empty workflows clear old state', async () => {
    const h = harness();
    h.run(`const node = new nodeType(); node.id = 1;
        node.onExecuted({text_a:['A'],text_b:['B'],connected_a:[true],connected_b:[true]});
        node.onDblClick(); const out = {}; node.onSerialize(out);
        const restored = new nodeType(); restored.onConfigure({properties:out.properties});`);
    assert.equal(h.run('restored._texts[0]'), 'B');
    assert.equal(h.run('restored._xzgDisplayChannel'), 1);
    h.run('restored.onConfigure({widgets_values:[],properties:{}})');
    assert.equal(h.run('restored._texts.length'), 0);
    assert.equal(h.run('restored._xzgDisplayChannels'), null);
    await h.run('getDisplayHistory()');
});
test('legacy widget restore and repeated serialization', () => {
    const h = harness();
    h.run(`const node = new nodeType(); node.onConfigure({widgets_values:[{texts:['legacy'],cfg:{}}]});
        const out = {widgets_values:[{texts:['old'],cfg:{}}]}; node.onSerialize(out); node.onSerialize(out);`);
    assert.equal(h.run('node._texts[0]'), 'legacy');
    assert.equal(h.run('out.widgets_values.length'), 1);
});
test('cloud initialization race, execution snapshots and duplicate suppression', async () => {
    let resolve;
    const h = harness(new Promise(r => { resolve = r; }));
    h.run(`const node = new nodeType(); node.id = 7; node.title = 'Display';
        node.onExecuted({text:['first']}); node.onExecuted({text:['second']}); node.onExecuted({text:['second']});`);
    resolve([{time:1,nodeId:'7',state:{texts:['previous']}}]);
    const entries = await h.run('getDisplayHistory()');
    assert.deepEqual(Array.from(entries, e => e.state.texts[0]), ['second','first','previous']);
    assert.equal(h.saves.length, 2);
    assert.equal(h.saves[0][0].state.texts[0], 'first');
});
test('B-only execution and history restoration without recording again', async () => {
    const h = harness();
    h.run(`const node = new nodeType(); node.id = 9;
        node.onExecuted({text_a:[],text_b:['B only'],connected_a:[false],connected_b:[true]});`);
    const entries = await h.run('getDisplayHistory()');
    assert.equal(entries[0].state.channel, 1);
    h.context.entry = entries[0]; h.run('node._restoreDisplayState(entry.state)');
    assert.equal(h.run('node._texts[0]'), 'B only');
    assert.equal((await h.run('getDisplayHistory()')).length, 1);
});
test('latest 200 history entries retained', async () => {
    const h = harness();
    h.run(`const node = new nodeType(); node.id = 1; for(let i=0;i<205;i++) node.onExecuted({text:[String(i)]});`);
    const entries = await h.run('getDisplayHistory()');
    assert.equal(entries.length, 200);
    assert.equal(entries[0].state.texts[0], '204');
    assert.equal(entries.at(-1).state.texts[0], '5');
});


test('unified backup maps display history to its independent category', () => {
    const panel = fs.readFileSync(new URL('../web/xzg_theme_panel.js', import.meta.url), 'utf8');
    const h = harness();
    const start = panel.indexOf('function xzgExportCategoryForKey(');
    const end = panel.indexOf('window.XZGThemePanel =', start);
    vm.runInContext(panel.slice(start, end), h.context);
    assert.equal(h.run('xzgExportCategoryForKey(DISPLAY_HISTORY_KEY)'), 'displayHistory');
    assert.equal(h.run('xzgExportCategoryForKey("xzg_text_box_god_presets")'), 'textBoxGodPresets');
});
