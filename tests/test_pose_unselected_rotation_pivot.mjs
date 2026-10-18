import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../web/vnccs_pose_vendor/three/three.module.js';

const source = fs.readFileSync(new URL('../web/pose_studio/core.js', import.meta.url), 'utf8');
const first = source.indexOf('    _getViewRotationPivot() {');
const last = source.indexOf('    _getFrameGroundOrigin()', first);
assert.ok(first >= 0 && last > first, 'view pivot method exists');
const Methods = new Function('return class {' + source.slice(first, last) + '}')();

const active = new THREE.Object3D();
active.position.set(2, 4, 6);
const firstPassive = new THREE.Object3D();
firstPassive.position.set(8, 1, -3);
const secondPassive = new THREE.Object3D();
secondPassive.position.set(-1, 7, 3);
const hidden = new THREE.Object3D();
hidden.visible = false;
hidden.position.set(100, 100, 100);
const viewer = Object.assign(new Methods(), {
    THREE,
    skinnedMesh: active,
    _noCharacterSelection: true,
    _multiCharacterSelection: false,
    passiveCharacters: new Map([
        ['first', { mesh: firstPassive }],
        ['second', { mesh: secondPassive }],
        ['hidden', { mesh: hidden }],
    ]),
    _getFrameGroundOrigin: () => new THREE.Vector3(-10, 0, 0),
});

const average = viewer._getViewRotationPivot();
assert.ok(average.distanceTo(new THREE.Vector3(3, 4, 2)) < 1e-9, 'unselected pivot averages visible character origins');

viewer._noCharacterSelection = false;
assert.ok(viewer._getViewRotationPivot().distanceTo(new THREE.Vector3(2, 4, 6)) < 1e-9, 'single selection keeps its own origin as pivot');

active.visible = false;
viewer._noCharacterSelection = true;
firstPassive.visible = false;
secondPassive.visible = false;
assert.ok(viewer._getViewRotationPivot().distanceTo(new THREE.Vector3(-10, 0, 0)) < 1e-9, 'empty scene falls back to the frame origin');

console.log('View pivot: selected character, unselected cast average, and empty-scene fallback passed.');
