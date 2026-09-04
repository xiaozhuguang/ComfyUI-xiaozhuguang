import { app } from "../../scripts/app.js";
import { XiaozhuguangVideoPlayer } from "./xzg_video_player.js";

/**
 * 小珠光 · 视频节点同步预览
 *
 * 功能：
 * - 在画布上「合并视频」等带视频预览的节点右键菜单中增加「同步预览」；
 *   点击（选中）一个视频节点右键，或多选（框选）多个视频节点后右键，
 *   选择「同步预览」后，这些节点输出的视频从头一起播放，并自动开启循环播放。
 * - 画布空白处右键，当存在选中的视频节点时提供「同步预览选中视频」。
 * - 供快捷键 G（xiaozhuguang 设置中可配置）调用：对当前选中的视频节点同步预览，
 *   无选中时预览画布上全部视频节点。
 */

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

function getVideoUrl(filename, type, subfolder) {
    if (!filename) return "";
    const params = new URLSearchParams({
        filename,
        type: type || "output",
    });
    if (subfolder) params.set("subfolder", subfolder);
    return `/view?${params.toString()}`;
}

function _extractFilename(url) {
    try {
        const params = new URLSearchParams(new URL(url, location.origin).search);
        return params.get("filename") || "video.mp4";
    } catch (_) {
        return "video.mp4";
    }
}

/** 节点是否有可预览的视频（小珠光合并视频节点带 _xzgVideoPlayer） */
function nodeHasVideo(node) {
    if (!node || node.mode === 4) return false; // bypass 节点不参与预览
    const p = node._xzgVideoPlayer;
    if (!p) return false;
    if (typeof p.getSrc === "function" && p.getSrc()) return true;
    if (p._videoInfo && p._videoInfo.filename) return true;
    return false;
}

/** 从节点取视频 { url, name }，取不到返回 null */
function getVideoFromNode(node) {
    const p = node && node._xzgVideoPlayer;
    if (!p) return null;
    let src = typeof p.getSrc === "function" ? p.getSrc() : null;
    if (!src && p._videoInfo && p._videoInfo.filename) {
        src = getVideoUrl(p._videoInfo.filename, p._videoInfo.type, p._videoInfo.subfolder);
    }
    if (!src) return null;
    return { url: src, name: _extractFilename(src) };
}

/** 收集当前选中的视频节点（保留画布选中顺序；兼容 Map/Set/对象三种形态） */
function getSelectedVideoNodes() {
    const sel = app?.canvas?.selected_nodes;
    const out = [];
    if (!sel) return out;
    if (sel instanceof Map || sel instanceof Set) {
        for (const n of sel.values()) {
            if (nodeHasVideo(n)) out.push(n);
        }
    } else if (typeof sel === "object") {
        for (const id in sel) {
            const n = sel[id];
            if (n && nodeHasVideo(n)) out.push(n);
        }
    }
    return out;
}

/** 画布上所有有视频的节点 */
function getAllVideoNodes() {
    return (app?.graph?._nodes || []).filter((n) => nodeHasVideo(n));
}

// ═══════════════════════════════════════════════════════════════
// 同步预览弹窗
// ═══════════════════════════════════════════════════════════════

let _overlay = null;
let _players = [];
let _forceTimer = null;
let _scrubRAF = null;
let _syncLoopOn = true;
let _syncMuted = true;

function closeSyncPreview() {
    if (_forceTimer) {
        clearTimeout(_forceTimer);
        _forceTimer = null;
    }
    if (_scrubRAF) {
        cancelAnimationFrame(_scrubRAF);
        _scrubRAF = null;
    }
    if (_overlay && _overlay._xzgOnKey) {
        document.removeEventListener("keydown", _overlay._xzgOnKey, true);
        _overlay._xzgOnKey = null;
    }
    if (_overlay && _overlay._xzgPanMove) {
        window.removeEventListener("mousemove", _overlay._xzgPanMove, true);
        _overlay._xzgPanMove = null;
    }
    if (_overlay && _overlay._xzgPanUp) {
        window.removeEventListener("mouseup", _overlay._xzgPanUp, true);
        _overlay._xzgPanUp = null;
    }
    if (_overlay && _overlay._xzgWipeMove) {
        window.removeEventListener("mousemove", _overlay._xzgWipeMove, true);
        _overlay._xzgWipeMove = null;
    }
    if (_overlay && _overlay._xzgWipeUp) {
        window.removeEventListener("mouseup", _overlay._xzgWipeUp, true);
        _overlay._xzgWipeUp = null;
    }
    for (const p of _players) {
        try { p.destroy(); } catch (_) {}
    }
    _players = [];
    if (_overlay) {
        _overlay.remove();
        _overlay = null;
    }
}

