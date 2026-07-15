import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { pinyin as pinyinPro } from "./pinyin-pro.esm.js";

const STORAGE_KEY = "xzg_workflows_meta";
const PLUGIN_NAME = "工作流";
const SETTING_TOGGLE_SHORTCUT = "xzg_wf_toggle_shortcut";

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
            this.waitForExtensionManager().then(() => {
                this.registerSidebarTab();
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
        icon.style.color = '#FFD700';
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
        dialog.innerHTML = `
            <div class="xzg-wf-dialog">
                <div class="xzg-wf-dialog-title">设置快捷键</div>
                <div class="xzg-wf-dialog-body">
                    <p style="margin-bottom: 16px; color: #888; font-size: 13px; text-align: center;">请按下你想要的快捷键</p>
                    <div style="text-align: center; margin-bottom: 16px;">
                        <div id="xzg-wf-listen-display" style="
                            padding: 16px 24px;
                            background: #FFD700;
                            border: 2px solid #FFD700;
                            border-radius: 6px;
                            color: #1a1a1a;
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
        `;

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
            display.style.color = "#FFD700";
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
        try {
            if (app.extensionManager?.sidebarTab?.toggleSidebarTab) {
                app.extensionManager.sidebarTab.toggleSidebarTab('xiaozhuguang-workflows');
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
                this.hideContextMenu();
                this.hideMoveSubmenu();
                document.removeEventListener("mousedown", closeHandler);
                document.removeEventListener("keydown", keyHandler);
            }
        };
        
        const keyHandler = (ev) => {
            if (ev.key === "Escape") {
                this.hideContextMenu();
                this.hideMoveSubmenu();
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
        if (this._moveSubmenu) {
            this._moveSubmenu.remove();
            this._moveSubmenu = null;
        }
    }

    showMoveSubmenu(e, wf, parentItem) {
        this.hideMoveSubmenu();

        const submenu = document.createElement("div");
        submenu.className = "xzg-wf-submenu";

        const currentFolder = wf.folder === "未分类" ? "" : wf.folder;

        const buildFolderItems = (folders, parentPath = "") => {
            let html = '';
            for (const folder of folders) {
                if (folder.type !== "folder") continue;
                const fullPath = parentPath ? parentPath + "/" + folder.name : folder.name;
                const selected = fullPath === currentFolder ? ' selected' : '';
                const hasSubFolders = folder.children && folder.children.some(c => c.type === "folder");
                html += `<div class="xzg-wf-submenu-item${selected}${hasSubFolders ? ' has-children' : ''}" data-folder="${fullPath}">
                    <span>${folder.name}</span>
                    ${hasSubFolders ? '<span class="xzg-wf-submenu-arrow">▶</span>' : ''}
                </div>`;
            }
            return html;
        };

        let html = '';
        const isUncategorized = currentFolder === "";
        html += `<div class="xzg-wf-submenu-item${isUncategorized ? ' selected' : ''}" data-folder="">
            <span>未分类</span>
        </div>`;

        if (this.tree && this.tree.length > 0) {
            html += buildFolderItems(this.tree);
        }

        submenu.innerHTML = html;
        document.body.appendChild(submenu);

        const parentRect = parentItem.getBoundingClientRect();
        const subRect = submenu.getBoundingClientRect();
        const vw = window.innerWidth;

        let subLeft = parentRect.right + 2;
        let subTop = parentRect.top;

        if (subLeft + subRect.width > vw) {
            subLeft = parentRect.left - subRect.width - 2;
        }

        submenu.style.left = subLeft + "px";
        submenu.style.top = subTop + "px";

        this._moveSubmenu = submenu;

        const self = this;

        submenu.querySelectorAll(".xzg-wf-submenu-item").forEach(item => {
            const folderPath = item.dataset.folder;
            const hasChildren = item.classList.contains("has-children");
            let childSubmenu = null;

            const removeChildSubmenu = () => {
                if (childSubmenu) {
                    childSubmenu.remove();
                    childSubmenu = null;
                }
            };

            item.addEventListener("mouseenter", (ev) => {
                if (hasChildren) {
                    removeChildSubmenu();
                    childSubmenu = self.buildFolderSubmenu(folderPath, wf, item);
                }
            });

            item.addEventListener("mouseleave", (ev) => {
                if (childSubmenu && !childSubmenu.contains(ev.relatedTarget)) {
                    setTimeout(() => {
                        if (!item.matches(":hover") && !childSubmenu.matches(":hover")) {
                            removeChildSubmenu();
                        }
                    }, 100);
                }
            });

            item.addEventListener("click", (ev) => {
                ev.stopPropagation();
                this.hideContextMenu();
                this.hideMoveSubmenu();
                this.moveWorkflowToFolder(wf, folderPath);
            });
        });
    }

    buildFolderSubmenu(folderPath, wf, parentItem) {
        const folderData = this.findFolderByPath(folderPath);
        if (!folderData || !folderData.children) return null;

        const submenu = document.createElement("div");
        submenu.className = "xzg-wf-submenu xzg-wf-submenu-child";

        const currentFolder = wf.folder === "未分类" ? "" : wf.folder;
        const subFolders = folderData.children.filter(c => c.type === "folder");

        let html = '';
        for (const folder of subFolders) {
            const fullPath = folderPath + "/" + folder.name;
            const selected = fullPath === currentFolder ? ' selected' : '';
            const hasSubFolders = folder.children && folder.children.some(c => c.type === "folder");
            html += `<div class="xzg-wf-submenu-item${selected}${hasSubFolders ? ' has-children' : ''}" data-folder="${fullPath}">
                <span>${folder.name}</span>
                ${hasSubFolders ? '<span class="xzg-wf-submenu-arrow">▶</span>' : ''}
            </div>`;
        }

        if (!html) return null;

        submenu.innerHTML = html;
        document.body.appendChild(submenu);

        const parentRect = parentItem.getBoundingClientRect();
        const subRect = submenu.getBoundingClientRect();
        const vw = window.innerWidth;

        let subLeft = parentRect.right + 2;
        let subTop = parentRect.top;

        if (subLeft + subRect.width > vw) {
            subLeft = parentRect.left - subRect.width - 2;
        }

        submenu.style.left = subLeft + "px";
        submenu.style.top = subTop + "px";

        const self = this;
        submenu.querySelectorAll(".xzg-wf-submenu-item").forEach(item => {
            const fp = item.dataset.folder;
            const hasChildren = item.classList.contains("has-children");
            let childSubmenu = null;

            const removeChildSubmenu = () => {
                if (childSubmenu) {
                    childSubmenu.remove();
                    childSubmenu = null;
                }
            };

            item.addEventListener("mouseenter", () => {
                if (hasChildren) {
                    removeChildSubmenu();
                    childSubmenu = self.buildFolderSubmenu(fp, wf, item);
                }
            });

            item.addEventListener("mouseleave", (ev) => {
                if (childSubmenu && !childSubmenu.contains(ev.relatedTarget)) {
                    setTimeout(() => {
                        if (!item.matches(":hover") && !childSubmenu.matches(":hover")) {
                            removeChildSubmenu();
                        }
                    }, 100);
                }
            });

            item.addEventListener("click", (ev) => {
                ev.stopPropagation();
                this.hideContextMenu();
                this.hideMoveSubmenu();
                this.moveWorkflowToFolder(wf, fp);
            });
        });

        return submenu;
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
        
        const menu = document.createElement("div");
        menu.className = "xzg-wf-context-menu";
        menu.innerHTML = `
            <div class="xzg-wf-ctx-item" data-action="new-subfolder">📁 新建子分类</div>
            <div class="xzg-wf-ctx-item danger" data-action="delete">🗑️ 删除分类</div>
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
                
                if (action === "delete") {
                    this.deleteCategory(cat);
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
        if (this._contextMenu) {
            this._contextMenu.remove();
            this._contextMenu = null;
            this._contextMenuWf = null;
        }
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
            preview.style.cssText = `
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
            `;
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
                            <div class="xzg-wf-header-btn xzg-wf-refresh-btn" id="xzg-wf-refresh-btn" title="刷新">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M21 12a9 9 0 1 1-3-6.7L21 8"/>
                                    <polyline points="21 3 21 8 16 8"/>
                                </svg>
                            </div>
                            <button class="xzg-wf-header-btn xzg-wf-shortcut-btn" id="xzg-wf-shortcut-btn" title="设置快捷键">快捷键: \`</button>
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
        style.textContent = `
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
                padding: 5px 12px;
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
                background: var(--comfy-input-bg, #333);
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
                background: var(--comfy-input-bg, #333);
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
                color: #FFD700 !important;
                border-color: #FFD700 !important;
            }
            .xzg-wf-shortcut-btn:hover {
                background: rgba(255, 215, 0, 0.1) !important;
            }
            .xzg-wf-refresh-btn {
                padding: 5px 8px;
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 4px;
                cursor: pointer;
                user-select: none;
                transition: all 0.15s;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .xzg-wf-refresh-btn:hover {
                color: #FFD700;
                background: rgba(255, 215, 0, 0.1);
                border-color: rgba(255, 215, 0, 0.3);
            }
            .xzg-wf-refresh-btn.xzg-wf-spinning svg {
                animation: xzg-wf-spin 0.6s linear infinite;
            }
            @keyframes xzg-wf-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
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

        const refreshBtn = container.querySelector("#xzg-wf-refresh-btn");
        if (refreshBtn) {
            refreshBtn.addEventListener("click", () => {
                this.refreshWorkflows();
            });
        }

        const shortcutBtn = container.querySelector("#xzg-wf-shortcut-btn");
        if (shortcutBtn) {
            shortcutBtn.addEventListener("click", () => {
                this.showShortcutDialog();
            });
        }
        this.updateShortcutDisplay();

    }

    async refreshWorkflows() {
        const refreshBtn = this.container?.querySelector("#xzg-wf-refresh-btn");
        if (refreshBtn) {
            refreshBtn.classList.add("xzg-wf-spinning");
        }
        try {
            await this.loadWorkflows();
            const wfStore = app.extensionManager?.workflow;
            if (wfStore?.loadWorkflows) {
                try { await wfStore.loadWorkflows(); } catch (e) {}
            }
        } catch (e) {
            console.warn("[小珠光] 刷新工作流失败:", e);
        } finally {
            if (refreshBtn) {
                setTimeout(() => {
                    refreshBtn.classList.remove("xzg-wf-spinning");
                }, 300);
            }
        }
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
        try {
            const wfStore = app.extensionManager?.workflow;
            const officialPath = 'workflows/' + path + '.json';

            let data = null;
            let persistedWf = null;
            let isAlreadyOpen = false;
            let isAlreadyActive = false;

            if (wfStore?.openWorkflow && wfStore?.getWorkflowByPath) {
                persistedWf = wfStore.getWorkflowByPath(officialPath);
                if (!persistedWf && typeof wfStore.loadWorkflows === 'function') {
                    await wfStore.loadWorkflows();
                    persistedWf = wfStore.getWorkflowByPath(officialPath);
                }

                if (persistedWf) {
                    isAlreadyActive = wfStore.isActive ? wfStore.isActive(persistedWf) : false;
                    isAlreadyOpen = wfStore.isOpen ? wfStore.isOpen(persistedWf) : false;

                    if (isAlreadyActive) {
                        return;
                    }

                    if (isAlreadyOpen) {
                        await wfStore.openWorkflow(persistedWf);
                        return;
                    }

                    if (!persistedWf.isLoaded) {
                        await persistedWf.load();
                    }
                    data = JSON.parse(persistedWf.content);
                }
            }

            if (!data) {
                const res = await api.fetchApi(`/xzg/workflows/${encodeURIComponent(path)}`, { cache: "no-store" });
                if (!res.ok) throw new Error("加载失败");
                data = await res.json();
            }

            if (persistedWf && wfStore) {
                await wfStore.openWorkflow(persistedWf);
                await new Promise(r => setTimeout(r, 50));

                const graph = app.graph;
                const canvas = app.canvas;
                graph.beforeChange();
                graph.clear();
                graph.configure(data);
                graph.afterChange();

                await new Promise(r => setTimeout(r, 50));

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

                if (canvas?.setDirty) {
                    canvas.setDirty(true, true);
                }

                if (data.id) {
                    location.hash = data.id;
                }
            } else {
                app.loadGraphData(data);
            }

            await new Promise(r => setTimeout(r, 100));
            app.canvas?.draw(true, true);

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
    }
});
