import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../web/xzg_monitor.js', import.meta.url), 'utf8');
const intervals = source.slice(source.indexOf('function finishRunNodeInterval('), source.indexOf('function fmtDur('));
const capture = source.slice(source.indexOf('function captureRunMetrics('), source.indexOf('function resolveExecutionNode('));

test('short node intervals and exact boundaries preserve correct node attribution', () => {
    const record = { startedAt: 1000, finishedAt: 1500, nodeIntervals: [
        { startMs: 0, endMs: 20, node: 'short' }, { startMs: 20, endMs: 500, node: 'next' },
    ] };
    const at = vm.runInNewContext(`${intervals}\nnodeAtRunTime`, {});
    assert.equal(at(record, 19), 'short');
    assert.equal(at(record, 20), 'next');
    assert.equal(at(record, 500), null);
    assert.equal(at(record, 2400), null);
    assert.equal(at({}, 10, 'old-record-node'), 'old-record-node');
});

test('finishing an interval never produces negative duration or overwrites a closed interval', () => {
    const record = { startedAt: 1000, nodeIntervals: [{ startMs: 100, endMs: null }] };
    const finish = vm.runInNewContext(`${intervals}\nfinishRunNodeInterval`, { _activeRunMetrics: record });
    finish(1050);
    assert.equal(record.nodeIntervals[0].endMs, 100);
    finish(1200);
    assert.equal(record.nodeIntervals[0].endMs, 100);
});

test('tail samples stop after two seconds and reject responses from a previous run', () => {
    let now = 7000;
    const record = { startedAt: 5000, finishedAt: 6000, lastCapturedAt: 0, lastSourceTime: 0,
        samples: [], gpuNames: [], gpuIds: [] };
    const runCapture = vm.runInNewContext(`${capture}\ncaptureRunMetrics`, {
        _activeRunMetrics: record, _runRecordingEnabled: true, _currentRunNode: null,
        XZG_RUN_METRICS_TAIL_MS: 2000, XZG_RUN_METRICS_MAX_SAMPLES: 100,
        Date: { now: () => now }, _liveRunChartRefresh: null,
    });
    runCapture({ time: 4 });
    assert.equal(record.samples.length, 0);
    runCapture({ time: 7 });
    assert.equal(record.samples.length, 1);
    assert.equal(record.samples[0][3], null);
    now = 8100; runCapture({ time: 8.1 });
    assert.equal(record.samples.length, 1);
});


test('right-clicking monitor metrics opens charts without recorded samples', async () => {
    const start = source.indexOf('statsEl.addEventListener("contextmenu",');
    const end = source.indexOf('\n  function renderCompact(', start);
    let handler;
    const opened = [];
    const statsEl = { addEventListener: (_, fn) => { handler = fn; } };
    vm.runInNewContext(source.slice(start, end), {
        statsEl, _runMetricsRestorePromise: Promise.resolve(),
        showContextMenu: (anchor, request) => opened.push({ anchor, ...request }),
    });
    for (const [metric, expected] of [
        ['gpu_temp', 'gpu:2:1'], ['gpu_vram', 'gpu:2:2'],
        ['cpu_util', 'cpu:0'], ['mem_used', 'cpu:1'],
    ]) {
        const parameter = { dataset: { xzgMetric: metric, xzgGpuIndex: '2' } };
        await handler({ target: { closest: () => parameter }, preventDefault() {}, stopPropagation() {} });
        assert.equal(opened.at(-1).chartKey, expected);
        assert.equal(opened.at(-1).anchor, parameter);
    }
    await handler({ target: { closest: () => null }, preventDefault() {}, stopPropagation() {} });
    assert.equal(opened.at(-1).chartKey, 'gpu:0:2');
    assert.equal(opened.at(-1).anchor, statsEl);
});


test('empty capacity charts use physical VRAM, GPU power limits and total RAM with headroom', () => {
    const start = source.indexOf('  const drawRunChart = () => {');
    const end = source.indexOf('    const nodeColor = (point) =>', start);
    for (const [kind, metric, gpuId, capacity, unit] of [
        ['gpu', 2, '0', 48, 'GB'], ['gpu', 2, '2', 24, 'GB'],
        ['gpu', 3, '0', 450, 'W'], ['cpu', 1, null, 256, 'GB'],
    ]) {
        const labels = [];
        const labelPositions = [];
        const ctx = {
            clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
            measureText: () => ({ width: 20 }), fillText: (text, x, y) => { labels.push(text); labelPositions.push({ text, y }); },
        };
        const choice = { value: 'vram', kind, metric, gpuId, unit, decimals: 1 };
        vm.runInNewContext(source.slice(start, end) + '\n}; drawRunChart();', {
            chartCanvas: { width: 640, height: 340, getContext: () => ctx },
            chartChoices: [choice], chartSelect: { value: 'vram' }, _selectedRunMetrics: null,
            _monitorMemoryTotalMb: 256 * 1024,
            _monitorGpus: [
                { index: 0, vram_total_mb: 48 * 1024, power_limit_w: 450, shared_memory_mb: 64 * 1024 },
                { index: 2, vram_total_mb: 24 * 1024, shared_memory_mb: 64 * 1024 },
            ],
        });
        assert.equal(choice.fixedMax, capacity);
        assert.ok(labels.includes(`${capacity.toFixed(1)}${unit}`));
        assert.ok(!labels.includes(`${(capacity * 1.12).toFixed(1)}${unit}`));
        const topTick = labelPositions.find(label => label.text === `${capacity.toFixed(1)}${unit}`);
        assert.ok(Math.abs(topTick.y - (14 + (340 - 14 - 34) * .12 / 1.12)) < 1e-9);
        assert.ok(labels.includes(`0.0${unit}`));
        assert.ok(!labels.includes(`112.0${unit}`));
    }
});


