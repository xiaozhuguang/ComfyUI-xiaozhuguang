export function installBackgroundFocusGuard(win, doc, report) {
    const originalElementFocus = win.HTMLElement.prototype.focus;
    const originalWindowFocus = win.focus;
    let trustedInput = false;
    const allowUserInput = event => {
        if (!event.isTrusted) return;
        trustedInput = true;
        queueMicrotask(() => { trustedInput = false; });
    };
    doc.addEventListener("pointerdown", allowUserInput, true);
    doc.addEventListener("keydown", allowUserInput, true);
    const background = () => !doc.hasFocus() && !trustedInput;
    win.HTMLElement.prototype.focus = function (...args) {
        if (background()) {
            report("blocked-element-focus", `${this.tagName || ""}#${this.id || ""}.${String(this.className || "").slice(0, 160)}`, new Error().stack);
            return;
        }
        return originalElementFocus.apply(this, args);
    };
    win.focus = function (...args) {
        if (background()) {
            report("blocked-window-focus", "window", new Error().stack);
            return;
        }
        return originalWindowFocus.apply(this, args);
    };
}
