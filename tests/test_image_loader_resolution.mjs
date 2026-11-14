import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../web/xzg_image_loader.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('function getCroppedImageSize('), source.indexOf('// 原始分辨率缓存'));
const label = source.slice(source.indexOf('    function _updateSingleResLabel()'), source.indexOf('    singleImgEl.onerror'));

test('fullscreen crop dimensions stay linked without accumulating rounding drift', () => {
    const start = source.indexOf('    function createCropFromSize(');
    const end = source.indexOf('    cropMultipleSelect.addEventListener', start);
    const context = vm.createContext({
        cropEnabled: true, _cropAspect: null, _cropPending: null, cropRect: null,
        _singleOrigW: 1600, _singleOrigH: 900, _maskImgNaturalW: 1600, _maskImgNaturalH: 900,
        cropSizeAxis: 'width', lastSizedCrop: null, lastSizeRatio: null,
        cropSizeInputs: { width: { value: '6' }, height: { value: '900' } },
        cropMultipleSelect: { value: '1' },
        cropOriginalScale: () => 1,
        _clearCropBox() {}, _refreshCropPreview() {}, _renderTransformPreview() {},
        _renderMaskOverlay() {}, _updateSingleResLabel() {},
    });
    vm.runInContext(source.slice(start, end) + 'createCropFromSize({ normalize: false });', context);
    assert.equal(context.cropSizeInputs.height.value, 3);
    context.cropSizeInputs.width.value = '640';
    vm.runInContext('createCropFromSize();', context);
    assert.equal(context.cropSizeInputs.height.value, 360);

    context._cropAspect = 3 / 4;
    context.cropSizeAxis = 'height';
    context.cropSizeInputs.height.value = '399';
    context.cropMultipleSelect.value = '16';
    vm.runInContext('createCropFromSize();', context);
    assert.equal(context.cropSizeInputs.width.value, 304);
    assert.equal(context.cropSizeInputs.height.value, 400);
    assert.equal(context._cropAspect, 3 / 4);
});

test('applied crop immediately updates the single image resolution label', () => {
    const context = vm.createContext({
        syncCropSizeInputs() {}, _updateSingleCropBadge() {},
        cropRect: { x: 10, y: 20, w: 640, h: 360 },
        _singleOrigW: 7680, _singleOrigH: 4320,
        singleResLabel: { style: {} },
        singleImgEl: { naturalWidth: 99, naturalHeight: 99 },
        _maskImgNaturalW: 99, _maskImgNaturalH: 99,
    });
    vm.runInContext(helper + label + '_updateSingleResLabel();', context);
    assert.equal(context.singleResLabel.textContent, '1280 × 720');
    context.cropRect = null;
    vm.runInContext('_updateSingleResLabel();', context);
    assert.equal(context.singleResLabel.textContent, '7680 × 4320');
});

test('thumbnail and resize dialog use the same cropped output dimensions', () => {
    const context = vm.createContext({});
    vm.runInContext(helper, context);
    for (const [width, height, crop, expected] of [
        [100, 80, [50, 0, 50, 20], [50, 20]],
        [7680, 4320, [-10, 0, 640, 360], [1280, 720]],
        [100, 80, null, [100, 80]],
    ]) {
        const size = context.getCroppedImageSize(width, height, crop);
        assert.deepEqual([size.width, size.height], expected);
    }
    assert.match(source, /getCroppedImageSize\(info.width, info.height, _cropByImage\[name\]\)/);
    assert.match(source, /getCroppedImageSize\(image.naturalWidth, image.naturalHeight, crop\)/);
});
