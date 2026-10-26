import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../web/xzg_save_utils.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');

function setup(cancel = false) {
    const calls = [];
    const blob = new Blob(['full-resolution-jpg'], { type: 'image/jpeg' });
    const context = {
        console, URLSearchParams,
        api: { apiURL: url => url },
        app: { getRandParam: () => '' },
        window: { showSaveFilePicker: async () => {
            calls.push('picker');
            if (cancel) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
            return { createWritable: async () => ({
                write: async data => { assert.equal(data, blob); calls.push('write'); },
                close: async () => calls.push('close'),
            }) };
        } },
        fetch: async () => {
            calls.push('fetch');
            return { ok: true, blob: async () => blob };
        },
    };
    const save = vm.runInNewContext(`${source}\ndownloadLazyJpg`, context);
    return { save, calls };
}

for (const [name, image] of [
    ['saved output', { saved_filename: 'image.jpg', saved_type: 'output' }],
    ['resolved original', { real_url: '/original.jpg' }],
]) {
    test(`JPG ${name} selects once and writes to that file`, async () => {
        const { save, calls } = setup();
        await save(image);
        assert.deepEqual(calls, ['picker', 'fetch', 'write', 'close']);
    });
}

test('cancelling JPG save stops without downloading or reopening the picker', async () => {
    const { save, calls } = setup(true);
    await save({ real_url: '/original.jpg' });
    assert.deepEqual(calls, ['picker']);
});
