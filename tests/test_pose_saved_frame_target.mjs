import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeSAMProjectionFrame } from '../web/pose_studio/characters.mjs';

const controls = fs.readFileSync(new URL('../web/xzg_image_pose_editor_ctrl_character_controls.js', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('../web/pose_studio/core.js', import.meta.url), 'utf8');
const resetStart = core.indexOf('    resetSceneCameraTarget(');
const resetEnd = core.indexOf('\n    _disposePassiveCharacter(', resetStart);
const Target = new Function(`return class { ${core.slice(resetStart, resetEnd)} };`)();
const hydrateStart = controls.indexOf('    hydrateCharacterSceneModels(');
const hydrateEnd = controls.indexOf('\n    setCharactersBusy(', hydrateStart);
const Scene = new Function(`return class { ${controls.slice(hydrateStart, hydrateEnd)} };`)();
class Vector3 {
    constructor(...values) { this.values = values; }
    toArray() { return [...this.values]; }
}
const viewer = new Target();
viewer.THREE = { Vector3 };
const scene = new Scene();
Object.assign(scene, {
    viewer, characters: [{ id: 'active' }], activeCharacterId: 'active',
    _poseDataRestoreToken: 1,
    setCharactersBusy() {}, renderCharactersUI() {}, updateCharacterScene() {},
    // A different body center after rebuilding must not move the saved frame.
    async loadModel() {
        viewer.meshCenter = new Vector3(0, 25, 0);
        viewer.sceneCameraTarget ||= viewer.meshCenter;
    },
    applyCameraToViewer() { throw Error('Restoring a pose must not recenter the viewport'); },
});
const savedTarget = [0, 10, 2];
await scene.hydrateCharacterSceneModels({ recenterViewport: false, cameraTarget: savedTarget });
assert.deepEqual(viewer.sceneCameraTarget.toArray(), savedTarget);
assert.notEqual(viewer.sceneCameraTarget, savedTarget);
viewer.resetSceneCameraTarget([0, NaN, 0]);
assert.equal(viewer.sceneCameraTarget, null);
viewer.resetSceneCameraTarget();
assert.equal(viewer.sceneCameraTarget, null);
console.log('Saved frame target survives model rebuilding; invalid and legacy targets fall back safely.');

// Serialize the actual scene snapshot and exercise the actual hydration callback.
// Ordinary zoom/offset values alone cannot reproduce an imported projection.
const dataStart = controls.indexOf('        const data = {', controls.indexOf('    syncToNode('));
const dataEnd = controls.indexOf('\n        };', dataStart) + '\n        };'.length;
const serialize = new Function('normalizeSAMProjectionFrame', 'serializedCharacters', 'primaryCharacter', 'exportToSave', 'captureId',
    `${controls.slice(dataStart, dataEnd)}; return JSON.parse(JSON.stringify(data));`);
const projection = { fov: 30, projection_zoom: 1.8, cameraPosition: { x: 2, y: 14, z: 27 } };
const original = {
    viewer: { sceneCameraTarget: new Vector3(0, 10, 2) },
    _samCameraModeActive: true, _samCamDisplayActive: true,
    _samCamStoredProjectionFrame: projection,
    getInitialCharacterTransform: () => null,
    exportParams: {}, poses: [{}], activeTab: 0,
};
const saved = serialize.call(original, normalizeSAMProjectionFrame, [], null, {}, 'test');
assert.deepEqual(saved.scene_projection, normalizeSAMProjectionFrame(projection));
const applyStart = controls.indexOf('    applyLibrarySAMProjection(');
const applyEnd = controls.indexOf('\n    async loadCharacterSceneLibraryAsset(', applyStart);
const Restored = new Function('normalizeSAMProjectionFrame', `return class { ${controls.slice(applyStart, applyEnd)} };`)(normalizeSAMProjectionFrame);
const restored = new Restored();
let restoredFrame;
let captureFrame;
Object.assign(restored, {
    _poseDataRestoreToken: 7, _poseDataRestorePending: true,
    currentCameraParams: () => ({ zoom: 1, offset_x: 0, offset_y: 0 }),
    viewer: { setSAMProjectionCameraFrame(frame) { restoredFrame = frame; }, setCameraParams() {} },
    _updateSAMCameraBanner() {},
    applyCameraToViewer() { captureFrame = restoredFrame; },
});
const callbackStart = controls.indexOf('                    if (this._disposed || restoreToken !== this._poseDataRestoreToken) return;', controls.indexOf('cameraTarget: data.scene_camera_target'));
const callbackEnd = controls.indexOf('\n                }).catch(', callbackStart);
new Function('data', 'restoreToken', controls.slice(callbackStart, callbackEnd)).call(restored, saved, 7);
assert.deepEqual(captureFrame, saved.scene_projection);
assert.equal(restored._poseDataRestorePending, false);
assert.equal(restored._samCameraModeActive, true);
console.log('Imported projection survives scene serialization and restoration before the editor becomes ready.');
