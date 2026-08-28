// ═══════════════════════════════════════════════
//  小珠光视角锁定 V4 · 顶部菜单栏集成
//  记录/恢复画布缩放与坐标，5个槽位
//  存储方案：graph.extra（随工作流持久化）+ localStorage 备份
// ═══════════════════════════════════════════════
// 版本: V4.0 (graph.extra + localStorage backup)

import { app } from "../../scripts/app.js";

console.log("[小珠光] xzg_viewport_lock.js V4.0 加载...");

const STORAGE_KEY = "xzg_viewport_lock_slots_v4";
const POS_KEY = "xzg_viewport_lock_pos_v4";
const PANEL_ID = "xzg-viewport-lock-btn-v4";
const EXTRA_KEY = "xzg_viewport_slots";  // graph.extra 中的字段名（随工作流持久化）
const CONFIG_KEY = "xzg_viewport_lock_config_v4";
const GOLD = "#dcc85b";
const GRAY = "#999";
const SLOT_COUNT = 5;

// 可选速度倍率（循环切换）
const SPEED_LEVELS = [0.5, 1, 1.5, 2, 3];
// 可选缓动曲线（按顺序：无→线性→In→Out→InOut→Boing）
const EASE_OPTIONS = [
    { key: "none",   label: "None",    fn: t => 1 },
    { key: "linear", label: "Linear",  fn: t => t },
    { key: "in",     label: "In",      fn: t => (t <= 0) ? 0 : Math.pow(2, 10 * t - 10) },
    { key: "out",    label: "Out",     fn: t => (t >= 1) ? 1 : 1 - Math.pow(2, -10 * t) },
    { key: "inout",  label: "InOut",   fn: t => t < 0.5
                                        ? (Math.pow(2, 20 * t - 10)) / 2
                                        : (2 - Math.pow(2, -20 * t + 10)) / 2 },
    { key: "boing",  label: "Boing",   fn: t => 1 },  // Boing 专用：在 animateViewState 内单独处理分量
];

// Boing 弹性专用：位移用 easeOutBack（轻度过冲），scale 用过冲回弹
const EASE_BACK_C1 = 1.70158;
const EASE_BACK_C3 = EASE_BACK_C1 + 1;
function easeOutBack(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const k = t - 1;
    return 1 + EASE_BACK_C3 * k * k * k + EASE_BACK_C1 * k * k;
}
// scale 专用：先过冲到 1+overshoot，再回弹到 1
function easeBoingScale(t, overshoot = 0.10) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // 第一段 (0..0.55) easeOut 冲到 1+overshoot
    // 第二段 (0.55..1) easeOut 回落到 1
    if (t < 0.55) {
        const k = t / 0.55;
        const e = 1 - Math.pow(1 - k, 3);   // easeOutCubic
        return e * (1 + overshoot);
    } else {
        const k = (t - 0.55) / 0.45;
        const e = 1 - Math.pow(1 - k, 4);   // easeOutQuart，更干脆的回落
        return (1 + overshoot) - e * overshoot;
    }
}

// 配置加载/保存
function loadConfig() {
    let cfg = { speed: 1, ease: "inout" };
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
    } catch (e) {}
    // 校验合法值
    if (!SPEED_LEVELS.includes(cfg.speed)) cfg.speed = 1;
    if (!EASE_OPTIONS.some(e => e.key === cfg.ease)) cfg.ease = "inout";
    return cfg;
}
function saveConfig(cfg) {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) {}
}
let vpConfig = loadConfig();
function getEaseFn(key) {
    return (EASE_OPTIONS.find(e => e.key === key) || EASE_OPTIONS[0]).fn;
}

function getCanvas() {
    return app.canvas;
}

function getGraph() {
    return getCanvas()?.graph || app.graph;
}

// ─── 存储层 ───

// 从 graph.extra 读取（随工作流持久化，每个工作流独立）
function loadSlotsFromGraph() {
    const graph = getGraph();
    if (!graph) return null;
    const arr = (graph.extra || {})[EXTRA_KEY];
    if (Array.isArray(arr) && arr.length === SLOT_COUNT) {
        return arr.slice();
    }
    return null;
}

// 保存到 graph.extra
function saveSlotsToGraph(slotsArr) {
    const graph = getGraph();
    if (!graph) return;
    if (!graph.extra) graph.extra = {};
    graph.extra[EXTRA_KEY] = slotsArr.slice();
}

