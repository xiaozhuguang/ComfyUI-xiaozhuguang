import { app } from "../../scripts/app.js";
import { xzgT } from "./xzg_i18n.js";


const STORAGE_KEY = "xzg_quick_nodes";
const CONFIG_KEY = "xzg_quick_nodes_config";
const MAX_QUICK_NODES = 20;

class XZGQuickNodes {
    constructor() {
        this.quickNodes = this.loadQuickNodes();
        this.config = this.loadConfig();
        this.initialized = false;
        this.originalShowSearchBox = null;
        this.originalShowConnectionMenu = null;
    }

    loadConfig() {
        try {
            const data = localStorage.getItem(CONFIG_KEY);
            if (data) {
                return JSON.parse(data);
            }
        } catch (e) {
            console.warn("[小珠光] 加载快速节点配置失败:", e);
        }
        return {
            hideDefaultMenu: false,
            textColor: "#FFD700"
        };
    }

    saveConfig() {
        try {
            localStorage.setItem(CONFIG_KEY, JSON.stringify(this.config));
        } catch (e) {
            console.warn("[小珠光] 保存快速节点配置失败:", e);
        }
    }

    setHideDefaultMenu(value) {
        this.config.hideDefaultMenu = !!value;
        this.saveConfig();
    }

    isHideDefaultMenu() {
        return !!this.config.hideDefaultMenu;
    }

    setTextColor(color) {
        this.config.textColor = color;
        this.saveConfig();
    }

    getTextColor() {
        return this.config.textColor || "#FFD700";
    }

