import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

function load(file, context) {
    const source = fs.readFileSync(new URL(`../web/${file}`, import.meta.url), "utf8")
        .replace(/^import\s[\s\S]*?;\r?\n/gm, "")
        .replace(/^export /gm, "");
    vm.runInContext(source, context);
}

test("copy action uses the shared endpoint, original files and custom output token", async () => {
    const calls = [], toasts = [];
    const context = vm.createContext({
        xzgT: zh => zh,
        app: { extensionManager: { toast: { add: item => toasts.push(item) } } },
        api: { fetchApi: async (url, options) => {
            calls.push([url, JSON.parse(options.body)]);
            return { ok: true, json: async () => ({ ok: true, copied: true }) };
        } },
    });
    load("xzg_codex_upload.js", context);
    context.button = { disabled: false };
    await vm.runInContext('xzgCopyFiles(["测试 原视频.mp4 [output]"], "video", button, "saved-token")', context);
    assert.equal(calls[0][0], "/xzg/clipboard/files");
    assert.deepEqual(calls[0][1], { filenames: ["测试 原视频.mp4 [output]"], kind: "video", abs_token: "saved-token" });
    assert.equal(toasts[0].life, 2000);
    assert.equal(toasts[0].severity, "info");
    assert.equal(context.button.disabled, false);
    await vm.runInContext('xzgAddToDoubao(["a.png", "b.png"], "image", button)', context);
    assert.equal(calls[1][0], "/xzg/clipboard/files");
    assert.deepEqual(calls[1][1].filenames, ["a.png", "b.png"]);
});

test("legacy button visibility and ordering merge into one clipboard action", () => {
    const context = vm.createContext({});
    load("xzg_loader_settings.js", context);
    context.node = { properties: {
        xzg_preview_buttons: { codex: false, doubao: true },
        xzg_preview_button_colors: { codex: "#abcdef" },
        xzg_preview_button_order: ["doubao", "codex", "other"],
    } };
    assert.equal(vm.runInContext('xzgPreviewButtonVisible(node, "clipboard")', context), true);
    assert.equal(context.node.properties.xzg_preview_button_colors.clipboard, "#abcdef");
    assert.deepEqual(Array.from(context.node.properties.xzg_preview_button_order), ["clipboard", "other"]);
    context.node = { properties: { xzg_preview_buttons: { codex: false, doubao: false } } };
    assert.equal(vm.runInContext('xzgPreviewButtonVisible(node, "clipboard")', context), false);
});