// 加载：仅从 graph.extra（随工作流保存持久化，未保存则不保留）
function loadSlots() {
    return loadSlotsFromGraph() || new Array(SLOT_COUNT).fill(null);
}

// 保存：仅写入 graph.extra
function saveSlots(slotsArr) {
    saveSlotsToGraph(slotsArr);
    console.log("[小珠光] V4 保存: slots=" + JSON.stringify(slotsArr) + " graphExtra=" + JSON.stringify(getGraph()?.extra?.[EXTRA_KEY]));
}

function loadPos() {
    try {
        const raw = localStorage.getItem(POS_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { left: 16, top: 80 };
}

function savePos(pos) {
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (e) {}
}

function getViewState() {
    const canvas = getCanvas();
    if (!canvas || !canvas.ds) return null;
    return {
        scale: canvas.ds.scale,
        x: canvas.ds.offset[0],
        y: canvas.ds.offset[1],
    };
}

function setViewState(state) {
    const canvas = getCanvas();
    if (!canvas || !canvas.ds || !state) return;
    canvas.ds.scale = state.scale;
    canvas.ds.offset[0] = state.x;
    canvas.ds.offset[1] = state.y;
    canvas.setDirty(true, true);
    if (canvas.graph) canvas.graph.setDirtyCanvas(true, true);
}

// 带动画的视角过渡（支持速度倍率 + 多种缓动曲线 + 无动画）
let vpAnimTimer = null;
function animateViewState(target) {
    const canvas = getCanvas();
    if (!canvas || !canvas.ds || !target) return;
    if (vpAnimTimer) cancelAnimationFrame(vpAnimTimer);

    // 无动画模式：直接瞬间设置
    if (vpConfig.ease === "none") {
        canvas.ds.scale = target.scale;
        canvas.ds.offset[0] = target.x;
        canvas.ds.offset[1] = target.y;
        canvas.setDirty(true, true);
        if (canvas.graph) canvas.graph.setDirtyCanvas(true, true);
        return;
    }

    const start = {
        scale: canvas.ds.scale,
        x: canvas.ds.offset[0],
        y: canvas.ds.offset[1],
    };
    // 根据移动距离动态调整基础时长
    const dx = target.x - start.x;
    const dy = target.y - start.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const scaleDiff = Math.abs(target.scale - start.scale);
    const baseDuration = 200;
    const extraForDist = Math.min(180, dist / 8);
    const extraForScale = Math.min(120, scaleDiff * 600);
    // 应用速度倍率：速度越大，时长越短（3x → 时长 / 3）
    const speed = vpConfig.speed || 1;
    const duration = (baseDuration + extraForDist + extraForScale) / speed;

    const t0 = performance.now();

    // 从配置读取缓动曲线（Boing 模式在 frame 内部分量处理）
    const isBoing = vpConfig.ease === "boing";
    const ease = isBoing ? (t => t) : getEaseFn(vpConfig.ease);

    let lastT = -1;
    function frame(now) {
        const t = Math.min(1, (now - t0) / duration);
        if (t === lastT && t < 1) {
            vpAnimTimer = requestAnimationFrame(frame);
            return;
        }
        lastT = t;
        let eScale, eX, eY;
        if (isBoing) {
            // Boing：仅 scale 有弹性（先过冲再回弹）；位移用 InOut 平滑到位，不过冲
            eScale = easeBoingScale(t, 0.12);
            const t2 = t;
            const ePos = t2 < 0.5
                ? (Math.pow(2, 20 * t2 - 10)) / 2
                : (2 - Math.pow(2, -20 * t2 + 10)) / 2;
            eX = ePos;
            eY = ePos;
        } else {
            const e = ease(t);
            eScale = e;
            eX = e;
            eY = e;
        }
        canvas.ds.scale = start.scale + (target.scale - start.scale) * eScale;
        canvas.ds.offset[0] = start.x + (target.x - start.x) * eX;
        canvas.ds.offset[1] = start.y + (target.y - start.y) * eY;
        canvas.setDirty(true, true);
        if (t < 1) {
            vpAnimTimer = requestAnimationFrame(frame);
        } else {
            vpAnimTimer = null;
            if (canvas.graph) canvas.graph.setDirtyCanvas(true, true);
        }
    }
    vpAnimTimer = requestAnimationFrame(frame);
}

// ─── UI ───

// 每个槽位的固定颜色：红、橙、黄、绿、蓝
const SLOT_COLORS = ["#ff5b5b", "#ff9b3d", "#dcc85b", "#5bcc6e", "#5b9bff"];

// 圆圈图标 + 中间文字（数字或"空"）
function circleIcon(color, text, size) {
    const fontSize = Math.round(size * 0.5);
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="display:block;vertical-align:middle;">
        <circle cx="12" cy="12" r="10" fill="none" stroke="${color}" stroke-width="2"/>
        <text x="12" y="12" text-anchor="middle" dominant-baseline="central"
            fill="${color}" font-size="${fontSize}" font-family="Arial,sans-serif"
            font-weight="bold">${text}</text>
    </svg>`;
}

// 主图标（空心圆圈样式）
function targetIcon(color, size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="display:block;vertical-align:middle;">
        <circle cx="12" cy="12" r="10" fill="none" stroke="${color}" stroke-width="2"/>
    </svg>`;
}

let slots = new Array(SLOT_COUNT).fill(null);
let menuBtn = null;
let slotPanel = null;
let slotEls = [];
let toastEl = null;
let lastGraphRef = null;
let lastNodeSig = null;
let expanded = false;
let initialized = false;

function reloadSlotsForCurrentWorkflow() {
    const graph = getGraph();
    if (!graph) return;
    const newSlots = loadSlots();
    console.log("[小珠光] V4 reload: nodes=" + (graph._nodes||[]).length + " slots=" + JSON.stringify(newSlots) + " extraHas=" + !!((graph.extra||{})[EXTRA_KEY]));
    slots = newSlots;
    for (let i = 0; i < SLOT_COUNT; i++) updateSlotVisual(i);
    updateMainIcon();
}

function refreshSlots() {
    if (!initialized) return;
    const graph = getGraph();
    if (!graph) return;

    // 检查 graph.extra 是否变化（工作流切换/恢复）
    const extraSlots = loadSlotsFromGraph();
    if (extraSlots) {
        // 比较 graph.extra 中的数据是否和当前 slots 不同
        const changed = extraSlots.some((s, i) => {
            const old = slots[i];
            if (!s && !old) return false;
            if (!s || !old) return true;
            return s.scale !== old.scale || s.x !== old.x || s.y !== old.y;
        });
        if (changed) {
            console.log("[小珠光] V4 检测到 graph.extra 变化，重新加载");
            slots = extraSlots.slice();
            for (let i = 0; i < SLOT_COUNT; i++) updateSlotVisual(i);
            updateMainIcon();
        }
    }
}

function showToast(text) {
    if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.style.cssText = `
            position:fixed;z-index:10001;
            background:rgba(20,20,20,0.92);color:${GOLD};font-size:11px;
            padding:5px 12px;border-radius:4px;white-space:nowrap;
            border:1px solid rgba(220,200,91,0.3);pointer-events:none;
            opacity:0;transition:opacity 0.2s;
            box-shadow:0 2px 8px rgba(0,0,0,0.4);
        `;
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;

    // 定位到主图标（靶心）上方
    let left, top;
    if (menuBtn) {
        const pr = menuBtn.getBoundingClientRect();
        left = pr.left + pr.width / 2;
        top = pr.top - 28;  // 主图标上方 28px
    } else {
        left = window.innerWidth / 2;
        top = 60;
    }
    toastEl.style.left = left + "px";
    toastEl.style.top = top + "px";
    toastEl.style.transform = "translateX(-50%)";
    toastEl.style.opacity = "1";
    clearTimeout(toastEl._xzgTimer);
    toastEl._xzgTimer = setTimeout(() => {
        if (toastEl) toastEl.style.opacity = "0";
    }, 1500);
}

function updateSlotVisual(idx) {
    const el = slotEls[idx];
    if (!el) return;
    const hasData = !!slots[idx];
    const color = SLOT_COLORS[idx];  // 颜色固定
    const text = hasData ? String(idx + 1) : "空";
    el.innerHTML = circleIcon(color, text, 32);
    el.title = hasData
        ? `槽位${idx + 1}: 左键恢复 · 右键记录\n缩放: ${slots[idx].scale.toFixed(2)}  X: ${Math.round(slots[idx].x)}  Y: ${Math.round(slots[idx].y)}`
        : `槽位${idx + 1}: 右键记录视角`;
}

function updateMainIcon() {
    if (!menuBtn) return;
    const hasAny = slots.some(s => s);
    const iconBox = menuBtn.querySelector(".xzg-vp-icon");
    if (!iconBox) return;
    // 无记录（新建/未记录过的工作流）或有记录，统一只显示空心圆环（targetIcon），不显示"空"文字
    iconBox.innerHTML = targetIcon(GOLD, 25);
}

// 主图标临时显示某个槽位的圆圈（覆盖靶心），与展开槽位同等大小，一段时间后恢复
let mainIconFlashTimer = null;
function flashMainIcon(idx) {
    if (!menuBtn) return;
    const iconBox = menuBtn.querySelector(".xzg-vp-icon");
    if (!iconBox) return;
    const color = SLOT_COLORS[idx];
    const text = slots[idx] ? String(idx + 1) : "空";
    iconBox.innerHTML = circleIcon(color, text, 25);
    clearTimeout(mainIconFlashTimer);
    mainIconFlashTimer = setTimeout(() => {
        updateMainIcon();
    }, 1200);
}

function positionSlotPanel() {
    if (!slotPanel || !menuBtn) return;
    const pr = menuBtn.getBoundingClientRect();
    const sw = slotPanel.offsetWidth || 180;
    let left = pr.left;
    if (left + sw > window.innerWidth - 4) left = pr.right - sw;
    if (left < 4) left = 4;
    const top = pr.bottom + 8;
    slotPanel.style.left = left + "px";
    slotPanel.style.top = top + "px";
}

function setExpanded(on) {
    expanded = on;
    if (slotPanel) {
        slotPanel.style.display = on ? "flex" : "none";
        if (on) positionSlotPanel();
    }
    if (menuBtn) menuBtn.classList.toggle("xzg-vp-active", on);
}

// ─── 菜单栏集成 ───

function findMenuContainer() {
    if (app.menu?.element) return app.menu.element;
    const selectors = [
        ".comfyui-menu-right", ".comfyui-menu", ".comfy-menu",
        ".p-toolbar", ".top-menubar-container", ".actionbar-container",
        "[class*='menubar']", "[class*='menu-bar']",
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
    }
    return null;
}

function buildMenuButton() {
    const btn = document.createElement("div");
    btn.id = PANEL_ID;
    btn.className = "xzg-vp-menu-btn";
    btn.style.cssText = `
        display:flex;align-items:center;justify-content:center;gap:4px;
        height:32px;padding:0 8px;cursor:pointer;
        color:var(--input-text,#ddd);font-size:12px;
        border-radius:6px;user-select:none;
        transition:background 0.15s;position:relative;
        align-self:center;margin:auto 0;
    `;
    btn.innerHTML = `
        <span class="xzg-vp-icon" style="display:flex;align-items:center;justify-content:center;"></span>
    `;
    btn.addEventListener("mouseenter", () => {
        btn.style.background = "var(--comfy-input-bg,#353535)";
    });
    btn.addEventListener("mouseleave", () => {
        if (!expanded) btn.style.background = "transparent";
    });
    btn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        setExpanded(!expanded);
    });
    return btn;
}

