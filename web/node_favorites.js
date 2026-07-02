import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { pinyin as pinyinPro } from "./pinyin-pro.esm.js";
window.pinyinPro = { pinyin: pinyinPro };

const STORAGE_KEY = "comfyui_xiaozhuguang";
const SETTING_TOGGLE_SHORTCUT = "xiaozhuguang.ToggleShortcut";

let nodeFavoritesInstance = null;

class Xiaozhuguang {
    constructor() {
        this.favorites = this.loadFavorites();
        this.panel = null;
        this.searchInput = null;
        this.favoritesList = null;
        this.categoryList = null;
        this.currentCategory = "all";
        this.currentSearch = "";
        this.initialized = false;
        this.draggingNodeType = null;
        this.init();
    }

    loadFavorites() {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            if (data) {
                const parsed = JSON.parse(data);
                if (!parsed.categories) {
                    parsed.categories = [{ id: "default", name: "默认收藏", color: "#4CAF50" }];
                }
                parsed.categories.forEach((c, i) => {
                    if (c.order === undefined) c.order = i;
                });
                if (!parsed.nodes) {
                    parsed.nodes = [];
                }
                if (!parsed.workflows) {
                    parsed.workflows = [];
                }
                if (!parsed.sortMode) {
                    parsed.sortMode = "default";
                }
                parsed.nodes.forEach((n, i) => {
                    if (n.rating === undefined) n.rating = 0;
                    if (n.order === undefined) n.order = Date.now() + i;
                    if (n.useCount === undefined) n.useCount = 0;
                    if (n.lastUsed === undefined) n.lastUsed = 0;
                });
                parsed.workflows.forEach((w, i) => {
                    if (w.useCount === undefined) w.useCount = 0;
                    if (w.lastUsed === undefined) w.lastUsed = 0;
                    if (w.addedAt === undefined) w.addedAt = Date.now() + i;
                });
                return parsed;
            }
        } catch (e) {
            console.error("加载收藏失败:", e);
        }
        return {
            categories: [{ id: "default", name: "默认收藏", color: "#F44336" }],
            nodes: [],
            workflows: [],
            sortMode: "default"
        };
    }

    saveFavorites() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.favorites));
        } catch (e) {
            console.error("保存收藏失败:", e);
        }
    }

    init() {
        if (this.initialized) return;
        this.initialized = true;

        document.querySelectorAll(".xzg-panel-resizer").forEach(el => el.remove());

        try {
            this.injectCSS();
            this.setupKeyboardListener();
            this.setupDragDrop();
            this.waitForCanvasReady().then(() => {
                this.createPanel();
                this.extendNodeMenu();
                this.extendCanvasMenu();
                this.extendGroupMenu();
            });
        } catch (e) {
            console.error("Xiaozhuguang 初始化失败:", e);
        }
    }

    setupDragDrop() {
        const self = this;

        document.addEventListener("mousemove", (e) => {
            if (self.draggingNodeType) {
                self.updateDragPreview(e.clientX, e.clientY);
            }
        });

        document.addEventListener("mouseup", (e) => {
            if (self.draggingNodeType) {
                const canvas = app.canvas;
                if (canvas && canvas.canvas) {
                    const rect = canvas.canvas.getBoundingClientRect();
                    if (e.clientX >= rect.left && e.clientX <= rect.right &&
                        e.clientY >= rect.top && e.clientY <= rect.bottom) {
                        const offsetX = e.clientX - rect.left;
                        const offsetY = e.clientY - rect.top;
                        const pos = canvas.convertCanvasToOffset([offsetX, offsetY]);
                        if (pos) {
                            self.addNodeToCanvasAt(self.draggingNodeType, pos[0], pos[1]);
                        } else {
                            self.addNodeToCanvasAt(self.draggingNodeType, offsetX, offsetY);
                        }
                    }
                }
                self.removeDragPreview();
                self.draggingNodeType = null;
            }
        });
    }

    updateDragPreview(x, y, name = "") {
        let preview = document.getElementById("nf-drag-preview");
        if (!preview) {
            preview = document.createElement("div");
            preview.id = "nf-drag-preview";
            preview.style.cssText = `
                position: fixed;
                padding: 10px 18px;
                background: linear-gradient(135deg, #4CAF50, #45a049);
                color: white;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 500;
                pointer-events: none;
                z-index: 10000;
                white-space: nowrap;
                box-shadow: 0 6px 20px rgba(76, 175, 80, 0.4);
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
        const preview = document.getElementById("nf-drag-preview");
        if (preview) {
            preview.remove();
        }
    }

    recordUse(nodeType) {
        const node = this.favorites.nodes.find(n => n.type === nodeType);
        if (node) {
            node.useCount = (node.useCount || 0) + 1;
            node.lastUsed = Date.now();
            this.saveFavorites();
            this.renderFavorites();
        }
    }

    isNodeTypeValid(nodeType) {
        try {
            if (typeof LiteGraph === 'undefined') return true;
            if (LiteGraph.registered_node_types && nodeType in LiteGraph.registered_node_types) return true;
            if (LiteGraph.Nodes && nodeType in LiteGraph.Nodes) return true;
            return false;
        } catch (e) {
            return true;
        }
    }

    getInvalidFavorites() {
        return this.favorites.nodes.filter(n => !this.isNodeTypeValid(n.type));
    }

    removeInvalidFavorites() {
        const invalid = this.getInvalidFavorites();
        const count = invalid.length;
        if (count === 0) return 0;
        this.favorites.nodes = this.favorites.nodes.filter(n => this.isNodeTypeValid(n.type));
        this.saveFavorites();
        this.renderFavorites();
        this.renderCategories();
        return count;
    }

    addNodeToCanvasAt(nodeType, canvasX, canvasY) {
        this.recordUse(nodeType);
        try {
            const node = LiteGraph.createNode(nodeType);
            if (!node) {
                console.error(`无法创建节点: ${nodeType}`);
                return;
            }

            const canvas = app.canvas;
            if (!canvas || !app.graph) {
                console.error("画布或图未初始化");
                return;
            }

            node.pos = [canvasX, canvasY];
            app.graph.add(node);
            canvas.setDirty(true, true);

            if (node.onAdded) {
                node.onAdded();
            }

            app.graph.change();
        } catch (e) {
            console.error("添加节点到画布失败:", e);
        }
    }

    getShortcut() {
        try {
            const stored = localStorage.getItem(SETTING_TOGGLE_SHORTCUT);
            if (stored) {
                return JSON.parse(stored);
            }
        } catch (e) {}
        return { key: "q", ctrl: false, alt: false, shift: false, meta: false };
    }

    saveShortcut(shortcut) {
        localStorage.setItem(SETTING_TOGGLE_SHORTCUT, JSON.stringify(shortcut));
    }

    setupKeyboardListener() {
        const self = this;

        document.addEventListener("keydown", function handler(e) {
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) {
                return;
            }

            const shortcut = self.getShortcut();
            if (!shortcut || !shortcut.key) return;

            const key = e.key.toLowerCase();
            if (key !== shortcut.key.toLowerCase()) return;

            if (!!e.ctrlKey !== !!shortcut.ctrl) return;
            if (!!e.altKey !== !!shortcut.alt) return;
            if (!!e.shiftKey !== !!shortcut.shift) return;
            if (!!e.metaKey !== !!shortcut.meta) return;

            e.preventDefault();
            e.stopPropagation();
            self.togglePanel();
        });
    }

    async waitForCanvasReady() {
        return new Promise((resolve) => {
            let attempts = 0;
            const maxAttempts = 100;

            const checkReady = () => {
                attempts++;

                if (typeof LGraphCanvas !== "undefined" &&
                    document.querySelector(".litegraph") &&
                    app && app.graph) {
                    setTimeout(resolve, 100);
                    return;
                }

                if (attempts >= maxAttempts) {
                    console.warn("Xiaozhuguang: 等待画布超时，继续初始化");
                    setTimeout(resolve, 500);
                    return;
                }

                requestAnimationFrame(checkReady);
            };

            checkReady();
        });
    }

    injectCSS() {
        if (document.getElementById("node-favorites-styles")) return;

        const style = document.createElement("style");
        style.id = "node-favorites-styles";
        style.textContent = this.getCSS();
        document.head.appendChild(style);
    }

    getCSS() {
        return `
            #node-favorites-panel {
                position: fixed;
                top: 100px;
                right: 10px;
                width: 520px;
                height: 70vh;
                background: rgba(30, 30, 30, 0.95);
                border: 1px solid #444;
                border-radius: 8px;
                color: #ddd;
                font-family: Arial, sans-serif;
                font-size: 13px;
                z-index: 1000;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
                user-select: none;
                display: flex;
                flex-direction: column;
            }

            #node-favorites-panel.collapsed {
                display: none;
            }

            #node-favorites-panel * {
                box-sizing: border-box;
            }

            .nf-icon-btn {
                display: none;
            }

            #node-favorites-panel.collapsed .nf-header,
            #node-favorites-panel.collapsed .nf-content {
                display: none;
            }

            .nf-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 12px;
                background: rgba(50, 50, 50, 0.8);
                border-bottom: 1px solid #444;
                border-radius: 8px 8px 0 0;
                cursor: move;
                user-select: none;
                flex-shrink: 0;
            }

            .nf-header:active {
                cursor: grabbing;
            }

            .nf-title {
                font-weight: bold;
                font-size: 14px;
            }

            .nf-header-btns {
                display: flex;
                gap: 6px;
                align-items: center;
            }

            .nf-header-btn {
                background: transparent;
                border: 1px solid #666;
                color: #ddd;
                width: 24px;
                height: 24px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                line-height: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0;
            }

            .nf-header-btn:hover {
                background: #555;
                border-color: #888;
            }

            .nf-toggle-btn {
                background: transparent;
                border: 1px solid #666;
                color: #ddd;
                width: 24px;
                height: 24px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .nf-toggle-btn:hover {
                background: #555;
                border-color: #888;
            }

            .nf-shortcut-display {
                background: linear-gradient(135deg, #4CAF50, #45a049);
                border: 1px solid #4CAF50;
                color: #fff;
                font-weight: bold;
                font-size: 10px;
                min-width: 80px;
                padding: 0 8px;
            }

            .nf-shortcut-display:hover {
                background: linear-gradient(135deg, #45a049, #3d8b40);
                transform: scale(1.05);
            }

            .nf-content {
                padding: 10px;
                flex: 1;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }

            .nf-search-box {
                position: relative;
                margin-bottom: 10px;
                flex-shrink: 0;
            }

            .nf-split-container {
                display: flex;
                gap: 10px;
                flex: 1;
                overflow: hidden;
            }

            .nf-left-col {
                display: flex;
                flex-direction: column;
                overflow: hidden;
                flex-shrink: 0;
            }

            .nf-split-handle {
                width: 4px;
                cursor: col-resize;
                background: #444;
                flex-shrink: 0;
                transition: background 0.2s;
            }
            .nf-split-handle:hover {
                background: #4CAF50;
            }

            .nf-right-col {
                flex: 1;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }

            #nf-search-input {
                width: 100%;
                padding: 8px 30px 8px 10px;
                background: #2a2a2a;
                border: 1px solid #555;
                border-radius: 4px;
                color: #ddd;
                font-size: 13px;
            }

            #nf-search-input:focus {
                outline: none;
                border-color: #4CAF50;
            }

            .nf-clear-btn {
                position: absolute;
                right: 8px;
                top: 50%;
                transform: translateY(-50%);
                background: transparent;
                border: none;
                color: #888;
                cursor: pointer;
                font-size: 14px;
                padding: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
            }

            .nf-clear-btn:hover {
                background: #555;
                color: #fff;
            }
        ` + this.getCategoryCSS() + this.getFavoritesCSS() + this.getDialogCSS();
    }

    getCategoryCSS() {
        return `
            .nf-categories-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 4px 0 8px 0;
                font-weight: bold;
                color: #aaa;
                font-size: 12px;
                text-transform: uppercase;
                flex-shrink: 0;
            }

            .nf-add-cat-btn {
                background: #3a3a3a;
                border: 1px solid #555;
                color: #aaa;
                width: 22px;
                height: 22px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                line-height: 1;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .nf-add-cat-btn:hover {
                background: #4CAF50;
                color: #fff;
                border-color: #4CAF50;
            }

            .nf-category-list {
                display: flex;
                flex-direction: column;
                gap: 3px;
                overflow-y: auto;
                flex: 1;
                padding-right: 2px;
            }

            .nf-category-item {
                display: flex;
                align-items: center;
                padding: 6px 8px;
                background: #2a2a2a;
                border: 1px solid #3a3a3a;
                border-radius: 4px;
                cursor: pointer;
                transition: all 0.2s;
                gap: 8px;
            }

            .nf-category-item:hover {
                background: #333;
                border-color: #555;
            }

            .nf-category-item.active {
                background: rgba(76, 175, 80, 0.2);
                border-color: #4CAF50;
            }

            .nf-cat-color {
                width: 10px;
                height: 10px;
                border-radius: 50%;
                flex-shrink: 0;
            }

            .nf-cat-name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .nf-cat-invalid-count {
                background: rgba(255,107,107,0.2);
                color: #ff6b6b;
                font-size: 10px;
                padding: 1px 6px;
                border-radius: 8px;
                flex-shrink: 0;
                font-weight: 600;
            }

        `;
    }

    getFavoritesCSS() {
        return `
            .nf-favorites-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 4px 0 8px 0;
                font-weight: bold;
                color: #aaa;
                font-size: 12px;
                text-transform: uppercase;
                flex-shrink: 0;
            }

            .nf-fav-header-left {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .nf-sort-btns {
                display: flex;
                gap: 4px;
            }

            .nf-sort-btn {
                background: #3a3a3a;
                border: 1px solid #555;
                color: #888;
                width: 24px;
                height: 22px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                line-height: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                transition: all 0.2s;
            }

            .nf-sort-btn:hover {
                background: #444;
                color: #ccc;
                border-color: #666;
            }

            .nf-sort-btn.active {
                background: rgba(76, 175, 80, 0.2);
                border-color: #4CAF50;
                color: #4CAF50;
            }

            .nf-count {
                background: #444;
                padding: 2px 8px;
                border-radius: 10px;
                font-size: 11px;
            }

            .nf-clear-invalid-btn {
                background: rgba(255,107,107,0.15);
                border: 1px solid rgba(255,107,107,0.4);
                color: #ff6b6b;
                padding: 2px 8px;
                border-radius: 10px;
                font-size: 11px;
                cursor: pointer;
                line-height: 1;
                transition: all 0.2s;
            }
            .nf-clear-invalid-btn:hover {
                background: rgba(255,107,107,0.3);
                border-color: #ff6b6b;
            }

            .nf-favorites-list {
                display: flex;
                flex-direction: column;
                gap: 4px;
                overflow-y: auto;
                flex: 1;
                padding-right: 2px;
            }

            .nf-fav-item {
                display: flex;
                align-items: center;
                padding: 8px;
                background: #2a2a2a;
                border: 1px solid #3a3a3a;
                border-radius: 4px;
                cursor: grab;
                transition: all 0.2s;
                gap: 8px;
                user-select: none;
            }

            .nf-fav-item:active {
                cursor: grabbing;
            }

            .nf-fav-item:hover {
                background: #333;
                border-color: #4CAF50;
                transform: translateX(-2px);
            }

            .nf-fav-item.nf-reorder-dragging {
                opacity: 0.5;
                background: #3a3a3a;
                border-color: #4CAF50;
            }

            .nf-fav-drag-handle {
                color: #666;
                cursor: grab;
                font-size: 12px;
                padding: 2px 4px;
                border-radius: 3px;
                flex-shrink: 0;
                user-select: none;
            }

            .nf-fav-drag-handle:hover {
                color: #4CAF50;
                background: #333;
            }

            .nf-fav-color {
                width: 4px;
                height: 32px;
                border-radius: 2px;
                flex-shrink: 0;
            }

            .nf-fav-info {
                flex: 1;
                min-width: 0;
            }

            .nf-fav-name {
                font-weight: bold;
                font-size: 13px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .nf-fav-type {
                font-size: 11px;
                color: #888;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .nf-fav-actions {
                display: flex;
                gap: 4px;
            }

            .nf-fav-rating {
                display: flex;
                gap: 1px;
                padding: 0 4px;
            }

            .nf-star {
                font-size: 13px;
                color: #444;
                cursor: pointer;
                transition: color 0.15s;
                user-select: none;
            }

            .nf-star:hover {
                color: #FFC107;
                transform: scale(1.2);
            }

            .nf-star.filled {
                color: #FFC107;
            }

            .nf-fav-item.nf-invalid {
                opacity: 0.55;
                cursor: default;
                border-color: rgba(255,107,107,0.25);
            }
            .nf-fav-item.nf-invalid:hover {
                transform: none;
                border-color: rgba(255,107,107,0.4);
            }

            .nf-del-invalid-btn {
                background: transparent;
                border: 1px solid rgba(255,107,107,0.4);
                color: #ff6b6b;
                width: 22px;
                height: 22px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                line-height: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                flex-shrink: 0;
                transition: all 0.2s;
            }
            .nf-del-invalid-btn:hover {
                background: rgba(255,107,107,0.15);
                border-color: #ff6b6b;
            }

            .nf-empty-tip {
                text-align: center;
                padding: 30px 10px;
                color: #666;
                font-size: 12px;
                line-height: 1.8;
            }

            .nf-content::-webkit-scrollbar {
                width: 6px;
            }

            .nf-content::-webkit-scrollbar-track {
                background: #1e1e1e;
            }

            .nf-content::-webkit-scrollbar-thumb {
                background: #444;
                border-radius: 3px;
            }

            .nf-content::-webkit-scrollbar-thumb:hover {
                background: #555;
            }

            .nf-shortcut-bar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 10px;
                background: rgba(76, 175, 80, 0.1);
                border: 1px solid rgba(76, 175, 80, 0.3);
                border-radius: 4px;
                margin-bottom: 10px;
                cursor: pointer;
                transition: all 0.2s;
            }

            .nf-shortcut-bar:hover {
                background: rgba(76, 175, 80, 0.2);
                border-color: #4CAF50;
            }

            .nf-shortcut-label {
                font-size: 11px;
                color: #888;
            }

            .nf-shortcut-key {
                font-size: 12px;
                font-weight: bold;
                color: #4CAF50;
                background: #2a2a2a;
                padding: 3px 8px;
                border-radius: 3px;
                border: 1px solid #444;
            }

            .nf-shortcut-hint {
                font-size: 10px;
                color: #666;
            }
        `;
    }

    getDialogCSS() {
        return `
            .nf-dialog-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.6);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 9999;
            }

            .nf-dialog {
                background: #2a2a2a;
                border: 1px solid #444;
                border-radius: 8px;
                min-width: 300px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            }

            .nf-dialog-title {
                padding: 12px 16px;
                border-bottom: 1px solid #444;
                font-weight: bold;
                color: #ddd;
            }

            .nf-dialog-body {
                padding: 16px;
                color: #ccc;
                max-height: 400px;
                overflow-y: auto;
            }

            .nf-dialog-body label {
                display: block;
                margin-bottom: 8px;
            }

            .nf-dialog-body select {
                width: 100%;
                padding: 8px;
                background: #1e1e1e;
                border: 1px solid #555;
                border-radius: 4px;
                color: #ddd;
                font-size: 13px;
            }

            .nf-dialog-body select:focus {
                outline: none;
                border-color: #4CAF50;
            }

            .nf-dialog-footer {
                padding: 12px 16px;
                border-top: 1px solid #444;
                display: flex;
                justify-content: flex-end;
                gap: 8px;
            }

            .nf-btn {
                padding: 6px 16px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                transition: all 0.2s;
            }

            .nf-btn-cancel {
                background: #444;
                color: #ddd;
            }

            .nf-btn-cancel:hover {
                background: #555;
            }

            .nf-btn-ok {
                background: #4CAF50;
                color: #fff;
            }

            .nf-btn-ok:hover {
                background: #45a049;
            }

            .nf-form-item {
                margin-bottom: 16px;
            }

            .nf-form-item label {
                display: block;
                margin-bottom: 6px;
                font-size: 12px;
                color: #aaa;
            }

            .nf-form-item input[type="text"] {
                width: 100%;
                padding: 8px;
                background: #1e1e1e;
                border: 1px solid transparent;
                border-radius: 4px;
                color: #ddd;
                font-size: 13px;
                box-sizing: border-box;
            }

            .nf-form-item input[type="text"]:focus {
                outline: none;
                border-color: transparent;
            }

            .nf-color-picker {
                display: flex;
                align-items: center;
                gap: 10px;
            }

            .nf-color-picker input[type="color"] {
                width: 40px;
                height: 32px;
                border: 1px solid #555;
                border-radius: 4px;
                background: #1e1e1e;
                cursor: pointer;
                padding: 2px;
            }

            .nf-color-picker input[type="color"]::-webkit-color-swatch-wrapper {
                padding: 0;
            }

            .nf-color-picker input[type="color"]::-webkit-color-swatch {
                border: none;
                border-radius: 2px;
            }

            .nf-color-hex {
                font-family: monospace;
                font-size: 13px;
                color: #aaa;
            }

            .nf-color-presets {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }

            .nf-preset-color {
                width: 24px;
                height: 24px;
                border-radius: 4px;
                cursor: pointer;
                border: 2px solid transparent;
                transition: all 0.2s;
            }

            .nf-preset-color:hover {
                transform: scale(1.2);
                border-color: #fff;
            }
        `;
    }

    createPanel() {
        if (document.getElementById("node-favorites-panel")) {
            this.panel = document.getElementById("node-favorites-panel");
            this.searchInput = this.panel.querySelector("#nf-search-input");
            this.favoritesList = this.panel.querySelector("#nf-favorites-list");
            this.categoryList = this.panel.querySelector("#nf-category-list");
            this.bindPanelEvents();
            this.renderCategories();
            this.renderFavorites();
            return;
        }

        const panel = document.createElement("div");
        panel.id = "node-favorites-panel";
        panel.className = "node-favorites-panel collapsed";
        const savedWidth = localStorage.getItem("xiaozhuguang.PanelWidth");
        if (savedWidth) panel.style.width = savedWidth + "px";
        panel.style.userSelect = "none";

        panel.innerHTML = `
            <div class="nf-header" title="拖拽标题栏可移动窗口">
                <span class="nf-title">⭐ 小珠光收藏 · 拖动标题栏改变位置</span>
                <div class="nf-header-btns">
                    <button class="nf-header-btn nf-shortcut-display" id="nf-shortcut-btn"></button>
                    <button class="nf-toggle-btn" id="nf-toggle-btn">−</button>
                </div>
            </div>
            <div class="nf-content" id="nf-content" style="display: none;">
                <div class="nf-search-box">
                    <input type="text" id="nf-search-input" placeholder="🔍 搜索收藏的节点..." />
                    <button class="nf-clear-btn" id="nf-clear-btn" title="清除搜索" style="display: none;">✕</button>
                </div>
                <div class="nf-split-container">
                    <div class="nf-left-col">
                        <div class="nf-categories-header">
                            <span>分类</span>
                            <button class="nf-add-cat-btn" id="nf-add-cat-btn" title="新建分类">+</button>
                        </div>
                        <div class="nf-category-list" id="nf-category-list"></div>
                    </div>
                    <div class="nf-split-handle" id="nf-split-handle"></div>
                    <div class="nf-right-col">
                        <div class="nf-favorites-header">
                            <div class="nf-fav-header-left">
                                <span>收藏节点</span>
                                <span class="nf-count" id="nf-count">0</span>
                                <button class="nf-clear-invalid-btn" id="nf-clear-invalid-btn" style="display:none;" title="清理所有失效节点">🧹 清理失效</button>
                            </div>
                            <div class="nf-sort-btns">
                                <button class="nf-sort-btn active" id="nf-sort-default" title="按使用频率排序">🔥</button>
                                <button class="nf-sort-btn" id="nf-sort-rating" title="按星标排序">★</button>
                            </div>
                        </div>
                        <div class="nf-favorites-list" id="nf-favorites-list">
                            <div class="nf-empty-tip">暂无收藏节点<br/>右键节点选择"收藏节点"</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const menu = document.querySelector(".comfy-menu");
        if (menu && menu.parentNode) {
            menu.parentNode.insertBefore(panel, menu.nextSibling);
        } else {
            const graphCanvas = document.querySelector(".litegraph");
            if (graphCanvas && graphCanvas.parentNode) {
                graphCanvas.parentNode.appendChild(panel);
            } else {
                document.body.appendChild(panel);
            }
        }

        this.panel = panel;
        this.searchInput = panel.querySelector("#nf-search-input");
        this.favoritesList = panel.querySelector("#nf-favorites-list");
        this.categoryList = panel.querySelector("#nf-category-list");

        this.bindPanelEvents();
        this.renderCategories();
        this.renderFavorites();
        this.loadPanelPosition();
    }

    bindPanelEvents() {
        if (!this.panel) return;

        this.setupDragging();
        this.setupSplitResizing();

        const toggleBtn = this.panel.querySelector("#nf-toggle-btn");

        if (toggleBtn) {
            toggleBtn.addEventListener("click", () => {
                this.collapsePanel();
            });
        }

        if (this.searchInput) {
            this.searchInput.addEventListener("input", (e) => {
                this.currentSearch = e.target.value.toLowerCase();
                this.renderFavorites();
                this.updateClearButtonVisibility();
            });
        }

        const clearBtn = this.panel.querySelector("#nf-clear-btn");
        if (clearBtn) {
            clearBtn.addEventListener("click", () => {
                this.searchInput.value = "";
                this.currentSearch = "";
                this.renderFavorites();
                this.updateClearButtonVisibility();
                this.searchInput.focus();
            });
        }

        const addCatBtn = this.panel.querySelector("#nf-add-cat-btn");
        if (addCatBtn) {
            addCatBtn.addEventListener("click", () => {
                this.showAddCategoryDialog();
            });
        }

        const shortcutBtn = this.panel.querySelector("#nf-shortcut-btn");
        if (shortcutBtn) {
            shortcutBtn.addEventListener("click", () => {
                this.showShortcutDialog();
            });
        }

        const sortDefaultBtn = this.panel.querySelector("#nf-sort-default");
        const sortRatingBtn = this.panel.querySelector("#nf-sort-rating");
        if (sortDefaultBtn) {
            sortDefaultBtn.addEventListener("click", () => {
                this.setSortMode("default");
            });
            sortDefaultBtn.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                const hasData = this.favorites.nodes.some(n => (n.useCount || 0) > 0);
                if (!hasData) return;
                if (confirm("确定清空所有收藏节点的使用频率记录吗？")) {
                    this.favorites.nodes.forEach(n => n.useCount = 0);
                    this.saveFavorites();
                    this.renderFavorites();
                }
            });
        }
        if (sortRatingBtn) {
            sortRatingBtn.addEventListener("click", () => {
                this.setSortMode("rating");
            });
        }

        // 清理失效节点按钮
        const clearInvalidBtn = this.panel.querySelector("#nf-clear-invalid-btn");
        if (clearInvalidBtn) {
            clearInvalidBtn.addEventListener("click", () => {
                const count = this.getInvalidFavorites().length;
                if (count === 0) return;
                if (confirm(`确定要清理 ${count} 个失效的收藏节点吗？\n（这些节点对应的插件可能已卸载）`)) {
                    const removed = this.removeInvalidFavorites();
                    alert(`已清理 ${removed} 个失效节点`);
                }
            });
        }

        this.updateShortcutDisplay();
        this.updateSortButtons();
    }

    setupDragging() {
        if (!this.panel) return;

        const header = this.panel.querySelector(".nf-header");
        if (!header) return;

        let isDragging = false;
        let startX, startY, startLeft, startTop;

        const startDrag = (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;

            const rect = this.panel.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;

            this.panel.style.transition = "none";
            this.panel.style.zIndex = "9999";
        };

        header.addEventListener("mousedown", (e) => {
            if (e.target.tagName === "BUTTON") return;
            startDrag(e);
        });

        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;

            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            let newLeft = startLeft + dx;
            let newTop = startTop + dy;

            const maxLeft = window.innerWidth - this.panel.offsetWidth;
            const maxTop = window.innerHeight - this.panel.offsetHeight;
            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));

            this.setPanelPosition(newLeft, newTop);
        });

        document.addEventListener("mouseup", () => {
            if (isDragging) {
                isDragging = false;
                this.panel.style.transition = "";
                this.panel.style.zIndex = "1000";
                this.savePanelPosition();
            }
        });
    }

    setupResizing() {
        if (this._resizingSetup) return;
        this._resizingSetup = true;
        const pan = this.panel;
        let isResizing = false;
        let startX, startWidth;
        let handle = document.body.querySelector(".xzg-panel-resizer");
        
        if (!handle) {
            handle = document.createElement("div");
            handle.className = "xzg-panel-resizer";
            handle.style.cssText = "position:fixed;width:8px;cursor:ew-resize;z-index:1001;border-radius:0 4px 4px 0;pointer-events:auto;";
            handle.addEventListener("mouseenter", () => handle.style.background = "rgba(76,175,80,0.3)");
            handle.addEventListener("mouseleave", () => handle.style.background = "transparent");
            document.body.appendChild(handle);
        }

        const updateHandlePos = () => {
            if (pan.classList.contains("collapsed")) {
                handle.style.display = "none";
                return;
            }
            const r = pan.getBoundingClientRect();
            handle.style.display = "block";
            handle.style.left = (r.right - 4) + "px";
            handle.style.top = r.top + "px";
            handle.style.height = r.height + "px";
        };
        updateHandlePos();
        const observer = new ResizeObserver(updateHandlePos);
        observer.observe(pan);

        handle.addEventListener("mousedown", (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = pan.offsetWidth;
            e.preventDefault();
        });

        const onMove = (e) => {
            if (!isResizing) return;
            const dx = e.clientX - startX;
            const newWidth = Math.max(260, Math.min(800, startWidth + dx));
            pan.style.width = newWidth + "px";
            updateHandlePos();
        };

        const onUp = () => {
            if (isResizing) {
                isResizing = false;
                localStorage.setItem("xiaozhuguang.PanelWidth", pan.offsetWidth);
            }
        };

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);

        this._resizeCleanup = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            observer.disconnect();
        };
    }

    setupSplitResizing() {
        const handle = this.panel.querySelector("#nf-split-handle");
        const leftCol = this.panel.querySelector(".nf-left-col");
        if (!handle || !leftCol) return;

        const saved = localStorage.getItem("xiaozhuguang.SplitWidth");
        if (saved) leftCol.style.width = saved + "px";

        let isSplitResizing = false;
        let startX, startWidth;

        handle.addEventListener("mousedown", (e) => {
            isSplitResizing = true;
            startX = e.clientX;
            startWidth = leftCol.offsetWidth;
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener("mousemove", (e) => {
            if (!isSplitResizing) return;
            const dx = e.clientX - startX;
            const newWidth = Math.max(80, Math.min(300, startWidth + dx));
            leftCol.style.width = newWidth + "px";
        });

        document.addEventListener("mouseup", () => {
            if (isSplitResizing) {
                isSplitResizing = false;
                localStorage.setItem("xiaozhuguang.SplitWidth", leftCol.offsetWidth);
            }
        });
    }

    setPanelPosition(left, top) {
        if (!this.panel) return;
        this.panel.style.setProperty('left', left + 'px', 'important');
        this.panel.style.setProperty('top', top + 'px', 'important');
        this.panel.style.setProperty('right', 'auto', 'important');
        this.panel.style.setProperty('bottom', 'auto', 'important');
    }

    savePanelPosition() {
        if (!this.panel) return;
        const rect = this.panel.getBoundingClientRect();
        localStorage.setItem("xiaozhuguang.PanelPos", JSON.stringify({
            left: rect.left,
            top: rect.top
        }));
    }

    loadPanelPosition() {
        try {
            const stored = localStorage.getItem("xiaozhuguang.PanelPos");
            if (stored) {
                const pos = JSON.parse(stored);
                this.setPanelPosition(pos.left, pos.top);
            }
        } catch (e) {}
    }

    updateShortcutDisplay() {
        const display = this.panel?.querySelector("#nf-shortcut-btn");
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
        dialog.className = "nf-dialog-overlay";
        dialog.innerHTML = `
            <div class="nf-dialog">
                <div class="nf-dialog-title">设置快捷键</div>
                <div class="nf-dialog-body">
                    <p style="margin-bottom: 16px; color: #888; font-size: 12px; text-align: center;">请按下你想要的快捷键</p>
                    <div style="text-align: center; margin-bottom: 16px;">
                        <div id="nf-listen-display" style="
                            padding: 16px 24px;
                            background: #4CAF50;
                            border: 2px solid #4CAF50;
                            border-radius: 6px;
                            color: #fff;
                            font-size: 16px;
                            font-weight: bold;
                            min-width: 180px;
                            display: inline-block;
                        ">请按快捷键...</div>
                    </div>
                    <p style="text-align: center; color: #666; font-size: 11px;">按 Esc 取消</p>
                </div>
                <div class="nf-dialog-footer">
                    <button class="nf-btn nf-btn-cancel" id="nf-dialog-close">关闭</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        const display = dialog.querySelector("#nf-listen-display");
        let isListening = true;

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

            this.saveShortcut(shortcut);
            this.updateShortcutDisplay();

            const parts = [];
            if (shortcut.ctrl) parts.push("Ctrl");
            if (shortcut.alt) parts.push("Alt");
            if (shortcut.shift) parts.push("Shift");
            parts.push(shortcut.key.toUpperCase());

            display.textContent = parts.join(" + ");
            display.style.background = "#2a2a2a";
            display.style.color = "#4CAF50";
            stopListening();
        };

        document.addEventListener("keydown", handleKeyDown, true);

        dialog.querySelector("#nf-dialog-close").addEventListener("click", () => {
            document.removeEventListener("keydown", handleKeyDown, true);
            dialog.remove();
        });

        dialog.addEventListener("click", (e) => {
            if (e.target === dialog) {
                document.removeEventListener("keydown", handleKeyDown, true);
                dialog.remove();
            }
        });
    }

    expandPanel() {
        if (!this.panel) return;

        const rect = this.panel.getBoundingClientRect();
        this._collapsedPos = { left: rect.left, top: rect.top };

        this.panel.classList.remove("collapsed");
        if (this._expandedWidth) {
            this.panel.style.width = this._expandedWidth;
        }
        const content = this.panel.querySelector("#nf-content");
        if (content) {
            content.style.display = "flex";
            content.style.flexDirection = "column";
        }

        if (this.searchInput) {
            this.searchInput.value = "";
        }
        this.currentSearch = "";
        this.currentCategory = "all";
        this.renderCategories();
        this.renderFavorites();
        this.updateClearButtonVisibility();

        const panelW = this.panel.offsetWidth || 450;
        const panelH = this.panel.offsetHeight || 400;

        let left, top;
        if (this._expandedPos) {
            left = this._expandedPos.left;
            top = this._expandedPos.top;
        } else {
            try {
                const saved = localStorage.getItem("xiaozhuguang.PanelPos");
                if (saved) {
                    const pos = JSON.parse(saved);
                    left = pos.left;
                    top = pos.top;
                } else {
                    left = rect.left;
                    top = rect.top;
                }
            } catch (e) {
                left = rect.left;
                top = rect.top;
            }
        }

        if (left + panelW > window.innerWidth - 10) left = window.innerWidth - panelW - 10;
        if (left < 10) left = 10;
        if (top + panelH > window.innerHeight - 10) top = window.innerHeight - panelH - 10;
        if (top < 10) top = 10;

        this.setPanelPosition(left, top);
    }

    collapsePanel() {
        if (!this.panel) return;
        const rect = this.panel.getBoundingClientRect();
        this._expandedPos = { left: rect.left, top: rect.top };
        this._expandedWidth = this.panel.style.width;
        this.panel.style.width = "";
        this.panel.classList.add("collapsed");
        const content = this.panel.querySelector("#nf-content");
        if (content) {
            content.style.display = "none";
        }
        if (this._collapsedPos) {
            this.setPanelPosition(this._collapsedPos.left, this._collapsedPos.top);
        }

        if (this._savedCollapsedPosition) {
            this.setPanelPosition(this._savedCollapsedPosition.left, this._savedCollapsedPosition.top);
            this.savePanelPosition();
            this._savedCollapsedPosition = null;
        }
    }

    extendNodeMenu() {
        if (this.nodeMenuExtended) return;
        this.nodeMenuExtended = true;

        const self = this;
        const origGetNodeMenuOptions = LGraphCanvas.prototype.getNodeMenuOptions;

        if (!origGetNodeMenuOptions) return;

        LGraphCanvas.prototype.getNodeMenuOptions = function(node) {
            const options = origGetNodeMenuOptions.apply(this, arguments);
            if (!options || !Array.isArray(options)) return options;

            // 多选时显示工作流收藏选项
            const selectedNodes = this.selected_nodes;
            const hasMultiple = selectedNodes && Object.keys(selectedNodes).length >= 2;

            if (hasMultiple) {
                const nodes = Object.values(selectedNodes);
                const wfId = self.getWorkflowIdByNodes(nodes);
                const count = nodes.length;
                const wfOption = {
                    content: wfId
                        ? `<span style="color:#FFD700;">⭐ 取消收藏多节点 (${count}个节点)</span>`
                        : `<span style="color:#FFD700;">🔗 收藏多节点 (${count}个节点)</span>`,
                    callback: () => {
                        if (wfId) {
                            self.removeFavoriteWorkflow(wfId);
                        } else {
                            self.saveSelectedAsWorkflow(nodes);
                        }
                    }
                };
                const sepIndex = options.findIndex(o => o === null);
                if (sepIndex >= 0) {
                    options.splice(sepIndex, 0, wfOption);
                } else {
                    options.push(null, wfOption);
                }
            } else {
                // 单节点收藏
                const isFavorited = self.isNodeFavorited(node.type);
                let favOption = {
                    content: isFavorited ? `<span style="color:#FFD700;">⭐ 取消收藏</span>` : `<span style="color:#FFD700;">☆ 收藏节点</span>`,
                    callback: () => {
                        if (isFavorited) {
                            self.removeFavorite(node.type);
                        } else {
                            self.showAddToCategoryDialog(node);
                        }
                    }
                };
                const sepIndex = options.findIndex(o => o === null);
                if (sepIndex >= 0) {
                    options.splice(sepIndex, 0, favOption);
                } else {
                    options.push(null, favOption);
                }
            }

            return options;
        };
    }

    extendCanvasMenu() {
        if (this.canvasMenuExtended) return;
        this.canvasMenuExtended = true;

        const self = this;
        const origGetCanvasMenuOptions = LGraphCanvas.prototype.getCanvasMenuOptions;

        if (!origGetCanvasMenuOptions) return;

        LGraphCanvas.prototype.getCanvasMenuOptions = function() {
            const options = origGetCanvasMenuOptions.apply(this, arguments);
            if (!options || !Array.isArray(options)) return options;

            const selectedNodes = this.selected_nodes;
            const hasMultiple = selectedNodes && Object.keys(selectedNodes).length >= 2;

            if (hasMultiple) {
                const nodes = Object.values(selectedNodes);
                const wfId = self.getWorkflowIdByNodes(nodes);
                const count = nodes.length;
                const wfOption = {
                    content: wfId
                        ? `<span style="color:#FFD700;">⭐ 取消收藏工作流 (${count}个节点)</span>`
                        : `<span style="color:#FFD700;">🔗 收藏工作流片段 (${count}个节点)</span>`,
                    callback: () => {
                        if (wfId) {
                            self.removeFavoriteWorkflow(wfId);
                        } else {
                            self.saveSelectedAsWorkflow(nodes);
                        }
                    }
                };
                const sepIndex = options.findIndex(o => o === null);
                if (sepIndex >= 0) {
                    options.splice(sepIndex, 0, wfOption);
                } else {
                    options.push(null, wfOption);
                }
            }

            const sc = self.getShortcut();
            const scParts = [];
            if (sc.ctrl) scParts.push("Ctrl");
            if (sc.alt) scParts.push("Alt");
            if (sc.shift) scParts.push("Shift");
            scParts.push(sc.key.toUpperCase());
            const xzgItem = {
                content: `<span style="color:#FFD700;">⭐ 小珠光收藏</span> <span style="color:#4CAF50;font-size:10px;">快捷键${scParts.join("+")}</span>`,
                callback: () => {
                    self.togglePanel();
                }
            };
            options.splice(0, 0, xzgItem);

            return options;
        };
    }

    extendGroupMenu() {
        // 不再需要单独的方法；功能已整合到 extendNodeMenu 和 extendCanvasMenu 中
    }

    togglePanel() {
        if (!this.panel) return;
        if (this.panel.classList.contains("collapsed")) {
            this.expandPanel();
        } else {
            this.collapsePanel();
        }
    }

    isNodeFavorited(nodeType) {
        return this.favorites.nodes.some(n => n.type === nodeType);
    }

    addFavorite(node, categoryId = "default") {
        if (this.isNodeFavorited(node.type)) {
            return;
        }

        const nodeDef = LiteGraph.registered_node_types[node.type];
        const displayName = node.title || nodeDef?.title || node.type;
        const category = nodeDef ? (nodeDef.category || "Unknown") : "Unknown";

        const maxOrder = this.favorites.nodes
            .filter(n => n.categoryId === categoryId)
            .reduce((max, n) => Math.max(max, n.order || 0), 0);

        this.favorites.nodes.push({
            type: node.type,
            displayName: displayName,
            category: category,
            categoryId: categoryId,
            addedAt: Date.now(),
            rating: 0,
            useCount: 0,
            lastUsed: 0,
            order: maxOrder + 1000
        });

        this.saveFavorites();
        this.renderFavorites();
        this.renderCategories();
    }

    removeFavorite(nodeType) {
        this.favorites.nodes = this.favorites.nodes.filter(n => n.type !== nodeType);
        this.saveFavorites();
        this.renderFavorites();
        this.renderCategories();
    }

    // ====== 工作流片段收藏 ======

    getWorkflowIdByNodes(selectedNodes) {
        if (!selectedNodes || selectedNodes.length < 2) return null;
        const typeIds = selectedNodes.map(n => n.type).sort().join(",");
        return this.favorites.workflows.find(w => w._typeSignature === typeIds)?.id || null;
    }

    saveSelectedAsWorkflow(selectedNodes) {
        const graph = app.graph;
        const nodeIds = new Set(selectedNodes.map(n => n.id));

        // 序列化节点数据
        const nodesData = selectedNodes.map(n => {
            const ser = {};
            ser.id = n.id;
            ser.type = n.type;
            ser.pos = [...n.pos];
            ser.size = [...n.size];
            ser.flags = { ...n.flags };
            ser.order = n.order;
            ser.mode = n.mode;
            ser.properties = { ...n.properties };
            ser.widgets_values = n.widgets_values ? [...n.widgets_values] : null;
            // 保存 inputs/outputs 结构用于恢复连线
            ser.inputs = n.inputs ? n.inputs.map(inp => ({ name: inp.name, type: inp.type })) : [];
            ser.outputs = n.outputs ? n.outputs.map(out => ({ name: out.name, type: out.type })) : [];
            return ser;
        });

        // 提取选中节点之间的连线
        const linksData = [];
        if (graph.links) {
            for (const link of graph.links) {
                if (!link) continue;
                if (nodeIds.has(link.origin_id) && nodeIds.has(link.target_id)) {
                    linksData.push({
                        origin_id: link.origin_id,
                        origin_slot: link.origin_slot,
                        target_id: link.target_id,
                        target_slot: link.target_slot,
                        type: link.type
                    });
                }
            }
        }

        // 计算中心偏移
        let minX = Infinity, minY = Infinity;
        for (const n of nodesData) {
            if (n.pos[0] < minX) minX = n.pos[0];
            if (n.pos[1] < minY) minY = n.pos[1];
        }

        // 生成名称
        const typeNames = selectedNodes.map(n => {
            const def = LiteGraph.registered_node_types[n.type];
            return def ? (def.title || n.type) : n.type;
        });
        const name = typeNames.slice(0, 3).join(" + ") + (typeNames.length > 3 ? `...` : ``);
        const typeSignature = selectedNodes.map(n => n.type).sort().join(",");

        const cats = this.favorites.categories;
        this.showWorkflowCategoryDialog({ nodesData, linksData, name, typeSignature, minX, minY });
    }

    showWorkflowCategoryDialog(data) {
        const cats = this.favorites.categories;
        let optionsHTML = "";
        for (const cat of cats) {
            optionsHTML += `<option value="${cat.id}">${cat.name}</option>`;
        }

        const dialog = document.createElement("div");
        dialog.className = "nf-dialog-overlay";
        dialog.innerHTML = `
            <div class="nf-dialog">
                <div class="nf-dialog-title">收藏工作流片段</div>
                <div class="nf-dialog-body">
                    <label>分类：</label>
                    <select id="nf-cat-select" style="margin-bottom:10px;">${optionsHTML}</select>
                    <label>名称：</label>
                    <input type="text" id="nf-wf-name" value="${data.name}" style="width:100%;padding:6px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#ddd;box-sizing:border-box;" />
                </div>
                <div class="nf-dialog-footer">
                    <button class="nf-btn nf-btn-cancel" id="nf-dlg-cancel">取消</button>
                    <button class="nf-btn nf-btn-ok" id="nf-dlg-ok">确定</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        dialog.querySelector("#nf-dlg-cancel").addEventListener("click", () => dialog.remove());
        dialog.querySelector("#nf-dlg-ok").addEventListener("click", () => {
            const name = dialog.querySelector("#nf-wf-name").value.trim() || data.name;
            const catId = dialog.querySelector("#nf-cat-select").value;
            const id = "wf_" + Date.now();

            this.favorites.workflows.push({
                id: id,
                name: name,
                categoryId: catId,
                nodesData: data.nodesData,
                linksData: data.linksData,
                _typeSignature: data.typeSignature,
                addedAt: Date.now(),
                useCount: 0,
                lastUsed: 0
            });

            this.saveFavorites();
            this.renderFavorites();
            this.renderCategories();
            dialog.remove();
        });

        dialog.addEventListener("mousedown", (e) => {
            if (e.target === dialog) dialog.remove();
        });

        // 回车提交
        dialog.querySelector("#nf-wf-name").addEventListener("keydown", (e) => {
            if (e.key === "Enter") dialog.querySelector("#nf-dlg-ok").click();
        });
    }

    removeFavoriteWorkflow(id) {
        this.favorites.workflows = this.favorites.workflows.filter(w => w.id !== id);
        this.saveFavorites();
        this.renderFavorites();
        this.renderCategories();
    }

    addWorkflowToCanvas(workflow) {
        try {
            const graph = app.graph;
            const canvas = app.canvas;
            if (!graph || !canvas) {
                console.error("[小珠光] 画布不可用");
                return;
            }

            console.log("[小珠光] 恢复工作流:", workflow.name, "节点数:", workflow.nodesData?.length);

            // 计算画布中心
            let cx = 0, cy = 0;
            try {
                const rect = canvas.canvas?.getBoundingClientRect?.();
                if (rect) {
                    cx = rect.width / 2;
                    cy = rect.height / 2;
                }
                const scale = canvas.ds?.scale || 1;
                const ox = canvas.ds?.offset?.[0] || 0;
                const oy = canvas.ds?.offset?.[1] || 0;
                cx = cx / scale - ox;
                cy = cy / scale - oy;
            } catch (e) {
                // 以画布上现有节点的中心为参照
                const gNodes = graph._nodes?.filter?.(n => n.type) || [];
                if (gNodes.length > 0) {
                    let sx = 0, sy = 0;
                    for (const n of gNodes) { sx += n.pos[0]; sy += n.pos[1]; }
                    cx = sx / gNodes.length + 100;
                    cy = sy / gNodes.length + 100;
                } else {
                    cx = 200;
                    cy = 200;
                }
            }

            // 计算工作流的中心
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const nd of workflow.nodesData) {
                const px = nd.pos?.[0] || 0;
                const py = nd.pos?.[1] || 0;
                const w = nd.size?.[0] || 200;
                const h = nd.size?.[1] || 100;
                if (px < minX) minX = px;
                if (py < minY) minY = py;
                if (px + w > maxX) maxX = px + w;
                if (py + h > maxY) maxY = py + h;
            }
            const originCx = (minX + maxX) / 2;
            const originCy = (minY + maxY) / 2;

            // 创建节点
            const idMap = {};
            for (const nd of workflow.nodesData) {
                const node = LiteGraph.createNode(nd.type);
                if (!node) {
                    console.warn("[小珠光] 无法创建节点类型:", nd.type);
                    continue;
                }

                // 分配新ID
                let newId;
                if (graph.getNextNodeId) {
                    newId = graph.getNextNodeId();
                } else {
                    newId = graph._nodeIdCounter || 1;
                    graph._nodeIdCounter = newId + 1;
                }
                idMap[nd.id] = newId;
                node.id = newId;

                // 设置位置（相对偏移）
                node.pos = [cx + (nd.pos[0] - originCx), cy + (nd.pos[1] - originCy)];

                // 恢复节点状态
                if (nd.size) node.size = [...nd.size];
                if (nd.flags) Object.assign(node.flags, nd.flags);
                if (nd.mode !== undefined) node.mode = nd.mode;
                if (nd.properties) node.properties = JSON.parse(JSON.stringify(nd.properties));
                if (nd.widgets_values) node.widgets_values = JSON.parse(JSON.stringify(nd.widgets_values));

                // 添加到画布
                graph.add(node);
                if (typeof node.onAdded === 'function') node.onAdded();

                // 恢复 widget 值
                if (node.widgets && node.widgets_values) {
                    for (let i = 0; i < node.widgets.length && i < node.widgets_values.length; i++) {
                        if (node.widgets[i]) {
                            node.widgets[i].value = node.widgets_values[i];
                        }
                    }
                }
            }

            // 恢复连线
            let linkCount = 0;
            for (const ld of workflow.linksData) {
                const srcId = idMap[ld.origin_id];
                const tgtId = idMap[ld.target_id];
                if (srcId == null || tgtId == null) continue;

                try {
                    const result = graph.connect(srcId, ld.origin_slot, tgtId, ld.target_slot, ld.type);
                    if (result != null && result !== -1) linkCount++;
                } catch (e) {
                    console.warn("[小珠光] 连线恢复失败:", e);
                }
            }

            canvas.setDirty(true, true);
            canvas.draw(true, true);
            if (typeof app.graph.change === 'function') app.graph.change();

            // 记录使用
            const w = this.favorites.workflows.find(x => x.id === workflow.id);
            if (w) {
                w.useCount = (w.useCount || 0) + 1;
                w.lastUsed = Date.now();
                this.saveFavorites();
                this.renderFavorites();
            }

            console.log(`[小珠光] 工作流恢复完成: ${workflow.name} (${Object.keys(idMap).length}节点, ${linkCount}连线)`);
        } catch (e) {
            console.error("[小珠光] 恢复工作流失败:", e);
            console.error(e.stack);
        }
    }

    showWorkflowContextMenu(x, y, wfId, wfName) {
        document.querySelectorAll(".nf-cat-context-menu").forEach(el => el.remove());

        const wf = this.favorites.workflows.find(w => w.id === wfId);
        const useCount = wf?.useCount || 0;

        const menu = document.createElement("div");
        menu.className = "nf-cat-context-menu";
        menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:99999;background:#2a2a2a;border:1px solid #555;border-radius:6px;padding:4px 0;min-width:130px;box-shadow:0 4px 12px rgba(0,0,0,0.5);`;
        menu.innerHTML = `
            <div class="nf-cat-menu-item" data-action="move" style="padding:8px 16px;cursor:pointer;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;transition:background:0.15s;">
                <span style="color:#FF9800;">📁</span> 修改分类
            </div>
            <div class="nf-cat-menu-item" data-action="rename" style="padding:8px 16px;cursor:pointer;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;transition:background:0.15s;">
                <span style="color:#2196F3;">✏️</span> 重命名
            </div>
            <div class="nf-cat-menu-item" data-action="clear" style="padding:8px 16px;cursor:pointer;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;transition:background:0.15s;">
                <span style="color:#FF5722;">🗑</span> 清空使用频率${useCount > 0 ? ` (${useCount}次)` : ''}
            </div>
            <div style="border-top:1px solid #444;margin:4px 0;"></div>
            <div class="nf-cat-menu-item" data-action="delete" style="padding:8px 16px;cursor:pointer;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;transition:background:0.15s;">
                <span style="color:#f44336;">×</span> 删除工作流
            </div>
        `;

        menu.querySelectorAll(".nf-cat-menu-item").forEach(el => {
            el.addEventListener("mouseenter", () => el.style.background = "#3a3a3a");
            el.addEventListener("mouseleave", () => el.style.background = "");
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                menu.remove();
                if (el.dataset.action === "rename") {
                    this.showRenameWorkflowDialog(wfId);
                } else if (el.dataset.action === "move") {
                    this.showMoveWorkflowCategoryDialog(wfId);
                } else if (el.dataset.action === "clear") {
                    if (useCount > 0 && confirm(`确定清空工作流"${wfName}"的使用频率记录吗？`)) {
                        if (wf) { wf.useCount = 0; this.saveFavorites(); this.renderFavorites(); }
                    }
                } else if (el.dataset.action === "delete") {
                    if (confirm(`确定要删除工作流"${wfName}"吗？`)) {
                        this.removeFavoriteWorkflow(wfId);
                    }
                }
            });
        });

        document.body.appendChild(menu);

        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener("click", closeMenu);
                document.removeEventListener("contextmenu", closeMenu);
            }
        };
        requestAnimationFrame(() => {
            document.addEventListener("click", closeMenu);
            document.addEventListener("contextmenu", closeMenu);
        });
    }

    showMoveWorkflowCategoryDialog(wfId) {
        const wf = this.favorites.workflows.find(w => w.id === wfId);
        if (!wf) return;
        const wfName = wf.name || "工作流";

        const cats = this.favorites.categories;
        let optionsHTML = "";
        for (const cat of cats) {
            const selected = cat.id === wf.categoryId ? "selected" : "";
            optionsHTML += `<option value="${cat.id}" ${selected}>${cat.name}</option>`;
        }

        const dialog = document.createElement("div");
        dialog.className = "nf-dialog-overlay";
        dialog.innerHTML = `
            <div class="nf-dialog">
                <div class="nf-dialog-title">移动"${wfName}"到分类</div>
                <div class="nf-dialog-body">
                    <label>选择分类：</label>
                    <select id="nf-cat-select">${optionsHTML}</select>
                </div>
                <div class="nf-dialog-footer">
                    <button class="nf-btn nf-btn-cancel" id="nf-dlg-cancel">取消</button>
                    <button class="nf-btn nf-btn-ok" id="nf-dlg-ok">确定</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);
        dialog.querySelector("#nf-dlg-cancel").addEventListener("click", () => dialog.remove());
        dialog.querySelector("#nf-dlg-ok").addEventListener("click", () => {
            const catId = dialog.querySelector("#nf-cat-select").value;
            wf.categoryId = catId;
            this.saveFavorites();
            this.renderFavorites();
            this.renderCategories();
            dialog.remove();
        });
        dialog.addEventListener("mousedown", (e) => { if (e.target === dialog) dialog.remove(); });
    }

    showRenameWorkflowDialog(wfId) {
        const wf = this.favorites.workflows.find(w => w.id === wfId);
        if (!wf) return;
        const oldName = wf.name || "工作流";

        const dialog = document.createElement("div");
        dialog.className = "nf-dialog-overlay";
        dialog.innerHTML = `
            <div class="nf-dialog">
                <div class="nf-dialog-title">重命名工作流</div>
                <div class="nf-dialog-body">
                    <label>新名称：</label>
                    <input type="text" id="nf-wf-rename-input" value="${oldName.replace(/"/g, '&quot;')}" style="width:100%;padding:6px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#ddd;margin-bottom:10px;box-sizing:border-box;" />
                </div>
                <div class="nf-dialog-footer">
                    <button class="nf-btn nf-btn-cancel" id="nf-dlg-cancel">取消</button>
                    <button class="nf-btn nf-btn-ok" id="nf-dlg-ok">确定</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);

        const input = dialog.querySelector("#nf-wf-rename-input");
        input.focus();
        input.select();

        dialog.querySelector("#nf-dlg-cancel").addEventListener("click", () => dialog.remove());
        dialog.querySelector("#nf-dlg-ok").addEventListener("click", () => {
            const newName = input.value.trim();
            if (!newName) { dialog.remove(); return; }
            wf.name = newName;
            this.saveFavorites();
            this.renderFavorites();
            this.renderCategories();
            dialog.remove();
        });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") dialog.querySelector("#nf-dlg-ok").click();
            if (e.key === "Escape") dialog.remove();
        });
        dialog.addEventListener("mousedown", (e) => { if (e.target === dialog) dialog.remove(); });
    }

    moveNodeToCategory(nodeType, targetCatId) {
        const node = this.favorites.nodes.find(n => n.type === nodeType);
        if (!node) return;
        if (node.categoryId === targetCatId) return;
        node.categoryId = targetCatId;
        this.saveFavorites();
        this.renderFavorites();
        this.renderCategories();
    }

    showRenameNodeDialog(nodeType) {
        const node = this.favorites.nodes.find(n => n.type === nodeType);
        if (!node) return;
        const oldName = node.displayName || node.type;

        const dialog = document.createElement("div");
        dialog.className = "nf-dialog-overlay";
        dialog.innerHTML = `
            <div class="nf-dialog">
                <div class="nf-dialog-title">重命名</div>
                <div class="nf-dialog-body">
                    <label>显示名称：</label>
                    <input type="text" id="nf-node-rename-input" value="${oldName.replace(/"/g, '&quot;')}" style="width:100%;padding:6px;background:#2a2a2a;border:1px solid #555;border-radius:4px;color:#ddd;margin-bottom:10px;box-sizing:border-box;" />
                </div>
                <div class="nf-dialog-footer">
                    <button class="nf-btn nf-btn-cancel" id="nf-dlg-cancel">取消</button>
                    <button class="nf-btn nf-btn-ok" id="nf-dlg-ok">确定</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);

        const input = dialog.querySelector("#nf-node-rename-input");
        input.focus();
        input.select();

        dialog.querySelector("#nf-dlg-cancel").addEventListener("click", () => dialog.remove());
        dialog.querySelector("#nf-dlg-ok").addEventListener("click", () => {
            const newName = input.value.trim();
            if (!newName) { dialog.remove(); return; }
            node.displayName = newName;
            this.saveFavorites();
            this.renderFavorites();
            dialog.remove();
        });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") dialog.querySelector("#nf-dlg-ok").click();
            if (e.key === "Escape") dialog.remove();
        });
        dialog.addEventListener("mousedown", (e) => { if (e.target === dialog) dialog.remove(); });
    }

    // ====== 拼音搜索支持 ======

    /* ── 拼音首字母（如"补帧" → "bz"） ── */
    toPinyinInitials(text) {
        if (!text || typeof text !== 'string') return '';
        try {
            return window.pinyinPro.pinyin(text, { pattern: 'first', toneType: 'none', type: 'string' }).replace(/\s/g, '');
        } catch(e) { return ''; }
    }

    /* ── 完整拼音（如"补帧" → "buzhen"） ── */
    toPinyinFull(text) {
        if (!text || typeof text !== 'string') return '';
        try {
            return window.pinyinPro.pinyin(text, { toneType: 'none', type: 'string' }).replace(/\s/g, '');
        } catch(e) { return ''; }
    }

    fuzzyMatch(text, query) {
        if (!query) return true;
        text = text.toLowerCase();
        query = query.toLowerCase();

        if (text.includes(query)) return true;

        let ti = 0;
        let qi = 0;
        while (ti < text.length && qi < query.length) {
            if (text[ti] === query[qi]) {
                qi++;
            }
            ti++;
        }
        return qi === query.length;
    }

    getFilteredFavorites() {
        let nodes = this.favorites.nodes;

        if (this.currentCategory !== "all") {
            nodes = nodes.filter(n => n.categoryId === this.currentCategory);
        }

        if (this.currentSearch) {
            nodes = nodes.filter(n =>
                this.fuzzyMatch(n.displayName, this.currentSearch) ||
                this.fuzzyMatch(n.type, this.currentSearch) ||
                this.fuzzyMatch(n.category, this.currentSearch) ||
                this.fuzzyMatch(this.toPinyinInitials(n.displayName), this.currentSearch) ||
                this.fuzzyMatch(this.toPinyinFull(n.displayName), this.currentSearch)
            );
        }

        const sortMode = this.favorites.sortMode || "default";
        if (sortMode === "rating") {
            return nodes.sort((a, b) => {
                if (b.rating !== a.rating) return b.rating - a.rating;
                if ((b.useCount || 0) !== (a.useCount || 0)) return (b.useCount || 0) - (a.useCount || 0);
                return (b.lastUsed || 0) - (a.lastUsed || 0);
            });
        } else {
            return nodes.sort((a, b) => {
                if ((b.useCount || 0) !== (a.useCount || 0)) return (b.useCount || 0) - (a.useCount || 0);
                return (b.lastUsed || 0) - (a.lastUsed || 0);
            });
        }
    }

    getFilteredWorkflows() {
        let workflows = this.favorites.workflows || [];
        if (this.currentCategory !== "all") {
            workflows = workflows.filter(w => w.categoryId === this.currentCategory);
        }
        if (this.currentSearch) {
            workflows = workflows.filter(w =>
                this.fuzzyMatch(w.name, this.currentSearch) ||
                this.fuzzyMatch(this.toPinyinInitials(w.name), this.currentSearch) ||
                this.fuzzyMatch(this.toPinyinFull(w.name), this.currentSearch)
            );
        }
        return workflows.sort((a, b) => {
            if ((b.useCount || 0) !== (a.useCount || 0)) return (b.useCount || 0) - (a.useCount || 0);
            return (b.lastUsed || 0) - (a.lastUsed || 0);
        });
    }

    getCategoryById(id) {
        return this.favorites.categories.find(c => c.id === id);
    }

    setNodeRating(nodeType, rating) {
        const node = this.favorites.nodes.find(n => n.type === nodeType);
        if (node) {
            node.rating = rating;
            this.saveFavorites();
            this.renderFavorites();
        }
    }

    setSortMode(mode) {
        this.favorites.sortMode = mode;
        this.saveFavorites();
        this.renderFavorites();
        this.updateSortButtons();
    }

    updateSortButtons() {
        const defaultBtn = this.panel?.querySelector("#nf-sort-default");
        const ratingBtn = this.panel?.querySelector("#nf-sort-rating");
        if (!defaultBtn || !ratingBtn) return;

        const mode = this.favorites.sortMode || "default";
        defaultBtn.classList.toggle("active", mode === "default");
        ratingBtn.classList.toggle("active", mode === "rating");
    }

    updateClearButtonVisibility() {
        const clearBtn = this.panel?.querySelector("#nf-clear-btn");
        if (clearBtn) {
            clearBtn.style.display = this.searchInput && this.searchInput.value.length > 0 ? "flex" : "none";
        }
    }

    renderCategories() {
        if (!this.categoryList) return;

        const cats = [...this.favorites.categories].sort((a, b) => (a.order || 0) - (b.order || 0));
        const allInvalid = this.getInvalidFavorites().length;
        let html = `
            <div class="nf-category-item ${this.currentCategory === 'all' ? 'active' : ''}" data-cat="all">
                <span class="nf-cat-color" style="background: #888;"></span>
                <span class="nf-cat-name">全部</span>
                ${allInvalid > 0 ? `<span class="nf-cat-invalid-count" title="${allInvalid}个失效节点">${allInvalid}</span>` : ''}
            </div>
        `;

        for (const cat of cats) {
            const catNodes = this.favorites.nodes.filter(n => n.categoryId === cat.id);
            const invalidInCat = catNodes.filter(n => !this.isNodeTypeValid(n.type)).length;
            html += `
                <div class="nf-category-item ${this.currentCategory === cat.id ? 'active' : ''}" data-cat="${cat.id}">
                    <span class="nf-cat-color" style="background: ${cat.color};"></span>
                    <span class="nf-cat-name" title="${cat.name}">${cat.name}</span>
                    ${invalidInCat > 0 ? `<span class="nf-cat-invalid-count" title="${invalidInCat}个失效节点">${invalidInCat}</span>` : ''}
                </div>
            `;
        }

        this.categoryList.innerHTML = html;

        this.categoryList.querySelectorAll(".nf-category-item").forEach(item => {
            item.addEventListener("click", (e) => {
                this.currentCategory = item.dataset.cat;
                this.renderCategories();
                this.renderFavorites();
            });
            item.addEventListener("dragover", (e) => {
                e.preventDefault();
                item.style.background = "rgba(76,175,80,0.3)";
                item.style.borderColor = "#4CAF50";
            });
            item.addEventListener("dragleave", () => {
                item.style.background = "";
                item.style.borderColor = "";
            });
            item.addEventListener("drop", (e) => {
                e.preventDefault();
                item.style.background = "";
                item.style.borderColor = "";
                const nodeType = e.dataTransfer.getData("text/xzg-node-type");
                if (!nodeType) return;
                const targetCat = item.dataset.cat === "all" ? "default" : item.dataset.cat;
                this.moveNodeToCategory(nodeType, targetCat);
            });
            item.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const catId = item.dataset.cat;
                if (catId === "all") return;
                this.showCategoryContextMenu(e.clientX, e.clientY, catId);
            });
        });
    }

    showCategoryContextMenu(x, y, catId) {
        // 移除已有菜单
        document.querySelectorAll(".nf-cat-context-menu").forEach(el => el.remove());

        const menu = document.createElement("div");
        menu.className = "nf-cat-context-menu";
        menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:99999;background:#2a2a2a;border:1px solid #555;border-radius:6px;padding:4px 0;min-width:120px;box-shadow:0 4px 12px rgba(0,0,0,0.5);`;
        const cats = this.favorites.categories;
        const catIdx = cats.findIndex(c => c.id === catId);
        const canUp = catIdx > 0;
        const canDown = catIdx >= 0 && catIdx < cats.length - 1;

        menu.innerHTML = `
            <div class="nf-cat-menu-item" data-action="up" style="padding:8px 16px;cursor:pointer;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;transition:background:0.15s;${canUp ? '' : 'opacity:0.4;pointer-events:none;'}">
                <span style="color:#2196F3;">▲</span> 上移
            </div>
            <div class="nf-cat-menu-item" data-action="down" style="padding:8px 16px;cursor:pointer;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;transition:background:0.15s;${canDown ? '' : 'opacity:0.4;pointer-events:none;'}">
                <span style="color:#2196F3;">▼</span> 下移
            </div>
            <div style="border-top:1px solid #444;margin:4px 0;"></div>
            <div class="nf-cat-menu-item" data-action="edit" style="padding:8px 16px;cursor:pointer;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;transition:background:0.15s;">
                <span style="color:#FF9800;">✎</span> 编辑分类
            </div>
            <div class="nf-cat-menu-item" data-action="delete" style="padding:8px 16px;cursor:pointer;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;transition:background:0.15s;">
                <span style="color:#f44336;">×</span> 删除分类
            </div>
        `;

        // 悬停效果
        menu.querySelectorAll(".nf-cat-menu-item").forEach(el => {
            el.addEventListener("mouseenter", () => el.style.background = "#3a3a3a");
            el.addEventListener("mouseleave", () => el.style.background = "");
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                menu.remove();
                if (el.dataset.action === "up") {
                    this.moveCategory(catId, -1);
                } else if (el.dataset.action === "down") {
                    this.moveCategory(catId, 1);
                } else if (el.dataset.action === "edit") {
                    this.showEditCategoryDialog(catId);
                } else if (el.dataset.action === "delete") {
                    if (confirm("确定删除该分类吗？")) {
                        this.deleteCategory(catId);
                    }
                }
            });
        });

        document.body.appendChild(menu);

        // 点击菜单外关闭
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener("click", closeMenu);
                document.removeEventListener("contextmenu", closeMenu);
            }
        };
        requestAnimationFrame(() => {
            document.addEventListener("click", closeMenu);
            document.addEventListener("contextmenu", closeMenu);
        });
    }

    showNodeContextMenu(x, y, nodeType, nodeName) {
        document.querySelectorAll(".nf-cat-context-menu").forEach(el => el.remove());

        const menu = document.createElement("div");
        menu.className = "nf-cat-context-menu";
        menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:99999;background:#2a2a2a;border:1px solid #555;border-radius:6px;padding:4px 0;min-width:130px;box-shadow:0 4px 12px rgba(0,0,0,0.5);`;
        const nodeData = this.favorites.nodes.find(n => n.type === nodeType);
        const useCount = nodeData?.useCount || 0;

        menu.innerHTML = `
            <div class="nf-cat-menu-item" data-action="move" style="padding:8px 16px;cursor:pointer;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;transition:background:0.15s;">
                <span style="color:#FF9800;">📁</span> 修改分类
            </div>
            <div class="nf-cat-menu-item" data-action="rename" style="padding:8px 16px;cursor:pointer;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;transition:background:0.15s;">
                <span style="color:#2196F3;">✏️</span> 重命名
            </div>
            <div class="nf-cat-menu-item" data-action="clear" style="padding:8px 16px;cursor:pointer;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;transition:background:0.15s;">
                <span style="color:#FF5722;">🗑</span> 清空使用频率${useCount > 0 ? ` (${useCount}次)` : ''}
            </div>
            <div style="border-top:1px solid #444;margin:4px 0;"></div>
            <div class="nf-cat-menu-item" data-action="delete" style="padding:8px 16px;cursor:pointer;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;transition:background:0.15s;">
                <span style="color:#f44336;">×</span> 取消收藏
            </div>
        `;

        menu.querySelectorAll(".nf-cat-menu-item").forEach(el => {
            el.addEventListener("mouseenter", () => el.style.background = "#3a3a3a");
            el.addEventListener("mouseleave", () => el.style.background = "");
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                menu.remove();
                if (el.dataset.action === "rename") {
                    this.showRenameNodeDialog(nodeType);
                } else if (el.dataset.action === "move") {
                    this.showMoveNodeCategoryDialog(nodeType);
                } else if (el.dataset.action === "clear") {
                    if (useCount > 0 && confirm(`确定清空"${nodeName}"的使用频率记录吗？`)) {
                        const n = this.favorites.nodes.find(x => x.type === nodeType);
                        if (n) {
                            n.useCount = 0;
                            this.saveFavorites();
                            this.renderFavorites();
                        }
                    }
                } else if (el.dataset.action === "delete") {
                    if (confirm(`确定要取消收藏"${nodeName}"吗？`)) {
                        this.removeFavorite(nodeType);
                    }
                }
            });
        });

        document.body.appendChild(menu);

        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener("click", closeMenu);
                document.removeEventListener("contextmenu", closeMenu);
            }
        };
        requestAnimationFrame(() => {
            document.addEventListener("click", closeMenu);
            document.addEventListener("contextmenu", closeMenu);
        });
    }

    renderFavorites() {
        if (!this.favoritesList) return;

        const nodes = this.getFilteredFavorites();
        const countEl = this.panel?.querySelector("#nf-count");
        if (countEl) {
            countEl.textContent = nodes.length;
        }

        // 失效节点清理按钮
        const invalidCount = this.getInvalidFavorites().length;
        const clearInvalidBtn = this.panel?.querySelector("#nf-clear-invalid-btn");
        if (clearInvalidBtn) {
            if (invalidCount > 0) {
                clearInvalidBtn.style.display = "inline-flex";
                clearInvalidBtn.textContent = `🧹 清理失效(${invalidCount})`;
            } else {
                clearInvalidBtn.style.display = "none";
            }
        }

        // 过滤工作流
        const workflows = this.getFilteredWorkflows();
        const totalCount = nodes.length + workflows.length;

        if (totalCount === 0) {
            this.favoritesList.innerHTML = `<div class="nf-empty-tip">暂无匹配的收藏节点</div>`;
            return;
        }

        let html = "";
        let listInvalidCount = 0;
        // 渲染普通收藏节点
        for (const node of nodes) {
            const cat = this.getCategoryById(node.categoryId);
            const catColor = cat ? cat.color : "#888";
            const catName = cat ? cat.name : "未知";
            const rating = node.rating || 0;
            const isValid = this.isNodeTypeValid(node.type);
            if (!isValid) listInvalidCount++;

            let starsHtml = "";
            for (let i = 1; i <= 5; i++) {
                starsHtml += `<span class="nf-star ${i <= rating ? 'filled' : ''}" data-star="${i}">★</span>`;
            }

            const useCount = node.useCount || 0;
            const itemClass = `nf-fav-item${isValid ? '' : ' nf-invalid'}`;
            const titleText = isValid
                ? ""
                : "节点已失效（插件可能已卸载）· 右键可删除";
            const nameText = isValid
                ? node.displayName
                : `${node.displayName} <span style="color:#ff6b6b;font-size:11px;">[已失效]</span>`;
            const typeText = isValid
                ? `${node.category}${useCount > 0 ? ` · 使用${useCount}次` : ''}`
                : `${node.type}`;
            const dragAttr = isValid ? 'draggable="true"' : 'draggable="false"';

            html += `
                <div class="${itemClass}" data-type="${node.type}" data-order="${node.order || 0}" data-kind="node" ${dragAttr} title="${titleText}">
                    <div class="nf-fav-color" style="background: ${isValid ? catColor : '#555'};"></div>
                    <div class="nf-fav-info">
                        <div class="nf-fav-name">${nameText}</div>
                        <div class="nf-fav-type">${typeText}</div>
                    </div>
                    <div class="nf-fav-rating" data-type="${node.type}">
                        ${isValid ? starsHtml : ''}
                    </div>
                    ${isValid ? '' : `<button class="nf-del-invalid-btn" data-type="${node.type}" title="移除此失效收藏">✕</button>`}
                </div>
            `;
        }

        // 渲染工作流片段
        if (workflows.length > 0) {
            html += `<div style="font-size:11px;color:#aaa;padding:8px 4px 4px;border-top:1px solid #3a3a3a;margin-top:4px;">🔗 工作流片段</div>`;
            for (const wf of workflows) {
                const cat = this.getCategoryById(wf.categoryId);
                const catColor = cat ? cat.color : "#888";
                const useCount = wf.useCount || 0;
                html += `
                    <div class="nf-fav-item nf-wf-item" data-wf-id="${wf.id}" data-kind="workflow" draggable="false">
                        <div class="nf-fav-color" style="background: ${catColor};"></div>
                        <div class="nf-fav-info">
                            <div class="nf-fav-name">🔗 ${wf.name}</div>
                            <div class="nf-fav-type">${wf.nodesData ? wf.nodesData.length + '个节点' : ''}${useCount > 0 ? ` · 使用${useCount}次` : ''}</div>
                        </div>
                    </div>
                `;
            }
        }

        this.favoritesList.innerHTML = html;

        const self = this;
        this.favoritesList.querySelectorAll(".nf-fav-item").forEach(item => {
            item.addEventListener("dragstart", (e) => {
                e.dataTransfer.setData("text/xzg-node-type", item.dataset.type);
                e.dataTransfer.effectAllowed = "move";
                item.style.opacity = "0.5";
            });
            item.addEventListener("dragend", () => {
                item.style.opacity = "";
            });

            let startX, startY;
            let isDrag = false;
            let dragInfo = null;
            let isReorderDrag = false;

            const onMouseMove = (e) => {
                if (e.buttons !== 1 || !dragInfo || isDrag) return;
                const dx = Math.abs(e.clientX - startX);
                const dy = Math.abs(e.clientY - startY);
                if (dx > 3 || dy > 3) {
                    isDrag = true;
                    if (isReorderDrag) {
                        self.startReorderDrag(item, e.clientY);
                    } else {
                        self.draggingNodeType = dragInfo.type;
                        self.updateDragPreview(e.clientX, e.clientY, dragInfo.name);
                    }
                }
            };

            const onMouseUp = (e) => {
                if (isReorderDrag) {
                    self.endReorderDrag();
                } else if (self.draggingNodeType) {
                    self.draggingNodeType = null;
                    self.removeDragPreview();
                } else if (!isDrag && dragInfo) {
                    self.addNodeToCanvas(dragInfo.type);
                }

                dragInfo = null;
                isDrag = false;
                isReorderDrag = false;
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
            };

            item.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return; // 仅左键
                if (e.target.closest(".nf-fav-rating")) return;
                if (item.dataset.kind === "workflow") return; // 工作流由独立点击处理

                startX = e.clientX;
                startY = e.clientY;
                isDrag = false;
                dragInfo = {
                    type: item.dataset.type,
                    name: item.querySelector(".nf-fav-name")?.textContent || item.dataset.type,
                    color: item.dataset.categoryColor || "#f44336"
                };
                e.preventDefault();
                document.addEventListener("mousemove", onMouseMove);
                document.addEventListener("mouseup", onMouseUp);
            });
        });

        this.favoritesList.querySelectorAll(".nf-fav-rating").forEach(ratingEl => {
            const nodeType = ratingEl.dataset.type;
            ratingEl.querySelectorAll(".nf-star").forEach(star => {
                star.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const starNum = parseInt(star.dataset.star);
                    const currentRating = ratingEl.querySelectorAll(".nf-star.filled").length;
                    const newRating = currentRating === starNum ? 0 : starNum;
                    self.setNodeRating(nodeType, newRating);
                });
                star.addEventListener("mousedown", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                });
            });
        });

        this.favoritesList.querySelectorAll(".nf-fav-item").forEach(item => {
            item.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (item.dataset.kind === "workflow") {
                    const wfId = item.dataset.wfId;
                    const wfName = item.querySelector(".nf-fav-name")?.textContent || "工作流";
                    this.showWorkflowContextMenu(e.clientX, e.clientY, wfId, wfName);
                } else {
                    const nodeType = item.dataset.type;
                    const nodeName = item.querySelector(".nf-fav-name")?.textContent || nodeType;
                    this.showNodeContextMenu(e.clientX, e.clientY, nodeType, nodeName);
                }
            });
        });

        // 工作流片段点击添加到画布
        this.favoritesList.querySelectorAll(".nf-wf-item").forEach(item => {
            item.addEventListener("click", (e) => {
                if (e.button !== 0) return;
                const wfId = item.dataset.wfId;
                const wf = this.favorites.workflows.find(w => w.id === wfId);
                if (wf) {
                    console.log("[小珠光] 恢复工作流:", wf.name);
                    this.addWorkflowToCanvas(wf);
                }
            });
        });

        // 失效节点删除按钮
        this.favoritesList.querySelectorAll(".nf-del-invalid-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const nodeType = btn.dataset.type;
                if (confirm("确定要移除这个失效的收藏节点吗？")) {
                    self.removeFavorite(nodeType);
                }
            });
            btn.addEventListener("mousedown", (e) => {
                e.stopPropagation();
                e.preventDefault();
            });
        });
    }

    moveFavorite(nodeType, offset) {
        const nodes = this.getFilteredFavorites();
        const idx = nodes.findIndex(n => n.type === nodeType);
        if (idx < 0) return;
        const newIdx = idx + offset;
        if (newIdx < 0 || newIdx >= nodes.length) return;
        const moved = nodes.splice(idx, 1)[0];
        nodes.splice(newIdx, 0, moved);
        nodes.forEach((n, i) => n.order = i);
        this.saveFavorites();
        this.renderFavorites();
    }

    startReorderDrag(item, clientY) {
        this._reorderData = {
            item: item,
            nodeType: item.dataset.type,
            startY: clientY,
            originalIndex: Array.from(this.favoritesList.children).indexOf(item)
        };
        item.classList.add("nf-reorder-dragging");
        document.addEventListener("mousemove", this._onReorderMove = (e) => this.onReorderMove(e));
        document.addEventListener("mouseup", this._onReorderEnd = (e) => this.endReorderDrag());
    }

    onReorderMove(e) {
        if (!this._reorderData || !this.favoritesList) return;

        const items = Array.from(this.favoritesList.querySelectorAll(".nf-fav-item:not(.nf-reorder-dragging)"));
        const draggingItem = this._reorderData.item;
        const mouseY = e.clientY;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const rect = item.getBoundingClientRect();
            const itemMidY = rect.top + rect.height / 2;
            if (mouseY < itemMidY) {
                this.favoritesList.insertBefore(draggingItem, item);
                return;
            }
        }
        this.favoritesList.appendChild(draggingItem);
    }

    endReorderDrag() {
        if (!this._reorderData) return;

        const item = this._reorderData.item;
        const nodeType = this._reorderData.nodeType;
        item.classList.remove("nf-reorder-dragging");

        const items = Array.from(this.favoritesList.querySelectorAll(".nf-fav-item"));
        const newIndex = items.indexOf(item);

        const categoryId = this.currentCategory === "all" ? null : this.currentCategory;
        let catNodes = this.favorites.nodes;
        if (categoryId) {
            catNodes = catNodes.filter(n => n.categoryId === categoryId);
        }

        const sortMode = this.favorites.sortMode || "default";
        if (sortMode === "default") {
            catNodes.sort((a, b) => (a.order || 0) - (b.order || 0));
        } else {
            catNodes.sort((a, b) => {
                if (b.rating !== a.rating) return b.rating - a.rating;
                return (a.order || 0) - (b.order || 0);
            });
        }

        const draggedNode = this.favorites.nodes.find(n => n.type === nodeType);
        if (!draggedNode) {
            this._reorderData = null;
            return;
        }

        if (newIndex === 0) {
            if (items.length > 1) {
                const nextNode = this.favorites.nodes.find(n => n.type === items[1].dataset.type);
                draggedNode.order = (nextNode?.order || 1000) - 1000;
            } else {
                draggedNode.order = 1000;
            }
        } else if (newIndex === items.length - 1) {
            const prevNode = this.favorites.nodes.find(n => n.type === items[items.length - 2].dataset.type);
            draggedNode.order = (prevNode?.order || 0) + 1000;
        } else {
            const prevNode = this.favorites.nodes.find(n => n.type === items[newIndex - 1].dataset.type);
            const nextNode = this.favorites.nodes.find(n => n.type === items[newIndex + 1].dataset.type);
            const prevOrder = prevNode?.order || 0;
            const nextOrder = nextNode?.order || (prevOrder + 2000);
            draggedNode.order = (prevOrder + nextOrder) / 2;
        }

        this.saveFavorites();
        this.renderFavorites();

        document.removeEventListener("mousemove", this._onReorderMove);
        document.removeEventListener("mouseup", this._onReorderEnd);
        this._reorderData = null;
    }

    addNodeToCanvas(nodeType) {
        this.recordUse(nodeType);
        try {
            const node = LiteGraph.createNode(nodeType);
            if (!node) {
                console.error(`无法创建节点: ${nodeType}`);
                return;
            }

            const canvas = app.canvas;
            if (!canvas || !app.graph) {
                console.error("画布或图未初始化");
                return;
            }

            const graph = app.graph;

            const viewCenterX = canvas.canvas.width / canvas.ds.scale / 2 - canvas.ds.offset[0];
            const viewCenterY = canvas.canvas.height / canvas.ds.scale / 2 - canvas.ds.offset[1];
            node.pos = [viewCenterX, viewCenterY];

            graph.add(node);
            canvas.setDirty(true, true);

            if (node.onAdded) {
                node.onAdded();
            }

            app.graph.change();
        } catch (e) {
            console.error("添加节点到画布失败:", e);
        }
    }

    showAddCategoryDialog() {
        const name = prompt("请输入分类名称：");
        if (!name || !name.trim()) return;

        const colors = ["#4CAF50", "#2196F3", "#FF9800", "#E91E63", "#9C27B0", "#00BCD4", "#795548", "#607D8B"];
        const color = colors[Math.floor(Math.random() * colors.length)];

        const id = "cat_" + Date.now();
        const maxOrder = this.favorites.categories.reduce((max, c) => Math.max(max, c.order || 0), 0);
        this.favorites.categories.push({
            id: id,
            name: name.trim(),
            color: color,
            order: maxOrder + 1
        });

        this.saveFavorites();
        this.renderCategories();
    }

    showEditCategoryDialog(catId) {
        const cat = this.getCategoryById(catId);
        if (!cat) return;

        const dialog = document.createElement("div");
        dialog.className = "nf-dialog-overlay";
        dialog.innerHTML = `
            <div class="nf-dialog">
                <div class="nf-dialog-title">编辑分类</div>
                <div class="nf-dialog-body">
                    <div class="nf-form-item">
                        <label>分类名称：</label>
                        <input type="text" id="nf-cat-name-input" value="${cat.name}" />
                    </div>
                    <div class="nf-form-item">
                        <label>分类颜色：</label>
                        <div class="nf-color-picker">
                            <input type="color" id="nf-cat-color-input" value="${cat.color}" />
                            <span class="nf-color-hex" id="nf-color-hex">${cat.color}</span>
                        </div>
                    </div>
                    <div class="nf-form-item">
                        <label>预设颜色：</label>
                        <div class="nf-color-presets">
                            <div class="nf-preset-color" data-color="#F44336" style="background: #F44336;"></div>
                            <div class="nf-preset-color" data-color="#FF9800" style="background: #FF9800;"></div>
                            <div class="nf-preset-color" data-color="#FFEB3B" style="background: #FFEB3B;"></div>
                            <div class="nf-preset-color" data-color="#4CAF50" style="background: #4CAF50;"></div>
                            <div class="nf-preset-color" data-color="#00BCD4" style="background: #00BCD4;"></div>
                            <div class="nf-preset-color" data-color="#2196F3" style="background: #2196F3;"></div>
                            <div class="nf-preset-color" data-color="#9C27B0" style="background: #9C27B0;"></div>
                        </div>
                    </div>
                </div>
                <div class="nf-dialog-footer">
                    <button class="nf-btn nf-btn-cancel" id="nf-dlg-cancel">取消</button>
                    <button class="nf-btn nf-btn-ok" id="nf-dlg-ok">确定</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        const colorInput = dialog.querySelector("#nf-cat-color-input");
        const colorHex = dialog.querySelector("#nf-color-hex");

        colorInput.addEventListener("input", () => {
            colorHex.textContent = colorInput.value;
        });

        dialog.querySelectorAll(".nf-preset-color").forEach(preset => {
            preset.addEventListener("click", () => {
                const color = preset.dataset.color;
                colorInput.value = color;
                colorHex.textContent = color;
            });
        });

        dialog.querySelector("#nf-dlg-cancel").addEventListener("click", () => {
            dialog.remove();
        });

        dialog.querySelector("#nf-dlg-ok").addEventListener("click", () => {
            const name = dialog.querySelector("#nf-cat-name-input").value.trim();
            const color = colorInput.value;
            if (!name) {
                alert("请输入分类名称！");
                return;
            }
            cat.name = name;
            cat.color = color;
            this.saveFavorites();
            this.renderCategories();
            this.renderFavorites();
            dialog.remove();
        });

        dialog.addEventListener("mousedown", (e) => {
            if (e.target === dialog) {
                dialog.remove();
            }
        });
    }

    deleteCategory(catId) {
        this.favorites.nodes.forEach(n => {
            if (n.categoryId === catId) {
                n.categoryId = "default";
            }
        });

        this.favorites.categories = this.favorites.categories.filter(c => c.id !== catId);

        if (this.currentCategory === catId) {
            this.currentCategory = "all";
        }

        this.saveFavorites();
        this.renderCategories();
        this.renderFavorites();
    }

    moveCategory(catId, offset) {
        const cats = this.favorites.categories;
        const idx = cats.findIndex(c => c.id === catId);
        if (idx < 0) return;
        const newIdx = idx + offset;
        if (newIdx < 0 || newIdx >= cats.length) return;
        // 交换 order 值
        const tmp = cats[idx].order;
        cats[idx].order = cats[newIdx].order;
        cats[newIdx].order = tmp;
        this.saveFavorites();
        this.renderCategories();
    }

    showAddToCategoryDialog(node) {
        const cats = this.favorites.categories;
        let optionsHTML = "";
        for (const cat of cats) {
            optionsHTML += `<option value="${cat.id}">${cat.name}</option>`;
        }

        const dialog = document.createElement("div");
        dialog.className = "nf-dialog-overlay";
        dialog.innerHTML = `
            <div class="nf-dialog">
                <div class="nf-dialog-title">收藏到分类</div>
                <div class="nf-dialog-body">
                    <label>选择分类：</label>
                    <select id="nf-cat-select">${optionsHTML}</select>
                </div>
                <div class="nf-dialog-footer">
                    <button class="nf-btn nf-btn-cancel" id="nf-dlg-cancel">取消</button>
                    <button class="nf-btn nf-btn-ok" id="nf-dlg-ok">确定</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        dialog.querySelector("#nf-dlg-cancel").addEventListener("click", () => {
            dialog.remove();
        });

        dialog.querySelector("#nf-dlg-ok").addEventListener("click", () => {
            const catId = dialog.querySelector("#nf-cat-select").value;
            this.addFavorite(node, catId);
            dialog.remove();
        });

        dialog.addEventListener("mousedown", (e) => {
            if (e.target === dialog) {
                dialog.remove();
            }
        });
    }

    showBatchAddToCategoryDialog(nodes) {
        if (!nodes || nodes.length === 0) return;

        const cats = this.favorites.categories;
        let optionsHTML = "";
        for (const cat of cats) {
            optionsHTML += `<option value="${cat.id}">${cat.name}</option>`;
        }

        const count = nodes.length;
        const dialog = document.createElement("div");
        dialog.className = "nf-dialog-overlay";
        dialog.innerHTML = `
            <div class="nf-dialog">
                <div class="nf-dialog-title">批量收藏 (${count}个节点)</div>
                <div class="nf-dialog-body">
                    <label>选择分类：</label>
                    <select id="nf-cat-select">${optionsHTML}</select>
                </div>
                <div class="nf-dialog-footer">
                    <button class="nf-btn nf-btn-cancel" id="nf-dlg-cancel">取消</button>
                    <button class="nf-btn nf-btn-ok" id="nf-dlg-ok">确定</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        dialog.querySelector("#nf-dlg-cancel").addEventListener("click", () => {
            dialog.remove();
        });

        dialog.querySelector("#nf-dlg-ok").addEventListener("click", () => {
            const catId = dialog.querySelector("#nf-cat-select").value;
            let added = 0;
            for (const node of nodes) {
                if (!this.isNodeFavorited(node.type)) {
                    this.addFavorite(node, catId);
                    added++;
                }
            }
            dialog.remove();
            if (added > 0) {
                this.renderFavorites();
                this.renderCategories();
            }
        });

        dialog.addEventListener("mousedown", (e) => {
            if (e.target === dialog) {
                dialog.remove();
            }
        });
    }

    showMoveNodeCategoryDialog(nodeType) {
        const node = this.favorites.nodes.find(n => n.type === nodeType);
        if (!node) return;
        const nodeName = node.displayName || nodeType;

        const cats = this.favorites.categories;
        let optionsHTML = "";
        for (const cat of cats) {
            const selected = cat.id === node.categoryId ? "selected" : "";
            optionsHTML += `<option value="${cat.id}" ${selected}>${cat.name}</option>`;
        }

        const dialog = document.createElement("div");
        dialog.className = "nf-dialog-overlay";
        dialog.innerHTML = `
            <div class="nf-dialog">
                <div class="nf-dialog-title">移动"${nodeName}"到分类</div>
                <div class="nf-dialog-body">
                    <label>选择分类：</label>
                    <select id="nf-cat-select">${optionsHTML}</select>
                </div>
                <div class="nf-dialog-footer">
                    <button class="nf-btn nf-btn-cancel" id="nf-dlg-cancel">取消</button>
                    <button class="nf-btn nf-btn-ok" id="nf-dlg-ok">确定</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        dialog.querySelector("#nf-dlg-cancel").addEventListener("click", () => {
            dialog.remove();
        });

        dialog.querySelector("#nf-dlg-ok").addEventListener("click", () => {
            const catId = dialog.querySelector("#nf-cat-select").value;
            this.moveNodeToCategory(nodeType, catId);
            dialog.remove();
        });

        dialog.addEventListener("mousedown", (e) => {
            if (e.target === dialog) {
                dialog.remove();
            }
        });
    }
}

