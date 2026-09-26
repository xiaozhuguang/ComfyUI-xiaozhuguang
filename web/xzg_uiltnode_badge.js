import { app } from "../../scripts/app.js";

// The encrypted workflow wrapper is registered by the backend under a dynamic
// internal type. Match its display name instead of trying to instantiate it.
const DISPLAY_NAME = "uiltnode";
const BADGE_FILTER_MARK = "__xzgUiltnodeBadgeFilter";

function hideSourceName(badge) {
    if (!badge || typeof badge !== "object" || badge[BADGE_FILTER_MARK]) return badge;

    let descriptor = Object.getOwnPropertyDescriptor(badge, "text");
    for (let proto = Object.getPrototypeOf(badge); !descriptor && proto; proto = Object.getPrototypeOf(proto)) {
        descriptor = Object.getOwnPropertyDescriptor(proto, "text");
    }
    let storedText = typeof badge.text === "string" ? badge.text : "";
    const readText = descriptor?.get
        ? () => descriptor.get.call(badge)
        : () => storedText;
    const writeText = descriptor?.set
        ? (value) => descriptor.set.call(badge, value)
        : (value) => { storedText = value; };

    try {
        Object.defineProperty(badge, "text", {
            configurable: true,
            enumerable: descriptor?.enumerable ?? true,
            get() {
                const text = readText();
                return typeof text === "string"
                    ? text.replace(/[ \t\r\n]*xiaozhuguang([^a-zA-Z0-9_]|$)/ig, "$1").replace(/ {2,}/g, " ").trim()
                    : text;
            },
            set(value) {
                writeText(value);
            },
        });
        Object.defineProperty(badge, BADGE_FILTER_MARK, { value: true });
    } catch (_) {
        // Some frontend versions expose immutable badge objects; leave those intact.
    }
    return badge;
}

function wrapBadgeEntry(entry) {
    if (typeof entry === "function") {
        if (entry[BADGE_FILTER_MARK]) return entry;
        const wrapped = function (...args) {
            return hideSourceName(entry.apply(this, args));
        };
        try { Object.defineProperty(wrapped, BADGE_FILTER_MARK, { value: true }); } catch (_) {}
        return wrapped;
    }
    return hideSourceName(entry);
}

function filterNodeBadges(node) {
    if (!node || node.__xzgUiltnodeBadgeArray) return;

    let badges = [];
    const setBadges = (value) => {
        badges = Array.isArray(value) ? value : [];
        for (let i = 0; i < badges.length; i++) badges[i] = wrapBadgeEntry(badges[i]);
        if (!badges.__xzgUiltnodePushWrapped) {
            const push = badges.push;
            Object.defineProperty(badges, "push", {
                configurable: true,
                writable: true,
                value(...entries) {
                    return push.apply(this, entries.map(wrapBadgeEntry));
                },
            });
            Object.defineProperty(badges, "__xzgUiltnodePushWrapped", { value: true });
        }
    };

    try {
        setBadges(node.badges);
        Object.defineProperty(node, "badges", {
            configurable: true,
            enumerable: true,
            get: () => badges,
            set: setBadges,
        });
        node.__xzgUiltnodeBadgeArray = true;
    } catch (_) {
        // Keep node behavior untouched if this ComfyUI build locks the property.
    }
}

app.registerExtension({
    name: "ComfyUI.xiaozhuguang.uiltnode_badge",

    beforeRegisterNodeDef(nodeType, nodeData) {
        const displayName = String(nodeData?.display_name || "").trim();
        if (displayName !== DISPLAY_NAME && nodeData?.name !== DISPLAY_NAME) return;

        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            if (typeof originalCreated === "function") {
                originalCreated.apply(this, args);
            }
            filterNodeBadges(this);
        };
    },
});
