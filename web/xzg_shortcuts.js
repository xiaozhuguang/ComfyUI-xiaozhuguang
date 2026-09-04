import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

/**
 * 小珠光自定义快捷键
 * - 配置持久化在后端插件目录 xzg_shortcuts.json，跟插件绑定，所有浏览器共享
 * - 支持为"执行工作流"等动作绑定额外快捷键（如 Ctrl+D）
 * - 不覆盖 ComfyUI 原生 Ctrl+Enter，仅追加
 */

const SHORTCUTS_API = "/xzg/shortcuts";

/** 获取鼠标在画布上的坐标（优先用 LiteGraph 内部维护的 graph_mouse，兜底自行转换） */
function getCanvasMouse() {
    const c = app?.canvas;
    if (c?.graph_mouse && Array.isArray(c.graph_mouse)) {
        return { x: c.graph_mouse[0], y: c.graph_mouse[1] };
    }
    // 兜底：自行转换
    if (!c) return { x: 0, y: 0 };
    const rect = c.canvas?.getBoundingClientRect?.() || { left: 0, top: 0 };
    const ox = c.canvasX ?? c._offset_x ?? 0;
    const oy = c.canvasY ?? c._offset_y ?? 0;
    const scale = c.ds?.scale ?? c.zoom ?? 1;
    return {
        x: (_lastMouseX - rect.left - ox) / scale,
        y: (_lastMouseY - rect.top - oy) / scale,
    };
}

// 跟踪最后鼠标屏幕坐标（兜底用）
let _lastMouseX = 0, _lastMouseY = 0;
document.addEventListener("mousemove", (e) => { _lastMouseX = e.clientX; _lastMouseY = e.clientY; }, true);

/** 执行指定节点列表及其上游依赖（hook 方式，保证种子随机化等 app.queuePrompt 内部逻辑正常执行） */
async function executeNodes(nodes) {
    if (!nodes || !nodes.length) return false;
    const nodeIds = new Set(nodes.filter(n => n.mode !== 4).map(n => String(n.id)));
    if (!nodeIds.size) return false;

    const origApiQueuePrompt = api.queuePrompt;
    let hookInstalled = false;

    const hook = async function (index, prompt, ...args) {
        if (prompt.output) {
            const oldOutput = prompt.output;
            const newOutput = {};
            const visited = new Set();

            function collectValue(val) {
                if (!Array.isArray(val)) return;
                // 尝试作为连接 [sourceNodeId, slotIndex] 处理
                if (val.length >= 1) {
                    const sourceId = String(val[0]);
                    if (oldOutput[sourceId]) {
                        addNode(sourceId);
                        return;
                    }
                }
                // 嵌套数组（如图像列表），递归每个元素
                for (const item of val) collectValue(item);
            }

            function addNode(nodeId) {
                const id = String(nodeId);
                if (visited.has(id)) return;
                const def = oldOutput[id];
                if (!def) return;
                visited.add(id);
                newOutput[id] = def;
                const inputs = def.inputs || {};
                for (const key of Object.keys(inputs)) {
                    collectValue(inputs[key]);
                }
            }

            for (const id of nodeIds) addNode(id);
            prompt.output = newOutput;
        }
        api.queuePrompt = origApiQueuePrompt;
        return origApiQueuePrompt.call(api, index, prompt, ...args);
    };

    try {
        api.queuePrompt = hook;
        hookInstalled = true;
        await app.queuePrompt(0);
        return true;
    } catch (e) {
        console.error("[小珠光快捷键] 执行节点失败:", e);
        return false;
    } finally {
        if (hookInstalled) {
            api.queuePrompt = origApiQueuePrompt;
        }
    }
}

