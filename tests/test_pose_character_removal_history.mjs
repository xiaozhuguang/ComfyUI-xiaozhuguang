import assert from 'node:assert/strict';
import fs from 'node:fs';
const widgetSource = fs.readFileSync(new URL('../web/xzg_image_pose_editor_ctrl_character_controls.js', import.meta.url), 'utf8');
const coreSource = fs.readFileSync(new URL('../web/pose_studio/core.js', import.meta.url), 'utf8');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const Widget = new Function('normalizeCharacterTransform', `return class {${extract(widgetSource, '    captureCharacterHistory()', '    async waitForMorphIdle')}${extract(widgetSource, '    async restoreImageHistory(', '    clearPoseHistory()')}}`)(value => value);
const Viewer = new Function(`return class {${extract(coreSource, '    getHistoryPose()', '    setPose(pose,')}}`)();
const original = [1, 2].map(id => ({ id, name: `Person ${id}`, mesh: { age: id * 20 }, transform: { x: id }, poses: [{ bones: { hips: [id, 0, 0] } }] }));
const w = Object.assign(new Widget(), {
 characters: structuredClone(original), activeCharacterId: 1, activeTab: 0, meshParams: original[0].mesh,
 _temporarilyHiddenCharacters: new Set(), _selectedCharacterIds: new Set([1]), exportParams: {},
 getActiveCharacter() { return this.characters.find(c => c.id === this.activeCharacterId); },
 captureActiveCharacterRuntime() {}, renderCharactersUI() {}, updateCharacterScene() {}, syncToNode() {}, hideHandControlPopover() {},
 async selectCharacter(id) { this.activeCharacterId = id; this.viewer.history = []; this.viewer.future = []; return true; },
 async loadModel() {}, async hydrateCharacterSceneModels() { this.viewer.history = []; this.viewer.future = []; },
 characterPoseForScene(c) { return c.poses[0]; }, restoreMeshHistory() {}, persistActivePoseCameraParams() {}, applyCameraToViewer() {},
 syncCharacterEditorControls() {}, currentCameraParams() { return {}; },
});
const v = w.viewer = Object.assign(new Viewer(), {
 history: [], future: [], maxHistory: 50, getPose() { return { bones: {} }; }, setPose() {}, removePassiveCharacter() {}, dispatchPoseChange() {},
 options: { captureHistoryContext: () => ({ characters: w.captureCharacterHistory(), activeCharacterId: w.activeCharacterId }), onHistoryRestore: pose => w.restoreImageHistory(pose) },
});
// Active removal switches rigs and clears history internally; deletion must retain its snapshot.
await w.deleteCharacter(1);
assert.deepEqual(w.characters.map(c => c.id), [2]);
await v.undo();
assert.deepEqual(w.characters, original);
assert.equal(w.activeCharacterId, 1);
await v.redo();
assert.deepEqual(w.characters.map(c => c.id), [2]);
// Last-character removal must also remain undoable, including repeated undo/redo.
w.poses = [{}];
await w.deleteCharacter(2);
assert.equal(w.characters.length, 0);
await v.undo();
assert.equal(w.characters[0].id, 2);
await v.redo();
assert.equal(w.characters.length, 0);
await v.undo();
await v.undo();
assert.deepEqual(w.characters, original);
console.log('Character removal history: active, last character, full data restoration, repeated undo/redo passed.');
