import assert from 'node:assert/strict';
import fs from 'node:fs';

const controls = fs.readFileSync(new URL('../web/xzg_image_pose_editor_ctrl_character_controls.js', import.meta.url), 'utf8');
const selectionStart = controls.indexOf('    restoreImportedCharacterSelection() {');
const selectionEnd = controls.indexOf('\n    async loadFromLibrary(', selectionStart);
const Selection = new Function(`return class { ${controls.slice(selectionStart, selectionEnd)} };`)();
for (const initialSelection of [[], ['old'], ['old', 'other']]) {
    const editor = new Selection();
    let locked = true;
    let flags;
    Object.assign(editor, {
        _selectedCharacterIds: new Set(initialSelection),
        _temporarilyHiddenCharacters: new Set(['imported', 'other']),
        getActiveCharacter: () => ({ id: 'imported' }),
        viewer: { resetJointSelectionLock() { locked = false; }, requestRender() {} },
        updateCharacterScene() {},
        renderCharactersUI() { flags = [...this._selectedCharacterIds]; },
    });
    editor.restoreImportedCharacterSelection();
    assert.deepEqual(flags, ['imported']);
    assert.equal(locked, false);
    assert.equal(editor._temporarilyHiddenCharacters.has('imported'), false);
    assert.equal(editor._temporarilyHiddenCharacters.has('other'), true);
}

const core = fs.readFileSync(new URL('../web/pose_studio/core.js', import.meta.url), 'utf8');
const wheelStart = core.indexOf('        this._handleViewportWheel = e => {');
const wheelEnd = core.indexOf("        this.canvas.addEventListener('wheel'", wheelStart);
const viewer = {
    skinnedMesh: {}, activeCharacterAppearance: { transform: { zoom: 1 } },
    recordState() {}, _normalizedCharacterTransform: value => value,
    setActiveCharacterAppearance({ transform }) { this.result = transform.zoom; },
    options: {}, zoomViewAtPointer() { this.viewportZoomed = true; }, requestRender() {},
};
new Function(core.slice(wheelStart, wheelEnd)).call(viewer);
function wheel(overrides) {
    viewer.result = null;
    viewer._handleViewportWheel({ deltaY: -100, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...overrides });
    return viewer.result;
}
assert.equal(wheel({ ctrlKey: true }), 1.06);
assert.equal(wheel({ altKey: true }), 1.005);
assert.equal(wheel({ ctrlKey: true, altKey: true }), 1.005);
assert.equal(wheel({ ctrlKey: true, deltaY: 100 }), 0.94);
assert.equal(wheel({ altKey: true, deltaY: 100 }), 0.995);
viewer._noCharacterSelection = true;
assert.equal(wheel({ altKey: true }), null);
console.log('Imported selection resets stale selection/locks; Ctrl and Alt apply quick and fine character scaling.');
