import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../web/xzg_image_loader.js', import.meta.url), 'utf8');
const start = source.indexOf('            const savedPoseStates = node.properties?.xzg_pose_capture_states || {};');
const menuSource = source.slice(start, source.indexOf('            appendContextMenuDivider();', start));

function menu(state) {
    const items = [], calls = [];
    vm.runInNewContext(menuSource, {
        node: { properties: { xzg_pose_capture_states: { 'image.png': state } } },
        imageName: 'image.png', xzgT: zh => zh,
        document: { createElement: () => ({ style: {}, addEventListener(event, fn) { this[event] = fn; } }) },
        contextMenu: { appendChild: item => items.push(item) },
        hideContextMenu() {}, openPoseStudio: (...args) => calls.push(args),
        getImageLoaderBackendSessionId: async () => 'current',
    });
    return { items, calls };
}

test('ordinary image offers background and detection without edit-existing action', () => {
    const { items, calls } = menu();
    assert.deepEqual(items.map(item => item.textContent), ['以此图为背景编辑姿势', '以此图获取姿势']);
    items[0].click();
    assert.deepEqual(calls[0], ['image.png', null, 'image.png']);
});

test('pose capture can resume its saved pose and still offers background entry', async () => {
    const { items, calls } = menu({ backend_session_id: 'current', pose_data: 'saved-pose' });
    assert.equal(items[0].textContent, '编辑姿势');
    assert.equal(items[1].textContent, '以此图为背景编辑姿势');
    assert.equal(items.length, 2, 'pose capture must not offer pose detection again');
    await items[0].click();
    assert.deepEqual(calls[0], [null, 'saved-pose', 'image.png']);
});
