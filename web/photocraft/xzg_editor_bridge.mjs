const PREFS_KEY = "photocraft.preferences";
const EXPORT_COMMAND = "file.export.quickExportAsPng";
const EXPORT_KEY = "Alt+Shift+F12";
const HIDDEN_HELP = new Set([
    "help.about", "help.artcraftWebsite", "help.checkForUpdates", "help.discord",
    "help.github", "help.reportIssue", "help.systemInfo", "help.website",
]);
// 图片编辑不提供文字相关功能：隐去文字类工具、文字菜单项和文字工具快捷键。
const HIDDEN_TEXT_TOOLS = ["Type", "VerticalType", "HorizontalTypeMask", "VerticalTypeMask"];
const HIDDEN_TEXT_SHORTCUTS = [
    "tools.select.typeT", "tools.select.verticalType",
    "tools.select.horizontalTypeMask", "tools.select.verticalTypeMask",
];
const HIDDEN_TEXT_MENUS = new Set([
    // Type 菜单：面板与文字属性
    "type.panels.character", "type.panels.paragraph", "type.panels.glyphs",
    "type.panels.characterStyles", "type.panels.paragraphStyles",
    "type.antiAlias.none", "type.antiAlias.sharp", "type.antiAlias.crisp",
    "type.antiAlias.strong", "type.antiAlias.smooth", "type.antiAlias.windowsLcd",
    "type.antiAlias.windows",
    "type.orientation.horizontal", "type.orientation.vertical",
    "type.openType.oldstyle", "type.openType.ornaments",
    "type.openType.numerals.default", "type.openType.numerals.lining",
    "type.openType.numerals.oldstyle", "type.openType.numerals.proportional",
    "type.openType.numerals.tabular", "type.openType.numerals.proportionalLining",
    "type.openType.numerals.tabularLining", "type.openType.numerals.proportionalOldstyle",
    "type.openType.numerals.tabularOldstyle",
    "type.openType.standardLigatures", "type.openType.contextualAlternates",
    "type.openType.discretionaryLigatures", "type.openType.swash",
    "type.openType.stylisticAlternates", "type.openType.titlingAlternates",
    "type.openType.ordinals", "type.openType.fractions",
    ...Array.from({ length: 20 }, (_, i) => `type.openType.stylisticSets.set${i + 1}`),
    // Type 菜单：文字图层命令
    "type.createWorkPath", "type.convertToShape", "type.rasterizeTypeLayer",
    "type.convertToParagraphText", "type.convertToPointText", "type.warpText",
    "type.fontPreviewSize.small", "type.fontPreviewSize.medium", "type.fontPreviewSize.large",
    "type.fontPreviewSize.extraLarge", "type.fontPreviewSize.huge",
    "type.languageOptions.defaultFeatures", "type.languageOptions.eastAsianFeatures",
    "type.languageOptions.middleEasternFeatures",
    "type.languageOptions.middleEasternAndSouthAsianComposer",
    "type.updateAllTextLayers", "type.replaceAllMissingFonts", "type.resolveMissingFonts",
    "type.pasteLoremIpsum", "type.loadDefaultTypeStyles", "type.saveDefaultTypeStyles",
    // Edit / Layer / Window 菜单里的文字相关项
    "edit.checkSpelling", "edit.findAndReplaceText", "layer.rasterize.type",
    "window.panel.character", "window.panel.characterStyles", "window.panel.glyphs",
    "window.panel.paragraph", "window.panel.paragraphStyles",
]);

