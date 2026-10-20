import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../web/xzg_image_loader.js', import.meta.url), 'utf8');
const start = source.indexOf('function attachImageLoaderDOMWidget(');
const end = source.indexOf('function createImgBatchUI(', start);
assert.ok(start >= 0 && end > start);
let sync, disconnected = false, cleared = false;
const observed = [];
class ResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe(element) { observed.push(element); }
    disconnect() { disconnected = true; }
}
const attach = new Function('app', 'ResizeObserver', 'setInterval', 'clearInterval',
    source.slice(start, end) + '\nreturn attachImageLoaderDOMWidget;')(
    { canvas: { ds: { scale: 1 } } }, ResizeObserver,
    callback => { sync = callback; return 42; }, id => { assert.equal(id, 42); cleared = true; });
const host = () => ({
    listeners: new Set(),
    addEventListener(type, fn) { assert.equal(type, 'wheel'); this.listeners.add(fn); },
    removeEventListener(type, fn) { assert.equal(type, 'wheel'); this.listeners.delete(fn); },
});
const legacyHost = host(), vueHost = host();
let labels = 0, bypass = 0, layout = 0;
const ui = {
    container: { parentElement: legacyHost, isConnected: true, clientHeight: 240 },
    _onWheel() {},
    _updateLabelScale() { labels++; },
    _updateBypassState() { bypass++; },
};
const node = {
    size: [400, 500], mode: 0,
    addDOMWidget(name, type, element, options) {
        assert.equal(name, 'xzg_img_loader');
        assert.equal(type, 'customwidget');
        assert.equal(element, ui.container);
        assert.equal(options.getMinHeight(), 240);
        assert.equal(options.getHeight(), '100%');
        assert.equal(options.hideOnZoom, false);
        return {};
    },
};
const widget = attach(node, ui, () => layout++);
assert.deepEqual(observed, [ui.container]);
sync();
assert.equal(labels, 1);
assert.equal(bypass, 1);
assert.equal(legacyHost.listeners.size, 1);
widget.width = 120; // A sidebar row must not change the canvas widget width.
assert.equal(widget.width, 400);
node.size[0] = 600;
assert.equal(widget.width, 600);
sync();
assert.equal(labels, 1);
assert.equal(bypass, 1);
ui.container.parentElement = vueHost; // Switching renderers reparents the element.
node.mode = 4;
sync();
assert.equal(legacyHost.listeners.size, 0);
assert.equal(vueHost.listeners.size, 1);
assert.equal(bypass, 2);
assert.equal(layout, 1);
ui.container.clientHeight = 420;
sync();
assert.equal(layout, 2);
ui.disposeDOMWidget();
assert.equal(vueHost.listeners.size, 0);
assert.equal(disconnected, true);
assert.equal(cleared, true);

// Preserve the node argument required by frontend widget callbacks.
const listStart = source.indexOf('function setNameList(');
const listEnd = source.indexOf('\nfunction getCardSize(', listStart);
const listWidget = {};
const canvas = {};
const setNames = new Function('getImageListWidget', 'app',
    source.slice(listStart, listEnd) + '\nreturn setNameList;')(() => listWidget, { canvas });
listWidget.callback = function(value, callbackCanvas, callbackNode) {
    assert.equal(this, listWidget);
    assert.equal(value, 'a.png\nb.png');
    assert.equal(callbackCanvas, canvas);
    assert.equal(callbackNode, node);
};
setNames(node, ['a.png', 'b.png']);
console.log('Image loader DOM layout, renderer remount, callbacks and cleanup passed.');
