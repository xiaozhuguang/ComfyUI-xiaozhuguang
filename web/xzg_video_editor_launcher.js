/**
 * 小珠光 · 快剪 — 菜单栏启动器
 *
 * 将视频编辑器从加载器节点中完全独立出来，通过 ComfyUI 顶部菜单栏按钮触发。
 * 按钮注入方式参考 xzg_viewport_lock.js（DOM 注入 app.menu.element 或回退选择器）。
 *
 * 两套系统各自独立：
 *   - 视频加载器节点：只负责加载视频给下游
 *   - 快剪编辑器：独立全屏弹窗，渲染产物保存到 input/ 或 output/
 */
import { app } from "../../scripts/app.js";
import { XiaozhuguangVideoEditor } from "./xzg_video_editor.js";

const BTN_ID = "xzg-quick-edit-btn";
const GOLD = "#dcc85b";

let _editorInstance = null;

function findMenuContainer() {
    if (app.menu?.element) return app.menu.element;
    const selectors = [
        ".comfyui-menu-right", ".comfyui-menu", ".comfy-menu",
        ".p-toolbar", ".top-menubar-container", ".actionbar-container",
        "[class*='menubar']", "[class*='menu-bar']",
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
    }
    return null;
}

function buildButton() {
    const btn = document.createElement("div");
    btn.id = BTN_ID;
    btn.style.cssText = `
        display:flex; align-items:center; justify-content:center; gap:4px;
        height:32px; padding:0 10px; cursor:pointer;
        color:${GOLD}; font-size:20px; font-weight:600;
        border-radius:6px; user-select:none;
        transition:background 0.15s; position:relative;
        align-self:center; margin:auto 0;
        background:transparent;
    `;
    btn.innerHTML = `<span style="font-size:18px;">🎬</span><span>快剪</span>`;
    btn.addEventListener("mouseenter", () => {
        btn.style.background = "var(--comfy-input-bg,#353535)";
    });
    btn.addEventListener("mouseleave", () => {
        btn.style.background = "transparent";
    });
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openEditor();
    });
    return btn;
}

function openEditor(options = {}) {
    // 单例：已打开则不重复创建
    if (_editorInstance && !_editorInstance._destroyed) {
        // 切换打开来源：更新回调 / 模式过滤（无参=菜单独立打开，恢复完整 UI）
        _editorInstance._confirmCallback =
            typeof options.confirmCallback === "function" ? options.confirmCallback : null;
        _editorInstance._confirmCallbackCalled = false;
        _editorInstance._modeFilter =
            (options.modeFilter === "audio" || options.modeFilter === "video") ? options.modeFilter : null;
        _editorInstance._applyModeFilter?.();
        return _editorInstance;
    }
    _editorInstance = new XiaozhuguangVideoEditor(options);
    _editorInstance.open();
    return _editorInstance;
}

// 暴露到 window 供视频加载器等外部调用
window._xzgOpenVideoEditor = openEditor;

function tryInject(retries) {
    const container = findMenuContainer();
    if (container) {
        if (document.getElementById(BTN_ID)) return; // 已注入
        const btn = buildButton();
        container.appendChild(btn);
        return;
    }
    if (retries < 20) {
        setTimeout(() => tryInject(retries + 1), 300);
    }
}

function waitForApp() {
    if (app.canvas) {
        tryInject(0);
        return;
    }
    setTimeout(waitForApp, 200);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForApp);
} else {
    waitForApp();
}
