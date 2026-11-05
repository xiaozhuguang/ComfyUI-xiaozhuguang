import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../web/xzg_video_loader.js", import.meta.url), "utf8");

test("empty and superseded restores release the shared preview queue immediately", async () => {
    const timers = new Map();
    const loaded = [];
    let nextTimer = 0;
    const context = vm.createContext({
        player: { load: url => loaded.push(url) },
        setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout(id) { timers.delete(id); },
    });
    const queueStart = source.indexOf("const _xzgVideoRestoreQueue = [];");
    const queueEnd = source.indexOf("// ═", queueStart);
    const restoreStart = source.indexOf("    const _restoreVideoPreviewInQueue =");
    const restoreEnd = source.indexOf("    const _lmNow", restoreStart);
    vm.runInContext(`${source.slice(queueStart, queueEnd)}
        let _restoreRequestToken = 0;
        let _finishRestorePreview = null;
        let _restoreFadePending = false;
        ${source.slice(restoreStart, restoreEnd)}`, context);
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

    vm.runInContext('_restoreVideoPreviewInQueue("")', context);
    assert.equal(timers.size, 0);
    vm.runInContext('_restoreVideoPreviewInQueue("first.mp4")', context);
    assert.deepEqual(loaded, ["", "first.mp4"]);
    vm.runInContext('_restoreVideoPreviewInQueue("latest.mp4")', context);
    await flush();
    assert.equal(loaded.at(-1), "latest.mp4");
    assert.equal(timers.size, 1);
    vm.runInContext('_restoreVideoPreviewInQueue("")', context);
    await flush();
    assert.equal(timers.size, 0);
    vm.runInContext('_restoreVideoPreviewInQueue("next-workflow.mp4")', context);
    assert.equal(loaded.at(-1), "next-workflow.mp4");
    vm.runInContext('_finishRestorePreview()', context);
    await flush();
    assert.equal(timers.size, 0);
});

test("workflow configuration restores preview from the final video widget value", () => {
    const timers = new Map();
    const loaded = [];
    let nextTimer = 0;
    const node = { widgets: [{ name: "视频", value: "default.mp4" }] };
    const player = { _destroyed: false, resize() {} };
    const context = vm.createContext({
        node, player,
        setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout(id) { timers.delete(id); },
        requestAnimationFrame() {},
        getVideoUrl: value => value === "（不加载视频）" ? "" : value,
        _restoreVideoPreviewInQueue: url => loaded.push(url),
    });
    const start = source.indexOf("    let _restorePreviewTimer = null;");
    const end = source.indexOf("    const _playRestoreFade", start);
    const configureStart = source.indexOf("    const origOnConfigure = node.onConfigure;", end);
    const configureEnd = source.indexOf("    // 从后端输出", configureStart);
    vm.runInContext(`let _isPreviewLoaded = false;\n${source.slice(start, end)}\n${source.slice(configureStart, configureEnd)}`, context);
    const flush = () => {
        const callbacks = [...timers.values()];
        timers.clear();
        callbacks.forEach(callback => callback());
    };

    // Node initialization can finish before async workflow widget restoration.
    vm.runInContext("_scheduleVideoPreviewRestore()", context);
    flush();
    assert.deepEqual(loaded, ["default.mp4"]);
    node.widgets[0].value = "saved.mp4";
    node.onConfigure({});
    flush();
    assert.deepEqual(loaded, ["default.mp4", "saved.mp4"]);

    // Multiple configurations before the timer fires use the latest selection.
    node.onConfigure({});
    node.widgets[0].value = "other.mp4";
    node.onConfigure({});
    assert.equal(timers.size, 1);
    flush();
    assert.equal(loaded.at(-1), "other.mp4");

    node.widgets[0].value = "（不加载视频）";
    node.onConfigure({});
    flush();
    assert.equal(loaded.at(-1), "");

    node.onConfigure({});
    player._destroyed = true;
    const count = loaded.length;
    flush();
    assert.equal(loaded.length, count);
});
