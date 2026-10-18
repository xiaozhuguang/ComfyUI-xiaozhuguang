import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../web/vnccs_pose_vendor/three/three.module.js';

const source = fs.readFileSync(new URL('../web/pose_studio/core.js', import.meta.url), 'utf8');
const start = source.indexOf('    _getCaptureRenderCamera() {');
const end = source.indexOf('    capture(width, height,', start);
const Viewer = new Function(`return class { ${source.slice(start, end)} }`)();
const viewer = new Viewer();
viewer.THREE = THREE;
viewer.camera = new THREE.OrthographicCamera(-12, 12, 9, -9, 0.1, 500);
viewer.captureCamera = new THREE.PerspectiveCamera(30, 1.5, 0.1, 500);
viewer.captureCamera.position.set(2, 10, 45);
viewer.captureCamera.lookAt(2, 10, 0);
viewer.captureFrame = new THREE.Object3D();
viewer.captureFrame.position.set(2, 10, 0);
viewer.captureFrame.scale.set(6, 4, 1);
viewer.camera.position.copy(viewer.captureCamera.position).add(new THREE.Vector3(1, 2, 0));
viewer.camera.quaternion.copy(viewer.captureCamera.quaternion);
viewer.camera.zoom = 1.7;
viewer.camera.updateProjectionMatrix();
viewer.camera.updateMatrixWorld(true);
const outputCamera = viewer._getCaptureRenderCamera();
assert.ok(outputCamera.isOrthographicCamera);

// Compare image coordinates against the editor frame after viewport pan/zoom.
const min = new THREE.Vector3(-4, 6, 0).project(viewer.camera);
const max = new THREE.Vector3(8, 14, 0).project(viewer.camera);
for (const z of [-10, 0, 10]) {
    const point = new THREE.Vector3(4, 11, z);
    const preview = point.clone().project(viewer.camera);
    const output = point.clone().project(outputCamera);
    assert.ok(Math.abs((preview.x - min.x) / (max.x - min.x) - (output.x + 1) / 2) < 1e-10);
    assert.ok(Math.abs((preview.y - min.y) / (max.y - min.y) - (output.y + 1) / 2) < 1e-10);
}
viewer._samProjectionCameraFrame = {};
assert.ok(viewer._getCaptureRenderCamera().isOrthographicCamera);
viewer._samProjectionCameraFrame = null;
viewer.camera = new THREE.PerspectiveCamera();
assert.equal(viewer._getCaptureRenderCamera(), viewer.captureCamera);
console.log('Capture projection: parallel frame coordinates match at multiple depths, including with legacy SAM metadata.');
