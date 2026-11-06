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

test("source-quality preview uses the supplied URL at full resolution even when decoding fails", async () => {
    const ctx = vm.createContext({
        VideoDecoder: class {},
        window: { mb: {} },
        console: { error() {}, warn() {} },
    });
    vm.runInContext(source, ctx);
    const player = Object.create(vm.runInContext("XiaozhuguangVideoPlayer", ctx).prototype);
    const url = "/view?filename=original.mp4";
    const failure = new Error("unsupported codec");
    const opens = [];
    const errors = [];
    let transcodes = 0;
    Object.assign(player, {
        _loadToken: 0,
        _exclusiveDecoder: true,
        _preserveSourceQuality: true,
        _parseVideoUrl: () => ({ filename: "original.mp4", type: "input" }),
        _ensureDecodableUrl: async () => { transcodes++; return "/proxy.mp4"; },
        _decoderPool: {
            async getExclusive(_key, _type, src, maxSide) {
                opens.push([src, maxSide]);
                throw failure;
            },
        },
        _onErrorEvt: error => errors.push(error),
    });
    await player._loadDecoderAsync(url);
    assert.equal(transcodes, 0);
    assert.deepEqual(opens, [[url, Infinity]]);
    assert.deepEqual(errors, [failure]);
});

test("audio decoding finishing after pause or close cannot restart playback", async () => {
    for (const destroyed of [false, true]) {
        let finishDecode;
        const player = Object.create(Player.prototype);
        Object.assign(player, {
            _isPlayingState: true, _destroyed: false, _loadToken: 1,
            _currentDecoder: { hasAudio: true, decodeFullAudio: () => new Promise(resolve => { finishDecode = resolve; }) },
            _ensureAudioContext() {},
        });
        const pending = player._startAudioPlayback();
        player._isPlayingState = false;
        player._destroyed = destroyed;
        player._currentDecoder = null;
        finishDecode({});
        await pending;
        assert.equal(player._audioSource, undefined);
        assert.equal(player._fullAudioBuffer, undefined);
    }
});

test("destroyed player cannot resume from delayed play callbacks", () => {
    const player = Object.create(Player.prototype);
    player._destroyed = true;
    player.play();
    assert.notEqual(player._isPlayingState, true);
});

test("closing comparison destroys every registered player immediately", () => {
    const preview = fs.readFileSync(new URL("../web/xzg_video_sync_preview.js", import.meta.url), "utf8")
        .replace(/^import\s[\s\S]*?;\r?\n/gm, "");
    const calls = [];
    const ctx = vm.createContext({
        app: { registerExtension() {} }, window: {},
    });
    vm.runInContext(preview, ctx);
    ctx.instances = [0, 1].map(id => ({ destroy() { calls.push(id); } }));
    ctx.overlay = { remove() { calls.push("removed"); } };
    vm.runInContext("_players = instances; _overlay = overlay; closeSyncPreview(); closeSyncPreview();", ctx);
    assert.deepEqual(calls, [0, 1, "removed"]);
    assert.equal(vm.runInContext("_players.length", ctx), 0);
});

test("comparison audio follows the leftmost video and respects mute", () => {
    const preview = fs.readFileSync(new URL("../web/xzg_video_sync_preview.js", import.meta.url), "utf8")
        .replace(/^import\s[\s\S]*?;\r?\n/gm, "");
    const ctx = vm.createContext({ app: { registerExtension() {} }, window: {} });
    vm.runInContext(preview, ctx);
    const players = [0, 1, 2].map(() => ({ player: { setMuted(value) { this.muted = value; } } }));
    ctx.players = players;
    vm.runInContext("applyCompareAudio(players, _syncMuted)", ctx);
    assert.deepEqual(players.map(p => p.player.muted), [false, true, true]);
    const originalLeft = players[0];
    [players[0], players[1]] = [players[1], players[0]];
    vm.runInContext("applyCompareAudio(players, false)", ctx);
    assert.equal(originalLeft.player.muted, true);
    assert.deepEqual(players.map(p => p.player.muted), [false, true, true]);
    vm.runInContext("applyCompareAudio(players, true)", ctx);
    assert.ok(players.every(p => p.player.muted));
    vm.runInContext("applyCompareAudio(players, false)", ctx);
    assert.deepEqual(players.map(p => p.player.muted), [false, true, true]);
});

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

test("comparison caches the interval once and reuses frames after pause and seek", async () => {
    context.document = {createElement: () => ({getContext: () => ({drawImage() {}})})};
    let decodes = 0;
    let stops = 0;
    const player = Object.create(Player.prototype);
    Object.assign(player, {
        _frameRate: 24, _skipFrames: 0, _loadToken: 1, _currentTime: 0,
        _computeEndFrame: () => 3,
        _currentDecoder: {width: 100, height: 100,
            createPlaybackIterator() {
                decodes++;
                let i = 0;
                return {next: async () => i < 3 ? {value: {canvas: {width: 100, height: 100}, timestamp: i++ / 24}} : {done: true}};
            },
            stopPlaybackIterator() {stops++;},
        },
    });
    await player.prepareComparisonCache();
    assert.equal(player._comparisonFrames.length, 3);
    assert.equal(player._comparisonFrames[0].canvas.width, 100);
    assert.equal(player._comparisonFrames[0].canvas.height, 100);
    assert.equal(stops, 1);
    player._isPlayingState = true;
    player._playbackIterator = player._createPlaybackIterator(0);
    await player._fillPlaybackBuffer();
    assert.equal(player._playbackBuffer.length, 3);
    player._stopPlaybackLoop();
    player._currentTime = 1 / 24;
    player._playbackIterator = player._createPlaybackIterator(1 / 24);
    await player._fillPlaybackBuffer();
    assert.equal(player._playbackBuffer.length, 2);
    assert.equal(decodes, 1, "resume must reuse the completed cache");
});

test("comparison caches the entire 1080p interval at original dimensions", async () => {
    let index = 0;
    const player = Object.create(Player.prototype);
    Object.assign(player, {
        _frameRate: 64, _skipFrames: 0, _loadToken: 1,
        _computeEndFrame: () => 792,
        _currentDecoder: {
            width: 1920, height: 1080,
            createPlaybackIterator() {
                return { next: async () => ({ value: { canvas: { width: 1920, height: 1080 }, timestamp: index++ / 64 }, done: false }) };
            },
            stopPlaybackIterator() {},
        },
    });
    const progress = [];
    await player.prepareComparisonCache(value => progress.push(value));
    assert.equal(player._comparisonCacheReady, true);
    assert.equal(player._comparisonFrames.length, 792);
    assert.ok(player._comparisonFrames.every(({ canvas }) => canvas.width === 1920 && canvas.height === 1080));
    assert.equal(progress.at(-1), 1);
});
