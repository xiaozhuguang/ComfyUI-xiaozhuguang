import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/xzg_points_editor.js', import.meta.url), 'utf8');
const start = source.indexOf('        let loadedPreview = "";');
const end = source.indexOf('        // ---- 尺寸管理', start);
assert.ok(start >= 0 && end > start);

function setup() {
    const node = {};
    const images = [];
    const state = {
        frames: [], frameIdx: 0, image: null, srcKey: '', sampleIdx: [],
        manualKeyframes: { 1: { 212: [{ x1: 0.2, y1: 0.3, x2: 0.4, y2: 0.5 }] } },
    };
    const slider = { style: {}, offsetHeight: 10 };
    const frameInfo = { style: {} };
    const counts = { stop: 0, hide: 0, redraw: 0, clear: 0 };
    const Image = class { constructor() { images.push(this); } };
    new Function('node', 'state', 'slider', 'frameInfo', 'Image', 'chainCallback',
        'hideProgress', 'stopPlay', 'clearRegions', 'getRealURL', 'readData', 'syncSize',
        'redraw', 'drawKfBar', 'requestAnimationFrame', 'setTimeout', source.slice(start, end))(
        node, state, slider, frameInfo, Image,
        (target, name, callback) => { target[name] = callback; },
        () => counts.hide++, () => counts.stop++, () => counts.clear++,
        file => file.filename, () => {}, () => {}, () => counts.redraw++,
        () => {}, () => {}, () => {},
    );
    return { node, state, slider, frameInfo, images, counts };
}

function message(count, id = 'whole-video') {
    return { preview: [{ preview_str: JSON.stringify({
        frames: Array.from({ length: count }, (_, index) => ({ filename: `${id}-${index}.jpg` })),
        sample_idx: Array.from({ length: count }, (_, index) => index),
        video_id: id,
    }) }] };
}

// Loading images out of order cannot change the timeline length or keyframe positions.
{
    const { node, state, slider, images } = setup();
    const keyframes = structuredClone(state.manualKeyframes);
    node.onExecuted(message(1091));
    assert.equal(state.frames.length, 1091);
    assert.equal(slider.max, 1090);
    for (const index of [0, 12, 400, 1090, 212]) {
        images[index].onload();
        assert.equal(state.frames.length, 1091);
        assert.equal(212 / (state.frames.length - 1), 212 / 1090);
        assert.deepEqual(state.manualKeyframes, keyframes);
    }
}

// The ten scene runs replay one cached preview, without reloading it or resetting the user view.
{
    const { node, state, slider, images, counts } = setup();
    const cached = message(1091);
    node.onExecuted(cached);
    images[0].onload();
    state.frameIdx = 579;
    slider.value = 579;
    const frames = state.frames;
    const image = state.image;
    for (let scene = 1; scene < 10; scene++) node.onExecuted(cached);
    assert.equal(images.length, 1091);
    assert.equal(state.frames, frames);
    assert.equal(state.image, image);
    assert.equal(state.frameIdx, 579);
    assert.equal(slider.value, 579);
    assert.equal(counts.stop, 1);
    assert.equal(counts.hide, 10);
    assert.equal(counts.clear, 0);
}

// Images from the previous video may finish late but cannot overwrite the new timeline.
{
    const { node, state, slider, images } = setup();
    node.onExecuted(message(1091));
    const oldFirst = images[0];
    const oldLast = images[1090];
    node.onExecuted(message(30, 'replacement'));
    const newFirst = images[1091];
    oldFirst.onload();
    oldLast.onload();
    assert.equal(state.frames.length, 30);
    assert.equal(state.image, null);
    assert.equal(slider.max, 29);
    newFirst.onload();
    assert.equal(state.image, newFirst);
    assert.equal(state.frames[0], newFirst);
}

// Jumping while images are still loading must show the selected frame once it arrives.
{
    const { node, state, images } = setup();
    node.onExecuted(message(1091));
    state.frameIdx = 742;
    images[0].onload();
    assert.equal(state.image, null);
    images[742].onload();
    assert.equal(state.image, images[742]);
    assert.equal(state.frameIdx, 742);
}

console.log('Cached tracker previews, stable timelines and stale image callback checks passed.');
