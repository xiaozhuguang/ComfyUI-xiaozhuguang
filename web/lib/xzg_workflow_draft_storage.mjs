const METADATA_PREFIXES = [
    "Comfy.Workflow.DraftIndex.v2:",
    "Comfy.Workflow.ActivePath:", "Comfy.Workflow.OpenPaths:",
    "Comfy.Workflow.LastActivePath:", "Comfy.Workflow.LastOpenPaths:",
];
export const isWorkflowDraftKey = key => String(key).startsWith("Comfy.Workflow.Draft.v2:");
const PAYLOAD_MARKER = '{"__xzgIndexedDBDraft":true}';
const INLINE_LIMIT = 64 * 1024;
const isDraftMetadataKey = key => METADATA_PREFIXES.some(prefix => String(key).startsWith(prefix));

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
            if (isWorkflowDraftKey(cursor.key) || isDraftMetadataKey(cursor.key)) entries.set(cursor.key, cursor.value);
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
    // The frontend reads/migrates the index before extension initialization.
    // Keep metadata synchronous even before this IndexedDB mirror is hydrated.
    for (const [key, value] of cache) {
        if (!isDraftMetadataKey(key)) continue;
        const physical = original.getItem.call(storage, key);
        let restore = physical === null;
        if (!restore && key.startsWith("Comfy.Workflow.DraftIndex.v2:")) {
            try {
                const current = JSON.parse(physical);
                const previous = JSON.parse(value);
                restore = !current.order?.length && previous.order?.length > 0;
            } catch {}
        }
        if (restore) {
            original.setItem.call(storage, key, value);
            // The frontend may already have cached an empty index before
            // extensions load. Restart once after recovering legacy metadata.
            globalThis.__xzgWorkflowDraftStorageNeedsReload = true;
        }
        cache.delete(key);
    }
    // Never remove the original drafts before their migration commits.
    const migrated = physicalKeys().filter(isWorkflowDraftKey);
    for (const key of migrated) {
        const value = original.getItem.call(storage, key);
        if (value !== PAYLOAD_MARKER) cache.set(key, value);
    }
    await new Promise((resolve, reject) => {
        const transaction = db.transaction("entries", "readwrite");
        const store = transaction.objectStore("entries");
        for (const [key, value] of cache) store.put(value, key);
        for (const key of physicalKeys().filter(isDraftMetadataKey)) store.delete(key);
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
    });
    const mirrorPayload = (key, value) => {
        // Startup orphan cleanup runs before extensions load. Keep a physical
        // key so it does not prune IndexedDB-backed drafts from its index.
        if (value === null) original.removeItem.call(storage, key);
        else {
            try {
                original.setItem.call(storage, key, value.length <= INLINE_LIMIT ? value : PAYLOAD_MARKER);
            } catch (error) {
                if (error.name !== "QuotaExceededError") throw error;
                original.setItem.call(storage, key, PAYLOAD_MARKER);
            }
        }
    };
    for (const [key, value] of cache) mirrorPayload(key, value);

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
        mirrorPayload(key, value);
        persist(key, value);
        cache.set(key, value);
    };
    prototype.removeItem = function (key) {
        key = String(key);
        if (this !== storage || !isWorkflowDraftKey(key)) return original.removeItem.call(this, key);
        mirrorPayload(key, null);
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
