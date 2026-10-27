import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { installBackgroundFocusGuard } from "./lib/xzg_background_focus.mjs";

app.registerExtension({
    name: "XZG.BackgroundFocusDiagnostics",
    setup() {
        const pending = [];
        const recent = [];
        let timer;
        let lastCall = "";
        let lastTime = 0;
        const flush = async () => {
            timer = null;
            const batch = pending.splice(0, 20);
            try {
                await api.fetchApi("/xzg/focus-diagnostics", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(batch),
                });
            } catch (error) {
                console.warn("[小珠光焦点诊断] 记录发送失败", error);
            }
            if (pending.length && !timer) timer = setTimeout(flush, 500);
        };
        const report = (event, target = "", stack = "") => {
            const key = event + target + stack;
            const now = Date.now();
            if (key === lastCall && now - lastTime < 1000) return;
            lastCall = key;
            lastTime = now;
            const item = { time: new Date().toISOString(), event, target,
                visibility: `${document.visibilityState};focused=${document.hasFocus()}`, stack: String(stack || "").slice(0, 2400) };
            recent.push(item);
            if (recent.length > 200) recent.shift();
            pending.push(item);
            if (pending.length > 100) pending.shift();
            if (!timer) timer = setTimeout(flush, 500);
            if (event.startsWith("blocked-")) console.warn("[小珠光焦点诊断] 已阻止后台主动聚焦", item);
        };
        window.xzgFocusDiagnostics = recent;
        installBackgroundFocusGuard(window, document, report);
        window.addEventListener("focus", () => report("window-focus"));
        window.addEventListener("blur", () => report("window-blur"));
        document.addEventListener("visibilitychange", () => report("visibilitychange"));
        for (const event of ["execution_start", "execution_success", "execution_error", "execution_interrupted"]) {
            api.addEventListener(event, () => report(event));
        }
    },
});
