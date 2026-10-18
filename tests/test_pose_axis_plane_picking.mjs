import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../web/pose_studio/core.js', import.meta.url), 'utf8');
const start = source.indexOf('    _pickCharacterAxisGizmoHit(event) {');
const end = source.indexOf('    _beginCharacterAxisDrag(event)', start);
const Methods = new Function(`return class {${source.slice(start, end)}}`)();
const viewer = Object.assign(new Methods(), {
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    _characterAxisArcHitSegments: [{ axis: 'Z', start: { x: 0, y: 0 }, end: { x: 80, y: 0 } }],
    _characterAxisPlaneHitRegions: [
        { plane: 'XY', points: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 0, y: 80 }] },
        { plane: 'ZX', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] },
    ],
});
const event = (x, y, dataset = {}, ctrlKey = false) => ({ clientX: x, clientY: y, ctrlKey, target: { dataset } });
assert.equal(viewer._pickCharacterAxisGizmoHit(event(25, 18, { plane: 'XY' })).planeName, 'ZX',
    'fan interior must select the most face-on plane rather than a nearby edge-on arc or DOM stacking order');
assert.equal(viewer._pickCharacterAxisGizmoHit(event(25, 4)).rotationAxisName, 'Z', 'arc remains selectable close to its visible line');
assert.equal(viewer._pickCharacterAxisGizmoHit(event(25, 18, { axis: 'X' })).axisName, 'X', 'axis hit retains priority');
assert.equal(viewer._pickCharacterAxisGizmoHit(event(25, 4, { rotationAxis: 'Z' }, false)).rotationAxisName, 'Z',
    'gizmo supports direct picking without Ctrl');
assert.equal(viewer._pickCharacterAxisGizmoHit(event(25, 18, { axis: 'X' }, true)).axisName, null, 'Ctrl bypasses coordinate interactions');
console.log('Axis picking: plane interior, overlapping planes, arc edges, axis priority and direct interaction passed.');