    loadQuickNodes() {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            if (data) {
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) {
                    return parsed.filter(n => n && n.type);
                }
            }
        } catch (e) {
            console.warn("[小珠光] 加载快速节点失败:", e);
        }
        return [];
    }

    saveQuickNodes() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.quickNodes));
        } catch (e) {
            console.warn("[小珠光] 保存快速节点失败:", e);
        }
    }

    isQuickNode(nodeType) {
        return this.quickNodes.some(n => n.type === nodeType);
    }

    addQuickNode(nodeType, nodeTitle) {
        if (this.isQuickNode(nodeType)) return false;
        if (this.quickNodes.length >= MAX_QUICK_NODES) return false;
        
        const title = nodeTitle || LiteGraph.registered_node_types[nodeType]?.title || nodeType;
        this.quickNodes.push({
            type: nodeType,
            title: title,
            order: Date.now()
        });
        this.saveQuickNodes();
        return true;
    }

    removeQuickNode(nodeType) {
        const idx = this.quickNodes.findIndex(n => n.type === nodeType);
        if (idx === -1) return false;
        this.quickNodes.splice(idx, 1);
        this.saveQuickNodes();
        return true;
    }

    moveQuickNode(fromIndex, toIndex) {
        if (fromIndex < 0 || fromIndex >= this.quickNodes.length) return;
        if (toIndex < 0 || toIndex >= this.quickNodes.length) return;
        const [item] = this.quickNodes.splice(fromIndex, 1);
        this.quickNodes.splice(toIndex, 0, item);
        this.quickNodes.forEach((n, i) => n.order = i);
        this.saveQuickNodes();
    }

    _connectNodes(sourceNode, sourceSlotIdx, isOutput, targetNode, slotType) {
        const typeMatches = (a, b) => {
            if (a === b) return true;
            const aStr = String(a);
            const bStr = String(b);
            if (aStr === bStr) return true;
            const wildcards = ["*", "", "0"];
            if (wildcards.includes(aStr) || wildcards.includes(bStr)) return true;
            return false;
        };

        const findSlot = (node, findInput, type) => {
            const slots = findInput ? node.inputs : node.outputs;
            if (!slots) return -1;
            for (let i = 0; i < slots.length; i++) {
                const slot = slots[i];
                const isLinked = findInput ? slot.link != null : (slot.links && slot.links.length > 0);
                if (!isLinked && typeMatches(slot.type, type)) {
                    return i;
                }
            }
            return -1;
        };

        if (isOutput) {
            const targetInputIdx = findSlot(targetNode, true, slotType);
            if (targetInputIdx !== -1) {
                sourceNode.connect(sourceSlotIdx, targetNode, targetInputIdx);
                return true;
            }
        } else {
            const targetOutputIdx = findSlot(targetNode, false, slotType);
            if (targetOutputIdx !== -1) {
                targetNode.connect(targetOutputIdx, sourceNode, sourceSlotIdx);
                return true;
            }
        }
        return false;
    }

    _getSourceSlotIndex(sourceNode, slot, isOutput) {
        if (slot == null) return -1;
        if (typeof slot === 'number') return slot;
        if (typeof slot === 'string') {
            return isOutput 
                ? sourceNode.findOutputSlot(slot) 
                : sourceNode.findInputSlot(slot);
        }
        if (typeof slot === 'object') {
            if (slot.slot_index !== undefined) return slot.slot_index;
            if (slot.name) {
                return isOutput 
                    ? sourceNode.findOutputSlot(slot.name) 
                    : sourceNode.findInputSlot(slot.name);
            }
        }
        return -1;
    }

    getQuickNodeList() {
        return [...this.quickNodes].sort((a, b) => (a.order || 0) - (b.order || 0));
    }

    init() {
        if (this.initialized) return;
        this.initialized = true;

        this.waitForCanvasReady().then(() => {
            this.interceptShowSearchBox();
            this.extendNodeMenu();
            setTimeout(() => {
                this.interceptShowConnectionMenu();
            }, 1000);
        });
    }

    waitForCanvasReady() {
        return new Promise((resolve) => {
            const check = () => {
                if (app?.canvas?.showSearchBox) {
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }

    interceptShowSearchBox() {
        const canvas = app.canvas;
        this.originalShowSearchBox = canvas.showSearchBox.bind(canvas);

        const self = this;
        canvas.showSearchBox = function(e, t) {
            const result = self.originalShowSearchBox(e, t);
            
            const searchBox = canvas.search_box;
            if (!searchBox) return result;

            const input = searchBox.querySelector("input");
            const helper = searchBox.querySelector(".helper");
            if (!input || !helper) return result;

            const showQuickNodes = () => {
                if (input.value.trim() !== "") return;
                
                const quickNodes = self.getQuickNodeList();
                if (quickNodes.length === 0) return;

                const existingSection = helper.querySelector(".xzg-quick-nodes-section");
                if (existingSection) existingSection.remove();

                const section = document.createElement("div");
                section.className = "xzg-quick-nodes-section";
                
                const header = document.createElement("div");
                header.className = "xzg-quick-nodes-header";
                header.textContent = xzgT('快速节点','Quick Nodes');
                section.appendChild(header);

                const list = document.createElement("div");
                list.className = "xzg-quick-nodes-list";
                
                quickNodes.forEach(node => {
                    const item = document.createElement("div");
                    item.className = "litegraph lite-search-item xzg-quick-node-item";
                    item.dataset.type = escape(node.type);
                    
                    const titleSpan = document.createElement("span");
                    titleSpan.className = "xzg-quick-node-title";
                    titleSpan.textContent = node.title;
                    item.appendChild(titleSpan);

                    const typeSpan = document.createElement("span");
                    typeSpan.className = "litegraph lite-search-item-type";
                    typeSpan.textContent = node.type;
                    item.appendChild(typeSpan);

                    item.addEventListener("click", function() {
                        const type = unescape(String(this.dataset.type));
                        if (canvas.onSearchBoxSelection) {
                            canvas.onSearchBoxSelection(type, e, LGraphCanvas.active_canvas);
                        } else {
                            const graph = LGraphCanvas.active_canvas.graph;
                            if (graph) {
                                graph.beforeChange();
                                const newNode = LiteGraph.createNode(type);
                                if (newNode) {
                                    newNode.pos = LGraphCanvas.active_canvas.convertEventToCanvasOffset(e);
                                    graph.add(newNode, false);
                                    
                                    if (t?.node_from && t?.slot_from !== undefined) {
                                        let slotIndex = -1;
                                        if (typeof t.slot_from === "number") {
                                            slotIndex = t.slot_from;
                                        } else if (typeof t.slot_from === "string") {
                                            slotIndex = t.node_from.findOutputSlot(t.slot_from);
                                        } else if (t.slot_from?.slot_index !== undefined) {
                                            slotIndex = t.slot_from.slot_index;
                                        }
                                        if (slotIndex !== -1 && t.node_from.outputs[slotIndex]) {
                                            t.node_from.connectByType(slotIndex, newNode, t.node_from.outputs[slotIndex].type);
                                        }
                                    }
                                    
                                    if (t?.node_to && t?.slot_from !== undefined) {
                                        let slotIndex = -1;
                                        if (typeof t.slot_from === "number") {
                                            slotIndex = t.slot_from;
                                        } else if (typeof t.slot_from === "string") {
                                            slotIndex = t.node_to.findInputSlot(t.slot_from);
                                        } else if (t.slot_from?.slot_index !== undefined) {
                                            slotIndex = t.slot_from.slot_index;
                                        }
                                        if (slotIndex !== -1 && t.node_to.inputs[slotIndex]) {
                                            t.node_to.connectByTypeOutput(slotIndex, newNode, t.node_to.inputs[slotIndex].type);
                                        }
                                    }
                                    
                                    graph.afterChange();
                                }
                            }
                        }
                        searchBox.close();
                    });

                    list.appendChild(item);
                });

                section.appendChild(list);
                helper.insertBefore(section, helper.firstChild);
            };

            const originalInput = input.oninput;
            input.addEventListener("input", () => {
                setTimeout(() => {
                    if (input.value.trim() === "") {
                        showQuickNodes();
                    } else {
                        const section = helper.querySelector(".xzg-quick-nodes-section");
                        if (section) section.remove();
                    }
                }, 50);
            });

            setTimeout(showQuickNodes, 100);

            return result;
        };
    }

    interceptShowConnectionMenu() {
        const self = this;
        const canvas = app.canvas;
        const origShowConnectionMenu = canvas.showConnectionMenu.bind(canvas);

        canvas.showConnectionMenu = function(optPass) {
            const quickNodes = self.getQuickNodeList();
            if (quickNodes.length === 0) {
                return origShowConnectionMenu.call(this, optPass);
            }

            const OrigCM = LiteGraph.ContextMenu;
            let menu = null;

            const NewCM = function(options, menuOpts) {
                LiteGraph.ContextMenu = OrigCM;

                const isConnectionMenu = Array.isArray(options) && 
                    options.includes("Add Node") && 
                    options.includes("Add Reroute");

                if (!isConnectionMenu) {
                    return new OrigCM(options, menuOpts);
                }

                const quickNodeLabels = quickNodes.map(n => n.title);
                let newOptions;
                if (self.isHideDefaultMenu()) {
                    newOptions = [...quickNodeLabels];
                } else {
                    newOptions = [...options, null, ...quickNodeLabels];
                }

                const origCb = menuOpts.callback;
                menuOpts.callback = function(v, cbOpts, e) {
                    const quickNode = quickNodes.find(n => n.title === v);
                    if (quickNode) {
                        const graph = canvas.graph || app.graph;
                        if (!graph) return;

                        const node = LiteGraph.createNode(quickNode.type);
                        if (!node) return;

                        const ev = optPass?.e || menuOpts?.event;
                        const pos = [ev?.canvasX ?? 400, ev?.canvasY ?? 300];
                        node.pos = [pos[0] - node.size[0] / 2, pos[1] - 10];
                        graph.add(node);

                        const isFrom = !!(optPass?.nodeFrom && optPass?.slotFrom != null);
                        const sourceNode = isFrom ? optPass.nodeFrom : optPass.nodeTo;
                        const sourceSlot = isFrom ? optPass.slotFrom : optPass.slotTo;

                        if (sourceNode && sourceSlot != null) {
                            const sourceSlotIdx = self._getSourceSlotIndex(sourceNode, sourceSlot, isFrom);
                            if (sourceSlotIdx !== -1) {
                                const slotType = isFrom 
                                    ? sourceNode.outputs[sourceSlotIdx]?.type 
                                    : sourceNode.inputs[sourceSlotIdx]?.type;
                                
                                if (slotType != null) {
                                    self._connectNodes(sourceNode, sourceSlotIdx, isFrom, node, slotType);
                                }
                            }
                        }

                        graph.change();
                        canvas.setDirty(true, true);
                        if (menu?.close) menu.close();
                        return;
                    }
                    return origCb?.call(this, v, cbOpts, e);
                };

                menu = new OrigCM(newOptions, menuOpts);

                if (menu?.root) {
                    const entries = menu.root.querySelectorAll('.litemenu-entry');
                    const quickTitles = quickNodes.map(n => n.title);
                    const textColor = self.getTextColor();
                    entries.forEach(entry => {
                        const text = entry.textContent?.trim();
                        if (quickTitles.includes(text)) {
                            entry.style.color = textColor;
                        }
                    });
                }

                return menu;
            };
            NewCM.prototype = OrigCM.prototype;
            LiteGraph.ContextMenu = NewCM;

            const result = origShowConnectionMenu.call(this, optPass);

            LiteGraph.ContextMenu = OrigCM;
            return result;
        };
    }

    extendNodeMenu() {
        const self = this;
        const origGetNodeMenuOptions = app.canvas.getNodeMenuOptions;
        
        app.canvas.getNodeMenuOptions = function(node, options, e) {
            const menuOptions = origGetNodeMenuOptions.call(this, node, options, e);
            
            if (!menuOptions) return menuOptions;
            
            const nodeType = node.type;
            const isQuick = self.isQuickNode(nodeType);
            
            const quickNodeOption = {
                content: isQuick ? '<span style="color:#FFD700;">⭐ ' + xzgT('从快速节点移除','Remove from Quick Nodes') + '</span>' : '<span style="color:#FFD700;">☆ ' + xzgT('添加到快速节点','Add to Quick Nodes') + '</span>',
                callback: () => {
                    if (isQuick) {
                        self.removeQuickNode(nodeType);
                    } else {
                        self.addQuickNode(nodeType, node.title || node.type);
                    }
                    if (window.XZGThemePanel?.refreshQuickNodesTab) {
                        window.XZGThemePanel.refreshQuickNodesTab();
                    }
                }
            };
            
            const separator = { content: null };
            
            let insertIndex = menuOptions.length;
            for (let i = 0; i < menuOptions.length; i++) {
                const opt = menuOptions[i];
                if (opt && opt.content && typeof opt.content === 'string' && opt.content.indexOf('小珠光主题') !== -1) {
                    insertIndex = i;
                    break;
                }
            }
            menuOptions.splice(insertIndex, 0, separator, quickNodeOption);
            
            return menuOptions;
        };
    }
}

const xzgQuickNodes = new XZGQuickNodes();
window.XZGQuickNodes = xzgQuickNodes;

app.registerExtension({
    name: "xiaozhuguang.quicknodes",
    setup() {
        xzgQuickNodes.init();
    }
});
