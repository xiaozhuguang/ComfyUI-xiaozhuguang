import { app } from "../../scripts/app.js";

// 小珠光插件共享双语（中/英）支持。
// 用法：把 UI 里的中文串改为 xzgT("中文", "English")。
//   检测到 ComfyUI 界面为英文时返回英文，否则返回中文。
// 检测失败时回退中文（作者母语，保证中文用户始终有可读文案）。

export function xzgLang() {
    let v = "";
    // 1. ComfyUI 设置存储的当前语言（最权威，且本版本 getSettingValue 对英文用户返回空）
    try { v = app?.ui?.settings?.settingsLookup?.["Comfy.Locale"]?.value || ""; } catch (e) {}
    // 2. 退化路径：部分版本用 getSettingValue
    if (!v) { try { v = app?.ui?.settings?.getSettingValue?.("Comfy.Locale") || ""; } catch (e) {} }
    // 3. 退化路径：ComfyUI 会把当前语言写到 <html lang>
    if (!v) { try { v = document.documentElement.lang || ""; } catch (e) {} }
    v = String(v || "").toLowerCase();
    if (v.startsWith("zh")) return "zh";
    if (v) return "en";
    return "zh";
}

export function xzgT(zh, en) {
    if (xzgLang() === "en") return en != null ? en : zh;
    return zh;
}

// 在 HTML 模板字符串里用的版本：用 ${xzgTh("中文","English")} 包裹。
export const xzgTh = xzgT;
