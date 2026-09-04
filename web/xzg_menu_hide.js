
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
        this._setupMenuRightClick();
        // 从后端云存储异步拉取并覆盖本地，实现“同一台服务器任意浏览器共享配置”。
        // 配错/失败时静默保留本地 localStorage 兜底。
        this.cloudLoad();
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
        this._cloudPush();
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
        this._cloudPush();
    },

    // ---------- 后端云持久化（复用 /xzg_cloud_store，key=menuhide） ----------
    // 云端为权威配置：初始化时优先拉取而代之；每次本地修改后异步推送到云端，
    // 同一台 ComfyUI 服务器上的任意浏览器 / 会话共享同一份隐藏配置，解决云端环境
    // localStorage 无法跨会话持久化的问题。push 一律静默失败，不影响本地功能。

    async cloudLoad() {
        try {
            const resp = await fetch('/xzg_cloud_store?key=menuhide', { credentials: 'same-origin' });
            if (!resp.ok) return;
            const json = await resp.json();
            if (!json || !json.found || json.data == null) return;
            const d = json.data;
            if (d && typeof d.config === 'object') {
                this.config = Object.assign({ canvas: {}, node: {} }, d.config);
                try { localStorage.setItem('xzg-menu-hide', JSON.stringify(this.config)); } catch(e) {}
            }
            if (typeof d.enabled === 'boolean') {
                this._enabled = d.enabled;
                try { localStorage.setItem('xzg-menu-hide-enabled', d.enabled ? 'true' : 'false'); } catch(e) {}
            }
            this._applyHideToOpenMenus();
            // 若隐藏面板正处于显示状态，拉取完成后再渲染一次列表以反映最新云端配置
            if (window.XZGThemePanel && window.XZGThemePanel._refreshMenuListUI) {
                window.XZGThemePanel._refreshMenuListUI();
            }
        } catch(e) { /* 云端不可达时静默，保留本地配置 */ }
    },

    _cloudPush() {
        if (this._cloudTimer) clearTimeout(this._cloudTimer);
        this._cloudTimer = setTimeout(() => {
            this._cloudTimer = null;
            this._cloudPushNow();
        }, 400);
    },

    async _cloudPushNow() {
        try {
            await fetch('/xzg_cloud_store', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'menuhide', data: { config: this.config, enabled: this._enabled } }),
            });
        } catch(e) { /* 静默 */ }
    },

    isHidden(menuType, content) {
        if (!this._enabled) return false;
        const map = this.config[menuType];
        if (!map) return false;
        const key = this._normalizeKey(content);
        if (map[key]) return true;
        // 强归一化兜底：忽略空白 / 全角差异，保证面板勾选状态与真实隐藏一致
        const strongKey = this._strongKey(key);
        if (strongKey) {
            for (const k in map) {
                if (this._strongKey(k) === strongKey) return true;
            }
        }
        return false;
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

    reload() {
        // 从本地(localStorage)重新载入配置并同步到云端，供主题面板“导入配置”在写回后刷新内存实例，
        // 避免内存仍是旧配置导致导入不生效、或被旧云端数据覆盖。
        this.loadConfig();
        this.loadEnabled();
        this._applyHideToOpenMenus();
        this._cloudPush();
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

    // 强归一化：小写 + 去除所有空白（含全角空格、NBSP、零宽字符、软连字符等）。
    // 用于去重 / 搜索 / 隐藏匹配 / isHidden，让“视觉相同但因空格或不可见字符而有细微差异”的
    // 菜单项合并为同一键，避免勾选后因子串匹配被中间空格切断而隐藏失败、或搜索搜不到。
    _strongKey(text) {
        if (text == null) return '';
        let s = String(text);
        s = s.replace(/<[^>]*>/g, '');
        s = s.replace(/[\s\u00AD\u180E\u200B-\u200F\u2028-\u202F\u2060-\u2064\uFEFF]+/g, '');
        return s.toLowerCase();
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

        // 5. 强归一化匹配（忽略所有空白与全角/零宽差异），保证视觉相同的菜单项都能被搜索到
        try {
            const itemStrong = this._strongKey(itemText);
            const searchStrong = this._strongKey(searchNorm);
            if (itemStrong && searchStrong && itemStrong.includes(searchStrong)) {
                return true;
            }
        } catch(e) {}

        return false;
    },

    _collectItems(options, menuType) {
        if (!options || !Array.isArray(options)) return;
        const list = this._collectedItems[menuType];
        if (!list) return;

        const existing = new Set(list.map(it => this._strongKey(it)));
        let changed = false;

        const addItem = (opt) => {
            if (!opt || opt === null) return;
            const key = this._normalizeKey(opt);
            const sk = this._strongKey(key);
            if (!key || !sk || existing.has(sk)) return;
            existing.add(sk);
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
                    let menuType = null;
                    try {

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

                        // 子菜单：继承父菜单类型（仅当父菜单是画布/节点菜单时才过滤）
                        if (!menuType && opts?.parentMenu?._xzgMenuType) {
                            menuType = opts.parentMenu._xzgMenuType;
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

                        // 关键：无法确定为画布/节点菜单时（如工作流标签右键、侧边栏菜单、对话框菜单等），不过滤
                        // 此前 fallback 到 _lastMenuType||'canvas' 会误把标签菜单当画布菜单过滤，导致右键失效
                        if (menuType) {
                            self._lastMenuType = menuType;
                            self._collectItems(options, menuType);
                            filteredOptions = self._filterOptions(options, menuType);
                        }
                    } catch(e) {
                        console.warn('[小珠光] ContextMenu filter error:', e);
                    }

                    const instance = new origContextMenu(filteredOptions, opts);
                    if (menuType) instance._xzgMenuType = menuType;
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

            // 记录上次右键是否在画布上：用于区分画布/节点菜单 vs 工作流标签/侧边栏等非画布菜单
            if (!self._ctxMenuTargetListenerInstalled) {
                self._ctxMenuTargetListenerInstalled = true;
                window.addEventListener('contextmenu', (e) => {
                    const target = e.target;
                    const canvasEl = app?.canvas?.canvas;
                    const graphCanvasEl = document.getElementById('graphCanvas');
                    self._lastCtxMenuOnCanvas = !!(
                        target === canvasEl ||
                        (graphCanvasEl && (target === graphCanvasEl || target.closest('#graphCanvas'))) ||
                        target.classList?.contains('graphcanvas') ||
                        target.closest?.('.graphcanvas')
                    );
                }, true);
            }

            self._startDOMObserver();
        };

        waitForLiteGraph();
    },

    _domObserver: null,
    _lastMenuType: 'canvas',
    _lastCtxMenuOnCanvas: false,

    // 在画布/节点右键菜单上，对某个菜单项“鼠标中键点击”弹出“隐藏此菜单项”按钮，点击即隐藏。
    // 这是最方便、且不干扰右键菜单本身的操作方式（右键会关闭原生菜单，因此改用中键）。
    _menuRightClickInstalled: false,

    _setupMenuRightClick() {
        if (this._menuRightClickInstalled) return;
        this._menuRightClickInstalled = true;
        const self = this;

        const removePopup = () => {
            const p = document.getElementById('xzg-menu-hide-popup');
            if (p) p.remove();
        };

        // 点击弹窗区域时阻止事件穿透到画布/LiteGraph，避免“点弹窗按钮导致原生菜单被关闭”。
        // 挂在 window 捕获阶段（最先执行）：stopImmediatePropagation 让画布任何“点击外部关闭菜单”的
        // mousedown/mouseup/pointerdown 监听都收不到，菜单得以保持打开。
        // 注意：不要 preventDefault mousedown/mouseup，那会抑制浏览器派发 click，导致按钮 click 隐藏逻辑不触发。
        const blockPopupLeak = (e) => {
            if (e.target && e.target.closest && e.target.closest('#xzg-menu-hide-popup')) {
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        };
        window.addEventListener('mousedown', blockPopupLeak, true);
        window.addEventListener('mouseup', blockPopupLeak, true);
        window.addEventListener('pointerdown', blockPopupLeak, true);
        window.addEventListener('pointerup', blockPopupLeak, true);
        window.addEventListener('contextmenu', (e) => {
            if (e.target && e.target.closest && e.target.closest('#xzg-menu-hide-popup')) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        }, true);

        // 左键点击别处 / 滚动 / 滚轮 / Esc 时关闭弹层。
        // 注意：中键（button 1）按下后松开也会派发 click，这里需忽略中键的 click，
        // 且点击落在弹层自身（如“隐藏此菜单项”按钮）时也不关闭，交由按钮逻辑处理。
        document.addEventListener('click', (e) => {
            if (e.button === 1) return;
            if (e.target && e.target.closest && e.target.closest('#xzg-menu-hide-popup')) return;
            removePopup();
        }, true);
        document.addEventListener('wheel', removePopup, true);
        document.addEventListener('scroll', removePopup, true);
        document.addEventListener('keydown', (e) => { if (!e.repeat && e.key === 'Escape') removePopup(); }, true);

        // 判定是否画布/节点右键菜单项。不依赖 _lastCtxMenuOnCanvas（桌面版 ComfyUI 画布 id/class 是
        // graph-canvas / lgraphcanvas，右键还可能被悬浮层截获，导致该标志不置位而误判非画布菜单）。
        // 改为按菜单自身 class 判定：.litecontextmenu / .litegraph-contextmenu 正是 LiteGraph 画布/节点
        // 菜单专用容器；工作流标签 / 侧边栏等用的是 .context-menu / .comfyui-menu，不会被误判。
        const isCanvasLike = (menuEl) => Boolean(
            menuEl && (
                menuEl._xzgMenuType ||
                menuEl.classList?.contains('litecontextmenu') ||
                menuEl.classList?.contains('litegraph-contextmenu') ||
                self._lastCtxMenuOnCanvas
            )
        );

        // 在 pointerdown（鼠标中键）捕获阶段截获条目文字。此时菜单仍挂在 DOM 上，可正常读取。
        // 原生菜单因右键而关闭发生在更晚的 mousedown/contextmenu，而中键不会关闭菜单、不会触发浏览器右键菜单，
        // 因此选中键作为触发键，不干扰右键菜单的其它操作用途。
        // 同时挂到 window 与 document 的捕获阶段：window 先于 document 触发，可抵抗
        // 上游在 window/document 捕获里 stopPropagation 导致 document 监听收不到情况。
        const onRightDown = (e) => {
            if (e.button !== 1) return; // 仅鼠标中键（button 1）

            const entry = e.target && e.target.closest
                ? e.target.closest('.litemenu-entry, .context-menu-item, .lite-menu-item, .menu-item, [class*="menu-entry"], [class*="menu-item"]')
                : null;
            if (!entry) return;

            const menuEl = entry.closest('.litecontextmenu, .context-menu, .litegraph-contextmenu, [class*="lite-menu"]');
            if (!isCanvasLike(menuEl)) return; // 非画布/节点菜单，不劫持

            // 阻止系统/ComfyUI 对本次右键的默认处理（浏览器原生右键菜单 / 画布重开新菜单）
            e.preventDefault();
            e.stopPropagation();

            const text = entry.textContent?.trim() || entry.innerText?.trim();
            if (!text) return;
            const key = self._normalizeKey(text);
            if (!key) return;

            // 同一次右键只会触发一个 pointerdown，这里仅对极短间隔内的重复事件去重
            const dup = document.getElementById('xzg-menu-hide-popup');
            if (dup && dup._xzgTime && (Date.now() - dup._xzgTime) < 200) return;

            removePopup();
            const popup = document.createElement('div');
            popup.id = 'xzg-menu-hide-popup';
            popup.style.cssText = 'position:fixed;z-index:2147483000;min-width:150px;max-width:240px;' +
                'background:#1a1a1a;border:1px solid #444;border-radius:6px;padding:4px;' +
                'box-shadow:0 4px 14px rgba(0,0,0,.45);font-size:12px;font-family:inherit;';

            const label = document.createElement('div');
            label.style.cssText = 'color:#aaa;padding:3px 6px;margin-bottom:2px;overflow:hidden;' +
                'text-overflow:ellipsis;white-space:nowrap;';
            label.textContent = text;
            label.title = text;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = '隐藏此菜单项';
            btn.style.cssText = 'display:block;width:100%;text-align:left;' +
                'background:none;border:none;color:#FFD700;font-weight:bold;font-size:12px;' +
                'padding:5px 6px;cursor:pointer;border-radius:4px;';
            btn.addEventListener('mouseenter', () => { btn.style.background = '#2a2a2a'; });
            btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                // 开启隐藏功能并记录配置。菜单份属类型由挂钩阶段(filterOptions)可靠写入
                // menuEl._xzgMenuType，这里只按该类型写入，避免 canvas / node 两表被写成一模一样，
                // 导致主题面板切换“画布菜单 / 节点菜单”标签时隐藏列表不随类型变化。
                self.setEnabled(true);
                const menuType = menuEl._xzgMenuType || self._lastMenuType || 'canvas';
                self.setHidden(menuType, key, true);
                // 菜单可能在按钮点击瞬间刚渲染/重建，下一帧与稍后再补几次隐藏，确保对应当前打开的菜单生效。
                requestAnimationFrame(() => self._applyHideToOpenMenus());
                setTimeout(() => self._applyHideToOpenMenus(), 150);
                setTimeout(() => self._applyHideToOpenMenus(), 400);
                if (window.XZGThemePanel && window.XZGThemePanel._menuListVisible) {
                    window.XZGThemePanel._refreshMenuListUI?.();
                }
                // 视觉反馈：按钮变绿说明 setHidden 已真正执行，方便与“隐藏没匹配上”问题区分。
                btn.textContent = '已隐藏';
                btn.style.color = '#7CFC00';
                setTimeout(() => { btn.textContent = text; }, 250);
                const menuRoot = entry.closest('.litecontextmenu, .litegraph-contextmenu, .context-menu, [class*="lite-menu"]') || entry.parentElement;
                console.info('[小珠光] 已隐藏菜单项 => key:', key, '| 容器class:', menuRoot?.className || '', '| itemHTML:', entry.outerHTML.slice(0, 300));
                setTimeout(() => removePopup(), 600);
            });

            popup.appendChild(label);
            popup.appendChild(btn);
            popup._xzgTime = Date.now();
            document.body.appendChild(popup);

            const x = Math.min(e.clientX, window.innerWidth - popup.offsetWidth - 8);
            const y = Math.min(e.clientY, window.innerHeight - popup.offsetHeight - 8);
            popup.style.left = Math.max(0, x) + 'px';
            popup.style.top = Math.max(0, y) + 'px';
        };

        window.addEventListener('pointerdown', onRightDown, true);
        document.addEventListener('pointerdown', onRightDown, true);
    },

    _startDOMObserver() {
        if (this._domObserver) return;
        const self = this;

        this._domObserver = new MutationObserver((mutations) => {
            const seenMenus = new WeakSet();
            const processMenu = (menuEl) => {
                if (!menuEl || seenMenus.has(menuEl)) return;
                seenMenus.add(menuEl);
                // 隐藏必须在任意时机可执行：菜单容器先挂载、条目随后才填充，因此要多次重试。
                // 且不能依赖画布标志(_lastCtxMenuOnCanvas)——桌面版该标志可能始终为 false，
                // 若把重试包进该判断内，条目填充后就不会被二次隐藏，造成“重开菜单又回来”。
                const tryHide = () => { if (self._enabled) self._hideFromDOM(menuEl); };
                tryHide();
                requestAnimationFrame(tryHide);
                setTimeout(tryHide, 60);
                setTimeout(tryHide, 180);
                if (!self._lastCtxMenuOnCanvas) return;
                // 仅处理画布/节点右键菜单；跳过工作流标签、侧边栏、对话框等非画布菜单，
                // 避免误隐藏标签右键条目导致"右键失效"
                menuEl._xzgMenuType = self._lastMenuType || 'canvas';
                self._collectFromDOM(menuEl);
                tryHide();
                requestAnimationFrame(() => { self._collectFromDOM(menuEl); tryHide(); });
                setTimeout(() => { self._collectFromDOM(menuEl); tryHide(); }, 50);
            };

            const findMenu = (el) => {
                if (!el || el.nodeType !== 1) return null;
                if (el.classList && (
                    el.classList.contains('litecontextmenu') ||
                    el.classList.contains('context-menu') ||
                    el.classList.contains('litegraph-contextmenu') ||
                    (el.tagName === 'DIV' && el.querySelector?.('.litemenu-title'))
                )) {
                    return el;
                }
                const inner = el.querySelector?.('.litecontextmenu, .context-menu, .litegraph-contextmenu');
                return inner || null;
            };

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        const menuEl = findMenu(node);
                        if (menuEl) processMenu(menuEl);
                    }
                }
                if (mutation.type === 'characterData' || mutation.type === 'childList') {
                    let target = mutation.target;
                    if (target.nodeType === 3) target = target.parentElement;
                    if (target) {
                        const menuEl = target.closest?.('.litecontextmenu, .context-menu, .litegraph-contextmenu');
                        if (menuEl) {
                            self._collectFromDOM(menuEl);
                        }
                    }
                }
            }
        });

        this._domObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            characterDataOldValue: false
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
            const existing = new Set(list.map(it => this._strongKey(it)));
            let changed = false;
            collected.forEach(text => {
                const key = this._cleanText(text.replace(/<[^>]*>/g, '')).trim();
                const sk = this._strongKey(key);
                if (key && sk && !existing.has(sk)) {
                    existing.add(sk);
                    list.push(key);
                    changed = true;
                }
            });
            if (changed) {
                list.sort();
                if (window.XZGThemePanel && window.XZGThemePanel._menuListVisible) {
                    window.XZGThemePanel._refreshMenuListUI?.();
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
            Object.keys(hiddenMap).forEach(key => allHiddenKeys.add(this._strongKey(key)));
        }
        if (allHiddenKeys.size === 0) return;

        const hideItem = (item) => {
            const text = item.textContent?.trim() || item.innerText?.trim();
            if (!text) return;
            const key = this._strongKey(text);
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
                    const strongText = this._strongKey(text);
                    if (!strongText) return;
                    for (const hiddenKey of allHiddenKeys) {
                        if (strongText === hiddenKey || strongText.includes(hiddenKey) || hiddenKey.includes(strongText)) {
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
