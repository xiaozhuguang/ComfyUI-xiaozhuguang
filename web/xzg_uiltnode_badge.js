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

// 兼容 V0.38+ 内核：右上角角标改由 registerBadgeRowsProvider 提供（直接计算、
// **不读 node.badges**，且把 `#编号` + 生命周期 + 来源 合并成一个角标文本），
// 因此 filterNodeBadges 的"只读空数组拦截"对新通道已失效，来源文案 `uiltnode` 会
// 混在编号里一起冒出来。
// 这里参考小珠光展示任意节点（web/xzg_big_display.js）在调用点
// node.drawBadges(canvas) 做手脚的思路，但**不再整体清空角标**——而是重写为
// 只绘制节点的 `#编号` 徽章（保留工作流正常编号），隐藏派生的来源/生命周期文案；
// 同时继续绘制已过滤的扩展角标（node.badges），保留既有行为。
const ID_BADGE_FONT_SIZE = 12;
const ID_BADGE_PADDING = 6;
const ID_BADGE_HEIGHT = 20;
const ID_BADGE_CORNER = 5;
const ID_BADGE_BG = "#0F1F0F";
const ID_BADGE_FG = "#ffffff";

// 构造一个与 ComfyUI 默认节点角标外观一致的 `#id` 角标（自包含，不依赖内部类）。
function makeIdBadge(idText) {
    return {
        height: ID_BADGE_HEIGHT,
        getWidth(ctx) {
            const saved = ctx.font;
            ctx.font = `${ID_BADGE_FONT_SIZE}px sans-serif`;
            const w = ctx.measureText(idText).width;
            ctx.font = saved;
            return w + ID_BADGE_PADDING * 2;
        },
        draw(ctx, x, y) {
            const saved = {
                font: ctx.font,
                fillStyle: ctx.fillStyle,
                textBaseline: ctx.textBaseline,
                textAlign: ctx.textAlign,
            };
            ctx.font = `${ID_BADGE_FONT_SIZE}px sans-serif`;
            const w = ctx.measureText(idText).width + ID_BADGE_PADDING * 2;
            ctx.fillStyle = ID_BADGE_BG;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x, y, w, ID_BADGE_HEIGHT, ID_BADGE_CORNER);
            else ctx.rect(x, y, w, ID_BADGE_HEIGHT);
            ctx.fill();
            ctx.fillStyle = ID_BADGE_FG;
            ctx.textBaseline = "middle";
            ctx.textAlign = "left";
            ctx.fillText(idText, x + ID_BADGE_PADDING, y + ID_BADGE_HEIGHT / 2 + 1);
            ctx.font = saved.font;
            ctx.fillStyle = saved.fillStyle;
            ctx.textBaseline = saved.textBaseline;
            ctx.textAlign = saved.textAlign;
        },
    };
}

function installIdBadgeDrawing(nodeType) {
    try {
        nodeType.prototype.drawBadges = function (ctx, opts) {
            const idText = "#" + this.id;
            const instances = [makeIdBadge(idText)];
            // 继续绘制扩展角标（node.badges），但跳过同形的 `#id` 徽章以免与手动编号重复。
            for (const badge of this.badges || []) {
                const inst = typeof badge === "function" ? badge() : badge;
                if (!inst || typeof inst.draw !== "function") continue;
                const t = typeof inst.text === "string" ? inst.text.trim() : "";
                if (/^#\d+$/.test(t)) continue;
                instances.push(inst);
            }
            const gap = opts?.gap ?? 2;
            let currentX =
                this.width -
                instances.reduce(
                    (acc, b) => acc + (typeof b.getWidth === "function" ? b.getWidth(ctx) : 0) + gap,
                    0
                );
            const y = -(LiteGraph.NODE_TITLE_HEIGHT + gap);
            for (const badge of instances) {
                const w = typeof badge.getWidth === "function" ? badge.getWidth(ctx) : 0;
                badge.draw(ctx, currentX, y - (badge.height ?? ID_BADGE_HEIGHT));
                currentX += w + gap;
            }
        };
    } catch (_) {
        // 该内核不支持覆盖 drawBadges 时忽略，仍靠旧通道兜底。
    }
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

        // V0.38+ 内核兼容：重写 drawBadges 为只画 `#编号`（保留正常编号），
        // 隐藏派生的来源/生命周期文案。
        installIdBadgeDrawing(nodeType);

        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            if (typeof originalCreated === "function") {
                originalCreated.apply(this, args);
            }
            filterNodeBadges(this);
        };
    },
});
