import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../web/xzg_video_sync_preview.js', import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\r?\n/gm, '');
const draws = [];
const context = { fillRect(...args) { draws.push(['fill', this.fillStyle, ...args]); },
    drawImage(image, ...args) { draws.push(['image', ...args]); } };
const canvas = { getContext: () => context, toDataURL: () => 'data:image/png;cropped' };
const ctx = vm.createContext({ app: { registerExtension() {} }, window: {},
    document: { createElement: () => canvas }, URLSearchParams, URL,
    location: { origin: 'http://localhost' } });
vm.runInContext(source, ctx);
function crop(rect) {
    draws.length = 0;
    ctx.rect = rect;
    return vm.runInContext('cropCompareImage({ naturalWidth: 100, naturalHeight: 80 }, rect, "#123456")', ctx);
}

test('comparison crops at original resolution and preserves padding placement', () => {
    assert.equal(crop([10, 20, 40, 30]), 'data:image/png;cropped');
    assert.equal(canvas.width, 40);
    assert.equal(canvas.height, 30);
    assert.deepEqual(draws[1], ['image', 10, 20, 40, 30, 0, 0, 40, 30]);
    crop([-10, -20, 130, 120]);
    assert.deepEqual(draws[0], ['fill', '#123456', 0, 0, 130, 120]);
    assert.deepEqual(draws[1], ['image', 0, 0, 100, 80, 10, 20, 100, 80]);
    crop([200, 200, 10, 10]);
    assert.equal(draws.length, 1);
});

test('missing or invalid crop leaves the original image intact', () => {
    for (const rect of [null, [], [0, 0, 0, 20], [0, 0, NaN, 20]]) {
        assert.equal(crop(rect), null);
        assert.equal(draws.length, 0);
    }
});

test('selected loader images keep their individual crop metadata', async () => {
    ctx.node = { widgets: [{ name: 'image_list', value: 'a.png\nb.png' }],
        _xzgImgLoaderUI: { getSelectedCompareItems: () => [
            { url: '/a.png', crop: [1, 2, 3, 4], paddingColor: '#123456' },
            { url: '/b.png', crop: null },
        ] } };
    const items = await vm.runInContext('getImagesFromNode(node)', ctx);
    assert.deepEqual(items[0].crop, [1, 2, 3, 4]);
    assert.equal(items[0].paddingColor, '#123456');
    assert.equal(items[1].crop, null);
});
