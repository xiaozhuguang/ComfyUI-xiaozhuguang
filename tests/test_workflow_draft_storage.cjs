const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
    const source = fs.readFileSync(path.join(__dirname, '../web/lib/xzg_workflow_draft_storage.mjs'));
    const server = http.createServer((request, response) => {
        response.setHeader('Content-Type', request.url === '/storage.mjs' ? 'text/javascript' : 'text/html');
        response.end(request.url === '/storage.mjs' ? source : '<!doctype html><title>Draft storage test</title>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const key = 'Comfy.Workflow.Draft.v2:personal:test';
        const result = await page.evaluate(async key => {
            localStorage.setItem('unrelated', 'keep');
            localStorage.setItem(key, 'existing draft');
            sessionStorage.setItem(key, 'session stays separate');
            // Simulate metadata stored by the previous adapter, followed by the
            // frontend's pre-extension migration creating an empty index.
            const legacyKey = 'Comfy.Workflow.DraftIndex.v2:legacy';
            localStorage.setItem(legacyKey, JSON.stringify({ order: [], entries: {} }));
            await new Promise((resolve, reject) => {
                const request = indexedDB.open('xzg-workflow-drafts', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('entries');
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const db = request.result;
                    const tx = db.transaction('entries', 'readwrite');
                    tx.objectStore('entries').put(JSON.stringify({ order: ['old'], entries: { old: { path: 'old' } } }), legacyKey);
                    tx.oncomplete = () => { db.close(); resolve(); };
                    tx.onabort = () => reject(tx.error);
                };
            });
            const { installWorkflowDraftStorage } = await import('/storage.mjs');
            await installWorkflowDraftStorage();
            const migrated = localStorage.getItem(key);
            const legacyRestored = JSON.parse(localStorage.getItem(legacyKey)).order[0] === 'old';
            // Exceeds Chrome's localStorage limit, even without other data.
            localStorage.setItem(key, JSON.stringify({ workflow: 'x'.repeat(8 * 1024 * 1024) }));
            localStorage.setItem('Comfy.Workflow.DraftIndex.v2:personal', '{"v":2}');
            const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
            // Wait behind queued write transactions before simulating refresh.
            await new Promise((resolve, reject) => {
                const open = indexedDB.open('xzg-workflow-drafts', 1);
                open.onsuccess = () => {
                    const db = open.result;
                    const tx = db.transaction('entries', 'readonly');
                    tx.objectStore('entries').get(key);
                    tx.oncomplete = () => { db.close(); resolve(); };
                    tx.onabort = () => reject(tx.error);
                };
                open.onerror = () => reject(open.error);
            });
            return { migrated, legacyRestored, enumerated: keys.includes(key), session: sessionStorage.getItem(key) };
        }, key);
        assert.deepEqual(result, { migrated: 'existing draft', legacyRestored: true, enumerated: true, session: 'session stays separate' });
        await page.reload();
        const restored = await page.evaluate(async key => {
            // ComfyUI reads its index before loading extensions.
            const earlyIndex = localStorage.getItem('Comfy.Workflow.DraftIndex.v2:personal');
            // The real frontend prunes index entries whose payload key is
            // missing, before extensions hydrate the IndexedDB mirror.
            const earlyPayloadExists = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).includes(key);
            if (!earlyPayloadExists) throw new Error('Frontend orphan cleanup would discard this imported temporary workflow');
            const { installWorkflowDraftStorage } = await import('/storage.mjs');
            await installWorkflowDraftStorage();
            const size = JSON.parse(localStorage.getItem(key)).workflow.length;
            const unrelated = localStorage.getItem('unrelated');
            const index = localStorage.getItem('Comfy.Workflow.DraftIndex.v2:personal');
            localStorage.removeItem(key);
            const removed = localStorage.getItem(key) === null;
            const enumerated = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).includes(key);
            return { size, unrelated, index, earlyIndex, removed, enumerated };
        }, key);
        assert.deepEqual(restored, {
            size: 8 * 1024 * 1024, unrelated: 'keep', index: '{"v":2}', earlyIndex: '{"v":2}', removed: true, enumerated: false,
        });
        console.log('PASS: migrate existing draft, save 8 MiB, refresh/restore, enumerate/remove, preserve other storage');
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
