import assert from "node:assert/strict";
import fs from "node:fs";
const source = fs.readFileSync(new URL("../web/xzg_image_loader.js", import.meta.url), "utf8");
const start = source.indexOf("    function createCropFromSize(");
const end = source.indexOf('    cropMultipleSelect.addEventListener', start);
assert.ok(start >= 0 && end > start);
const run = new Function("width", "height", "multiple", "scale", "box", `
    let cropEnabled = true, _cropPending = box, cropRect = null, _cropAspect = 1, _lastCropPreviewKey = null;
    const cropSizeInputs = { width: {value: width}, height: {value: height} };
    const cropMultipleSelect = {value: multiple};
    const _maskImgNaturalW = 2160, _maskImgNaturalH = 3840, singleImgEl = {};
    const cropOriginalScale = () => scale;
    const xzgT = a => a;
    const xzgAlert = message => { throw new Error(message); };
    const _clearCropBox = () => { _cropPending = null; cropRect = null; };
    const refreshCropRatioUI = () => {};
    const _refreshCropPreview = () => {};
    const _renderTransformPreview = () => {};
    const _renderMaskOverlay = () => {};
    const _updateSingleResLabel = () => {};
    ${source.slice(start, end)}
    createCropFromSize();
    return { box: _cropPending, aspect: _cropAspect };
`);
for (const multiple of [1, 8, 16, 32]) {
    for (const scale of [1, 2.5, 6000 / 3840]) {
        const result = run(1001, 713, multiple, scale, null);
        const width = Math.round(result.box.w * scale), height = Math.round(result.box.h * scale);
        assert.equal(width % multiple, 0);
        assert.equal(height % multiple, 0);
        assert.equal(width, Math.max(multiple, Math.floor(1001 / multiple + .5) * multiple));
        assert.equal(height, Math.max(multiple, Math.floor(713 / multiple + .5) * multiple));
        assert.equal(result.aspect, null);
    }
}
const centered = run(800, 600, 8, 1, {x: 10, y: 20, w: 100, h: 100}).box;
assert.equal(centered.x + centered.w / 2, 60);
assert.equal(centered.y + centered.h / 2, 70);
assert.throws(() => run(0, 600, 8, 1, null));
console.log("Crop size generation: passed");
