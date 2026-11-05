import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../web/xzg_image_compare.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');

for (const type of ['XiaozhuguangImageCompare', 'XiaozhuguangImageCompareCustom']) {
    test(`${type}: workflow round trip reloads preview images without serializing DOM images`, async () => {
        let extension;
        const context = vm.createContext({
            app: { registerExtension(value) { extension = value; }, getPreviewFormatParam: () => '', getRandParam: () => '' },
            api: { apiURL: value => value }, Image: class {},
        });
        vm.runInContext(source, context);
        class Node {
            constructor() {
                this.type = type;
                this.widgets = [{ name: 'show_line', value: true }];
                this.size = [300, 350];
                this.properties = {};
            }
            addCustomWidget(widget) { this.widgets.push(widget); return widget; }
            getWidgetOnPos() {}
            setSize(size) { this.size = size; }
            setDirtyCanvas() {}
        }
        await extension.beforeRegisterNodeDef(Node, { name: type });
        const original = new Node();
        original.onNodeCreated();
        original.onExecuted({ a_images: [{ filename: 'a.jpg', type: 'temp', subfolder: '' }],
            b_images: [{ filename: 'b.jpg', type: 'temp', subfolder: '', has_alpha: true, transparent_filename: 'b.png' }] });
        const data = { widgets_values: original.widgets.map(w => w.serializeValue?.() ?? w.value) };
        original.onSerialize(data);
        const saved = JSON.parse(JSON.stringify(data));
        assert.equal(saved.widgets_values[1].images.length, 2);
        assert.ok(saved.widgets_values[1].images.every(image => !('img' in image)));
        const restored = new Node();
        restored.onNodeCreated();
        restored.onConfigure(saved);
        assert.equal(restored.canvasWidget.selected.length, 2);
        assert.match(restored.canvasWidget.selected[0].img.src, /a\.jpg/);
        assert.match(restored.canvasWidget.selected[1].img.src, /b\.png/);
        assert.equal(restored.canvasWidget.selected[1].has_alpha, true);
        restored.onConfigure({ widgets_values: [true, []] });
        assert.equal(restored.canvasWidget.selected.length, 0);
    });
}