function buildFloatingPanel() {
    const pos = loadPos();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText = `
        position:fixed;left:${pos.left}px;top:${pos.top}px;z-index:10000;
        width:30px;height:30px;
        display:flex;align-items:center;justify-content:center;
        cursor:pointer;border-radius:50%;
        background:rgba(40,40,40,0.6);transition:background 0.15s;
        user-select:none;
    `;
    panel.innerHTML = `<span class="xzg-vp-icon" style="display:flex;align-items:center;"></span>`;
    panel.addEventListener("mouseenter", () => { panel.style.background = "rgba(60,60,60,0.8)"; });
    panel.addEventListener("mouseleave", () => { panel.style.background = "rgba(40,40,40,0.6)"; });

    let dragging = false, dragMoved = false;
    let dragStart = { x: 0, y: 0, left: 0, top: 0 };
    panel.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        dragging = true; dragMoved = false;
        dragStart = { x: e.clientX, y: e.clientY, left: panel.offsetLeft, top: panel.offsetTop };
    });
    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;
        if (!dragMoved && Math.hypot(dx, dy) > 3) dragMoved = true;
        panel.style.left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, dragStart.left + dx)) + "px";
        panel.style.top = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, dragStart.top + dy)) + "px";
        if (expanded) positionSlotPanel();
    });
    document.addEventListener("mouseup", () => {
        if (dragging) { dragging = false; if (dragMoved) savePos({ left: panel.offsetLeft, top: panel.offsetTop }); }
    });
    panel.addEventListener("click", (e) => {
        if (dragMoved) return;
        e.preventDefault(); e.stopPropagation();
        setExpanded(!expanded);
    });
    return panel;
}

