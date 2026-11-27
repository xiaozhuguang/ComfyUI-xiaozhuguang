import { app } from "../../scripts/app.js";
import { cloudLoad, cloudSave } from "./xzg_cloud_store.js";

// 天工对齐偏好云存储防抖计时器（颜色/间距/快捷键合并一个云键）
let _alignCloudTimer = null;
const ALIGN_ENABLED_SETTING = "xiaozhuguang.Toggle.EnableTianAlign";

// 小珠光 - 田字格对齐面板 (Alt+S)
app.registerExtension({
    name: "Comfy.Xiaozhuguang.Align",
    async setup() {
        const DEFAULT_THEME = "#FFD700";
        let THEME_COLOR = localStorage.getItem("xiaozhuguang.tian.themeColor") || DEFAULT_THEME;

        const DEFAULT_V_GAP = 50;
        const DEFAULT_H_GAP = 100;
        let V_GAP = parseInt(localStorage.getItem("xiaozhuguang.tian.vGap")) || DEFAULT_V_GAP;
        let H_GAP = parseInt(localStorage.getItem("xiaozhuguang.tian.hGap")) || DEFAULT_H_GAP;

        const DEFAULT_SHORTCUT = { key: "s", alt: true, ctrl: false, shift: false, meta: false };
        let SHORTCUT = JSON.parse(localStorage.getItem("xiaozhuguang.tian.shortcut") || "null") || { ...DEFAULT_SHORTCUT };

        // 云持久化：对齐偏好（颜色/间距/快捷键）合并一个云键，本地先写兜底、异步以服务端为准覆盖
        const ALIGN_STATE_KEY = "xzg_align_state";
        function alignQueueSave() {
            if (_alignCloudTimer) clearTimeout(_alignCloudTimer);
            _alignCloudTimer = setTimeout(() => {
                _alignCloudTimer = null;
                cloudSave(ALIGN_STATE_KEY, {
                    themeColor: THEME_COLOR,
                    vGap: V_GAP,
                    hGap: H_GAP,
                    shortcut: SHORTCUT
                }).catch(() => {});
            }, 500);
        }
        async function alignCloudRestore() {
            try {
                const s = await cloudLoad(ALIGN_STATE_KEY, { fallbackValue: null });
                if (!s || typeof s !== "object") return;
                if (typeof s.themeColor === "string" && /^#[0-9a-fA-F]{6}$/.test(s.themeColor)) {
                    THEME_COLOR = s.themeColor;
                    localStorage.setItem("xiaozhuguang.tian.themeColor", s.themeColor);
                    applyThemeToVisuals();
                }
                if (typeof s.vGap === "number" && s.vGap >= 10 && s.vGap <= 500) {
                    V_GAP = s.vGap;
                    localStorage.setItem("xiaozhuguang.tian.vGap", String(s.vGap));
                }
                if (typeof s.hGap === "number" && s.hGap >= 10 && s.hGap <= 500) {
                    H_GAP = s.hGap;
                    localStorage.setItem("xiaozhuguang.tian.hGap", String(s.hGap));
                }
                if (s.shortcut && typeof s.shortcut === "object" && s.shortcut.key) {
                    SHORTCUT = s.shortcut;
                    localStorage.setItem("xiaozhuguang.tian.shortcut", JSON.stringify(s.shortcut));
                    updateShortcutHint();
                }
            } catch (e) {
                console.warn("[小珠光] 从云同步对齐设置失败:", e);
            }
        }
        alignCloudRestore();
        // 供主题面板“导入配置”后一键推送天工对齐设置
        window.__xzgCloudPush = window.__xzgCloudPush || {};
        window.__xzgCloudPush.align = alignQueueSave;

        function formatShortcut(sc) {
            const parts = [];
            if (sc.ctrl) parts.push("Ctrl");
            if (sc.alt) parts.push("Alt");
            if (sc.shift) parts.push("Shift");
            if (sc.meta) parts.push("Meta");
            if (sc.key) parts.push(sc.key.toUpperCase());
            return parts.join(" + ");
        }

        function hexToRgba(hex, alpha) {
            const h = hex.replace("#", "");
            const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
            const r = parseInt(full.slice(0, 2), 16);
            const g = parseInt(full.slice(2, 4), 16);
            const b = parseInt(full.slice(4, 6), 16);
            return `rgba(${r},${g},${b},${alpha})`;
        }
        function updateThemeColors() {
            GOLD = THEME_COLOR;
            QZONE_BG = hexToRgba(THEME_COLOR, 0.12);
            QZONE_BORDER = hexToRgba(THEME_COLOR, 0.5);
            GLOW_DROP = hexToRgba(THEME_COLOR, 0.67);
        }

        let GOLD = THEME_COLOR;
        const LINE_COLOR = "rgba(194,194,194,0.5)";
        const LINE_DIM = "rgba(194,194,194,0.18)";
        let QZONE_BG = hexToRgba(THEME_COLOR, 0.12);
        let QZONE_BORDER = hexToRgba(THEME_COLOR, 0.5);
        let GLOW_DROP = hexToRgba(THEME_COLOR, 0.67);
        const TIAN_SIZE = 200;
        const PAD = 18;
        const CX = TIAN_SIZE / 2;
        const CY = TIAN_SIZE / 2;
        const HIT_LINE = 12;
        const HIT_ZONE = 28;
        const CENTER_RADIUS = 18;

        const PRESET_COLORS = [
            "#FFD700", "#FF6B6B", "#4ECDC4", "#A78BFA",
            "#F472B6", "#60A5FA", "#34D399", "#FBBF24",
            "#FFFFFF", "#FF8C42",
        ];

        const LINES = {
            v_left:   { type: "v", x: PAD,            key: "v_left" },
            v_mid:    { type: "v", x: CX,             key: "v_mid" },
            v_right:  { type: "v", x: TIAN_SIZE-PAD,  key: "v_right" },
            h_top:    { type: "h", y: PAD,            key: "h_top" },
            h_mid:    { type: "h", y: CY,             key: "h_mid" },
            h_bottom: { type: "h", y: TIAN_SIZE-PAD,  key: "h_bottom" },
        };
        const LINE_KEYS = Object.keys(LINES);

        // 4个区域分布功能
        const ZONES = {
            z_left:   { key: "z_left",   quads: [0, 2] },
            z_right:  { key: "z_right",  quads: [1, 3] },
            z_top:    { key: "z_top",    quads: [0, 1] },
            z_bottom: { key: "z_bottom", quads: [2, 3] },
        };

        let tianPanel = null;
        let alignmentEnabled = true;
        let recordingShortcut = false;
        let tianIsOpen = false;
        let tianOpenedFromSelection = false;
        let panelTransition = null;
        let shortcutHint = null;
        let previousSelection = new Set();
        let selectionRAF = null;
        let svgLineEls = {};
        let svgQuadEls = [];
        let centerDot = null;
        let centerGlow = null;
        let frameEl = null;
        let overlay = null;
        let hoveredType = null;
        let hoveredKey = null;
        let colorMenu = null;
        let colorMenuOpen = false;
        let centerDrag = null;
        let wasCenterDrag = false; // 中心拖动后抑制误触 click
        let dirArrow = null;
        let pressRing = null;
        let pressTimer = null;
        let successRAF = null;
        let autoArrangeMenu = null;
        let pressStartTime = 0;
        const DRAG_THRESHOLD = 60;
        const LONG_PRESS_MS = 1500;

        // --- 辅助函数 ---
        function getSelectedNodes() {
            const canvas = app.canvas;
            if (canvas?.selectedItems) {
                return [...canvas.selectedItems].filter(item => canvas.graph?.getNodeById(item.id) === item);
            }
            return Object.values(canvas?.selected_nodes || {});
        }
        function beginChange() { app.canvas.graph.beforeChange(); }
        function endChange()   { app.canvas.graph.afterChange(); app.canvas.draw(true, true); }
        function getLeftmost(nodes) {
            return nodes.reduce((a, n) => (n.pos[0] < a.pos[0] ? n : a), nodes[0]);
        }
        function getRightmost(nodes) {
            return nodes.reduce((a, n) => (n.pos[0] + n.size[0] > a.pos[0] + a.size[0] ? n : a), nodes[0]);
        }
        function getTopmost(nodes) {
            return nodes.reduce((a, n) => (n.pos[1] < a.pos[1] ? n : a), nodes[0]);
        }
        function getClosestToCenterH(nodes) {
            const avgCX = nodes.reduce((a, n) => a + n.pos[0] + n.size[0] / 2, 0) / nodes.length;
            let best = nodes[0], bestDist = Infinity;
            for (const n of nodes) {
                const cx = n.pos[0] + n.size[0] / 2;
                const d = Math.abs(cx - avgCX);
                if (d < bestDist) { bestDist = d; best = n; }
            }
            return best;
        }
        function getClosestToCenterV(nodes) {
            const avgCY = nodes.reduce((a, n) => a + n.pos[1] + n.size[1] / 2, 0) / nodes.length;
            let best = nodes[0], bestDist = Infinity;
            for (const n of nodes) {
                const cy = n.pos[1] + n.size[1] / 2;
                const d = Math.abs(cy - avgCY);
                if (d < bestDist) { bestDist = d; best = n; }
            }
            return best;
        }

        // --- 6个线对齐功能 ---
        function alignColumnsVertically(columns, anchorRatio) {
            const anchorColumn = columns[0];
            const top = Math.min(...anchorColumn.map(node => node.pos[1]));
            const bottom = Math.max(...anchorColumn.map(node => node.pos[1] + node.size[1]));
            const anchorY = top + (bottom - top) * anchorRatio;
            beginChange();
            for (const column of columns) {
                const height = column.reduce((sum, node) => sum + node.size[1], 0)
                    + (column.length - 1) * V_GAP;
                let y = anchorY - height * anchorRatio;
                for (const node of column) {
                    node.pos[1] = y;
                    y += node.size[1] + V_GAP;
                }
            }
            endChange();
        }

        function alignLeft() {
            alignHorizontal(0);
        }
        function alignHCenter() {
            alignHorizontal(0.5);
        }
        function alignRight() {
            alignHorizontal(1);
        }
        function alignHorizontal(anchorRatio) {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            const anchor = getTopmost(nodes);
            const x = anchor.pos[0] + anchor.size[0] * anchorRatio;
            beginChange();
            nodes.forEach(node => { node.pos[0] = x - node.size[0] * anchorRatio; });
            endChange();
        }
        function alignTop()     { alignVertical(0); }
        function alignVCenter() { alignVertical(0.5); }
        function alignBottom()  { alignVertical(1); }
        function alignVertical(anchorRatio) {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            const anchor = getLeftmost(nodes);
            const y = anchor.pos[1] + anchor.size[1] * anchorRatio;
            beginChange();
            nodes.forEach(node => { node.pos[1] = y - node.size[1] * anchorRatio; });
            endChange();
        }

        // --- 4个区域分布功能 ---
        // 上下分布（左侧/右侧区域）：以最上面节点为锚点
        // 左右分布（上侧/下侧区域）：以最左侧节点为锚点
        // 左侧区域：水平居中(以最上面节点为锚) + 垂直等距分布(两端不动)
        function distVLeftAnchor() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getTopmost(nodes);
            const targetCX = anchor.pos[0] + anchor.size[0] / 2;
            nodes.forEach(n => { n.pos[0] = targetCX - n.size[0] / 2; });

            const sorted = [...nodes].sort((a, b) => a.pos[1] - b.pos[1]);
            const minY = sorted[0].pos[1];
            const maxY = sorted[sorted.length-1].pos[1] + sorted[sorted.length-1].size[1];
            const totalH = sorted.reduce((a, n) => a + n.size[1], 0);
            const gap = (maxY - minY - totalH) / (sorted.length - 1);
            let y = minY;
            sorted.forEach(n => { n.pos[1] = y; y += n.size[1] + gap; });
            endChange();
        }
        // 右侧区域：水平居中(以最上面节点为锚) + 垂直固定间距堆叠(最上节点不动)
        function distVRightAnchor() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getTopmost(nodes);
            const targetCX = anchor.pos[0] + anchor.size[0] / 2;
            const startY = anchor.pos[1];
            nodes.forEach(n => { n.pos[0] = targetCX - n.size[0] / 2; });

            const sorted = [...nodes].sort((a, b) => a.pos[1] - b.pos[1]);
            let y = startY;
            sorted.forEach(n => { n.pos[1] = y; y += n.size[1] + V_GAP; });
            endChange();
        }
        // 上侧区域：水平等距分布(两端不动，只改变左右位置)
        function distHTopAnchor() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();

            const sorted = [...nodes].sort((a, b) => a.pos[0] - b.pos[0]);
            const minX = sorted[0].pos[0];
            const maxX = sorted[sorted.length-1].pos[0] + sorted[sorted.length-1].size[0];
            const totalW = sorted.reduce((a, n) => a + n.size[0], 0);
            const gap = (maxX - minX - totalW) / (sorted.length - 1);
            let x = minX;
            sorted.forEach(n => { n.pos[0] = x; x += n.size[0] + gap; });
            endChange();
        }
        // 下侧区域：水平固定间距(最左节点不动，只改变左右位置)
        function distHBottomAnchor() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getLeftmost(nodes);

            const sorted = [...nodes].sort((a, b) => a.pos[0] - b.pos[0]);
            const startX = anchor.pos[0];
            let x = startX;
            sorted.forEach(n => { n.pos[0] = x; x += n.size[0] + H_GAP; });
            endChange();
        }

        const ALIGN_FN = {
            v_left:   alignLeft,
            v_mid:    alignHCenter,
            v_right:  alignRight,
            h_top:    alignTop,
            h_mid:    alignVCenter,
            h_bottom: alignBottom,
        };
        const ZONE_FN = {
            z_left:   distVLeftAnchor,
            z_right:  distVRightAnchor,
            z_top:    distHTopAnchor,
            z_bottom: distHBottomAnchor,
        };

        // 中心功能：智能判断分布方向，等宽或等高
        function centerSameSize() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;

            // 判断节点是主要上下分布还是左右分布
            const minX = Math.min(...nodes.map(n => n.pos[0]));
            const maxX = Math.max(...nodes.map(n => n.pos[0] + n.size[0]));
            const minY = Math.min(...nodes.map(n => n.pos[1]));
            const maxY = Math.max(...nodes.map(n => n.pos[1] + n.size[1]));
            const totalW = maxX - minX;
            const totalH = maxY - minY;

            // 计算节点在X/Y方向上的总重叠范围
            // 如果垂直范围 > 水平范围 → 主要上下分布 → 等宽
            // 如果水平范围 > 垂直范围 → 主要左右分布 → 等高
            const verticalLayout = totalH > totalW;

            beginChange();
            if (verticalLayout) {
                matchWidthAndCenter(nodes);
            } else {
                // 左右分布 → 等高，以最高的节点为锚点（只加高不加窄）
                const maxH = Math.max(...nodes.map(n => n.size[1]));
                nodes.forEach(n => {
                    const cy = n.pos[1] + n.size[1] / 2;
                    n.size[1] = maxH;
                    n.pos[1] = cy - maxH / 2;
                });
            }
            endChange();
        }

        // 等宽后沿最上面节点原来的中心线对齐
        function matchWidthAndCenter(nodes) {
            const anchor = getTopmost(nodes);
            const cx = anchor.pos[0] + anchor.size[0] / 2;
            const maxW = Math.max(...nodes.map(n => n.size[0]));
            nodes.forEach(n => {
                n.size[0] = maxW;
                n.pos[0] = cx - maxW / 2;
            });
        }

        // 强制等宽（左右拖）
        function sameWidth() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            matchWidthAndCenter(nodes);
            endChange();
        }

        // 强制等高（上下拖）
        function sameHeight() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const maxH = Math.max(...nodes.map(n => n.size[1]));
            nodes.forEach(n => {
                const cy = n.pos[1] + n.size[1] / 2;
                n.size[1] = maxH;
                n.pos[1] = cy - maxH / 2;
            });
            endChange();
        }

        function autoArrange() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            const widths = new Map(nodes.map(node => [node, node.size[0]]));
            beginChange();

            const nodeMap = new Map();
            nodes.forEach(n => nodeMap.set(n.id, n));

            const inputsOf = new Map();
            const outputsOf = new Map();
            nodes.forEach(n => {
                inputsOf.set(n.id, new Set());
                outputsOf.set(n.id, new Set());
            });

            nodes.forEach(n => {
                if (!n.inputs) return;
                n.inputs.forEach((inp) => {
                    if (!inp || inp.link == null) return;
                    const link = app.graph.links[inp.link];
                    if (!link) return;
                    const srcId = link.origin_id;
                    if (nodeMap.has(srcId) && srcId !== n.id) {
                        inputsOf.get(n.id).add(srcId);
                        outputsOf.get(srcId).add(n.id);
                    }
                });
            });

            const depth = new Map();
            const visiting = new Set();

            function getDepth(id) {
                if (depth.has(id)) return depth.get(id);
                if (visiting.has(id)) return 0;
                visiting.add(id);
                const inputs = inputsOf.get(id) || new Set();
                let d = 0;
                inputs.forEach(srcId => {
                    if (nodeMap.has(srcId)) {
                        d = Math.max(d, getDepth(srcId) + 1);
                    }
                });
                visiting.delete(id);
                depth.set(id, d);
                return d;
            }

            nodes.forEach(n => getDepth(n.id));

            const layers = new Map();
            let maxDepth = 0;
            nodes.forEach(n => {
                const d = depth.get(n.id) || 0;
                maxDepth = Math.max(maxDepth, d);
                if (!layers.has(d)) layers.set(d, []);
                layers.get(d).push(n);
            });

            const sortedDepths = [...layers.keys()].sort((a, b) => a - b);
            const anchor = getTopmost(layers.get(sortedDepths[0]));
            const startY = anchor.pos[1];
            let x = anchor.pos[0];

            // 保留原有上下顺序，只有交换相邻节点能减少列间交叉时才换位。
            const layerOrder = new Map();
            for (const list of layers.values()) {
                list.sort((a, b) => a.pos[1] - b.pos[1]);
                list.forEach((node, index) => layerOrder.set(node.id, index));
            }

            function crossingReduction(firstLinks, secondLinks, currentDepth) {
                let reduction = 0;
                for (const first of firstLinks) {
                    const otherDepth = depth.get(first);
                    if (otherDepth === currentDepth) continue;
                    for (const second of secondLinks) {
                        if (depth.get(second) !== otherDepth) continue;
                        reduction += Math.sign(layerOrder.get(first) - layerOrder.get(second));
                    }
                }
                return reduction;
            }

            for (const sweep of [[...sortedDepths].reverse(), sortedDepths]) {
                for (const d of sweep) {
                    const list = layers.get(d);
                    for (let i = 1; i < list.length; i++) {
                        const first = list[i - 1];
                        const second = list[i];
                        const reduction =
                            crossingReduction(inputsOf.get(first.id), inputsOf.get(second.id), d) +
                            crossingReduction(outputsOf.get(first.id), outputsOf.get(second.id), d);
                        if (reduction > 0) {
                            list[i - 1] = second;
                            list[i] = first;
                            layerOrder.set(first.id, i);
                            layerOrder.set(second.id, i - 1);
                        }
                    }
                }
            }

            const columns = sortedDepths.map(d => layers.get(d));
            placeColumns(columns, widths, x, startY);
            endChange();
            return { columns, widths, inputsOf, outputsOf };
        }

        function placeColumns(columns, widths, x, startY) {
            for (const column of columns) {
                const width = Math.max(...column.map(node => widths.get(node)));
                let y = startY;
                for (const node of column) {
                    node.pos[0] = x;
                    node.pos[1] = y;
                    node.size[0] = width;
                    y += node.size[1] + V_GAP;
                }
                x += width + H_GAP;
            }
        }

        function balanceColumnHeights({ columns, widths, inputsOf, outputsOf }) {
            const columnOf = new Map();
            const heights = columns.map((column, index) => {
                for (const node of column) columnOf.set(node.id, index);
                return column.reduce((height, node) => height + node.size[1] + V_GAP, 0) - V_GAP;
            });
            const x = columns[0][0].pos[0];
            const y = columns[0][0].pos[1];
            let changed = false;

            while (true) {
                let best = null;
                let bestSpread = Math.max(...heights) - Math.min(...heights);
                let bestGain = 0;
                const destinations = new Map();

                function considerMove(node, from, to, height, exchange) {
                    const gain = height * (heights[from] - heights[to] - height);
                    if (height <= 0 || gain <= 0) return;
                    const nextHeights = heights.slice();
                    nextHeights[from] -= height;
                    nextHeights[to] += height;
                    const spread = Math.max(...nextHeights) - Math.min(...nextHeights);
                    if (spread > bestSpread || (spread === bestSpread && gain <= bestGain)) return;
                    best = { node, from, to, height, exchange };
                    bestSpread = spread;
                    bestGain = gain;
                }

                for (const [from, column] of columns.entries()) {
                    for (const node of column) {
                        let first = 0;
                        let last = columns.length - 1;
                        for (const input of inputsOf.get(node.id)) first = Math.max(first, columnOf.get(input) + 1);
                        for (const output of outputsOf.get(node.id)) last = Math.min(last, columnOf.get(output) - 1);
                        destinations.set(node, [first, last]);
                        if (column.length < 2) continue;
                        const height = node.size[1] + V_GAP;
                        for (let to = first; to <= last; to++) {
                            if (from !== to) considerMove(node, from, to, height);
                        }
                    }
                }

                // 单独挪动会让目标列过高时，尝试用较矮的节点交换。
                if (!best) {
                    for (const [node, [first, last]] of destinations) {
                        const from = columnOf.get(node.id);
                        for (let to = first; to <= last; to++) {
                            if (heights[to] >= heights[from]) continue;
                            for (const exchange of columns[to]) {
                                const [exchangeFirst, exchangeLast] = destinations.get(exchange);
                                if (from < exchangeFirst || from > exchangeLast) continue;
                                considerMove(node, from, to, node.size[1] - exchange.size[1], exchange);
                            }
                        }
                    }
                }
                if (!best) break;
                const { node, from, to, height, exchange } = best;
                columns[from].splice(columns[from].indexOf(node), 1);
                if (exchange) {
                    columns[to].splice(columns[to].indexOf(exchange), 1);
                    columns[from].push(exchange);
                    columnOf.set(exchange.id, from);
                }
                columns[to].push(node);
                columnOf.set(node.id, to);
                heights[from] -= height;
                heights[to] += height;
                changed = true;
            }

            const typicalHeight = heights.slice().sort((a, b) => a - b)[Math.floor((heights.length - 1) / 2)];
            const balancedColumns = [];
            for (const [index, column] of columns.entries()) {
                column.sort((a, b) => a.pos[1] - b.pos[1]);
                const tallest = Math.max(...column.map(node => node.size[1]));
                const height = heights[index];
                let split = 0;
                if (column.length > 1 && height > Math.max(typicalHeight, tallest) * 1.4) {
                    let leftHeight = -V_GAP;
                    let bestHeight = height;
                    const leftIds = new Set();
                    for (let i = 1; i < column.length; i++) {
                        const node = column[i - 1];
                        leftIds.add(node.id);
                        leftHeight += node.size[1] + V_GAP;
                        const largest = Math.max(leftHeight, height - leftHeight - V_GAP);
                        if (largest >= bestHeight) continue;
                        const hasBackwardLink = column.slice(i).some(right =>
                            [...outputsOf.get(right.id)].some(id => leftIds.has(id))
                        );
                        if (hasBackwardLink) continue;
                        split = i;
                        bestHeight = largest;
                    }
                }
                if (split) {
                    balancedColumns.push(column.slice(0, split), column.slice(split));
                    changed = true;
                } else {
                    balancedColumns.push(column);
                }
            }

            if (!changed) return;
            beginChange();
            columns.splice(0, columns.length, ...balancedColumns);
            placeColumns(columns, widths, x, y);
            endChange();
        }

        // --- 主题颜色应用 ---
        function applyThemeToVisuals() {
            if (!tianPanel) return;
            updateThemeColors();
            updateShortcutHint();
            if (autoArrangeMenu) applyAutoArrangeMenuTheme();

            // 中心发光环
            if (centerGlow) {
                centerGlow.setAttribute("fill", hexToRgba(THEME_COLOR, 0.12));
                centerGlow.setAttribute("stroke", hexToRgba(THEME_COLOR, 0.6));
                centerGlow.style.filter = `drop-shadow(0 0 8px ${hexToRgba(THEME_COLOR, 0.67)})`;
            }
            // 方向尺子
            if (dirArrow) {
                const body = dirArrow.querySelector("rect");
                const lines = dirArrow.querySelectorAll("line");
                if (body) {
                    body.setAttribute("stroke", GOLD);
                    body.style.filter = `drop-shadow(0 0 5px ${hexToRgba(THEME_COLOR, 0.5)})`;
                }
                lines.forEach(l => {
                    l.setAttribute("stroke", GOLD);
                });
            }
            // 长按进度环
            if (pressRing) {
                pressRing.setAttribute("stroke", GOLD);
                pressRing.style.filter = `drop-shadow(0 0 6px ${hexToRgba(THEME_COLOR, 0.7)})`;
            }

            // 如果当前有悬停状态，重新应用
            if (hoveredType || hoveredKey) {
                const curType = hoveredType, curKey = hoveredKey;
                hoveredType = null; hoveredKey = null;
                setHover(curType, curKey);
            }
        }

        function setThemeColor(hex) {
            THEME_COLOR = hex;
            localStorage.setItem("xiaozhuguang.tian.themeColor", hex);
            applyThemeToVisuals();
            alignQueueSave();
        }

        // --- 颜色设置菜单 ---
        function buildColorMenu() {
            if (colorMenu) return;
            // 注入样式隐藏number输入框箭头
            if (!document.getElementById("xzg-tian-color-menu-style")) {
                const style = document.createElement("style");
                style.id = "xzg-tian-color-menu-style";
                style.textContent = `
                    #xzg-tian-color-menu input[type="number"]::-webkit-outer-spin-button,
                    #xzg-tian-color-menu input[type="number"]::-webkit-inner-spin-button {
                        -webkit-appearance: none;
                        margin: 0;
                    }
                    #xzg-tian-color-menu input[type="number"] {
                        -moz-appearance: textfield;
                    }
                `;
                document.head.appendChild(style);
            }
            colorMenu = document.createElement("div");
            colorMenu.id = "xzg-tian-color-menu";
            colorMenu.style.cssText = `
                display:none; position:fixed; z-index:10001;
                background: rgba(20,20,20,0.92);
                border: 1px solid rgba(255,255,255,0.15);
                border-radius: 10px;
                padding: 12px;
                backdrop-filter: blur(10px);
                box-shadow: 0 6px 24px rgba(0,0,0,0.6);
                user-select:none;
                font-family: "Microsoft YaHei", sans-serif;
                width: 210px;
            `;

            // 标题
            const title = document.createElement("div");
            title.textContent = "面板颜色";
            title.style.cssText = "color:#fff; font-size:13px; margin-bottom:10px; text-align:center; font-weight:500;";
            colorMenu.appendChild(title);

            // 预设颜色网格
            const grid = document.createElement("div");
            grid.style.cssText = "display:grid; grid-template-columns:repeat(5, 1fr); gap:8px; margin-bottom:10px;";
            PRESET_COLORS.forEach(color => {
                const swatch = document.createElement("div");
                swatch.style.cssText = `
                    width: 30px; height: 30px; border-radius: 6px;
                    background: ${color}; cursor: pointer;
                    border: 2px solid transparent;
                    box-sizing: border-box;
                    transition: all 0.15s ease;
                `;
                swatch.title = color;
                swatch.addEventListener("mouseenter", () => {
                    swatch.style.borderColor = "rgba(255,255,255,0.5)";
                    swatch.style.transform = "scale(1.1)";
                });
                swatch.addEventListener("mouseleave", () => {
                    if (color.toUpperCase() !== THEME_COLOR.toUpperCase()) {
                        swatch.style.borderColor = "transparent";
                    }
                    swatch.style.transform = "scale(1)";
                });
                swatch.addEventListener("click", (e) => {
                    e.stopPropagation();
                    setThemeColor(color);
                    updateSwatchSelection();
                    hideColorMenu();
                });
                swatch.dataset.color = color;
                grid.appendChild(swatch);
            });
            colorMenu.appendChild(grid);

            // 自定义颜色行
            const customRow = document.createElement("div");
            customRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:10px;";
            const customLabel = document.createElement("span");
            customLabel.textContent = "自定义";
            customLabel.style.cssText = "color:#bbb; font-size:12px;";
            const customInput = document.createElement("input");
            customInput.type = "color";
            customInput.value = THEME_COLOR;
            customInput.style.cssText = `
                width: 30px; height: 26px; border: none; background: none;
                cursor: pointer; padding: 0;
            `;
            customInput.addEventListener("input", (e) => {
                setThemeColor(e.target.value);
                updateSwatchSelection();
                hideColorMenu();
            });
            customRow.appendChild(customLabel);
            customRow.appendChild(customInput);
            colorMenu.appendChild(customRow);

            // 分隔线
            const divider1 = document.createElement("div");
            divider1.style.cssText = "height:1px; background:rgba(255,255,255,0.1); margin:10px 0;";
            colorMenu.appendChild(divider1);

            // 上下等距标题
            const vGapTitle = document.createElement("div");
            vGapTitle.textContent = "上下等距间距";
            vGapTitle.style.cssText = "color:#fff; font-size:12px; margin-bottom:8px;";
            colorMenu.appendChild(vGapTitle);

            // 上下等距设置行
            const vGapRow = document.createElement("div");
            vGapRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:12px;";
            const vGapSlider = document.createElement("input");
            vGapSlider.type = "range";
            vGapSlider.min = "10";
            vGapSlider.max = "200";
            vGapSlider.value = V_GAP;
            vGapSlider.style.cssText = "flex:1; accent-color:#FFD700;";
            const vGapNum = document.createElement("input");
            vGapNum.type = "number";
            vGapNum.min = "10";
            vGapNum.max = "500";
            vGapNum.value = V_GAP;
            vGapNum.style.cssText = `
                width: 56px; height: 26px; background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.25); border-radius: 5px;
                color: #fff; font-size: 12px; text-align: center;
                outline: none; cursor: text;
                transition: border-color 0.15s, box-shadow 0.15s;
            `;
            vGapNum.addEventListener("focus", () => {
                vGapNum.style.borderColor = "#FFD700";
                vGapNum.style.boxShadow = "0 0 0 2px rgba(255,215,0,0.2)";
            });
            vGapNum.addEventListener("blur", () => {
                vGapNum.style.borderColor = "rgba(255,255,255,0.25)";
                vGapNum.style.boxShadow = "none";
            });
            vGapNum.addEventListener("click", (e) => e.stopPropagation());
            vGapNum.addEventListener("pointerdown", (e) => e.stopPropagation());
            vGapNum.addEventListener("mousedown", (e) => e.stopPropagation());
            function applyVGap(val) {
                val = parseInt(val);
                if (isNaN(val) || val < 10) val = 10;
                if (val > 500) val = 500;
                V_GAP = val;
                localStorage.setItem("xiaozhuguang.tian.vGap", val);
                alignQueueSave();
                vGapSlider.value = val;
                vGapNum.value = val;
            }
            vGapSlider.addEventListener("input", (e) => applyVGap(e.target.value));
            vGapNum.addEventListener("input", (e) => {
                const numVal = parseInt(e.target.value);
                if (!isNaN(numVal) && numVal >= 10 && numVal <= 500) {
                    vGapSlider.value = numVal;
                    V_GAP = numVal;
                    localStorage.setItem("xiaozhuguang.tian.vGap", numVal);
                    alignQueueSave();
                }
            });
            vGapNum.addEventListener("blur", () => applyVGap(vGapNum.value));
            vGapNum.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    applyVGap(vGapNum.value);
                    vGapNum.blur();
                }
            });
            vGapRow.appendChild(vGapSlider);
            vGapRow.appendChild(vGapNum);
            colorMenu.appendChild(vGapRow);

            // 左右等距标题
            const hGapTitle = document.createElement("div");
            hGapTitle.textContent = "左右等距间距";
            hGapTitle.style.cssText = "color:#fff; font-size:12px; margin-bottom:8px;";
            colorMenu.appendChild(hGapTitle);

            // 左右等距设置行
            const hGapRow = document.createElement("div");
            hGapRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:10px;";
            const hGapSlider = document.createElement("input");
            hGapSlider.type = "range";
            hGapSlider.min = "10";
            hGapSlider.max = "200";
            hGapSlider.value = H_GAP;
            hGapSlider.style.cssText = "flex:1; accent-color:#FFD700;";
            const hGapNum = document.createElement("input");
            hGapNum.type = "number";
            hGapNum.min = "10";
            hGapNum.max = "500";
            hGapNum.value = H_GAP;
            hGapNum.style.cssText = `
                width: 56px; height: 26px; background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.25); border-radius: 5px;
                color: #fff; font-size: 12px; text-align: center;
                outline: none; cursor: text;
                transition: border-color 0.15s, box-shadow 0.15s;
            `;
            hGapNum.addEventListener("focus", () => {
                hGapNum.style.borderColor = "#FFD700";
                hGapNum.style.boxShadow = "0 0 0 2px rgba(255,215,0,0.2)";
            });
            hGapNum.addEventListener("blur", () => {
                hGapNum.style.borderColor = "rgba(255,255,255,0.25)";
                hGapNum.style.boxShadow = "none";
            });
            hGapNum.addEventListener("click", (e) => e.stopPropagation());
            hGapNum.addEventListener("pointerdown", (e) => e.stopPropagation());
            hGapNum.addEventListener("mousedown", (e) => e.stopPropagation());
            function applyHGap(val) {
                val = parseInt(val);
                if (isNaN(val) || val < 10) val = 10;
                if (val > 500) val = 500;
                H_GAP = val;
                localStorage.setItem("xiaozhuguang.tian.hGap", val);
                alignQueueSave();
                hGapSlider.value = val;
                hGapNum.value = val;
            }
            hGapSlider.addEventListener("input", (e) => applyHGap(e.target.value));
            hGapNum.addEventListener("input", (e) => {
                const numVal = parseInt(e.target.value);
                if (!isNaN(numVal) && numVal >= 10 && numVal <= 500) {
                    hGapSlider.value = numVal;
                    H_GAP = numVal;
                    localStorage.setItem("xiaozhuguang.tian.hGap", numVal);
                    alignQueueSave();
                }
            });
            hGapNum.addEventListener("blur", () => applyHGap(hGapNum.value));
            hGapNum.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    applyHGap(hGapNum.value);
                    hGapNum.blur();
                }
            });
            hGapRow.appendChild(hGapSlider);
            hGapRow.appendChild(hGapNum);
            colorMenu.appendChild(hGapRow);

            // 分隔线
            const divider2 = document.createElement("div");
            divider2.style.cssText = "height:1px; background:rgba(255,255,255,0.1); margin:10px 0;";
            colorMenu.appendChild(divider2);

            // 快捷键标题
            const shortcutTitle = document.createElement("div");
            shortcutTitle.textContent = "面板快捷键";
            shortcutTitle.style.cssText = "color:#fff; font-size:12px; margin-bottom:8px;";
            colorMenu.appendChild(shortcutTitle);

            // 快捷键设置行
            const shortcutRow = document.createElement("div");
            shortcutRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:10px;";

            const shortcutDisplay = document.createElement("div");
            shortcutDisplay.style.cssText = `
                flex:1; height: 26px; background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.25); border-radius: 5px;
                color: #fff; font-size: 12px; text-align: center;
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; user-select: none;
                transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
            `;
            shortcutDisplay.textContent = formatShortcut(SHORTCUT);
            shortcutDisplay.title = "点击修改快捷键";

            let tempShortcut = null;

            function startRecording() {
                recordingShortcut = true;
                tempShortcut = { key: "", alt: false, ctrl: false, shift: false, meta: false };
                shortcutDisplay.textContent = "按下快捷键...";
                shortcutDisplay.style.borderColor = "#FFD700";
                shortcutDisplay.style.boxShadow = "0 0 0 2px rgba(255,215,0,0.2)";
                shortcutDisplay.style.background = "rgba(255,215,0,0.1)";
            }

            function stopRecording(save) {
                recordingShortcut = false;
                shortcutDisplay.style.borderColor = "rgba(255,255,255,0.25)";
                shortcutDisplay.style.boxShadow = "none";
                shortcutDisplay.style.background = "rgba(255,255,255,0.08)";
                if (save && tempShortcut && tempShortcut.key) {
                    SHORTCUT = { ...tempShortcut };
                    updateShortcutHint();
                    localStorage.setItem("xiaozhuguang.tian.shortcut", JSON.stringify(SHORTCUT));
                    alignQueueSave();
                }
                shortcutDisplay.textContent = formatShortcut(SHORTCUT);
                tempShortcut = null;
            }

            shortcutDisplay.addEventListener("click", (e) => {
                e.stopPropagation();
                if (recordingShortcut) {
                    stopRecording(false);
                } else {
                    startRecording();
                }
            });

            shortcutDisplay.addEventListener("mouseenter", () => {
                if (!recordingShortcut) {
                    shortcutDisplay.style.borderColor = "rgba(255,215,0,0.5)";
                }
            });
            shortcutDisplay.addEventListener("mouseleave", () => {
                if (!recordingShortcut) {
                    shortcutDisplay.style.borderColor = "rgba(255,255,255,0.25)";
                }
            });

            shortcutRow.appendChild(shortcutDisplay);
            colorMenu.appendChild(shortcutRow);

            // 重置按钮
            const resetBtn = document.createElement("div");
            resetBtn.textContent = "恢复默认";
            resetBtn.style.cssText = `
                text-align:center; color:#aaa; font-size:12px;
                padding: 5px 0; cursor:pointer; border-radius: 5px;
                transition: all 0.15s;
            `;
            resetBtn.addEventListener("mouseenter", () => {
                resetBtn.style.color = "#FFD700";
                resetBtn.style.background = "rgba(255,215,0,0.1)";
            });
            resetBtn.addEventListener("mouseleave", () => {
                resetBtn.style.color = "#aaa";
                resetBtn.style.background = "transparent";
            });
            resetBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                setThemeColor(DEFAULT_THEME);
                customInput.value = DEFAULT_THEME;
                applyVGap(DEFAULT_V_GAP);
                applyHGap(DEFAULT_H_GAP);
                SHORTCUT = { ...DEFAULT_SHORTCUT };
                updateShortcutHint();
                localStorage.setItem("xiaozhuguang.tian.shortcut", JSON.stringify(SHORTCUT));
                alignQueueSave();
                shortcutDisplay.textContent = formatShortcut(SHORTCUT);
                updateSwatchSelection();
                hideColorMenu();
            });
            colorMenu.appendChild(resetBtn);

            function updateSwatchSelection() {
                const swatches = grid.querySelectorAll("div");
                swatches.forEach(s => {
                    if (s.dataset.color.toUpperCase() === THEME_COLOR.toUpperCase()) {
                        s.style.borderColor = "#fff";
                    } else {
                        s.style.borderColor = "transparent";
                    }
                });
            }
            // 初始选中状态
            updateSwatchSelection();

            function handleRecordKey(e) {
                if (!recordingShortcut) return;
                e.preventDefault();
                e.stopPropagation();

                if (e.key === "Escape") {
                    stopRecording(false);
                    return;
                }

                const key = e.key.toLowerCase();
                const isModifier = ["control", "alt", "shift", "meta"].includes(key);

                tempShortcut.ctrl = e.ctrlKey;
                tempShortcut.alt = e.altKey;
                tempShortcut.shift = e.shiftKey;
                tempShortcut.meta = e.metaKey;

                if (!isModifier && key.length === 1) {
                    tempShortcut.key = key;
                    stopRecording(true);
                } else if (!isModifier && e.key.startsWith("F") && e.key.length <= 3) {
                    tempShortcut.key = e.key.toLowerCase();
                    stopRecording(true);
                } else {
                    shortcutDisplay.textContent = formatShortcut(tempShortcut) + " + ...";
                }
            }
            document.addEventListener("keydown", handleRecordKey, true);

            colorMenu._cancelShortcutRecording = () => {
                if (recordingShortcut) stopRecording(false);
            };
            colorMenu._customInput = customInput;
            colorMenu._shortcutDisplay = shortcutDisplay;
            colorMenu._updateShortcutDisplay = function() {
                shortcutDisplay.textContent = formatShortcut(SHORTCUT);
            };
            document.body.appendChild(colorMenu);
        }

        function showColorMenu(clientX, clientY) {
            buildColorMenu();
            colorMenu.style.display = "block";
            colorMenuOpen = true;

            // 定位到鼠标位置，自动检测边界
            const rect = colorMenu.getBoundingClientRect();
            let left = clientX + 10;
            let top = clientY;
            if (left + rect.width > window.innerWidth) left = clientX - rect.width - 10;
            if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 10;
            if (left < 10) left = 10;
            if (top < 10) top = 10;
            colorMenu.style.left = left + "px";
            colorMenu.style.top = top + "px";

            // 更新自定义颜色输入值
            if (colorMenu._customInput) colorMenu._customInput.value = THEME_COLOR;
            // 更新快捷键显示
            if (colorMenu._updateShortcutDisplay) colorMenu._updateShortcutDisplay();
        }

        function hideColorMenu() {
            if (colorMenu) {
                colorMenu._cancelShortcutRecording();
                colorMenu.style.display = "none";
            }
            colorMenuOpen = false;
        }

        // --- 命中检测 ---
        function hitTest(mx, my) {
            // 范围检查
            if (mx < PAD-4 || mx > TIAN_SIZE-PAD+4 || my < PAD-4 || my > TIAN_SIZE-PAD+4) {
                return { type: null, key: null };
            }

            // 中心区域 → 等宽/等高
            const cdx = mx - CX, cdy = my - CY;
            if (Math.hypot(cdx, cdy) < CENTER_RADIUS) {
                return { type: "center", key: "center" };
            }

            // 计算到6条线的距离
            const dists = {};
            for (const key of LINE_KEYS) {
                const L = LINES[key];
                if (L.type === "v") {
                    if (my < PAD || my > TIAN_SIZE - PAD) { dists[key] = Infinity; continue; }
                    dists[key] = Math.abs(mx - L.x);
                } else {
                    if (mx < PAD || mx > TIAN_SIZE - PAD) { dists[key] = Infinity; continue; }
                    dists[key] = Math.abs(my - L.y);
                }
            }

            // 找最近的线
            let bestLine = null, bestLineDist = Infinity;
            for (const k of LINE_KEYS) {
                if (dists[k] < bestLineDist) { bestLineDist = dists[k]; bestLine = k; }
            }

            // 如果离某条线很近 → 线对齐模式
            if (bestLineDist <= HIT_LINE) {
                return { type: "line", key: bestLine };
            }

            // 否则判断区域分布模式：看离哪个边缘更近
            const dLeft   = mx - PAD;
            const dRight  = (TIAN_SIZE - PAD) - mx;
            const dTop    = my - PAD;
            const dBottom = (TIAN_SIZE - PAD) - my;

            // 在格子内部，判断更偏哪个方向
            // 比较水平方向和垂直方向哪个更"靠边"
            const hMin = Math.min(dLeft, dRight);
            const vMin = Math.min(dTop, dBottom);

            if (hMin < vMin) {
                // 更靠近左右边 → 垂直分布
                if (dLeft < dRight) return { type: "zone", key: "z_left" };
                else return { type: "zone", key: "z_right" };
            } else {
                // 更靠近上下边 → 水平分布
                if (dTop < dBottom) return { type: "zone", key: "z_top" };
                else return { type: "zone", key: "z_bottom" };
            }
        }

        // --- 重置所有视觉状态 ---
        function resetVisuals() {
            LINE_KEYS.forEach(k => {
                const el = svgLineEls[k];
                el.setAttribute("stroke", LINE_COLOR);
                el.setAttribute("stroke-width", "1.5");
                el.style.filter = "none";
            });
            svgQuadEls.forEach(el => {
                el.setAttribute("fill", "none");
                el.setAttribute("stroke", "none");
            });
            centerDot.setAttribute("fill", "rgba(194,194,194,0.5)");
            if (centerGlow) {
                centerGlow.setAttribute("opacity", "0");
            }
            if (dirArrow) {
                dirArrow.setAttribute("opacity", "0");
            }
            if (pressRing) {
                pressRing.setAttribute("opacity", "0");
            }
            if (overlay) overlay.style.cursor = "default";
            const tipEl = document.getElementById("xzg-tian-tip");
            if (tipEl) {
                tipEl.style.opacity = "0";
                tipEl.style.left = "50%";
                tipEl.style.top = "50%";
                tipEl.style.transform = "translate(-50%,-50%)";
                tipEl.style.writingMode = "horizontal-tb";
                tipEl.style.textOrientation = "initial";
            }
        }

        function dimAllLines() {
            LINE_KEYS.forEach(k => {
                const el = svgLineEls[k];
                el.setAttribute("stroke", LINE_DIM);
                el.setAttribute("stroke-width", "1.5");
                el.style.filter = "none";
            });
        }

        function setHover(htype, hkey) {
            if (hoveredType === htype && hoveredKey === hkey) return;
            hoveredType = htype;
            hoveredKey = hkey;

            resetVisuals();

            const tipEl = document.getElementById("xzg-tian-tip");

            if (!htype) {
                if (tipEl) tipEl.style.opacity = "0";
                return;
            }

            if (htype === "line") {
                // 线对齐模式：对应线变亮，其他线变暗，格子不亮
                dimAllLines();
                const el = svgLineEls[hkey];
                el.setAttribute("stroke", GOLD);
                el.setAttribute("stroke-width", "3");
                el.style.filter = `drop-shadow(0 0 6px ${GOLD}aa)`;
                centerDot.setAttribute("fill", GOLD);
                overlay.style.cursor = "pointer";
                if (tipEl) tipEl.style.opacity = "0";
            } else if (htype === "zone") {
                // 区域分布模式：对应两个格子亮起，线条变暗
                dimAllLines();
                const z = ZONES[hkey];
                z.quads.forEach(qi => {
                    const el = svgQuadEls[qi];
                    el.setAttribute("fill", QZONE_BG);
                    el.setAttribute("stroke", QZONE_BORDER);
                    el.setAttribute("stroke-width", "1");
                });
                centerDot.setAttribute("fill", GOLD);
                if (centerGlow) centerGlow.setAttribute("opacity", "0");
                overlay.style.cursor = "pointer";
                // 显示提示文字
                if (tipEl) {
                    const tips = {
                        z_left: "上下等分",
                        z_right: "上下等距",
                        z_top: "左右等分",
                        z_bottom: "左右等距"
                    };
                    tipEl.textContent = tips[hkey] || "";
                    tipEl.style.color = GOLD;
                    tipEl.style.textShadow = `0 0 6px rgba(0,0,0,0.9), 0 0 12px ${hexToRgba(THEME_COLOR, 0.5)}`;
                    // 重置transform
                    tipEl.style.left = "50%";
                    tipEl.style.top = "50%";
                    tipEl.style.transform = "translate(-50%,-50%)";
                    if (hkey === "z_left" || hkey === "z_right") {
                        tipEl.style.writingMode = "vertical-rl";
                        tipEl.style.textOrientation = "upright";
                        // 竖排：左右区域的文字放在对应半边，避开中心线
                        if (hkey === "z_left") {
                            tipEl.style.left = (PAD + (CX - PAD) / 2) + "px";
                        } else {
                            tipEl.style.left = (CX + (CX - PAD) / 2) + "px";
                        }
                        tipEl.style.transform = "translate(-50%, calc(-50% + 6px))";
                    } else {
                        tipEl.style.writingMode = "horizontal-tb";
                        tipEl.style.textOrientation = "initial";
                        // 横排：上下区域的文字放在对应半边，避开中心线
                        if (hkey === "z_top") {
                            tipEl.style.top = (PAD + (CY - PAD) / 2) + "px";
                        } else {
                            tipEl.style.top = (CY + (CY - PAD) / 2) + "px";
                        }
                        tipEl.style.transform = "translate(calc(-50% + 6px),-50%)";
                    }
                    tipEl.style.opacity = "1";
                }
            } else if (htype === "center") {
                // 中心模式：中心发光 + 所有线和格子变暗
                dimAllLines();
                svgQuadEls.forEach(el => {
                    el.setAttribute("fill", "none");
                    el.setAttribute("stroke", "none");
                });
                centerDot.setAttribute("fill", GOLD);
                if (centerGlow) centerGlow.setAttribute("opacity", "1");
                overlay.style.cursor = "pointer";
                if (tipEl) tipEl.style.opacity = "0";
            }
        }

        function executeAction(htype, hkey) {
            if (!htype) { closeTianPanel(); return; }
            if (getSelectedNodes().length < 2) { closeTianPanel(); return; }
            if (htype === "line") {
                const fn = ALIGN_FN[hkey];
                if (fn) fn();
            } else if (htype === "zone") {
                const fn = ZONE_FN[hkey];
                if (fn) fn();
            } else if (htype === "center") {
                centerSameSize();
            }
            closeTianPanel();
        }

        // --- 构建面板 ---
        function buildTianPanel() {
            if (tianPanel) return;
            tianPanel = document.createElement("div");
            tianPanel.id = "xzg-tian-panel";
            tianPanel.style.cssText = `
                display:none; position:fixed; z-index:10000;
                width:${TIAN_SIZE}px; height:${TIAN_SIZE}px;
                left:50%; top:50%;
                margin-left:-${TIAN_SIZE/2}px; margin-top:-${TIAN_SIZE/2}px;
                user-select:none;
                border-radius:14px;
                background: rgba(18,18,18,0.65);
                border: 1.5px solid rgba(194,194,194,0.28);
                box-shadow: 0 8px 40px rgba(0,0,0,0.55);
                backdrop-filter: blur(10px);
            `;

            const svgNS = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(svgNS, "svg");
            svg.setAttribute("width", TIAN_SIZE);
            svg.setAttribute("height", TIAN_SIZE);
            svg.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;display:block;";

            // 外框
            frameEl = document.createElementNS(svgNS, "rect");
            frameEl.setAttribute("x", PAD-5); frameEl.setAttribute("y", PAD-5);
            frameEl.setAttribute("width", TIAN_SIZE - 2*(PAD-5));
            frameEl.setAttribute("height", TIAN_SIZE - 2*(PAD-5));
            frameEl.setAttribute("rx", "8");
            frameEl.setAttribute("fill", "none");
            frameEl.setAttribute("stroke", "rgba(194,194,194,0.1)");
            frameEl.setAttribute("stroke-width", "1");
            svg.appendChild(frameEl);

            // 对角线装饰
            [[PAD,PAD,TIAN_SIZE-PAD,TIAN_SIZE-PAD],[TIAN_SIZE-PAD,PAD,PAD,TIAN_SIZE-PAD]].forEach(([x1,y1,x2,y2])=>{
                const d = document.createElementNS(svgNS,"line");
                d.setAttribute("x1",x1);d.setAttribute("y1",y1);
                d.setAttribute("x2",x2);d.setAttribute("y2",y2);
                d.setAttribute("stroke","rgba(194,194,194,0.06)");
                d.setAttribute("stroke-width","1");
                d.setAttribute("stroke-dasharray","3,5");
                svg.appendChild(d);
            });

            // 4个格子 (可高亮，先画在线下面)
            const quadDefs = [
                { x: PAD, y: PAD, w: CX-PAD, h: CY-PAD },      // 0 左上
                { x: CX,  y: PAD, w: CX-PAD, h: CY-PAD },      // 1 右上
                { x: PAD, y: CY,  w: CX-PAD, h: CY-PAD },      // 2 左下
                { x: CX,  y: CY,  w: CX-PAD, h: CY-PAD },      // 3 右下
            ];
            svgQuadEls = [];
            quadDefs.forEach(q => {
                const rect = document.createElementNS(svgNS, "rect");
                rect.setAttribute("x", q.x);
                rect.setAttribute("y", q.y);
                rect.setAttribute("width", q.w);
                rect.setAttribute("height", q.h);
                rect.setAttribute("fill", "none");
                rect.setAttribute("stroke", "none");
                rect.setAttribute("rx", "3");
                svg.appendChild(rect);
                svgQuadEls.push(rect);
            });

            // 6条线
            function mkLine(x1,y1,x2,y2,key) {
                const l = document.createElementNS(svgNS,"line");
                l.setAttribute("x1",x1);l.setAttribute("y1",y1);
                l.setAttribute("x2",x2);l.setAttribute("y2",y2);
                l.setAttribute("stroke",LINE_COLOR);
                l.setAttribute("stroke-width","1.5");
                l.setAttribute("stroke-linecap","round");
                svg.appendChild(l);
                svgLineEls[key] = l;
            }
            mkLine(PAD, PAD, PAD, TIAN_SIZE-PAD, "v_left");
            mkLine(CX,  PAD, CX,  TIAN_SIZE-PAD, "v_mid");
            mkLine(TIAN_SIZE-PAD, PAD, TIAN_SIZE-PAD, TIAN_SIZE-PAD, "v_right");
            mkLine(PAD, PAD, TIAN_SIZE-PAD, PAD, "h_top");
            mkLine(PAD, CY,  TIAN_SIZE-PAD, CY,  "h_mid");
            mkLine(PAD, TIAN_SIZE-PAD, TIAN_SIZE-PAD, TIAN_SIZE-PAD, "h_bottom");

            // 中心圆点
            centerDot = document.createElementNS(svgNS, "circle");
            centerDot.setAttribute("cx", CX); centerDot.setAttribute("cy", CY);
            centerDot.setAttribute("r", "3.5");
            centerDot.setAttribute("fill", "rgba(194,194,194,0.5)");
            svg.appendChild(centerDot);

            // 中心发光环 (悬停时显示)
            centerGlow = document.createElementNS(svgNS, "circle");
            centerGlow.setAttribute("cx", CX); centerGlow.setAttribute("cy", CY);
            centerGlow.setAttribute("r", CENTER_RADIUS);
            centerGlow.setAttribute("fill", hexToRgba(THEME_COLOR, 0.12));
            centerGlow.setAttribute("stroke", hexToRgba(THEME_COLOR, 0.6));
            centerGlow.setAttribute("stroke-width", "1.5");
            centerGlow.setAttribute("opacity", "0");
            centerGlow.style.filter = `drop-shadow(0 0 8px ${hexToRgba(THEME_COLOR, 0.67)})`;
            svg.appendChild(centerGlow);

            // 长按进度环（扩张动画）
            pressRing = document.createElementNS(svgNS, "circle");
            pressRing.setAttribute("cx", CX); pressRing.setAttribute("cy", CY);
            pressRing.setAttribute("r", CENTER_RADIUS);
            pressRing.setAttribute("fill", "none");
            pressRing.setAttribute("stroke", GOLD);
            pressRing.setAttribute("stroke-width", "2");
            pressRing.setAttribute("opacity", "0");
            pressRing.style.filter = `drop-shadow(0 0 6px ${hexToRgba(THEME_COLOR, 0.7)})`;
            svg.appendChild(pressRing);

            // 尺子（拖拽时显示）
            dirArrow = document.createElementNS(svgNS, "g");
            dirArrow.setAttribute("opacity", "0");
            // 尺子主体（长条矩形，居中）
            const rulerBody = document.createElementNS(svgNS, "rect");
            rulerBody.setAttribute("x", -8); rulerBody.setAttribute("y", -30);
            rulerBody.setAttribute("width", 16); rulerBody.setAttribute("height", 60);
            rulerBody.setAttribute("rx", 3);
            rulerBody.setAttribute("fill", "rgba(30,30,30,0.85)");
            rulerBody.setAttribute("stroke", GOLD);
            rulerBody.setAttribute("stroke-width", "1.5");
            rulerBody.style.filter = `drop-shadow(0 0 6px ${hexToRgba(THEME_COLOR, 0.5)})`;
            dirArrow.appendChild(rulerBody);
            // 中心0刻度
            const zeroTick = document.createElementNS(svgNS, "line");
            zeroTick.setAttribute("x1", -8); zeroTick.setAttribute("y1", 0);
            zeroTick.setAttribute("x2", 8); zeroTick.setAttribute("y2", 0);
            zeroTick.setAttribute("stroke", GOLD);
            zeroTick.setAttribute("stroke-width", "1.5");
            dirArrow.appendChild(zeroTick);
            // 刻度线（向两侧对称）
            for (let i = 1; i <= 3; i++) {
                const y = i * 10;
                const isLong = i % 2 === 0;
                // 正向
                const t1 = document.createElementNS(svgNS, "line");
                t1.setAttribute("x1", -8); t1.setAttribute("y1", y);
                t1.setAttribute("x2", isLong ? 8 : -4); t1.setAttribute("y2", y);
                t1.setAttribute("stroke", GOLD); t1.setAttribute("stroke-width", "1"); t1.setAttribute("opacity", "0.7");
                dirArrow.appendChild(t1);
                // 负向
                const t2 = document.createElementNS(svgNS, "line");
                t2.setAttribute("x1", -8); t2.setAttribute("y1", -y);
                t2.setAttribute("x2", isLong ? 8 : -4); t2.setAttribute("y2", -y);
                t2.setAttribute("stroke", GOLD); t2.setAttribute("stroke-width", "1"); t2.setAttribute("opacity", "0.7");
                dirArrow.appendChild(t2);
            }
            // 定位到中心
            dirArrow.setAttribute("transform", `translate(${CX}, ${CY})`);
            svg.appendChild(dirArrow);

            tianPanel.appendChild(svg);

            // 提示文字
            const tipEl = document.createElement("div");
            tipEl.id = "xzg-tian-tip";
            tipEl.style.cssText = `
                position:absolute; left:50%; top:50%;
                transform:translate(-50%,-50%);
                color:#fff; font-size:18px; font-family:"Microsoft YaHei",sans-serif;
                pointer-events:none;
                text-shadow:0 0 6px rgba(0,0,0,0.9), 0 0 10px rgba(255,215,0,0.3);
                opacity:0; transition:opacity 0.2s ease;
                font-weight:500;
                letter-spacing:12px;
                white-space:nowrap;
            `;
            tianPanel.appendChild(tipEl);

            shortcutHint = document.createElement("div");
            shortcutHint.className = "xzg-tian-shortcut-hint";
            shortcutHint.style.cssText = `
                position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
                border-radius:6px; background:#181818; padding:5px 10px;
                font-size:34px; font-weight:600; white-space:nowrap; pointer-events:none;
            `;
            const hintStyle = document.createElement("style");
            hintStyle.textContent = `
                #xzg-tian-panel > .xzg-tian-shortcut-hint { display:none; }
                #xzg-tian-panel[data-selection-open] > :not(.xzg-tian-shortcut-hint) { display:none; }
                #xzg-tian-panel[data-selection-open] > .xzg-tian-shortcut-hint { display:block; }
            `;
            tianPanel.append(shortcutHint, hintStyle);

            // 交互覆盖层
            overlay = document.createElement("div");
            overlay.style.cssText = `
                position:absolute;left:0;top:0;
                width:100%;height:100%;
                cursor:default;
                border-radius:14px;
            `;
            function getLocal(e) {
                const r = overlay.getBoundingClientRect();
                return {
                    x: (e.clientX - r.left) * TIAN_SIZE / r.width,
                    y: (e.clientY - r.top) * TIAN_SIZE / r.height,
                };
            }
            function isInCenter(x, y) {
                return Math.hypot(x - CX, y - CY) < CENTER_RADIUS;
            }

            function updateArrow(dx, dy, confirmed) {
                if (!dirArrow) return;
                const absDx = Math.abs(dx), absDy = Math.abs(dy);
                const dist = Math.hypot(dx, dy);
                if (dist < 4) { dirArrow.setAttribute("opacity", "0"); return; }
                dirArrow.setAttribute("opacity", "1");

                // 只允许水平或垂直方向（吸附到最近的轴）
                let angle, showDist, isHorizontal;
                if (absDx >= absDy) {
                    isHorizontal = true;
                    angle = dx >= 0 ? 90 : -90; // 朝右或朝左
                    showDist = absDx;
                } else {
                    isHorizontal = false;
                    angle = dy >= 0 ? 180 : 0; // 朝下或朝上
                    showDist = absDy;
                }

                // 超出阈值时更亮
                const overThreshold = showDist >= DRAG_THRESHOLD;
                const color = overThreshold ? GOLD : hexToRgba(THEME_COLOR, 0.8);
                const bodyFill = overThreshold ? "rgba(30,30,30,0.9)" : "rgba(30,30,30,0.75)";

                // 尺子长度：根据拖动距离，向两侧对称延伸
                const halfLen = Math.min(45, Math.max(17, showDist));
                const rulerW = 16;

                // 更新尺子主体（居中，上下/左右对称）
                const body = dirArrow.querySelector("rect");
                if (body) {
                    body.setAttribute("x", -rulerW/2);
                    body.setAttribute("y", -halfLen);
                    body.setAttribute("height", halfLen * 2);
                    body.setAttribute("fill", bodyFill);
                    body.setAttribute("stroke", color);
                    body.style.filter = `drop-shadow(0 0 ${overThreshold ? 8 : 5}px ${hexToRgba(THEME_COLOR, overThreshold ? 0.7 : 0.4)})`;
                }

                // 更新刻度线 - 先清除旧的再重画
                const oldTicks = dirArrow.querySelectorAll("line");
                oldTicks.forEach(t => t.remove());

                // 重新画刻度（从中心向两侧对称）
                const tickCount = Math.floor(halfLen / 10);
                const svgNS = "http://www.w3.org/2000/svg";
                // 0刻度（中心）
                const zeroTick = document.createElementNS(svgNS, "line");
                zeroTick.setAttribute("x1", -rulerW/2); zeroTick.setAttribute("y1", 0);
                zeroTick.setAttribute("x2", rulerW/2); zeroTick.setAttribute("y2", 0);
                zeroTick.setAttribute("stroke", color);
                zeroTick.setAttribute("stroke-width", "1.5");
                dirArrow.insertBefore(zeroTick, dirArrow.firstChild?.nextSibling || null);

                for (let i = 1; i <= tickCount; i++) {
                    const y = i * 10;
                    if (y > halfLen - 2) break;
                    const isLong = i % 2 === 0;
                    // 正向刻度
                    const tick1 = document.createElementNS(svgNS, "line");
                    tick1.setAttribute("x1", -rulerW/2);
                    tick1.setAttribute("y1", y);
                    tick1.setAttribute("x2", isLong ? rulerW/2 : -rulerW/2 + 4);
                    tick1.setAttribute("y2", y);
                    tick1.setAttribute("stroke", color);
                    tick1.setAttribute("stroke-width", "1");
                    tick1.setAttribute("opacity", overThreshold ? "0.9" : "0.6");
                    dirArrow.insertBefore(tick1, dirArrow.firstChild?.nextSibling || null);
                    // 负向刻度（对称）
                    const tick2 = document.createElementNS(svgNS, "line");
                    tick2.setAttribute("x1", -rulerW/2);
                    tick2.setAttribute("y1", -y);
                    tick2.setAttribute("x2", isLong ? rulerW/2 : -rulerW/2 + 4);
                    tick2.setAttribute("y2", -y);
                    tick2.setAttribute("stroke", color);
                    tick2.setAttribute("stroke-width", "1");
                    tick2.setAttribute("opacity", overThreshold ? "0.9" : "0.6");
                    dirArrow.insertBefore(tick2, dirArrow.firstChild?.nextSibling || null);
                }

                dirArrow.setAttribute("transform",
                    `translate(${CX}, ${CY}) rotate(${angle})`);
            }

            let pressRAF = null;
            function updatePressRing(progress) {
                if (!pressRing) return;
                const r = CENTER_RADIUS + 6;
                pressRing.setAttribute("r", r);
                pressRing.setAttribute("stroke", GOLD);
                pressRing.setAttribute("opacity", 0.5 + progress * 0.5);
                const circumference = 2 * Math.PI * r;
                pressRing.setAttribute("stroke-dasharray", circumference);
                pressRing.setAttribute("stroke-dashoffset", circumference * (1 - progress));
                pressRing.style.filter = `drop-shadow(0 0 ${4 + progress * 6}px ${hexToRgba(THEME_COLOR, 0.6 + progress * 0.4)})`;
            }
            function playSuccessAnimation() {
                if (successRAF) cancelAnimationFrame(successRAF);
                const startTime = performance.now();
                const duration = 300;
                function tick() {
                    const elapsed = performance.now() - startTime;
                    const t = Math.min(1, elapsed / duration);
                    const easeOut = 1 - Math.pow(1 - t, 3);
                    if (pressRing) {
                        pressRing.setAttribute("opacity", 1 - easeOut);
                        pressRing.setAttribute("stroke-width", 2 + easeOut * 3);
                    }
                    if (centerGlow) {
                        centerGlow.setAttribute("opacity", 1 - easeOut * 0.5);
                    }
                    if (t < 1) {
                        successRAF = requestAnimationFrame(tick);
                    } else {
                        successRAF = null;
                        const layout = autoArrange();
                        if (layout) showAutoArrangeMenu(layout);
                        else closeTianPanel();
                    }
                }
                successRAF = requestAnimationFrame(tick);
            }
            function startLongPress() {
                if (pressTimer) clearTimeout(pressTimer);
                if (pressRAF) cancelAnimationFrame(pressRAF);
                if (successRAF) cancelAnimationFrame(successRAF);
                pressStartTime = performance.now();
                if (pressRing) {
                    pressRing.setAttribute("opacity", "0.5");
                    pressRing.setAttribute("r", CENTER_RADIUS + 6);
                    pressRing.setAttribute("stroke-width", "2");
                    pressRing.setAttribute("stroke-dashoffset", 2 * Math.PI * (CENTER_RADIUS + 6));
                    pressRing.setAttribute("transform-origin", `${CX}px ${CY}px`);
                    pressRing.setAttribute("transform", "rotate(-90deg)");
                }
                function tick() {
                    const elapsed = performance.now() - pressStartTime;
                    const progress = Math.min(1, elapsed / LONG_PRESS_MS);
                    updatePressRing(progress);
                    const pulse = 0.8 + 0.2 * Math.sin(elapsed / 180);
                    if (centerGlow) {
                        centerGlow.setAttribute("opacity", pulse);
                    }
                    if (progress < 1 && centerDrag && centerDrag.active && !centerDrag.dragging) {
                        pressRAF = requestAnimationFrame(tick);
                    }
                }
                pressRAF = requestAnimationFrame(tick);
                pressTimer = setTimeout(() => {
                    if (centerDrag && centerDrag.active && !centerDrag.dragging) {
                        cancelLongPress();
                        centerDrag = null;
                        playSuccessAnimation();
                    }
                }, LONG_PRESS_MS);
            }
            function cancelLongPress() {
                if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
                if (pressRAF) { cancelAnimationFrame(pressRAF); pressRAF = null; }
                if (successRAF) { cancelAnimationFrame(successRAF); successRAF = null; }
                if (pressRing) {
                    pressRing.setAttribute("opacity", "0");
                    pressRing.setAttribute("stroke-width", "2");
                    pressRing.setAttribute("transform", "rotate(-90deg)");
                }
            }

            overlay.addEventListener("mousemove", (e) => {
                const { x, y } = getLocal(e);

                if (centerDrag && centerDrag.active) {
                    const dx = x - centerDrag.startX;
                    const dy = y - centerDrag.startY;
                    centerDrag.lastDx = dx;
                    centerDrag.lastDy = dy;

                    const dist = Math.hypot(dx, dy);
                    // 超过轻微移动阈值才显示尺子（区分单击和拖拽）
                    if (dist >= 5) {
                        if (!centerDrag.dragging) {
                            centerDrag.dragging = true;
                            cancelLongPress();
                        }
                        updateArrow(dx, dy, false);
                    }
                    // 保持中心发光
                    if (centerGlow) centerGlow.setAttribute("opacity", "1");
                    if (centerDot) centerDot.setAttribute("fill", GOLD);
                    return;
                }

                const r = hitTest(x, y);
                setHover(r.type, r.key);
            });
            overlay.addEventListener("mouseleave", () => {
                if (centerDrag && centerDrag.active) return;
                setHover(null, null);
            });
            overlay.addEventListener("mousedown", (e) => {
                if (e.button !== 0 || successRAF) return;
                if (colorMenuOpen) { hideColorMenu(); return; }
                const { x, y } = getLocal(e);
                if (isInCenter(x, y)) {
                    e.preventDefault();
                    e.stopPropagation();
                    centerDrag = { startX: x, startY: y, active: true, dragging: false };
                    setHover("center", "center");
                    startLongPress();
                }
            });
            overlay.addEventListener("click", (e) => {
                if (successRAF) return;
                if (colorMenuOpen) { hideColorMenu(); return; }
                if (wasCenterDrag) {
                    wasCenterDrag = false;
                    return;
                }
                const { x, y } = getLocal(e);
                // 中心区域点击不执行操作（需要拖拽）
                if (isInCenter(x, y)) return;
                const r = hitTest(x, y);
                executeAction(r.type, r.key);
            });
            document.addEventListener("mouseup", () => {
                if (centerDrag && centerDrag.active) {
                    cancelLongPress();

                    if (centerDrag.dragging) {
                        const dx = centerDrag.lastDx || 0;
                        const dy = centerDrag.lastDy || 0;
                        const absDx = Math.abs(dx), absDy = Math.abs(dy);

                        // 只要拖动就执行等宽/等高，不设阈值
                        const hadAction = getSelectedNodes().length >= 2;
                        if (hadAction) {
                            if (absDx >= absDy) {
                                sameWidth();
                            } else {
                                sameHeight();
                            }
                        }

                        // 标记刚结束中心拖动，抑制后续 click 误触
                        wasCenterDrag = true;
                        centerDrag = null;
                        if (dirArrow) dirArrow.setAttribute("opacity", "0");
                        closeTianPanel();
                    } else {
                        // 没有拖拽，是短按（未达2秒）→ 不执行任何操作
                        centerDrag = null;
                        setHover(null, null);
                    }
                }
            });
            overlay.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (successRAF) return;
                if (centerDrag && centerDrag.active) {
                    cancelLongPress();
                    centerDrag = null;
                    if (dirArrow) dirArrow.setAttribute("opacity", "0");
                }
                setHover(null, null);
                showColorMenu(e.clientX, e.clientY);
            });

            tianPanel.appendChild(overlay);
            document.body.appendChild(tianPanel);
        }

        function applyAutoArrangeMenuTheme() {
            const style = autoArrangeMenu.style;
            style.setProperty("--xzg-align-color", GOLD);
            style.setProperty("--xzg-align-fill", QZONE_BG);
            style.setProperty("--xzg-align-border", QZONE_BORDER);
            style.setProperty("--xzg-align-hover", hexToRgba(THEME_COLOR, 0.24));
        }

        function showAutoArrangeMenu(layout) {
            autoArrangeMenu = document.createElement("div");
            autoArrangeMenu.id = "xzg-auto-arrange-menu";
            autoArrangeMenu.style.cssText = `
                position:absolute; inset:0; display:flex; flex-direction:column;
                justify-content:center; gap:8px; padding:20px;
                border-radius:inherit; background:#181818;
            `;
            updateThemeColors();
            applyAutoArrangeMenuTheme();
            const actions = [
                ["高度居中", () => alignColumnsVertically(layout.columns, 0.5)],
                ["顶部对齐", () => alignColumnsVertically(layout.columns, 0)],
                ["底部对齐", () => alignColumnsVertically(layout.columns, 1)],
                ["均衡列高", () => balanceColumnHeights(layout)],
            ];
            for (const [label, action] of actions) {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = label;
                button.addEventListener("click", () => {
                    action();
                    closeTianPanel();
                });
                autoArrangeMenu.appendChild(button);
            }
            const style = document.createElement("style");
            style.textContent = `
                #xzg-auto-arrange-menu > button {
                    padding:7px; border:1px solid var(--xzg-align-border); border-radius:6px;
                    background:var(--xzg-align-fill); color:var(--xzg-align-color); cursor:pointer;
                }
                #xzg-auto-arrange-menu > button:hover {
                    background:var(--xzg-align-hover); border-color:var(--xzg-align-color);
                }
                #xzg-auto-arrange-menu > button:focus-visible {
                    outline:none; text-decoration:underline;
                }
            `;
            autoArrangeMenu.appendChild(style);
            tianPanel.appendChild(autoArrangeMenu);
        }

        function updateShortcutHint() {
            if (!shortcutHint) return;
            shortcutHint.textContent = formatShortcut(SHORTCUT);
            shortcutHint.style.color = THEME_COLOR;
        }

        function openTianPanel(fromSelection = false) {
            buildTianPanel();
            setHover(null, null);
            updateShortcutHint();
            tianPanel.toggleAttribute("data-selection-open", fromSelection);
            tianPanel.style.left = fromSelection ? "auto" : "50%";
            tianPanel.style.top = fromSelection ? "auto" : "50%";
            tianPanel.style.right = fromSelection ? "16px" : "auto";
            tianPanel.style.bottom = fromSelection ? "72px" : "auto";
            tianPanel.style.marginLeft = fromSelection ? "0" : `-${TIAN_SIZE / 2}px`;
            tianPanel.style.marginTop = fromSelection ? "0" : `-${TIAN_SIZE / 2}px`;
            tianPanel.style.transformOrigin = fromSelection ? "bottom right" : "center";
            tianPanel.style.transform = fromSelection ? "scale(0.35)" : "none";
            tianPanel.style.pointerEvents = fromSelection ? "none" : "";
            tianPanel.style.display = "block";
            tianIsOpen = true;
            tianOpenedFromSelection = fromSelection;
        }
        function closeTianPanel() {
            if (!tianPanel) return;
            panelTransition?.cancel();
            panelTransition = null;
            if (successRAF) { cancelAnimationFrame(successRAF); successRAF = null; }
            autoArrangeMenu?.remove();
            autoArrangeMenu = null;
            tianPanel.style.display = "none";
            tianIsOpen = false;
            tianOpenedFromSelection = false;
            hoveredType = null;
            hoveredKey = null;
            centerDrag = null;
            if (dirArrow) dirArrow.setAttribute("opacity", "0");
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
            if (pressRing) pressRing.setAttribute("opacity", "0");
            hideColorMenu();
        }
        function toggleTianPanel() {
            const openCentered = !tianIsOpen || tianOpenedFromSelection;
            const start = tianOpenedFromSelection && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ? tianPanel.getBoundingClientRect() : null;
            if (tianIsOpen) closeTianPanel();
            if (!openCentered || getSelectedNodes().length < 2) return;
            openTianPanel();
            if (!start) return;

            const end = tianPanel.getBoundingClientRect();
            const dx = start.left + start.width / 2 - end.left - end.width / 2;
            const dy = start.top + start.height / 2 - end.top - end.height / 2;
            const scale = start.width / end.width;
            panelTransition = tianPanel.animate([
                { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
                { transform: "translate(0, 0) scale(1)" },
            ], { duration: 260, easing: "cubic-bezier(0.2, 0.75, 0.25, 1)" });
        }

        function syncSelectionPanel() {
            selectionRAF = null;
            if (!alignmentEnabled) return;
            const selection = new Set(getSelectedNodes());
            const changed = selection.size !== previousSelection.size
                || [...selection].some(node => !previousSelection.has(node));
            previousSelection = selection;
            if (!changed) return;
            if (selection.size < 2) {
                if (tianIsOpen) closeTianPanel();
            } else if (!tianIsOpen || tianOpenedFromSelection) {
                if (tianIsOpen) closeTianPanel();
                openTianPanel(true);
            }
        }

        function queueSelectionCheck() {
            if (alignmentEnabled && selectionRAF === null) {
                selectionRAF = requestAnimationFrame(syncSelectionPanel);
            }
        }

        window.__xzg_tian_close = closeTianPanel;
        previousSelection = new Set(getSelectedNodes());
        app.ui?.settings?.addSetting?.({
            id: ALIGN_ENABLED_SETTING,
            name: "[小珠光] 启用「田字格对齐」",
            defaultValue: true,
            type: "boolean",
            onChange(value) {
                const enabled = value !== false;
                if (alignmentEnabled === enabled) return;
                alignmentEnabled = enabled;
                if (enabled) {
                    previousSelection.clear();
                    queueSelectionCheck();
                } else {
                    if (selectionRAF !== null) cancelAnimationFrame(selectionRAF);
                    selectionRAF = null;
                    closeTianPanel();
                }
            },
        });
        alignmentEnabled = app.ui?.settings?.getSettingValue?.(ALIGN_ENABLED_SETTING) !== false;
        document.addEventListener("pointerup", queueSelectionCheck, true);
        document.addEventListener("keyup", queueSelectionCheck, true);

        // --- 键盘 ---
        document.addEventListener("keydown", (e) => {
            if (!alignmentEnabled || recordingShortcut || e.defaultPrevented || e.isComposing) return;
            if (e.target.closest?.("input, textarea, select") || e.target.isContentEditable) return;
            const keyMatch = e.key.toLowerCase() === SHORTCUT.key;
            const altMatch = e.altKey === SHORTCUT.alt;
            const ctrlMatch = e.ctrlKey === SHORTCUT.ctrl;
            const shiftMatch = e.shiftKey === SHORTCUT.shift;
            const metaMatch = e.metaKey === SHORTCUT.meta;
            if (keyMatch && altMatch && ctrlMatch && shiftMatch && metaMatch && SHORTCUT.key) {
                if (!tianIsOpen && getSelectedNodes().length < 2) return;
                e.preventDefault();
                e.stopPropagation();
                if (!e.repeat) toggleTianPanel();
            }
        }, true);

        document.addEventListener("keydown", (e) => {
            if (!alignmentEnabled || e.defaultPrevented) return;
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
            if (e.key === "Escape" && tianIsOpen) {
                e.preventDefault();
                if (colorMenuOpen) { hideColorMenu(); return; }
                closeTianPanel();
            }
        });

        // 点击外部关闭
        document.addEventListener("pointerdown", (e) => {
            if (colorMenuOpen) {
                if (e.target.closest("#xzg-tian-color-menu")) return;
                hideColorMenu();
                return;
            }
            if (!tianIsOpen) return;
            if (e.target.closest("#xzg-tian-panel")) return;
            closeTianPanel();
        }, true);

        console.log(`[小珠光] 田字格对齐面板已加载 (${formatShortcut(SHORTCUT)})`);
    }
});