test('chart body dragging preserves controls and resize handle and saves its position', () => {
    const handlers = {};
    let captures = 0, saves = 0;
    const menu = {
        style: {}, isConnected: true, offsetWidth: 500,
        getBoundingClientRect: () => ({ left: 100, top: 100, right: 600, bottom: 500, width: 500, height: 400 }),
        addEventListener: (name, fn) => { handlers[name] = fn; },
        setPointerCapture: () => { captures++; },
    };
    const start = source.indexOf('    let drag = null;', source.indexOf('if (isChartWindow) {'));
    const end = source.indexOf('    let chartResizeSaveTimer', start);
    vm.runInNewContext(source.slice(start, end), {
        menu, window: { innerWidth: 1200, innerHeight: 800 },
        _display: {}, normalizeChartWindow: value => value, saveDisplay: () => { saves++; },
    });
    const down = (control, x = 200, y = 200, button = 0) => handlers.pointerdown({
        target: { closest: () => control }, button, clientX: x, clientY: y,
        pointerId: 1, preventDefault() {},
    });
    for (const control of ['select', 'button', 'a', 'split']) {
        down(control); handlers.pointermove({ clientX: 250, clientY: 260 });
        assert.equal(menu.style.left, undefined);
    }
    down(null, 595, 495); assert.equal(captures, 0);
    down(null, 200, 200, 2); assert.equal(captures, 0);
    down(null); assert.equal(captures, 1);
    handlers.pointermove({ clientX: 250, clientY: 260 });
    assert.equal(menu.style.left, '150px'); assert.equal(menu.style.top, '160px');
    handlers.pointerup(); assert.equal(saves, 1);
    handlers.lostpointercapture(); assert.equal(saves, 1);
    handlers.pointermove({ clientX: 300, clientY: 300 }); assert.equal(menu.style.left, '150px');
});


test('clearing history keeps the chart visible and the next run updates the same window', async () => {
    let redraws = 0;
    const canvas = { style: { display: 'block' } };
    const context = vm.createContext({
        _runMetricsHistory: [{ id: 'old' }], _lastRunMetrics: { id: 'old' }, _lastRunDuration: 100,
        _activeRunMetrics: null, _runMetricsRestorePromise: Promise.resolve(), _display: {},
        _monitorGpus: [{ index: 0, name: 'GPU' }], _monitorMemoryTotalMb: null, _run: { name: 'new' },
        _runRecordingEnabled: true, _currentRunNode: null,
        chartCanvas: canvas, chartSelect: { value: 'gpu:0:2' }, chartHoverInfo: { value: 1 },
        populateRunSelector() {}, populateRunChart() { redraws++; }, syncInlineClearButton() {},
        renderRunHistoryPopup() {}, runHistoryPopup: { isConnected: false },
        openRunMetricsDb: async () => ({ transaction() {
            const transaction = { objectStore: () => ({ clear() {
                queueMicrotask(() => transaction.oncomplete());
            } }) };
            return transaction;
        } }),
        _liveRunChartRefresh: () => { redraws++; },
        XZG_RUN_METRICS_TAIL_MS: 2000, XZG_RUN_METRICS_MAX_SAMPLES: 100,
        resolveExecutionNode: () => null, console,
    });
    const start = source.indexOf('  const runClearMetricsHistory =');
    const end = source.indexOf('  const syncRunPickerButton =', start);
    vm.runInContext(source.slice(start, end) + '\nglobalThis.clearHistory = runClearMetricsHistory;', context);
    await context.clearHistory({ disabled: false });
    assert.equal(canvas.style.display, 'block');
    assert.equal(context.chartHoverInfo, null);
    assert.equal(context._runMetricsHistory.length, 0);
    assert.equal(redraws, 1);
    const beginStart = source.indexOf('function beginRunMetricsCapture(');
    const beginEnd = source.indexOf('function finishRunNodeInterval(', beginStart);
    vm.runInContext(source.slice(beginStart, beginEnd) + capture, context);
    context.beginRunMetricsCapture(Date.now() - 1000);
    assert.equal(redraws, 2);
    context.captureRunMetrics({ gpu: { gpus: [{ index: 0, name: 'GPU', vram_used_mb: 100 }] } });
    assert.equal(context._activeRunMetrics.samples.length, 1);
    assert.equal(redraws, 3);
    assert.equal(canvas.style.display, 'block');
});


