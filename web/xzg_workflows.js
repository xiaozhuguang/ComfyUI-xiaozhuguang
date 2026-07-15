import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { pinyin as pinyinPro } from "./pinyin-pro.esm.js";

const STORAGE_KEY = "xzg_workflows_meta";
const PLUGIN_NAME = "工作流";
const SETTING_TOGGLE_SHORTCUT = "xzg_wf_toggle_shortcut";
const ACCENT_KEY = "xzg_wf_accent";

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
                title: "工作流",
                tooltip: "工作流",
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

    // ====== 分类编号工具方法 ======
    /** 去除文件夹名称的数字前缀 (如 "01_AAA" → "AAA") */
    stripNumberPrefix(name) {
        return name.replace(/^\d+[_\s]?/, '');
    }
    /** 判断文件夹名称是否已有数字前缀 */
    hasNumberPrefix(name) {
        return /^\d+_/.test(name);
    }
    /** 构建数字前缀 (如 1 → "01_") */
    buildNumberPrefix(num) {
        return String(num).padStart(2, '0') + '_';
    }
    /** 获取路径的父级路径 */
    getParentPath(path) {
        if (!path || !path.includes('/')) return '';
        return path.substring(0, path.lastIndexOf('/'));
    }
    /** 获取文件夹名称中的数字序号，没有则返回 -1 */
    getFolderNumber(name) {
        const m = name.match(/^(\d+)_/);
        return m ? parseInt(m[1], 10) : -1;
    }

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
        const display = this.container?.querySelector("#xzg-wf-shortcut-btn");
        if (!display) return;

        const shortcut = this.getShortcut();
        const parts = [];
        if (shortcut.ctrl) parts.push("Ctrl");
        if (shortcut.alt) parts.push("Alt");
        if (shortcut.shift) parts.push("Shift");
        parts.push(shortcut.key.toUpperCase());
        display.textContent = "快捷键: " + parts.join("+");
    }

    showShortcutDialog() {
        const dialog = document.createElement("div");
        dialog.className = "xzg-wf-dialog-overlay";
        dialog.innerHTML = this._applyAccent(`
            <div class="xzg-wf-dialog">
                <div class="xzg-wf-dialog-title">设置快捷键</div>
                <div class="xzg-wf-dialog-body">
                    <p style="margin-bottom: 16px; color: #888; font-size: 13px; text-align: center;">请按下你想要的快捷键</p>
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
                        ">请按快捷键...</div>
                    </div>
                </div>
                <div class="xzg-wf-dialog-footer">
                    <button class="xzg-wf-dialog-btn xzg-wf-dialog-btn-cancel" id="xzg-wf-dialog-cancel">取消</button>
                    <button class="xzg-wf-dialog-btn xzg-wf-dialog-btn-confirm" id="xzg-wf-dialog-confirm" disabled>确认</button>
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
    }

    showContextMenu(e, wf) {
        this.hideContextMenu();
        
        const menu = document.createElement("div");
        menu.className = "xzg-wf-context-menu";
        menu.innerHTML = `
            <div class="xzg-wf-ctx-item xzg-wf-ctx-submenu" data-action="move">📁 移动到分类</div>
            <div class="xzg-wf-ctx-item" data-action="rename">✏️ 重命名</div>
            <div class="xzg-wf-ctx-item danger" data-action="delete">🗑️ 删除</div>
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
                this.hideContextMenu();
                
                if (action === "rename") {
                    this.renameWorkflow(wf);
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
                ? `<span class="xzg-wf-cat-toggle" data-path="${folderPath}"><svg class="xzg-wf-cat-toggle-svg ${isExpanded ? 'expanded' : ''}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></span>`
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
                <span class="xzg-wf-cat-label">未分类</span>
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
            <div class="xzg-wf-ctx-item" data-action="new-folder">📁 新建分类</div>
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
            html += `<div class="xzg-wf-ctx-item" data-action="move-up">⬆️ 上移</div>
            <div class="xzg-wf-ctx-item" data-action="move-down">⬇️ 下移</div>
            <div class="xzg-wf-ctx-separator"></div>`;
        }
        html += `<div class="xzg-wf-ctx-item" data-action="new-subfolder">📁 新建子分类</div>
            <div class="xzg-wf-ctx-separator"></div>
            <div class="xzg-wf-ctx-item danger" data-action="delete">🗑️ 删除分类</div>`;

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
                } else if (action === "new-subfolder") {
                    this.createNewCategory(cat.path || cat.name);
                } else if (action === "move-up") {
                    this.moveCategoryUp(cat).catch(e => alert("上移失败: " + e.message));
                } else if (action === "move-down") {
                    this.moveCategoryDown(cat).catch(e => alert("下移失败: " + e.message));
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
            alert("导入工作流失败: " + e.message);
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
                    <span class="xzg-wf-title">工作流</span>
                    <div class="xzg-wf-header-btns">
                                    <div class="xzg-wf-header-btn xzg-wf-trash-btn" id="xzg-wf-trash-btn" title="回收站（误删可恢复）">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="3 6 5 6 21 6"/>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                </svg>
                            </div>
                            <label class="xzg-wf-header-btn xzg-wf-accent-btn" id="xzg-wf-accent-btn" title="主题设置（点击选择工作流面板强调色）">
                                <span class="xzg-wf-accent-text">主题设置</span>
                                <input type="color" id="xzg-wf-accent-input" />
                            </label>
                            <button class="xzg-wf-header-btn xzg-wf-shortcut-btn" id="xzg-wf-shortcut-btn" title="设置快捷键">快捷键: \`</button>
                            <div class="xzg-wf-header-btn xzg-wf-possess" id="xzg-wf-possess-btn" title="夺舍模式：开启后隐藏 ComfyUI 官方工作流管理按钮">
                                <span class="xzg-wf-possess-text">夺舍模式</span>
                                <span class="xzg-wf-toggle"><i></i></span>
                            </div>
                        </div>
                </div>
                <div class="xzg-wf-search-box">
                    <input type="text" class="xzg-wf-search-input" placeholder="🔍 搜索工作流 (拼音/首字母/名称)..." />
                    <button class="xzg-wf-clear-btn" style="display: none;">✕</button>
                </div>
                <div class="xzg-wf-split-container">
                    <div class="xzg-wf-left-col">
                        <div class="xzg-wf-cat-header">
                            <span>分类</span>
                        </div>
                        <div class="xzg-wf-cat-list"></div>
                    </div>
                    <div class="xzg-wf-split-handle" title="拖动调节宽度"></div>
                    <div class="xzg-wf-right-col">
                        <div class="xzg-wf-list-header">
                            <div class="xzg-wf-list-title">
                                <span>工作流</span>
                                <span class="xzg-wf-count">0</span>
                            </div>
                            <div class="xzg-wf-sort-btns">
                                <button class="xzg-wf-sort-btn active" data-sort="default" title="按使用频率排序">🔥</button>
                                <button class="xzg-wf-sort-btn" data-sort="time" title="按最近使用排序">🕐</button>
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
                background: #444;
                border-color: #FFD700;
                color: #FFD700;
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
            #xzg-wf-accent-input {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                border: none;
                margin: 0;
                padding: 0;
                opacity: 0;
                cursor: pointer;
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
            .xzg-wf-search-input:focus {
                border-color: #FFD700;
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
                width: 160px;
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
                background: rgba(255, 215, 0, 0.15);
                color: #FFD700;
            }
            .xzg-wf-cat-item.active {
                background: rgba(255, 255, 255, 0.1);
                color: #FFD700;
                border-left: 2px solid #FFD700;
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
                color: #FFD700;
            }
            .xzg-wf-cat-drag-handle {
                flex: none;
                cursor: grab;
                color: #888;
                font-size: 14px;
                line-height: 1;
                user-select: none;
                margin-right: 2px;
                transition: color 0.15s;
            }
            .xzg-wf-cat-drag-handle:hover {
                color: #FFD700;
            }
            .xzg-wf-cat-drag-handle:active {
                cursor: grabbing;
            }
            .xzg-wf-cat-item.xzg-wf-cat-dragging {
                opacity: 0.5;
            }
            .xzg-wf-cat-insert-indicator {
                height: 3px;
                flex: none;
                border-radius: 2px;
                background: #FFD700;
                box-shadow: 0 0 6px rgba(255, 215, 0, 0.8);
                margin: 1px 0;
                pointer-events: none;
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
                width: 16px;
                height: 16px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #FFD700;
                cursor: pointer;
                flex-shrink: 0;
                transition: transform 0.15s, color 0.15s;
            }
            .xzg-wf-cat-toggle-svg {
                width: 14px;
                height: 14px;
                transition: transform 0.15s;
            }
            .xzg-wf-cat-toggle-svg.expanded {
                transform: rotate(90deg);
            }
            .xzg-wf-cat-toggle:hover {
                color: #ffed4e;
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
                width: 2px;
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
                background: rgba(255, 215, 0, 0.15);
                color: #FFD700;
                border-color: #FFD700;
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
            .xzg-wf-item-icon {
                font-size: 16px;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #FFD700;
            }
            .xzg-wf-item-icon svg {
                width: 16px;
                height: 16px;
            }
            .xzg-wf-item:hover {
                background: rgba(255, 215, 0, 0.15);
                color: #FFD700;
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
                background: rgba(255, 215, 0, 0.15);
                color: #FFD700;
            }
            .xzg-wf-ctx-item.danger:hover {
                background: rgba(244, 67, 54, 0.15);
                color: #f44336;
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
            .xzg-wf-ctx-submenu:hover::after {
                color: #FFD700;
            }
            .xzg-wf-submenu {
                position: fixed;
                z-index: 100001;
                background: var(--comfy-menu-bg, #2a2a2a);
                border: 1px solid var(--border-color, #444);
                border-radius: 6px;
                padding: 4px 0;
                min-width: 140px;
                max-height: 300px;
                overflow-y: auto;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
                font-size: 13px;
            }
            .xzg-wf-submenu-item {
                padding: 8px 16px;
                cursor: pointer;
                color: var(--fg, #ddd);
                transition: background 0.15s;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .xzg-wf-submenu-item:hover {
                background: rgba(255, 215, 0, 0.15);
                color: #FFD700;
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
                z-index: 10000;
            }
            .xzg-wf-dialog {
                background: var(--comfy-menu-bg, #2a2a2a);
                border: 1px solid var(--border-color, #555);
                border-radius: 8px;
                min-width: 320px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            }
            .xzg-wf-dialog-title {
                padding: 14px 16px;
                font-size: 15px;
                font-weight: bold;
                color: #FFD700;
                border-bottom: 1px solid var(--border-color, #444);
                text-align: center;
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
                background: #444;
                border-color: #FFD700;
                color: #FFD700;
            }
            .xzg-wf-dialog-btn-cancel {
                background: var(--comfy-input-bg, #3a3a3a);
                color: var(--fg, #ddd);
            }
            .xzg-wf-dialog-btn-confirm {
                background: #FFD700;
                color: #1a1a1a;
                border-color: #FFD700;
                font-weight: bold;
            }
            .xzg-wf-dialog-btn-confirm:hover:not(:disabled) {
                background: #ffed4e;
                color: #1a1a1a;
                border-color: #ffed4e;
            }
            .xzg-wf-dialog-btn-confirm:disabled {
                opacity: 0.4;
                cursor: not-allowed;
            }
            .xzg-wf-shortcut-btn {
                color: #ddd !important;
                border-color: #666 !important;
            }
            .xzg-wf-shortcut-btn:hover {
                background: #555 !important;
                border-color: #888 !important;
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

        container.querySelectorAll(".xzg-wf-sort-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                container.querySelectorAll(".xzg-wf-sort-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                this.sortMode = btn.dataset.sort;
                this.meta.sortMode = this.sortMode;
                this.saveMeta();
                this.renderWorkflowList();
            });
        });

        const accentInput = container.querySelector("#xzg-wf-accent-input");
        if (accentInput) {
            const savedAccent = localStorage.getItem(ACCENT_KEY) || "#FFD700";
            accentInput.value = savedAccent;
            this.applyAccentColor(savedAccent);
            accentInput.addEventListener("input", (e) => {
                this.applyAccentColor(e.target.value);
            });
        }

        const trashBtn = container.querySelector("#xzg-wf-trash-btn");
        if (trashBtn) {
            trashBtn.addEventListener("click", () => {
                this.openTrashModal();
            });
        }

        const shortcutBtn = container.querySelector("#xzg-wf-shortcut-btn");
        if (shortcutBtn) {
            shortcutBtn.addEventListener("click", () => {
                this.showShortcutDialog();
            });
        }

        const possessBtn = container.querySelector("#xzg-wf-possess-btn");
        if (possessBtn) {
            possessBtn.addEventListener("click", () => this.togglePossessMode());
        }

        this.updateShortcutDisplay();
        this.initPossessMode();

    }

    // ====== 夺舍模式：隐藏官方工作流管理按钮 ======
    initPossessMode() {
        const on = localStorage.getItem("xzg_possess_mode") === "1";
        const btn = this.container?.querySelector("#xzg-wf-possess-btn");
        if (btn) btn.classList.toggle("active", on);
        this._applyPossessMode(on);
    }

    togglePossessMode() {
        const on = localStorage.getItem("xzg_possess_mode") !== "1";
        localStorage.setItem("xzg_possess_mode", on ? "1" : "0");
        const btn = this.container?.querySelector("#xzg-wf-possess-btn");
        if (btn) btn.classList.toggle("active", on);
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
                        <strong style="font-size:15px;">回收站</strong>
                        <span id="xzg-wf-trash-close" style="cursor:pointer;font-size:20px;line-height:1;padding:0 4px;">✕</span>
                    </div>
                    <div id="xzg-wf-trash-body"></div>
                    <div style="margin-top:12px;font-size:11px;color:#999;text-align:center;">回收站保留 3 个月，过期项目自动清理（不可手动清空）</div>
                </div>
            `;
            modal.style.display = "flex";

            const body = modal.querySelector("#xzg-wf-trash-body");
            if (items.length === 0) {
                body.innerHTML = `<div style="color:#999;padding:12px 0;text-align:center;">回收站为空</div>`;
            } else {
                body.innerHTML = items.map(it => {
                    const daysLeft = (it.days_left == null) ? "" : ` · 剩 ${it.days_left} 天`;
                    return `
                    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
                        <div style="flex:1;min-width:0;">
                            <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📄 ${this.escapeHtml(it.name)}</div>
                            <div style="font-size:11px;color:#999;">原路径: ${this.escapeHtml(it.original_path)} · ${this.escapeHtml(it.deleted_at)}${daysLeft}</div>
                        </div>
                        <button data-restore="${this.escapeHtml(it.id)}" style="background:#3a6;color:#fff;border:none;border-radius:4px;padding:5px 10px;cursor:pointer;">恢复</button>
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
            alert("打开回收站失败: " + e.message);
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
                    alert("恢复失败：目标位置已存在同名文件，请先手动处理。");
                } else {
                    alert("恢复失败: " + (data.error || res.status));
                }
                return;
            }
            this.closeTrashModal();
            await this.loadWorkflows();
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.loadWorkflows) { try { await wfStore.loadWorkflows(); } catch (e) {} }
        } catch (e) {
            alert("恢复失败: " + e.message);
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
        // 自动编号过程中由 renameFolder 触发的内部刷新：仅加载数据，避免无限递归
        if (this._autoNumbering) {
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
            }
            // 同步官方 store，避免拖动分类排序后官方工作流 path 陈旧导致 404
            await this._refreshOfficialStore();
            return;
        }
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

        // 自动为文件夹添加/修正顺序编号前缀（已连续编号的层会被跳过，不覆盖手动排序）
        this._autoNumbering = true;
        try {
            await this.autoNumberCategories();
        } catch (e) {
            console.warn("[小珠光] 自动编号失败:", e);
            if (!this._autoNumberErrorShown) {
                this._autoNumberErrorShown = true;
                alert("分类自动编号失败: " + e.message);
            }
        } finally {
            this._autoNumbering = false;
        }
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
            name: "根目录未分类",
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
        html += `<span class="xzg-wf-cat-drag-handle" draggable="true" data-path="${folderPath}" title="拖动调整顺序">⠿</span>`;
        if (hasChildren) {
            html += `<span class="xzg-wf-cat-toggle" data-path="${folderPath}">
                <svg class="xzg-wf-cat-toggle-svg ${isExpanded ? 'expanded' : ''}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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

        const handle = item.querySelector(".xzg-wf-cat-drag-handle");
        if (handle) {
            handle.addEventListener("dragstart", (e) => {
                e.stopPropagation();
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/xzg-wf-cat", folderPath);
                this._wfCatDrag = { path: folderPath };
                this._wfCatInsertIndex = null;
                item.classList.add("xzg-wf-cat-dragging");
            });
            handle.addEventListener("dragend", () => {
                item.classList.remove("xzg-wf-cat-dragging");
                this._removeWfCatInsertIndicator();
                this._wfCatInsertIndex = null;
                this._wfCatDrag = null;
            });
            // 阻止点击手柄时触发分类选中/展开
            handle.addEventListener("click", (e) => e.stopPropagation());
        }

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
            const isCatDrag = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("text/xzg-wf-cat");
            if (isCatDrag) {
                this._handleCatDragOver(e, item, folderPath);
                return;
            }
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
            const isCatDrag = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("text/xzg-wf-cat");
            if (isCatDrag) {
                this._handleCatDrop(e, item, folderPath);
                return;
            }
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

    renderWorkflowList() {
        if (!this.workflowList) return;
        const countEl = this.container.querySelector(".xzg-wf-count");
        const items = this.getFilteredWorkflows(this.currentCategory, this.currentSearch);

        countEl.textContent = items.length;
        this.workflowList.innerHTML = "";

        if (items.length === 0) {
            const empty = document.createElement("div");
            empty.className = "xzg-wf-empty";
            empty.textContent = this.currentSearch ? "没有匹配的工作流" : "暂无工作流";
            this.workflowList.appendChild(empty);
            return;
        }

        for (const wf of items) {
            const item = this.createWorkflowItem(wf);
            this.workflowList.appendChild(item);
        }
    }

    createWorkflowItem(wf) {
        const item = document.createElement("div");
        item.className = "xzg-wf-item";
        item.draggable = true;
        item.dataset.path = wf.path;

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

        if (this.sortMode === "time") {
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
            alert("加载工作流失败: " + e.message);
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

    async saveCurrentWorkflow() {
        const name = prompt("请输入工作流名称：", "新工作流");
        if (!name) return;

        try {
            const data = app.graph.serialize();
            const res = await api.fetchApi("/xzg/workflows", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, workflow: data, overwrite: false })
            });

            if (res.status === 409) {
                if (!confirm("工作流已存在，是否覆盖？")) return;
                const res2 = await api.fetchApi("/xzg/workflows", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, workflow: data, overwrite: true })
                });
                if (!res2.ok) throw new Error("保存失败");
            } else if (!res.ok) {
                throw new Error("保存失败");
            }

            this.getWorkflowMeta(name);
            await this.loadWorkflows();
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.loadWorkflows) { try { await wfStore.loadWorkflows(); } catch (e) {} }
        } catch (e) {
            alert("保存工作流失败: " + e.message);
        }
    }

    async renameWorkflow(wf) {
        const newName = prompt("请输入新名称：", wf.name);
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
            alert("重命名失败: " + e.message);
        }
    }

    async deleteWorkflow(wf) {
        if (!confirm(`确定要删除工作流「${wf.name}」吗？`)) return;

        try {
            const res = await api.fetchApi(`/xzg/workflows/${encodeURIComponent(wf.path)}`, {
                method: "DELETE"
            });

            if (!res.ok) throw new Error("删除失败");

            if (this.meta.workflows[wf.path]) {
                delete this.meta.workflows[wf.path];
                this.saveMeta();
            }

            await this.loadWorkflows();
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.loadWorkflows) { try { await wfStore.loadWorkflows(); } catch (e) {} }
        } catch (e) {
            alert("删除失败: " + e.message);
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
        const promptText = parentFolder ? `请输入子分类名称（父分类：${parentFolder}）：` : "请输入分类名称：";
        const name = prompt(promptText);
        if (!name || !name.trim()) return;
        const folderName = name.trim();

        try {
            const res = await api.fetchApi("/xzg/wf-manage/folder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: folderName, parent: parentFolder })
            });

            if (res.status === 409) {
                alert("分类已存在！");
                return;
            }
            if (!res.ok) {
                let errMsg = "创建失败";
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
            alert("创建分类失败: " + e.message);
        }
    }

    async deleteCategory(cat) {
        if (!cat || cat.type !== "folder") return;
        
        if (!confirm(`确定要删除分类「${cat.name}」吗？\n分类内的所有工作流和子分类也将被删除！`)) return;

        try {
            const res = await api.fetchApi(`/xzg/wf-manage/folder/${encodeURIComponent(cat.path)}`, {
                method: "DELETE"
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "删除失败");
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
            alert("删除分类失败: " + e.message);
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
            alert("移动工作流失败: " + e.message);
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

    /** 取某一层（同父路径）下的所有文件夹节点（始终基于最新 this.tree） */
    getCurrentLayerFolders(parentPath) {
        if (!parentPath) {
            return (this.tree || []).filter(item => item.type === "folder");
        }
        const node = this.findFolderByPath(parentPath);
        return (node && node.children) ? node.children.filter(c => c.type === "folder") : [];
    }

    /** 判断一层文件夹是否已连续编号（序号 1..n 递增无跳号） */
    isLayerNumbered(siblings) {
        if (siblings.length === 0) return true;
        const nums = siblings.map(s => this.getFolderNumber(s.name)).sort((a, b) => a - b);
        for (let i = 0; i < nums.length; i++) {
            if (nums[i] !== i + 1) return false;
        }
        return true;
    }

    /** 把一层文件夹（按传入顺序）重命名为连续递增编号前缀，如 01_、02_ */
    async renumberLayer(siblings) {
        if (siblings.length === 0) return;
        const parentPath = this.getParentPath(siblings[0].path);
        const tmpParent = parentPath ? parentPath + "/" : "";
        // 每次调用使用「唯一」临时前缀：避免上一次编号中断后残留的 __xzg_tmp 造成冲突，
        // 否则 renameFolder 会因「目标已存在」返回 409 而中断，导致文件夹卡在 __xzg_tmp 状态。
        const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const tmpPrefix = "__xzg_tmp_" + uniq + "_";
        const targets = siblings.map((s, i) =>
            this.buildNumberPrefix(i + 1) + this.stripNumberPrefix(s.name));
        try {
            // 1) 全部改名到唯一临时名（即使存在历史残留的 __xzg_tmp 也不会冲突）
            //    单步失败不中断整体，避免后续步骤错乱
            for (let i = 0; i < siblings.length; i++) {
                try {
                    await this.renameFolder(siblings[i].path, tmpPrefix + i);
                } catch (e) {
                    console.warn("[小珠光] 重命名到临时名失败（已跳过）:", siblings[i].path, e);
                }
            }
            // 2) 临时名 → 目标连续编号名；对残留目标冲突做兜底，避免整体中断卡在 __xzg_tmp
            for (let i = 0; i < targets.length; i++) {
                const tmpFull = tmpParent + tmpPrefix + i;
                const targetName = targets[i];
                try {
                    await this.renameFolder(tmpFull, targetName);
                } catch (e) {
                    // 目标已存在（上一次中断残留）：先把残留目标移走，再重试一次
                    const targetFull = tmpParent + targetName;
                    try {
                        await this.renameFolder(targetFull, targetName + "__bak_" + uniq);
                    } catch (_) {}
                    try {
                        await this.renameFolder(tmpFull, targetName);
                    } catch (e2) {
                        console.warn("[小珠光] 重命名分类失败，已跳过:", tmpFull, e2);
                    }
                }
            }
        } finally {
            // 关键：无论重命名是否完全成功，都重新读取磁盘真实状态并刷新面板与官方 store。
            // 否则一旦 renameFolder 中途抛错，面板路径会与磁盘脱节，点击旧路径即 404。
            await this.loadWorkflows();
        }
    }

    /** 自动为所有文件夹添加/修正顺序编号前缀（已连续编号的层会被跳过） */
    /** 判断整棵树是否存在「未连续编号」的层（含递归子层） */
    needsAutoNumbering(tree, parentPath = "") {
        const folders = tree.filter(item => item.type === "folder");
        for (const f of folders) {
            if (f.children && f.children.length > 0) {
                if (this.needsAutoNumbering(f.children, f.path)) return true;
            }
        }
        const layer = this.getCurrentLayerFolders(parentPath);
        if (layer.length > 0 && !this.isLayerNumbered(layer)) return true;
        return false;
    }

    async autoNumberCategories() {
        if (!this.tree || this.tree.length === 0) {
            localStorage.setItem("xzg_wf_auto_numbered", "1");
            return;
        }
        try {
            await this.autoNumberLayer(this.tree, "");
            localStorage.setItem("xzg_wf_auto_numbered", "1");
        } catch (e) {
            console.warn("[小珠光] 自动编号失败:", e);
        } finally {
            await this.loadWorkflows();
        }
    }

    /** 递归自动编号：最深层级优先，避免父目录改名导致子路径失效 */
    async autoNumberLayer(tree, parentPath) {
        const folders = tree.filter(item => item.type === "folder");
        for (const f of folders) {
            if (f.children && f.children.length > 0) {
                await this.autoNumberLayer(f.children, f.path);
            }
        }
        const layer = this.getCurrentLayerFolders(parentPath);
        if (layer.length > 0 && !this.isLayerNumbered(layer)) {
            await this.renumberLayer(layer);
        }
    }

    // ====== 分类排序调整 ======

    /** 获取同一层级的所有同级文件夹信息 */
    getSiblingFolders(cat) {
        const parentPath = this.getParentPath(cat.path);
        let siblings = [];

        if (!parentPath) {
            // 根层级
            siblings = this.tree.filter(item => item.type === "folder");
        } else {
            // 子层级：找到父节点
            const parentNode = this.findFolderByPath(parentPath);
            if (parentNode && parentNode.children) {
                siblings = parentNode.children.filter(c => c.type === "folder");
            }
        }

        // 按数字序或名称排序
        siblings.sort((a, b) => {
            const na = this.getFolderNumber(a.name);
            const nb = this.getFolderNumber(b.name);
            if (na !== -1 && nb !== -1) return na - nb;
            if (na !== -1) return -1;
            if (nb !== -1) return 1;
            return a.name.localeCompare(b.name);
        });

        return siblings;
    }

    /** 上移分类 */
    async moveCategoryUp(cat) {
        await this.reorderCategory(cat, -1);
    }

    /** 下移分类 */
    async moveCategoryDown(cat) {
        await this.reorderCategory(cat, +1);
    }

    /** 调整分类顺序：dir 为 -1（上移）或 +1（下移） */
    async reorderCategory(cat, dir) {
        const siblings = this.getSiblingFolders(cat);
        const idx = siblings.findIndex(s => s.path === cat.path);
        if (idx === -1) return;
        const newIdx = idx + dir;
        if (newIdx < 0 || newIdx >= siblings.length) return; // 已在最前/最后

        // 构造移动后的新顺序，再整体重编号为连续递增序号
        const ordered = siblings.slice();
        const [moved] = ordered.splice(idx, 1);
        ordered.splice(newIdx, 0, moved);
        await this.renumberLayer(ordered);
    }

    /** 拖拽分类到指定间隙位置（insertIndex 为同级层中的目标序号） */
    async reorderCategoryToIndex(cat, insertIndex) {
        const siblings = this.getSiblingFolders(cat);
        const idx = siblings.findIndex(s => s.path === cat.path);
        if (idx === -1) return;
        // 将 insertIndex 由“原数组位置”换算为“移除后的目标位置”
        let to = idx < insertIndex ? insertIndex - 1 : insertIndex;
        if (to === idx) return;
        const ordered = siblings.slice();
        const [moved] = ordered.splice(idx, 1);
        ordered.splice(to, 0, moved);
        await this.renumberLayer(ordered);
    }

    _handleCatDragOver(e, item, folderPath) {
        const drag = this._wfCatDrag;
        if (!drag) return;
        // 仅允许在同一层级（同父目录）内排序
        if (this.getParentPath(drag.path) !== this.getParentPath(folderPath)) {
            this._removeWfCatInsertIndicator();
            return;
        }
        const rect = item.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        const siblings = this.getSiblingFolders({ path: drag.path });
        const idx = siblings.findIndex(s => s.path === folderPath);
        if (idx < 0) { this._removeWfCatInsertIndicator(); return; }
        this._wfCatInsertIndex = before ? idx : idx + 1;
        const wrapper = item.closest(".xzg-wf-folder-wrapper");
        if (!wrapper) return;
        this._showWfCatInsertIndicator(wrapper, before);
    }

    async _handleCatDrop(e, item, folderPath) {
        const drag = this._wfCatDrag;
        this._removeWfCatInsertIndicator();
        if (!drag) return;
        if (this.getParentPath(drag.path) !== this.getParentPath(folderPath)) return;
        const insertIndex = this._wfCatInsertIndex;
        this._wfCatInsertIndex = null;
        this._wfCatDrag = null;
        if (insertIndex === null || insertIndex === undefined) return;
        await this.reorderCategoryToIndex({ path: drag.path }, insertIndex);
    }

    _showWfCatInsertIndicator(wrapper, before) {
        this._removeWfCatInsertIndicator();
        const indicator = document.createElement("div");
        indicator.className = "xzg-wf-cat-insert-indicator";
        if (before) {
            wrapper.parentNode.insertBefore(indicator, wrapper);
        } else {
            const next = wrapper.nextElementSibling;
            wrapper.parentNode.insertBefore(indicator, next);
        }
    }

    _removeWfCatInsertIndicator() {
        if (this.categoryList) {
            const el = this.categoryList.querySelector(".xzg-wf-cat-insert-indicator");
            if (el) el.remove();
        }
    }

    exportWorkflows() {
        const exportData = {
            version: 1,
            type: 'xzg-workflows-config',
            meta: JSON.parse(JSON.stringify(this.meta)),
            exportedAt: new Date().toISOString()
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `xzg-workflows-meta-${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(url);
        }, 0);
    }

    async importWorkflows(e) {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        for (const file of files) {
            try {
                const text = await file.text();
                const data = JSON.parse(text);

                if (data.type === 'xzg-workflows-config' && data.meta) {
                    if (!confirm("检测到工作流元数据配置，是否导入？")) continue;
                    Object.assign(this.meta.workflows, data.meta.workflows || {});
                    this.saveMeta();
                    await this.loadWorkflows();
                    alert("元数据导入成功！");
                } else {
                    const name = file.name.replace(/\.json$/, '');
                    const res = await api.fetchApi("/xzg/workflows", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name, workflow: data, overwrite: false })
                    });
                    if (res.status === 409) {
                        if (!confirm(`工作流「${name}」已存在，是否覆盖？`)) continue;
                        await api.fetchApi("/xzg/workflows", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name, workflow: data, overwrite: true })
                        });
                    }
                }
            } catch (err) {
                console.warn("[小珠光] 导入文件失败:", file.name, err);
            }
        }

        await this.loadWorkflows();
        e.target.value = "";
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
    }
});