/** 获取鼠标所在的 ComfyUI 原生编组（LGraphGroup） */
function getNativeGroupAtMouse() {
    const groups = app?.graph?._groups;
    if (!groups?.length) return null;
    const { x, y } = getCanvasMouse();
    // 从后往前遍历（后绘制的在上层）
    for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        const gx = g.pos?.[0] ?? g.x ?? 0;
        const gy = g.pos?.[1] ?? g.y ?? 0;
        const gw = g.size?.[0] ?? g.w ?? 0;
        const gh = g.size?.[1] ?? g.h ?? 0;
        if (x >= gx && x <= gx + gw && y >= gy && y <= gy + gh) {
            return g;
        }
    }
    return null;
}

/** 获取原生编组内的节点（节点中心点在编组范围内） */
function getNativeGroupNodes(group) {
    const nodes = app?.graph?._nodes;
    if (!nodes?.length || !group) return [];
    const gx = group.pos?.[0] ?? group.x ?? 0;
    const gy = group.pos?.[1] ?? group.y ?? 0;
    const gw = group.size?.[0] ?? group.w ?? 0;
    const gh = group.size?.[1] ?? group.h ?? 0;
    return nodes.filter(n => {
        const nx = n.pos?.[0] ?? n.x ?? 0;
        const ny = n.pos?.[1] ?? n.y ?? 0;
        const nw = n.size?.[0] ?? 0;
        const nh = n.size?.[1] ?? 0;
        const cx = nx + nw / 2, cy = ny + nh / 2;
        return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
    });
}

// 动作映射：action id -> 执行函数
/** 执行官方命令（封装 extensionManager.command.execute，失败时告警） */
function executeCommand(commandId) {
    try {
        if (app.extensionManager?.command?.execute) {
            app.extensionManager.command.execute(commandId);
        }
    } catch (e) {
        console.warn(`[小珠光快捷键] 执行命令 ${commandId} 失败:`, e);
    }
}

const ACTION_HANDLERS = {
    queue_prompt: () => {
        try {
            if (typeof app.queuePrompt === "function") {
                app.queuePrompt();
            } else if (app.extensionManager?.command?.execute) {
                app.extensionManager.command.execute("Comfy.QueuePrompt");
            }
        } catch (e) {
            console.warn("[小珠光快捷键] 执行失败:", e);
        }
    },

    /** 只执行选中的节点及其上游依赖（无选中时回退为执行整个工作流） */
    queue_selected: async () => {
        try {
            const graph = app.graph;
            if (!graph?._nodes) { app.queuePrompt?.(); return; }
            const selected = graph._nodes.filter(n => n.selected && n.mode !== 4);
            if (selected.length === 0) { app.queuePrompt?.(); return; }
            const ok = await executeNodes(selected);
            if (!ok) app.queuePrompt?.();
        } catch (e) {
            console.warn("[小珠光快捷键] 执行选中节点失败:", e);
            app.queuePrompt?.();
        }
    },

    /** 执行鼠标所在编组节点（优先小珠光编组，其次 ComfyUI 原生编组） */
    queue_group_at_mouse: async () => {
        try {
            // 1. 小珠光编组
            const grp = window.XZGGroup;
            if (grp && typeof grp.getGroupAtMouse === "function") {
                const gid = grp.getGroupAtMouse();
                if (gid) {
                    if (typeof grp.queueGroupOutputNodes === "function") {
                        await grp.queueGroupOutputNodes(gid);
                    } else if (typeof grp.getGroupNodes === "function") {
                        const nodes = grp.getGroupNodes(gid);
                        await executeNodes(nodes);
                    }
                    return;
                }
            }
            // 2. ComfyUI 原生编组
            const nativeGroup = getNativeGroupAtMouse();
            if (nativeGroup) {
                const nodes = getNativeGroupNodes(nativeGroup);
                if (nodes.length) {
                    await executeNodes(nodes);
                }
            }
        } catch (e) {
            console.warn("[小珠光快捷键] 执行编组节点失败:", e);
        }
    },

    /** 官方中断（Comfy.Interrupt 命令，等价于菜单栏"中断"按钮） */
    interrupt: () => {
        try {
            if (app.extensionManager?.command?.execute) {
                app.extensionManager.command.execute("Comfy.Interrupt");
            } else if (typeof api?.interrupt === "function") {
                api.interrupt();
            }
        } catch (e) {
            console.warn("[小珠光快捷键] 中断执行失败:", e);
        }
    },

    /** 清除待处理任务（Comfy.ClearPendingTasks 命令，等价于队列面板"清空队列"） */
    clear_pending_tasks: () => {
        try {
            if (app.extensionManager?.command?.execute) {
                app.extensionManager.command.execute("Comfy.ClearPendingTasks");
            }
        } catch (e) {
            console.warn("[小珠光快捷键] 清除待处理任务失败:", e);
        }
    },

    /** 将选区转换为子图（Comfy.Graph.ConvertToSubgraph） */
    convert_to_subgraph: () => executeCommand("Comfy.Graph.ConvertToSubgraph"),

    /** 忽略/取消忽略选中节点（Comfy.Canvas.ToggleSelectedNodes.Bypass） */
    bypass_selected: () => executeCommand("Comfy.Canvas.ToggleSelectedNodes.Bypass"),

    /** 调整选中节点大小（Comfy.Canvas.Resize） */
    resize_selected_nodes: () => executeCommand("Comfy.Canvas.Resize"),

    /** 折叠/展开选中节点（Comfy.Canvas.ToggleSelectedNodes.Collapse） */
    collapse_selected: () => executeCommand("Comfy.Canvas.ToggleSelectedNodes.Collapse"),

    /** 打开选中节点的遮罩编辑器（Comfy.MaskEditor.OpenMaskEditor） */
    open_mask_editor: () => executeCommand("Comfy.MaskEditor.OpenMaskEditor"),
};


