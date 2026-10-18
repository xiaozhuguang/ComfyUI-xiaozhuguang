import assert from 'node:assert/strict';
import { Vector3 } from '../web/vnccs_pose_vendor/three/three.module.js';
import { computeTrackballRotation } from '../web/vnccs_pose_vendor/three/trackball_rotation.mjs';

function point(x, y, radius) {
    const v = new Vector3(x / radius, y / radius, 0);
    const d2 = v.x * v.x + v.y * v.y;
    const r = Math.sqrt(d2);
    v.z = r <= Math.SQRT1_2 ? Math.sqrt(1 - d2) : 0.5 / r;
    return v.normalize();
}
for (const radius of [100, 200]) {
    const start = point(radius, -radius, radius);
    const end = point(-radius, radius, radius);
    const rotation = computeTrackballRotation(radius, -radius, -radius, radius, radius);
    assert.ok(start.clone().applyQuaternion(rotation).distanceTo(end) < 1e-8,
        'the grabbed lower-right point must follow the pointer to upper-left');
    const insideStart = point(20, -20, radius);
    const insideEnd = point(-10, 30, radius);
    assert.ok(insideStart.clone().applyQuaternion(computeTrackballRotation(20, -20, -10, 30, radius)).distanceTo(insideEnd) < 1e-8);
    const same = computeTrackballRotation(42, 18, 42, 18, radius);
    assert.ok(Math.abs(same.x) + Math.abs(same.y) + Math.abs(same.z) < 1e-12);
}
console.log('Anchored trackball passed: pointer start maps to pointer end exactly, including opposite corners and zoom-scaled radii.');
