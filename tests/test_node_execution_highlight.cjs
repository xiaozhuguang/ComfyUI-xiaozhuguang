const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function harness({ running = true, vue = false, runningId = null, drawError = false } = {}) {
    let strokes = 0;
    let nativeDraws = 0;
    let dirty = 0;
    let nativeStyle;
    const nativeRunning = function () {
        assert.equal(this.id, 1);
        return running ? { color: '#0f0', lineWidth: 3 } : undefined;
    };
    class Canvas {
        drawNode(node) {
            nativeDraws++;
            nativeStyle = node.strokeStyles.running?.call(node);
            if (drawError) throw new Error('native draw failed');
        }
    }
    const canvas = new Canvas();
    canvas.setDirty = () => dirty++;
    const context = vm.createContext({
        console, performance: { now: () => 500 },
        LiteGraph: { vueNodesMode: vue, BOX_SHAPE: 1, CIRCLE_SHAPE: 4, NODE_TITLE_HEIGHT: 30 },
        LGraphCanvas: Canvas,
        app: { canvas, runningNodeId: runningId, graph: { setDirtyCanvas: () => dirty++ } },
    });
    context.window = context;
    const source = fs.readFileSync(path.join(__dirname, '../web/xzg_theme.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '');
    vm.runInContext(source.slice(0, source.indexOf('(function initThemeWhenReady()')), context);
    const manager = context.XZGThemeManager;
    manager.nodeHighlightActive = true;
    manager.nodeHighlightBreath = true;
    manager.nodeHighlightColor = '#ff0000,#0000ff';
    manager._ensureNodeHighlightHook();
    const node = { id: 1, type: 'Sleep', size: [200, 100], flags: {}, strokeStyles: { running: nativeRunning } };
    const ctx = {
        save() {}, restore() {}, beginPath() {}, roundRect() {}, rect() {}, clip() {},
        createLinearGradient() { return { addColorStop() {} }; },
        stroke() { strokes++; },
    };
    return { canvas, manager, node, ctx, nativeRunning,
        get strokes() { return strokes; }, get nativeDraws() { return nativeDraws; },
        get nativeStyle() { return nativeStyle; }, get dirty() { return dirty; } };
}

test('Nodes 1 draws execution effects from native running state when execution ID is absent', () => {
    const h = harness();
    h.canvas.drawNode(h.node, h.ctx);
    assert.equal(h.nativeDraws, 1);
    assert.equal(h.strokes, 3);
    assert.equal(h.nativeStyle, null, 'native green border is replaced by the custom effect');
    assert.ok(h.dirty > 0, 'breathing requests another frame');
    assert.equal(h.node.strokeStyles.running, h.nativeRunning);
});

test('native idle state takes precedence over a stale running ID', () => {
    const h = harness({ running: false, runningId: '1' });
    h.canvas.drawNode(h.node, h.ctx);
    assert.equal(h.strokes, 0);
    assert.equal(h.nativeStyle, null);
    assert.equal(h.node.strokeStyles.running, h.nativeRunning);
});

test('Nodes 2 leaves canvas execution rendering to its separate renderer', () => {
    const h = harness({ vue: true, runningId: '1' });
    h.canvas.drawNode(h.node, h.ctx);
    assert.equal(h.nativeDraws, 1);
    assert.equal(h.strokes, 0);
    assert.equal(h.nativeStyle.color, '#0f0');
    assert.equal(h.node.strokeStyles.running, h.nativeRunning);
});

test('old frontend without native running callback still uses the execution ID', () => {
    const h = harness({ runningId: '1' });
    delete h.node.strokeStyles.running;
    h.canvas.drawNode(h.node, h.ctx);
    assert.equal(h.strokes, 3);
});

test('disabled highlight leaves the native execution border intact', () => {
    const h = harness();
    h.manager.nodeHighlightActive = false;
    h.canvas.drawNode(h.node, h.ctx);
    assert.equal(h.nativeStyle.color, '#0f0');
    assert.equal(h.strokes, 0);
    assert.equal(h.node.strokeStyles.running, h.nativeRunning);
});

test('native running callback is restored even if the original renderer throws', () => {
    const h = harness({ drawError: true });
    assert.throws(() => h.canvas.drawNode(h.node, h.ctx), /native draw failed/);
    assert.equal(h.node.strokeStyles.running, h.nativeRunning);
});
