import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../web/xzg_video_sync_preview.js", import.meta.url), "utf8");
const timeline = source.slice(source.indexOf("    const playerFps ="), source.indexOf("    const fmtTime ="));
const alignment = source.slice(source.indexOf("    let _lastAlignAt ="), source.indexOf('    let _lastBufferStatusText ='));
function setup(fps, frames) {
    const players = fps.map((rate, i) => ({ player: {
        duration: frames[i] / rate, currentTime: 0, _skipFrames: 0,
        getFrameRate: () => rate, _computeEndFrame: () => frames[i],
        seek(time) { this.currentTime = time; this.seeks = (this.seeks || 0) + 1; },
    } }));
    const ctx = vm.createContext({ players, pickMain: () => players[0], playing: true, groupStartTime: 0, isFinite });
    vm.runInContext(timeline + alignment, ctx);
    return { players, run: code => vm.runInContext(code, ctx) };
}

test("different frame rates align by elapsed time and use the common duration", () => {
    const { players, run } = setup([24, 48], [240, 576]);
    assert.equal(run("timelineFrames()"), 240);
    run("seekAllToOffset(72)");
    assert.equal(players[0].player.currentTime, 3);
    assert.equal(players[1].player.currentTime, 3);
    assert.equal(run("playerOffsetFrames(players[1])"), 72);
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