app.registerExtension({
    name: "ComfyUI.xiaozhuguang",

    async setup() {
        // 移除旧版 XiaozhuguangSelector 的 DOM widget 处理，改为 Canvas 版
        // 新版实现位于 web/xzg_selector.js
        // 这里仅注册扩展依赖，确保 node_favorites.js 依然加载，选择器功能由 xzg_selector.js 接管

        if (nodeFavoritesInstance) return;

        nodeFavoritesInstance = new Xiaozhuguang();

        const origDrawNode = LGraphCanvas.prototype.drawNode;
        LGraphCanvas.prototype.drawNode = function(node, ctx) {
            if (node.type === "XiaozhuguangTitle") {
                const cv = app.canvas || LGraphCanvas.active_canvas;
                node.selected = !!(cv?.selected_nodes?.[node.id]);
                node.bgcolor = "transparent";
                node.color = "#fff0";
                node.resizable = false;
                node.flags = node.flags || {};
                node.flags.resizable = false;
                if (node.onDrawBackground) {
                    node.onDrawBackground(ctx);
                }
                return;
            }
            origDrawNode.call(this, node, ctx);
        };
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "XiaozhuguangSelector") {
            // 选择器 Canvas 绘制版已迁移到 xzg_selector.js
            // 这里仅保留设置对话框和右键菜单，DOM widget 创建逻辑已移除
            const DEFAULT_COUNT = 2;
            const DEFAULT_COLUMNS = DEFAULT_COUNT;
            const DEFAULT_BTN_WIDTH = 60;
            const DEFAULT_BTN_HEIGHT = 30;
            const DEFAULT_FONT_SIZE = 12;
            const DEFAULT_BTN_GAP = 4;
            const DEFAULT_FONT_COLOR = "#aaa";
            const DEFAULT_COLORS = {
                color1: "#000000",
                color2: "#FF0000",
                color3: "#000000",
                direction: "180deg"
            };
            const DEFAULT_SETTINGS = {
                labels: {"0": "", "1": ""},
                colors: { ...DEFAULT_COLORS },
                count: DEFAULT_COUNT,
                columns: DEFAULT_COLUMNS,
                btnWidth: DEFAULT_BTN_WIDTH,
                btnHeight: DEFAULT_BTN_HEIGHT,
                fontSize: DEFAULT_FONT_SIZE,
                btnGap: DEFAULT_BTN_GAP,
                fontColor: DEFAULT_FONT_COLOR
            };

            function getNodeSettings(node) {
                try {
                    const sw = node.widgets?.find(w => w.name === "_xz_settings");
                    if (sw && sw.value) {
                        const parsed = JSON.parse(sw.value);
                        const settings = { ...DEFAULT_SETTINGS, ...parsed };
                        const max = Math.max(1, settings.count);
                        settings.columns = Math.max(1, Math.min(settings.columns, max));
                        return settings;
                    }
                } catch (e) {}
                const settings = { ...DEFAULT_SETTINGS };
                const max = Math.max(1, settings.count);
                settings.columns = Math.max(1, Math.min(settings.columns, max));
                return settings;
            }

            function setNodeSettings(node, settings) {
                try {
                    const sw = node.widgets?.find(w => w.name === "_xz_settings");
                    if (sw) {
                        sw.value = JSON.stringify(settings);
                    }
                } catch (e) {}
            }

            function loadCount(node) { return getNodeSettings(node).count; }
            function loadLabels(node) { return getNodeSettings(node).labels; }
            function loadColors(node) { return getNodeSettings(node).colors; }
            function loadColumns(node) { return getNodeSettings(node).columns; }

            function getDisplayLabel(value, labels) {
                if (labels[value] && labels[value].trim()) {
                    return labels[value];
                }
                return value;
            }

            function buildLabelsHTML(labels, count) {
                let html = "";
                for (let i = 0; i < count; i += 2) {
                    html += `<div style="display: flex; gap: 12px;">`;
                    html += `
                        <div class="nf-form-item" data-label-item="${i}" style="flex: 1; margin-bottom: 8px;">
                            <label>标签 ${i + 1}（输出值：${i}）：</label>
                            <input type="text" id="nf-label-${i}" value="${labels[String(i)] || ""}" placeholder="留空显示 ${i}" />
                        </div>`;
                    if (i + 1 < count) {
                        html += `
                        <div class="nf-form-item" data-label-item="${i + 1}" style="flex: 1; margin-bottom: 8px;">
                            <label>标签 ${i + 2}（输出值：${i + 1}）：</label>
                            <input type="text" id="nf-label-${i + 1}" value="${labels[String(i + 1)] || ""}" placeholder="留空显示 ${i + 1}" />
                        </div>`;
                    }
                    html += `</div>`;
                }
                return html;
            }

            function getMinBtnWidth(columns) {
                if (columns === 1) return 130;
                if (columns === 2) return 65;
                return 55;
            }

            function showLabelsSettingsDialog(node, onSaved) {
                const settings = getNodeSettings(node);
                const labels = settings.labels;
                const colors = settings.colors;
                const count = settings.count;
                const dialog = document.createElement("div");
                dialog.className = "nf-dialog-overlay";
                dialog.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    z-index: 9999;
                    background: transparent;
                    pointer-events: none;
                `;
                dialog.innerHTML = `
                    <div class="nf-dialog nf-selector-settings-dialog" style="pointer-events: auto; max-height: 85vh; width: 520px; margin: 0; display: flex; flex-direction: column; position: absolute; top: 50%; right: 20px; transform: translateY(-50%);">
                        <div class="nf-dialog-title nf-dialog-drag-handle" style="cursor: move;">设置标签</div>
                        <div class="nf-dialog-body" style="overflow-y: auto; padding: 12px 16px; max-height: 520px;">
                            <div class="nf-form-item" style="margin-bottom: 10px;">
                                <label>颜色与方向：</label>
                                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                    <input type="color" id="nf-color-1" value="${colors.color1}" style="width: 50px; height: 30px; padding: 2px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; cursor: pointer;" title="颜色 1" />
                                    <input type="color" id="nf-color-2" value="${colors.color2}" style="width: 50px; height: 30px; padding: 2px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; cursor: pointer;" title="颜色 2" />
                                    <input type="color" id="nf-color-3" value="${colors.color3}" style="width: 50px; height: 30px; padding: 2px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; cursor: pointer;" title="颜色 3" />
                                    <select id="nf-color-direction" style="width: 120px; height: 28px; padding: 2px 6px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; color: #ddd; font-size: 13px;">
                                        <option value="90deg" ${colors.direction === '90deg' ? 'selected' : ''}>从左到右</option>
                                        <option value="180deg" ${colors.direction === '180deg' ? 'selected' : ''}>从上到下</option>
                                        <option value="radial" ${colors.direction === 'radial' ? 'selected' : ''}>从中心到四周</option>
                                    </select>
                                    <label style="margin-left: 4px; font-size: 13px; color: #aaa;">字体颜色：</label>
                                    <input type="color" id="nf-font-color" value="${settings.fontColor || DEFAULT_FONT_COLOR}" style="width: 50px; height: 30px; padding: 2px; border: 1px solid #444; border-radius: 4px; background: #2a2a2a; cursor: pointer;" title="字体颜色" />
                                </div>
                            </div>
                            <div style="display: flex; gap: 12px; margin-bottom: 10px;">
                                <div class="nf-form-item" style="flex: 1;">
                                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                                        <label style="margin-bottom: 0;">标签数量：</label>
                                        <input type="range" id="nf-label-count" min="2" max="10" value="${count}" style="flex: 1; height: 20px;" />
                                    </div>
                                    <span id="nf-count-value" style="display: block; font-size: 13px; color: #ddd; text-align: center;">${count}个</span>
                                </div>
                                <div class="nf-form-item" style="flex: 1;">
                                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                                        <label style="margin-bottom: 0;">每行列数：</label>
                                        <input type="range" id="nf-columns" min="1" max="${count}" value="${loadColumns(node)}" style="flex: 1; height: 20px;" />
                                    </div>
                                    <span id="nf-columns-value" style="display: block; font-size: 13px; color: #ddd; text-align: center;">${loadColumns(node)}（范围 1~${count}）</span>
                                </div>
                            </div>
                            <div style="display: flex; gap: 12px; margin-bottom: 10px;">
                                <div class="nf-form-item" style="flex: 1;">
                                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                                        <label style="margin-bottom: 0;">标签宽度：</label>
                                        <input type="range" id="nf-btn-width" min="55" max="200" value="${settings.btnWidth || DEFAULT_BTN_WIDTH}" style="flex: 1; height: 20px;" />
                                    </div>
                                    <span id="nf-btn-width-value" style="display: block; font-size: 13px; color: #ddd; text-align: center;">${settings.btnWidth || DEFAULT_BTN_WIDTH}px</span>
                                </div>
                                <div class="nf-form-item" style="flex: 1;">
                                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                                        <label style="margin-bottom: 0;">标签高度：</label>
                                        <input type="range" id="nf-btn-height" min="30" max="80" value="${settings.btnHeight || DEFAULT_BTN_HEIGHT}" style="flex: 1; height: 20px;" />
                                    </div>
                                    <span id="nf-btn-height-value" style="display: block; font-size: 13px; color: #ddd; text-align: center;">${settings.btnHeight || DEFAULT_BTN_HEIGHT}px</span>
                                </div>
                            </div>
                            <div style="display: flex; gap: 12px; margin-bottom: 10px;">
                                <div class="nf-form-item" style="flex: 1;">
                                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                                        <label style="margin-bottom: 0;">字体大小：</label>
                                        <input type="range" id="nf-font-size" min="10" max="24" value="${settings.fontSize || DEFAULT_FONT_SIZE}" style="flex: 1; height: 20px;" />
                                    </div>
                                    <span id="nf-font-size-value" style="display: block; font-size: 13px; color: #ddd; text-align: center;">${settings.fontSize || DEFAULT_FONT_SIZE}px</span>
                                </div>
                                <div class="nf-form-item" style="flex: 1;">
                                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                                        <label style="margin-bottom: 0;">标签间距：</label>
                                        <input type="range" id="nf-btn-gap" min="0" max="20" value="${settings.btnGap || DEFAULT_BTN_GAP}" style="flex: 1; height: 20px;" />
                                    </div>
                                    <span id="nf-btn-gap-value" style="display: block; font-size: 13px; color: #ddd; text-align: center;">${settings.btnGap || DEFAULT_BTN_GAP}px</span>
                                </div>
                            </div>
                            <div id="nf-labels-container">
                                ${buildLabelsHTML(labels, count)}
                            </div>
                        </div>
                        <div class="nf-dialog-footer">
                            <button class="nf-btn nf-btn-cancel" id="nf-dlg-reset">恢复默认</button>
                            <button class="nf-btn nf-btn-cancel" id="nf-dlg-cancel">取消</button>
                            <button class="nf-btn nf-btn-ok" id="nf-dlg-ok">确定</button>
                        </div>
                    </div>
                `;

                document.body.appendChild(dialog);

                const countSelect = dialog.querySelector("#nf-label-count");
                const countValueEl = dialog.querySelector("#nf-count-value");
                const labelsContainer = dialog.querySelector("#nf-labels-container");
                const columnsInput = dialog.querySelector("#nf-columns");
                const columnsValueEl = dialog.querySelector("#nf-columns-value");
                const colorDirectionInput = dialog.querySelector("#nf-color-direction");
                const color1Input = dialog.querySelector("#nf-color-1");
                const color2Input = dialog.querySelector("#nf-color-2");
                const color3Input = dialog.querySelector("#nf-color-3");
                const fontColorInput = dialog.querySelector("#nf-font-color");
                const btnWidthInput = dialog.querySelector("#nf-btn-width");
                const btnHeightInput = dialog.querySelector("#nf-btn-height");
                const fontSizeInput = dialog.querySelector("#nf-font-size");
                const btnGapInput = dialog.querySelector("#nf-btn-gap");
                const btnWidthValueEl = dialog.querySelector("#nf-btn-width-value");
                const btnHeightValueEl = dialog.querySelector("#nf-btn-height-value");
                const fontSizeValueEl = dialog.querySelector("#nf-font-size-value");
                const btnGapValueEl = dialog.querySelector("#nf-btn-gap-value");

                const getCurrentColors = () => ({
                    color1: color1Input.value,
                    color2: color2Input.value,
                    color3: color3Input.value,
                    direction: colorDirectionInput.value
                });

                const getCurrentLabels = () => {
                    const newCount = parseInt(countSelect.value, 10);
                    const newLabels = {};
                    for (let i = 0; i < newCount; i++) {
                        const input = dialog.querySelector(`#nf-label-${i}`);
                        if (input) {
                            newLabels[String(i)] = input.value.trim();
                        }
                    }
                    return { newCount, newLabels };
                };

                const originalSettings = JSON.parse(JSON.stringify(settings));

                const applyCurrentSettings = () => {
                    const { newCount, newLabels } = getCurrentLabels();
                    let newColumns = parseInt(columnsInput?.value, 10);
                    if (isNaN(newColumns) || newColumns < 1) newColumns = 1;
                    newColumns = Math.min(newColumns, newCount);
                    const newColors = getCurrentColors();
                    let newBtnWidth = parseInt(btnWidthInput?.value, 10);
                    const minBtnWidth = getMinBtnWidth(newColumns);
                    if (isNaN(newBtnWidth) || newBtnWidth < minBtnWidth) newBtnWidth = minBtnWidth;
                    if (newBtnWidth > 200) newBtnWidth = 200;
                    let newBtnHeight = parseInt(btnHeightInput?.value, 10);
                    if (isNaN(newBtnHeight) || newBtnHeight < 30) newBtnHeight = 30;
                    if (newBtnHeight > 80) newBtnHeight = 80;
                    let newFontSize = parseInt(fontSizeInput?.value, 10);
                    if (isNaN(newFontSize) || newFontSize < 10) newFontSize = 10;
                    if (newFontSize > 24) newFontSize = 24;
                    let newBtnGap = parseInt(btnGapInput?.value, 10);
                    if (isNaN(newBtnGap) || newBtnGap < 0) newBtnGap = 0;
                    if (newBtnGap > 20) newBtnGap = 20;
                    const newFontColor = fontColorInput?.value || DEFAULT_FONT_COLOR;
                    setNodeSettings(node, {
                        labels: newLabels,
                        colors: newColors,
                        count: newCount,
                        columns: newColumns,
                        btnWidth: newBtnWidth,
                        btnHeight: newBtnHeight,
                        fontSize: newFontSize,
                        btnGap: newBtnGap,
                        fontColor: newFontColor
                    });
                    rebuildSelectorNode(node);
                };

                const applyPreviewColors = () => {
                    const curColors = getCurrentColors();
                    const curFontColor = fontColorInput?.value || DEFAULT_FONT_COLOR;
                    const nodeInfo = allSelectorNodes.find(info => info.node === node);
                    if (nodeInfo && nodeInfo.buttons && nodeInfo.currentValue) {
                        const activeBtn = nodeInfo.buttons.find(b => b.dataset.value === String(nodeInfo.currentValue));
                        if (activeBtn) {
                            applyButtonActiveStyle(activeBtn, curColors, curFontColor);
                        }
                    }
                };

                color1Input.addEventListener("input", () => { applyPreviewColors(); applyCurrentSettings(); });
                color2Input.addEventListener("input", () => { applyPreviewColors(); applyCurrentSettings(); });
                color3Input.addEventListener("input", () => { applyPreviewColors(); applyCurrentSettings(); });
                colorDirectionInput.addEventListener("change", () => { applyPreviewColors(); applyCurrentSettings(); });
                fontColorInput?.addEventListener("input", () => { applyCurrentSettings(); });

                const updateColumnsState = () => {
                    const curCount = parseInt(countSelect.value, 10);
                    if (columnsInput) {
                        columnsInput.max = String(curCount);
                        let curColumns = parseInt(columnsInput.value, 10);
                        if (isNaN(curColumns) || curColumns < 1) curColumns = 1;
                        if (curColumns > curCount) curColumns = curCount;
                        columnsInput.value = String(curColumns);
                        if (columnsValueEl) columnsValueEl.textContent = String(curColumns) + `（范围 1~${curCount}）`;
                    }
                };

                const updateWidthSliderMin = () => {
                    if (!columnsInput || !btnWidthInput) return;
                    const curColumns = parseInt(columnsInput.value, 10) || 1;
                    const minW = getMinBtnWidth(curColumns);
                    btnWidthInput.min = String(minW);
                    let v = parseInt(btnWidthInput.value, 10);
                    if (isNaN(v) || v < minW) {
                        v = minW;
                        btnWidthInput.value = String(v);
                        if (btnWidthValueEl) btnWidthValueEl.textContent = String(v) + "px";
                    }
                };

                countSelect.addEventListener("input", () => {
                    const newCount = parseInt(countSelect.value, 10);
                    const body = dialog.querySelector(".nf-dialog-body");
                    const scrollTop = body ? body.scrollTop : 0;
                    const oldLabels = getCurrentLabels().newLabels;
                    labelsContainer.innerHTML = buildLabelsHTML(oldLabels, newCount);
                    if (body) body.scrollTop = scrollTop;
                    if (countValueEl) countValueEl.textContent = String(newCount) + "个";
                    updateColumnsState();
                    updateWidthSliderMin();
                    applyCurrentSettings();
                });

                labelsContainer.addEventListener("input", (e) => {
                    if (e.target && e.target.id && e.target.id.startsWith("nf-label-")) {
                        applyCurrentSettings();
                    }
                });

                columnsInput?.addEventListener("input", () => {
                    const curCount = parseInt(countSelect.value, 10);
                    let v = parseInt(columnsInput.value, 10);
                    if (isNaN(v) || v < 1) v = 1;
                    if (v > curCount) v = curCount;
                    columnsInput.value = String(v);
                    if (columnsValueEl) columnsValueEl.textContent = String(v);
                    updateWidthSliderMin();
                    applyCurrentSettings();
                });

                btnWidthInput?.addEventListener("input", () => {
                    const curColumns = parseInt(columnsInput?.value, 10) || 1;
                    const minW = getMinBtnWidth(curColumns);
                    let v = parseInt(btnWidthInput.value, 10);
                    if (isNaN(v) || v < minW) v = minW;
                    if (v > 200) v = 200;
                    btnWidthInput.value = String(v);
                    if (btnWidthValueEl) btnWidthValueEl.textContent = String(v) + "px";
                    applyCurrentSettings();
                });

                btnHeightInput?.addEventListener("input", () => {
                    let v = parseInt(btnHeightInput.value, 10);
                    if (isNaN(v) || v < 30) v = 30;
                    if (v > 80) v = 80;
                    btnHeightInput.value = String(v);
                    if (btnHeightValueEl) btnHeightValueEl.textContent = String(v) + "px";
                    applyCurrentSettings();
                });

                fontSizeInput?.addEventListener("input", () => {
                    let v = parseInt(fontSizeInput.value, 10);
                    if (isNaN(v) || v < 10) v = 10;
                    if (v > 24) v = 24;
                    fontSizeInput.value = String(v);
                    if (fontSizeValueEl) fontSizeValueEl.textContent = String(v) + "px";
                    applyCurrentSettings();
                });

                btnGapInput?.addEventListener("input", () => {
                    let v = parseInt(btnGapInput.value, 10);
                    if (isNaN(v) || v < 0) v = 0;
                    if (v > 20) v = 20;
                    btnGapInput.value = String(v);
                    if (btnGapValueEl) btnGapValueEl.textContent = String(v) + "px";
                    applyCurrentSettings();
                });

                color1Input.focus();
                updateWidthSliderMin();

                const submit = () => {
                    applyCurrentSettings();
                    if (onSaved) onSaved();
                    dialog.remove();
                };

                dialog.querySelector("#nf-dlg-reset").addEventListener("click", () => {
                    const body = dialog.querySelector(".nf-dialog-body");
                    const scrollTop = body ? body.scrollTop : 0;
                    const defaultCount = DEFAULT_COUNT;
                    countSelect.value = defaultCount;
                    labelsContainer.innerHTML = buildLabelsHTML({}, defaultCount);
                    if (body) body.scrollTop = scrollTop;
                    if (countValueEl) countValueEl.textContent = String(defaultCount) + "个";
                    color1Input.value = DEFAULT_COLORS.color1;
                    color2Input.value = DEFAULT_COLORS.color2;
                    color3Input.value = DEFAULT_COLORS.color3;
                    colorDirectionInput.value = DEFAULT_COLORS.direction;
                    if (columnsInput) columnsInput.value = String(Math.min(DEFAULT_COLUMNS, defaultCount));
                    if (btnWidthInput) btnWidthInput.value = String(DEFAULT_BTN_WIDTH);
                    if (btnWidthValueEl) btnWidthValueEl.textContent = String(DEFAULT_BTN_WIDTH) + "px";
                    if (btnHeightInput) btnHeightInput.value = String(DEFAULT_BTN_HEIGHT);
                    if (btnHeightValueEl) btnHeightValueEl.textContent = String(DEFAULT_BTN_HEIGHT) + "px";
                    if (fontSizeInput) fontSizeInput.value = String(DEFAULT_FONT_SIZE);
                    if (fontSizeValueEl) fontSizeValueEl.textContent = String(DEFAULT_FONT_SIZE) + "px";
                    if (btnGapInput) btnGapInput.value = String(DEFAULT_BTN_GAP);
                    if (btnGapValueEl) btnGapValueEl.textContent = String(DEFAULT_BTN_GAP) + "px";
                    if (fontColorInput) fontColorInput.value = DEFAULT_FONT_COLOR;
                    updateColumnsState();
                    updateWidthSliderMin();
                    applyPreviewColors();
                    applyCurrentSettings();
                });
                const dialogEl = dialog.querySelector(".nf-selector-settings-dialog");
                let isDragging = false;
                let dragOffsetX = 0;
                let dragOffsetY = 0;

                const savedPos = (() => {
                    try {
                        const stored = localStorage.getItem("xz_selector_dialog_pos");
                        if (stored) return JSON.parse(stored);
                    } catch (e) {}
                    return null;
                })();

                if (savedPos && savedPos.left !== undefined && savedPos.top !== undefined) {
                    dialogEl.style.left = savedPos.left + "px";
                    dialogEl.style.top = savedPos.top + "px";
                    dialogEl.style.right = "auto";
                    dialogEl.style.transform = "none";
                }

                const dragHandle = dialog.querySelector(".nf-dialog-drag-handle");
                if (dragHandle) {
                    dragHandle.addEventListener("mousedown", (e) => {
                        isDragging = true;
                        const rect = dialogEl.getBoundingClientRect();
                        dragOffsetX = e.clientX - rect.left;
                        dragOffsetY = e.clientY - rect.top;
                        dialogEl.style.right = "auto";
                        dialogEl.style.transform = "none";
                        e.preventDefault();
                        e.stopPropagation();
                    });
                }

                document.addEventListener("mousemove", (e) => {
                    if (!isDragging) return;
                    let left = e.clientX - dragOffsetX;
                    let top = e.clientY - dragOffsetY;
                    const rect = dialogEl.getBoundingClientRect();
                    if (left + rect.width > window.innerWidth) {
                        left = window.innerWidth - rect.width;
                    }
                    if (top + rect.height > window.innerHeight) {
                        top = window.innerHeight - rect.height;
                    }
                    if (left < 0) left = 0;
                    if (top < 0) top = 0;
                    dialogEl.style.left = left + "px";
                    dialogEl.style.top = top + "px";
                });

                document.addEventListener("mouseup", () => {
                    if (isDragging) {
                        isDragging = false;
                        try {
                            const rect = dialogEl.getBoundingClientRect();
                            localStorage.setItem("xz_selector_dialog_pos", JSON.stringify({
                                left: rect.left,
                                top: rect.top
                            }));
                        } catch (e) {}
                    }
                });

                dialog.querySelector("#nf-dlg-cancel").addEventListener("click", () => {
                    setNodeSettings(node, originalSettings);
                    rebuildSelectorNode(node);
                    dialog.remove();
                });
                dialog.querySelector("#nf-dlg-ok").addEventListener("click", submit);
            }

            function refreshSelectorNode(node) {
                // Canvas 版：重新触发重绘即可
                if (app?.canvas) app.canvas.setDirtyCanvas(true, true);
            }

            function rebuildSelectorNode(node) {
                // Canvas 版无需重建 DOM，只需刷新画布
                const settings = getNodeSettings(node);
                const count = settings.count;
                const perRow = settings.columns;
                const gap = Math.max(0, Math.min(20, settings.btnGap || DEFAULT_BTN_GAP));
                const minBtnWidth = getMinBtnWidth(perRow);
                const btnWidth = Math.max(minBtnWidth, Math.min(200, settings.btnWidth || DEFAULT_BTN_WIDTH));
                const btnHeight = Math.max(30, Math.min(80, settings.btnHeight || DEFAULT_BTN_HEIGHT));
                const rows = Math.ceil(count / perRow);
                const contentW = perRow * btnWidth + (perRow - 1) * gap;
                const contentH = rows * btnHeight + (rows - 1) * gap;
                const newW = Math.max(180, contentW + 40);
                const newH = Math.max(80, contentH + 50);
                if (!node.size || node.size[0] !== newW || node.size[1] !== newH) {
                    node.size = [newW, newH];
                }
                node.resizable = false;
                node.flags = node.flags || {};
                node.flags.resizable = false;
                if (app?.canvas) {
                    app.canvas.setDirty(true, true);
                    app.graph?.setDirtyCanvas(true, true);
                    app.graph?.change?.();
                }
            }

            if (!window._xz_selector_menu_extended) {
                window._xz_selector_menu_extended = true;
                const origGetNodeMenu = LGraphCanvas.prototype.getNodeMenuOptions;
                LGraphCanvas.prototype.getNodeMenuOptions = function(node) {
                    const options = origGetNodeMenu.apply(this, arguments);
                    if (!options || !Array.isArray(options)) return options;
                    if (node.type !== "XiaozhuguangSelector") return options;

                    options.unshift({
                        content: `<span style="color:#FFD700;">小珠光选择器设置</span>`,
                        callback: () => {
                            showLabelsSettingsDialog(node, (newLabels, newColors, newCount) => {
                                rebuildSelectorNode(node);
                            });
                        }
                    });
                    return options;
                };
            }

            // 注：DOM widget 创建逻辑已移除，选择器 Canvas 绘制版在 xzg_selector.js 中实现
            // 此处保留设置对话框和右键菜单即可
        }

        if (nodeData.name === "XiaozhuguangTitle") {
            const DEFAULT_PROPS = {
                text: "双击编辑字体大小和颜色\n单击拖动右下角调整大小",
                fontSize: 14,
                fontColor: "#ffffff",
                bgColor: "#2a2a2a",
                borderRadius: 8,
                textAlign: "center",
                lineHeight: 1.4,
                glowEnabled: false,
                glowSize: 15,
                glowColor: "#4CAF50",
                glowIntensity: 1,
                rainbowEnabled: false,
                rainbowSpeed: 30,
                rainbowStyle: "波浪",
            };
            const DOM_PREFIX = "xz-title";

            function hexToRgb(hex) {
                const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
                return result ? {
                    r: parseInt(result[1], 16),
                    g: parseInt(result[2], 16),
                    b: parseInt(result[3], 16)
                } : { r: 255, g: 255, b: 255 };
            }

            function hslToRgb(h, s, l) {
                h /= 360;
                s /= 100;
                l /= 100;
                let r, g, b;
                if (s === 0) {
                    r = g = b = l;
                } else {
                    const hue2rgb = (p, q, t) => {
                        if (t < 0) t += 1;
                        if (t > 1) t -= 1;
                        if (t < 1/6) return p + (q - p) * 6 * t;
                        if (t < 1/2) return q;
                        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                        return p;
                    };
                    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                    const p = 2 * l - q;
                    r = hue2rgb(p, q, h + 1/3);
                    g = hue2rgb(p, q, h);
                    b = hue2rgb(p, q, h - 1/3);
                }
                return {
                    r: Math.round(r * 255),
                    g: Math.round(g * 255),
                    b: Math.round(b * 255)
                };
            }

            function getRainbowColor(speed, offset = 0) {
                const time = Date.now() * 0.002 * speed + offset;
                const hue = (time % 360);
                return hslToRgb(hue, 100, 60);
            }

            nodeType.title_mode = LiteGraph.NO_TITLE;
            nodeType.collapsable = false;
            nodeType.resizable = true;

            function vueSels(id) {
                return [`[data-node-id="${id}"]`, `[data-id="${id}"]`, `#node-${id}`, `.litegraph-node[data-node-id="${id}"]`, `.comfy-node[data-node-id="${id}"]`, `.litegraph-node[data-id="${id}"]`, `.comfy-node[data-id="${id}"]`];
            }

            function hideNodeLabels(node) {
                for (const sel of vueSels(node.id)) {
                    const dom = document.querySelector(sel);
                    if (!dom) continue;
                    const hideTextNodes = (el) => {
                        el.childNodes.forEach(child => {
                            if (child.nodeType === Node.TEXT_NODE) {
                                const text = child.textContent.trim();
                                if (text === "xiaozhuguang" || text === "Xiaozhuguang" || text === "小珠光") {
                                    child.textContent = "";
                                }
                            } else if (child.nodeType === Node.ELEMENT_NODE) {
                                const text = child.textContent.trim();
                                if (text === "xiaozhuguang" || text === "Xiaozhuguang" || text === "小珠光") {
                                    child.style.display = "none";
                                    child.style.opacity = "0";
                                    child.style.height = "0";
                                    child.style.width = "0";
                                    child.style.overflow = "hidden";
                                } else {
                                    hideTextNodes(child);
                                }
                            }
                        });
                    };
                    hideTextNodes(dom);
                }
            }

            function applyNodeStyle(node) {
                if (!node?.properties) return;
                const tid = `${DOM_PREFIX}-bg-${node.id}`;
                node.bgcolor = "transparent";
                node.color = "#fff0";
                let el = document.getElementById(tid);
                if (!el) {
                    el = document.createElement("style");
                    el.id = tid;
                    document.head.appendChild(el);
                }
                const sels = vueSels(node.id).join(",");
                el.textContent =
                    `${sels}{background:transparent!important;background-color:transparent!important;border:none!important;box-shadow:none!important;border-radius:0!important;overflow:visible!important;}` +
                    `${sels} *{background:transparent!important;background-color:transparent!important;border:none!important;box-shadow:none!important;}` +
                    `${sels} .node-body,${sels} .litegraph-node-body,${sels} [class*='node-body'],${sels} [class*='node_body'],${sels} .litegraph-node,${sels} .node-container{background:transparent!important;background-color:transparent!important;border:none!important;box-shadow:none!important;overflow:visible!important;}` +
                    `${sels} .node-title,${sels} .litegraph-node-title,${sels} .comfy-node-title,${sels} [class*='title'],${sels} .node-header,${sels} .litegraph-node-header,${sels} .comfy-node-header,${sels} [class*='header'],${sels} .node-type,${sels} .comfy-node-type,${sels} [class*='type'],${sels} .node-badge,${sels} .comfy-badge,${sels} [class*='badge'],${sels} .comfy-menu-button,${sels} .comfy-node-menu,${sels} .litegraph-node-type,${sels} .node-category,${sels} [class*='category'],${sels} .node-label,${sels} [class*='label']{display:none!important;opacity:0!important;height:0!important;width:0!important;overflow:hidden!important;margin:0!important;padding:0!important;}`;
                for (const sel of vueSels(node.id)) {
                    const dom = document.querySelector(sel);
                    if (!dom) continue;
                    dom.style.setProperty("background", "transparent", "important");
                    dom.style.setProperty("background-color", "transparent", "important");
                    dom.style.setProperty("border", "none", "important");
                    dom.style.setProperty("box-shadow", "none", "important");
                    dom.style.setProperty("border-radius", "0", "important");
                    dom.style.setProperty("overflow", "visible", "important");
                    dom.querySelectorAll(".node-body,.litegraph-node-body,[class*='node-body'],[class*='node_body'],.litegraph-node,.node-container").forEach(c => {
                        c.style.setProperty("background", "transparent", "important");
                        c.style.setProperty("background-color", "transparent", "important");
                        c.style.setProperty("border", "none", "important");
                        c.style.setProperty("box-shadow", "none", "important");
                        c.style.setProperty("overflow", "visible", "important");
                    });
                    dom.querySelectorAll(".node-title,.litegraph-node-title,.comfy-node-title,[class*='title'],.node-header,.litegraph-node-header,.comfy-node-header,[class*='header'],.node-type,.comfy-node-type,.litegraph-node-type,[class*='type'],.node-badge,.comfy-badge,[class*='badge'],.comfy-menu-button,.comfy-node-menu,.node-category,[class*='category'],.node-label,[class*='label']").forEach(c => {
                        c.style.display = "none";
                        c.style.opacity = "0";
                        c.style.height = "0";
                        c.style.width = "0";
                        c.style.overflow = "hidden";
                    });
                }
                hideNodeLabels(node);
            }

            const _origCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                _origCreated?.apply(this, arguments);
                this.flags = this.flags || {};
                this.resizable = false;
                this.size = [200, 120];
                this.properties = { ...DEFAULT_PROPS };
                this.color = "#fff0";
                this.bgcolor = "transparent";
                this.title = "";
                this.label = "";
                this.isEditing = false;
                this.editTextarea = null;
                this._removed = false;
                const cs = this.computeSize();
                this.size[0] = cs[0];
                this.size[1] = cs[1];
                let tries = 0;
                const _tick = () => {
                    if (this._removed) return;
                    applyNodeStyle(this, false);
                    attachVueDblClick(this);
                    if (this.title) this.title = "";
                    if (this.label) this.label = "";
                    if (++tries >= 20) return;
                    setTimeout(_tick, 100);
                };
                setTimeout(_tick, 100);
            };

            const _origConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                _origConfigure?.apply(this, arguments);
                this.properties = this.properties || { ...DEFAULT_PROPS };
                if (info.properties) Object.assign(this.properties, info.properties);
                if (info.pos) this.pos = info.pos;
                if (info.size) this.size = info.size;
                if (info.flags) this.flags = info.flags;
                this.color = "#fff0";
                this.bgcolor = "transparent";
                let tries = 0;
                const _cfgTick = () => {
                    if (this._removed) return;
                    applyNodeStyle(this, false);
                    attachVueDblClick(this);
                    if (++tries >= 15) return;
                    setTimeout(_cfgTick, 100);
                };
                setTimeout(_cfgTick, 100);
            };

            const _origSerialize = nodeType.prototype.serialize;
            nodeType.prototype.serialize = function () {
                const d = _origSerialize ? _origSerialize.apply(this, arguments) : {};
                if (!d.id && this.id) d.id = this.id;
                d.properties = { ...this.properties };
                if (!d.pos && this.pos) d.pos = [...this.pos];
                if (!d.size && this.size) d.size = [...this.size];
                if (!d.flags && this.flags) d.flags = { ...this.flags };
                return d;
            };

            nodeType.prototype.onAdded = function () {
                this.properties = this.properties || { ...DEFAULT_PROPS };
                this.color = "#fff0";
                this.bgcolor = "transparent";
                let tries = 0;
                const _addedTick = () => {
                    if (this._removed) return;
                    applyNodeStyle(this, false);
                    attachVueDblClick(this);
                    if (++tries >= 15) {
                        setTimeout(() => { this.adjustHeightToContent(); }, 100);
                        return;
                    }
                    setTimeout(_addedTick, 100);
                };
                setTimeout(_addedTick, 100);
            };

            nodeType.prototype.onRemoved = function () {
                this._removed = true;
                if (this.editTextarea) {
                    this.editTextarea.remove();
                    this.editTextarea = null;
                }
                detachVueDblClick(this);
                const el = document.getElementById(`${DOM_PREFIX}-bg-${this.id}`);
                if (el) el.remove();
            };

            nodeType.prototype.computeSize = function () {
                const p = this.properties || DEFAULT_PROPS;
                const fontSize = p.fontSize || 16;
                const text = p.text || "";
                const lineHeight = fontSize * (p.lineHeight || 1.4);
                const lines = text.split("\n");
                const cv = (window.app?.canvas || LGraphCanvas.active_canvas)?.canvas;
                const ctx = cv ? cv.getContext("2d") : null;
                let maxWidth = 0;
                if (ctx) {
                    ctx.font = `normal ${fontSize}px Arial, sans-serif`;
                    lines.forEach(line => {
                        const w = ctx.measureText(line).width;
                        if (w > maxWidth) maxWidth = w;
                    });
                } else {
                    lines.forEach(line => {
                        const w = fontSize * line.length * 0.6;
                        if (w > maxWidth) maxWidth = w;
                    });
                }
                const w = this._customWidth || Math.max(50, maxWidth + 12);
                const h = this._customHeight || Math.max(30, lines.length * lineHeight + 12);
                return [w, h];
            };

            const _origSetSize = nodeType.prototype.setSize;
            nodeType.prototype.setSize = function (size) {
                _origSetSize?.apply(this, arguments);
                const autoSize = this.computeSize();
                if (size[0] !== autoSize[0]) {
                    this._customWidth = size[0];
                } else {
                    this._customWidth = null;
                }
                if (size[1] !== autoSize[1]) {
                    this._customHeight = size[1];
                } else {
                    this._customHeight = null;
                }
                if (this._resizeTimeout) {
                    clearTimeout(this._resizeTimeout);
                }
                this._resizeTimeout = setTimeout(() => {
                    this.adjustHeightToContent();
                }, 500);
            };

            nodeType.prototype.adjustHeightToContent = function () {
                const p = this.properties || DEFAULT_PROPS;
                const text = p.text || "";
                const fontSize = p.fontSize || 16;
                const lineHeight = fontSize * (p.lineHeight || 1.4);
                const lines = text.split("\n");
                const cv = (window.app?.canvas || LGraphCanvas.active_canvas)?.canvas;
                const ctx = cv ? cv.getContext("2d") : null;

                let maxWidth = 0;
                if (ctx) {
                    ctx.font = `normal ${fontSize}px Arial, sans-serif`;
                    lines.forEach(line => {
                        const w = ctx.measureText(line).width;
                        if (w > maxWidth) maxWidth = w;
                    });
                }
                const autoW = Math.max(50, maxWidth + 12);
                const autoH = Math.max(30, lines.length * lineHeight + 12);

                let changed = false;
                if (!this._customWidth && this.size[0] !== autoW) {
                    this.size[0] = autoW;
                    changed = true;
                }
                if (!this._customHeight && this.size[1] !== autoH) {
                    this.size[1] = autoH;
                    changed = true;
                }
                if (changed && this.graph) {
                    this.graph.change();
                }
            };

            nodeType.prototype.onDrawBackground = function (ctx) {
                if (this.isEditing) return;
                const p = this.properties || DEFAULT_PROPS;
                const w = this.size[0] || 100;
                const h = this.size[1] || 60;
                const text = p.text || "";
                const fontSize = p.fontSize || 16;
                const fontColor = p.fontColor || "#ffffff";
                const glowEnabled = p.glowEnabled;
                const glowSize = p.glowSize || 15;
                const glowColor = p.glowColor || "#4CAF50";
                const glowIntensity = p.glowIntensity || 1;
                const rainbowEnabled = p.rainbowEnabled;
                const rainbowSpeed = p.rainbowSpeed ?? 30;
                const lines = text.split("\n");
                const lineHeight = fontSize * (p.lineHeight || 1.4);
                ctx.save();

                if (this.selected) {
                    ctx.fillStyle = "rgba(76, 175, 80, 0.06)";
                    ctx.fillRect(0, 0, w, h);
                    ctx.strokeStyle = "#4CAF50";
                    ctx.lineWidth = 1;
                    ctx.setLineDash([4, 4]);
                    ctx.strokeRect(1, 1, w - 2, h - 2);
                    ctx.setLineDash([]);
                }

                ctx.font = `normal ${fontSize}px Arial, sans-serif`;
                ctx.textBaseline = "top";
                const align = p.textAlign || "center";
                ctx.textAlign = align;
                const xPos = align === "left" ? 16 : (align === "right" ? w - 16 : w / 2);
                const totalTextH = lines.length * lineHeight;
                const startY = Math.max(0, (h - totalTextH) / 2);

                if (rainbowEnabled) {
                    this._titleAnimFrame = requestAnimationFrame(() => {
                        if (this.graph && !this.isEditing) this.graph.change();
                    });
                } else if (this._titleAnimFrame) {
                    cancelAnimationFrame(this._titleAnimFrame);
                    this._titleAnimFrame = null;
                }

                const getCharColor = (charX, totalWidth, lineIndex) => {
                    if (!rainbowEnabled) return fontColor;
                    const style = p.rainbowStyle || "波浪";
                    const time = Date.now() * 0.002 * (rainbowSpeed / 30);
                    if (style === "透明渐变") {
                        const alpha = ((Math.sin(time + lineIndex * 0.5 + charX / Math.max(totalWidth, 1) * 3) + 1) / 2);
                        const rgb = hexToRgb(fontColor);
                        return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha.toFixed(2)})`;
                    }
                    if (style === "整体透明") {
                        const alpha = ((Math.sin(time) + 1) / 2);
                        const rgb = hexToRgb(fontColor);
                        return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha.toFixed(2)})`;
                    }
                    const hue = style === "呼吸"
                        ? ((Math.sin(time) + 1) / 2 * 360) % 360
                        : (time * 60 + lineIndex * 30 + charX * 360 / Math.max(totalWidth, 1)) % 360;
                    const rgb = hslToRgb(hue, 100, 60);
                    return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
                };

                lines.forEach((line, i) => {
                    const y = startY + i * lineHeight;
                    if (y + fontSize > h) return;
                    if (!rainbowEnabled && !glowEnabled) {
                        ctx.fillStyle = fontColor;
                        ctx.fillText(line, xPos, y);
                    } else {
                        const textWidth = ctx.measureText(line).width;
                        const chars = line.split("");
                        let cx = xPos + (align === "center" ? -textWidth / 2 : align === "right" ? -textWidth : 0);
                        let pixOff = 0;
                        for (let ci = 0; ci < chars.length; ci++) {
                            const color = getCharColor(pixOff, textWidth, i);
                            if (glowEnabled) {
                                const g = rainbowEnabled ? color : glowColor;
                                ctx.save();
                                ctx.shadowColor = g;
                                ctx.shadowBlur = glowSize * glowIntensity * 2;
                                ctx.globalAlpha = 0.15 * glowIntensity;
                                ctx.fillStyle = color;
                                ctx.fillText(chars[ci], cx, y);
                                ctx.restore();
                                ctx.save();
                                ctx.shadowColor = g;
                                ctx.shadowBlur = glowSize * glowIntensity;
                                ctx.globalAlpha = 0.3 * glowIntensity;
                                ctx.fillStyle = color;
                                ctx.fillText(chars[ci], cx, y);
                                ctx.restore();
                                ctx.save();
                                ctx.shadowColor = g;
                                ctx.shadowBlur = glowSize * glowIntensity * 0.5;
                                ctx.globalAlpha = 0.6 * glowIntensity;
                                ctx.fillStyle = color;
                                ctx.fillText(chars[ci], cx, y);
                                ctx.restore();
                            }
                            ctx.fillStyle = color;
                            ctx.fillText(chars[ci], cx, y);
                            const cw = ctx.measureText(chars[ci]).width;
                            cx += cw;
                            pixOff += cw;
                        }
                    }
                });

                ctx.restore();
            };

            nodeType.prototype.onDblClick = function () {
                if (this.isEditing) return true;
                return true;
            };

            nodeType.prototype.onMouseDown = function (e, pos) {
                if (this.isEditing) return true;
                const w = this.size[0] || 100;
                const h = this.size[1] || 60;
                if (pos[0] > w - 16 && pos[1] > h - 16) {
                    return false;
                }
                const now = Date.now();
                if (this._lastClickTime && now - this._lastClickTime < 300) {
                    createTitleEditor(this);
                    return true;
                }
                this._lastClickTime = now;
                return false;
            };

            function getNodeViewportRect(node) {
                const cv = window.app?.canvas || LGraphCanvas.active_canvas;
                if (!cv?.canvas || !cv?.ds) return null;
                const rect = cv.canvas.getBoundingClientRect();
                const sc = cv.ds.scale;
                return {
                    left: rect.left + (node.pos[0] + cv.ds.offset[0]) * sc,
                    top: rect.top + (node.pos[1] + cv.ds.offset[1]) * sc,
                    scale: sc,
                };
            }

            function attachVueDblClick(node) {
                if (node._vueDblClickBound) return;
                const handler = (e) => {
                    if (node._removed) return;
                    node._dblClickHandled = true;
                    setTimeout(() => { node._dblClickHandled = false; }, 50);
                    e.stopPropagation();
                    e.preventDefault();
                    if (!node.isEditing) createTitleEditor(node);
                };
                const tryBind = () => {
                    if (node._removed) return true;
                    for (const sel of vueSels(node.id)) {
                        const el = document.querySelector(sel);
                        if (el) {
                            el.addEventListener("dblclick", handler, true);
                            node._vueDblClickBound = { el, handler };
                            return true;
                        }
                    }
                    return false;
                };
                if (!tryBind()) {
                    let tries = 0;
                    node._dblClickBindTimer = setInterval(() => {
                        if (tryBind() || ++tries > 20) {
                            clearInterval(node._dblClickBindTimer);
                            node._dblClickBindTimer = null;
                        }
                    }, 100);
                }
            }

            function detachVueDblClick(node) {
                if (node._dblClickBindTimer) {
                    clearInterval(node._dblClickBindTimer);
                    node._dblClickBindTimer = null;
                }
                if (!node._vueDblClickBound) return;
                node._vueDblClickBound.el.removeEventListener("dblclick", node._vueDblClickBound.handler, true);
                node._vueDblClickBound = null;
            }

            function createTitleEditor(node) {
                if (node.editTextarea) removeTitleEditor(node);
                const p = node.properties;
                const vr = getNodeViewportRect(node);
                if (!vr) return;
                const sc = vr.scale;
                
                const container = document.createElement("div");
                container.style.cssText = `position:fixed;left:${vr.left}px;top:${vr.top}px;width:${Math.max(260, node.size[0] * sc)}px;z-index:100000;`;
                container.dataset.xzTitleEdit = node.id;
                
                container.addEventListener("wheel", (e) => {
                    if (e.target === ta) return; // let textarea handle its own wheel
                    const cv = app.canvas?.canvas;
                    if (!cv) return;
                    e.preventDefault();
                    e.stopPropagation();
                    cv.dispatchEvent(new WheelEvent('wheel', {
                        deltaY: e.deltaY, deltaX: e.deltaX,
                        clientX: e.clientX, clientY: e.clientY,
                        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
                        bubbles: true, cancelable: true
                    }));
                }, { capture: true, passive: false });
                
                const ta = document.createElement("textarea");
                ta.value = p.text;
                ta.spellcheck = false;
                const editScale = Math.max(1, sc);
                const editFontSize = p.fontSize * sc;
                const editHeight = Math.max(90, node.size[1] * sc);
                const glowShadow = p.glowEnabled ? `box-shadow:inset 0 0 ${(p.glowSize || 15) * (p.glowIntensity || 1)}px ${(p.glowSize || 15) * (p.glowIntensity || 1) / 2}px ${p.glowColor || "#4CAF50"};` : "";
                ta.style.cssText = `${glowShadow}width:100%;height:${editHeight}px;border:1px dashed #4CAF50;outline:none;resize:none;padding:16px;box-sizing:border-box;text-align:${p.textAlign || "center"};background:transparent;color:${p.fontColor};font: normal ${editFontSize}px Arial, sans-serif;line-height:${editFontSize * (p.lineHeight || 1.4)}px;border-radius:${(p.borderRadius || 8) * editScale}px;caret-color:#00ff6a;overflow:hidden;white-space:pre;position:relative;`;
                
                const toolbar = document.createElement("div");
                toolbar.style.cssText = `position:absolute;left:0;right:0;bottom:100%;display:flex;align-items:stretch;margin-bottom:6px;`;
                
                const leftPanel = document.createElement("div");
                leftPanel.style.cssText = `display:flex;flex-direction:column;background:rgba(42,42,42,0.95);border:1px solid #444;border-right:none;border-radius:6px 0 0 6px;padding:4px 0;`;
                
                const rowSeparator = () => {
                    const sep = document.createElement("div");
                    sep.style.cssText = `height:1px;background:#444;margin:4px 6px;`;
                    return sep;
                };
                
                const row1 = document.createElement("div");
                row1.style.cssText = `display:flex;align-items:center;gap:8px;padding:0 6px;`;
                
                const sliderLabel = document.createElement("span");
                sliderLabel.textContent = "字号";
                sliderLabel.style.cssText = `color:#aaa;font-size:13px;white-space:nowrap;font-family:Arial,sans-serif;`;
                
                const slider = document.createElement("input");
                slider.type = "range";
                slider.min = "8";
                slider.max = "50";
                slider.step = "1";
                slider.value = p.fontSize;
                slider.style.cssText = `flex:1;height:4px;cursor:pointer;`;
                
                const sliderValue = document.createElement("span");
                sliderValue.textContent = p.fontSize + "px";
                sliderValue.style.cssText = `color:#4CAF50;font-size:13px;white-space:nowrap;min-width:36px;text-align:right;font-family:Arial,sans-serif;`;
                
                row1.appendChild(sliderLabel);
                row1.appendChild(slider);
                row1.appendChild(sliderValue);
                
                const row2 = document.createElement("div");
                row2.style.cssText = `display:flex;align-items:center;gap:8px;padding:0 6px;`;
                
                const lineHeightLabel = document.createElement("span");
                lineHeightLabel.textContent = "行距";
                lineHeightLabel.style.cssText = `color:#aaa;font-size:13px;white-space:nowrap;font-family:Arial,sans-serif;`;
                
                const lineHeightSlider = document.createElement("input");
                lineHeightSlider.type = "range";
                lineHeightSlider.min = "1";
                lineHeightSlider.max = "3";
                lineHeightSlider.step = "0.1";
                lineHeightSlider.value = p.lineHeight || 1.4;
                lineHeightSlider.style.cssText = `flex:1;height:4px;cursor:pointer;`;
                
                const lineHeightValue = document.createElement("span");
                lineHeightValue.textContent = (p.lineHeight || 1.4).toFixed(1);
                lineHeightValue.style.cssText = `color:#4CAF50;font-size:13px;white-space:nowrap;min-width:30px;text-align:right;font-family:Arial,sans-serif;`;
                
                row2.appendChild(lineHeightLabel);
                row2.appendChild(lineHeightSlider);
                row2.appendChild(lineHeightValue);
                
                const row3 = document.createElement("div");
                row3.style.cssText = `display:flex;align-items:center;gap:8px;padding:0 6px;justify-content:space-between;`;
                
                const fontSizeGroup = document.createElement("div");
                fontSizeGroup.style.cssText = `display:flex;align-items:center;gap:4px;`;
                
                const fontSizeLabel = document.createElement("span");
                fontSizeLabel.textContent = "字号";
                fontSizeLabel.style.cssText = `color:#aaa;font-size:13px;white-space:nowrap;font-family:Arial,sans-serif;`;
                
                const fontSizeInput = document.createElement("input");
                fontSizeInput.type = "text";
                fontSizeInput.value = p.fontSize;
                fontSizeInput.style.cssText = `width:40px;padding:3px 4px;border:1px solid #444;border-radius:4px;background:#2a2a2a;color:#4CAF50;font-size:13px;font-family:Arial,monospace;outline:none;text-align:center;`;
                
                fontSizeGroup.appendChild(fontSizeLabel);
                fontSizeGroup.appendChild(fontSizeInput);
                
                const alignLabel = document.createElement("span");
                alignLabel.textContent = "对齐";
                alignLabel.style.cssText = `color:#aaa;font-size:13px;white-space:nowrap;font-family:Arial,sans-serif;`;
                
                const alignGroup = document.createElement("div");
                alignGroup.style.cssText = `display:flex;gap:2px;`;
                
                const alignBtnStyle = `padding:3px 8px;border:1px solid #444;border-radius:4px;background:#2a2a2a;color:#aaa;cursor:pointer;font-size:13px;font-family:Arial,sans-serif;`;
                
                const alignLeft = document.createElement("button");
                alignLeft.textContent = "左";
                alignLeft.style.cssText = alignBtnStyle + (p.textAlign === "left" ? "background:#4CAF50;color:#fff;border-color:#4CAF50;" : "");
                
                const alignCenter = document.createElement("button");
                alignCenter.textContent = "中";
                alignCenter.style.cssText = alignBtnStyle + (p.textAlign === "center" ? "background:#4CAF50;color:#fff;border-color:#4CAF50;" : "");
                
                const alignRight = document.createElement("button");
                alignRight.textContent = "右";
                alignRight.style.cssText = alignBtnStyle + (p.textAlign === "right" ? "background:#4CAF50;color:#fff;border-color:#4CAF50;" : "");
                
                alignGroup.appendChild(alignLeft);
                alignGroup.appendChild(alignCenter);
                alignGroup.appendChild(alignRight);
                
                const rightGroup = document.createElement("div");
                rightGroup.style.cssText = `display:flex;align-items:center;gap:8px;`;
                rightGroup.appendChild(alignLabel);
                rightGroup.appendChild(alignGroup);
                
                row3.appendChild(fontSizeGroup);
                row3.appendChild(rightGroup);
                
                const colorPanel = document.createElement("div");
                colorPanel.style.cssText = `background:rgba(42,42,42,0.95);border:1px solid #444;border-left:none;border-radius:0 6px 6px 0;padding:8px;user-select:none;display:flex;flex-direction:column;justify-content:center;`;
                
                const svCanvas = document.createElement("canvas");
                svCanvas.width = 140;
                svCanvas.height = 110;
                svCanvas.style.cssText = `width:140px;height:110px;border-radius:4px;cursor:crosshair;display:block;margin-bottom:6px;`;
                
                const hueCanvas = document.createElement("canvas");
                hueCanvas.width = 140;
                hueCanvas.height = 10;
                hueCanvas.style.cssText = `width:140px;height:10px;border-radius:4px;cursor:pointer;display:block;`;
                
                colorPanel.appendChild(svCanvas);
                colorPanel.appendChild(hueCanvas);
                
                colorPanel.addEventListener("mousedown", e => { e.stopPropagation(); e.preventDefault(); });
                colorPanel.addEventListener("click", e => { e.stopPropagation(); });
                
                let currentHue = 0;
                let currentSat = 1;
                let currentVal = 1;
                
                const hexToHsv = (hex) => {
                    const r = parseInt(hex.slice(1, 3), 16) / 255;
                    const g = parseInt(hex.slice(3, 5), 16) / 255;
                    const b = parseInt(hex.slice(5, 7), 16) / 255;
                    const max = Math.max(r, g, b), min = Math.min(r, g, b);
                    let h, s, v = max;
                    const d = max - min;
                    s = max === 0 ? 0 : d / max;
                    if (max === min) {
                        h = 0;
                    } else {
                        switch (max) {
                            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                            case g: h = (b - r) / d + 2; break;
                            case b: h = (r - g) / d + 4; break;
                        }
                        h /= 6;
                    }
                    return { h: h * 360, s, v };
                };
                
                const hsvToHex = (h, s, v) => {
                    h /= 360;
                    let r, g, b;
                    const i = Math.floor(h * 6);
                    const f = h * 6 - i;
                    const p = v * (1 - s);
                    const q = v * (1 - f * s);
                    const t = v * (1 - (1 - f) * s);
                    switch (i % 6) {
                        case 0: r = v, g = t, b = p; break;
                        case 1: r = q, g = v, b = p; break;
                        case 2: r = p, g = v, b = t; break;
                        case 3: r = p, g = q, b = v; break;
                        case 4: r = t, g = p, b = v; break;
                        case 5: r = v, g = p, b = q; break;
                    }
                    const toHex = x => {
                        const hex = Math.round(x * 255).toString(16);
                        return hex.length === 1 ? "0" + hex : hex;
                    };
                    return "#" + toHex(r) + toHex(g) + toHex(b);
                };
                
                const drawHue = () => {
                    const ctx = hueCanvas.getContext("2d");
                    const w = hueCanvas.width, h = hueCanvas.height;
                    const grad = ctx.createLinearGradient(0, 0, w, 0);
                    grad.addColorStop(0, "#ff0000");
                    grad.addColorStop(1 / 6, "#ffff00");
                    grad.addColorStop(2 / 6, "#00ff00");
                    grad.addColorStop(3 / 6, "#00ffff");
                    grad.addColorStop(4 / 6, "#0000ff");
                    grad.addColorStop(5 / 6, "#ff00ff");
                    grad.addColorStop(1, "#ff0000");
                    ctx.fillStyle = grad;
                    ctx.fillRect(0, 0, w, h);
                    const x = (currentHue / 360) * w;
                    ctx.fillStyle = "#fff";
                    ctx.beginPath();
                    ctx.arc(x, h / 2, h / 2 - 1, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = "#000";
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.arc(x, h / 2, h / 2 - 1, 0, Math.PI * 2);
                    ctx.stroke();
                };
                
                const drawSV = () => {
                    const ctx = svCanvas.getContext("2d");
                    const w = svCanvas.width, h = svCanvas.height;
                    const hueColor = hsvToHex(currentHue, 1, 1);
                    const hGrad = ctx.createLinearGradient(0, 0, w, 0);
                    hGrad.addColorStop(0, "#ffffff");
                    hGrad.addColorStop(1, hueColor);
                    ctx.fillStyle = hGrad;
                    ctx.fillRect(0, 0, w, h);
                    const vGrad = ctx.createLinearGradient(0, 0, 0, h);
                    vGrad.addColorStop(0, "rgba(0,0,0,0)");
                    vGrad.addColorStop(1, "#000000");
                    ctx.fillStyle = vGrad;
                    ctx.fillRect(0, 0, w, h);
                    const x = currentSat * w;
                    const y = (1 - currentVal) * h;
                    ctx.fillStyle = "#fff";
                    ctx.beginPath();
                    ctx.arc(x, y, 5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = "#000";
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.arc(x, y, 5, 0, Math.PI * 2);
                    ctx.stroke();
                };
                
                const updateColorFromHSV = () => {
                    const hex = hsvToHex(currentHue, currentSat, currentVal);
                    if (activeColorTarget === "glow") {
                        p.glowColor = hex;
                        glowColorBtn.style.background = hex;
                        updateTextareaGlow();
                    } else {
                        p.fontColor = hex;
                        ta.style.color = hex;
                        fontColorSwatch.style.background = hex;
                    }
                    drawSV();
                    drawHue();
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                };
                
                const initFromColor = (hex) => {
                    const hsv = hexToHsv(hex);
                    currentHue = hsv.h;
                    currentSat = hsv.s;
                    currentVal = hsv.v;
                    drawSV();
                };
                
                drawHue();
                initFromColor(p.fontColor);
                
                let svDragging = false;
                let hueDragging = false;
                
                const updateSVFromEvent = (e) => {
                    const rect = svCanvas.getBoundingClientRect();
                    let x = (e.clientX - rect.left) / rect.width;
                    let y = (e.clientY - rect.top) / rect.height;
                    x = Math.max(0, Math.min(1, x));
                    y = Math.max(0, Math.min(1, y));
                    currentSat = x;
                    currentVal = 1 - y;
                    updateColorFromHSV();
                };
                
                svCanvas.addEventListener("mousedown", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    svDragging = true;
                    updateSVFromEvent(e);
                });
                
                document.addEventListener("mousemove", (e) => {
                    if (svDragging) updateSVFromEvent(e);
                });
                
                document.addEventListener("mouseup", () => {
                    svDragging = false;
                });
                
                const updateHueFromEvent = (e) => {
                    const rect = hueCanvas.getBoundingClientRect();
                    let x = (e.clientX - rect.left) / rect.width;
                    x = Math.max(0, Math.min(1, x));
                    currentHue = x * 360;
                    drawSV();
                    updateColorFromHSV();
                };
                
                hueCanvas.addEventListener("mousedown", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    hueDragging = true;
                    updateHueFromEvent(e);
                });
                
                document.addEventListener("mousemove", (e) => {
                    if (hueDragging) updateHueFromEvent(e);
                });
                
                document.addEventListener("mouseup", () => {
                    hueDragging = false;
                });

                const createToggleBtn = (label, enabled, activeColor, scale = 1) => {
                    const btn = document.createElement("button");
                    btn.type = "button";
                    const updateBtn = (isOn, currentScale = scale) => {
                        const s = currentScale;
                        btn.innerHTML = `
                            <span style="display:inline-flex;align-items:center;gap:${4 * s}px;pointer-events:none;white-space:nowrap;">
                                <span style="font-size:${13 * s}px;pointer-events:none;white-space:nowrap;">${label}</span>
                                <span class="toggle-track" style="display:inline-flex;align-items:center;width:${32 * s}px;height:${16 * s}px;border-radius:${8 * s}px;background:${isOn ? activeColor : '#555'};position:relative;transition:background 0.2s;pointer-events:none;">
                                    <span class="toggle-thumb" style="position:absolute;left:${isOn ? 17 * s : 2 * s}px;top:${2 * s}px;width:${12 * s}px;height:${12 * s}px;border-radius:50%;background:#fff;transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.3);pointer-events:none;"></span>
                                </span>
                                <span style="font-size:${12 * s}px;color:${isOn ? activeColor : '#777'};font-weight:bold;min-width:${16 * s}px;pointer-events:none;">${isOn ? '开' : '关'}</span>
                            </span>
                        `;
                        btn.style.cssText = `padding:${4 * s}px ${8 * s}px;border:1px solid ${isOn ? activeColor : '#555'};border-radius:${4 * s}px;background:${isOn ? activeColor + '22' : '#333'};color:${isOn ? activeColor : '#aaa'};cursor:pointer;font-family:Arial,sans-serif;transition:all 0.2s;display:flex;align-items:center;flex-shrink:0;white-space:nowrap;`;
                    };
                    updateBtn(enabled);
                    btn._update = updateBtn;
                    return btn;
                };
                
                const row4 = document.createElement("div");
                row4.style.cssText = `display:flex;align-items:center;gap:8px;padding:0 6px;flex-wrap:nowrap;`;

                const glowToggle = createToggleBtn("辉光", p.glowEnabled, "#4CAF50");

                const glowSizeLabel = document.createElement("span");
                glowSizeLabel.textContent = "大小";
                glowSizeLabel.style.cssText = `color:#888;font-size:13px;white-space:nowrap;font-family:Arial,sans-serif;margin-left:4px;`;

                const glowSizeSlider = document.createElement("input");
                glowSizeSlider.type = "range";
                glowSizeSlider.min = "0";
                glowSizeSlider.max = "50";
                glowSizeSlider.step = "1";
                glowSizeSlider.value = p.glowSize || 15;
                glowSizeSlider.style.cssText = `width:60px;height:4px;cursor:pointer;`;

                const glowIntensityLabel = document.createElement("span");
                glowIntensityLabel.textContent = "强度";
                glowIntensityLabel.style.cssText = `color:#888;font-size:13px;white-space:nowrap;font-family:Arial,sans-serif;margin-left:4px;`;

                const glowIntensitySlider = document.createElement("input");
                glowIntensitySlider.type = "range";
                glowIntensitySlider.min = "0.1";
                glowIntensitySlider.max = "3";
                glowIntensitySlider.step = "0.1";
                glowIntensitySlider.value = p.glowIntensity || 1;
                glowIntensitySlider.style.cssText = `width:50px;height:4px;cursor:pointer;`;

                const glowColorLabel = document.createElement("span");
                glowColorLabel.textContent = "颜色";
                glowColorLabel.style.cssText = `color:#888;font-size:13px;white-space:nowrap;font-family:Arial,sans-serif;margin-left:4px;`;

                let activeColorTarget = "font";
                const fontColorSwatch = document.createElement("button");
                fontColorSwatch.style.cssText = `width:28px;height:24px;padding:0;border:2px solid #fff;border-radius:3px;background:${p.fontColor};cursor:pointer;`;
                fontColorSwatch.title = "文字颜色";
                fontColorSwatch.addEventListener("click", (e) => {
                    e.stopPropagation();
                    activeColorTarget = "font";
                    fontColorSwatch.style.borderColor = "#fff";
                    glowColorBtn.style.borderColor = "#444";
                    initFromColor(p.fontColor);
                });

                const glowColorBtn = document.createElement("button");
                glowColorBtn.style.cssText = `width:28px;height:24px;padding:0;border:2px solid #444;border-radius:3px;background:${p.glowColor || "#4CAF50"};cursor:pointer;`;
                glowColorBtn.title = "辉光颜色";
                glowColorBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    activeColorTarget = "glow";
                    glowColorBtn.style.borderColor = "#fff";
                    fontColorSwatch.style.borderColor = "#444";
                    initFromColor(p.glowColor || "#4CAF50");
                });


                const glowControlsWrap = document.createElement("div");
                glowControlsWrap.style.cssText = `display:${p.glowEnabled ? 'flex' : 'none'};align-items:center;gap:8px;flex-wrap:nowrap;`;
                glowControlsWrap.appendChild(glowSizeLabel);
                glowControlsWrap.appendChild(glowSizeSlider);
                glowControlsWrap.appendChild(glowIntensityLabel);
                glowControlsWrap.appendChild(glowIntensitySlider);
                glowControlsWrap.appendChild(glowColorLabel);
                glowControlsWrap.appendChild(fontColorSwatch);
                glowControlsWrap.appendChild(glowColorBtn);

                row4.appendChild(glowToggle);
                row4.appendChild(glowControlsWrap);

                const row5 = document.createElement("div");
                row5.style.cssText = `display:flex;align-items:center;gap:8px;padding:0 6px;flex-wrap:nowrap;`;

                const rainbowToggle = createToggleBtn("炫彩", p.rainbowEnabled, "#FF6B9D");

                const rainbowStyleLabel = document.createElement("span");
                rainbowStyleLabel.textContent = "样式";
                rainbowStyleLabel.style.cssText = `color:#888;font-size:13px;white-space:nowrap;font-family:Arial,sans-serif;margin-left:4px;`;

                const rainbowStyleSelect = document.createElement("select");
                rainbowStyleSelect.style.cssText = `background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:2px 4px;font-size:12px;cursor:pointer;`;
                ["波浪", "呼吸", "透明渐变", "整体透明"].forEach(s => {
                    const opt = document.createElement("option");
                    opt.value = s; opt.textContent = s;
                    if (s === (p.rainbowStyle || "波浪")) opt.selected = true;
                    rainbowStyleSelect.appendChild(opt);
                });
                rainbowStyleSelect.addEventListener("change", (e) => {
                    p.rainbowStyle = e.target.value;
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                });

                const rainbowSpeedLabel = document.createElement("span");
                rainbowSpeedLabel.textContent = "速度";
                rainbowSpeedLabel.style.cssText = `color:#888;font-size:13px;white-space:nowrap;font-family:Arial,sans-serif;margin-left:4px;`;

                const rainbowSpeedSlider = document.createElement("input");
                rainbowSpeedSlider.type = "range";
                rainbowSpeedSlider.min = "0.1";
                rainbowSpeedSlider.max = "60";
                rainbowSpeedSlider.step = "0.1";
                rainbowSpeedSlider.value = p.rainbowSpeed ?? 30;
                rainbowSpeedSlider.style.cssText = `width:120px;height:4px;cursor:pointer;`;

                const rainbowControlsWrap = document.createElement("div");
                rainbowControlsWrap.style.cssText = `display:${p.rainbowEnabled ? 'flex' : 'none'};align-items:center;gap:8px;`;
                rainbowControlsWrap.appendChild(rainbowStyleLabel);
                rainbowControlsWrap.appendChild(rainbowStyleSelect);
                rainbowControlsWrap.appendChild(rainbowSpeedLabel);
                rainbowControlsWrap.appendChild(rainbowSpeedSlider);

                row5.appendChild(rainbowToggle);
                row5.appendChild(rainbowControlsWrap);

                leftPanel.appendChild(row1);
                leftPanel.appendChild(rowSeparator());
                leftPanel.appendChild(row2);
                leftPanel.appendChild(rowSeparator());
                leftPanel.appendChild(row3);
                leftPanel.appendChild(rowSeparator());
                leftPanel.appendChild(row4);
                leftPanel.appendChild(rowSeparator());
                leftPanel.appendChild(row5);
                toolbar.appendChild(leftPanel);
                toolbar.appendChild(colorPanel);
                container.appendChild(toolbar);
                container.appendChild(ta);
                
                node.editTextarea = container;
                node._editTextareaEl = ta;
                document.body.appendChild(container);
                
                requestAnimationFrame(() => { 
                    ta.focus({ preventScroll: true }); 
                    requestAnimationFrame(() => {
                        ta.setSelectionRange(1, 1);
                    });
                });

                let _focusTries = 0;
                const _focusTick = () => {
                    if (!node.editTextarea || ++_focusTries > 8 || node._removed) { node._focusGuard = null; return; }
                    if (node._composing) { node._focusGuard = requestAnimationFrame(_focusTick); return; }
                    const ae = document.activeElement;
                    if (colorPanel.contains(ae)) { node._focusGuard = requestAnimationFrame(_focusTick); return; }
                    if (row4.contains(ae) || row5.contains(ae)) { node._focusGuard = requestAnimationFrame(_focusTick); return; }
                    if (ae !== ta && ae !== slider && ae !== lineHeightSlider && ae !== alignLeft && ae !== alignCenter && ae !== alignRight && ae !== glowToggle && ae !== glowSizeSlider && ae !== glowIntensitySlider && ae !== glowColorBtn && ae !== fontColorSwatch && ae !== rainbowToggle && ae !== rainbowSpeedSlider) { ta.focus({ preventScroll: true }); }
                    node._focusGuard = requestAnimationFrame(_focusTick);
                };
                node._focusGuard = requestAnimationFrame(_focusTick);
                node._blurRetries = 0;

                const updateFontSize = (size) => {
                    const s = parseFloat(size) || 16;
                    p.fontSize = s;
                    const nr = getNodeViewportRect(node);
                    const scale = nr ? nr.scale : 1;
                    ta.style.fontSize = s * scale + "px";
                    ta.style.lineHeight = s * scale * 1.4 + "px";
                    sliderValue.textContent = s + "px";
                    if (s <= 50) {
                        slider.value = s;
                    }
                    fontSizeInput.value = s;
                    node.adjustHeightToContent();
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                };

                const updateTextAlign = (align) => {
                    p.textAlign = align;
                    ta.style.textAlign = align;
                    alignLeft.style.cssText = alignBtnStyle + (align === "left" ? "background:#4CAF50;color:#fff;border-color:#4CAF50;" : "");
                    alignCenter.style.cssText = alignBtnStyle + (align === "center" ? "background:#4CAF50;color:#fff;border-color:#4CAF50;" : "");
                    alignRight.style.cssText = alignBtnStyle + (align === "right" ? "background:#4CAF50;color:#fff;border-color:#4CAF50;" : "");
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                };

                const updateLineHeight = (value) => {
                    const v = parseFloat(value) || 1.4;
                    p.lineHeight = v;
                    const nr = getNodeViewportRect(node);
                    const scale = nr ? nr.scale : 1;
                    ta.style.lineHeight = p.fontSize * scale * v + "px";
                    lineHeightValue.textContent = v.toFixed(1);
                    node.adjustHeightToContent();
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                };

                const saveClose = () => {
                    if (!node.editTextarea) return;
                    p.text = ta.value;
                    removeTitleEditor(node);
                    node._customWidth = null;
                    node._customHeight = null;
                    node.adjustHeightToContent();
                    node.setDirtyCanvas?.(true, true);
                    window.app?.graph?.setDirtyCanvas(true);
                };

                const _posTick = () => {
                    if (!node.editTextarea) { node._posRaf = null; return; }
                    const nr = getNodeViewportRect(node);
                    if (nr) {
                        const s = nr.scale;
                        container.style.left = nr.left + "px";
                        container.style.top = nr.top + "px";
                        container.style.width = node.size[0] * s + "px";
                        ta.style.height = node.size[1] * s + "px";
                        ta.style.fontSize = p.fontSize * s + "px";
                        ta.style.lineHeight = p.fontSize * s * (p.lineHeight || 1.4) + "px";
                        ta.style.borderRadius = (p.borderRadius || 8) * s + "px";
                    }
                    node._posRaf = requestAnimationFrame(_posTick);
                };
                node._posRaf = requestAnimationFrame(_posTick);

                slider.addEventListener("input", (e) => {
                    updateFontSize(e.target.value);
                });
                
                slider.addEventListener("mousedown", (e) => {
                    e.stopPropagation();
                });
                
                slider.addEventListener("click", (e) => {
                    e.stopPropagation();
                });
                
                alignLeft.addEventListener("click", (e) => {
                    e.stopPropagation();
                    updateTextAlign("left");
                });
                alignCenter.addEventListener("click", (e) => {
                    e.stopPropagation();
                    updateTextAlign("center");
                });
                alignRight.addEventListener("click", (e) => {
                    e.stopPropagation();
                    updateTextAlign("right");
                });

                alignLeft.addEventListener("mousedown", (e) => { e.stopPropagation(); });
                alignCenter.addEventListener("mousedown", (e) => { e.stopPropagation(); });
                alignRight.addEventListener("mousedown", (e) => { e.stopPropagation(); });

                lineHeightSlider.addEventListener("input", (e) => {
                    updateLineHeight(e.target.value);
                });
                lineHeightSlider.addEventListener("mousedown", (e) => { e.stopPropagation(); });
                lineHeightSlider.addEventListener("click", (e) => { e.stopPropagation(); });

                fontSizeInput.addEventListener("input", (e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val) && val >= 8 && val <= 200) {
                        updateFontSize(val);
                        if (val <= 50) {
                            slider.value = val;
                        }
                    }
                });
                fontSizeInput.addEventListener("mousedown", (e) => { e.stopPropagation(); });
                fontSizeInput.addEventListener("click", (e) => { e.stopPropagation(); });

                const updateTextareaGlow = () => {
                    if (p.glowEnabled) {
                        const blur = (p.glowSize || 15) * (p.glowIntensity || 1);
                        ta.style.boxShadow = `inset 0 0 ${blur}px ${blur / 2}px ${p.glowColor || "#4CAF50"}`;
                    } else {
                        ta.style.boxShadow = "";
                    }
                };

                const updateGlowEnabled = (enabled) => {
                    p.glowEnabled = enabled;
                    glowToggle._update(enabled);
                    glowControlsWrap.style.display = enabled ? 'flex' : 'none';
                    updateTextareaGlow();
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                };

                const updateGlowSize = (size) => {
                    const s = parseFloat(size) || 15;
                    p.glowSize = s;
                    updateTextareaGlow();
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                };

                const updateGlowIntensity = (intensity) => {
                    const i = parseFloat(intensity) || 1;
                    p.glowIntensity = i;
                    updateTextareaGlow();
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                };

                const updateGlowColor = (color) => {
                    p.glowColor = color;
                    updateTextareaGlow();
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                };

                const updateRainbowEnabled = (enabled) => {
                    p.rainbowEnabled = enabled;
                    rainbowToggle._update(enabled);
                    rainbowControlsWrap.style.display = enabled ? 'flex' : 'none';
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                };

                const updateRainbowSpeed = (speed) => {
                    const s = parseFloat(speed) ?? 30;
                    p.rainbowSpeed = s;
                    if (node.graph) node.graph.setDirtyCanvas(true, true);
                };

                glowToggle.addEventListener("click", (e) => {
                    e.stopPropagation();
                    updateGlowEnabled(!p.glowEnabled);
                });
                glowToggle.addEventListener("mousedown", (e) => { e.stopPropagation(); });

                glowSizeSlider.addEventListener("input", (e) => {
                    updateGlowSize(e.target.value);
                });
                glowSizeSlider.addEventListener("mousedown", (e) => { e.stopPropagation(); });
                glowSizeSlider.addEventListener("click", (e) => { e.stopPropagation(); });

                glowIntensitySlider.addEventListener("input", (e) => {
                    updateGlowIntensity(e.target.value);
                });
                glowIntensitySlider.addEventListener("mousedown", (e) => { e.stopPropagation(); });
                glowIntensitySlider.addEventListener("click", (e) => { e.stopPropagation(); });

                rainbowToggle.addEventListener("click", (e) => {
                    e.stopPropagation();
                    updateRainbowEnabled(!p.rainbowEnabled);
                });
                rainbowToggle.addEventListener("mousedown", (e) => { e.stopPropagation(); });

                rainbowSpeedSlider.addEventListener("input", (e) => {
                    updateRainbowSpeed(e.target.value);
                });
                rainbowSpeedSlider.addEventListener("mousedown", (e) => { e.stopPropagation(); });
                rainbowSpeedSlider.addEventListener("click", (e) => { e.stopPropagation(); });

                ta.addEventListener("input", () => {
                    node._userText = ta.value;
                    p.text = ta.value;
                    node._customWidth = null;
                    node._customHeight = null;
                    node.adjustHeightToContent();
                    const vr2 = getNodeViewportRect(node);
                    if (vr2) {
                        container.style.left = vr2.left + "px";
                        container.style.top = vr2.top + "px";
                        container.style.width = Math.max(260, node.size[0] * vr2.scale) + "px";
                        ta.style.height = Math.max(90, node.size[1] * vr2.scale) + "px";
                    }
                    node.setDirtyCanvas?.(true, true);
                    window.app?.graph?.setDirtyCanvas(true);
                });
                ta.addEventListener("compositionstart", () => { node._composing = true; });
                ta.addEventListener("compositionend", () => { node._composing = false; });

                ta.addEventListener("keydown", e => {
                    if (e.key === "Escape") removeTitleEditor(node);
                    else if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); saveClose(); }
                    e.stopPropagation();
                });
                
                ta.addEventListener("wheel", (e) => {
                    const canvas = app.canvas?.canvas;
                    if (!canvas) return;
                    e.stopPropagation();
                    canvas.dispatchEvent(new WheelEvent('wheel', {
                        deltaY: e.deltaY, deltaX: e.deltaX,
                        clientX: e.clientX, clientY: e.clientY,
                        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
                        bubbles: true, cancelable: true
                    }));
                }, { passive: false });
                
                slider.addEventListener("keydown", e => {
                    if (e.key === "Escape") removeTitleEditor(node);
                    e.stopPropagation();
                });
                
                lineHeightSlider.addEventListener("keydown", e => {
                    if (e.key === "Escape") removeTitleEditor(node);
                    e.stopPropagation();
                });
                
                fontSizeInput.addEventListener("keydown", e => {
                    if (e.key === "Escape") removeTitleEditor(node);
                    e.stopPropagation();
                });
                
                alignLeft.addEventListener("keydown", e => {
                    if (e.key === "Escape") removeTitleEditor(node);
                    e.stopPropagation();
                });
                alignCenter.addEventListener("keydown", e => {
                    if (e.key === "Escape") removeTitleEditor(node);
                    e.stopPropagation();
                });
                alignRight.addEventListener("keydown", e => {
                    if (e.key === "Escape") removeTitleEditor(node);
                    e.stopPropagation();
                });

                glowToggle.addEventListener("keydown", e => {
                    if (e.key === "Escape") removeTitleEditor(node);
                    e.stopPropagation();
                });
                glowSizeSlider.addEventListener("keydown", e => {
                    if (e.key === "Escape") removeTitleEditor(node);
                    e.stopPropagation();
                });
                glowIntensitySlider.addEventListener("keydown", e => {
                    if (e.key === "Escape") removeTitleEditor(node);
                    e.stopPropagation();
                });
                rainbowToggle.addEventListener("keydown", e => {
                    if (e.key === "Escape") removeTitleEditor(node);
                    e.stopPropagation();
                });
                rainbowSpeedSlider.addEventListener("keydown", e => {
                    if (e.key === "Escape") removeTitleEditor(node);
                    e.stopPropagation();
                });

                node._docClickHandler = e => {
                    if (!node.isEditing || !node.editTextarea) return;
                    if (container.contains(e.target)) return;
                    saveClose();
                };
                setTimeout(() => { if (node.isEditing) document.addEventListener("click", node._docClickHandler, true); }, 200);

                const isFocusInside = () => {
                    const ae = document.activeElement;
                    if (colorPanel.contains(ae)) return true;
                    if (row4.contains(ae) || row5.contains(ae)) return true;
                    return ae === ta || ae === slider || ae === lineHeightSlider || ae === fontSizeInput || ae === alignLeft || ae === alignCenter || ae === alignRight || ae === glowToggle || ae === glowSizeSlider || ae === glowIntensitySlider || ae === glowColorBtn || ae === fontColorSwatch || ae === rainbowToggle || ae === rainbowSpeedSlider;
                };

                ta.addEventListener("blur", () => { setTimeout(() => {
                    if (!node.isEditing || isFocusInside()) return;
                    const ae = document.activeElement;
                    if (ae && vueSels(node.id).some(sel => ae.closest?.(sel))) {
                        if ((node._blurRetries = (node._blurRetries || 0) + 1) <= 4) { ta.focus({ preventScroll: true }); }
                        return;
                    }
                    saveClose();
                }, 150); });
                
                slider.addEventListener("blur", () => { setTimeout(() => {
                    if (!node.isEditing || isFocusInside()) return;
                    const ae = document.activeElement;
                    if (ae && vueSels(node.id).some(sel => ae.closest?.(sel))) {
                        return;
                    }
                    saveClose();
                }, 150); });
                
                lineHeightSlider.addEventListener("blur", () => { setTimeout(() => {
                    if (!node.isEditing || isFocusInside()) return;
                    const ae = document.activeElement;
                    if (ae && vueSels(node.id).some(sel => ae.closest?.(sel))) {
                        return;
                    }
                    saveClose();
                }, 150); });

                fontSizeInput.addEventListener("blur", () => { setTimeout(() => {
                    if (!node.isEditing || isFocusInside()) return;
                    const ae = document.activeElement;
                    if (ae && vueSels(node.id).some(sel => ae.closest?.(sel))) {
                        return;
                    }
                    const val = parseFloat(fontSizeInput.value);
                    if (!isNaN(val) && val >= 8 && val <= 200) {
                        updateFontSize(val);
                    } else {
                        fontSizeInput.value = p.fontSize;
                    }
                    saveClose();
                }, 150); });

                node.isEditing = true;
            }

            function removeTitleEditor(node) {
                if (node._focusGuard) { cancelAnimationFrame(node._focusGuard); node._focusGuard = null; }
                if (node._posRaf) { cancelAnimationFrame(node._posRaf); node._posRaf = null; }
                if (node._docClickHandler) { document.removeEventListener("click", node._docClickHandler, true); node._docClickHandler = null; }
                if (node.editTextarea) { node.editTextarea.remove(); node.editTextarea = null; }
                delete node._userText;
                node.isEditing = false;
            }
        }
    },

    setCustomWidgets(app) {
    }
});