function buildSlotPanel() {
    slotPanel = document.createElement("div");
    slotPanel.style.cssText = `
        position:fixed;z-index:10000;
        display:none;align-items:center;gap:6px;padding:6px;
        background:rgba(20,20,20,0.85);
        border:1px solid rgba(120,120,120,0.25);
        border-radius:10px;backdrop-filter:blur(8px);
        user-select:none;box-shadow:0 4px 20px rgba(0,0,0,0.4);
    `;
    for (let i = 0; i < SLOT_COUNT; i++) {
        const slot = document.createElement("div");
        slot.className = "xzg-vp-slot";
        slot.style.cssText = `
            position:relative;width:28px;height:28px;
            display:flex;align-items:center;justify-content:center;
            cursor:pointer;border-radius:50%;
            background:rgba(40,40,40,0.6);
            transition:background 0.15s;flex-shrink:0;
        `;
        slot.addEventListener("mouseenter", () => { slot.style.background = "rgba(60,60,60,0.8)"; });
        slot.addEventListener("mouseleave", () => { slot.style.background = "rgba(40,40,40,0.6)"; });
        const idx = i;
        slot.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            if (slots[idx]) {
                animateViewState(slots[idx]);
                flashMainIcon(idx);
                setExpanded(false);
            } else {
                flashMainIcon(idx);
            }
        });
        slot.addEventListener("contextmenu", (e) => {
            e.preventDefault(); e.stopPropagation();
            const state = getViewState();
            if (state) {
                slots[idx] = state;
                saveSlots(slots);
                updateSlotVisual(idx);
                updateMainIcon();
                flashMainIcon(idx);
                setExpanded(false);
            }
        });
        slotPanel.appendChild(slot);
        slotEls.push(slot);
        updateSlotVisual(i);
    }

    // 清空记录按钮
    const clearBtn = document.createElement("div");
    clearBtn.title = "清空所有记录";
    clearBtn.style.cssText = `
        width:28px;height:28px;
        display:flex;align-items:center;justify-content:center;
        cursor:pointer;border-radius:50%;
        background:rgba(40,40,40,0.6);color:#999;
        transition:background 0.15s;flex-shrink:0;
        font-size:14px;font-family:Arial,sans-serif;
    `;
    clearBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" style="display:block;">
        <path d="M4 7H20M9 7V5C9 4 10 3 11 3H13C14 3 15 4 15 5V7M6 7L7 19C7 20 8 21 9 21H15C16 21 17 20 17 19L18 7" stroke="#999" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <path d="M11 11V17M13 11V17" stroke="#999" stroke-width="1.8" stroke-linecap="round" fill="none"/>
    </svg>`;
    clearBtn.addEventListener("mouseenter", () => {
        clearBtn.style.background = "rgba(60,60,60,0.8)";
        clearBtn.querySelectorAll("svg path").forEach(p => p.setAttribute("stroke", "#ff5b5b"));
    });
    clearBtn.addEventListener("mouseleave", () => {
        clearBtn.style.background = "rgba(40,40,40,0.6)";
        clearBtn.querySelectorAll("svg path").forEach(p => p.setAttribute("stroke", "#999"));
    });
    clearBtn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        slots = new Array(SLOT_COUNT).fill(null);
        saveSlots(slots);
        for (let i = 0; i < SLOT_COUNT; i++) updateSlotVisual(i);
        updateMainIcon();
        setExpanded(false);
    });
    slotPanel.appendChild(clearBtn);

    // ── 通用下拉列表构造器 ──
    let openDropdown = null;   // 当前打开的下拉引用
    function closeOpenDropdown() {
        if (openDropdown && openDropdown._close) {
            openDropdown._close();
            openDropdown = null;
        }
    }
    document.addEventListener("click", (e) => {
        if (!openDropdown) return;
        if (!openDropdown.contains(e.target)) closeOpenDropdown();
    }, true);

    function buildDropdown({ width, options, getCurrent, onSelect, titlePrefix }) {
        const wrap = document.createElement("div");
        wrap.style.cssText = `
            position:relative;height:28px;width:${width}px;flex-shrink:0;
        `;

        // 按钮
        const btn = document.createElement("div");
        btn.style.cssText = `
            width:100%;height:100%;
            display:flex;align-items:center;justify-content:space-between;
            padding:0 8px 0 8px;box-sizing:border-box;
            cursor:pointer;border-radius:6px;
            background:rgba(40,40,40,0.6);
            transition:background 0.15s;
            font-size:12px;font-family:Arial,sans-serif;user-select:none;
            gap:4px;
        `;
        const label = document.createElement("span");
        label.style.flex = "1";
        label.style.textAlign = "center";
        const arrow = document.createElement("span");
        arrow.textContent = "▾";
        arrow.style.cssText = "font-size:10px;color:#888;transition:transform 0.15s;";
        btn.appendChild(label);
        btn.appendChild(arrow);
        wrap.appendChild(btn);

        // 弹层
        const list = document.createElement("div");
        list.style.cssText = `
            position:absolute;left:0;top:calc(100% + 4px);
            min-width:100%;padding:4px 0;
            background:rgba(28,28,28,0.98);
            border:1px solid rgba(220,200,91,0.25);
            border-radius:6px;z-index:10001;
            box-shadow:0 4px 14px rgba(0,0,0,0.5);
            display:none;overflow:hidden;
        `;
        wrap.appendChild(list);

        let isOpen = false;
        function updateBtn() {
            const cur = getCurrent();
            const opt = options.find(o => o.value === cur);
            const text = opt ? opt.label : String(cur);
            label.textContent = text;
            label.style.color = GOLD;
            label.style.fontWeight = "bold";
            btn.title = titlePrefix + " " + text + "（点击展开）";
        }
        function renderList() {
            list.innerHTML = "";
            const cur = getCurrent();
            options.forEach((opt, idx) => {
                const row = document.createElement("div");
                const sel = (opt.value === cur);
                row.style.cssText = `
                    padding:6px 22px 6px 12px;
                    font-size:12px;font-family:Arial,sans-serif;
                    cursor:pointer;white-space:nowrap;
                    color:${GOLD};
                    background:${sel ? "rgba(220,200,91,0.12)" : "transparent"};
                    font-weight:${sel ? "bold" : "normal"};
                    transition:background 0.1s;
                    display:flex;align-items:center;gap:8px;
                `;
                // 选中勾
                const check = document.createElement("span");
                check.textContent = sel ? "✓" : "";
                check.style.cssText = `width:10px;color:${GOLD};font-size:11px;`;
                row.appendChild(check);
                const txt = document.createElement("span");
                txt.textContent = opt.label;
                row.appendChild(txt);
                // 提示
                if (opt.desc) {
                    const desc = document.createElement("span");
                    desc.textContent = opt.desc;
                    desc.style.cssText = "color:#777;font-size:10px;margin-left:auto;";
                    row.appendChild(desc);
                }
                row.addEventListener("mouseenter", () => {
                    if (!sel) row.style.background = "rgba(255,255,255,0.06)";
                });
                row.addEventListener("mouseleave", () => {
                    row.style.background = sel ? "rgba(220,200,91,0.12)" : "transparent";
                });
                row.addEventListener("click", (e) => {
                    e.preventDefault(); e.stopPropagation();
                    onSelect(opt.value);
                    close();
                });
                list.appendChild(row);
            });
        }
        function open() {
            closeOpenDropdown();
            renderList();
            list.style.display = "block";
            arrow.style.transform = "rotate(180deg)";
            btn.style.background = "rgba(60,60,60,0.85)";
            isOpen = true;
            openDropdown = wrap;
        }
        function close() {
            list.style.display = "none";
            arrow.style.transform = "rotate(0deg)";
            btn.style.background = "rgba(40,40,40,0.6)";
            isOpen = false;
            if (openDropdown === wrap) openDropdown = null;
        }
        wrap._close = close;
        btn.addEventListener("mouseenter", () => {
            if (!isOpen) btn.style.background = "rgba(60,60,60,0.8)";
        });
        btn.addEventListener("mouseleave", () => {
            if (!isOpen) btn.style.background = "rgba(40,40,40,0.6)";
        });
        btn.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            if (isOpen) close(); else open();
        });
        updateBtn();
        wrap._updateBtn = updateBtn;
        return wrap;
    }

    // 速度下拉
    const speedDropdown = buildDropdown({
        width: 58,
        titlePrefix: "动画速度",
        getCurrent: () => vpConfig.speed,
        options: SPEED_LEVELS.map((s, i) => ({
            value: s,
            label: s === 1 ? "1×" : (s + "×"),
            isDefault: s === 1,
            desc: ["慢", "标准", "快", "很快", "极快"][i],
        })),
        onSelect: (v) => {
            vpConfig.speed = v;
            saveConfig(vpConfig);
            speedDropdown._updateBtn?.();
        },
    });
    slotPanel.appendChild(speedDropdown);

    // 缓动下拉
    const easeDropdown = buildDropdown({
        width: 78,
        titlePrefix: "缓动曲线",
        getCurrent: () => vpConfig.ease,
        options: EASE_OPTIONS.map(e => ({
            value: e.key,
            label: e.label,
            isDefault: e.key === "inout",
            desc: {
                out: "快入慢出",
                inout: "缓入缓出",
                in: "慢入快出",
                linear: "匀速",
                none: "瞬间跳转",
                boing: "弹性回弹",
            }[e.key] || "",
        })),
        onSelect: (v) => {
            vpConfig.ease = v;
            saveConfig(vpConfig);
            easeDropdown._updateBtn?.();
        },
    });
    slotPanel.appendChild(easeDropdown);

    // 使用说明
    const helpBtn = document.createElement("div");
    helpBtn.title = "使用说明";
    helpBtn.style.cssText = `
        width:28px;height:28px;
        display:flex;align-items:center;justify-content:center;
        cursor:pointer;border-radius:50%;
        background:rgba(40,40,40,0.6);color:#999;
        transition:background 0.15s;flex-shrink:0;
        font-size:14px;font-family:Arial,sans-serif;
    `;
    helpBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" style="display:block;">
        <circle cx="12" cy="12" r="10" fill="none" stroke="#999" stroke-width="1.8"/>
        <text x="12" y="16" text-anchor="middle" fill="#999" font-size="13" font-family="Arial,sans-serif" font-weight="bold">?</text>
    </svg>`;
    helpBtn.addEventListener("mouseenter", () => {
        helpBtn.style.background = "rgba(60,60,60,0.8)";
        helpBtn.querySelector("circle").setAttribute("stroke", "#dcc85b");
        helpBtn.querySelector("text").setAttribute("fill", "#dcc85b");
    });
    helpBtn.addEventListener("mouseleave", () => {
        helpBtn.style.background = "rgba(40,40,40,0.6)";
        helpBtn.querySelector("circle").setAttribute("stroke", "#999");
        helpBtn.querySelector("text").setAttribute("fill", "#999");
    });
    helpBtn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        showHelpDialog();
    });
    slotPanel.appendChild(helpBtn);

    document.body.appendChild(slotPanel);
    window.addEventListener("resize", () => { if (expanded) positionSlotPanel(); });
}

