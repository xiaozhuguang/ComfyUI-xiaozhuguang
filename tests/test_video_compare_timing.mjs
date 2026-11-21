import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../web/xzg_video_sync_preview.js", import.meta.url), "utf8");
const timeline = source.slice(source.indexOf("    const pickMain ="), source.indexOf("    const fmtTime ="));
const alignment = source.slice(source.indexOf("    let _lastAlignAt ="), source.indexOf("    const updateBufferStatus ="));
function setup(fps, frames) {
    const players = fps.map((rate, i) => ({ player: {
        duration: frames[i] / rate, currentTime: 0, _skipFrames: 0,
        getFrameRate: () => rate, _computeEndFrame: () => frames[i],
        seek(time) { this.currentTime = time; this.seeks = (this.seeks || 0) + 1; },
    } }));
    const ctx = vm.createContext({ players, playing: true, groupStartTime: 0, isFinite });
    vm.runInContext(timeline + alignment, ctx);
    return { players, run: code => vm.runInContext(code, ctx) };
}

test("different frame rates align by elapsed time and use the common duration", () => {
    const { players, run } = setup([24, 48], [240, 576]);
    assert.equal(run("pickMain()"), players[1]);
    assert.equal(run("timelineFrames()"), 480);
    run("seekAllToOffset(144)");
    assert.equal(players[0].player.currentTime, 3);
    assert.equal(players[1].player.currentTime, 3);
    assert.equal(run("playerOffsetFrames(players[1])"), 144);
    run("alignPlayers(100)");
    assert.equal(players[1].player.seeks, 1, "equal times at different FPS must not be corrected");
});

test("appended tail does not stretch the identical opening; visible drift corrects promptly", () => {
    const { players, run } = setup([24, 24], [240, 360]);
    run("seekAllToOffset(120)");
    assert.equal(players[0].player.currentTime, 5);
    assert.equal(players[1].player.currentTime, 5);
    players[1].player.currentTime = 4.8;
    run("alignPlayers(100)");
    assert.equal(players[1].player.currentTime, 5);
    assert.equal(run("timelineFrames()"), 240);
    players[0].player._skipFrames = 48;
    players[1].player._skipFrames = 24;
    run("seekAllToOffset(24)");
    assert.equal(players[0].player.currentTime, 3);
    assert.equal(players[1].player.currentTime, 2);
});

test("alignment waits for the shared startup buffer barrier", () => {
    const { players, run } = setup([24, 24], [240, 240]);
    players[1].player.currentTime = 1;
    run("groupStartTime = null; alignPlayers(100)");
    assert.equal(players[1].player.seeks, undefined);
});

test("scrubbing previews both players during drag and resumes them together on release", async () => {
    const { players } = setup([24, 48], [240, 480]);
    const handlers = {};
    const scrubRange = {
        value: 500,
        addEventListener(type, handler) { handlers[type] = handler; },
    };
    players[0].player.currentTime = 1;
    players[1].player.currentTime = 1.1;
    for (const { player } of players) {
        player.isPlaying = true;
        player.pause = () => { player.isPlaying = false; };
        player.play = () => { player.isPlaying = true; };
    }
    const overlay = {};
    const ctx = vm.createContext({
        players, playing: true, mediaReady: true, groupStartTime: 123, groupStallStarted: null,
        overlay, _overlay: overlay, bufferPanel: { style: {} },
        scrubRange, scrubFrame: {}, scrubTime: {}, playPauseBtn: {}, statusEl: {},
    });
    const scrub = source.slice(source.indexOf("    const fmtTime ="), source.indexOf("    // Check time drift"));
    const playback = source.slice(source.indexOf("    let _syncing ="), source.indexOf("    const playAll ="));
    vm.runInContext(timeline + scrub + playback, ctx);
    handlers.input();
    assert.deepEqual(players.map(({ player }) => player.currentTime), [5, 5]);
    assert.equal(ctx.scrubTime.textContent, "00:05 / 00:10");
    assert.ok(players.every(({ player }) => !player.isPlaying));
    scrubRange.value = 600;
    handlers.input();
    scrubRange.value = 700;
    handlers.input();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(players.map(({ player }) => player.currentTime), [7, 7]);
    assert.deepEqual(players.map(({ player }) => player.seeks), [2, 2]);
    handlers.change();
    assert.deepEqual(players.map(({ player }) => player.currentTime), [7, 7]);
    assert.ok(players.every(({ player }) => player.isPlaying));
    assert.equal(ctx.groupStartTime, null);
});