test('curve types follow capsule metric switches for each GPU and handle all metrics disabled', () => {
    const options = [];
    const select = {
        style: { setProperty() {} }, value: '', replaceChildren() { options.length = 0; this.value = ''; },
        appendChild(option) { options.push(option); if (options.length === 1) this.value = option.value; },
    };
    const display = { gpu_util: false, gpu_temp: true, gpu_vram: false, gpu_power: false, cpu_util: false, mem_used: true };
    const context = vm.createContext({
        chartSelect: select, chartChoices: [], chartNodeColors: new Map(),
        _selectedRunMetrics: null, _activeRunMetrics: null, runSelect: { value: '' },
        _runMetricsHistory: [], _lastRunMetrics: null, _display: display,
        _monitorGpus: [{ index: 0, name: 'GPU A' }, { index: 2, name: 'GPU B' }],
        document: { createElement: () => ({ style: { setProperty() {} } }), querySelectorAll: () => [] }, chartHoverInfo: null,
        metricMenuColor: () => "#ffffff",
        menu: {}, drawRunChart() {},
    });
    const start = source.indexOf('  const populateRunChart =');
    const end = source.indexOf('  runSelect.addEventListener', start);
    vm.runInContext(source.slice(start, end) + '\nglobalThis.populate = populateRunChart;', context);
    context.populate('gpu:0:2');
    assert.deepEqual(options.map(option => option.value), ['gpu:0:1', 'gpu:2:1', 'cpu:1']);
    assert.equal(select.value, 'gpu:0:1');
    display.gpu_temp = false;
    context.populate('gpu:0:1'); assert.equal(select.value, 'cpu:1');
    display.mem_used = false;
    context.populate('cpu:1'); assert.equal(options.length, 0);
    display.gpu_vram = true;
    context.populate('gpu:2:2');
    assert.deepEqual(options.map(option => option.value), ['gpu:0:2', 'gpu:2:2']);
    assert.equal(select.value, 'gpu:2:2');
    assert.ok(context.chartChoices.every(choice => choice.textColor === '#FFD700'));
});


test('VRAM values stay theme gold at every utilization and tolerate missing readings', () => {
    const start = source.indexOf('function vramColor(');
    const end = source.indexOf('function pctColor(', start);
    const color = vm.runInNewContext(source.slice(start, end) + '\nvramColor', {});
    assert.equal(color(79.9, 100), '#FFD700');
    assert.equal(color(80, 100), '#FFD700');
    assert.equal(color(94.9, 100), '#FFD700');
    assert.equal(color(95, 100), '#FFD700');
    assert.equal(color(110, 100), '#FFD700');
    assert.equal(color(null, 100), '#8b8f9a');
    assert.equal(color(NaN, 100), '#8b8f9a');
    assert.equal(color(10, null), '#FFD700');
});


test('deleting one saved curve preserves other records and active capture and refreshes the view', async () => {
    const deleted = [];
    let redraws = 0;
    const context = vm.createContext({
        _activeRunMetrics: { id: 'live', samples: [] },
        _runMetricsHistory: [{ id: 'a', durationMs: 10 }, { id: 'b', durationMs: 20 }],
        _lastRunMetrics: { id: 'a' }, _lastRunDuration: 10,
        _runMetricsRestorePromise: Promise.resolve(),
        runSelect: { value: 'a' }, chartSelect: { value: 'gpu:0:2' },
        chartCanvas: { style: {} }, chartHoverInfo: {},
        populateRunSelector() {}, populateRunChart() { redraws++; }, syncInlineClearButton() {},
        renderRunHistoryPopup() {}, runHistoryPopup: { isConnected: false }, console,
        openRunMetricsDb: async () => ({ transaction() {
            const transaction = { objectStore: () => ({ delete(id) {
                deleted.push(id); queueMicrotask(() => transaction.oncomplete());
            } }) }; return transaction;
        } }),
    });
    const start = source.indexOf('  const deleteRunMetricsRecord =');
    const end = source.indexOf('  const syncRunPickerButton =', start);
    vm.runInContext(source.slice(start, end) + '\nglobalThis.deleteRecord = deleteRunMetricsRecord;', context);
    const button = { disabled: false };
    await context.deleteRecord('a', button);
    assert.deepEqual(deleted, ['a']);
    assert.equal(context._runMetricsHistory.length, 1);
    assert.equal(context._lastRunMetrics.id, 'b');
    assert.equal(context._lastRunDuration, 20);
    assert.equal(context.chartCanvas.style.display, 'block');
    assert.equal(button.disabled, false); assert.equal(redraws, 1);
    await context.deleteRecord('live', button); assert.deepEqual(deleted, ['a']);
    await context.deleteRecord('b', button);
    assert.equal(context._runMetricsHistory.length, 0);
    assert.equal(context._lastRunMetrics, null);
    assert.equal(context._activeRunMetrics.id, 'live');
    assert.equal(redraws, 2);
});