function _ensureStyle() {
    if (document.getElementById("xzg-sync-preview-style")) return;
    const st = document.createElement("style");
    st.id = "xzg-sync-preview-style";
    st.textContent = `
    .xzg-sp-overlay {
        position: fixed; inset: 0; z-index: 2147483000;
        background: rgba(0,0,0,0.6);
        display: flex; align-items: center; justify-content: center;
        font-family: system-ui, sans-serif;
    }
    .xzg-sp-window {
        position: relative;
        width: 100%;
        height: 100%;
        background: #1c1c1e;
        display: flex; flex-direction: column;
        overflow: hidden;
    }
    .xzg-sp-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 16px; background: #222; border-bottom: 1px solid #3f3f3f;
        flex-shrink: 0;
    }
    .xzg-sp-title { font-size: 14px; font-weight: 600; color: #dcc85b; }
    .xzg-sp-close {
        background: transparent; color: #ff6b6b; border: none;
        font-size: 20px; cursor: pointer; line-height: 1; padding: 2px 6px;
    }
    .xzg-sp-close:hover { color: #ff9494; }
    .xzg-sp-grid {
        flex: 1; overflow: hidden; padding: 14px;
        display: grid; gap: 14px;
    }
    .xzg-sp-cell {
        position: relative; display: flex; flex-direction: column;
        background: #1a1a1a; border: 1px solid #3f3f3f; border-radius: 8px;
        overflow: hidden;
        min-width: 0;
    }
    .xzg-sp-label {
        padding: 6px 8px; font-size: 11px; color: #aaa;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        background: #232323; flex-shrink: 0;
    }
    .xzg-sp-player {
        position: relative; flex: 1; min-height: 0;
        background: #000;
    }
    .xzg-sp-ctrl {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 14px; background: #222; border-top: 1px solid #3f3f3f;
        flex-shrink: 0; flex-wrap: wrap;
    }
    .xzg-sp-btn {
        background: #333; color: #eee; border: 1px solid #4a4a4a;
        border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px;
    }
    .xzg-sp-btn:hover { background: #444; }
    .xzg-sp-btn-primary { background: #2980b9; border-color: #2980b9; }
    .xzg-sp-btn-primary:hover { background: #3498db; }
    .xzg-sp-status { margin-left: auto; font-size: 12px; color: #999; }
    .xzg-sp-scrub {
        display: flex; align-items: center; gap: 8px; flex: 1;
        min-width: 220px;
    }
    .xzg-sp-scrub input[type=range] {
        flex: 1; accent-color: #dcc85b; cursor: pointer;
    }
    .xzg-sp-scrub-time { font-size: 12px; color: #bbb; white-space: nowrap; }
    .xzg-sp-wipe {
        position: relative; flex: 1; overflow: hidden; background: #000;
        display: none;
    }
    .xzg-sp-wipe.active { display: block; }
    .xzg-sp-wipe .xzg-sp-player {
        position: absolute; inset: 0;
    }
    .xzg-sp-wipe .xzg-sp-player.wipe-top {                          /* 上层：按 --wipe 裁剪 */
        z-index: 2;
        clip-path: inset(0 0 0 var(--wipe, 50%));
    }
    .xzg-sp-wipe-divider {
        position: absolute; top: 0; bottom: 0; left: var(--wipe, 50%);
        width: 32px; margin-left: -16px; background: transparent; /* 宽命中区，方便拖动 */
        cursor: ew-resize; z-index: 10;
    }
    .xzg-sp-wipe-divider::before {
        content: ""; position: absolute; top: 0; bottom: 0; left: 50%;
        width: 3px; transform: translateX(-50%);
        background: #dcc85b; box-shadow: 0 0 8px rgba(0,0,0,.7);
    }
    .xzg-sp-wipe-divider::after {
        content: "◀ ▶"; position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        background: #dcc85b; color: #222; font-size: 10px;
        padding: 2px 4px; border-radius: 3px; white-space: nowrap;
    }
    `;
    document.head.appendChild(st);
}