export function installEditorBridge(canvas) {
    // PhotoCraft v0.23.1 reads this JSON before installing its command shortcuts.
    // Keep the integration shortcut out of the user's saved preferences.
    const language = new URLSearchParams(location.search).get("xzgLang");
    const { getItem, setItem } = Storage.prototype;
    Storage.prototype.getItem = function (key) {
        const value = getItem.call(this, key);
        if (key !== PREFS_KEY || this !== localStorage) return value;
        let prefs;
        try {
            prefs = JSON.parse(value) || {};
        } catch {
            prefs = {};
        }
        prefs.interface ??= {};
        if (!prefs.interface.language || prefs.interface.language === "auto") {
            prefs.interface.language = language === "zh-hans" ? "zh-hans" : "en";
        }
        prefs.general ??= {};
        prefs.general.autoShowHomeScreen = false;
        prefs.alternateShortcuts ??= {};
        const keys = prefs.alternateShortcuts[EXPORT_COMMAND] ?? [];
        prefs.alternateShortcuts[EXPORT_COMMAND] = [...new Set([EXPORT_KEY, ...keys])].slice(0, 8);
        prefs.menus ??= {};
        prefs.menus.hidden = [...new Set([...(prefs.menus.hidden ?? []), ...HIDDEN_HELP, ...HIDDEN_TEXT_MENUS])];
        prefs.toolbar ??= {};
        prefs.toolbar.hidden = [...new Set([...(prefs.toolbar.hidden ?? []), ...HIDDEN_TEXT_TOOLS])];
        prefs.shortcuts ??= {};
        for (const id of HIDDEN_TEXT_SHORTCUTS) prefs.shortcuts[id] = "";
        prefs.alternateShortcuts ??= {};
        for (const id of HIDDEN_TEXT_SHORTCUTS) prefs.alternateShortcuts[id] = [];
        return JSON.stringify(prefs);
    };
    Storage.prototype.setItem = function (key, value) {
        if (key === PREFS_KEY && this === localStorage) {
            const prefs = JSON.parse(value);
            const shortcuts = prefs.alternateShortcuts;
            if (shortcuts?.[EXPORT_COMMAND]?.includes(EXPORT_KEY)) {
                const keys = shortcuts[EXPORT_COMMAND].filter(key => key !== EXPORT_KEY);
                if (keys.length) shortcuts[EXPORT_COMMAND] = keys;
                else delete shortcuts[EXPORT_COMMAND];
            }
            if (prefs.menus?.hidden) {
                prefs.menus.hidden = prefs.menus.hidden.filter(id => !HIDDEN_HELP.has(id) && !HIDDEN_TEXT_MENUS.has(id));
            }
            if (prefs.toolbar?.hidden) {
                prefs.toolbar.hidden = prefs.toolbar.hidden.filter(name => !HIDDEN_TEXT_TOOLS.includes(name));
            }
            if (prefs.shortcuts) {
                for (const id of HIDDEN_TEXT_SHORTCUTS) {
                    if (prefs.shortcuts[id] === "") delete prefs.shortcuts[id];
                }
            }
            if (prefs.alternateShortcuts) {
                for (const id of HIDDEN_TEXT_SHORTCUTS) {
                    if (prefs.alternateShortcuts[id]?.length === 0) delete prefs.alternateShortcuts[id];
                }
            }
            value = JSON.stringify(prefs);
        }
        return setItem.call(this, key, value);
    };

    const open = window.open;
    window.open = (target, ...args) => {
        const url = URL.canParse(target, document.baseURI) ? new URL(target, document.baseURI) : null;
        if (url) {
            if (/(^|\.)getartcraft\.com$/i.test(url.hostname) ||
                (url.hostname === "github.com" && /^\/storytold\/photocraft(?:\/|$)/i.test(url.pathname)) ||
                (url.hostname === "discord.gg" && /^\/artcraft\/?$/i.test(url.pathname))) return null;
        }
        return open.call(window, target, ...args);
    };

    const exportImage = () => {
        canvas.focus();
        const key = { key: "F12", code: "F12", altKey: true, shiftKey: true, bubbles: true, cancelable: true };
        canvas.dispatchEvent(new KeyboardEvent("keydown", key));
        canvas.dispatchEvent(new KeyboardEvent("keyup", key));
    };
    window.xzgExportImage = exportImage;
    // A loader page opened before the rename can still call the previous name.
    window.xzgPhotoCraftExport = exportImage;
}
