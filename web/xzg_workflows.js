import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { pinyin as pinyinPro } from "./pinyin-pro.esm.js";
import { xzgT } from "./xzg_i18n.js";

const STORAGE_KEY = "xzg_workflows_meta";
const PLUGIN_NAME = xzgT('工作流','Workflow');
const SETTING_TOGGLE_SHORTCUT = "xzg_wf_toggle_shortcut";
const ACCENT_KEY = "xzg_wf_accent";
// 使用频率配色默认值（按阈值升序）：超过 N 次时，工作流名称与图标显示对应颜色
const DEFAULT_USE_COLORS = [
    { threshold: 10,  color: "#60ce7f" },
    { threshold: 20,  color: "#3b6cdc" },
    { threshold: 30,  color: "#9c00ff" },
    { threshold: 50,  color: "#fffc00" },
    { threshold: 100, color: "#cda56d" }
];

let workflowsInstance = null;

class XZGWorkflowsManager {
    constructor() {
        this.workflows = [];
        this.categories = [];
        this.tree = [];
        this.expandedFolders = new Set();
        this.meta = {};
        this.container = null;
        this.searchInput = null;
        this.workflowList = null;
        this.categoryList = null;
        this.currentCategory = "all";
        this.currentSearch = "";
        this.sortMode = "default";
        this.initialized = false;
        this.draggedWorkflow = null;
        this._loading = false;
        this._loadQueue = [];

        this.init();
    }

