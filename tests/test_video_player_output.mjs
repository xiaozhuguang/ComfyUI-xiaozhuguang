import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../web/xzg_video_player.js", import.meta.url), "utf8")
    .replace(/^import\s[\s\S]*?;\r?\n/gm, "")
    .replace("export class XiaozhuguangVideoPlayer", "class XiaozhuguangVideoPlayer");
const context = vm.createContext({});
vm.runInContext(source, context);
const Player = vm.runInContext("XiaozhuguangVideoPlayer", context);

test("saved video uses authoritative frames despite stale range and decoder totals", () => {
    const player = Object.create(Player.prototype);
    Object.assign(player, {
        _enableLoadRange: false, _backendFrameCount: 383,
        _totalFrames: 61, _sourceTotalFrames: 61, _rangeTotalFrames: 61,
        _skipFrames: 0, _frameLimit: 0,
    });
    assert.equal(player.getTotalFrames(), 383);
    assert.equal(player.getSourceTotalFrames(), 383);
    assert.equal(player._computeEndFrame(), 383);
    assert.equal(player._getDisplayTotalFrames(), 382);
});

test("disabled load range clears all colored labels", () => {
    const player = Object.create(Player.prototype);
    player._enableLoadRange = false;
    for (const key of ["_redFrameDisplay", "_blueFrameDisplay", "_rangeLenDisplay"]) {
        player[key] = { textContent: "61", style: { display: "block" } };
    }
    player._updateRangeDisplay();
    for (const key of ["_redFrameDisplay", "_blueFrameDisplay", "_rangeLenDisplay"]) {
        assert.equal(player[key].textContent, "");
        assert.equal(player[key].style.display, "none");
    }
});
