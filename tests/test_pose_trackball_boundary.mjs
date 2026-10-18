import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../web/vnccs_pose_vendor/three/three.module.js';
import { computeTrackballRotation } from '../web/vnccs_pose_vendor/three/trackball_rotation.mjs';

const outsideCircle = computeTrackballRotation(150, 0, 150, 1, 100);
assert.ok(Math.abs(outsideCircle.z) > 0.001, 'a point inside a wide rectangle but outside its incircle must decay');
const atEdge = computeTrackballRotation(100, -.5, 100, .5, 100);
const justOutside = computeTrackballRotation(100.001, -.5, 100.001, .5, 100);
assert.ok(atEdge.angleTo(justOutside) < 1e-7, 'transition at the incircle must be smooth');
const source = fs.readFileSync(new URL('../web/pose_studio/core.js', import.meta.url), 'utf8');
const start = source.indexOf('    _viewTrackballPixelRadius(pivot)');
const end = source.indexOf('    moveCharacterControlDrag(event)', start);
const Methods = new Function(`return class {${source.slice(start, end)}}`)();
for (const camera of [new THREE.PerspectiveCamera(45, 4/3, .1, 1000), new THREE.OrthographicCamera(-8, 8, 6, -6, .1, 1000)]) {
    camera.position.z = 20;
    camera.updateMatrixWorld();
    const frame = new THREE.Object3D();
    frame.scale.set(3, 4, 1);
    const viewer = Object.assign(new Methods(), { THREE, camera, captureFrame: frame, canvas: { getBoundingClientRect: () => ({width: 800, height: 600}) } });
    const initial = viewer._viewTrackballPixelRadius(frame.position);
    frame.rotation.set(.3, .4, .2);
    assert.ok(Math.abs(viewer._viewTrackballPixelRadius(frame.position) - initial) < 1e-8,
        'the screen-centered circle must not shrink when the frame turns edge-on');
    camera.zoom = 2;
    camera.updateProjectionMatrix();
    assert.ok(Math.abs(viewer._viewTrackballPixelRadius(frame.position) - initial) < 1e-8,
        'the fixed screen-space circle must remain unchanged by viewport zoom');
    frame.scale.multiplyScalar(1.5);
    assert.ok(Math.abs(viewer._viewTrackballPixelRadius(frame.position) - initial) < 1e-8,
        'the fixed screen-space circle must remain unchanged by frame size');
}
console.log('Trackball boundaries passed: screen-centered fixed circle, character circle, smooth transition, perspective and parallel zoom, frame scaling and rotation.');
