const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../web/xzg_video_loader.js'), 'utf8');
const start = source.indexOf('function _xzgKeepConvertedWidgetVisible(');
const end = source.indexOf('// 统一应用所有 widget', start);
const context = {
    _xzgVideoRowSize: width => [width, 20],
    _xzgDrawWidget() {},
    _xzgDrawComboWidget() {},
};
vm.runInNewContext(source.slice(start, end), context);

test('connected parameters retain their row and drawing while blocking local edits', () => {
    let draws = 0;
    let edits = 0;
    let suppressed = true;
    const widget = {
        name: '自定义宽度', type: 'xzg_number', value: 640,
        draw(ctx) { draws++; assert.equal(ctx.globalAlpha, 0.65); },
        mouse() { edits++; },
        computeSize: width => [width, 20],
        get connectionSuppressed() { return suppressed; },
        set connectionSuppressed(value) { suppressed = value; },
    };
    const node = { inputs: [{ name: widget.name, link: 0 }] };
    context._xzgKeepConvertedWidgetVisible(widget, node);
    widget.connectionSuppressed = true;
    assert.equal(suppressed, false, 'clear existing frontend visibility state');
    assert.equal(widget.connectionSuppressed, false);
    const ctx = { globalAlpha: 1, save() {}, restore() { this.globalAlpha = 1; } };
    if (!widget.connectionSuppressed) widget.draw(ctx);
    assert.equal(draws, 1);
    widget.mouse();
    assert.equal(edits, 0);
    assert.equal(widget.value, 640);

    node.inputs[0].link = null;
    widget.mouse();
    assert.equal(edits, 1, 'disconnect restores local editing');

    widget.type = 'converted-widget';
    widget.draw = () => { throw new Error('hidden draw must be ignored'); };
    widget.computeSize = () => [0, -4];
    widget.draw(ctx);
    assert.equal(draws, 2);
    assert.deepEqual([...widget.computeSize(300)], [300, 20]);
    assert.equal(widget.type, 'converted-widget');
});
