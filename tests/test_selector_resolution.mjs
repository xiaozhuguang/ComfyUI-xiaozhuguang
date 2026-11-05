import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

for (const filename of ['xzg_selector.js', 'xzg_boolean_selector.js']) {
const source = fs.readFileSync(new URL(`../web/${filename}`, import.meta.url), 'utf8');
const resizeSource = source.slice(source.indexOf('    const resize = () => {'), source.indexOf('    const observer = new ResizeObserver(resize);'));

test(`${filename}: increases bitmap density on zoom without changing layout dimensions`, () => {
    let zoom = 1;
    const root = { clientWidth: 300, clientHeight: 100,
        getBoundingClientRect: () => ({ width: 300 * zoom, height: 100 * zoom }) };
    const canvas = { style: {} };
    const context = vm.createContext({ root, canvas, window: { devicePixelRatio: 1 }, paint() {} });
    vm.runInContext('let width = 0, height = 0, dpr = 1; const RASTER_SUPERSAMPLE = 2;' + resizeSource, context);
    vm.runInContext('resize()', context);
    assert.equal(canvas.width, 600);
    zoom = 4;
    vm.runInContext('resize()', context);
    assert.equal(canvas.width, 1200);
    assert.equal(canvas.height, 400);
    assert.equal(canvas.style.width, '300px');
    assert.equal(canvas.style.height, '100px');
    context.window.devicePixelRatio = 2;
    vm.runInContext('resize()', context);
    assert.equal(canvas.width, 2400);
});
}
