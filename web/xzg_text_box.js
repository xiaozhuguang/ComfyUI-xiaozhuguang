import { app } from "../../scripts/app.js";

// ═══════════════════════════════════════════════
//  小珠光文本框 / Xiaozhuguang Text Box
//  修复：鼠标悬停在文本框上时滚轮失效
//    原因：原生 multiline textarea 在内容不长（无滚动条）时
//          会吞掉 wheel 事件，既不滚动文本也不缩放画布
//    方案：全局 capture 阶段监听 wheel 事件，
//          当目标 textarea 不可滚动时（scrollHeight <= clientHeight），
//          转发给画布做缩放
//  增强：缩小 placeholder 占位说明字体大小
//    方案：给小珠光文本框的 textarea 加 class，CSS 缩小 placeholder 字体
// ═══════════════════════════════════════════════

// 注入 CSS：缩小小珠光文本框 placeholder 字体
(function () {
    const cssId = "xzg-text-box-placeholder-css";
    if (document.getElementById(cssId)) return;
    const s = document.createElement("style");
    s.id = cssId;
    s.textContent = `
textarea.xzg-text-box::placeholder {
    font-size: 14px;
    line-height: 1.5;
    opacity: 0.55;
}`;
    document.head.appendChild(s);
})();

// 全局 capture：textarea 不可滚动时把 wheel 转发给画布缩放
(function () {
    if (window.__xzg_textarea_wheel_fixed) return;
    window.__xzg_textarea_wheel_fixed = true;

    window.addEventListener("wheel", (e) => {
        const el = e.target;
        if (!el || el.tagName !== "TEXTAREA") return;
        // textarea 自身可滚动时，让它自己处理（滚动文本）
        if (el.scrollHeight > el.clientHeight + 1) return;
        // 无可滚动内容时，转发给画布做缩放
        const cv = app.canvas?.canvas;
        if (!cv) return;
        e.preventDefault();
        e.stopPropagation();
        cv.dispatchEvent(new WheelEvent("wheel", {
            deltaY: e.deltaY,
            deltaX: e.deltaX,
            clientX: e.clientX,
            clientY: e.clientY,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            bubbles: true,
            cancelable: true,
        }));
    }, { capture: true, passive: false });
})();

// 节点级：给小珠光文本框的 textarea 加标识 class（用于 placeholder 样式）
app.registerExtension({
    name: "ComfyUI.xiaozhuguang.text_box_ta",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "XiaozhuguangTextBox") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origOnNodeCreated) origOnNodeCreated.apply(this, arguments);

            const node = this;
            const tag = (ta) => {
                if (!ta || ta._xzgTagged) return;
                ta._xzgTagged = true;
                ta.classList.add("xzg-text-box");
            };

            const tryAttach = () => {
                const wid = node.id;
                const selectors = [
                    `textarea[data-node-id="${wid}"]`,
                    `textarea[node-id="${wid}"]`,
                    `[data-node-id="${wid}"] textarea`,
                ];
                for (const sel of selectors) {
                    const ta = document.querySelector(sel);
                    if (ta) { tag(ta); return true; }
                }
                const root = node.domElement || node.element || null;
                if (root) {
                    const ta = root.querySelector("textarea");
                    if (ta) { tag(ta); return true; }
                }
                return false;
            };

            if (!tryAttach()) {
                const obs = new MutationObserver(() => {
                    if (tryAttach()) obs.disconnect();
                });
                obs.observe(document.body, { childList: true, subtree: true });
                setTimeout(() => obs.disconnect(), 30000);
            }
        };
    },
});
