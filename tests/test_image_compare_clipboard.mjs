import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../web/xzg_image_compare.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');

function setup(overrides = {}) {
    let extension;
    const copied = [];
    const toasts = [];
    const context = {
        app: { registerExtension: e => { extension = e; }, getPreviewFormatParam: () => '', getRandParam: () => '',
            extensionManager: { toast: { add(message) { toasts.push(message); } } } },
        api: { apiURL: url => url }, xzgTh: zh => zh,
        Image: class {},
        xzgCopyImageToClipboard: async image => { copied.push(image); },
        ...overrides,
    };
    const Widget = vm.runInNewContext(`${source}\nXzgImageCompareWidget`, context);
    return { extension, Widget, copied, toasts };
}

for (const type of ['XiaozhuguangImageCompare', 'XiaozhuguangImageCompareCustom']) {
    test(`${type} copies current A/B originals, including after swapping`, async () => {
        const { extension, Widget, copied } = setup();
        class Node {
            getExtraMenuOptions(canvas, options) { options.push({ content: 'Existing action' }); }
            setDirtyCanvas() {}
        }
        await extension.beforeRegisterNodeDef(Node, { name: type });
        const node = new Node();
        node.widgets = [];
        node.canvasWidget = new Widget('compare', node);
        node.onExecuted({
            a_images: [{ filename: 'small-a.jpg', real_token: 'a-token', real_index: 4 }],
            b_images: [{ filename: 'small-b.jpg', real_token: 'b-token', real_index: 2, has_alpha: true, transparent_filename: 'small-b.png' }],
        });
        let options = [];
        node.getExtraMenuOptions(null, options);
        assert.equal(options[0].content, '复制 A 图到剪贴板');
        assert.equal(options[1].content, '复制 B 图到剪贴板');
        assert.equal(options.at(-1).content, 'Existing action');
        options[0].callback(); options[1].callback();
        assert.equal(copied[0].real_token, 'a-token');
        assert.equal(copied[0].real_index, 4);
        assert.equal(copied[1].real_token, 'b-token');
        assert.equal(copied[1].has_alpha, true);
        node.canvasWidget._swapAB();
        options = [];
        node.getExtraMenuOptions(null, options);
        options[0].callback();
        assert.equal(copied[2].real_token, 'b-token');
    });
}

test('empty comparison has no copy actions and one image has only A', async () => {
    const { extension, Widget } = setup();
    class Node { setDirtyCanvas() {} }
    await extension.beforeRegisterNodeDef(Node, { name: 'XiaozhuguangImageCompare' });
    const node = new Node(); node.widgets = []; node.canvasWidget = new Widget('compare', node);
    let options = []; node.getExtraMenuOptions(null, options);
    assert.equal(options.length, 0);
    node.onExecuted({ a_images: [{ filename: 'a.jpg', real_token: 'single' }] });
    node.getExtraMenuOptions(null, options);
    assert.equal(options.filter(Boolean).length, 1);
});

test('batch selection copies selected original instead of first batch entry', async () => {
    const { extension, Widget, copied } = setup();
    class Node { setDirtyCanvas() {} }
    await extension.beforeRegisterNodeDef(Node, { name: 'XiaozhuguangImageCompareCustom' });
    const node = new Node(); node.widgets = []; node.canvasWidget = new Widget('compare', node);
    node.onExecuted({ a_images: [0, 1, 2].map(i => ({ filename: `${i}.jpg`, real_token: 'batch', real_index: i })) });
    node.canvasWidget._setSelected([node.canvasWidget.value.images[2], node.canvasWidget.value.images[0]]);
    const options = []; node.getExtraMenuOptions(null, options); options[0].callback();
    assert.equal(copied[0].real_index, 2);
});

function hookSetup() {
    const listeners = new Map();
    const menus = [];
    const copied = [];
    function element() {
        return { style: {}, children: [], setAttribute() {},
            appendChild(child) { this.children.push(child); },
            contains(target) { return target === this || this.children.includes(target); },
            remove() { this.removed = true; },
            getBoundingClientRect: () => ({ width: 190, height: 64 }),
        };
    }
    const canvasEl = element();
    canvasEl.getBoundingClientRect = () => ({ left: 20, top: 10 });
    const node = { type: 'XiaozhuguangImageCompareCustom', pos: [100, 200], flags: {},
        canvasWidget: { _previewBounds: [0, 60, 300, 220], selected: [{ real_token: 'a' }, { real_token: 'b' }] } };
    class Canvas {
        constructor() { this.canvas = canvasEl; this.ds = { scale: 2, offset: [10, -20] }; this.native = []; }
        getNodeAtPosition() { return node; }
        processMouseDown(event) { this.native.push(['mouse', event]); return 'native'; }
        processContextMenu(target, event) { this.native.push(['menu', event]); return 'native'; }
    }
    const canvas = new Canvas();
    const context = {
        app: { canvas, registerExtension() {}, extensionManager: { toast: { add() {} } } },
        window: { innerWidth: 800, innerHeight: 600,
            addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
            removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(f => f !== fn)); } },
        document: { createElement: element, body: { appendChild(menu) { menus.push(menu); } } },
        xzgTh: zh => zh, xzgCopyImageToClipboard: async image => { copied.push(image); },
    };
    const hooks = vm.runInNewContext(`${source}\n({ installCompareCopyHooks, compareImageAreaAt, compareWidgetAtEvent })`, context);
    hooks.installCompareCopyHooks();
    function eventAt(localX, localY, type = 'contextmenu', target = canvasEl) {
        return { type, button: 2, target,
            clientX: (node.pos[0] + localX + canvas.ds.offset[0]) * canvas.ds.scale + 20,
            clientY: (node.pos[1] + localY + canvas.ds.offset[1]) * canvas.ds.scale + 10,
            preventDefault() { this.prevented = true; }, stopPropagation() {},
            stopImmediatePropagation() { this.stopped = true; } };
    }
    return { canvas, node, menus, listeners, eventAt, hooks, copied };
}

