import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../web/xzg_video_combine.js', import.meta.url), 'utf8')
    .replace(/^import\s[^;]+;\r?\n/gm, '');

function load() {
    let extension;
    const jobs = [], prompts = [];
    const app = { registerExtension(value) { extension = value; }, canvas: {
        prompt(label, value, callback) { prompts.push({ label, value, callback }); },
    } };
    const context = vm.createContext({ app, createVideoOutputCache: () => ({}),
        queueMicrotask: job => jobs.push(job), xzgLang: () => 'zh' });
    vm.runInContext(source, context);
    return { context, app, jobs, prompts, extension };
}

test('save schemas use private factories even when other extensions replace shared factories', async () => {
    const { extension, app } = load();
    for (const name of ['XiaozhuguangVideoCombine', 'XiaozhuguangVideoSaveDaVinci']) {
        const schema = { name, input: { required: {
            '帧率': ['FLOAT', { widgetType: 'XZGFLOAT', default: 8 }],
            CRF: ['INT', { widgetType: 'XZGINT', default: 16 }],
            '模式': [['保存', '预览'], { default: '保存' }],
        } } };
        await extension.beforeRegisterNodeDef(function Node() {}, schema, app);
        for (const order of [0, 1]) {
            const foreign = { XZGINT() { throw Error('foreign factory'); }, XZGFLOAT() { throw Error('foreign factory'); } };
            const own = extension.getCustomWidgets();
            const registry = order ? { ...foreign, ...own } : { ...own, ...foreign };
            for (const [key, data] of Object.entries(schema.input.required)) {
                const node = {};
                const widget = registry[data[1].widgetType](node, key, data);
                assert.equal(widget.value, data[1].default);
                assert.equal(typeof widget.onPointerDown, 'function');
            }
        }
    }
});

test('CRF opens once after release and cleanup, never changes on drag', () => {
    const { context, app, jobs, prompts } = load();
    const widget = vm.runInContext("_xzgCreateNumberWidget({}, 'CRF', ['INT', {default:16,min:0,max:51}])", context);
    widget.mouse = vm.runInContext('_xzgCRFWidgetMouse', context);
    const node = { setDirtyCanvas() {} };
    // CanvasPointer.finally's setter runs the previous cleanup before replacing it.
    let cleanup;
    const pointer = { eDown: { type: 'pointerdown' },
        get finally() { return cleanup; },
        set finally(value) { try { cleanup?.(); } finally { cleanup = value; } },
    };
    for (let i = 0; i < 3; i++) {
        pointer.eUp = undefined;
        assert.equal(widget.onPointerDown(pointer, node), true);
        pointer.onDrag({ type: 'pointermove', deltaX: 50 });
        assert.equal(widget.value, i ? 23 : 16);
        pointer.eUp = { type: 'pointerup' };
        pointer.finally = undefined;
        delete pointer.onDrag;
        assert.equal(app.canvas.node_widget, null);
        assert.equal(prompts.length, i);
        jobs.shift()();
        assert.equal(prompts.length, i + 1);
        assert.equal(app.canvas._xzgAllowPrompt, false);
        prompts[i].callback('23');
        assert.equal(widget.value, 23);
        prompts[i].callback('invalid');
        assert.equal(widget.value, 23);
    }
});

test('linked controls cannot change values or open prompts', () => {
    const { context, jobs } = load();
    const widget = vm.runInContext("_xzgCreateNumberWidget({}, 'CRF', ['INT', {default:16}])", context);
    widget.mouse = vm.runInContext('_xzgCRFWidgetMouse', context);
    const node = { inputs: [{ name: 'CRF', link: 1 }] };
    context.widget = widget; context.node = node;
    vm.runInContext('_xzgKeepConvertedWidgetVisible(widget, node)', context);
    widget.mouse({ type: 'pointerup' }, [], node);
    assert.equal(widget.value, 16);
    assert.equal(jobs.length, 0);
});
