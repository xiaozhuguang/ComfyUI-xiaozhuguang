import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createVideoOutputCache } from '../web/lib/xzg_video_output_cache.mjs';

function setup() {
    const values = new Map();
    const storage = { setItem: (k, v) => values.set(k, v), getItem: k => values.get(k) };
    const listeners = new Map();
    let count = 0;
    const api = {
        queuePrompt: async () => ({ prompt_id: `p${++count}` }),
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
    };
    const emit = (type, detail) => { for (const fn of listeners.get(type) || []) fn({ detail }); };
    const app = { graph: { id: 'a' } };
    const cache = createVideoOutputCache(storage);
    cache.install(api, app);
    const queue = (id, nodeId = '7') => api.queuePrompt(0, {
        workflow: id ? { id } : {}, output: { [nodeId]: { class_type: 'XiaozhuguangVideoCombine' } },
    });
    const output = (pid, filename, nodeId = '7') => emit('executed', {
        prompt_id: pid, node: nodeId, output: { video: [{ filename, preview_id: filename }] },
    });
    return { cache, api, app, emit, queue, output, storage };
}

test('queued workflows with identical node IDs receive only their own results', async () => {
    const h = setup();
    const a = { id: 'a' }, b = { id: 'b' };
    const seenA = [], seenB = [];
    h.cache.subscribe({ graph: a, id: 7 }, x => seenA.push(x.video[0].filename));
    h.cache.subscribe({ graph: b, id: 7 }, x => seenB.push(x.video[0].filename));
    await h.queue('a'); await h.queue('b');
    h.app.graph = b;
    h.output('p1', 'a-new.mp4'); h.output('p2', 'b-new.mp4');
    assert.deepEqual(seenA, ['a-new.mp4']); assert.deepEqual(seenB, ['b-new.mp4']);
    assert.equal(h.cache.get(a, 7).filename, 'a-new.mp4');
    assert.equal(h.cache.get(b, 7).filename, 'b-new.mp4');
});

test('recreated nodes and a refreshed cache restore the latest workflow result', async () => {
    const h = setup(); await h.queue('a'); h.output('p1', 'old.mp4');
    await h.queue('a'); h.output('p2', 'latest.mp4');
    assert.equal(h.cache.get({ id: 'a' }, 7).filename, 'latest.mp4');
    const refreshed = createVideoOutputCache(h.storage);
    assert.equal(refreshed.get({ id: 'a' }, 7).filename, 'latest.mp4');
    assert.equal(refreshed.get({ id: 'b' }, 7), null);
});

test('an execution arriving before the queue response is routed after registration', async () => {
    const listeners = new Map();
    const api = {
        addEventListener: (type, fn) => listeners.set(type, fn),
        async queuePrompt() {
            listeners.get('executed')({ detail: { prompt_id: 'fast', node: '7', output: { video: [{ filename: 'fast.mp4' }] } } });
            return { prompt_id: 'fast' };
        },
    };
    const cache = createVideoOutputCache(null);
    cache.install(api, { graph: { id: 'a' } });
    await api.queuePrompt(0, { workflow: { id: 'a' }, output: { 7: { class_type: 'XiaozhuguangVideoSaveDaVinci' } } });
    assert.equal(cache.get({ id: 'a' }, 7).filename, 'fast.mp4');
});

test('unknown prompts and nodes cannot overwrite confirmed output', async () => {
    const h = setup(); await h.queue('a'); h.output('p1', 'correct.mp4');
    h.output('foreign', 'wrong.mp4'); h.output('p1', 'wrong.mp4', 'other:7');
    h.emit('executed', { node: '7', output: { video: [{ filename: 'wrong.mp4' }] } });
    assert.equal(h.cache.get({ id: 'a' }, 7).filename, 'correct.mp4');
});

test('subgraph execution IDs remain distinct', async () => {
    const h = setup(); await h.queue('a', '12:7');
    h.output('p1', 'nested.mp4', '12:7');
    assert.equal(h.cache.get({ id: 'a' }, '12:7').filename, 'nested.mp4');
    assert.equal(h.cache.get({ id: 'a' }, '7'), null);
});