const ACTION_LABELS = {
    queue_prompt: "执行工作流 (Queue Prompt)",
    queue_selected: "执行选中节点 (Queue Selected)",
    queue_group_at_mouse: "执行鼠标所在编组节点 (Queue Group)",
    interrupt: "中断 (Interrupt)",
    clear_pending_tasks: "清除待处理任务 (Clear Pending Tasks)",
    convert_to_subgraph: "选区转换为子图 (Convert to Subgraph)",
    bypass_selected: "忽略/取消忽略选中节点 (Bypass Selected)",
    resize_selected_nodes: "调整选中节点大小 (Resize Selected Nodes)",
    collapse_selected: "折叠/展开选中节点 (Collapse Selected)",
    open_mask_editor: "打开选中节点遮罩编辑器 (Open Mask Editor)",
};

// 快捷键配置（运行时）
let shortcuts = [];
let initialized = false;

/** 将快捷键对象序列化为显示文本，如 "Ctrl+D" */
function shortcutToText(s) {
    const parts = [];
    if (s.ctrl) parts.push("Ctrl");
    if (s.shift) parts.push("Shift");
    if (s.alt) parts.push("Alt");
    if (s.meta) parts.push("Meta");
    parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
    return parts.join("+");
}

/** 从 KeyboardEvent 构建快捷键对象 */
function eventToShortcut(e) {
    let key = e.key;
    // 忽略纯修饰键
    if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
    // 规范化：字母大写，特殊键保留原名
    if (key.length === 1) key = key.toUpperCase();
    return {
        key,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
    };
}

/** 判断 KeyboardEvent 是否匹配某条快捷键 */
function matchShortcut(e, s) {
    if (!s.key) return false;
    let key = e.key;
    if (key.length === 1) key = key.toUpperCase();
    return (
        key === s.key &&
        !!e.ctrlKey === !!s.ctrl &&
        !!e.shiftKey === !!s.shift &&
        !!e.altKey === !!s.alt &&
        !!e.metaKey === !!s.meta
    );
}

