import { cloudLoad, cloudSave } from "./xzg_cloud_store.js";

export const DISPLAY_HISTORY_KEY = "xzg_big_display_history";
export const DISPLAY_HISTORY_LIMIT = 200;

export function normalizeDisplayState(value = {}) {
    const texts = items => Array.isArray(items) ? items.map(item => String(item ?? "")) : [];
    const channels = value.channels;
    return {
        texts: texts(value.texts),
        channels: Array.isArray(channels?.texts) && Array.isArray(channels?.connected) ? {
            texts: [texts(channels.texts[0]), texts(channels.texts[1])],
            connected: [!!channels.connected[0], !!channels.connected[1]],
        } : null,
        channel: value.channel === 1 ? 1 : 0,
    };
}

let entries = [];
const ready = cloudLoad(DISPLAY_HISTORY_KEY, { fallbackValue: [] }).then(data => {
    entries = Array.isArray(data) ? data.filter(e => e && typeof e === "object")
        .slice(0, DISPLAY_HISTORY_LIMIT).map(e => ({ ...e, state: normalizeDisplayState(e.state) })) : [];
});
let pending = ready;
export async function getDisplayHistory() {
    await pending;
    return JSON.parse(JSON.stringify(entries));
}
export function addDisplayHistory(node) {
    // Capture before awaiting storage: another execution may already have replaced the node content.
    const state = normalizeDisplayState({ texts: node._texts, channels: node._xzgDisplayChannels, channel: node._xzgDisplayChannel });
    if (![...state.texts, ...(state.channels?.texts.flat() || [])].some(t => t.trim())) return pending;
    const entry = { time: Date.now(), title: node.title || "", nodeId: String(node.id), state };
    pending = pending.then(async () => {
        const previous = entries[0];
        if (previous?.nodeId === entry.nodeId && previous?.title === entry.title &&
            JSON.stringify(previous.state) === JSON.stringify(state)) return;
        entries = [entry, ...entries].slice(0, DISPLAY_HISTORY_LIMIT);
        await cloudSave(DISPLAY_HISTORY_KEY, entries);
    });
    return pending;
}