    loadMeta() {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            if (data) {
                this.meta = JSON.parse(data);
            }
        } catch (e) {
            console.warn("[小珠光] 加载工作流元数据失败:", e);
        }
        if (!this.meta.workflows) this.meta.workflows = {};
        if (!this.meta.categories) this.meta.categories = [];
        if (!this.meta.sortMode) this.meta.sortMode = "default";
        if (!Array.isArray(this.meta.useColors) || this.meta.useColors.length === 0) {
            this.meta.useColors = DEFAULT_USE_COLORS.map(x => ({ ...x }));
        }
        if (typeof this.meta.useColorsEnabled !== "boolean") this.meta.useColorsEnabled = true;
        this.sortMode = this.meta.sortMode || "default";
    }

    saveMeta() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.meta));
        } catch (e) {
            console.warn("[小珠光] 保存工作流元数据失败:", e);
        }
    }

    getWorkflowMeta(path) {
        if (!this.meta.workflows[path]) {
            this.meta.workflows[path] = {
                useCount: 0,
                lastUsed: 0,
                categoryId: null,
                createdAt: Date.now()
            };
        }
        return this.meta.workflows[path];
    }

    init() {
        if (this.initialized) return;
        this.initialized = true;

        try {
            this.loadMeta();
            this.setupKeyboardListener();
            this.setupDragDrop();
            this.setupSidebarAutoClose();
            this.waitForExtensionManager().then(() => {
                this.registerSidebarTab();
                // 提前初始化夺舍模式：刷新后即使面板未打开，也能立即隐藏官方按钮并建立 Observer
                this.initPossessMode();
            });
        } catch (e) {
            console.error("[小珠光] 工作流初始化失败:", e);
        }
    }

    waitForExtensionManager() {
        return new Promise((resolve) => {
            const check = () => {
                if (app.extensionManager && app.extensionManager.registerSidebarTab) {
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }

    setIconGold() {
        const btn = document.querySelector('.xiaozhuguang-workflows-tab-button');
        if (!btn) return false;
        const icon = btn.querySelector('.side-bar-button-icon');
        if (!icon) return false;
        icon.style.color = 'var(--xzg-wf-accent, #FFD700)';
        if (!icon.querySelector('svg')) {
            icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="6" cy="6" r="2.5"/>
                <circle cx="18" cy="6" r="2.5"/>
                <circle cx="6" cy="18" r="2.5"/>
                <circle cx="18" cy="18" r="2.5"/>
                <path d="M8.5 6H15.5"/>
                <path d="M6 8.5V15.5"/>
                <path d="M18 8.5V15.5"/>
                <path d="M8.5 18H15.5"/>
            </svg>`;
        }
        return true;
    }

    registerSidebarTab() {
        try {
            app.extensionManager.registerSidebarTab({
                id: "xiaozhuguang-workflows",
                icon: "icon-[comfy--workflow]",
            title: xzgT('工作流','Workflow'),
            tooltip: xzgT('工作流','Workflow'),
                type: "custom",
                render: (el) => {
                    this._panelEl = el;
                    el.style.height = '100%';
                    el.style.width = '100%';
                    el.style.display = 'flex';
                    el.style.flexDirection = 'column';
                    el.style.overflow = 'hidden';

                    this.createPanel(el);
                    this.loadWorkflows();
                    this.observePanelOpen();
                    this.onPanelOpen();
                }
            });

            this.observeSidebarForIcon();
        } catch (error) {
            console.error("[小珠光] 注册侧边栏标签失败:", error);
        }
    }

    observeSidebarForIcon() {
        if (this.setIconGold() && this.moveButtonBeforeWorkflows()) return;

        const sidebar = document.querySelector('.sidebar-item-group');
        if (!sidebar) {
            setTimeout(() => this.observeSidebarForIcon(), 200);
            return;
        }

        const observer = new MutationObserver(() => {
            const iconDone = this.setIconGold();
            const moveDone = this.moveButtonBeforeWorkflows();
            if (iconDone && moveDone) {
                observer.disconnect();
            }
        });

        observer.observe(sidebar, { childList: true, subtree: true });

        setTimeout(() => {
            observer.disconnect();
        }, 5000);
    }

    moveButtonBeforeWorkflows() {
        const ourBtn = document.querySelector('.xiaozhuguang-workflows-tab-button');
        const wfBtn = document.querySelector('.workflows-tab-button');
        if (!ourBtn || !wfBtn) return false;
        if (ourBtn.previousElementSibling === wfBtn) return true;
        const parent = wfBtn.parentElement;
        if (!parent) return false;
        parent.insertBefore(ourBtn, wfBtn);
        return true;
    }

    // ====== 分类工具方法 ======

    getShortcut() {
        try {
            const stored = localStorage.getItem(SETTING_TOGGLE_SHORTCUT);
            if (stored) {
                return JSON.parse(stored);
            }
        } catch (e) {}
        return { key: "`", ctrl: false, alt: false, shift: false, meta: false };
    }

    saveShortcut(shortcut) {
        localStorage.setItem(SETTING_TOGGLE_SHORTCUT, JSON.stringify(shortcut));
    }

    updateShortcutDisplay() {
        const display = document.querySelector("#xzg-wf-shortcut-btn");
        if (!display) return;

        const shortcut = this.getShortcut();
        const parts = [];
        if (shortcut.ctrl) parts.push("Ctrl");
        if (shortcut.alt) parts.push("Alt");
        if (shortcut.shift) parts.push("Shift");
        parts.push(shortcut.key.toUpperCase());
        display.textContent = xzgT('快捷键','Shortcut') + ": " + parts.join("+");
    }

    // 语言切换时刷新面板内一次性构建的静态文案（标题、分类、列表标题、快捷键按钮）
    refreshStaticLabels() {
        const c = this.container;
        if (!c) return;
        const title = c.querySelector(".xzg-wf-title");
        if (title) title.textContent = xzgT('工作流','Workflow');
        const sc = c.querySelector("#xzg-wf-shortcut-btn");
        if (sc) sc.textContent = xzgT('快捷键','Shortcut') + ": " + (this.getShortcut().key || "`");
        const catHeader = c.querySelector(".xzg-wf-cat-header span");
        if (catHeader) catHeader.textContent = xzgT('分类','Categories');
        const listTitle = c.querySelector(".xzg-wf-list-title span");
        if (listTitle) listTitle.textContent = xzgT('工作流','Workflows');
    }

    showShortcutDialog() {
        const dialog = document.createElement("div");
        dialog.className = "xzg-wf-dialog-overlay";
        dialog.innerHTML = this._applyAccent(`
            <div class="xzg-wf-dialog">
                <div class="xzg-wf-dialog-title">${xzgT('设置快捷键','Set Shortcut')}</div>
                <div class="xzg-wf-dialog-body">
                    <p style="margin-bottom: 16px; color: #888; font-size: 13px; text-align: center;">${xzgT('请按下你想要的快捷键','Press the shortcut you want')}</p>
                    <div style="text-align: center; margin-bottom: 16px;">
                        <div id="xzg-wf-listen-display" style="
                            padding: 16px 24px;
                            background: #555;
                            border: 2px solid #888;
                            border-radius: 6px;
                            color: #ddd;
                            font-size: 16px;
                            font-weight: bold;
                            min-width: 180px;
                            display: inline-block;
                        ">${xzgT('请按快捷键...','Press shortcut...')}</div>
                    </div>
                </div>
                <div class="xzg-wf-dialog-footer">
                    <button class="xzg-wf-dialog-btn xzg-wf-dialog-btn-cancel" id="xzg-wf-dialog-cancel">${xzgT('取消','Cancel')}</button>
                    <button class="xzg-wf-dialog-btn xzg-wf-dialog-btn-confirm" id="xzg-wf-dialog-confirm" disabled>${xzgT('确认','Confirm')}</button>
                </div>
            </div>
        `);

        document.body.appendChild(dialog);

        const display = dialog.querySelector("#xzg-wf-listen-display");
        const confirmBtn = dialog.querySelector("#xzg-wf-dialog-confirm");
        let isListening = true;
        let currentShortcut = null;

        const stopListening = () => {
            isListening = false;
        };

        const handleKeyDown = (e) => {
            if (!isListening) return;

            e.preventDefault();
            e.stopPropagation();

            if (e.key === "Escape") {
                return;
            }

            const key = e.key.toLowerCase();
            if (key === "control" || key === "shift" || key === "alt" || key === "meta") {
                return;
            }

            const shortcut = {
                key: key,
                ctrl: e.ctrlKey,
                alt: e.altKey,
                shift: e.shiftKey,
                meta: e.metaKey
            };

            currentShortcut = shortcut;
            confirmBtn.disabled = false;

            const parts = [];
            if (shortcut.ctrl) parts.push("Ctrl");
            if (shortcut.alt) parts.push("Alt");
            if (shortcut.shift) parts.push("Shift");
            parts.push(shortcut.key.toUpperCase());

            display.textContent = parts.join(" + ");
            display.style.background = "#2a2a2a";
            display.style.color = "var(--xzg-wf-accent, #FFD700)";
            stopListening();
        };

        document.addEventListener("keydown", handleKeyDown, true);

        const closeDialog = () => {
            document.removeEventListener("keydown", handleKeyDown, true);
            dialog.remove();
        };

        dialog.querySelector("#xzg-wf-dialog-cancel").addEventListener("click", closeDialog);

        dialog.querySelector("#xzg-wf-dialog-confirm").addEventListener("click", () => {
            if (currentShortcut) {
                this.saveShortcut(currentShortcut);
                this.updateShortcutDisplay();
            }
            closeDialog();
        });

        dialog.addEventListener("click", (e) => {
            if (e.target === dialog) {
                closeDialog();
            }
        });
    }

    /** 自定义输入对话框，替代浏览器原生 prompt。返回输入字符串；取消 / ESC / 点遮罩返回 null */
    showInputDialog(title, defaultValue = "", opts = {}) {
        return new Promise((resolve) => {
            const escapeAttr = (v) => String(v == null ? "" : v)
                .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
                .replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const dialog = document.createElement("div");
            dialog.className = "xzg-wf-dialog-overlay";
            dialog.innerHTML = this._applyAccent(`
                <div class="xzg-wf-dialog">
                    <div class="xzg-wf-dialog-title">${escapeAttr(title)}</div>
                    <div class="xzg-wf-dialog-body">
                        <input type="text" class="xzg-wf-dialog-input" id="xzg-wf-dialog-input"
                            value="${escapeAttr(defaultValue)}" placeholder="${escapeAttr(opts.placeholder || "")}" />
                    </div>
                    <div class="xzg-wf-dialog-footer">
                        <button class="xzg-wf-dialog-btn xzg-wf-dialog-btn-cancel" id="xzg-wf-dialog-cancel">${xzgT('取消','Cancel')}</button>
                        <button class="xzg-wf-dialog-btn xzg-wf-dialog-btn-confirm" id="xzg-wf-dialog-confirm">${xzgT('确认','Confirm')}</button>
                    </div>
                </div>
            `);
            document.body.appendChild(dialog);

            const input = dialog.querySelector("#xzg-wf-dialog-input");
            const confirmBtn = dialog.querySelector("#xzg-wf-dialog-confirm");
            const cancelBtn = dialog.querySelector("#xzg-wf-dialog-cancel");

            const finish = (val) => {
                document.removeEventListener("keydown", onKey, true);
                dialog.remove();
                resolve(val);
            };
            const onKey = (e) => {
                if (e.key === "Escape") {
                    e.preventDefault(); e.stopPropagation();
                    finish(null);
                } else if (e.key === "Enter") {
                    e.preventDefault(); e.stopPropagation();
                    finish(input.value);
                }
            };
            document.addEventListener("keydown", onKey, true);

            cancelBtn.addEventListener("click", () => finish(null));
            confirmBtn.addEventListener("click", () => finish(input.value));
            dialog.addEventListener("click", (e) => {
                if (e.target === dialog) finish(null);
            });

            // 自动聚焦并全选，方便直接修改原名称
            input.focus();
            input.select();
        });
    }

    setupKeyboardListener() {
        document.addEventListener("keydown", (e) => {
            const activeEl = document.activeElement;
            const tagName = activeEl?.tagName;
            if (tagName === "INPUT" || tagName === "TEXTAREA" || activeEl?.isContentEditable) {
                return;
            }

            const shortcut = this.getShortcut();
            if (!shortcut || !shortcut.key) return;

            const key = e.key.toLowerCase();
            if (key !== shortcut.key.toLowerCase()) return;

            if (!!e.ctrlKey !== !!shortcut.ctrl) return;
            if (!!e.altKey !== !!shortcut.alt) return;
            if (!!e.shiftKey !== !!shortcut.shift) return;
            if (!!e.metaKey !== !!shortcut.meta) return;

            e.preventDefault();
            e.stopPropagation();
            this.toggleSidebarTab();
        });
    }

    toggleSidebarTab() {
        const wasOpen = this.isPanelOpen();   // 记录切换前状态，避免依赖自维护标志
        try {
            if (app.extensionManager?.sidebarTab?.toggleSidebarTab) {
                app.extensionManager.sidebarTab.toggleSidebarTab('xiaozhuguang-workflows');
                if (wasOpen) this.hideAllFloatingMenus();   // 关闭面板时一并清理浮层菜单（含嵌套子菜单）
                return;
            }
        } catch (e) {
            console.warn('[小珠光] 使用官方API切换侧边栏失败，尝试备用方案:', e);
        }
        
        const tabBtn = document.querySelector('[data-tab-id="xiaozhuguang-workflows"]') || 
                       document.querySelector('.xiaozhuguang-workflows-tab-button');
        if (tabBtn) {
            tabBtn.click();
        }
        if (wasOpen) this.hideAllFloatingMenus();
        else setTimeout(() => this.onPanelOpen(), 60);  // 打开瞬间重置为「全部」并聚焦搜索框
    }

    showContextMenu(e, wf) {
        this.hideContextMenu();
        
        const menu = document.createElement("div");
        menu.className = "xzg-wf-context-menu";
        menu.innerHTML = `
            <div class="xzg-wf-ctx-item" data-action="rename">✏️ ${xzgT('重命名','Rename')}</div>
            <div class="xzg-wf-ctx-item danger" data-action="delete-usage">🧹 ${xzgT('删除使用频率','Delete Usage')}</div>
            <div class="xzg-wf-ctx-item danger" data-action="delete">🗑️ ${xzgT('删除','Delete')}</div>
            <div class="xzg-wf-ctx-item xzg-wf-ctx-submenu" data-action="move">📁 ${xzgT('移动到分类','Move to Category')}</div>
        `;
        
        document.body.appendChild(menu);
        
        const x = e.clientX;
        const y = e.clientY;
        const rect = menu.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        
        let left = x;
        let top = y;
        
        if (x + rect.width > vw) {
            left = vw - rect.width - 5;
        }
        if (y + rect.height > vh) {
            top = vh - rect.height - 5;
        }
        
        menu.style.left = left + "px";
        menu.style.top = top + "px";
        
        this._contextMenu = menu;
        this._contextMenuWf = wf;
        
        const moveItem = menu.querySelector('[data-action="move"]');
        if (moveItem) {
            moveItem.addEventListener("mouseenter", (ev) => {
                this.showMoveSubmenu(ev, wf, moveItem);
            });
            moveItem.addEventListener("click", (ev) => {
                ev.stopPropagation();
                this.showMoveSubmenu(ev, wf, moveItem);
            });
        }
        
        menu.querySelectorAll(".xzg-wf-ctx-item:not(.xzg-wf-ctx-submenu)").forEach(item => {
            item.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const action = item.dataset.action;
                this.hideAllFloatingMenus();
                
                if (action === "rename") {
                    this.renameWorkflow(wf);
                } else if (action === "delete-usage") {
                    this.deleteWorkflowUsage(wf);
                } else if (action === "delete") {
                    this.deleteWorkflow(wf);
                }
            });
        });
        
        const closeHandler = (ev) => {
            if (!menu.contains(ev.target) && !this._moveSubmenu?.contains(ev.target)) {
                this.hideAllFloatingMenus();
                document.removeEventListener("mousedown", closeHandler);
                document.removeEventListener("keydown", keyHandler);
            }
        };
        
        const keyHandler = (ev) => {
            if (ev.key === "Escape") {
                this.hideAllFloatingMenus();
                document.removeEventListener("mousedown", closeHandler);
                document.removeEventListener("keydown", keyHandler);
            }
        };
        
        setTimeout(() => {
            document.addEventListener("mousedown", closeHandler);
            document.addEventListener("keydown", keyHandler);
        }, 0);
    }

    hideMoveSubmenu() {
        document.querySelectorAll(".xzg-wf-submenu").forEach(el => el.remove());
        this._moveSubmenu = null;
    }

    showMoveSubmenu(e, wf, parentItem) {
        this.hideMoveSubmenu();

        const submenu = document.createElement("div");
        submenu.className = "xzg-wf-submenu";

        // 独立的展开状态：默认全部折叠，与左侧分类树一致（需点击三角才展开）
        if (!this._moveExpanded) this._moveExpanded = new Set();
        const expanded = this._moveExpanded;
        const currentFolder = wf.folder === "未分类" ? "" : wf.folder;

        const buildItemHtml = (folder, folderPath, depth) => {
            const hasChildren = folder.children && folder.children.some(c => c.type === "folder");
            const isExpanded = expanded.has(folderPath);
            const selected = folderPath === currentFolder ? " selected" : "";
            let bars = "";
            for (let i = 0; i < depth + 1; i++) bars += `<span class="xzg-wf-cat-bar"></span>`;
            const toggle = hasChildren
                ? `<span class="xzg-wf-cat-toggle" data-path="${folderPath}"><svg class="xzg-wf-cat-toggle-svg ${isExpanded ? 'expanded' : ''}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></span>`
                : `<span class="xzg-wf-cat-toggle xzg-wf-cat-toggle-empty"></span>`;
            return `<div class="xzg-wf-submenu-item${selected}" data-folder="${folderPath}" style="padding-left:${8 + depth * 16}px">
                ${toggle}
                <span class="xzg-wf-cat-icon xzg-wf-cat-bars">${bars}</span>
                <span class="xzg-wf-cat-label">${folder.name}</span>
            </div>`;
        };

        const buildHtml = () => {
            let html = `<div class="xzg-wf-submenu-item${currentFolder === "" ? ' selected' : ''}" data-folder="">
                <span class="xzg-wf-cat-toggle xzg-wf-cat-toggle-empty"></span>
                <span class="xzg-wf-cat-label">${xzgT('未分类','Uncategorized')}</span>
            </div>`;
            const walk = (folders, parentPath, depth) => {
                for (const folder of folders) {
                    if (folder.type !== "folder") continue;
                    const fullPath = folder.path || folder.name;
                    html += buildItemHtml(folder, fullPath, depth);
                    const hasChildren = folder.children && folder.children.some(c => c.type === "folder");
                    if (hasChildren && expanded.has(fullPath)) {
                        walk(folder.children, fullPath, depth + 1);
                    }
                }
            };
            if (this.tree && this.tree.length > 0) walk(this.tree, "", 0);
            return html;
        };

        const position = () => {
            const parentRect = parentItem.getBoundingClientRect();
            const subRect = submenu.getBoundingClientRect();
            const vw = window.innerWidth, vh = window.innerHeight;
            let subLeft = parentRect.right + 2;
            let subTop = parentRect.top;
            if (subLeft + subRect.width > vw) subLeft = parentRect.left - subRect.width - 2;
            if (subTop + subRect.height > vh) subTop = Math.max(5, vh - subRect.height - 5);
            submenu.style.left = subLeft + "px";
            submenu.style.top = subTop + "px";
        };

        const bind = () => {
            submenu.querySelectorAll(".xzg-wf-submenu-item").forEach(item => {
                item.addEventListener("click", (ev) => {
                    const toggleEl = ev.target.closest(".xzg-wf-cat-toggle");
                    if (toggleEl && !toggleEl.classList.contains("xzg-wf-cat-toggle-empty")) {
                        ev.stopPropagation();
                        const path = toggleEl.dataset.path;
                        if (expanded.has(path)) expanded.delete(path);
                        else expanded.add(path);
                        submenu.innerHTML = buildHtml();
                        bind();
                        return;
                    }
                    ev.stopPropagation();
                    this.hideContextMenu();
                    this.hideMoveSubmenu();
                    this.moveWorkflowToFolder(wf, item.dataset.folder);
                });
            });
        };

        submenu.innerHTML = buildHtml();
        document.body.appendChild(submenu);
        position();
        bind();
        this._moveSubmenu = submenu;
    }

    findFolderByPath(path, tree = this.tree, parentPath = "") {
        for (const item of tree) {
            if (item.type !== "folder") continue;
            const fullPath = parentPath ? parentPath + "/" + item.name : item.name;
            if (fullPath === path) return item;
            if (item.children) {
                const found = this.findFolderByPath(path, item.children, fullPath);
                if (found) return found;
            }
        }
        return null;
    }

    collapseSiblingFolders(folderPath) {
        const parentPath = folderPath.includes("/") 
            ? folderPath.substring(0, folderPath.lastIndexOf("/")) 
            : "";
        const siblings = [];
        for (const p of this.expandedFolders) {
            if (p === folderPath) continue;
            const pParent = p.includes("/") 
                ? p.substring(0, p.lastIndexOf("/")) 
                : "";
            if (pParent === parentPath) {
                siblings.push(p);
            }
        }
        for (const sib of siblings) {
            this.expandedFolders.delete(sib);
            for (const p of [...this.expandedFolders]) {
                if (p.startsWith(sib + "/")) {
                    this.expandedFolders.delete(p);
                }
            }
        }
    }

    showAllContextMenu(e) {
        this.hideContextMenu();
        
        const menu = document.createElement("div");
        menu.className = "xzg-wf-context-menu";
        menu.innerHTML = `
            <div class="xzg-wf-ctx-item" data-action="new-folder">📁 ${xzgT('新建分类','New Category')}</div>
        `;
        
        document.body.appendChild(menu);
        
        const x = e.clientX;
        const y = e.clientY;
        const rect = menu.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        
        let left = x;
        let top = y;
        
        if (x + rect.width > vw) {
            left = vw - rect.width - 5;
        }
        if (y + rect.height > vh) {
            top = vh - rect.height - 5;
        }
        
        menu.style.left = left + "px";
        menu.style.top = top + "px";
        
        this._contextMenu = menu;
        
        menu.querySelectorAll(".xzg-wf-ctx-item").forEach(item => {
            item.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const action = item.dataset.action;
                this.hideContextMenu();
                
                if (action === "new-folder") {
                    this.createNewCategory("");
                }
            });
        });
        
        const closeHandler = (ev) => {
            if (!menu.contains(ev.target)) {
                this.hideContextMenu();
                document.removeEventListener("mousedown", closeHandler);
                document.removeEventListener("keydown", keyHandler);
            }
        };
        
        const keyHandler = (ev) => {
            if (ev.key === "Escape") {
                this.hideContextMenu();
                document.removeEventListener("mousedown", closeHandler);
                document.removeEventListener("keydown", keyHandler);
            }
        };
        
        setTimeout(() => {
            document.addEventListener("mousedown", closeHandler);
            document.addEventListener("keydown", keyHandler);
        }, 0);
    }

    showCategoryContextMenu(e, cat) {
        this.hideContextMenu();

        // 判断是文件夹类型（非系统分类）才显示排序选项
        const isFolder = cat && cat.type === "folder";

        let html = '';
        if (isFolder) {
            html += `<div class="xzg-wf-ctx-item" data-action="rename">✏️ ${xzgT('重命名','Rename')}</div>
            <div class="xzg-wf-ctx-separator"></div>`;
        }
        html += `<div class="xzg-wf-ctx-item" data-action="new-subfolder">📁 ${xzgT('新建子分类','New Subcategory')}</div>
            <div class="xzg-wf-ctx-separator"></div>
            <div class="xzg-wf-ctx-item danger" data-action="delete">🗑️ ${xzgT('删除分类','Delete Category')}</div>`;

        const menu = document.createElement("div");
        menu.className = "xzg-wf-context-menu";
        menu.innerHTML = html;

        document.body.appendChild(menu);

        const x = e.clientX;
        const y = e.clientY;
        const rect = menu.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left = x;
        let top = y;

        if (x + rect.width > vw) {
            left = vw - rect.width - 5;
        }
        if (y + rect.height > vh) {
            top = vh - rect.height - 5;
        }

        menu.style.left = left + "px";
        menu.style.top = top + "px";

        this._contextMenu = menu;

        menu.querySelectorAll(".xzg-wf-ctx-item").forEach(item => {
            item.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const action = item.dataset.action;
                this.hideContextMenu();

                if (action === "delete") {
                    this.deleteCategory(cat);
                } else if (action === "rename") {
                    this.renameCategory(cat);
                } else if (action === "new-subfolder") {
                    this.createNewCategory(cat.path || cat.name);
                }
            });
        });

        const closeHandler = (ev) => {
            if (!menu.contains(ev.target)) {
                this.hideContextMenu();
                document.removeEventListener("mousedown", closeHandler);
                document.removeEventListener("keydown", keyHandler);
            }
        };

        const keyHandler = (ev) => {
            if (ev.key === "Escape") {
                this.hideContextMenu();
                document.removeEventListener("mousedown", closeHandler);
                document.removeEventListener("keydown", keyHandler);
            }
        };

        setTimeout(() => {
            document.addEventListener("mousedown", closeHandler);
            document.addEventListener("keydown", keyHandler);
        }, 0);
    }

    hideContextMenu() {
        document.querySelectorAll(".xzg-wf-context-menu").forEach(el => el.remove());
        this._contextMenu = null;
        this._contextMenuWf = null;
    }

    /** 清除所有浮层菜单（右键菜单、移动分类子菜单及其嵌套子菜单） */
    hideAllFloatingMenus() {
        this.hideContextMenu();
        this.hideMoveSubmenu();
    }

    setupDragDrop() {
        const self = this;

        document.addEventListener("dragover", (e) => {
            if (e.dataTransfer.types && e.dataTransfer.types.includes("application/xzg-workflow-path") && self.draggedWorkflow) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
                self.updateDragPreview(e.clientX, e.clientY, self.draggedWorkflow.name);
            }
        }, true);

        document.addEventListener("drop", (e) => {
            if (e.dataTransfer.types && e.dataTransfer.types.includes("application/xzg-workflow-path")) {
                e.preventDefault();
                e.stopPropagation();
                const path = e.dataTransfer.getData("application/xzg-workflow-path");
                if (path) {
                    const canvas = app.canvas;
                    if (canvas && canvas.canvas) {
                        const rect = canvas.canvas.getBoundingClientRect();
                        if (e.clientX >= rect.left && e.clientX <= rect.right &&
                            e.clientY >= rect.top && e.clientY <= rect.bottom) {
                            self.importWorkflowToCanvas(path, e.clientX, e.clientY);
                        }
                    }
                }
                self.removeDragPreview();
            }
        }, true);

        document.addEventListener("dragend", () => {
            self.removeDragPreview();
        }, true);
    }

    /** 判断点击位置是否落在某个节点上（用于区分「空白画布」与「节点」） */
    _isPointerOnNode(e) {
        try {
            const canvas = app.canvas;
            if (!canvas || !canvas.getNodeAtPosition) return false;
            let cx = e.canvasX ?? e._canvas_x;
            let cy = e.canvasY ?? e._canvas_y;
            if ((cx === undefined || cy === undefined) && canvas.convertEventToCanvasCoordinates) {
                const p = canvas.convertEventToCanvasCoordinates(e);
                if (p) { cx = p[0]; cy = p[1]; }
            }
            if (cx === undefined || cy === undefined) return false;
            return !!canvas.getNodeAtPosition(cx, cy);
        } catch (_) {
            return false;
        }
    }

    /**
     * 判断工作流管理面板当前是否真正处于「打开（激活）」状态。
     * 优先读取 ComfyUI 官方的激活标签状态（兼容 Vue ref 解包），
     * 读取不到时再用 DOM 可见性兜底。
     */
    isPanelOpen() {
        try {
            const st = app.extensionManager?.sidebarTab;
            if (st && st.activeSidebarTabId !== undefined) {
                let id = st.activeSidebarTabId;
                if (id && typeof id === "object") {
                    id = ("value" in id) ? id.value : id;
                }
                return id === "xiaozhuguang-workflows";
            }
        } catch (_) {}
        // DOM 兜底：面板容器可见即认为打开
        try {
            if (this._panelEl && this._panelEl.offsetParent !== null) {
                return true;
            }
        } catch (_) {}
        return false;
    }

    /** 每次面板打开时的默认状态：激活「全部」、清空并聚焦搜索框 */
    onPanelOpen() {
        this.currentCategory = "all";
        if (this.searchInput) {
            this.searchInput.value = "";
            this.currentSearch = "";
            const clearBtn = this.container?.querySelector(".xzg-wf-clear-btn");
            if (clearBtn) clearBtn.style.display = "none";
        }
        this.renderCategories();
        this.renderWorkflowList();
        // 延迟聚焦，避免被官方侧边栏打开时的焦点抢走（rAF + 兜底定时器）
        if (this.searchInput) {
            const focusSearch = () => { try { this.searchInput.focus(); } catch (e) {} };
            requestAnimationFrame(() => requestAnimationFrame(focusSearch));
            setTimeout(focusSearch, 120);
        }
    }

    /** 监听面板容器可见性，打开瞬间触发 onPanelOpen（覆盖所有打开入口） */
    observePanelOpen() {
        const el = this._panelEl;
        if (!el || this._panelObserver) return;
        let wasVisible = this.isPanelOpen();
        this._panelObserver = new MutationObserver(() => {
            const visible = this.isPanelOpen();
            if (visible && !wasVisible) {
                this.onPanelOpen();
            }
            wasVisible = visible;
        });
        this._panelObserver.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
    }

    /**
     * 面板打开时，若点击「空白画布」（非节点），则自动收起工作流管理面板，
     * 并清理所有浮层菜单（含嵌套子菜单）。
     * 点击节点时放行，保证节点可正常拖拽/选中。
     * 使用真实激活状态判断，避免与 ComfyUI 原生「点击画布关闭侧边栏」冲突导致二次 toggle 反向打开。
     */
    setupSidebarAutoClose() {
        if (this._sidebarAutoCloseInstalled) return;
        this._sidebarAutoCloseInstalled = true;

        const install = () => {
            const canvasEl = app.canvas && app.canvas.canvas;
            if (!canvasEl) {
                setTimeout(install, 200);
                return;
            }

            const onPointer = (e) => {
                try {
                    if (this._isPointerOnNode(e)) return;        // 点击节点：放行
                    this.hideAllFloatingMenus();                // 空白画布：先清理浮层
                    if (this.isPanelOpen()) {                   // 仅在面板确实打开时关闭，避免反向打开
                        this.closePanel();
                    }
                } catch (_) {}
            };

            canvasEl.addEventListener("pointerdown", onPointer, true);
        };

        install();
    }

    /** 关闭工作流管理侧边栏标签 */
    closePanel() {
        this.hideAllFloatingMenus();
        try {
            if (this.isPanelOpen() && app.extensionManager?.sidebarTab?.toggleSidebarTab) {
                app.extensionManager.sidebarTab.toggleSidebarTab("xiaozhuguang-workflows");
            }
        } catch (_) {}
    }

    async importWorkflowToCanvas(path, clientX, clientY) {
        try {
            let data = null;
            
            const wfStore = app.extensionManager?.workflow;
            const officialPath = 'workflows/' + path + '.json';
            
            if (wfStore?.getWorkflowByPath) {
                const persistedWf = wfStore.getWorkflowByPath(officialPath);
                if (persistedWf?.content) {
                    data = JSON.parse(persistedWf.content);
                }
            }
            
            if (!data) {
                const res = await api.fetchApi(`/xzg/workflows/${encodeURIComponent(path)}`, { cache: "no-store" });
                if (!res.ok) throw new Error("加载失败");
                data = await res.json();
            }

            const graph = app.graph;
            const canvas = app.canvas;

            if (!data.nodes || data.nodes.length === 0) return;

            let maxNodeId = graph._nodes?.reduce((max, n) => Math.max(max, n.id), 0) || 0;

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const node of data.nodes) {
                if (node.pos) {
                    const x = node.pos[0];
                    const y = node.pos[1];
                    const w = (node.size && node.size[0]) ? node.size[0] : 140;
                    const h = (node.size && node.size[1]) ? node.size[1] : 100;
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x + w > maxX) maxX = x + w;
                    if (y + h > maxY) maxY = y + h;
                }
            }

            let canvasX, canvasY;
            const canvasRect = canvas.canvas.getBoundingClientRect();
            const screenDX = clientX - canvasRect.left;
            const screenDY = clientY - canvasRect.top;
            if (canvas.convertCanvasToOffset) {
                const pos = canvas.convertCanvasToOffset([screenDX, screenDY]);
                if (pos) {
                    canvasX = pos[0];
                    canvasY = pos[1];
                } else {
                    canvasX = screenDX;
                    canvasY = screenDY;
                }
            } else {
                canvasX = screenDX;
                canvasY = screenDY;
            }

            const centerX = (minX + maxX) / 2;
            const centerY = (minY + maxY) / 2;
            const offsetX = canvasX - centerX;
            const offsetY = canvasY - centerY;

            graph.beforeChange();

            const nodeMap = {};
            const newNodes = [];
            for (const nodeData of data.nodes) {
                const oldId = nodeData.id;
                const node = LiteGraph.createNode(nodeData.type);
                if (!node) {
                    console.warn("[小珠光] 无法创建节点类型:", nodeData.type);
                    continue;
                }

                let newId;
                if (graph.getNextNodeId) {
                    newId = graph.getNextNodeId();
                } else {
                    newId = ++maxNodeId;
                }
                nodeMap[oldId] = node;
                node.id = newId;

                if (nodeData.pos) {
                    node.pos = [nodeData.pos[0] + offsetX, nodeData.pos[1] + offsetY];
                }
                if (nodeData.size) node.size = [...nodeData.size];
                if (nodeData.flags) Object.assign(node.flags, nodeData.flags);
                if (nodeData.mode !== undefined) node.mode = nodeData.mode;
                if (nodeData.properties) {
                    try {
                        node.properties = JSON.parse(JSON.stringify(nodeData.properties));
                    } catch (e) {
                        console.warn("[小珠光] 设置节点 properties 失败:", e);
                    }
                }
                if (nodeData.widgets_values) {
                    try {
                        node.widgets_values = JSON.parse(JSON.stringify(nodeData.widgets_values));
                    } catch (e) {
                        console.warn("[小珠光] 设置节点 widgets_values 失败:", e);
                    }
                }

                try {
                    graph.add(node);
                } catch (e) {
                    console.warn("[小珠光] 添加节点到图失败:", nodeData.type, e);
                    continue;
                }

                if (node.widgets && node.widgets_values) {
                    try {
                        for (let i = 0; i < node.widgets.length && i < node.widgets_values.length; i++) {
                            if (node.widgets[i]) {
                                node.widgets[i].value = node.widgets_values[i];
                            }
                        }
                    } catch (e) {
                        console.warn("[小珠光] 设置控件值失败:", nodeData.type, e);
                    }
                }

                newNodes.push(node);
            }

            if (data.links) {
                for (const linkData of data.links) {
                    try {
                        const [oldLinkId, oldOriginId, originSlot, oldTargetId, targetSlot, type] = linkData;
                        const srcNode = nodeMap[oldOriginId];
                        const tgtNode = nodeMap[oldTargetId];
                        if (!srcNode || !tgtNode) continue;
                        srcNode.connect(originSlot, tgtNode, targetSlot);
                    } catch (e) {
                        console.warn("[小珠光] 连线失败:", e);
                    }
                }
            }

            if (data.groups && data.groups.length > 0) {
                for (const groupData of data.groups) {
                    try {
                        const group = {
                            title: groupData.title || "Group",
                            bounding: [...(groupData.bounding || [0, 0, 200, 200])],
                            color: groupData.color || "#3f789e"
                        };
                        group.bounding[0] += offsetX;
                        group.bounding[1] += offsetY;
                        graph.add(group);
                    } catch (e) {
                        console.warn("[小珠光] 添加分组失败:", e);
                    }
                }
            }

            try {
                graph.afterChange();
            } catch (e) {
                console.warn("[小珠光] graph.afterChange 失败:", e);
            }

            if (newNodes.length > 0) {
                try {
                    canvas.selectNodes(newNodes);
                } catch (e) {
                    console.warn("[小珠光] 选中节点失败:", e);
                }
            }

            try {
                graph.setDirtyCanvas(true, true);
            } catch (e) {
                console.warn("[小珠光] 设置画布脏标记失败:", e);
            }

            if (newNodes.length === 0) {
                throw new Error("没有成功创建任何节点");
            }

            this.renderWorkflowList();
        } catch (e) {
            console.warn("[小珠光] 导入工作流到画布失败:", e);
            alert(xzgT('导入工作流失败: ','Failed to import workflow: ') + e.message);
        }
    }

    updateDragPreview(x, y, name = "") {
        let preview = document.getElementById("xzg-wf-drag-preview");
        if (!preview) {
            preview = document.createElement("div");
            preview.id = "xzg-wf-drag-preview";
            preview.style.cssText = this._applyAccent(`
                position: fixed;
                padding: 10px 18px;
                background: linear-gradient(135deg, #FFD700, #FFA500);
                color: #1a1a1a;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 500;
                pointer-events: none;
                z-index: 10000;
                white-space: nowrap;
                box-shadow: 0 6px 20px rgba(255, 215, 0, 0.4);
                border: 2px solid rgba(255,255,255,0.2);
                transform: translate(-50%, -50%);
                opacity: 0.95;
            `);
            document.body.appendChild(preview);
        }
        preview.textContent = name || "拖动中...";
        preview.style.left = x + "px";
        preview.style.top = y + "px";
    }

    removeDragPreview() {
        const preview = document.getElementById("xzg-wf-drag-preview");
        if (preview) {
            preview.remove();
        }
    }

    createPanel(container) {
        container.innerHTML = `
            <div class="xzg-wf-panel">
                <div class="xzg-wf-header">
                    <span class="xzg-wf-title">${xzgT('工作流','Workflow')}</span>
                    <div class="xzg-wf-header-btns">
                                    <button class="xzg-wf-header-btn" id="xzg-wf-help-btn" title="${xzgT('使用说明','Usage')}">📖 ${xzgT('说明','Help')}</button>
                                    <div class="xzg-wf-header-btn xzg-wf-trash-btn" id="xzg-wf-trash-btn" title="${xzgT('回收站（误删可恢复）','Recycle bin (recoverable if deleted by mistake)')}">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="3 6 5 6 21 6"/>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                </svg>
                            </div>
                            <button class="xzg-wf-header-btn xzg-wf-accent-btn" id="xzg-wf-settings-btn" title="${xzgT('设置（强调色 / 使用频率配色 / 快捷键 / 夺舍模式）','Settings (accent color / usage frequency colors / shortcut / possess mode)')}">${xzgT('设置','Settings')}</button>

                        </div>
                </div>
                <div class="xzg-wf-search-box">
                    <input type="text" class="xzg-wf-search-input" placeholder="🔍 ${xzgT('搜索工作流 (拼音/首字母/名称)...','Search workflows (pinyin/initials/name)...')}" />
                    <button class="xzg-wf-clear-btn" style="display: none;">✕</button>
                </div>
                <div class="xzg-wf-split-container">
                    <div class="xzg-wf-left-col">
                        <div class="xzg-wf-cat-header">
                            <span>${xzgT('分类','Categories')}</span>
                        </div>
                        <div class="xzg-wf-cat-list"></div>
                    </div>
                    <div class="xzg-wf-split-handle" title="拖动调节宽度"></div>
                    <div class="xzg-wf-right-col">
                        <div class="xzg-wf-list-header">
                            <div class="xzg-wf-list-title">
                                <span>${xzgT('工作流','Workflows')}</span>
                                <span class="xzg-wf-count">0</span>
                            </div>
                            <div class="xzg-wf-sort-btns">
                                <button class="xzg-wf-sort-btn active" data-sort="default" title="${xzgT('按使用频率排序（右键清空使用频率）','Sort by usage frequency (right-click to clear)')}">🔥</button>
                                <button class="xzg-wf-sort-btn xzg-wf-sort-btn-name" data-sort="name" title="按名称排序">A</button>
                            </div>
                        </div>
                        <div class="xzg-wf-list"></div>
                    </div>
                </div>
            </div>
        `;

        this.container = container;
        this.searchInput = container.querySelector(".xzg-wf-search-input");
        this.workflowList = container.querySelector(".xzg-wf-list");
        this.categoryList = container.querySelector(".xzg-wf-cat-list");

        this.injectStyles();
        this.bindPanelEvents();
        this.setupSplitResizing();
    }

    injectStyles() {
        const style = document.createElement("style");
        const css = `
            .xiaozhuguang-workflows-tab-button .side-bar-button-icon {
                color: #FFD700 !important;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .xiaozhuguang-workflows-tab-button .side-bar-button-icon svg {
                width: 20px;
                height: 20px;
            }
            .xiaozhuguang-workflows-tab-button.active .side-bar-button-icon {
                color: #FFD700 !important;
            }
            .xzg-wf-panel {
                display: flex;
                flex-direction: column;
                height: 100%;
                width: 100%;
                overflow: hidden;
                background: var(--comfy-menu-bg, rgba(30, 30, 30, 0.95));
                color: var(--fg, #ddd);
                font-family: Arial, sans-serif;
                font-size: 14px;
                user-select: none;
            }
            .xzg-wf-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 12px;
                background: var(--comfy-input-bg, rgba(50, 50, 50, 0.8));
                border-bottom: 1px solid var(--border-color, #444);
                flex-shrink: 0;
            }
            .xzg-wf-title {
                font-weight: bold;
                font-size: 16px;
                color: #FFD700;
            }
            .xzg-wf-header-btns {
                display: flex;
                gap: 6px;
            }
            .xzg-wf-header-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                height: 26px;
                box-sizing: border-box;
                padding: 0 12px;
                font-size: 12px;
                background: var(--comfy-input-bg, #3a3a3a);
                color: var(--fg, #ddd);
                border: 1px solid var(--border-color, #555);
                border-radius: 4px;
                cursor: pointer;
                transition: all 0.15s;
            }
            .xzg-wf-header-btn:hover {
                background: rgba(255, 255, 255, 0.1);
            }
            .xzg-wf-accent-btn,
            .xzg-wf-shortcut-btn {
                position: relative;
                flex: 1 1 0;
                min-width: 0;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                height: 26px;
                padding: 0 12px !important;
                box-sizing: border-box;
                background: rgba(255, 255, 255, 0.06) !important;
                border: 1px solid rgba(255, 255, 255, 0.2) !important;
                border-radius: 4px;
                overflow: hidden;
                cursor: pointer;
                font-size: 12px;
                line-height: 1;
                color: var(--xzg-wf-text);
                white-space: nowrap;
            }
            .xzg-wf-accent-btn:hover,
            .xzg-wf-shortcut-btn:hover {
                background: rgba(255, 255, 255, 0.12) !important;
            }
            .xzg-wf-accent-text {
                line-height: 1;
            }
            .xzg-wf-possess {
                gap: 6px;
                user-select: none;
            }
            .xzg-wf-possess-text {
                line-height: 1;
                white-space: nowrap;
            }
            .xzg-wf-toggle {
                position: relative;
                display: inline-block;
                width: 30px;
                height: 16px;
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.2);
                transition: background 0.2s;
                flex-shrink: 0;
            }
            .xzg-wf-toggle i {
                position: absolute;
                top: 2px;
                left: 2px;
                width: 12px;
                height: 12px;
                border-radius: 50%;
                background: #ddd;
                transition: all 0.2s;
            }
            .xzg-wf-possess.active {
                border-color: #e5484d;
                color: #e5484d;
            }
            .xzg-wf-possess.active .xzg-wf-toggle {
                background: #e5484d;
            }
            .xzg-wf-possess.active .xzg-wf-toggle i {
                left: 16px;
                background: #fff;
            }
            .xzg-wf-search-box {
                padding: 10px 12px;
                position: relative;
                flex-shrink: 0;
            }
            .xzg-wf-search-input {
                width: 100%;
                padding: 9px 12px;
                background: var(--comfy-input-bg, #2a2a2a);
                border: 1px solid var(--border-color, #555);
                border-radius: 4px;
                color: var(--fg, #ddd);
                font-size: 14px;
                box-sizing: border-box;
                outline: none;
            }
            .xzg-wf-clear-btn {
                position: absolute;
                right: 20px;
                top: 50%;
                transform: translateY(-50%);
                background: none;
                border: none;
                color: var(--fg-muted, #888);
                cursor: pointer;
                font-size: 14px;
            }
            .xzg-wf-clear-btn:hover {
                color: var(--fg, #ddd);
            }
            .xzg-wf-split-container {
                display: flex;
                flex: 1;
                overflow: hidden;
            }
            .xzg-wf-left-col {
                width: 100px;
                border-right: 1px solid var(--border-color, #444);
                overflow-y: auto;
                background: var(--comfy-input-bg, rgba(40, 40, 40, 0.5));
                flex-shrink: 0;
            }
            .xzg-wf-cat-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 12px;
                font-size: 12px;
                color: var(--fg-muted, #aaa);
                border-bottom: 1px solid var(--border-color, #444);
                font-weight: bold;
                text-transform: uppercase;
            }
            .xzg-wf-add-cat-btn {
                width: 20px;
                height: 20px;
                padding: 0;
                font-size: 16px;
                line-height: 1;
                background: transparent;
                color: #FFD700;
                border: 1px solid #FFD700;
                border-radius: 4px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.15s;
            }
            .xzg-wf-add-cat-btn:hover {
                background: rgba(255, 215, 0, 0.15);
                transform: scale(1.1);
            }
            .xzg-wf-cat-list {
                padding: 4px 0;
            }
            .xzg-wf-folder-wrapper {
                width: 100%;
            }
            .xzg-wf-folder-children {
                width: 100%;
            }
            .xzg-wf-cat-item {
                padding: 8px 12px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: background 0.15s;
                font-size: 14px;
                gap: 6px;
            }
            .xzg-wf-cat-item:hover {
                background: rgba(255, 255, 255, 0.1);
            }
            .xzg-wf-cat-item.active {
                background: rgba(255, 255, 255, 0.1);
                border-left: 2px solid var(--xzg-wf-accent, #FFD700);
                padding-left: 8px;
            }
            .xzg-wf-cat-item.xzg-wf-cat-hover {
                background: rgba(255, 255, 255, 0.1);
                border-left: 2px solid var(--xzg-wf-accent, #FFD700);
                padding-left: 8px;
            }
            .xzg-wf-cat-count {
                font-size: 12px;
                color: var(--fg-muted, #aaa);
                background: var(--comfy-input-bg, #444);
                padding: 2px 8px;
                border-radius: 10px;
                flex-shrink: 0;
            }
            .xzg-wf-cat-item.active .xzg-wf-cat-count {
                background: rgba(255, 255, 255, 0.15);
            }
            .xzg-wf-cat-name {
                display: flex;
                align-items: center;
                gap: 6px;
                flex: 1;
                min-width: 0;
                overflow: hidden;
            }
            .xzg-wf-cat-toggle {
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #FFD700;
                cursor: pointer;
                flex-shrink: 0;
                transition: transform 0.15s, color 0.15s;
            }
            .xzg-wf-cat-toggle-svg {
                width: 22px;
                height: 22px;
                stroke-width: 3px;
                transition: transform 0.15s;
            }
            .xzg-wf-cat-toggle-svg.expanded {
                transform: rotate(90deg);
            }

            .xzg-wf-cat-toggle-empty {
                visibility: hidden;
            }
            .xzg-wf-cat-icon {
                font-size: 14px;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #FFD700;
            }
            .xzg-wf-cat-icon svg {
                width: 14px;
                height: 14px;
            }
            .xzg-wf-cat-bars {
                display: flex;
                align-items: center;
                gap: 3px;
                height: 14px;
            }
            .xzg-wf-cat-bar {
                width: 4px;
                height: 100%;
                background: #FFD700;
                border-radius: 1px;
            }
            .xzg-wf-cat-label {
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .xzg-wf-cat-item.drag-over {
                background: rgba(255, 215, 0, 0.25) !important;
                border: 2px dashed #FFD700;
                border-left: none;
            }
            .xzg-wf-cat-item.xzg-wf-cat-flash {
                animation: xzg-wf-cat-flash-anim 1s ease;
            }
            @keyframes xzg-wf-cat-flash-anim {
                0% { background: rgba(255, 215, 0, 0.55); }
                100% { background: transparent; }
            }
            .xzg-wf-split-handle {
                width: 3px;
                cursor: col-resize;
                background: transparent;
                transition: background 0.15s;
                flex-shrink: 0;
            }
            .xzg-wf-split-handle:hover {
                background: #FFD700;
            }
            .xzg-wf-right-col {
                flex: 1;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                min-width: 0;
            }
            .xzg-wf-list-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 14px;
                border-bottom: 1px solid var(--border-color, #444);
                background: var(--comfy-input-bg, rgba(40, 40, 40, 0.5));
                flex-shrink: 0;
            }
            .xzg-wf-list-title {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 14px;
                font-weight: bold;
            }
            .xzg-wf-count {
                font-size: 12px;
                color: var(--fg-muted, #aaa);
            }
            .xzg-wf-sort-btns {
                display: flex;
                gap: 3px;
            }
            .xzg-wf-sort-btn {
                padding: 4px 9px;
                font-size: 13px;
                background: var(--comfy-input-bg, #2a2a2a);
                color: var(--fg-muted, #888);
                border: 1px solid var(--border-color, #444);
                border-radius: 4px;
                cursor: pointer;
                transition: all 0.15s;
            }
            .xzg-wf-sort-btn.active {
                background: var(--comfy-input-bg, #2a2a2a);
                color: #FFD700;
                border-color: #FFD700;
            }
            .xzg-wf-sort-btn-name {
                font-weight: bold;
                font-size: 15px;
            }
            .xzg-wf-list {
                flex: 1;
                overflow-y: auto;
            }
            .xzg-wf-item {
                padding: 10px 14px;
                border-bottom: 1px solid var(--border-color, #3a3a3a);
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 10px;
                transition: background 0.15s;
            }
            /* 按使用频率变化工作流名字文字颜色 */
            .xzg-wf-item.xzg-wf-use-l1 .xzg-wf-item-name,
            .xzg-wf-item.xzg-wf-use-l2 .xzg-wf-item-name,
            .xzg-wf-item.xzg-wf-use-l3 .xzg-wf-item-name,
            .xzg-wf-item.xzg-wf-use-l4 .xzg-wf-item-name,
            .xzg-wf-item.xzg-wf-use-l5 .xzg-wf-item-name {
                color: var(--xzg-use-color, #ddd);
            }
            /* 左侧 4 格图标同样按使用频率着色 */
            .xzg-wf-item.xzg-wf-use-l1 .xzg-wf-item-icon,
            .xzg-wf-item.xzg-wf-use-l2 .xzg-wf-item-icon,
            .xzg-wf-item.xzg-wf-use-l3 .xzg-wf-item-icon,
            .xzg-wf-item.xzg-wf-use-l4 .xzg-wf-item-icon,
            .xzg-wf-item.xzg-wf-use-l5 .xzg-wf-item-icon {
                color: var(--xzg-use-color, #d0d0d0);
            }
            .xzg-wf-item-icon {
                font-size: 16px;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #d0d0d0;
            }
            .xzg-wf-item-icon svg {
                width: 16px;
                height: 16px;
            }
            .xzg-wf-item:hover {
                background: rgba(255, 255, 255, 0.1);
            }
            .xzg-wf-item-info {
                flex: 1;
                min-width: 0;
            }
            .xzg-wf-item-name {
                font-size: 14px;
                color: var(--fg, #ddd);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                font-weight: 500;
            }
            .xzg-wf-item-meta {
                font-size: 12px;
                color: var(--fg-muted, #888);
                margin-top: 3px;
            }
            .xzg-wf-empty {
                padding: 40px 20px;
                text-align: center;
                color: var(--fg-muted, #888);
                font-size: 12px;
            }
            .xzg-wf-context-menu {
                position: fixed;
                z-index: 100000;
                background: var(--comfy-menu-bg, #2a2a2a);
                border: 1px solid var(--border-color, #444);
                border-radius: 6px;
                padding: 4px 0;
                min-width: 140px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
                font-size: 13px;
            }
            .xzg-wf-ctx-item {
                padding: 8px 16px;
                cursor: pointer;
                color: var(--fg, #ddd);
                transition: background 0.15s;
            }
            .xzg-wf-ctx-item:hover {
                background: rgba(255, 255, 255, 0.1);
            }
            .xzg-wf-ctx-item.danger:hover {
                background: rgba(255, 255, 255, 0.1);
            }
            .xzg-wf-ctx-separator {
                height: 1px;
                background: var(--border-color, #444);
                margin: 4px 8px;
            }
            .xzg-wf-ctx-submenu {
                position: relative;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .xzg-wf-ctx-submenu::after {
                content: "▶";
                font-size: 10px;
                color: var(--fg-muted, #888);
                margin-left: 10px;
            }

            .xzg-wf-submenu {
                position: fixed;
                z-index: 100001;
                background: var(--comfy-menu-bg, #2a2a2a);
                border: 1px solid var(--border-color, #444);
                border-radius: 6px;
                padding: 6px 0;
                min-width: 160px;
                max-height: 70vh;
                overflow-y: auto;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
                font-size: 14px;
            }
            .xzg-wf-submenu-item {
                padding: 14px 18px;
                cursor: pointer;
                color: var(--fg, #ddd);
                transition: background 0.15s;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .xzg-wf-submenu-item:hover {
                background: rgba(255, 255, 255, 0.1);
            }
            .xzg-wf-submenu-item.selected {
                color: #FFD700;
            }
            .xzg-wf-submenu-item.selected::before {
                content: "✓";
                color: #FFD700;
                font-size: 12px;
            }
            .xzg-wf-submenu-item.has-children {
                position: relative;
                justify-content: space-between;
            }
            .xzg-wf-submenu-arrow {
                font-size: 10px;
                color: var(--fg-muted, #888);
                margin-left: 10px;
                flex-shrink: 0;
            }
            .xzg-wf-submenu-item.has-children:hover .xzg-wf-submenu-arrow {
                color: #FFD700;
            }
            .xzg-wf-item.dragging {
                opacity: 0.5;
            }
            .xzg-wf-item.drag-over {
                border-top: 2px solid #FFD700;
            }
            .xzg-wf-dialog-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.6);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 100002;
            }
            .xzg-wf-dialog {
                background: var(--comfy-menu-bg, #2a2a2a);
                border: 1px solid var(--border-color, #555);
                border-radius: 8px;
                min-width: 320px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            }
            .xzg-wf-dialog-title {
                position: relative;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 14px 16px;
                font-size: 15px;
                font-weight: bold;
                color: #fff;
                border-bottom: 1px solid var(--border-color, #444);
                text-align: center;
            }
            /* 快捷键按钮置于标题栏最右侧 */
            .xzg-wf-dialog-title .xzg-wf-settings-shortcut-btn {
                position: absolute;
                right: 12px;
                top: 50%;
                transform: translateY(-50%);
                cursor: pointer;
            }
            .xzg-wf-dialog-body {
                padding: 20px 16px;
            }
            .xzg-wf-dialog-footer {
                padding: 12px 16px;
                border-top: 1px solid var(--border-color, #444);
                display: flex;
                justify-content: center;
                gap: 10px;
            }
            .xzg-wf-settings-footer {
                justify-content: space-between;
            }
            .xzg-wf-settings-footer .xzg-wf-settings-actions {
                flex: 1;
                justify-content: space-between;
            }
            .xzg-wf-settings-footer .xzg-wf-settings-actions .xzg-wf-dialog-btn-cancel,
            .xzg-wf-settings-footer .xzg-wf-settings-actions .xzg-wf-dialog-btn-confirm {
                background: transparent;
                font-weight: normal;
            }
            .xzg-wf-settings-footer .xzg-wf-settings-actions .xzg-wf-dialog-btn-cancel:hover,
            .xzg-wf-settings-footer .xzg-wf-settings-actions .xzg-wf-dialog-btn-confirm:hover:not(:disabled) {
                background: rgba(255, 255, 255, 0.1);
            }
            .xzg-wf-settings-io,
            .xzg-wf-settings-actions {
                display: flex;
                gap: 10px;
                position: relative;
            }
            .xzg-wf-config-menu {
                position: absolute;
                bottom: calc(100% + 6px);
                left: 0;
                display: flex;
                flex-direction: column;
                gap: 4px;
                padding: 6px;
                background: #2a2a2a;
                border: 1px solid rgba(255, 215, 0, 0.4);
                border-radius: 6px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
                z-index: 10;
            }
            .xzg-wf-config-menu[hidden] {
                display: none;
            }
            .xzg-wf-config-menu-item {
                white-space: nowrap;
                height: 30px;
                padding: 0 14px;
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 4px;
                color: #eee;
                cursor: pointer;
                font-size: 13px;
            }
            .xzg-wf-config-menu-item:hover {
                background: rgba(255, 255, 255, 0.1);
            }
            .xzg-wf-dialog-btn {
                padding: 6px 16px;
                font-size: 13px;
                background: var(--comfy-input-bg, #3a3a3a);
                color: var(--fg, #ddd);
                border: 1px solid var(--border-color, #555);
                border-radius: 4px;
                cursor: pointer;
                transition: all 0.15s;
            }
            .xzg-wf-dialog-btn:hover {
                background: rgba(255, 255, 255, 0.1);
            }
            .xzg-wf-dialog-btn-cancel {
                background: var(--comfy-input-bg, #3a3a3a);
                color: var(--fg, #ddd);
            }
            .xzg-wf-dialog-btn-confirm {
                background: #4a4a4a;
                color: #fff;
                border-color: #666;
                font-weight: bold;
            }
            .xzg-wf-dialog-btn-confirm:hover:not(:disabled) {
                background: rgba(255, 255, 255, 0.1);
            }
            .xzg-wf-dialog-btn-confirm:disabled {
                opacity: 0.4;
                cursor: not-allowed;
            }
            .xzg-wf-shortcut-btn {
                color: #ddd !important;
                border-color: #666 !important;
            }
            .xzg-wf-dialog-input {
                width: 100%;
                box-sizing: border-box;
                padding: 8px 10px;
                font-size: 14px;
                background: var(--comfy-input-bg, #3a3a3a);
                color: var(--fg, #ddd);
                border: 1px solid var(--border-color, #555);
                border-radius: 4px;
                outline: none;
            }
            .xzg-wf-dialog-input:focus {
                border-color: #FFD700;
            }
            .xzg-wf-help-dialog {
                min-width: 440px;
                max-width: 560px;
                max-height: 86vh;
            }
            .xzg-wf-help-body {
                max-height: 64vh;
                overflow-y: auto;
                text-align: left;
                font-size: 13px;
                line-height: 1.7;
                color: var(--fg, #ddd);
                padding: 16px 18px;
            }
            .xzg-wf-help-body h4 {
                margin: 16px 0 6px;
                font-size: 14px;
                color: var(--xzg-wf-accent, #FFD700);
                border-bottom: 1px solid var(--border-color, #444);
                padding-bottom: 4px;
            }
            .xzg-wf-help-body h4:first-child { margin-top: 0; }
            .xzg-wf-help-body ul { margin: 4px 0; padding-left: 20px; }
            .xzg-wf-help-body li { margin: 3px 0; }
            .xzg-wf-help-body b { color: var(--xzg-wf-accent, #FFD700); }
            .xzg-wf-help-body code {
                background: rgba(255, 255, 255, 0.1);
                padding: 1px 5px;
                border-radius: 3px;
                font-size: 12px;
            }
            .xzg-wf-shortcut-btn:hover {
                background: rgba(255, 255, 255, 0.1) !important;
            }
            /* 主题与频率设置面板 */
            .xzg-wf-settings-overlay { background: transparent; }
            .xzg-wf-settings-dialog { min-width: 240px; max-width: 280px; }
            .xzg-wf-settings-dialog .xzg-wf-dialog-body {
                display: flex;
                flex-direction: column;
                align-items: stretch;
                gap: 16px;
            }
            .xzg-wf-settings-section { margin-bottom: 0; }
            .xzg-wf-settings-sec-title {
                font-size: 13px;
                color: var(--fg, #ddd);
            }
            .xzg-wf-settings-accent-row {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .xzg-wf-settings-accent-row input[type="color"] {
                width: 45px;
                height: 24px;
                padding: 0;
                border: 1px solid var(--border-color, #555);
                border-radius: 6px;
                background: var(--comfy-input-bg, #3a3a3a);
                cursor: pointer;
            }
            .xzg-wf-use-row {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 8px;
            }
            .xzg-wf-use-row:last-child { margin-bottom: 0; }
            .xzg-wf-use-rank {
                width: 18px;
                height: 18px;
                line-height: 18px;
                text-align: center;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.1);
                font-size: 12px;
                flex-shrink: 0;
            }
            .xzg-wf-use-row input[type="color"] {
                width: 41px;
                height: 28px;
                padding: 0;
                border: 1px solid var(--border-color, #555);
                border-radius: 4px;
                background: var(--comfy-input-bg, #3a3a3a);
                cursor: pointer;
            }
            .xzg-wf-use-threshold {
                width: 64px;
                padding: 5px 8px;
                font-size: 13px;
                text-align: center;
                background: var(--comfy-input-bg, #3a3a3a);
                color: var(--fg, #ddd);
                border: 1px solid var(--border-color, #555);
                border-radius: 4px;
                outline: none;
            }
            .xzg-wf-use-threshold::-webkit-outer-spin-button,
            .xzg-wf-use-threshold::-webkit-inner-spin-button {
                -webkit-appearance: none;
                margin: 0;
            }
            .xzg-wf-use-threshold { -moz-appearance: textfield; }
            .xzg-wf-use-label {
                font-size: 13px;
                color: var(--fg, #ddd);
                white-space: nowrap;
            }
            .xzg-wf-use-switch {
                display: flex;
                align-items: center;
                justify-content: flex-start;
                gap: 8px;
                margin-bottom: 16px;
                font-size: 13px;
                color: var(--fg, #ddd);
                cursor: pointer;
                user-select: none;
                width: auto;
                flex-wrap: nowrap;
            }
            .xzg-wf-use-switch.xzg-wf-possess-flag.active .xzg-wf-toggle {
                background: #4CAF50;
            }
            /* 夺舍模式是该节唯一内容，去掉自身底部外边距，避免与下一节间距翻倍 */
            .xzg-wf-use-switch.xzg-wf-possess-flag { margin-bottom: 0; }
            .xzg-wf-possess-flag .xzg-wf-possess-desc {
                margin-left: auto;
                font-size: 12px;
                color: var(--fg-muted, #888);
                white-space: nowrap;
            }
            .xzg-wf-settings-shortcut-row {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .xzg-wf-settings-shortcut-btn {
                padding: 5px 12px;
                font-size: 13px;
                border-radius: 6px;
                border: 1px solid var(--border-color, #555);
                background: var(--comfy-input-bg, #3a3a3a);
                color: var(--fg, #ddd);
                cursor: pointer;
            }
            .xzg-wf-use-switch .xzg-wf-toggle {
                width: 40px;
                height: 22px;
                border-radius: 11px;
            }
            .xzg-wf-use-switch .xzg-wf-toggle i {
                width: 18px;
                height: 18px;
                top: 2px;
                left: 2px;
            }
            .xzg-wf-use-switch.active .xzg-wf-toggle {
                background: #4CAF50;
            }
            .xzg-wf-use-switch.active .xzg-wf-toggle i {
                left: 20px;
                background: #fff;
            }
        `;
        style.textContent = this._applyAccent(css);

        document.head.appendChild(style);
    }

    _applyAccent(css) {
        return css
            .replaceAll('#FFD700', 'var(--xzg-wf-accent, #FFD700)')
            .replaceAll('#ffed4e', 'color-mix(in srgb, var(--xzg-wf-accent) 80%, #fff)')
            .replaceAll('#FFA500', 'color-mix(in srgb, var(--xzg-wf-accent) 70%, #000)')
            .replaceAll('rgba(255, 215, 0, 0.15)', 'color-mix(in srgb, var(--xzg-wf-accent) 15%, transparent)')
            .replaceAll('rgba(255, 215, 0, 0.25)', 'color-mix(in srgb, var(--xzg-wf-accent) 25%, transparent)')
            .replaceAll('rgba(255, 215, 0, 0.4)', 'color-mix(in srgb, var(--xzg-wf-accent) 40%, transparent)')
            .replaceAll('rgba(255, 215, 0, 0.1)', 'color-mix(in srgb, var(--xzg-wf-accent) 10%, transparent)')
            .replaceAll('rgba(255, 215, 0, 0.3)', 'color-mix(in srgb, var(--xzg-wf-accent) 30%, transparent)');
    }

    applyAccentColor(color) {
        if (!color) color = "#FFD700";
        document.documentElement.style.setProperty("--xzg-wf-accent", color);
        try { localStorage.setItem(ACCENT_KEY, color); } catch (e) {}
    }

    showSettingsDialog() {
        const dialog = document.createElement("div");
        dialog.className = "xzg-wf-dialog-overlay xzg-wf-settings-overlay";
        dialog.dataset.xzgRole = "settings";
        const cfg = this.meta.useColors || DEFAULT_USE_COLORS;
        const rows = cfg.map((item, i) => `
            <div class="xzg-wf-use-row">
                <span class="xzg-wf-use-rank">${i + 1}</span>
                <input type="color" class="xzg-wf-use-color" data-idx="${i}" value="${item.color}" />
                <span class="xzg-wf-use-label">${xzgT('超过', 'over')}</span>
                <input type="number" class="xzg-wf-use-threshold" data-idx="${i}" value="${item.threshold}" min="0" step="1" />
                <span class="xzg-wf-use-label">${xzgT('次', 'times')}</span>
            </div>
        `).join("");

        const possessOn = localStorage.getItem("xzg_possess_mode") === "1";
        const sc = this.getShortcut();
        const scParts = [];
        if (sc.ctrl) scParts.push("Ctrl");
        if (sc.alt) scParts.push("Alt");
        if (sc.shift) scParts.push("Shift");
        if (sc.meta) scParts.push("Meta");
        scParts.push((sc.key || "`").toUpperCase());
        const shortcutText = xzgT('快捷键','Shortcut') + ": " + scParts.join("+");

        dialog.innerHTML = this._applyAccent(`
            <div class="xzg-wf-dialog xzg-wf-settings-dialog">
                <div class="xzg-wf-dialog-title">
                    <span>${xzgT('设置', 'Settings')}</span>
                    <button class="xzg-wf-settings-shortcut-btn" id="xzg-wf-shortcut-btn">${shortcutText}</button>
                </div>
                <div class="xzg-wf-dialog-body">
                    <div class="xzg-wf-settings-section">
                        <div class="xzg-wf-use-switch xzg-wf-possess-flag ${possessOn ? 'active' : ''}" id="xzg-wf-possess-btn">
                            <span>${xzgT('夺舍模式','Possess Mode')}</span>
                            <span class="xzg-wf-toggle"><i></i></span>
                            <span class="xzg-wf-possess-desc">${xzgT('关闭左侧默认工作流按钮','Hides the default workflow button on the left')}</span>
                        </div>
                    </div>
                    <div class="xzg-wf-settings-section">
                        <div class="xzg-wf-settings-accent-row xzg-wf-settings-sec-title">
                            <span>${xzgT('面板主题色', 'Panel Accent Color')}</span>
                            <input type="color" id="xzg-wf-accent-input" value="" />
                        </div>
                    </div>
                    <div class="xzg-wf-settings-section">
                        <div class="xzg-wf-use-switch ${this.meta.useColorsEnabled !== false ? 'active' : ''}" id="xzg-wf-use-toggle">
                            <span>${xzgT('根据使用频率变色', 'Color by usage frequency')}</span>
                            <span class="xzg-wf-toggle"><i></i></span>
                        </div>
                        ${rows}
                    </div>
                </div>
                <div class="xzg-wf-dialog-footer xzg-wf-settings-footer">
                    <div class="xzg-wf-settings-actions">
                        <button class="xzg-wf-dialog-btn xzg-wf-dialog-btn-cancel" id="xzg-wf-settings-reset">${xzgT('恢复默认', 'Reset')}</button>
                        <button class="xzg-wf-dialog-btn xzg-wf-dialog-btn-confirm" id="xzg-wf-settings-close">${xzgT('完成', 'Done')}</button>
                    </div>
                </div>
            </div>
        `);
        document.body.appendChild(dialog);

        const accentInput = dialog.querySelector("#xzg-wf-accent-input");
        if (accentInput) {
            accentInput.value = localStorage.getItem(ACCENT_KEY) || "#FFD700";
            accentInput.addEventListener("input", (e) => this.applyAccentColor(e.target.value));
        }

        const useToggle = dialog.querySelector("#xzg-wf-use-toggle");
        if (useToggle) {
            useToggle.addEventListener("click", () => {
                const on = this.meta.useColorsEnabled === false; // 切换：当前关 -> 开
                this.meta.useColorsEnabled = on;
                useToggle.classList.toggle("active", on);
                this.saveMeta();
                this.renderWorkflowList();
            });
        }

        const possessBtn = dialog.querySelector("#xzg-wf-possess-btn");
        if (possessBtn) {
            possessBtn.addEventListener("click", () => this.togglePossessMode());
        }
        const shortcutBtn = dialog.querySelector("#xzg-wf-shortcut-btn");
        if (shortcutBtn) {
            shortcutBtn.addEventListener("mousedown", (e) => e.stopPropagation());
            shortcutBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.showShortcutDialog();
            });
        }

        // 允许拖动设置面板（按住标题栏）
        const dragPanel = dialog.querySelector(".xzg-wf-dialog");
        const dragHandle = dialog.querySelector(".xzg-wf-dialog-title");
        if (dragPanel && dragHandle) {
            let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
            dragHandle.style.cursor = "move";
            dragHandle.addEventListener("mousedown", (e) => {
                dragging = true;
                const r = dragPanel.getBoundingClientRect();
                dragPanel.style.position = "fixed";
                dragPanel.style.margin = "0";
                dragPanel.style.left = r.left + "px";
                dragPanel.style.top = r.top + "px";
                startX = e.clientX;
                startY = e.clientY;
                origX = r.left;
                origY = r.top;
                e.preventDefault();
            });
            window.addEventListener("mousemove", (e) => {
                if (!dragging) return;
                dragPanel.style.left = (origX + e.clientX - startX) + "px";
                dragPanel.style.top = (origY + e.clientY - startY) + "px";
            });
            window.addEventListener("mouseup", () => { dragging = false; });
        }

        // 调色/调阈值时整列表重建 + 写盘很重；拖动取色器会高频触发 input，故防抖批处理。
        // 预览块即时更新（很轻量），真正的列表重渲染与存储延迟到停顿后执行。
        let renderTimer = null;
        const scheduleCommit = () => {
            if (renderTimer) clearTimeout(renderTimer);
            renderTimer = setTimeout(() => {
                renderTimer = null;
                this.saveMeta();
                this.renderWorkflowList();
            }, 120);
        };

        dialog.querySelectorAll(".xzg-wf-use-color").forEach(inp => {
            inp.addEventListener("input", (e) => {
                const idx = +e.target.dataset.idx;
                if (this.meta.useColors[idx]) {
                    this.meta.useColors[idx].color = e.target.value;
                    scheduleCommit();
                }
            });
        });
        dialog.querySelectorAll(".xzg-wf-use-threshold").forEach(inp => {
            inp.addEventListener("input", (e) => {
                const idx = +e.target.dataset.idx;
                if (this.meta.useColors[idx]) {
                    const v = parseInt(e.target.value, 10);
                    this.meta.useColors[idx].threshold = isNaN(v) ? 0 : v;
                    scheduleCommit();
                }
            });
        });

        dialog.querySelector("#xzg-wf-settings-reset").addEventListener("click", () => {
            this.meta.useColors = DEFAULT_USE_COLORS.map(x => ({ ...x }));
            this.meta.useColorsEnabled = true;
            this.applyAccentColor("#FFD700");
            this.saveMeta();
            dialog.remove();
            this.showSettingsDialog();
        });

        const close = () => {
            if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
            this.saveMeta();
            this.renderWorkflowList();
            dialog.remove();
        };
        dialog.querySelector("#xzg-wf-settings-close").addEventListener("click", close);
        dialog.addEventListener("mousedown", (e) => { if (e.target === dialog) close(); });
    }

    bindPanelEvents() {
        const container = this.container;

        const searchInput = container.querySelector(".xzg-wf-search-input");
        const clearBtn = container.querySelector(".xzg-wf-clear-btn");

        searchInput.addEventListener("input", (e) => {
            const val = e.target.value.replace(/\s/g, '').toLowerCase();
            this.currentSearch = val;
            clearBtn.style.display = e.target.value ? "block" : "none";
            this.renderWorkflowList();
        });

        clearBtn.addEventListener("click", () => {
            searchInput.value = "";
            this.currentSearch = "";
            clearBtn.style.display = "none";
            this.renderWorkflowList();
            searchInput.focus();
        });

        // 一旦在面板内做任何操作（点击分类/工作流/排序等，且不在搜索框内），取消搜索框聚焦
        container.addEventListener("mousedown", (e) => {
            if (e.target.closest(".xzg-wf-search-box")) return;
            if (this.searchInput && document.activeElement === this.searchInput) {
                this.searchInput.blur();
            }
        });

        container.querySelectorAll(".xzg-wf-sort-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                container.querySelectorAll(".xzg-wf-sort-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                this.sortMode = btn.dataset.sort;
                this.meta.sortMode = this.sortMode;
                this.saveMeta();
                this.renderWorkflowList();
            });
            if (btn.dataset.sort === "default") {
                btn.addEventListener("contextmenu", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.hideContextMenu();
                    const menu = document.createElement("div");
                    menu.className = "xzg-wf-context-menu";
                    menu.innerHTML = `
                        <div class="xzg-wf-ctx-item danger" data-action="clear-usage">🧹 ${xzgT('清空使用频率','Clear Usage Frequency')}</div>
                    `;
                    document.body.appendChild(menu);
                    const x = e.clientX;
                    const y = e.clientY;
                    const rect = menu.getBoundingClientRect();
                    const vw = window.innerWidth;
                    const vh = window.innerHeight;
                    let left = x;
                    let top = y;
                    if (x + rect.width > vw) {
                        left = vw - rect.width - 5;
                    }
                    if (y + rect.height > vh) {
                        top = vh - rect.height - 5;
                    }
                    menu.style.left = left + "px";
                    menu.style.top = top + "px";
                    this._contextMenu = menu;
                    menu.querySelectorAll(".xzg-wf-ctx-item").forEach(item => {
                        item.addEventListener("click", (ev) => {
                            ev.stopPropagation();
                            const action = item.dataset.action;
                            this.hideContextMenu();
                            if (action === "clear-usage") {
                                this.clearUsageFrequency();
                            }
                        });
                    });
                    const closeHandler = (ev) => {
                        if (!menu.contains(ev.target)) {
                            this.hideContextMenu();
                            document.removeEventListener("mousedown", closeHandler);
                            document.removeEventListener("keydown", keyHandler);
                        }
                    };
                    const keyHandler = (ev) => {
                        if (ev.key === "Escape") {
                            this.hideContextMenu();
                            document.removeEventListener("mousedown", closeHandler);
                            document.removeEventListener("keydown", keyHandler);
                        }
                    };
                    setTimeout(() => {
                        document.addEventListener("mousedown", closeHandler);
                        document.addEventListener("keydown", keyHandler);
                    }, 0);
                });
            }
        });

        // 启动时应用已保存的主题强调色
        this.applyAccentColor(localStorage.getItem(ACCENT_KEY) || "#FFD700");

        const settingsBtn = container.querySelector("#xzg-wf-settings-btn");
        if (settingsBtn) {
            settingsBtn.addEventListener("click", () => this.showSettingsDialog());
        }

        const trashBtn = container.querySelector("#xzg-wf-trash-btn");
        if (trashBtn) {
            trashBtn.addEventListener("click", () => {
                this.openTrashModal();
            });
        }

        const helpBtn = container.querySelector("#xzg-wf-help-btn");
        if (helpBtn) {
            helpBtn.addEventListener("click", () => this.showWorkflowHelp());
        }

        this.updateShortcutDisplay();
        this.initPossessMode();

    }

    /** 工作流管理使用说明弹窗 */
    showWorkflowHelp() {
        const dialog = document.createElement("div");
        dialog.className = "xzg-wf-dialog-overlay";
        dialog.dataset.xzgRole = "help";
        const html = `
            <div class="xzg-wf-dialog xzg-wf-help-dialog">
                <div class="xzg-wf-dialog-title">${xzgT('工作流管理 · 使用说明', 'Workflow Manager · Help')}</div>
                <div class="xzg-wf-dialog-body xzg-wf-help-body">
                    <h4>${xzgT('打开面板', 'Open Panel')}</h4>
                    <ul>
                        <li>${xzgT('快捷键：默认 ` （反引号），可点顶部「快捷键」按钮自定义', 'Shortcut: default ` (backtick); click the top "Shortcut" button to customize')}</li>
                    </ul>
                    <h4>${xzgT('工作流操作', 'Workflow Operations')}</h4>
                    <ul>
                        <li><b>${xzgT('打开', 'Open')}</b>：${xzgT('单击工作流项，加载到当前画布并激活对应官方工作流（已打开的仅切换、不重复加载）', 'Click a workflow to load it onto the current canvas and activate the corresponding official workflow (already-open ones just switch, without reloading)')}</li>
                        <li><b>${xzgT('导入到画布', 'Import to Canvas')}</b>：${xzgT('直接拖拽工作流项到画布空白处，节点即被导入当前工作流；点击工作流则是新建标签打开，与官方一致。', 'Drag a workflow item onto an empty canvas area to import its nodes into the current workflow; clicking a workflow opens it in a new tab, same as official behavior.')}</li>
                        <li><b>${xzgT('定位分类', 'Locate Category')}</b>：${xzgT('单击工作流项左侧的四个圆点图标，左侧分类树会自动展开并高亮其所属分类', 'Click the four-dot icon on the left of a workflow; the category tree auto-expands and highlights its category')}</li>
                        <li><b>${xzgT('右键菜单', 'Right-click Menu')}</b>：
                            <ul>
                                <li>✏️ ${xzgT('重命名：修改显示名称，保留你手工加的编号前缀', 'Rename: change the display name, keeping any manual numbering prefix')}</li>
                                <li>🗑️ ${xzgT('删除：移入回收站，可恢复', 'Delete: moved to recycle bin, recoverable')}</li>
                                <li>📁 ${xzgT('移动到分类：在子菜单中选择目标文件夹或「未分类」', 'Move to Category: choose a target folder or "Uncategorized" in the submenu')}</li>
                            </ul>
                        </li>
                    </ul>
                    <h4>${xzgT('分类管理（左侧）', 'Category Management (Left)')}</h4>
                    <ul>
                        <li><b>${xzgT('全部', 'All')}</b> / <b>${xzgT('根目录未分类', 'Root / Uncategorized')}</b>：${xzgT('分别显示所有、及未归入文件夹的工作流', 'Show all, or only workflows not assigned to a folder')}</li>
                        <li><b>${xzgT('新建分类', 'New Category')}</b>：${xzgT('右键「全部」→ 新建分类；右键文件夹可新建子分类（支持多级嵌套），改动会直接应用到本地文件夹', 'Right-click "All" → New Category; right-click a folder to create a subcategory (multi-level nesting supported); changes apply directly to local folders')}</li>
                        <li><b>${xzgT('重命名 / 删除分类', 'Rename / Delete Category')}</b>：${xzgT('右键文件夹操作；删除分类会将其下工作流一并移入回收站', 'Right-click a folder; deleting a category moves all its workflows to the recycle bin')}</li>
                        <li><b>${xzgT('筛选', 'Filter')}</b>：${xzgT('单击分类项，右侧只显示该分类的工作流', 'Click a category to show only its workflows on the right')}</li>
                    </ul>
                    <h4>${xzgT('搜索', 'Search')}</h4>
                    <ul>
                        <li>${xzgT('顶部搜索框实时过滤；支持拼音（首字母 + 完整拼音），自动忽略空格', 'The top search box filters in real time; supports pinyin (initials + full pinyin) and ignores spaces automatically')}</li>
                        <li>${xzgT('例如输入 txlj 匹配「图像连接」；tuxiang 同样匹配', 'e.g. t.x.l.j matches "图像连接"; t.u.x.i.a.n.g matches too')}</li>
                    </ul>
                    <h4>${xzgT('排序', 'Sort')}</h4>
                    <ul>
                        <li>🔥 ${xzgT('使用频率：使用次数', 'Usage frequency: by usage count')}</li>
                        <li>A ${xzgT('名称：按名称字母 / 拼音顺序', 'Name: alphabetical / pinyin order')}</li>
                        <li>${xzgT('拖拽工作流到画布不增加使用频率，仅单击打开会计数', 'Dragging a workflow to the canvas does not increase usage; only opening by click counts')}</li>
                    </ul>
                    <h4>${xzgT('回收站', 'Recycle Bin')}</h4>
                    <ul>
                        <li>${xzgT('误删的工作流会进入回收站，可在此恢复', 'Accidentally deleted workflows go to the recycle bin and can be restored here')}</li>
                        <li>${xzgT('回收站保留 3 个月，过期自动清理（不可手动清空）', 'The recycle bin keeps items for 3 months, then auto-cleans (cannot be manually emptied)')}</li>
                    </ul>
                    <h4>${xzgT('其它设置', 'Other Settings')}</h4>
                    <ul>
                        <li><b>${xzgT('设置', 'Settings')}</b>：${xzgT('自定义面板强调色、使用频率配色、快捷键与夺舍模式', 'Customize panel accent color, usage-frequency colors, shortcut and possess mode')}</li>
                        <li><b>${xzgT('夺舍模式', 'Possess Mode')}</b>：${xzgT('开启后隐藏 ComfyUI 官方工作流管理按钮，由本面板接管', 'Once enabled, hides ComfyUI official workflow buttons and takes over')}</li>
                        <li><b>${xzgT('保存工作流', 'Save Workflow')}</b>：${xzgT('使用 ComfyUI 官方保存（Ctrl+S / 顶栏），保存后本面板会自动同步显示', 'Use ComfyUI official save (Ctrl+S / top bar); the panel auto-syncs after saving')}</li>
                    </ul>
                </div>
                <div class="xzg-wf-dialog-footer">
                    <button class="xzg-wf-dialog-btn xzg-wf-dialog-btn-confirm" id="xzg-wf-help-close">${xzgT('明白了','Got it')}</button>
                </div>
            </div>
        `;
        dialog.innerHTML = this._applyAccent(html);
        document.body.appendChild(dialog);

        const close = () => {
            document.removeEventListener("keydown", onKey, true);
            dialog.remove();
        };
        dialog.querySelector("#xzg-wf-help-close").addEventListener("click", close);
        dialog.addEventListener("click", (e) => {
            if (e.target === dialog) close();
        });
        const onKey = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
            }
        };
        document.addEventListener("keydown", onKey, true);
    }

    // ====== 夺舍模式：隐藏官方工作流管理按钮 ======
    initPossessMode() {
        const on = localStorage.getItem("xzg_possess_mode") === "1";
        document.querySelectorAll(".xzg-wf-possess-flag").forEach(el => el.classList.toggle("active", on));
        this._applyPossessMode(on);
    }

    togglePossessMode() {
        const on = localStorage.getItem("xzg_possess_mode") !== "1";
        localStorage.setItem("xzg_possess_mode", on ? "1" : "0");
        document.querySelectorAll(".xzg-wf-possess-flag").forEach(el => el.classList.toggle("active", on));
        this._applyPossessMode(on);
    }

    _applyPossessMode(on) {
        this._setOfficialWorkflowButtonsHidden(on);
        // 官方 UI 可能晚于本扩展渲染，用防抖的 MutationObserver 兜底持续隐藏，
        // 并在 DOM 变动停止后做一次最终隐藏，避免按钮残留可见
        if (!this._possessObserver) {
            this._possessObserver = new MutationObserver(() => {
                const cur = localStorage.getItem("xzg_possess_mode") === "1";
                if (this._possessTimer) clearTimeout(this._possessTimer);
                this._possessTimer = setTimeout(() => {
                    this._setOfficialWorkflowButtonsHidden(cur);
                }, 120);
            });
            if (document.body) {
                this._possessObserver.observe(document.body, { childList: true, subtree: true });
            }
        }
    }

    _setOfficialWorkflowButtonsHidden(hidden) {
        const targets = this._findOfficialWorkflowButtons();
        targets.forEach(el => {
            if (hidden) {
                if (el.style.display !== "none") {
                    el.dataset.xzgHidden = el.style.display || "";
                    el.style.display = "none";
                }
            } else if (el.dataset.xzgHidden !== undefined) {
                el.style.display = el.dataset.xzgHidden;
                delete el.dataset.xzgHidden;
            }
        });
    }

    _findOfficialWorkflowButtons() {
        const out = [];
        const keywords = ["workflow", "工作流"];
        const xzgContainer = this.container;
        const xzgPanel = this._panelEl;
        const isXzg = (el) => {
            if (!el) return false;
            if (el.classList && (
                el.classList.contains("xiaozhuguang-workflows-tab-button") ||
                el.classList.contains("xiaozhuguang-workflows")
            )) return true;
            if (xzgContainer && xzgContainer.contains(el)) return true;
            if (xzgPanel && xzgPanel.contains(el)) return true;
            return false;
        };
        const candidates = new Set();
        // 确定性目标：官方「工作流」侧边栏标签按钮（位于小珠光标签正下方）
        const wfTab = document.querySelector(".workflows-tab-button");
        if (wfTab) candidates.add(wfTab);
        // 仅在侧边栏区域内扫描，避免误伤画布上方的工作流切换标签
        document.querySelectorAll(
            "#comfyui-sidebar, .comfyui-sidebar, .sidebar, .sidebar-item-group"
        ).forEach(sb => {
            sb.querySelectorAll(
                "button, [role='button'], .p-chip, .comfyui-button, .menu-item, .cm-item, " +
                ".comfy-menu-btn, .top-menu-item, .chip, .litegraph-button, .side-bar-button"
            ).forEach(el => candidates.add(el));
        });
        candidates.forEach(el => {
            if (isXzg(el)) return;
            const t = (el.textContent || "").trim().toLowerCase();
            if (keywords.some(k => t.includes(k))) out.push(el);
        });
        return out;
    }

    // ====== 回收站 (A) ======
    async openTrashModal() {
        try {
            const res = await api.fetchApi("/xzg/wf-manage/trash", { cache: "no-store" });
            if (!res.ok) throw new Error("获取回收站失败");
            const data = await res.json();
            const items = data.items || [];

            let modal = document.getElementById("xzg-wf-trash-modal");
            if (!modal) {
                modal = document.createElement("div");
                modal.id = "xzg-wf-trash-modal";
                modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;z-index:99999;";
                document.body.appendChild(modal);
            }
            modal.innerHTML = `
                <div style="background:var(--comfy-menu-bg,#2a2a2a);color:var(--fg,#ddd);width:480px;max-width:90vw;max-height:80vh;overflow:auto;border:1px solid var(--border-color,#555);border-radius:8px;padding:16px;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border-color,#444);">
                        <strong style="font-size:15px;">${xzgT('回收站', 'Recycle Bin')}</strong>
                        <span id="xzg-wf-trash-close" style="cursor:pointer;font-size:20px;line-height:1;padding:0 4px;">✕</span>
                    </div>
                    <div id="xzg-wf-trash-body"></div>
                    <div style="margin-top:12px;font-size:11px;color:#999;text-align:center;">${xzgT('回收站保留 3 个月，过期项目自动清理（不可手动清空）', 'The recycle bin keeps items for 3 months, then auto-cleans expired items (cannot be manually emptied)')}</div>
                </div>
            `;
            modal.style.display = "flex";

            const body = modal.querySelector("#xzg-wf-trash-body");
            if (items.length === 0) {
                body.innerHTML = `<div style="color:#999;padding:12px 0;text-align:center;">${xzgT('回收站为空','Recycle bin is empty')}</div>`;
            } else {
                body.innerHTML = items.map(it => {
                    const daysLeft = (it.days_left == null) ? "" : ` · 剩 ${it.days_left} 天`;
                    return `
                    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                        <div style="flex:1;min-width:0;">
                            <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📄 ${this.escapeHtml(it.name)}</div>
                            <div style="font-size:11px;color:#999;">原路径: ${this.escapeHtml(it.original_path)} · ${this.escapeHtml(it.deleted_at)}${daysLeft}</div>
                        </div>
                        <button data-restore="${this.escapeHtml(it.id)}" style="background:#3a6;color:#fff;border:none;border-radius:4px;padding:5px 10px;cursor:pointer;">${xzgT('恢复','Restore')}</button>
                    </div>
                `;}).join("");
                body.querySelectorAll("[data-restore]").forEach(btn => {
                    btn.addEventListener("click", async () => {
                        await this.restoreTrashItem(btn.dataset.restore);
                    });
                });
            }

            modal.querySelector("#xzg-wf-trash-close").addEventListener("click", () => this.closeTrashModal());
            modal.addEventListener("click", (e) => {
                if (e.target === modal) this.closeTrashModal();
            });
        } catch (e) {
            console.warn("[小珠光] 打开回收站失败:", e);
            alert(xzgT('打开回收站失败: ','Failed to open recycle bin: ') + e.message);
        }
    }

    closeTrashModal() {
        const modal = document.getElementById("xzg-wf-trash-modal");
        if (modal) modal.style.display = "none";
    }

    async restoreTrashItem(id) {
        try {
            const res = await api.fetchApi("/xzg/wf-manage/restore", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (data.conflict) {
                    alert(xzgT('恢复失败：目标位置已存在同名文件，请先手动处理。','Restore failed: a file with the same name already exists at the target location. Please handle it manually.'));
                } else {
                    alert(xzgT('恢复失败: ','Restore failed: ') + (data.error || res.status));
                }
                return;
            }
            this.closeTrashModal();
            await this.loadWorkflows();
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.loadWorkflows) { try { await wfStore.loadWorkflows(); } catch (e) {} }
        } catch (e) {
            alert(xzgT('恢复失败: ','Restore failed: ') + e.message);
        }
    }

    escapeHtml(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[c]));
    }

    setupSplitResizing() {
        const handle = this.container.querySelector(".xzg-wf-split-handle");
        const leftCol = this.container.querySelector(".xzg-wf-left-col");
        let isResizing = false;
        let startX, startWidth;

        const savedWidth = parseInt(localStorage.getItem("xzg_wf_left_col_width"));
        if (savedWidth && savedWidth >= 80 && savedWidth <= 300) {
            leftCol.style.width = savedWidth + "px";
        }

        handle.addEventListener("mousedown", (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = leftCol.offsetWidth;
            e.preventDefault();
        });

        document.addEventListener("mousemove", (e) => {
            if (!isResizing) return;
            const newWidth = Math.max(80, Math.min(300, startWidth + (e.clientX - startX)));
            leftCol.style.width = newWidth + "px";
        });

        document.addEventListener("mouseup", () => {
            if (isResizing) {
                isResizing = false;
                localStorage.setItem("xzg_wf_left_col_width", leftCol.offsetWidth.toString());
            }
        });
    }

    /** 同步刷新 ComfyUI 官方 workflow store，保证拖拽/重命名后官方工作流路径与实际磁盘一致 */
    async _refreshOfficialStore() {
        try {
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.loadWorkflows) await wfStore.loadWorkflows();
        } catch (e) {
            console.warn("[小珠光] 刷新官方工作流列表失败:", e);
        }
    }

    async loadWorkflows() {
        try {
            const res = await api.fetchApi("/xzg/wf-manage/list", { cache: "no-store" });
            const tree = await res.json();
            this.tree = tree;
            this.workflows = this.flattenTree(tree);
            this.syncCategories();
            this.renderCategories();
            this.renderWorkflowList();
        } catch (e) {
            console.warn("[小珠光] 加载工作流列表失败:", e);
            this.workflows = [];
            return;
        }
        // 同步官方 store，保证本扩展面板与官方面板的工作流路径一致
        await this._refreshOfficialStore();
        // 说明：已彻底移除分类自动/手动排序重命名。分类按名称自然排列，永不改动磁盘文件夹名。
    }

    flattenTree(tree, parentPath = "") {
        let result = [];
        for (const item of tree) {
            if (item.type === "folder") {
                result = result.concat(this.flattenTree(item.children || [], item.path));
            } else {
                const meta = this.getWorkflowMeta(item.path);
                result.push({
                    ...item,
                    folder: parentPath || "未分类",
                    useCount: meta.useCount || 0,
                    lastUsed: meta.lastUsed || 0,
                    categoryId: meta.categoryId || null
                });
            }
        }
        return result;
    }

    getAllFolders(tree, parentPath = "") {
        let folders = [];
        for (const item of tree) {
            if (item.type === "folder") {
                const fullPath = parentPath ? parentPath + "/" + item.name : item.name;
                folders.push(fullPath);
                folders = folders.concat(this.getAllFolders(item.children || [], fullPath));
            }
        }
        return folders;
    }

    syncCategories() {
        const folderSet = new Set();
        if (this.tree) {
            const allFolders = this.getAllFolders(this.tree);
            for (const f of allFolders) {
                folderSet.add(f);
            }
        }
        for (const wf of this.workflows) {
            if (wf.folder && wf.folder !== "未分类") {
                folderSet.add(wf.folder);
            }
        }
        const defaultCats = [
            { id: "all", name: "全部", type: "system" }
        ];
        const folderCats = Array.from(folderSet).map(folder => ({
            id: "folder:" + folder,
            name: folder,
            type: "folder",
            path: folder
        }));
        folderCats.sort((a, b) => {
            return a.name.localeCompare(b.name, 'zh-CN');
        });
        this.categories = [...defaultCats, ...folderCats];
    }

    renderCategories() {
        if (!this.categoryList) return;
        this.categoryList.innerHTML = "";

        const allItem = this.createCategoryItem({
            id: "all",
            name: "全部",
            type: "system"
        }, 0);
        this.categoryList.appendChild(allItem);

        const uncategorizedItem = this.createCategoryItem({
            id: "uncategorized",
            name: xzgT('根目录未分类','Root / Uncategorized'),
            type: "uncategorized",
            path: ""
        }, 0);
        this.categoryList.appendChild(uncategorizedItem);

        if (this.tree && this.tree.length > 0) {
            for (const item of this.tree) {
                if (item.type === "folder") {
                    const el = this.renderFolderTree(item, 0);
                    this.categoryList.appendChild(el);
                }
            }
        }
    }

    renderFolderTree(folderData, depth) {
        const wrapper = document.createElement("div");
        wrapper.className = "xzg-wf-folder-wrapper";

        const folderPath = folderData.path || folderData.name;
        const catId = "folder:" + folderPath;
        const isExpanded = this.expandedFolders.has(folderPath);
        const hasChildren = folderData.children && folderData.children.some(c => c.type === "folder");
        const count = this.getWorkflowCountForCategory(catId);

        const item = document.createElement("div");
        item.className = "xzg-wf-cat-item" + (this.currentCategory === catId ? " active" : "");
        item.dataset.catId = catId;
        item.dataset.catType = "folder";
        item.dataset.catName = folderData.name;
        item.dataset.folderPath = folderPath;
        item.style.paddingLeft = (12 + depth * 16) + "px";

        let html = '<span class="xzg-wf-cat-name">';
        if (hasChildren) {
            html += `<span class="xzg-wf-cat-toggle" data-path="${folderPath}">
                <svg class="xzg-wf-cat-toggle-svg ${isExpanded ? 'expanded' : ''}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
            </span>`;
        } else {
            html += `<span class="xzg-wf-cat-toggle xzg-wf-cat-toggle-empty"></span>`;
        }
        const barCount = depth + 1;
        let barsHtml = '';
        for (let i = 0; i < barCount; i++) {
            barsHtml += `<span class="xzg-wf-cat-bar"></span>`;
        }
        html += `<span class="xzg-wf-cat-icon xzg-wf-cat-bars">${barsHtml}</span>`;
        html += `<span class="xzg-wf-cat-label">${folderData.name}</span>`;
        html += '</span>';
        html += `<span class="xzg-wf-cat-count">${count}</span>`;

        item.innerHTML = html;

        item.addEventListener("click", (e) => {
            if (e.target.classList.contains("xzg-wf-cat-toggle")) {
                e.stopPropagation();
                const path = e.target.dataset.path;
                if (path) {
                    const isExpanding = !this.expandedFolders.has(path);
                    if (isExpanding) {
                        this.collapseSiblingFolders(path);
                        this.expandedFolders.add(path);
                    } else {
                        this.expandedFolders.delete(path);
                    }
                    this.renderCategories();
                }
                return;
            }
            if (hasChildren) {
                const isExpanding = !this.expandedFolders.has(folderPath);
                if (isExpanding) {
                    this.collapseSiblingFolders(folderPath);
                    this.expandedFolders.add(folderPath);
                } else {
                    this.expandedFolders.delete(folderPath);
                }
            }
            this.currentCategory = catId;
            this.renderCategories();
            this.renderWorkflowList();
        });

        item.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.showCategoryContextMenu(e, { id: catId, name: folderData.name, path: folderPath, type: "folder" });
        });

        item.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!this.draggedWorkflow) return;
            item.classList.add("drag-over");
        });

        item.addEventListener("dragleave", (e) => {
            if (!item.contains(e.relatedTarget)) {
                item.classList.remove("drag-over");
            }
        });

        item.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            item.classList.remove("drag-over");
            if (!this.draggedWorkflow) return;
            this.moveWorkflowToFolder(this.draggedWorkflow, folderPath);
        });

        wrapper.appendChild(item);

        if (hasChildren && isExpanded) {
            const childrenContainer = document.createElement("div");
            childrenContainer.className = "xzg-wf-folder-children";
            for (const child of folderData.children) {
                if (child.type === "folder") {
                    childrenContainer.appendChild(this.renderFolderTree(child, depth + 1));
                }
            }
            wrapper.appendChild(childrenContainer);
        }

        return wrapper;
    }

    createCategoryItem(cat, depth) {
        const count = this.getWorkflowCountForCategory(cat.id);
        const item = document.createElement("div");
        item.className = "xzg-wf-cat-item" + (this.currentCategory === cat.id ? " active" : "");
        item.dataset.catId = cat.id;
        item.dataset.catType = cat.type;
        item.dataset.catName = cat.name;
        item.style.paddingLeft = (12 + depth * 16) + "px";
        const catIcon = cat.id === "all" ? "" : (cat.type === "uncategorized" ? "" : `<svg width="14" height="14" viewBox="0 0 20 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="16" height="12" /></svg>`);
        item.innerHTML = `
            <span class="xzg-wf-cat-name">
                <span class="xzg-wf-cat-toggle xzg-wf-cat-toggle-empty"></span>
                ${catIcon ? `<span class="xzg-wf-cat-icon">${catIcon}</span>` : ''}
                <span class="xzg-wf-cat-label">${cat.name}</span>
            </span>
            <span class="xzg-wf-cat-count">${count}</span>
        `;
        item.addEventListener("click", () => {
            this.currentCategory = cat.id;
            this.renderCategories();
            this.renderWorkflowList();
        });

        if (cat.id === "all" || cat.type === "uncategorized") {
            item.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.showAllContextMenu(e);
            });
            item.addEventListener("dragover", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!this.draggedWorkflow) return;
                item.classList.add("drag-over");
            });
            item.addEventListener("dragleave", (e) => {
                item.classList.remove("drag-over");
            });
            item.addEventListener("drop", (e) => {
                e.preventDefault();
                e.stopPropagation();
                item.classList.remove("drag-over");
                if (!this.draggedWorkflow) return;
                this.moveWorkflowToFolder(this.draggedWorkflow, "");
            });
        }

        return item;
    }

    getWorkflowCountForCategory(catId) {
        return this.getFilteredWorkflows(catId, "").length;
    }

    /** 点击工作流图标，在左侧分类树中定位并高亮其所属分类 */
    locateWorkflowCategory(wf) {
        const folder = (wf.folder && wf.folder !== "未分类") ? wf.folder : "";
        const catId = folder ? "folder:" + folder : "uncategorized";

        // 展开所有父级文件夹，确保目标分类可见
        if (folder) {
            const parts = folder.split('/');
            let acc = '';
            for (let i = 0; i < parts.length - 1; i++) {
                acc = acc ? acc + '/' + parts[i] : parts[i];
                this.expandedFolders.add(acc);
            }
        }

        this.currentCategory = catId;
        this.renderCategories();
        this.renderWorkflowList();

        // 滚动到目标分类并闪动高亮
        const el = this.categoryList.querySelector(`[data-cat-id="${catId}"]`);
        if (el) {
            el.scrollIntoView({ block: 'nearest' });
            el.classList.add('xzg-wf-cat-flash');
            setTimeout(() => el.classList.remove('xzg-wf-cat-flash'), 1000);
        }
    }

    renderWorkflowList() {
        if (!this.workflowList) return;
        const countEl = this.container.querySelector(".xzg-wf-count");
        const items = this.getFilteredWorkflows(this.currentCategory, this.currentSearch);

        countEl.textContent = items.length;
        this.workflowList.innerHTML = "";

        if (items.length === 0) {
            const empty = document.createElement("div");
            empty.className = "xzg-wf-empty";
            empty.textContent = this.currentSearch ? xzgT('没有匹配的工作流','No matching workflows') : xzgT('暂无工作流','No workflows yet');
            this.workflowList.appendChild(empty);
            return;
        }

        for (const wf of items) {
            const item = this.createWorkflowItem(wf);
            this.workflowList.appendChild(item);
        }
    }

    /** 根据使用次数返回着色等级与颜色（阈值/颜色均可在设置面板自定义） */
    getUseLevel(count) {
        const c = count || 0;
        const cfg = (this.meta && this.meta.useColors) || DEFAULT_USE_COLORS;
        let best = { level: 0, color: "", threshold: -1 };
        for (let i = 0; i < cfg.length; i++) {
            const t = cfg[i].threshold;
            if (c > t && t > best.threshold) {
                best = { level: i + 1, color: cfg[i].color, threshold: t };
            }
        }
        delete best.threshold;
        return best;
    }

    createWorkflowItem(wf) {
        const item = document.createElement("div");
        item.className = "xzg-wf-item";
        item.draggable = true;
        item.dataset.path = wf.path;

        const useInfo = this.getUseLevel(wf.useCount || 0);
        if (this.meta.useColorsEnabled !== false && useInfo.level > 0) {
            item.classList.add("xzg-wf-use-l" + useInfo.level);
            item.style.setProperty("--xzg-use-color", useInfo.color);
        }

        const useCount = wf.useCount || 0;
        const useCountText = useCount > 0 ? `使用${useCount}次` : '';

        item.innerHTML = `
            <span class="xzg-wf-item-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="6" cy="6" r="2.5"/>
                    <circle cx="18" cy="6" r="2.5"/>
                    <circle cx="6" cy="18" r="2.5"/>
                    <circle cx="18" cy="18" r="2.5"/>
                    <path d="M8.5 6H15.5"/>
                    <path d="M6 8.5V15.5"/>
                    <path d="M18 8.5V15.5"/>
                    <path d="M8.5 18H15.5"/>
                </svg>
            </span>
            <div class="xzg-wf-item-info">
                <div class="xzg-wf-item-name"></div>
                <div class="xzg-wf-item-meta">${useCountText}</div>
            </div>
        `;

        item.querySelector(".xzg-wf-item-name").textContent = wf.name;

        // 悬浮高亮：处于「全部」分类时，悬浮工作流 → 左侧对应分类高亮并展开（手风琴模式）
        item.addEventListener("mouseenter", () => {
            if (this.currentCategory !== "all") return;
            const folder = (wf.folder && wf.folder !== "未分类") ? wf.folder : "";
            const catId = folder ? "folder:" + folder : "uncategorized";
            let needRender = false;
            if (folder) {
                const parts = folder.split('/');
                let acc = '';
                for (let i = 0; i < parts.length - 1; i++) {
                    acc = acc ? acc + '/' + parts[i] : parts[i];
                    const wasExpanded = this.expandedFolders.has(acc);
                    const beforeCount = this.expandedFolders.size;
                    this.collapseSiblingFolders(acc);
                    const afterCollapseCount = this.expandedFolders.size;
                    if (beforeCount !== afterCollapseCount) {
                        needRender = true;
                    }
                    if (!wasExpanded) {
                        this.expandedFolders.add(acc);
                        needRender = true;
                    }
                }
            } else {
                for (const p of [...this.expandedFolders]) {
                    if (!p.includes("/")) {
                        this.expandedFolders.delete(p);
                        for (const sub of [...this.expandedFolders]) {
                            if (sub.startsWith(p + "/")) {
                                this.expandedFolders.delete(sub);
                            }
                        }
                        needRender = true;
                    }
                }
            }
            if (needRender) this.renderCategories();
            const el = this.categoryList?.querySelector(`[data-cat-id="${catId}"]`);
            if (el) {
                el.classList.add("xzg-wf-cat-hover");
                el.scrollIntoView({ block: "nearest" });
            }
        });
        item.addEventListener("mouseleave", () => {
            this.categoryList?.querySelectorAll(".xzg-wf-cat-hover").forEach(el => el.classList.remove("xzg-wf-cat-hover"));
        });

        item.addEventListener("click", (e) => {
            this.loadWorkflow(wf.path);
        });

        item.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.showContextMenu(e, wf);
        });

        item.addEventListener("dragstart", (e) => {
            this.draggedWorkflow = wf;
            item.classList.add("dragging");
            e.dataTransfer.effectAllowed = "copyMove";
            e.dataTransfer.setData("application/xzg-workflow-path", wf.path);
            e.dataTransfer.setData("text/plain", wf.name);
        });

        item.addEventListener("dragend", () => {
            item.classList.remove("dragging");
            this.draggedWorkflow = null;
            document.querySelectorAll(".xzg-wf-item.drag-over").forEach(el => {
                el.classList.remove("drag-over");
            });
        });

        item.addEventListener("dragover", (e) => {
            e.preventDefault();
            if (!this.draggedWorkflow || this.draggedWorkflow.path === wf.path) return;
            item.classList.add("drag-over");
        });

        item.addEventListener("dragleave", () => {
            item.classList.remove("drag-over");
        });

        item.addEventListener("drop", (e) => {
            e.preventDefault();
            item.classList.remove("drag-over");
            if (!this.draggedWorkflow || this.draggedWorkflow.path === wf.path) return;
            this.reorderWorkflows(this.draggedWorkflow, wf);
        });

        return item;
    }

    getFilteredWorkflows(catId, search) {
        let items = [...this.workflows];

        if (catId === "uncategorized") {
            items = items.filter(w => !w.folder || w.folder === "未分类");
        } else if (catId && catId.startsWith("folder:")) {
            const folder = catId.substring(7);
            items = items.filter(w => {
                if (!w.folder || w.folder === "未分类") return false;
                return w.folder === folder || w.folder.startsWith(folder + "/");
            });
        }

        if (search) {
            const query = search.toLowerCase();
            items = items.filter(w => {
                const name = (w.name || '').toLowerCase();
                const folder = (w.folder || '').toLowerCase();
                const path = (w.path || '').toLowerCase();
                const nameInitials = this.toPinyinInitials(w.name);
                const nameFull = this.toPinyinFull(w.name);
                const folderInitials = this.toPinyinInitials(w.folder);
                const folderFull = this.toPinyinFull(w.folder);

                return this.fuzzyMatch(name, query) ||
                       this.fuzzyMatch(folder, query) ||
                       this.fuzzyMatch(path, query) ||
                       this.fuzzyMatch(nameInitials, query) ||
                       this.fuzzyMatch(nameFull, query) ||
                       this.fuzzyMatch(folderInitials, query) ||
                       this.fuzzyMatch(folderFull, query);
            });
        }

        if (this.sortMode === "name") {
            items.sort((a, b) => {
                return (a.name || "").localeCompare(b.name || "", 'zh-CN');
            });
        } else if (this.sortMode === "time") {
            items.sort((a, b) => {
                return (b.lastUsed || 0) - (a.lastUsed || 0);
            });
        } else {
            items.sort((a, b) => {
                if ((b.useCount || 0) !== (a.useCount || 0)) return (b.useCount || 0) - (a.useCount || 0);
                return (b.lastUsed || 0) - (a.lastUsed || 0);
            });
        }

        return items;
    }

    toPinyinInitials(text) {
        if (!text || typeof text !== 'string') return '';
        try {
            const p = window.pinyinPro?.pinyin || pinyinPro;
            return p(text, { pattern: 'first', toneType: 'none', type: 'string' }).replace(/\s/g, '');
        } catch(e) { return ''; }
    }

    toPinyinFull(text) {
        if (!text || typeof text !== 'string') return '';
        try {
            const p = window.pinyinPro?.pinyin || pinyinPro;
            return p(text, { toneType: 'none', type: 'string' }).replace(/\s/g, '');
        } catch(e) { return ''; }
    }

    fuzzyMatch(text, query) {
        if (!query) return true;
        if (!text) return false;
        text = String(text).toLowerCase();
        query = String(query).toLowerCase();
        if (text.includes(query)) return true;
        let ti = 0, qi = 0;
        while (ti < text.length && qi < query.length) {
            if (text[ti] === query[qi]) qi++;
            ti++;
        }
        return qi === query.length;
    }

    async loadWorkflow(path) {
        // 串行加载：快速连点时若多个加载并发交错，画布图与官方标签会不一致，
        // 此时保存会把当前画布误写进错误的官方工作流，造成严重数据损坏（两个工作流被覆盖成一样）。
        // 这里用队列保证同一时刻只有一个加载在跑，且连点时只加载「最后一次点击」的目标，丢弃中间连点。
        if (this._loading) {
            this._loadQueue = [path];
            return;
        }
        this._loading = true;
        try {
            let target = path;
            while (target != null) {
                const gen = (this._loadGen = (this._loadGen || 0) + 1);
                await this._loadWorkflowCore(target, gen);
                target = this._loadQueue.length ? this._loadQueue.pop() : null;
                this._loadQueue.length = 0;
            }
        } finally {
            this._loading = false;
            this._loadQueue.length = 0;
        }
    }

    async _loadWorkflowCore(path, gen) {
        try {
            this._lastLoadWasOpen = false;
            const wfStore = app.extensionManager?.workflow;
            const officialPath = 'workflows/' + path + '.json';

            let data = null;
            let persistedWf = null;

            if (wfStore?.openWorkflow && wfStore?.getWorkflowByPath) {
                persistedWf = wfStore.getWorkflowByPath(officialPath);
                if (!persistedWf && typeof wfStore.loadWorkflows === 'function') {
                    try { await wfStore.loadWorkflows(); } catch (_) {}
                    // 等待 store 注册表刷新后再查一次
                    await new Promise(r => setTimeout(r, 50));
                    persistedWf = wfStore.getWorkflowByPath(officialPath);
                }
                // 兜底：store 可能未索引到磁盘上的该文件，遍历已加载列表按路径/名称匹配
                if (!persistedWf) {
                    const list = wfStore.workflows || (typeof wfStore.getWorkflows === 'function' ? wfStore.getWorkflows() : null);
                    if (Array.isArray(list)) {
                        const name = path.split('/').pop();
                        persistedWf = list.find(w => w && (
                            w.path === officialPath ||
                            (w.path && w.path.endsWith(path + '.json')) ||
                            w.filename === name ||
                            w.name === name
                        )) || null;
                    }
                }

                if (persistedWf) {
                    // 记录点击前的状态：已激活则连画布都不必动；已打开（非激活）则需切画布但「不增加频率」
                    const wasActive = wfStore.isActive ? wfStore.isActive(persistedWf) : false;
                    const wasOpen = wfStore.isOpen ? wfStore.isOpen(persistedWf) : false;
                    this._lastLoadWasOpen = wasActive || wasOpen;

                    // 已经是当前激活工作流：画布已是其图，无需重复加载，直接结束
                    if (wasActive) {
                        return;
                    }
                    // 确保内容已加载到本地，供我们精确掌控画布图
                    if (!persistedWf.isLoaded) {
                        try { await persistedWf.load(); } catch (_) {}
                    }
                    data = JSON.parse(persistedWf.content);
                }
            }

            // 兜底：store 中无对应条目时从后端直接取
            if (!data) {
                const res = await api.fetchApi(`/xzg/workflows/${encodeURIComponent(path)}`, { cache: "no-store" });
                if (!res.ok) throw new Error("加载失败");
                data = await res.json();
            }

            const graph = app.graph;
            const canvas = app.canvas;

            // 1) 通过官方 store 切换「激活工作流」：决定顶部标签与保存目标路径
            if (persistedWf && wfStore?.openWorkflow) {
                try { await wfStore.openWorkflow(persistedWf); } catch (_) {}
            }

            // 2) 等待官方异步图加载先行完成（通常 < 300ms），避免其随后覆盖我们下面的加载
            await new Promise(r => setTimeout(r, 300));

            // 3) 由本扩展完全掌控画布图：清图并配置为「本次点击」的工作流数据，作为最终画布写入者
            graph.beforeChange();
            graph.clear();
            graph.configure(data);
            graph.afterChange();

            // 4) 视图恢复（缩放/偏移）
            const savedDs = data.extra?.ds;
            if (savedDs && canvas?.ds) {
                if (savedDs.scale != null) canvas.ds.scale = savedDs.scale;
                if (savedDs.offset) {
                    canvas.ds.offset[0] = savedDs.offset[0] || 0;
                    canvas.ds.offset[1] = savedDs.offset[1] || 0;
                }
            } else {
                this.centerCanvasOnNodes();
            }

            if (canvas?.setDirty) canvas.setDirty(true, true);
            if (data.id) location.hash = data.id;

            await new Promise(r => setTimeout(r, 120));
            app.canvas?.draw(true, true);

            // 5) 代际校验：若期间有更新的点击（gen 已变），不再写元信息，交由最新代次负责
            if (gen === this._loadGen) {
                // 仅当该工作流「本次点击前未打开」时才增加使用频率；
                // 已打开/已激活的反复点击只切画布，不刷频率，避免重复点击虚增计数
                if (!this._lastLoadWasOpen) {
                    const meta = this.getWorkflowMeta(path);
                    meta.useCount = (meta.useCount || 0) + 1;
                    meta.lastUsed = Date.now();
                    this.saveMeta();

                    const wf = this.workflows.find(w => w.path === path);
                    if (wf) {
                        wf.useCount = meta.useCount;
                        wf.lastUsed = meta.lastUsed;
                    }

                    this.renderWorkflowList();
                }
            }
        } catch (e) {
            console.warn("[小珠光] 加载工作流失败:", e);
            alert(xzgT('加载工作流失败: ','Failed to load workflow: ') + e.message);
        }
    }

    centerCanvasOnNodes() {
        const graph = app.graph;
        const canvas = app.canvas;
        const nodes = graph._nodes;
        if (!nodes || nodes.length === 0 || !canvas) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        nodes.forEach(n => {
            if (n.pos) {
                minX = Math.min(minX, n.pos[0]);
                minY = Math.min(minY, n.pos[1]);
                const w = n.size?.[0] || 200;
                const h = n.size?.[1] || 100;
                maxX = Math.max(maxX, n.pos[0] + w);
                maxY = Math.max(maxY, n.pos[1] + h);
            }
        });

        if (!isFinite(minX)) return;

        const padding = 100;
        const width = maxX - minX + padding * 2;
        const height = maxY - minY + padding * 2;
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        const canvasWidth = canvas.canvas?.width || 800;
        const canvasHeight = canvas.canvas?.height || 600;

        const scaleX = canvasWidth / width;
        const scaleY = canvasHeight / height;
        const scale = Math.min(scaleX, scaleY, 1.5);

        canvas.ds.scale = scale;
        canvas.ds.offset[0] = -centerX + canvasWidth / (2 * scale);
        canvas.ds.offset[1] = -centerY + canvasHeight / (2 * scale);

        if (canvas.setDirty) {
            canvas.setDirty(true, true);
        }
    }

    async renameWorkflow(wf) {
        const newName = await this.showInputDialog("重命名工作流", wf.name);
        if (!newName || newName === wf.name) return;

        const oldPath = wf.path;
        const folder = wf.folder === "未分类" ? "" : wf.folder + "/";
        const newPath = folder + newName;

        try {
            const res = await api.fetchApi("/xzg/workflows/rename", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ oldName: oldPath, newName: newPath })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "重命名失败");
            }

            if (this.meta.workflows[oldPath]) {
                this.meta.workflows[newPath] = this.meta.workflows[oldPath];
                delete this.meta.workflows[oldPath];
                this.saveMeta();
            }

            await this.loadWorkflows();
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.loadWorkflows) { try { await wfStore.loadWorkflows(); } catch (e) {} }
        } catch (e) {
            alert(xzgT('重命名失败: ','Rename failed: ') + e.message);
        }
    }

    async deleteWorkflow(wf) {
        if (!confirm(xzgT(`确定要删除工作流「${wf.name}」吗？`, `Delete workflow "${wf.name}"?`))) return;

        try {
            const res = await api.fetchApi(`/xzg/workflows/${encodeURIComponent(wf.path)}`, {
                method: "DELETE"
            });

            if (!res.ok) throw new Error(xzgT('删除失败','Delete failed'));

            if (this.meta.workflows[wf.path]) {
                delete this.meta.workflows[wf.path];
                this.saveMeta();
            }

            await this.loadWorkflows();
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.loadWorkflows) { try { await wfStore.loadWorkflows(); } catch (e) {} }
        } catch (e) {
            alert(xzgT('删除失败: ','Delete failed: ') + e.message);
        }
    }

    reorderWorkflows(draggedItem, targetItem) {
        const dragIdx = this.workflows.findIndex(w => w.path === draggedItem.path);
        const targetIdx = this.workflows.findIndex(w => w.path === targetItem.path);
        if (dragIdx === -1 || targetIdx === -1) return;

        const [removed] = this.workflows.splice(dragIdx, 1);
        this.workflows.splice(targetIdx, 0, removed);
        this.renderWorkflowList();
    }

    async createNewCategory(parentFolder = "") {
        const promptText = parentFolder ? xzgT('新建子分类（父分类：','New subcategory (parent: ') + parentFolder + xzgT('）','') : xzgT('新建分类','New Category');
        const name = await this.showInputDialog(promptText, "");
        if (!name || !name.trim()) return;
        const folderName = name.trim();

        try {
            const res = await api.fetchApi("/xzg/wf-manage/folder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: folderName, parent: parentFolder })
            });

            if (res.status === 409) {
                alert(xzgT('分类已存在！','Category already exists!'));
                return;
            }
            if (!res.ok) {
                let errMsg = xzgT('创建失败','Create failed');
                try {
                    const text = await res.text();
                    try {
                        const err = JSON.parse(text);
                        errMsg = err.error || errMsg;
                    } catch {
                        errMsg = `HTTP ${res.status}: ${text.substring(0, 200)}`;
                    }
                } catch {
                    errMsg = `HTTP ${res.status}`;
                }
                throw new Error(errMsg);
            }

            if (parentFolder) {
                this.expandedFolders.add(parentFolder);
            }
            await this.loadWorkflows();
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.loadWorkflows) { try { await wfStore.loadWorkflows(); } catch (e) {} }
        } catch (e) {
            console.warn("[小珠光] 创建分类失败:", e);
            alert(xzgT('创建分类失败: ','Failed to create category: ') + e.message);
        }
    }

    /** 重命名分类：文件夹整体重命名（含其下所有子分类与工作流）。保留用户自定义名称（含手工编号前缀），不做任何剥离 */
    async renameCategory(cat) {
        if (!cat || cat.type !== "folder") return;

        const input = await this.showInputDialog("重命名分类", cat.name);
        if (input === null) return; // 用户取消

        const newName = input.trim();
        if (!newName) { alert(xzgT('分类名称不能为空！','Category name cannot be empty!')); return; }
        if (newName.includes("/") || newName.includes("\\")) { alert(xzgT('分类名称不能包含 / 或 \\','Category name cannot contain / or \\')); return; }
        if (newName === cat.name) return; // 未修改，无需操作

        try {
            await this.renameFolder(cat.path, newName);
            // 重命名后刷新整棵树与官方 store，保证工作流路径同步、点击不再 404
            if (this.currentCategory === cat.id) {
                this.currentCategory = "all";
            }
            await this.loadWorkflows();
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.loadWorkflows) { try { await wfStore.loadWorkflows(); } catch (e) {} }
        } catch (e) {
            let msg = e.message || String(e);
            if (msg.includes("already exists") || msg.includes("409")) msg = "已存在同名分类，请换一个名称";
            alert(xzgT('重命名分类失败: ','Failed to rename category: ') + msg);
        }
    }

    async deleteCategory(cat) {
        if (!cat || cat.type !== "folder") return;
        
        if (!confirm(xzgT(`确定要删除分类「${cat.name}」吗？\n分类内的所有工作流和子分类也将被删除！`, `Delete category "${cat.name}"?\nAll workflows and subcategories inside will also be deleted!`))) return;

        try {
            const res = await api.fetchApi(`/xzg/wf-manage/folder/${encodeURIComponent(cat.path)}`, {
                method: "DELETE"
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || xzgT('删除失败','Delete failed'));
            }

            const folderPath = cat.path;
            for (const wf of this.workflows) {
                const wfFolder = wf.folder === "未分类" ? "" : wf.folder;
                if ((wfFolder === folderPath || wfFolder.startsWith(folderPath + "/")) && this.meta.workflows[wf.path]) {
                    delete this.meta.workflows[wf.path];
                }
            }
            this.saveMeta();

            if (this.currentCategory === cat.id) {
                this.currentCategory = "all";
            }

            await this.loadWorkflows();
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.loadWorkflows) { try { await wfStore.loadWorkflows(); } catch (e) {} }
        } catch (e) {
            alert(xzgT('删除分类失败: ','Failed to delete category: ') + e.message);
        }
    }

    async moveWorkflowToFolder(wf, targetFolder) {
        if (!wf) return;
        
        const currentFolder = wf.folder === "未分类" ? "" : wf.folder;
        const target = targetFolder || "";
        
        if (currentFolder === target) return;

        let moveSuccess = false;
        let newPath = null;

        try {
            const res = await api.fetchApi("/xzg/wf-manage/move", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                    oldPath: wf.path, 
                    newFolder: target 
                })
            });

            const text = await res.text();
            let result = {};
            try {
                result = JSON.parse(text);
            } catch (e) {
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}: ${text.substring(0, 200)}`);
                }
            }

            if (!res.ok) {
                throw new Error(result.error || `HTTP ${res.status}`);
            }

            newPath = result.newPath;
            moveSuccess = true;

            if (this.meta.workflows[wf.path]) {
                this.meta.workflows[newPath] = this.meta.workflows[wf.path];
                delete this.meta.workflows[wf.path];
                this.saveMeta();
            }
        } catch (e) {
            console.warn("[小珠光] 移动工作流失败:", e);
            alert(xzgT('移动工作流失败: ','Failed to move workflow: ') + e.message);
            return;
        }

        try {
            await this.loadWorkflows();
        } catch (e) {
            console.warn("[小珠光] 刷新工作流列表失败:", e);
        }

        try {
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.loadWorkflows) {
                try { await wfStore.loadWorkflows(); } catch (e) {
                    console.warn("[小珠光] 刷新官方工作流列表失败:", e);
                }
            }
        } catch (e) {
            console.warn("[小珠光] 刷新官方工作流列表失败:", e);
        }
    }

    // ====== 文件夹自动编号逻辑 ======

    /** 调用后端重命名文件夹 */
    async renameFolder(oldPath, newName) {
        let res;
        try {
            res = await api.fetchApi("/xzg/wf-manage/rename-folder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ oldPath, newName })
            });
        } catch (netErr) {
            throw new Error("无法连接后端: " + netErr.message);
        }
        if (res.status === 404) {
            throw new Error("后端接口不存在(404)，请重启 ComfyUI 后再试");
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        return res.json();
    }

    /** 清空所有工作流的使用频率（使用次数与最近使用时间），不影响工作流本身与分类 */
    clearUsageFrequency() {
        if (!confirm(xzgT('确定清空所有工作流的使用频率（使用次数与最近使用时间）吗？此操作不可撤销。', 'Clear usage frequency (use count and last-used) for all workflows? This cannot be undone.'))) {
            return;
        }
        for (const path in this.meta.workflows) {
            const m = this.meta.workflows[path];
            if (m) {
                m.useCount = 0;
                m.lastUsed = 0;
            }
        }
        this.saveMeta();
        for (const wf of this.workflows) {
            wf.useCount = 0;
            wf.lastUsed = 0;
        }
        this.renderWorkflowList();
        if (this.renderCategories) this.renderCategories();
    }

    /** 删除单个工作流的使用频率（使用次数与最近使用时间），不影响工作流本身与分类 */
    deleteWorkflowUsage(wf) {
        const path = wf && wf.path;
        if (!path) return;
        if (this.meta.workflows[path]) {
            this.meta.workflows[path].useCount = 0;
            this.meta.workflows[path].lastUsed = 0;
        }
        this.saveMeta();
        wf.useCount = 0;
        wf.lastUsed = 0;
        this.renderWorkflowList();
        if (this.renderCategories) this.renderCategories();
    }
}

workflowsInstance = new XZGWorkflowsManager();
window.XZGWorkflows = workflowsInstance;

app.registerExtension({
    name: "xiaozhuguang.workflows",
    setup() {
        // 监听官方 workflow store 变化（含原生 Save / 新建 / 删除工作流），
        // 一旦官方列表变动（磁盘新增了工作流），自动刷新本扩展面板，避免"新工作流不显示"。
        const refresh = () => {
            try { workflowsInstance.loadWorkflows(); } catch (e) {}
        };
        try {
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.subscribe) {
                wfStore.subscribe(refresh);
            } else {
                // 老版本 ComfyUI 无 subscribe：退化为轮询官方 store
                setInterval(() => {
                    try {
                        const s = app.extensionManager?.workflow;
                        if (s?.loadWorkflows) s.loadWorkflows().then(refresh).catch(() => {});
                    } catch (e) {}
                }, 3000);
            }
        } catch (e) {
            console.warn("[小珠光] 注册官方工作流监听失败:", e);
        }

        // 语言切换时刷新面板文案（双语支持）
        try {
            const lookup = app?.ui?.settings?.settingsLookup?.["Comfy.Locale"];
            if (lookup && !lookup.__xzg_wf_hooked) {
                lookup.__xzg_wf_hooked = true;
                const orig = lookup.onChange;
                lookup.onChange = function () {
                    try {
                        workflowsInstance.renderWorkflowList();
                        workflowsInstance.renderCategories();
                        workflowsInstance.refreshStaticLabels();
                        // 若设置面板 / 帮助弹窗当前打开，按新语言重建（其内部文案为一次性构建）
                        const openSettings = document.querySelector(".xzg-wf-settings-overlay");
                        if (openSettings) { openSettings.remove(); workflowsInstance.showSettingsDialog(); }
                        const openHelp = document.querySelector('.xzg-wf-dialog-overlay[data-xzg-role="help"]');
                        if (openHelp) { openHelp.remove(); workflowsInstance.showWorkflowHelp(); }
                    } catch (e) {}
                    return orig?.apply(this, arguments);
                };
            }
        } catch (e) {}
    }
});
