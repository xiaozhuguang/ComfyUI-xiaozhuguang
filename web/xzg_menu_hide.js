
window.XZGMenuHide = {
    config: {
        canvas: {},
        node: {}
    },

    _collectedItems: {
        canvas: [],
        node: []
    },

    _inited: false,
    _enabled: false,
    _canvasOrig: null,
    _nodeOrig: null,
    _contextMenuOrig: null,

    init() {
        if (this._inited) return;
        this._inited = true;
        this.loadConfig();
        this.loadEnabled();
        this.hookMenus();
    },

    loadEnabled() {
        try {
            this._enabled = localStorage.getItem('xzg-menu-hide-enabled') === 'true';
        } catch(e) {}
    },

    setEnabled(enabled) {
        this._enabled = enabled;
        try { localStorage.setItem('xzg-menu-hide-enabled', enabled ? 'true' : 'false'); } catch(e) {}
        this._applyHideToOpenMenus();
    },

    isEnabled() {
        return this._enabled;
    },

    loadConfig() {
        try {
            const saved = localStorage.getItem('xzg-menu-hide');
            if (saved) {
                const data = JSON.parse(saved);
                this.config = Object.assign({ canvas: {}, node: {} }, data);
            }
        } catch(e) {}
    },

    saveConfig() {
        try {
            localStorage.setItem('xzg-menu-hide', JSON.stringify(this.config));
        } catch(e) {}
    },

    isHidden(menuType, content) {
        if (!this._enabled) return false;
        const map = this.config[menuType];
        if (!map) return false;
        const key = this._normalizeKey(content);
        return !!map[key];
    },

    setHidden(menuType, content, hidden) {
        if (!this.config[menuType]) {
            this.config[menuType] = {};
        }
        const key = this._normalizeKey(content);
        if (hidden) {
            this.config[menuType][key] = true;
        } else {
            delete this.config[menuType][key];
        }
        this.saveConfig();
        this._applyHideToOpenMenus();
    },

    resetAll() {
        this.config = { canvas: {}, node: {} };
        this.saveConfig();
        this._applyHideToOpenMenus();
    },

    _applyHideToOpenMenus() {
        const menus = document.querySelectorAll('.litecontextmenu, .context-menu, .litegraph-contextmenu');
        menus.forEach(menu => {
            if (this._enabled) {
                this._hideFromDOM(menu);
            } else {
                const items = menu.querySelectorAll('.litemenu-entry, .context-menu-item, .menu-item, .lite-menu-item');
                items.forEach(item => {
                    item.style.display = '';
                });
                const separators = menu.querySelectorAll('.separator, .litemenu-separator, hr');
                separators.forEach(sep => {
                    sep.style.display = '';
                });
            }
        });
    },

    _normalizeKey(content) {
        if (!content) return '';
        if (typeof content === 'string') {
            return this._cleanText(content).replace(/<[^>]*>/g, '').trim();
        }
        const candidates = ['content', 'title', 'value', 'label', 'text', 'name'];
        for (const prop of candidates) {
            if (content[prop]) {
                return this._cleanText(String(content[prop])).replace(/<[^>]*>/g, '').trim();
            }
        }
        return this._cleanText(String(content)).replace(/<[^>]*>/g, '').trim();
    },

    _cleanText(text) {
        if (!text) return '';
        return String(text)
            .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u2064\uFEFF]/g, '')
            .replace(/\u00A0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    },

    _translationCache: null,
    _translationCacheTime: 0,

    _getTranslationDict() {
        const now = Date.now();
        if (this._translationCache && (now - this._translationCacheTime) < 10000) {
            return this._translationCache;
        }

        const dict = {
            enToCn: {},
            cnToEn: {}
        };

        try {
            if (window.TUtils && window.TUtils.T && window.TUtils.T.Menu) {
                const menuT = window.TUtils.T.Menu;
                for (const en in menuT) {
                    const cn = menuT[en];
                    if (en && cn && typeof en === 'string' && typeof cn === 'string') {
                        const enTrim = en.trim();
                        const cnTrim = cn.trim();
                        if (enTrim && cnTrim) {
                            dict.enToCn[enTrim] = cnTrim;
                            dict.cnToEn[cnTrim] = enTrim;
                        }
                    }
                }
            }
        } catch(e) {}

        try {
            if (window.comfyAPI && window.comfyAPI.i18n) {
                const i18n = window.comfyAPI.i18n;
                let zhCn = null;
                try {
                    if (typeof i18n.getTranslation === 'function') {
                        zhCn = i18n.getTranslation('zh-CN') || i18n.getTranslation('zh') || {};
                    }
                } catch(e) {}
                if (!zhCn) {
                    const translations = i18n.translations || i18n._translations || {};
                    zhCn = translations['zh-CN'] || translations['zh-cn'] || translations['zh'] || {};
                }
                const menuDict = zhCn.Menu || zhCn.menus || (zhCn.nodeDefs ? null : zhCn);
                if (menuDict && typeof menuDict === 'object') {
                    for (const en in menuDict) {
                        const cn = menuDict[en];
                        if (en && cn && typeof en === 'string' && typeof cn === 'string') {
                            const enTrim = en.trim();
                            const cnTrim = cn.trim();
                            if (enTrim && cnTrim) {
                                if (!dict.enToCn[enTrim]) {
                                    dict.enToCn[enTrim] = cnTrim;
                                }
                                if (!dict.cnToEn[cnTrim]) {
                                    dict.cnToEn[cnTrim] = enTrim;
                                }
                            }
                        }
                    }
                }
                const nodeDefs = zhCn.nodeDefs || zhCn.NodeDefs || {};
                if (nodeDefs && typeof nodeDefs === 'object') {
                    for (const cls in nodeDefs) {
                        const nodeInfo = nodeDefs[cls];
                        if (nodeInfo && nodeInfo.display_name) {
                            const enTrim = cls.trim();
                            const cnTrim = nodeInfo.display_name.trim();
                            if (enTrim && cnTrim) {
                                if (!dict.enToCn[enTrim]) {
                                    dict.enToCn[enTrim] = cnTrim;
                                }
                                if (!dict.cnToEn[cnTrim]) {
                                    dict.cnToEn[cnTrim] = enTrim;
                                }
                            }
                        }
                    }
                }
            }
        } catch(e) {}

        this._translationCache = dict;
        this._translationCacheTime = now;
        return dict;
    },

    _searchMatch(itemText, searchLower) {
        if (!searchLower) return true;
        if (!itemText) return false;

        const itemStr = String(itemText);
        const itemLower = itemStr.toLowerCase();
        const searchNorm = String(searchLower).toLowerCase();

        // 1. 直接匹配
        if (itemLower.includes(searchNorm)) {
            return true;
        }

        // 2. 清理不可见字符后匹配
        try {
            const cleanItem = this._cleanText(itemLower).toLowerCase();
            const cleanSearch = this._cleanText(searchNorm).toLowerCase();
            if (cleanItem.includes(cleanSearch)) {
                return true;
            }
        } catch(e) {}

        // 3. 尝试 Unicode 归一化后匹配（处理全角/半角等差异）
        try {
            const itemNFKC = itemLower.normalize('NFKC');
            const searchNFKC = searchNorm.normalize('NFKC');
            if (itemNFKC.includes(searchNFKC)) {
                return true;
            }
        } catch(e) {}

        // 4. 翻译匹配
        try {
            const dict = this._getTranslationDict();
            const itemTrim = itemStr.trim();

            const cn = dict.enToCn[itemTrim];
            if (cn) {
                const cnLower = cn.toLowerCase();
                if (cnLower.includes(searchNorm)) return true;
                try { if (cnLower.normalize('NFKC').includes(searchNorm.normalize('NFKC'))) return true; } catch(e) {}
            }

            const en = dict.cnToEn[itemTrim];
            if (en) {
                const enLower = en.toLowerCase();
                if (enLower.includes(searchNorm)) return true;
                try { if (enLower.normalize('NFKC').includes(searchNorm.normalize('NFKC'))) return true; } catch(e) {}
            }

            // 翻译字典中部分匹配
            for (const enKey in dict.enToCn) {
                const enKeyLower = enKey.toLowerCase();
                const cnVal = dict.enToCn[enKey];
                const cnValLower = cnVal.toLowerCase();

                if (itemLower.includes(enKeyLower) || enKeyLower.includes(itemLower)) {
                    if (enKeyLower.includes(searchNorm)) return true;
                    if (cnValLower.includes(searchNorm)) return true;
                }
                if (itemLower.includes(cnValLower) || cnValLower.includes(itemLower)) {
                    if (enKeyLower.includes(searchNorm)) return true;
                    if (cnValLower.includes(searchNorm)) return true;
                }
            }
        } catch(e) {}

        return false;
    },

    _collectItems(options, menuType) {
        if (!options || !Array.isArray(options)) return;
        const list = this._collectedItems[menuType];
        if (!list) return;

        const existing = new Set(list);
        let changed = false;

        const addItem = (opt) => {
            if (!opt || opt === null) return;
            const key = this._normalizeKey(opt);
            if (!key || existing.has(key)) return;
            existing.add(key);
            list.push(key);
            changed = true;

            let subOptions = null;
            if (opt.submenu) {
                if (opt.submenu.options) {
                    subOptions = opt.submenu.options;
                } else if (typeof opt.submenu === 'function') {
                    try {
                        const result = opt.submenu();
                        if (Array.isArray(result)) subOptions = result;
                        else if (result?.options) subOptions = result.options;
                    } catch(e) {}
                } else if (Array.isArray(opt.submenu)) {
                    subOptions = opt.submenu;
                }
            }
            if (opt.options && Array.isArray(opt.options)) {
                subOptions = opt.options;
            }
            if (opt.items && Array.isArray(opt.items)) {
                subOptions = opt.items;
            }
            if (subOptions) {
                subOptions.forEach(sub => addItem(sub));
            }
        };

        options.forEach(o => addItem(o));

        if (changed) {
            list.sort();
        }
    },

    _filterOptions(options, menuType) {
        if (!options || !Array.isArray(options)) return options;

        this._collectItems(options, menuType);

        if (!this._enabled) return options;

        const self = this;

        const filterOpt = (opt) => {
            if (opt === null || opt === undefined) return true;
            const key = self._normalizeKey(opt);
            if (!key) return true;
            if (self.isHidden(menuType, key)) return false;

            if (opt.submenu) {
                if (opt.submenu.options && Array.isArray(opt.submenu.options)) {
                    opt.submenu.options = opt.submenu.options.filter(o => filterOpt(o));
                } else if (typeof opt.submenu === 'function') {
                    const origSubmenu = opt.submenu;
                    opt.submenu = function() {
                        const result = origSubmenu.apply(this, arguments);
                        if (Array.isArray(result)) {
                            return result.filter(o => filterOpt(o));
                        } else if (result?.options) {
                            result.options = result.options.filter(o => filterOpt(o));
                            return result;
                        }
                        return result;
                    };
                } else if (Array.isArray(opt.submenu)) {
                    opt.submenu = opt.submenu.filter(o => filterOpt(o));
                }
            }
            if (opt.options && Array.isArray(opt.options)) {
                opt.options = opt.options.filter(o => filterOpt(o));
            }
            if (opt.items && Array.isArray(opt.items)) {
                opt.items = opt.items.filter(o => filterOpt(o));
            }
            return true;
        };

        return options.filter(opt => filterOpt(opt));
    },

    collectCurrentMenu(menuType) {
        if (!this._canvasOrig && !this._nodeOrig) {
            this.hookMenus();
        }

        if (menuType === 'canvas' && this._canvasOrig && app?.canvas) {
            try {
                const opts = this._canvasOrig.call(app.canvas);
                this._collectItems(opts, 'canvas');
            } catch(e) {}
        }

        if (menuType === 'node' && this._nodeOrig && app?.canvas) {
            try {
                const nodes = app.canvas.selected_nodes;
                const firstNode = nodes ? Object.values(nodes)[0] : null;
                if (firstNode) {
                    const opts = this._nodeOrig.call(app.canvas, firstNode);
                    this._collectItems(opts, 'node');
                }
            } catch(e) {}
        }
    },

    hookMenus() {
        const self = this;

        const waitForLiteGraph = () => {
            if (typeof LiteGraph === 'undefined' || !LiteGraph?.LGraphCanvas?.prototype) {
                setTimeout(waitForLiteGraph, 100);
                return;
            }

            if (!self._canvasOrig) {
                self._canvasOrig = LiteGraph.LGraphCanvas.prototype.getCanvasMenuOptions;
                LiteGraph.LGraphCanvas.prototype.getCanvasMenuOptions = function() {
                    let options = self._canvasOrig.apply(this, arguments);
                    options = self._filterOptions(options, 'canvas');
                    return options;
                };
            }

            if (!self._nodeOrig) {
                self._nodeOrig = LiteGraph.LGraphCanvas.prototype.getNodeMenuOptions;
                LiteGraph.LGraphCanvas.prototype.getNodeMenuOptions = function(node) {
                    let options = self._nodeOrig.apply(this, arguments);
                    options = self._filterOptions(options, 'node');
                    return options;
                };
            }

            if (!self._contextMenuOrig && LiteGraph.ContextMenu) {
                self._contextMenuOrig = LiteGraph.ContextMenu;
                const origContextMenu = LiteGraph.ContextMenu;

                function XZGContextMenu(options, opts) {
                    let filteredOptions = options;
                    try {
                        let menuType = null;

                        if (opts && opts.event) {
                            const e = opts.event;
                            const target = e.target;
                            if (target) {
                                const canvasEl = app?.canvas?.canvas;
                                const graphCanvasEl = document.getElementById('graphCanvas');
                                const isCanvasClick = 
                                    target === canvasEl ||
                                    (graphCanvasEl && (target === graphCanvasEl || target.closest('#graphCanvas'))) ||
                                    target.classList?.contains('graphcanvas') ||
                                    target.closest?.('.graphcanvas');

                                if (isCanvasClick) {
                                    let node = null;
                                    if (app?.canvas?.getNodeAtPosition) {
                                        const canvasX = e.canvasX ?? e._canvas_x;
                                        const canvasY = e.canvasY ?? e._canvas_y;
                                        if (canvasX !== undefined && canvasY !== undefined) {
                                            node = app.canvas.getNodeAtPosition(canvasX, canvasY);
                                        }
                                    }
                                    if (!node && app?.canvas?.selected_nodes && Object.keys(app.canvas.selected_nodes).length > 0) {
                                        node = Object.values(app.canvas.selected_nodes)[0];
                                    }
                                    menuType = node ? 'node' : 'canvas';
                                }
                            }
                        }

                        if (!menuType) {
                            if (opts && opts.parentMenu) {
                                menuType = self._lastMenuType || 'canvas';
                            }
                        }

                        if (!menuType) {
                            if (options && options.length > 0) {
                                const firstOpt = options.find(o => o && typeof o !== 'string');
                                if (firstOpt) {
                                    const hasNodeProps = firstOpt.hasOwnProperty?.('properties') || 
                                        firstOpt.hasOwnProperty?.('mode') ||
                                        firstOpt.hasOwnProperty?.('inputs');
                                    if (hasNodeProps) {
                                        menuType = 'node';
                                    }
                                }
                            }
                        }

                        if (!menuType) {
                            menuType = self._lastMenuType || 'canvas';
                        }

                        if (menuType) {
                            self._lastMenuType = menuType;
                            self._collectItems(options, menuType);
                            filteredOptions = self._filterOptions(options, menuType);
                        }
                    } catch(e) {
                        console.warn('[小珠光] ContextMenu filter error:', e);
                    }

                    const instance = new origContextMenu(filteredOptions, opts);
                    return instance;
                }

                XZGContextMenu.prototype = origContextMenu.prototype;
                Object.setPrototypeOf(XZGContextMenu, origContextMenu);

                for (const key in origContextMenu) {
                    if (Object.prototype.hasOwnProperty.call(origContextMenu, key)) {
                        XZGContextMenu[key] = origContextMenu[key];
                    }
                }

                LiteGraph.ContextMenu = XZGContextMenu;
            }

            self._startDOMObserver();
        };

        waitForLiteGraph();
    },

    _domObserver: null,
    _lastMenuType: 'canvas',

    _startDOMObserver() {
        if (this._domObserver) return;
        const self = this;

        this._domObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) {
                        const el = node;
                        let menuEl = null;
                        if (el.classList && (
                            el.classList.contains('litecontextmenu') ||
                            el.classList.contains('context-menu') ||
                            el.classList.contains('litegraph-contextmenu') ||
                            (el.tagName === 'DIV' && el.querySelector?.('.litemenu-title'))
                        )) {
                            menuEl = el;
                        }
                        if (!menuEl) {
                            const inner = el.querySelector?.('.litecontextmenu, .context-menu, .litegraph-contextmenu');
                            if (inner) menuEl = inner;
                        }

                        if (menuEl) {
                            self._collectFromDOM(menuEl);
                            // 同步立即隐藏：MutationObserver 回调以微任务执行，
                            // 发生在浏览器首次绘制之前，因此可以彻底消除 setTimeout 延迟导致的闪屏
                            self._hideFromDOM(menuEl);
                            // 使用 requestAnimationFrame 在下一帧前再次检查，
                            // 捕获 LiteGraph 在同一帧内后续动态插入的菜单项
                            requestAnimationFrame(() => {
                                self._hideFromDOM(menuEl);
                            });
                        }
                    }
                }
            }
        });

        this._domObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    },

    _collectFromDOM(menuEl) {
        if (!menuEl) return;
        const self = this;
        let menuType = this._lastMenuType || 'canvas';

        const items = menuEl.querySelectorAll('.litemenu-entry, .context-menu-item, .menu-item, .lite-menu-item');
        const collected = [];

        items.forEach(item => {
            const text = item.textContent?.trim() || item.innerText?.trim();
            if (text && text.length < 50 && !text.match(/^[\d\s\-\.]+$/)) {
                collected.push(this._cleanText(text));
            }
        });

        if (collected.length > 0 && this._collectedItems[menuType]) {
            const list = this._collectedItems[menuType];
            const existing = new Set(list);
            let changed = false;
            collected.forEach(text => {
                const key = this._cleanText(text.replace(/<[^>]*>/g, '')).trim();
                if (key && !existing.has(key)) {
                    existing.add(key);
                    list.push(key);
                    changed = true;
                }
            });
            if (changed) {
                list.sort();
                if (window.xzgThemePanel && window.xzgThemePanel._menuListVisible) {
                    window.xzgThemePanel._refreshMenuListUI?.();
                }
            }
        }
    },

    _hideFromDOM(menuEl) {
        if (!menuEl || !this._enabled) return;
        const self = this;

        const allHiddenKeys = new Set();
        for (const menuType of ['canvas', 'node']) {
            const hiddenMap = this.config[menuType] || {};
            Object.keys(hiddenMap).forEach(key => allHiddenKeys.add(key));
        }
        if (allHiddenKeys.size === 0) return;

        const hideItem = (item) => {
            const text = item.textContent?.trim() || item.innerText?.trim();
            if (!text) return;
            const key = this._cleanText(text.replace(/<[^>]*>/g, '')).trim();
            if (!key) return;

            for (const hiddenKey of allHiddenKeys) {
                if (key === hiddenKey || key.includes(hiddenKey) || hiddenKey.includes(key)) {
                    item.style.display = 'none';
                    break;
                }
            }
        };

        const items = menuEl.querySelectorAll('.litemenu-entry, .context-menu-item, .menu-item, .lite-menu-item, [class*="menu-entry"], [class*="menu-item"]');
        items.forEach(item => hideItem(item));

        const allItems = menuEl.querySelectorAll('*');
        allItems.forEach(el => {
            if (el.children && el.children.length === 0) {
                const text = el.textContent?.trim();
                if (text && text.length > 0 && text.length < 50) {
                    for (const hiddenKey of allHiddenKeys) {
                        if (text === hiddenKey || text.includes(hiddenKey) || hiddenKey.includes(text)) {
                            let parent = el.parentElement;
                            for (let i = 0; i < 5 && parent; i++) {
                                if (parent.tagName === 'LI' || 
                                    parent.classList?.contains('litemenu-entry') ||
                                    parent.classList?.contains('context-menu-item') ||
                                    parent.classList?.contains('menu-item')) {
                                    parent.style.display = 'none';
                                    break;
                                }
                                parent = parent.parentElement;
                            }
                            break;
                        }
                    }
                }
            }
        });

        const checkSeparator = (item) => {
            if (!item.previousElementSibling) return;
            const prev = item.previousElementSibling;
            const isSeparator = prev.classList?.contains('separator') ||
                prev.classList?.contains('litemenu-separator') ||
                prev.tagName === 'HR' ||
                prev.style?.borderTop;
            if (!isSeparator && prev.tagName !== 'HR') {
                const cls = prev.className;
                if (typeof cls === 'string' && (cls.includes('separator') || cls.includes('divider'))) {
                    // 可能是分隔符
                } else {
                    return;
                }
            }

            let nextVisible = item.nextElementSibling;
            while (nextVisible && nextVisible.style.display === 'none') {
                nextVisible = nextVisible.nextElementSibling;
            }
            if (!nextVisible) {
                prev.style.display = 'none';
            }
        };

        items.forEach(item => checkSeparator(item));
    }
};

(function() {
    function tryInit() {
        if (typeof LiteGraph !== 'undefined' && LiteGraph?.LGraphCanvas?.prototype) {
            window.XZGMenuHide.init();
        } else {
            setTimeout(tryInit, 200);
        }
    }
    tryInit();
})();
