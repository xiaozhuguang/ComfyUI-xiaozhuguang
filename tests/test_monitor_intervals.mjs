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
