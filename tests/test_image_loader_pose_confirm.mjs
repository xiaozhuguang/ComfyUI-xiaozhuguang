import assert from 'node:assert/strict';
import fs from 'node:fs';

// Exercise the actual fullscreen confirm handler without WebGL or ComfyUI.
const source = fs.readFileSync(new URL('../web/xzg_image_pose_editor_ctrl_character_controls.js', import.meta.url), 'utf8');
const start = source.indexOf('confirmButton.addEventListener("click", async () => {');
const end = source.indexOf('\n        actions.appendChild(confirmButton);', start);
assert.ok(start >= 0 && end > start);
const register = new Function('confirmButton', 'closeButton', 'waitForPoseStudioSyncIdle', source.slice(start, end));
function setup({ ready = true, restoreError = null, save = async () => {} } = {}) {
    let click;
    const confirm = { disabled: false, isConnected: true, addEventListener: (_, fn) => { click = fn; } };
    const cancel = { disabled: false };
    const calls = [];
    const studio = {
        viewer: { isInitialized: () => ready },
        characters: [{}],
        getActiveCharacter() { return this.characters[0]; },
        _poseDataRestoreError: restoreError,
        poseCaptures: [], activeTab: 0,
        syncToNode() { calls.push('capture'); this.poseCaptures[0] = 'new-image'; },
        host: { async onConfirm(image) { calls.push(image); await save(); } },
        closeFullscreen() { calls.push('close'); },
        showMessage(message) { calls.push(message); },
    };
    register.call(studio, confirm, cancel, async () => {});
    return { studio, confirm, cancel, calls, click: () => click() };
}

let release;
const pending = new Promise(resolve => { release = resolve; });
const saving = setup({ save: () => pending });
const task = saving.click();
await new Promise(resolve => setImmediate(resolve));
assert.equal(saving.cancel.disabled, true);
assert.equal(saving.studio._confirmingFullscreen, true);
assert.deepEqual(saving.calls, ['capture', 'new-image']);
await saving.click(); // double click must not upload again
release();
await task;
assert.deepEqual(saving.calls, ['capture', 'new-image', 'close']);
assert.equal(saving.cancel.disabled, false);
assert.equal(saving.confirm.disabled, false);

for (const options of [{ ready: false }, { restoreError: 'bad saved scene' }, { save: async () => { throw Error('upload failed'); } }]) {
    const failed = setup(options);
    await failed.click();
    assert.ok(!failed.calls.includes('close'));
    assert.equal(failed.confirm.disabled, false);
    assert.equal(failed.cancel.disabled, false);
    assert.equal(failed.studio._confirmingFullscreen, false);
    if (options.ready === false || options.restoreError) assert.ok(!failed.calls.includes('capture'));
}
const empty = setup({ ready: false });
empty.studio.characters = [];
empty.studio.exportParams = { view_width: 1088, view_height: 1920, background_url: 'background.png' };
empty.studio.applyCameraToViewer = () => {};
Object.assign(empty.studio.viewer, {
    initialized: true,
    clearPassiveCharacters() { empty.calls.push('clear-passive'); },
    setMannequinVisible(visible) { assert.equal(visible, false); empty.calls.push('hide-model'); },
    capture(width, height) {
        assert.equal(width, 1088);
        assert.equal(height, 1920);
        empty.calls.push('empty-scene-capture');
        return 'background-only-image';
    },
});
await empty.click();
assert.deepEqual(empty.calls, ['capture', 'clear-passive', 'hide-model', 'empty-scene-capture', 'background-only-image', 'close']);
const blank = setup({ ready: false });
blank.studio.characters = [];
blank.studio.exportParams = {};
blank.studio.poseCaptures = ['stale-character-image'];
blank.studio.viewer.capture = () => { throw Error('Empty scenes must never render an image'); };
await blank.click();
assert.deepEqual(blank.calls, ['capture', null, 'close']);
console.log('Pose confirm regression checks passed, including replacing the image after deleting every character.');
