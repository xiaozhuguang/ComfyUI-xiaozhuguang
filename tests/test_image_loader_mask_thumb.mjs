import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../web/xzg_image_loader.js', import.meta.url), 'utf8');
const start = source.indexOf('    function _applyMaskThumb(');
const end = source.indexOf('    function _applyCropThumb(', start);
assert.ok(start >= 0 && end > start);

function setup() {
    const images = [];
    let current = true;
    let draws = 0;
    const context = {
        drawImage() { draws++; },
        getImageData() { return { data: new Uint8ClampedArray([255, 255, 255, 255]) }; },
        putImageData() {}, clearRect() {},
    };
    const document = { createElement: () => ({
        style: {}, isConnected: false, getContext: () => context, remove() {},
    }) };
    const grid = { contains: () => current };
    const Image = class {
        constructor() { images.push(this); this.naturalWidth = this.naturalHeight = 100; }
    };
    const apply = new Function('document', 'Image', 'grid', '_getMaskForImage', '_maskPreviewRgb', '_cropByImage', 'getPreviewUrl',
        source.slice(start, end) + '\nreturn _applyMaskThumb;')(
        document, Image, grid, () => 'data:mask', () => [255, 0, 0], {}, () => '/preview');
    apply({ appendChild() {} }, 'image.png', 100);
    return { images, remove: () => { current = false; }, draws: () => draws };
}

// Saved masks must render even before the restored node is attached to the page.
const restored = setup();
restored.images[0].onload();
assert.equal(restored.images.length, 2);
restored.images[1].onload();
assert.equal(restored.draws(), 2);

const obsolete = setup();
obsolete.remove();
obsolete.images[0].onload();
assert.equal(obsolete.images.length, 1);
assert.equal(obsolete.draws(), 0);

for (const event of ['onload', 'onerror']) {
    const replaced = setup();
    replaced.images[0].onload();
    replaced.remove();
    replaced.images[1][event]();
    assert.equal(replaced.draws(), 0);
}

const fallback = setup();
fallback.images[0].onload();
fallback.images[1].onerror();
assert.equal(fallback.draws(), 1);
console.log('Mask thumbnail restoration regression checks passed.');