/** items: [{ url, name }]，全部从头一起播放、自动循环 */
function openSyncPreview(items) {
    if (!Array.isArray(items) || items.length === 0) return false;
    _ensureStyle();
    closeSyncPreview();

    const overlay = document.createElement("div");
    overlay.className = "xzg-sp-overlay";
    _overlay = overlay;

    // 居中的统一窗口：所有视频在窗口内排版
    const win = document.createElement("div");
    win.className = "xzg-sp-window";

    // 标题栏
    const closeBtn = document.createElement("button");
    closeBtn.className = "xzg-sp-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "关闭";
    closeBtn.addEventListener("click", closeSyncPreview);

    // 网格容器：初始按"一行排开"占位，视频加载完成后按实际宽高比重新计算行列
    const grid = document.createElement("div");
    grid.className = "xzg-sp-grid";
    const _n = items.length;
    grid.style.gridTemplateColumns = "repeat(" + _n + ", 1fr)";
    grid.style.gridTemplateRows = "repeat(1, 1fr)";
    const players = [];
    for (const it of items) {
        const cell = document.createElement("div");
        cell.className = "xzg-sp-cell";
        const label = document.createElement("div");
        label.className = "xzg-sp-label";
        label.textContent = it.name || "video";
        label.title = it.url;
        const holder = document.createElement("div");
        holder.className = "xzg-sp-player";
        cell.appendChild(label);
        cell.appendChild(holder);
        grid.appendChild(cell);
        const player = new XiaozhuguangVideoPlayer({
            container: holder,
            placeholderText: "加载中...",
            fit: "contain", // 保持原比例、不裁剪，在播放区域内居中最大化
            ui: false, // 隐藏播放器内置 UI（进度条/红蓝条/时间码/循环·静音按钮）
            // 点击任一视频画面切换播放/暂停时，同步所有视频（与左下角按钮一致：从暂停处继续）
            onPlay: () => syncResume(),
            onPause: () => syncPause(),
        });
        player.setMuted(true); // 多视频同播默认静音，避免声音混杂
        players.push({ player, url: it.url, holder, cell });
    }
    win.appendChild(grid);

    // 划像对比容器（仅两个视频时使用）：两视频重叠，拖动金色分界线左右对比
    const wipe = document.createElement("div");
    wipe.className = "xzg-sp-wipe";
    const wipeDivider = document.createElement("div");
    wipeDivider.className = "xzg-sp-wipe-divider";
    wipeDivider.title = "拖动分界线进行划像对比";
    wipe.appendChild(wipeDivider);
    win.appendChild(wipe);

    // 控制栏
    const ctrl = document.createElement("div");
    ctrl.className = "xzg-sp-ctrl";
    const mkBtn = (text, tip, cls) => {
        const b = document.createElement("button");
        b.className = "xzg-sp-btn" + (cls ? " " + cls : "");
        b.textContent = text;
        b.title = tip;
        return b;
    };

    let playing = false;
    const playPauseBtn = mkBtn("▶ 播放", "播放全部（从头开始）", "xzg-sp-btn-primary");
    const restartBtn = mkBtn("⏮ 回到开头", "全部回到开头重新播放");
    const muteBtn = mkBtn("🔇", "静音开关（默认静音）");
    const zoomBtn = mkBtn("🔍 100%", "滚轮缩放视频，点击重置（所有视频同步缩放）");
    const wipeBtn = mkBtn("🔀 划像对比", "两个视频重叠，拖动金色分界线左右对比（仅 2 个视频可用）");
    if (_n !== 2) wipeBtn.style.display = "none"; // 仅两个视频时提供划像对比
    const swapBtn = mkBtn("⇄ 交换左右", "交换两个视频的左右顺序（仅 2 个视频）");
    if (_n !== 2) swapBtn.style.display = "none";
    let _swapped = false;
    const setSwap = (s) => {
        _swapped = s;
        // 交换 players 顺序：并排左右 与 划像底层/上层 都随之对调
        [players[0], players[1]] = [players[1], players[0]];
        // 统一让 players[0] 的格子排在前（左侧）
        grid.insertBefore(players[0].cell, players[1].cell);
        if (wipeMode) setWipeMode(true); // 划像模式：重新布置底层/上层
        requestAnimationFrame(() => {
            for (const p of players) {
                try { p.player.resize?.(); } catch (_) {}
            }
            recordHolderBase();
            if (wipeMode) updateDividerPos();
        });
    };
    swapBtn.addEventListener("click", () => setSwap(!_swapped));
    // 播放台：共享进度条，同时控制所有视频的播放进度（按各自时长的比例同步跳转）
    const scrubWrap = document.createElement("div");
    scrubWrap.className = "xzg-sp-scrub";
    const scrubTime = document.createElement("span");
    scrubTime.className = "xzg-sp-scrub-time";
    scrubTime.textContent = "00:00 / 00:00";
    const scrubRange = document.createElement("input");
    scrubRange.type = "range";
    scrubRange.min = 0; scrubRange.max = 1000; scrubRange.value = 0;
    scrubRange.title = "同步控制所有视频的播放进度";
    scrubWrap.appendChild(scrubTime);
    scrubWrap.appendChild(scrubRange);
    const statusEl = document.createElement("span");
    statusEl.className = "xzg-sp-status";

    // 主视频（用于进度条/时间显示）：取第一个已有有效时长的
    const pickMain = () => {
        for (const p of players) {
            const d = p.player.duration;
            if (d && isFinite(d) && d > 0) return p;
        }
        return players[0];
    };
    const fmtTime = (t) => {
        if (!isFinite(t) || t < 0) t = 0;
        const m = Math.floor(t / 60), s = Math.floor(t % 60);
        return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    };
    let _scrubbing = false;
    const seekAllToRatio = (ratio) => {
        for (const p of players) {
            const d = p.player.duration;
            if (d && isFinite(d) && d > 0) {
                try { p.player.seek(d * ratio); } catch (_) {}
            }
        }
    };
    scrubRange.addEventListener("input", () => {
        _scrubbing = true;
        seekAllToRatio((+scrubRange.value) / 1000);
        const main = pickMain();
        scrubTime.textContent = fmtTime(main.player.currentTime) + " / " + fmtTime(main.player.duration);
    });
    scrubRange.addEventListener("change", () => {
        _scrubbing = false;
    });
    // 播放中每帧平滑刷新进度条（拖动时暂停刷新；仅数值变化时写入 DOM，避免无谓开销）
    const scrubTick = () => {
        if (!_scrubbing) {
            const main = pickMain();
            const d = main.player.duration;
            if (d && isFinite(d) && d > 0) {
                const ct = main.player.currentTime || 0;
                const v = Math.max(0, Math.min(1000, (ct / d) * 1000));
                if (v !== scrubRange.value) scrubRange.value = v;
                const txt = fmtTime(ct) + " / " + fmtTime(d);
                if (txt !== scrubTime.textContent) scrubTime.textContent = txt;
            }
        }
        _scrubRAF = requestAnimationFrame(scrubTick);
    };
    _scrubRAF = requestAnimationFrame(scrubTick);

    // 同步播放/暂停：点击任一视频画面（或左下角按钮）时，所有视频一起播放/暂停
    // _syncing 防止同步动作再次触发 onPlay/onPause 造成递归
    let _syncing = false;
    // 从暂停处继续播放：不 seek，各视频从自己的当前进度继续
    const syncResume = () => {
        if (_syncing) return;
        _syncing = true;
        try {
            for (const p of players) {
                if (!p.player.isPlaying) p.player.play();
            }
            playing = true;
            playPauseBtn.textContent = "⏸ 暂停";
            statusEl.textContent = "▶ 播放中（自动循环）";
        } finally { _syncing = false; }
    };
    // 从头一起播放：seek 0 + play（仅初次自动播放和"回到开头"使用）
    const syncPlayFromStart = () => {
        if (_syncing) return;
        _syncing = true;
        try {
            for (const p of players) {
                if (!p.player.isPlaying) { p.player.seek(0); p.player.play(); }
            }
            playing = true;
            playPauseBtn.textContent = "⏸ 暂停";
            statusEl.textContent = "▶ 播放中（自动循环）";
        } finally { _syncing = false; }
    };
    const syncPause = () => {
        if (_syncing) return;
        _syncing = true;
        try {
            for (const p of players) p.player.pause();
            playing = false;
            playPauseBtn.textContent = "▶ 播放";
            statusEl.textContent = "已暂停";
        } finally { _syncing = false; }
    };
    // 左下角播放按钮：从暂停处继续；点击视频 onPlay 同样走继续播放
    const playAll = syncResume;
    const pauseAll = syncPause;
    const restartAll = () => {
        _syncing = true; // 阻止 pause/seek 触发同步回调
        try {
            for (const p of players) {
                p.player.pause();
                p.player.seek(0);
            }
        } finally { _syncing = false; }
        if (playing) syncPlayFromStart();
    };

    playPauseBtn.addEventListener("click", () => {
        if (playing) pauseAll(); else playAll();
    });
    restartBtn.addEventListener("click", restartAll);
    muteBtn.addEventListener("click", () => {
        _syncMuted = !_syncMuted;
        muteBtn.textContent = _syncMuted ? "🔇" : "🔊";
        for (const p of players) p.player.setMuted(_syncMuted);
    });

    // ── 划像对比（仅两个视频）──────────────────────────────
    let wipeMode = false;
    const setWipeMode = (on) => {
        if (_n !== 2) return;
        wipeMode = on;
        if (on) {
            grid.style.display = "none";
            wipe.classList.add("active");
            // 播放器在容器上设置了内联 position:relative，会覆盖 CSS 的 absolute，
            // 因此必须内联强制 absolute + inset:0，两个视频才能真正重叠
            for (const p of players) {
                p.holder.style.position = "absolute";
                p.holder.style.inset = "0";
            }
            // 底层 = 第 1 个视频（全显示），上层 = 第 2 个视频（按 --wipe 裁剪）
            wipe.insertBefore(players[0].holder, wipeDivider);
            wipe.insertBefore(players[1].holder, wipeDivider);
            players[1].holder.classList.add("wipe-top");
            players[0].holder.classList.remove("wipe-top");
        } else {
            grid.style.display = "";
            wipe.classList.remove("active");
            players[0].cell.appendChild(players[0].holder);
            players[1].cell.appendChild(players[1].holder);
            players[1].holder.classList.remove("wipe-top");
            // 恢复播放器默认布局（position:relative 由播放器自己管理，这里清空内联覆盖）
            for (const p of players) {
                p.holder.style.position = "";
                p.holder.style.inset = "";
            }
        }
        // 切换视图时重置缩放/平移，避免残留 transform 造成错乱
        for (const p of players) {
            p.holder.style.transform = "none";
            p.holder.style.transformOrigin = "0 0";
        }
        wipeDivider.style.transform = "none";
        wipeDivider.style.transformOrigin = "0 0";
        _holderT = players.map(() => ({ x: 0, y: 0 }));
        _zoomScale = 1;
        applyZoomText();
        // 布局/画布尺寸变化后重录基线并校准
        requestAnimationFrame(() => {
            for (const p of players) {
                try { p.player.resize?.(); } catch (_) {}
            }
            recordHolderBase();
            if (wipeMode) updateDividerPos();
        });
        wipeBtn.textContent = on ? "⬒ 并排对比" : "🔀 划像对比";
    };
    wipeBtn.addEventListener("click", () => setWipeMode(!wipeMode));

    // 划像拖动：分界线拖动 + 画面任意位置按住左键拖动 均可划像。
    // 点击（不拖动）仍由播放器正常处理播放/暂停；拖动超过阈值才进入划像。
    let _wiping = false;          // 分界线拖动中
    let _wipeDrag = false;        // 任意位置拖动判定中
    let _wipeDragged = false;     // 是否已确认为拖动（超过阈值）
    let _wipeDownX = 0, _wipeDownY = 0;
    let _wipeX = 50;              // 划像位置（0-100，未缩放坐标，相对 wipe 宽度）
    // 分界线定位到 clip 边界的实际视觉位置：clip 边界 = 未缩放 X% 处经窗格缩放/平移后的位置
    const updateDividerPos = () => {
        const W = wipe.clientWidth;
        if (!W) return;
        const t0 = _holderT[0] || { x: 0, y: 0 };
        const leftPct = _wipeX * _zoomScale + (t0.x / W) * 100;
        wipeDivider.style.left = Math.max(-4, Math.min(104, leftPct)) + "%";
    };
    const updateWipe = (e) => {
        const r = wipe.getBoundingClientRect();
        if (!r.width) return;
        let x = ((e.clientX - r.left) / r.width) * 100;
        x = Math.max(0, Math.min(100, x));
        _wipeX = x;
        wipe.style.setProperty("--wipe", x + "%"); // clip-path 用它（相对窗格本地坐标）
        updateDividerPos();                         // 分界线跟随 clip 边界视觉位置
    };
    wipeDivider.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        _wiping = true;
        updateWipe(e);
    });
    wipe.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        _wipeDownX = e.clientX; _wipeDownY = e.clientY;
        _wipeDragged = false;
        _wipeDrag = true;
    });
    const onWipeMove = (e) => {
        if (_wiping) { updateWipe(e); return; }
        if (!_wipeDrag) return;
        if (!_wipeDragged) {
            // 超过阈值才判定为拖动（区分点击）
            if (Math.abs(e.clientX - _wipeDownX) < 4 && Math.abs(e.clientY - _wipeDownY) < 4) return;
            _wipeDragged = true;
        }
        updateWipe(e);
    };
    const onWipeUp = () => {
        _wiping = false;
        if (_wipeDrag && _wipeDragged) _suppressClick = true; // 划像拖动后抑制 click，避免误触发播放/暂停
        _wipeDrag = false;
    };
    window.addEventListener("mousemove", onWipeMove, true);
    window.addEventListener("mouseup", onWipeUp, true);
    overlay._xzgWipeMove = onWipeMove;
    overlay._xzgWipeUp = onWipeUp;

    ctrl.appendChild(playPauseBtn);
    ctrl.appendChild(restartBtn);
    ctrl.appendChild(muteBtn);
    ctrl.appendChild(zoomBtn);
    ctrl.appendChild(wipeBtn);
    ctrl.appendChild(swapBtn);
    ctrl.appendChild(scrubWrap);
    closeBtn.style.marginLeft = "auto";
    ctrl.appendChild(closeBtn);
    // 控制栏（菜单 + 播放台）置于窗口最顶部，视频区之下
    win.insertBefore(ctrl, grid);
    overlay.appendChild(win);

    document.body.appendChild(overlay);
    // 点击窗口外遮罩关闭
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeSyncPreview();
    });

    // 滚轮同步缩放：以鼠标处为锚点的 zoom-to-cursor。
    // 每个窗格用独立 translate + scale，所有窗格同步同倍率；
    // 锚点统一取"鼠标所在窗格内的相对位置"，放大时鼠标指向的内容点保持不动，便于多窗格对比
    let _zoomScale = 1;
    const ZOOM_MIN = 0.3, ZOOM_MAX = 6;
    let _zoomAnchorRX = 50, _zoomAnchorRY = 50;
    let _holderBase = []; // 各窗格 scale=1 时的屏幕矩形
    let _holderT = [];    // 各窗格累计 translate
    const applyZoomText = () => {
        zoomBtn.textContent = "🔍 " + Math.round(_zoomScale * 100) + "%";
    };
    const recordHolderBase = () => {
        _holderBase = players.map(p => {
            const r = p.holder.getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width, height: r.height };
        });
        _holderT = players.map(() => ({ x: 0, y: 0 }));
    };
    const applyZoomAll = (factor) => {
        // 基线失效（未记录/尺寸为 0）时即时重录，确保每个窗格都能被同步缩放
        if (_holderBase.length !== players.length ||
            _holderBase.some(b => !b || !(b.width > 0) || !(b.height > 0))) {
            recordHolderBase();
        }
        const sOld = _zoomScale;
        const sNew = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, sOld * factor));
        if (sNew === sOld) return;
        const rx = _zoomAnchorRX, ry = _zoomAnchorRY;
        for (let i = 0; i < players.length; i++) {
            const holder = players[i].holder;
            const b = _holderBase[i];
            const t = _holderT[i] || { x: 0, y: 0 };
            // 锚点在屏幕上的位置（各窗格统一相对比例）
            const mX = b.left + (b.width * rx / 100);
            const mY = b.top + (b.height * ry / 100);
            // 锚点对应的内容点（缩放前，相对窗格未缩放左上角）
            const cX = (mX - b.left - t.x) / sOld;
            const cY = (mY - b.top - t.y) / sOld;
            // 缩放后保持该内容点不动
            const nX = mX - b.left - cX * sNew;
            const nY = mY - b.top - cY * sNew;
            _holderT[i] = { x: nX, y: nY };
            holder.style.transformOrigin = "0 0";
            holder.style.transform = "translate(" + nX + "px," + nY + "px) scale(" + sNew + ")";
        }
        _zoomScale = sNew;
        applyZoomText();
        if (wipeMode) updateDividerPos(); // 缩放后分界线跟随 clip 边界
    };
    const resetZoomAll = () => {
        _zoomScale = 1;
        _zoomAnchorRX = 50; _zoomAnchorRY = 50;
        for (const p of players) {
            p.holder.style.transform = "none";
            p.holder.style.transformOrigin = "0 0";
        }
        _holderT = players.map(() => ({ x: 0, y: 0 }));
        applyZoomText();
        if (wipeMode) updateDividerPos();
    };
    zoomBtn.addEventListener("click", resetZoomAll);
    win.addEventListener("wheel", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // 锚点 = 鼠标所在窗格内的相对位置（各窗格统一；鼠标在空白处用中心）
        let rx = 50, ry = 50;
        for (let i = 0; i < players.length; i++) {
            const r = players[i].holder.getBoundingClientRect();
            if (r.width > 0 && e.clientX >= r.left && e.clientX <= r.right &&
                e.clientY >= r.top && e.clientY <= r.bottom) {
                const b = _holderBase[i];
                if (b && b.width > 0 && b.height > 0) {
                    const t = _holderT[i] || { x: 0, y: 0 };
                    rx = ((e.clientX - b.left - t.x) / (b.width * _zoomScale)) * 100;
                    ry = ((e.clientY - b.top - t.y) / (b.height * _zoomScale)) * 100;
                } else {
                    rx = ((e.clientX - r.left) / r.width) * 100;
                    ry = ((e.clientY - r.top) / r.height) * 100;
                }
                rx = Math.max(0, Math.min(100, rx));
                ry = Math.max(0, Math.min(100, ry));
                break;
            }
        }
        _zoomAnchorRX = rx; _zoomAnchorRY = ry;
        applyZoomAll(e.deltaY < 0 ? 1.1 : (e.deltaY > 0 ? 1 / 1.1 : 1));
    }, { capture: true, passive: false });

    // 鼠标中键 / Ctrl+左键拖动平移：所有窗格同步移动（配合滚轮缩放对比细节）
    let _panning = false;
    let _suppressClick = false; // 平移拖动结束后抑制一次 click，避免误触发播放/暂停
    let _panStartX = 0, _panStartY = 0;
    let _panStartT = [];
    win.addEventListener("mousedown", (e) => {
        // 中键，或 Ctrl+左键：进入平移模式
        const wantPan = (e.button === 1) || (e.button === 0 && e.ctrlKey);
        if (!wantPan) return;
        e.preventDefault();
        e.stopPropagation();
        _suppressClick = true;
        _panning = true;
        _panStartX = e.clientX; _panStartY = e.clientY;
        _panStartT = _holderT.map(t => ({ x: t.x, y: t.y }));
        win.style.cursor = "grabbing";
    }, true);
    // 平移结束后紧接着的 click 一律拦截（阻止播放器 _onSurfaceClick 触发播放/暂停）
    win.addEventListener("click", (e) => {
        if (!_suppressClick) return;
        e.preventDefault();
        e.stopPropagation();
        _suppressClick = false;
    }, true);
    const onPanMove = (e) => {
        if (!_panning) return;
        e.preventDefault();
        const dx = e.clientX - _panStartX;
        const dy = e.clientY - _panStartY;
        for (let i = 0; i < players.length; i++) {
            const t = _panStartT[i] || { x: 0, y: 0 };
            const nx = t.x + dx;
            const ny = t.y + dy;
            _holderT[i] = { x: nx, y: ny };
            players[i].holder.style.transformOrigin = "0 0";
            players[i].holder.style.transform = "translate(" + nx + "px," + ny + "px) scale(" + _zoomScale + ")";
        }
        if (wipeMode) updateDividerPos(); // 平移后分界线跟随 clip 边界
    };
    const onPanUp = () => {
        if (!_panning) return;
        _panning = false;
        win.style.cursor = "";
    };
    window.addEventListener("mousemove", onPanMove, true);
    window.addEventListener("mouseup", onPanUp, true);
    overlay._xzgPanMove = onPanMove;
    overlay._xzgPanUp = onPanUp;
    recordHolderBase(); // 初始布局下记录各窗格基线
    _syncLoopOn = true;
    _syncMuted = true;

    // 全部就绪后统一从头播放（8 秒超时兜底：强制播放已就绪的）
    let readyCount = 0;
    let forceStarted = false;
    // 根据视频实际宽高比重排行列：全竖屏(9:16等)时横向排开，让格子高度最大化（画面更大）
    const applyGridLayout = () => {
        const ratios = players.map(p => p.player._videoRatio || 16 / 9);
        let cols, rows;
        if (ratios.every(r => r < 1)) {
            // 全部竖屏：横向排开，让每个格子占满整列高度
            cols = _n <= 4 ? _n : Math.ceil(_n / 2);
            rows = Math.ceil(_n / cols);
        } else {
            // 横屏或混合：以 2~3 列为主
            cols = _n === 1 ? 1 : (_n === 2 ? 2 : (_n <= 4 ? 2 : (_n <= 6 ? 3 : 4)));
            rows = Math.ceil(_n / cols);
        }
        grid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
        grid.style.gridTemplateRows = "repeat(" + rows + ", 1fr)";
        // 重排后校准各播放器画布尺寸
        requestAnimationFrame(() => {
            for (const p of players) {
                try { p.player.resize?.(); } catch (_) {}
            }
            recordHolderBase(); // 布局稳定后重新记录窗格基线，保证缩放锚点准确
        });
    };
    const tryStart = () => {
        if (forceStarted) return;
        if (readyCount >= players.length) {
            forceStarted = true;
            applyGridLayout(); // 全部就绪后按比例重排
            statusEl.textContent = "▶ 播放中（自动循环）";
            syncPlayFromStart(); // 初次打开：从头一起播放
        } else {
            statusEl.textContent = "加载中... (" + readyCount + "/" + players.length + ")";
        }
    };
    _forceTimer = setTimeout(() => {
        if (forceStarted) return;
        forceStarted = true;
        applyGridLayout(); // 超时兜底：用已加载的比例重排
        statusEl.textContent = "已开始播放（部分视频仍在加载）";
        syncPlayFromStart(); // 超时兜底：从头一起播放
    }, 8000);

    for (const p of players) {
        p.player.onLoadedMetadata = () => {
            readyCount++;
            if (forceStarted) {
                p.player.seek(0);
                p.player.play();
            } else {
                tryStart();
            }
        };
        p.player.onError = () => {
            statusEl.textContent = "部分视频加载失败，其余正常播放";
        };
        p.player.setLoop(true);
        p.player.load(p.url);
    }
    tryStart();

    // 布局稳定后校准各播放器画布尺寸
    requestAnimationFrame(() => {
        for (const p of players) {
            try { p.player.resize?.(); } catch (_) {}
        }
    });

    // Esc 关闭
    const onKey = (e) => {
        if (e.key === "Escape") closeSyncPreview();
    };
    overlay._xzgOnKey = onKey;
    document.addEventListener("keydown", onKey, true);

    return true;
}