test('legacy workflows without UUID never share persisted previews', async () => {
    const h = setup(); const graph = {}; h.app.graph = graph;
    await h.queue(null); h.output('p1', 'legacy.mp4');
    assert.equal(h.cache.get(graph, 7).filename, 'legacy.mp4');
    assert.equal(h.cache.get({}, 7), null);
    assert.equal(createVideoOutputCache(h.storage).get({}, 7), null);
});

test('removed subscribers stop receiving outputs and finished jobs reject late events', async () => {
    const h = setup(); let calls = 0;
    const unsubscribe = h.cache.subscribe({ graph: { id: 'a' }, id: 7 }, () => calls++);
    await h.queue('a'); unsubscribe(); h.output('p1', 'ok.mp4');
    h.emit('execution_success', { prompt_id: 'p1' }); h.output('p1', 'late.mp4');
    assert.equal(calls, 0); assert.equal(h.cache.get({ id: 'a' }, 7).filename, 'ok.mp4');
});

test('new exports of a reused filename change URL; cached results keep the same URL', () => {
    const source = readFileSync(new URL('../web/xzg_video_combine.js', import.meta.url), 'utf8');
    const start = source.indexOf('function getVideoUrl(');
    const end = source.indexOf('\nfunction _extractFilename', start);
    const getUrl = vm.runInNewContext(source.slice(start, end) + '; getVideoUrl', { URLSearchParams });
    assert.notEqual(getUrl('same.mp4', 'output', '', null, 'v1'), getUrl('same.mp4', 'output', '', null, 'v2'));
    assert.equal(getUrl('same.mp4', 'output', '', null, 'v1'), getUrl('same.mp4', 'output', '', null, 'v1'));
    assert.notEqual(getUrl('same.mp4', 'output', '', 'token', 'v1'), getUrl('same.mp4', 'output', '', 'token', 'v2'));
});

test('late queue responses cannot restore an older buffered result over a newer result', async () => {
    const listeners = new Map(), pending = [];
    const api = {
        addEventListener: (type, fn) => listeners.set(type, fn),
        queuePrompt: () => new Promise(resolve => pending.push(resolve)),
    };
    const cache = createVideoOutputCache(null);
    cache.install(api, { graph: { id: 'a' } });
    const prompt = { workflow: { id: 'a' }, output: { 7: { class_type: 'XiaozhuguangVideoCombine' } } };
    const first = api.queuePrompt(0, prompt), second = api.queuePrompt(0, prompt);
    const emit = (pid, filename) => listeners.get('executed')({ detail: {
        prompt_id: pid, node: '7', output: { video: [{ filename }] },
    } });
    emit('first', 'old.mp4');
    pending[1]({ prompt_id: 'second' }); await second;
    emit('second', 'new.mp4');
    pending[0]({ prompt_id: 'first' }); await first;
    assert.equal(cache.get({ id: 'a' }, 7).filename, 'new.mp4');
});

test('the player refreshes changed content with the same filename and discards stale pending loads', () => {
    const source = readFileSync(new URL('../web/xzg_video_combine.js', import.meta.url), 'utf8');
    const start = source.indexOf('            const _applyVideoOutput =');
    const end = source.indexOf('\n            // 原生 onExecuted', start);
    const loaded = [];
    const player = { load: url => loaded.push(url), _pendingVideoUrl: 'old-pending' };
    const apply = vm.runInNewContext(source.slice(start, end) + '; _applyVideoOutput', {
        player, node: {}, document: { hidden: false },
        playerContainer: { clientWidth: 100, clientHeight: 100 },
        getVideoUrl: (name, type, folder, token, version) => `${name}?v=${version}`,
    });
    const show = version => apply({ video: [{ filename: 'same.mp4', preview_id: version }] });
    show('v1'); show('v1'); show('v2');
    assert.deepEqual(loaded, ['same.mp4?v=v1', 'same.mp4?v=v2']);
    assert.equal(player._pendingVideoUrl, null);
});