test('preview right-click only shows copy actions, header and controls keep native menu', () => {
    const { canvas, node, menus, listeners, eventAt, copied } = hookSetup();
    const handler = listeners.get('contextmenu')[0];
    const preview = eventAt(120, 150); handler(preview);
    assert.equal(preview.prevented, true); assert.equal(preview.stopped, true);
    assert.deepEqual(menus[0].children.map(item => item.textContent), ['复制 A 图到剪贴板', '复制 B 图到剪贴板']);
    menus[0].children[1].onclick();
    assert.equal(copied[0].real_token, 'b'); assert.equal(menus[0].removed, true);
    for (const [x, y] of [[100, -15], [100, 30], [-1, 150], [301, 150], [100, 290]]) {
        const event = eventAt(x, y); handler(event); assert.equal(event.prevented, undefined);
        assert.equal(canvas.processContextMenu(node, event), 'native');
    }
});

test('pointer and graph hooks suppress native preview menu but pass left-click through', () => {
    const { canvas, node, menus, listeners, eventAt } = hookSetup();
    const event = eventAt(100, 150, 'pointerdown'); listeners.get('pointerdown')[0](event);
    assert.equal(event.stopped, true);
    assert.equal(canvas.processMouseDown(eventAt(100, 150, 'mousedown')), true);
    canvas.processContextMenu(node, eventAt(100, 150));
    assert.equal(canvas.native.length, 0); assert.equal(menus.length, 3);
    const left = eventAt(100, 150, 'pointerdown'); left.button = 0;
    listeners.get('pointerdown')[0](left);
    assert.equal(left.prevented, undefined); assert.equal(canvas.processMouseDown(left), 'native');
});

test('copy menu closes on Escape and excludes other nodes, collapsed nodes and UI overlays', () => {
    const { node, menus, listeners, eventAt } = hookSetup();
    const handler = listeners.get('contextmenu')[0];
    handler(eventAt(100, 150));
    listeners.get('keydown')[0]({ type: 'keydown', key: 'Escape' });
    assert.equal(menus[0].removed, true); assert.equal(listeners.get('keydown').length, 0);
    node.flags.collapsed = true;
    const collapsed = eventAt(100, 150); handler(collapsed); assert.equal(collapsed.prevented, undefined);
    node.flags.collapsed = false; node.type = 'OtherNode';
    const other = eventAt(100, 150); handler(other); assert.equal(other.prevented, undefined);
    node.type = 'XiaozhuguangImageCompareCustom';
    const overlay = eventAt(100, 150, 'contextmenu', {}); handler(overlay); assert.equal(overlay.prevented, undefined);
});

test('menu pointerdown triggers copy before graph dismiss handlers; later click cannot copy twice', () => {
    const { listeners, menus, eventAt, copied } = hookSetup();
    listeners.get('contextmenu')[0](eventAt(100, 150));
    const menu = menus[0], button = menu.children[1];
    const press = { type: 'pointerdown', button: 0, target: button,
        preventDefault() { this.prevented = true; }, stopPropagation() {},
        stopImmediatePropagation() { this.stopped = true; } };
    listeners.get('pointerdown')[0](press);
    assert.equal(press.prevented, true); assert.equal(press.stopped, true);
    assert.equal(copied.length, 1); assert.equal(copied[0].real_token, 'b');
    assert.equal(menu.removed, true);
    button.onclick();
    assert.equal(copied.length, 1);
});

test('native context menu is suppressed over copy popup without triggering copy', () => {
    const { listeners, menus, eventAt, copied } = hookSetup();
    const handler = listeners.get('contextmenu')[0];
    handler(eventAt(100, 150));
    const event = { type: 'contextmenu', button: 2, target: menus[0].children[0],
        preventDefault() { this.prevented = true; }, stopPropagation() {},
        stopImmediatePropagation() { this.stopped = true; } };
    handler(event);
    assert.equal(event.prevented, true); assert.equal(event.stopped, true);
    assert.equal(copied.length, 0); assert.equal(menus.length, 1);
});

test('copy succeeds or fails without showing notifications', async () => {
    for (const failure of [false, true]) {
        const { extension, Widget, toasts } = setup({
            console: { warn() {} },
            xzgCopyImageToClipboard: async () => {
                if (failure) throw new Error('请重启 ComfyUI 并重新执行对应节点');
            },
        });
        class Node { setDirtyCanvas() {} }
        await extension.beforeRegisterNodeDef(Node, { name: 'XiaozhuguangImageCompare' });
        const node = new Node(); node.widgets = []; node.canvasWidget = new Widget('compare', node);
        node.onExecuted({ a_images: [{ filename: 'preview.jpg' }] });
        const options = []; node.getExtraMenuOptions(null, options);
        await options[0].callback();
        assert.equal(toasts.length, 0);
    }
});