/** 从后端加载快捷键（返回后端实际配置，失败时返回 null 而不是清空） */
async function loadShortcuts() {
    try {
        // no-store：避免 GET 被浏览器缓存，确保总是读到后端最新配置
        const res = await api.fetchApi(SHORTCUTS_API, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = Array.isArray(data.shortcuts) ? data.shortcuts : [];
        shortcuts = list;
        return list;
    } catch (e) {
        console.warn("[小珠光快捷键] 加载失败:", e);
        return null;
    }
}

/** 保存快捷键到后端 */
async function saveShortcuts(list) {
    const res = await api.fetchApi(SHORTCUTS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortcuts: list }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    shortcuts = list;
}

/** 全局 keydown 监听（capture 阶段，优先于输入框判断） */
function onKeyDown(e) {
    if (!shortcuts.length) return;
    // 快捷键设置对话框打开时，把键盘完全交给对话框的捕获逻辑（onCaptureKey），
    // 避免这里抢先处理导致"无法捕获 / 添加快捷键"。
    if (document.getElementById("xzg-shortcuts-dialog")) return;
    // 输入框 / 文本域 / 可编辑元素内：不触发动作，避免干扰打字。
    // 注意：裸键（如 D、F，无任何修饰键）必须完全放行，不能 preventDefault，
    // 否则会把字符输入也拦截掉，导致输入框里打不出 D / F。
    // 输入法（IME）组合中：完全放行，避免拦截拼音输入与候选词选择。
    if (e.isComposing) return;
    // 输入区判定：input / textarea / select / contenteditable / ComfyUI 属性值(.property_value)，
    // 通过 closest 向上覆盖输入元素内部的子节点（PrimeVue 等封装组件），
    // contenteditable 祖先需处于真正可编辑状态（排除 contenteditable="false"）。
    const t = e.target;
    let inField = false;
    if (t) {
        const ce = t.closest("[contenteditable]");
        inField = !!(
            t.closest("input, textarea, select, .property_value") ||
            t.isContentEditable ||
            (ce && ce.isContentEditable)
        );
    }

    for (const s of shortcuts) {
        if (!matchShortcut(e, s)) continue;
        const handler = ACTION_HANDLERS[s.action];
        if (!handler) continue;
        // 输入框内：
        // - 裸键（无修饰键）：完全放行，交给输入框正常输入字符；
        // - 带修饰键的组合（如 Ctrl+D）：仍阻止浏览器默认行为（如收藏当前页），但不触发动作。
        if (inField) {
            if (!s.ctrl && !s.shift && !s.alt && !s.meta) continue;
            e.preventDefault();
            return;
        }
        // 画布 / 非输入区域：匹配到快捷键，阻止默认行为并触发动作
        e.preventDefault();
        e.stopImmediatePropagation();
        handler();
        return;
    }
}

/** 创建设置对话框（打开时总是从后端重新拉取真实配置，避免使用启动时缓存的空/旧列表） */
async function openSettingsDialog() {
    const existing = document.getElementById("xzg-shortcuts-dialog");
    if (existing) { existing.remove(); }

    // 打开对话框前强制刷新一次后端配置，拿到权威数据再构建编辑列表。
    // 若后端拉取失败则回退到内存缓存；无论何种情况都不允许在"没读到真实配置"时清空后端文件。
    const fresh = await loadShortcuts();
    const base = (fresh !== null) ? fresh : shortcuts;

    const overlay = document.createElement("div");
    overlay.id = "xzg-shortcuts-dialog";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;";

    const dialog = document.createElement("div");
    dialog.style.cssText = "background:#2a2a2a;color:#e0e0e0;border-radius:10px;padding:24px;width:560px;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);border:1px solid #444;";

    // 编辑中的列表（副本）
    let editing = base.map(s => ({ ...s }));

    function render() {
        const rowsHtml = editing.map((s, i) => `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px;background:#333;border-radius:6px;">
                <span style="flex:1;font-size:14px;">${ACTION_LABELS[s.action] || s.action}</span>
                <span style="background:#1a1a1a;padding:4px 10px;border-radius:4px;font-family:monospace;font-size:13px;min-width:80px;text-align:center;">${shortcutToText(s)}</span>
                <button data-act="del" data-idx="${i}" style="background:#c0392b;color:#fff;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;">删除</button>
            </div>
        `).join("");

        dialog.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;font-size:18px;">小珠光 · 自定义快捷键</h3>
                <button id="xzg-sc-close" style="background:transparent;color:#999;border:none;font-size:20px;cursor:pointer;">&times;</button>
            </div>
            <p style="font-size:12px;color:#999;margin:0 0 16px;">配置保存在服务器端（插件目录），所有浏览器共享。原生 Ctrl+Enter 不受影响，以下为追加快捷键。</p>
            <div id="xzg-sc-list">${rowsHtml || '<p style="color:#888;font-size:13px;text-align:center;padding:16px;">暂无自定义快捷键</p>'}</div>
            <div style="margin-top:16px;padding-top:16px;border-top:1px solid #444;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                    <select id="xzg-sc-action" style="background:#1a1a1a;color:#e0e0e0;border:1px solid #555;border-radius:4px;padding:6px;font-size:13px;">
                        ${Object.entries(ACTION_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
                    </select>
                    <button id="xzg-sc-capture" style="background:#2980b9;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:13px;">按下快捷键...</button>
                    <button id="xzg-sc-add" style="background:#27ae60;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:13px;" disabled>添加</button>
                </div>
                <p id="xzg-sc-hint" style="font-size:12px;color:#888;margin:0;">点击"按下快捷键..."然后按组合键</p>
            </div>
            <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px;">
                <button id="xzg-sc-cancel" style="background:#555;color:#fff;border:none;border-radius:4px;padding:8px 20px;cursor:pointer;font-size:13px;">取消</button>
                <button id="xzg-sc-save" style="background:#2980b9;color:#fff;border:none;border-radius:4px;padding:8px 20px;cursor:pointer;font-size:13px;">保存</button>
            </div>
        `;

        // 事件绑定
        dialog.querySelector("#xzg-sc-close").onclick = () => overlay.remove();
        dialog.querySelector("#xzg-sc-cancel").onclick = () => overlay.remove();
        overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

        // 删除
        dialog.querySelectorAll("[data-act=del]").forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx);
                editing.splice(idx, 1);
                render();
            };
        });

        // 捕获快捷键
        let captured = null;
        const captureBtn = dialog.querySelector("#xzg-sc-capture");
        const addBtn = dialog.querySelector("#xzg-sc-add");
        const hint = dialog.querySelector("#xzg-sc-hint");

        function onCaptureKey(e) {
            e.preventDefault();
            e.stopPropagation();
            const sc = eventToShortcut(e);
            if (!sc) return;
            captured = sc;
            captureBtn.textContent = shortcutToText(sc);
            captureBtn.style.background = "#27ae60";
            addBtn.disabled = false;
            hint.textContent = "已捕获，点击添加";
            dialog.removeEventListener("keydown", onCaptureKey, true);
        }

        captureBtn.onclick = () => {
            captured = null;
            captureBtn.textContent = "请按快捷键...";
            captureBtn.style.background = "#e67e22";
            addBtn.disabled = true;
            hint.textContent = "现在按下组合键（如 Ctrl+D）";
            dialog.addEventListener("keydown", onCaptureKey, true);
        };

        addBtn.onclick = () => {
            if (!captured) return;
            const action = dialog.querySelector("#xzg-sc-action").value;
            // 检查重复
            const dup = editing.findIndex(s => matchShortcut(
                { key: captured.key, ctrlKey: captured.ctrl, shiftKey: captured.shift, altKey: captured.alt, metaKey: captured.meta },
                s
            ));
            if (dup >= 0) {
                hint.textContent = "该快捷键已存在，请勿重复添加";
                hint.style.color = "#e74c3c";
                return;
            }
            editing.push({ ...captured, action, label: shortcutToText(captured) });
            captured = null;
            captureBtn.textContent = "按下快捷键...";
            captureBtn.style.background = "#2980b9";
            addBtn.disabled = true;
            hint.textContent = "点击\"按下快捷键...\"然后按组合键";
            hint.style.color = "#888";
            render();
        };

        // 保存
        dialog.querySelector("#xzg-sc-save").onclick = async () => {
            // 安全护栏：本次刷新后端失败 且 列表为空时，禁止保存，避免把真实配置误清空。
            if (editing.length === 0 && fresh === null) {
                alert("无法连接到服务器读取当前快捷键配置，为防止数据丢失已取消保存，请稍后重试。");
                return;
            }
            try {
                await saveShortcuts(editing);
                overlay.remove();
            } catch (e) {
                alert("保存失败: " + e.message);
            }
        };
    }

    render();
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
}

/** 在设置面板的 xiaozhuguang 区域注入"自定义快捷键"按钮 */
let _settingsObserver = null;

function injectSettingsButton() {
    // 已注入则跳过
    if (document.getElementById("xzg-shortcuts-setting-btn")) return;
    // 找到最后一个 xiaozhuguang 设置项，在其后插入按钮
    const xzgItems = document.querySelectorAll('[data-setting-id^="xiaozhuguang."]');
    if (xzgItems.length === 0) return;
    const lastItem = xzgItems[xzgItems.length - 1];
    // —— 「其他」分组：分隔线 + 纯文字标题（对齐 EasyUse 排版）——
    const anchorEl = lastItem.nextSibling;
    if (!document.getElementById("xzg-settings-heading-other")) {
        const divider = document.createElement("div");
        divider.className = "my-8 border-t border-border-default";
        divider.id = "xzg-settings-heading-other-divider";
        const head = document.createElement("h3");
        head.className = "text-base";
        head.id = "xzg-settings-heading-other";
        head.textContent = "其他";
        lastItem.parentNode.insertBefore(divider, anchorEl);
        lastItem.parentNode.insertBefore(head, anchorEl);
    }
    const wrapper = document.createElement("div");
    wrapper.className = "setting-item mb-3";
    wrapper.id = "xzg-shortcuts-setting-btn";
    wrapper.innerHTML = `
        <div class="flex min-h-8 flex-row items-center gap-2">
            <div class="form-label flex grow items-center">
                <span class="text-sm text-muted">[小珠光] 自定义快捷键</span>
            </div>
            <div class="form-input flex justify-end">
                <button type="button" class="relative inline-flex items-center justify-center gap-2 cursor-pointer rounded-lg px-4 py-2 text-sm font-medium"
                    style="background:#2980b9;color:#fff;border:none;">配置快捷键</button>
            </div>
        </div>
    `;
    wrapper.querySelector("button").onclick = () => openSettingsDialog();
    lastItem.parentNode.insertBefore(wrapper, anchorEl);
}

function startSettingsObserver() {
    if (_settingsObserver) return;
    _settingsObserver = new MutationObserver(() => {
        // 设置面板打开时尝试注入按钮
        if (document.querySelector('[data-setting-id^="xiaozhuguang."]')) {
            injectSettingsButton();
        }
    });
    _settingsObserver.observe(document.body, { childList: true, subtree: true });
    // 初始也尝试一次
    injectSettingsButton();
}

/** 初始化 */
async function init() {
    if (initialized) return;
    initialized = true;
    await loadShortcuts();
    window.addEventListener("keydown", onKeyDown, true);
    startSettingsObserver();
    console.log(`[小珠光快捷键] 已加载 ${shortcuts.length} 条自定义快捷键`);
}

// ComfyUI 扩展注册
app.registerExtension({
    name: "xiaozhuguang.shortcuts",
    async setup() {
        await init();
    },
});

// 暴露给控制台调试
window.xzgShortcuts = {
    load: loadShortcuts,
    save: saveShortcuts,
    list: () => shortcuts,
    open: openSettingsDialog,
};
