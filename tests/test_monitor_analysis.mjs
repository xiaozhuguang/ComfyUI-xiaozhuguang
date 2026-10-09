import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/xzg_monitor_analysis.js', import.meta.url), 'utf8');
const { analyzeRunRecords, buildRunAnalysisHtml } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const record = {
    id: 'one', workflowName: 'test', schemaVersion: 3, startedAt: 1000, durationMs: 3000,
    gpuNames: ['GPU A'], gpuIds: ['2'], gpuCapacityMb: [48 * 1024], gpuPowerLimitsW: [300], memoryTotalMb: 256 * 1024,
    samples: [
        [0, [[20, 40, 10 * 1024, 100]], [10, 20 * 1024], { id: '1', title: 'load' }],
        [1000, [[40, 45, 20 * 1024, 200]], [30, 40 * 1024], { id: '1', title: 'load' }],
        [3000, [[80, 50, 30 * 1024, 300]], [50, 60 * 1024], { id: '2', title: 'sample' }],
        [4000, [[100, 60, 99 * 1024, 900]], [90, 99 * 1024], null],
    ],
    nodeIntervals: [
        { startMs: 0, endMs: 1000, node: { id: '1', title: 'load' } },
        { startMs: 1000, endMs: 3000, node: { id: '2', title: 'sample' } },
    ],
};

test('peaks and time-weighted averages exclude tail samples and preserve physical limits', () => {
    const [run] = analyzeRunRecords([record]);
    const vram = run.series.find(s => s.metricKey === 'gpu_vram');
    assert.equal(vram.peak.y, 30);
    assert.equal(vram.peak.x, 3);
    assert.equal(vram.capacity, 48);
    assert.equal(vram.key, 'gpu_vram:2');
    assert.equal(vram.average, 65 / 3);
    const power = run.series.find(s => s.metricKey === 'gpu_power');
    assert.equal(power.capacity, 300);
    assert.equal(power.energyWh, 650 / 3600);
    assert.equal(power.coveredSeconds, 3);
    assert.equal(run.series.find(s => s.metricKey === 'mem_used').capacity, 256);
    assert.deepEqual(run.nodes.map(n => n.seconds), [1, 2]);
});

test('missing measurements are not zero or integrated across missing intervals', () => {
    const missing = structuredClone(record);
    missing.samples[1][1][0][3] = null;
    const power = analyzeRunRecords([missing])[0].series.find(s => s.metricKey === 'gpu_power');
    assert.equal(power.points[1].y, null);
    assert.equal(power.energyWh, null);
    assert.equal(power.coveredSeconds, 0);
});

test('legacy memory columns, disabled metrics, repeated nodes and multiple GPUs stay correct', () => {
    for (const [schemaVersion, cpu] of [[1, [12, 0, 0, 8 * 1024]], [2, [12, 0, 8 * 1024]], [3, [12, 8 * 1024]]]) {
        const legacy = { ...record, schemaVersion, gpuNames: ['A', 'B'], gpuIds: ['0', '2'],
            samples: [[0, [[0, 0, 1024, 1], [1, 1, 2048, 2]], cpu]],
            nodeIntervals: [...record.nodeIntervals, { startMs: 2000, endMs: 2500, node: { id: '1', title: 'load' } }],
        };
        const [run] = analyzeRunRecords([legacy], { gpu_temp: false, gpu_power: false });
        assert.ok(!run.series.some(s => s.metricKey === 'gpu_temp' || s.metricKey === 'gpu_power'));
        assert.equal(run.series.find(s => s.metricKey === 'mem_used').peak.y, 8);
        assert.equal(run.series.find(s => s.key === 'gpu_vram:2').peak.y, 2);
        assert.equal(run.nodes.find(n => n.id === '1').seconds, 1.5);
    }
});

test('standalone report safely embeds record names and has syntactically valid inline JavaScript', () => {
    const html = buildRunAnalysisHtml([{ ...record, workflowName: '</script><script>throw 1</script>' }]);
    const payload = html.match(/<script id="analysis-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
    assert.equal(JSON.parse(payload)[0].name, '</script><script>throw 1</script>');
    assert.ok(!payload.includes('<'));
    const script = html.match(/<script>\(([\s\S]*?)<\/script>/)[1];
    new vm.Script('(' + script);
    assert.ok(html.includes('节点耗时') && html.includes('资源采样峰值对比'));
    assert.ok(!html.includes('<script src=') && !html.includes('https://'));
});

test('history picker selects records, disables empty selections and generates only chosen records', async () => {
    class Element {
        constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.events = {}; }
        append(...items) { this.children.push(...items); }
        appendChild(item) { this.children.push(item); }
        addEventListener(name, fn) { this.events[name] = fn; }
        remove() {}
        showModal() { this.open = true; }
        close() { this.open = false; this.events.close?.(); }
    }
    const body = new Element('body');
    let report;
    const context = vm.createContext({
        document: { getElementById: () => null, createElement: tag => new Element(tag), body },
        window: { open: () => ({ opener: null }) }, Blob,
        URL: { createObjectURL: blob => { report = blob; return 'blob:test'; }, revokeObjectURL() {} },
        setTimeout() {},
    });
    vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.picker = showRunAnalysisPicker;', context);
    context.picker([record, { ...record, id: 'two', workflowName: 'second' }], 'two', {});
    let dialog = body.children.at(-1);
    const list = dialog.children[2], actions = dialog.children[3];
    assert.equal(list.children[0].children[0].checked, true);
    assert.equal(list.children[1].children[0].checked, true);
    // 取消勾选第一条后生成：仅导出勾选的第二条记录
    const firstCheck = list.children[0].children[0];
    firstCheck.checked = false;
    firstCheck.events.change();
    actions.children[2].events.click();
    const html = await report.text();
    const data = JSON.parse(html.match(/<script id="analysis-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(data.length, 1); assert.equal(data[0].id, 'two');
    assert.equal(dialog.open, false);
    context.picker([record], 'one', {});
    dialog = body.children.at(-1);
    dialog.children[3].children[0].events.click();
    assert.equal(dialog.children[3].children[2].disabled, true);
    context.picker([], null, {});
    dialog = body.children.at(-1);
    assert.equal(dialog.children[3].children[2].disabled, true);
    assert.match(dialog.children[2].textContent, /暂无历史记录/);
});
