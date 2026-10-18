const PREFIXES = [
    "Comfy.Workflow.Draft.v2:", "Comfy.Workflow.DraftIndex.v2:",
    "Comfy.Workflow.ActivePath:", "Comfy.Workflow.OpenPaths:",
    "Comfy.Workflow.LastActivePath:", "Comfy.Workflow.LastOpenPaths:",
];
export const isWorkflowDraftKey = key => PREFIXES.some(prefix => String(key).startsWith(prefix));

// Preserve ComfyUI's synchronous Storage API with a hydrated mirror, backed by
// IndexedDB rather than localStorage's small quota. Other keys are untouched.
export async function installWorkflowDraftStorage() {
    if (!globalThis.__xzgWorkflowDraftStorageReady) {
        globalThis.__xzgWorkflowDraftStorageReady = initialize();
    }
    return globalThis.__xzgWorkflowDraftStorageReady;
}

async function initialize() {
    const storage = localStorage;
    const prototype = Storage.prototype;
    const original = {
        getItem: prototype.getItem, setItem: prototype.setItem,
        removeItem: prototype.removeItem, key: prototype.key, clear: prototype.clear,
        length: Object.getOwnPropertyDescriptor(prototype, "length"),
    };
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("xzg-workflow-drafts", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("entries");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Workflow draft database is blocked"));
    });
    const cache = await new Promise((resolve, reject) => {
        const entries = new Map();
        const transaction = db.transaction("entries", "readonly");
        const request = transaction.objectStore("entries").openCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (isWorkflowDraftKey(cursor.key)) entries.set(cursor.key, cursor.value);
            cursor.continue();
        };
        transaction.oncomplete = () => resolve(entries);
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
    });
    const physicalKeys = () => {
        const keys = [];
        for (let index = 0; index < original.length.get.call(storage); index++) {
            const key = original.key.call(storage, index);
            if (key !== null) keys.push(key);
        }
        return keys;
    };
    // Never remove the original drafts before their migration commits.
    const migrated = physicalKeys().filter(isWorkflowDraftKey);
    for (const key of migrated) cache.set(key, original.getItem.call(storage, key));
    await new Promise((resolve, reject) => {
        const transaction = db.transaction("entries", "readwrite");
        const store = transaction.objectStore("entries");
        for (const [key, value] of cache) store.put(value, key);
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
    });
    for (const key of migrated) original.removeItem.call(storage, key);

    let pending = new Map();
    let scheduled = false;
    let failure = null;
    const flush = () => {
        scheduled = false;
        if (!pending.size) return;
        const changes = pending;
        pending = new Map();
        try {
            const transaction = db.transaction("entries", "readwrite");
            const store = transaction.objectStore("entries");
            for (const [key, value] of changes) {
                if (value === null) store.delete(key);
                else store.put(value, key);
            }
            transaction.onabort = () => {
                failure = transaction.error || new Error("Workflow draft write aborted");
                console.error("[XZG] Workflow draft commit failed", failure);
            };
        } catch (error) {
            failure = error;
            console.error("[XZG] Workflow draft commit failed", error);
        }
    };
    const persist = (key, value) => {
        if (failure) throw failure;
        pending.set(key, value);
        if (!scheduled) {
            scheduled = true;
            queueMicrotask(flush);
        }
    };
    const keys = () => [...new Set([...physicalKeys(), ...cache.keys()])];
    prototype.getItem = function (key) {
        key = String(key);
        if (this === storage && isWorkflowDraftKey(key)) return cache.get(key) ?? null;
        return original.getItem.call(this, key);
    };
    prototype.setItem = function (key, value) {
        key = String(key);
        value = String(value);
        if (this !== storage || !isWorkflowDraftKey(key)) return original.setItem.call(this, key, value);
        persist(key, value);
        cache.set(key, value);
    };
    prototype.removeItem = function (key) {
        key = String(key);
        if (this !== storage || !isWorkflowDraftKey(key)) return original.removeItem.call(this, key);
        persist(key, null);
        cache.delete(key);
    };
    prototype.key = function (index) {
        return this === storage ? keys()[Number(index) >>> 0] ?? null : original.key.call(this, index);
    };
    Object.defineProperty(prototype, "length", {
        ...original.length,
        get() { return this === storage ? keys().length : original.length.get.call(this); },
    });
    prototype.clear = function () {
        if (this === storage) {
            for (const key of cache.keys()) persist(key, null);
            cache.clear();
        }
        return original.clear.call(this);
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
    });
    return true;
}
