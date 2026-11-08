import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../web/xzg_workflows.js", import.meta.url), "utf8");
const start = source.indexOf("    async _loadWorkflowCore(");
const end = source.indexOf("    centerCanvasOnNodes()", start);

for (const exactMatch of [false, true]) {
    test(`workflow loading ignores same-name trash and other folders (exact match: ${exactMatch})`, async () => {
        const path = "人物替换";
        const officialPath = `workflows/${path}.json`;
        const data = { nodes: [], extra: { ds: {} } };
        const loaded = [];
        const fetched = [];
        const errors = [];
        const wrong = p => ({
            path: p, filename: path, name: path,
            load() { throw new Error("Loaded wrong workflow"); },
        });
        const exact = { path: officialPath, isLoaded: true, content: JSON.stringify(data) };
        const context = vm.createContext({
            app: {
                extensionManager: { workflow: {
                    openWorkflow() {}, getWorkflowByPath() {}, async loadWorkflows() {},
                    workflows: [wrong(`workflows/__trash/20261106__${path}.json/${path}.json`),
                        wrong(`workflows/其他分类/${path}.json`), ...(exactMatch ? [exact] : [])],
                } },
                async loadGraphData(...args) { loaded.push(args); },
            },
            api: { async fetchApi(url) { fetched.push(url); return { ok: true, async json() { return data; } }; } },
            setTimeout: callback => callback(), console, alert: error => errors.push(error),
            xzgT: zh => zh,
        });
        const manager = vm.runInContext(`new (class { ${source.slice(start, end)} })()`, context);
        manager._loadGen = 2;
        await manager._loadWorkflowCore(path, 1);
        assert.deepEqual(errors, []);
        assert.equal(loaded.length, 1);
        assert.equal(loaded[0][3], exactMatch ? exact : `${path}.json`);
        assert.deepEqual(fetched, exactMatch ? [] : [`/xzg/workflows/${encodeURIComponent(path)}`]);
    });
}
