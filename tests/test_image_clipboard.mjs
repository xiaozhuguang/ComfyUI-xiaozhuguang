import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../web/xzg_image_clipboard.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export async function', 'async function');

function setup(overrides = {}) {
    const calls = [];
    const png = new Blob(['original'], { type: 'image/png' });
    const context = {
        window: { isSecureContext: true }, URLSearchParams,
        xzgTh: (zh) => zh,
        api: { apiURL: (url) => url },
        xzgGetRealUrl: async (image, options) => {
            calls.push(['encode', image.real_index, options.format]);
            return '/original.png';
        },
        fetch: async (url) => { calls.push(['fetch', url]); return { ok: true, blob: async () => png }; },
        ClipboardItem: class { constructor(data) { this.data = data; } },
        navigator: { clipboard: { write: async ([item]) => {
            calls.push(['write']);
            assert.equal(await item.data['image/png'], png);
        } } },
        ...overrides,
    };
    const copy = vm.runInNewContext(`${source}\nxzgCopyImageToClipboard`, context);
    return { copy, calls, context, png };
}

test('writes during click before encoding finishes and copies full-resolution PNG', async () => {
    const { copy, calls } = setup();
    await copy({ real_token: 'token', real_index: 3, url: '/small-preview.jpg', saved_filename: 'lossy.jpg' });
    assert.deepEqual(calls, [['encode', 3, 'png'], ['write'], ['fetch', '/original.png']]);
});

test('old workflows use saved original with encoded filename, never preview', async () => {
    const { copy, calls } = setup();
    await copy({ saved_filename: 'a & b.png', saved_subfolder: '中文', url: '/preview.jpg' });
    const url = new URL(calls.find(c => c[0] === 'fetch')[1], 'http://localhost');
    assert.equal(url.searchParams.get('filename'), 'a & b.png');
    assert.equal(url.searchParams.get('subfolder'), '中文');
    assert.equal(url.searchParams.get('type'), 'output');
});

test('saved JPG converts at original dimensions and releases bitmap and canvas', async () => {
    let closed = false;
    const canvas = {
        getContext: () => ({ drawImage: (bitmap) => assert.equal(bitmap.width, 4096) }),
        toBlob(callback, type) {
            assert.equal(this.width, 4096); assert.equal(this.height, 2048);
            assert.equal(type, 'image/png'); callback(png);
        },
    };
    const { copy, png } = setup({
        fetch: async () => ({ ok: true, blob: async () => new Blob(['jpg'], { type: 'image/jpeg' }) }),
        createImageBitmap: async () => ({ width: 4096, height: 2048, close() { closed = true; } }),
        document: { createElement: () => canvas },
    });
    await copy({ saved_filename: 'original.jpg' });
    assert.equal(closed, true); assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
});

test('missing original rejects rather than copying low-resolution preview', async () => {
    const { copy, calls } = setup();
    await assert.rejects(copy({ url: '/preview.jpg' }), /高清原图不可用/);
    assert.equal(calls.some(c => c[0] === 'fetch'), false);
});

test('insecure browser fails before fetching or writing', async () => {
    const { copy, calls } = setup({ window: { isSecureContext: false } });
    await assert.rejects(copy({ real_token: 'token' }), /localhost/);
    assert.equal(calls.length, 0);
});

test('failed original request is reported', async () => {
    const { copy } = setup({ fetch: async () => ({ ok: false, status: 404 }) });
    await assert.rejects(copy({ real_token: 'expired' }), /HTTP 404/);
});

test('clipboard permission rejection propagates', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const { copy } = setup({ navigator: { clipboard: { write: async () => { throw denied; } } } });
    await assert.rejects(copy({ real_token: 'token' }), error => error === denied);
});

test('local Windows transparent images use native clipboard without browser overwrite', async () => {
    const calls = [];
    const { copy } = setup({
        window: { location: { hostname: 'localhost' } },
        navigator: { userAgent: 'Windows Edge', clipboard: { write: () => { throw new Error('browser overwrote native'); } } },
        api: { fetchApi: async (url, options) => {
            calls.push([url, JSON.parse(options.body)]);
            return { ok: true, json: async () => ({ copied: true }) };
        } },
    });
    const result = await copy({ has_alpha: true, real_token: 'rgba-token', real_index: 2 });
    assert.equal(result.native, true);
    assert.deepEqual(calls, [['/xzg_copy_image_clipboard', { token: 'rgba-token', index: 2 }]]);
});

test('native copy failure is reported without silently using incompatible browser path', async () => {
    const { copy } = setup({
        window: { location: { hostname: '127.0.0.1' } },
        navigator: { userAgent: 'Windows Edge' },
        api: { fetchApi: async () => ({ ok: false, status: 500, json: async () => ({ error: 'clipboard busy' }) }) },
    });
    await assert.rejects(copy({ has_alpha: true, real_token: 'rgba-token' }), /clipboard busy/);
});
