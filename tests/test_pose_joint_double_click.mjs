import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../web/pose_studio/core.js', import.meta.url), 'utf8');
const start = source.indexOf('        this._jointLockPointerDown = event => {');
const end = source.indexOf('        window.addEventListener("pointerdown", this._jointLockPointerDown', start);
assert.ok(start >= 0 && end > start);
let time = 0;
const canvas = {};
const bone = { name: 'elbow' };
let hit = bone;
let selections = 0;
const viewer = {
    canvas,
    _getLockableBoneAtPointer: () => hit,
    pickCharacterAtPointer: () => false,
    selectBone() { selections++; },
    deselectBone() {}, requestRender() {},
};
new Function('performance', 'axisGizmo', source.slice(start, end)).call(viewer,
    { now: () => time }, { contains: () => false });
const event = (overrides = {}) => ({ button: 0, pointerId: 1, clientX: 100, clientY: 100, target: canvas, ...overrides });
function click({ jitter = 0, cancel = false } = {}) {
    hit = bone;
    viewer._jointLockPointerDown(event());
    viewer._jointLockPointerMove(event({ clientX: 100 + jitter }));
    // Selection handles may obscure the marker between press and release.
    hit = null;
    viewer._jointLockPointerUp(event({ type: cancel ? 'pointercancel' : 'pointerup', clientX: 100 + jitter }));
}
click({ jitter: 6 });
time += 460;
click({ jitter: 5 });
assert.equal(viewer._lockedBoneName, 'elbow');
assert.equal(selections, 1);

viewer._lockedBoneName = null;
time += 600;
click();
time += 100;
click({ jitter: 15 });
time += 100;
click();
assert.equal(viewer._lockedBoneName, null, 'a real drag must break the double-click sequence');
click({ cancel: true });
assert.equal(viewer._jointLockClick, null);
viewer._jointLockPointerDown(event({ target: {} }));
assert.equal(viewer._jointLockPress, null, 'outside clicks must not start a joint lock gesture');
console.log('Joint double-click tolerates hand jitter and changing release hits; drags, cancellation and outside UI do not lock joints.');

const pickerStart = source.indexOf('    _getLockableBoneAtPointer(event) {');
const pickerEnd = source.indexOf('\n    resetJointSelectionLock()', pickerStart);
const Picker = new Function(`return class { ${source.slice(pickerStart, pickerEnd)} };`)();
const picker = new Picker();
Object.assign(picker, {
    boneList: [bone], hoveredBoneName: bone.name,
    _getJointMarkerAtPointer: () => null,
    pickCharacterAtPointer: () => ({ active: true }),
});
assert.equal(picker._getLockableBoneAtPointer(event()), bone, 'yellow surface hover must lock even outside the marker dot');
picker.pickCharacterAtPointer = () => null;
assert.equal(picker._getLockableBoneAtPointer(event()), null, 'stale hover must not lock a joint on empty space');
picker.pickCharacterAtPointer = () => ({ active: false });
assert.equal(picker._getLockableBoneAtPointer(event()), null, 'hover from the active rig must not lock through another character');
