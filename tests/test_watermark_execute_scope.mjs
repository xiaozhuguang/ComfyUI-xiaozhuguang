import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editor = readFileSync(new URL('../web/xzg_points_editor.js', import.meta.url), 'utf8');
const batch = readFileSync(new URL('../web/xzg_video_batch.js', import.meta.url), 'utf8');
const editorStart = editor.indexOf('        let queueingUpstream = false;');
const editorEnd = editor.indexOf('        // 右键菜单追加', editorStart);
const batchStart = batch.indexOf('    setup() {', batch.indexOf('name: "XZG.VideoBatchRunner"'));
const batchEnd = batch.indexOf('    beforeRegisterNodeDef(', batchStart);
assert.ok(editorStart >= 0 && editorEnd > editorStart);
assert.ok(batchStart >= 0 && batchEnd > batchStart);

function setup({ schedulerUpstream = false, busy = false, serialize = async () => {} } = {}) {
    const submissions = [];
    const scheduled = [];
    const errors = [];
    let hidden = 0;
    let started = 0;
    const api = { queuePrompt: async (index, prompt) => {
        submissions.push(prompt);
        return { prompt_id: 'test-prompt' };
    } };
    const output = {
        '1': { class_type: 'Loader', inputs: { rectangle: [4, 5] } },
        '2': { class_type: 'VideoWatermarkDetector', inputs: { images: [schedulerUpstream ? '3' : '1', 0] } },
        '3': { class_type: 'Scheduler', inputs: { images: [schedulerUpstream ? '1' : '2', 0] } },
        '4': { class_type: 'Save', inputs: { images: ['2', 0] } },
    };
    const app = {
        graph: { _nodes: [{ id: 1, type: 'Loader' }, { id: 3, type: 'Scheduler' }] },
        queuePrompt: async index => {
            await serialize();
            return api.queuePrompt(index, { output: structuredClone(output) });
        },
    };
    const log = { error: (...args) => errors.push(args) };
    const installBatch = new Function(
        'api', 'app', 'activeSession', 'SCHEDULER_NODE_TYPE', 'BATCH_NODE_TYPE',
        'removeBatchFocusGuard', 'setTimeout', 'openBatchDialog', 'document', 'xzgBatchToast', 'console',
        `return ({${batch.slice(batchStart, batchEnd)}}).setup();`,
    );
    installBatch(api, app, busy ? { isRunning: true } : null, 'Scheduler', 'Loader',
        () => {}, callback => scheduled.push(callback), () => { started++; },
        { querySelector: () => null }, () => {}, log);
    const original = api.queuePrompt;
    const run = new Function('api', 'app', 'node', 'hideProgress', 'console',
        editor.slice(editorStart, editorEnd) + '\nreturn runUpstream;')(
        api, app, { id: 2 }, () => { hidden++; }, log);
    return {
        api, app, run, original, submissions, scheduled, errors,
        hidden: () => hidden,
        started: () => started,
        output,
    };
}

// Loading the tracker must not start batch processing, even when the scheduler is an ancestor.
for (const schedulerUpstream of [false, true]) {
    const state = setup({ schedulerUpstream });
    await state.run();
    assert.equal(state.scheduled.length, 0);
    assert.equal(state.submissions.length, 1);
    assert.deepEqual(Object.keys(state.submissions[0].output).sort(), schedulerUpstream ? ['1', '2', '3'] : ['1', '2']);
    assert.equal(state.submissions[0].xzgExecuteToNode, '2');
    assert.equal(state.api.queuePrompt, state.original);
}

// Other partial submissions containing only the loader must also bypass automatic batching.
{
    const state = setup();
    await state.api.queuePrompt(0, { output: { '1': state.output['1'] } });
    assert.equal(state.scheduled.length, 0);
    assert.equal(state.submissions.length, 1);
}

// Normal full-workflow runs still start batching; an active batch may submit its own segments.
for (const busy of [false, true]) {
    const state = setup({ busy });
    await state.app.queuePrompt(0);
    assert.equal(state.submissions.length, busy ? 1 : 0);
    assert.equal(state.scheduled.length, busy ? 0 : 1);
    state.scheduled.forEach(callback => callback());
    assert.equal(state.started(), busy ? 0 : 1);
}

// Keep the restriction installed until serialization finishes, and ignore repeated clicks.
{
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const state = setup({ serialize: () => pending });
    const run = state.run();
    assert.notEqual(state.api.queuePrompt, state.original);
    await state.run();
    release();
    await run;
    assert.equal(state.submissions.length, 1);
    assert.equal(state.scheduled.length, 0);
    assert.equal(state.api.queuePrompt, state.original);
}

// Serialization failures must restore the queue function and clear the loading indicator.
{
    const state = setup({ serialize: async () => { throw new Error('serialization failed'); } });
    await state.run();
    assert.equal(state.api.queuePrompt, state.original);
    assert.equal(state.hidden(), 1);
    assert.equal(state.errors.length, 1);
    assert.equal(state.submissions.length, 0);
}

// A missing tracker must never fall back to submitting the complete workflow.
{
    const state = setup();
    delete state.output['2'];
    await state.run();
    assert.equal(state.api.queuePrompt, state.original);
    assert.equal(state.submissions.length, 0);
    assert.equal(state.scheduled.length, 0);
    assert.equal(state.hidden(), 1);
}

console.log('Tracker execution scope and batch interception regression checks passed.');