// ═══════════════════════════════════════════════════════════════
// 对外入口
// ═══════════════════════════════════════════════════════════════

/** 对指定节点集合做同步预览 */
function previewNodes(nodes) {
    const items = [];
    for (const n of nodes || []) {
        const v = getVideoFromNode(n);
        if (v) items.push(v);
    }
    if (items.length === 0) {
        console.warn("[小珠光同步预览] 选中的节点中没有可预览的视频");
        return false;
    }
    return openSyncPreview(items);
}

/** 快捷键入口：当前选中的视频节点；无选中时预览画布全部视频节点 */
function previewSelection() {
    let nodes = getSelectedVideoNodes();
    if (nodes.length === 0) nodes = getAllVideoNodes();
    if (nodes.length === 0) {
        console.warn("[小珠光同步预览] 画布上没有可预览的视频节点");
        return false;
    }
    return previewNodes(nodes);
}

// ═══════════════════════════════════════════════════════════════
// 右键菜单扩展（与 xzg_menu_hide 等链式 patch 兼容，幂等）
// ═══════════════════════════════════════════════════════════════

let _patched = false;
function patchContextMenus() {
    if (_patched) return;
    _patched = true;
    const LGC = (typeof LiteGraph !== "undefined") ? LiteGraph.LGraphCanvas : null;
    if (!LGC || !LGC.prototype) return;

    // 节点右键菜单：视频节点置顶「▶ 同步预览」（金色，放在菜单最上面）
    const origNodeMenu = LGC.prototype.getNodeMenuOptions;
    LGC.prototype.getNodeMenuOptions = function (node) {
        const options = origNodeMenu ? origNodeMenu.apply(this, arguments) : [];
        if (Array.isArray(options) && nodeHasVideo(node)) {
            options.unshift({
                content: "<span style='color:#dcc85b;font-weight:600'>▶ 同步预览</span>",
                callback: () => {
                    let nodes = getSelectedVideoNodes();
                    // 保证右键节点本身被包含（多选时选中集合应已含它，兜底补上）
                    if (!nodes.includes(node)) nodes.push(node);
                    previewNodes(nodes);
                },
            });
        }
        return options;
    };

    // 画布空白右键菜单：存在选中的视频节点时提供「同步预览选中视频」
    const origCanvasMenu = LGC.prototype.getCanvasMenuOptions;
    LGC.prototype.getCanvasMenuOptions = function () {
        const options = origCanvasMenu ? origCanvasMenu.apply(this, arguments) : [];
        if (Array.isArray(options) && getSelectedVideoNodes().length > 0) {
            options.push(null);
            options.push({
                content: "<span style='color:#dcc85b;font-weight:600'>▶ 同步预览选中视频</span>",
                callback: () => previewSelection(),
            });
        }
        return options;
    };
}

// ═══════════════════════════════════════════════════════════════
// 扩展注册 + 全局暴露（供快捷键等外部调用）
// ═══════════════════════════════════════════════════════════════

app.registerExtension({
    name: "xiaozhuguang.video_sync_preview",
    async setup() {
        patchContextMenus();
    },
});

window.xzgSyncPreview = {
    previewSelection,
    previewNodes,
    openSyncPreview,
    closeSyncPreview,
    nodeHasVideo,
    getVideoFromNode,
    getSelectedVideoNodes,
};
