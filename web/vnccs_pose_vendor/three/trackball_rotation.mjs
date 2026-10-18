import { Quaternion, Vector3 } from './three.module.js';

export const TRACKBALL_ROTATION_GAIN = 1.8;

function projectTrackball(x, y, radius) {
    const point = new Vector3(x / radius, y / radius, 0);
    const distanceSquared = point.x * point.x + point.y * point.y;
    const boundary = Math.SQRT1_2;
    const distance = Math.sqrt(distanceSquared);
    if (distance <= boundary) {
        point.z = Math.sqrt(1 - distanceSquared);
    } else {
        // Match the sphere's slope at the boundary, so entering the outer
        // trackball region does not create a sudden change in rotation speed.
        point.z = (boundary * boundary) / distance;
    }
    return point.normalize();
}

export function computeTrackballRotation(startX, startY, endX, endY, radius, gain = 1) {
    const start = projectTrackball(startX, startY, Math.max(1, radius));
    const end = projectTrackball(endX, endY, Math.max(1, radius));
    const rotation = new Quaternion().setFromUnitVectors(start, end);
    const angle = 2 * Math.acos(Math.max(-1, Math.min(1, rotation.w)));
    const axis = new Vector3(rotation.x, rotation.y, rotation.z);
    if (axis.lengthSq() > 1e-12 && Math.abs(gain) !== 1) {
        axis.normalize();
        rotation.setFromAxisAngle(axis, angle * gain);
    } else if (gain < 0) {
        rotation.invert();
    }
    return rotation;
}
