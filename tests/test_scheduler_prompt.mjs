import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { prepareSchedulerPrompt, useSchedulerCache, prepareMergePrompt } from "../web/lib/xzg_scheduler_prompt.mjs";

const source = fs.readFileSync(new URL("../web/xzg_video_batch.js", import.meta.url), "utf8");
const start = source.indexOf("function filterPromptOutput(");
const end = source.indexOf("\n}", start) + 2;
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const prune = context.filterPromptOutput;

test("preparation keeps actual image/audio/fps/mask input dependencies", () => {
    const prompt = {output: {
        161: {inputs: {}},
        158: {inputs: {图像: ["161", 0], 音频: ["161", 1], 帧率: ["161", 2], 遮罩: ["161", 3]}},
        133: {inputs: {图像: ["158", 0]}},
    }};
    prune(prompt, new Set(["158"]));
    prepareSchedulerPrompt(prompt, 158, "batch-a");
    assert.deepEqual(Object.keys(prompt.output).sort(), ["158", "161"]);
    assert.deepEqual(prompt.output[158].inputs.图像, ["161", 0]);
    assert.equal(prompt.output[158].inputs.当前段, 1000000);
    assert.equal(prompt.output[158].inputs.缓存批次, "batch-a");
});

test("segment submission uses cache and removes the upstream execution branch", () => {
    const prompt = {output: {
        161: {inputs: {}},
        158: {inputs: {图像: ["161", 0], 音频: ["161", 1], 帧率: ["161", 2], 遮罩: ["161", 3], 当前段: 1}},
        133: {inputs: {图像: ["158", 0]}},
    }};
    useSchedulerCache(prompt, 158, "batch-a");
    prune(prompt, new Set(["133"]));
    assert.deepEqual(Object.keys(prompt.output).sort(), ["133", "158"]);
    assert.deepEqual(prompt.output[158].inputs, {当前段: 1, 缓存批次: "batch-a"});
    assert.throws(() => useSchedulerCache(prompt, 158, ""));
});

test("final save takes processed fps from merge without rerunning interpolation", () => {
    const prompt = {output: {
        161: {inputs: {}},
        158: {inputs: {图像: ["161", 0]}},
        123: {inputs: {images: ["158", 0]}},
        133: {inputs: {图像: ["123", 0], 帧率: ["123", 1], 执行合并: false}},
        117: {inputs: {图像: ["133", 0], 帧率: ["123", 1], 音频: ["161", 1]}},
    }};
    const downstream = new Set(["133", "117"]);
    prepareMergePrompt(prompt, 133, downstream);
    prune(prompt, downstream);
    assert.deepEqual(Object.keys(prompt.output).sort(), ["117", "133", "161"]);
    assert.deepEqual(prompt.output[117].inputs.帧率, ["133", 2]);
    assert.deepEqual(prompt.output[117].inputs.音频, ["161", 1]);
    assert.deepEqual(prompt.output[133].inputs, {执行合并: true});
});

test("merge rewiring preserves independent fps sources and merge audio", () => {
    const prompt = {output: {
        90: {inputs: {value: 24}},
        123: {inputs: {}},
        133: {inputs: {图像: ["123", 0], 帧率: ["123", 1]}},
        117: {inputs: {图像: ["133", 0], 音频: ["133", 1], 帧率: ["90", 0]}},
    }};
    const downstream = new Set(["133", "117"]);
    prepareMergePrompt(prompt, 133, downstream);
    prune(prompt, downstream);
    assert.deepEqual(Object.keys(prompt.output).sort(), ["117", "133", "90"]);
    assert.deepEqual(prompt.output[117].inputs.音频, ["133", 1]);
    assert.deepEqual(prompt.output[117].inputs.帧率, ["90", 0]);
});