function showHelpDialog() {
    // 移除已有对话框
    const old = document.getElementById("xzg-vp-help-dialog");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "xzg-vp-help-dialog";
    overlay.style.cssText = `
        position:fixed;inset:0;z-index:10002;
        background:rgba(0,0,0,0.5);
        display:flex;align-items:center;justify-content:center;
    `;
    const dialog = document.createElement("div");
    dialog.style.cssText = `
        background:#1e1e1e;color:#ddd;
        border:1px solid rgba(220,200,91,0.3);border-radius:10px;
        padding:20px 24px;max-width:360px;font-size:13px;line-height:1.8;
        box-shadow:0 4px 20px rgba(0,0,0,0.5);
    `;
    dialog.innerHTML = `
        <div style="font-size:15px;color:${GOLD};margin-bottom:12px;font-weight:bold;">视角锁定 使用说明</div>
        <div><span style="color:${GOLD};">右键</span> 槽位（1-5）：记录当前视角</div>
        <div><span style="color:${GOLD};">左键</span> 槽位（1-5）：恢复对应视角</div>
        <div><span style="color:${GOLD};">键盘 1-5</span>：快捷恢复对应视角</div>
        <div><span style="color:${GOLD};">垃圾桶</span>：清空所有记录</div>
        <div><span style="color:${GOLD};">速度</span>：切换动画速度（0.5× / 1× / 1.5× / 2× / 3×）</div>
        <div><span style="color:${GOLD};">缓动</span>：切换缓动曲线（Out / InOut / In / Linear / None / Boing）</div>
        <div style="margin-top:10px;color:#999;font-size:12px;line-height:1.6;">
            · 每个工作流独立记录视角<br>
            · 需保存工作流才会保留记录
        </div>
        <div style="margin-top:14px;text-align:right;">
            <button id="xzg-vp-help-close" style="
                background:#353535;color:#ddd;border:1px solid #555;
                border-radius:6px;padding:5px 16px;cursor:pointer;font-size:12px;
            ">关闭</button>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    dialog.querySelector("#xzg-vp-help-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

function injectIntoMenu() {
    // 移除旧按钮（如果存在）
    const oldBtn = document.getElementById(PANEL_ID);
    if (oldBtn) oldBtn.remove();

    const container = findMenuContainer();
    if (container) {
        menuBtn = buildMenuButton();
        container.appendChild(menuBtn);
    } else {
        menuBtn = buildFloatingPanel();
        document.body.appendChild(menuBtn);
    }
    updateMainIcon();
}

function tryInjectLoop(retries) {
    const container = findMenuContainer();
    if (container) {
        injectIntoMenu();
        return;
    }
    if (retries >= 15) {
        console.warn("[小珠光] V3 菜单栏未找到，使用浮动面板");
        injectIntoMenu();
        return;
    }
    setTimeout(() => tryInjectLoop(retries + 1), 200);
}

function hookWorkflowLoad() {
    const graph = getGraph();
    if (graph && !graph._xzgVpV3Hooked) {
        graph._xzgVpV3Hooked = true;
        const origConfigure = graph.configure;
        if (origConfigure) {
            graph.configure = function(...args) {
                const r = origConfigure.apply(this, args);
                setTimeout(() => reloadSlotsForCurrentWorkflow(), 200);
                return r;
            };
        }
    }
}

// ─── 初始化 ───

function init() {
    if (initialized) return;
    initialized = true;
    console.log("[小珠光] V4 初始化开始");

    reloadSlotsForCurrentWorkflow();
    hookWorkflowLoad();
    tryInjectLoop(0);
    buildSlotPanel();
    setInterval(refreshSlots, 500);

    // 快捷键 1~5
    document.addEventListener("keydown", (e) => {
        // 放行所有可编辑上下文，避免劫持其它插件的文本框输入数字键。
        // contenteditable（自定义编辑器）的 tag 是 div/span，需额外判断。
        const et = e.target;
        const tag = et?.tagName ? et.tagName.toLowerCase() : "";
        const editable =
            tag === "input" || tag === "textarea" || tag === "select" ||
            tag === "contenteditable" ||
            et?.isContentEditable ||
            et?.getAttribute?.("contenteditable") === "true" ||
            !!(et && et.closest && et.closest('[contenteditable="true"]'));
        if (editable) return;
        if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
        if (e.key >= "1" && e.key <= "5") {
            const idx = parseInt(e.key) - 1;
            if (idx >= SLOT_COUNT) return;
            e.preventDefault();
            if (slots[idx]) {
                animateViewState(slots[idx]);
                flashMainIcon(idx);
                setExpanded(false);
            } else {
                flashMainIcon(idx);
            }
        }
    });

    // 点击空白收起
    document.addEventListener("mousedown", (e) => {
        if (!expanded) return;
        if (menuBtn?.contains(e.target)) return;
        if (slotPanel?.contains(e.target)) return;
        setExpanded(false);
    }, true);

    // 持续 hook graph
    let hookRetries = 0;
    const hookTimer = setInterval(() => {
        hookWorkflowLoad();
        if (++hookRetries > 60) clearInterval(hookTimer);
    }, 500);
}

// 注入样式
if (!document.getElementById("xzg-viewport-lock-style-v3")) {
    const style = document.createElement("style");
    style.id = "xzg-viewport-lock-style-v3";
    style.textContent = `
        .xzg-vp-menu-btn.xzg-vp-active { background: var(--comfy-input-bg,#353535) !important; }
        .xzg-vp-slot:hover { transform: scale(1.05); }
    `;
    document.head.appendChild(style);
}

window.xzgViewportLockV4 = {
    expand: () => setExpanded(true),
    collapse: () => setExpanded(false),
    reload: reloadSlotsForCurrentWorkflow,
    getSlots: () => slots.slice(),
    saveSlots: saveSlots,
};

// 等 app.canvas 就绪后初始化
function waitForApp() {
    if (app && app.canvas) {
        init();
    } else {
        setTimeout(waitForApp, 200);
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForApp);
} else {
    waitForApp();
}
