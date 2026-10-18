import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../web/vnccs_pose_vendor/three/three.module.js';

const source = fs.readFileSync(new URL('../web/pose_studio/core.js', import.meta.url), 'utf8');
const start = source.indexOf('    createCharacterControlGroup() {');
const end = source.indexOf('    beginCharacterControlDrag(event)', start);
const Methods = new Function(`return class {${source.slice(start, end)}}`)();
const meshes = [-4, 4, 12].map(x => {
    const mesh = new THREE.Object3D();
    mesh.position.set(x, 1, 0);
    const hip = new THREE.Object3D();
    hip.name = 'hips'; hip.position.y = 2; mesh.add(hip);
    mesh.updateMatrixWorld(true);
    return mesh;
});
let saved;
const viewer = Object.assign(new Methods(), {
    THREE, skinnedMesh: meshes[0], boneList: meshes[0].children,
    _centerHipBoneName: 'hips', activeCharacterAppearance: {},
    passiveCharacters: new Map([['b', { mesh: meshes[1], boneList: meshes[1].children }]]),
    options: {
        getCharacterSelection: () => [
            { id: 'a', active: true, transform: { x: -4, y: 1, z: 0, zoom: 1 } },
            { id: 'b', active: false, transform: { x: 4, y: 1, z: 0, zoom: 1 } },
        ],
        onCharacterGroupChange: states => { saved = states; },
    },
    requestRender() {},
});
const group = viewer.createCharacterControlGroup();
assert.ok(group.pivot.distanceTo(new THREE.Vector3(0, 3, 0)) < 1e-9);
const translation = new THREE.Vector3(3, 5, 7);
viewer.applyCharacterControlGroup(group, { translation });
assert.ok(meshes[1].position.clone().sub(meshes[0].position).distanceTo(new THREE.Vector3(8, 0, 0)) < 1e-9);
const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
viewer.applyCharacterControlGroup(group, { rotation });
assert.ok(meshes[1].position.clone().sub(meshes[0].position).distanceTo(new THREE.Vector3(0, 8, 0)) < 1e-9);
assert.ok(meshes[0].quaternion.angleTo(rotation) < 1e-9);
viewer.applyCharacterControlGroup(group, { scale: 2 });
assert.equal(meshes[0].position.distanceTo(meshes[1].position), 16);
assert.equal(meshes[1].scale.x, 2);
assert.equal(saved[1].transform.zoom, 2);
assert.deepEqual(meshes[2].position.toArray(), [12, 1, 0]);
assert.ok(group.pivot.distanceTo(meshes[0].children[0].getWorldPosition(new THREE.Vector3()).add(meshes[1].children[0].getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5)) < 1e-9);
console.log('Character group: shared pivot, translation, rotation, uniform scaling, unselected character preserved.');
