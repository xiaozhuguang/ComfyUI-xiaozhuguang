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

/** 从节点取视频 { url, name, skipFrames?, frameLimit? }，取不到返回 null */
function getVideoFromNode(node) {
    const p = node && node._xzgVideoPlayer;
    if (!p) return null;
    let src = typeof p.getSrc === "function" ? p.getSrc() : null;
    if (!src && p._videoInfo && p._videoInfo.filename) {
        src = getVideoUrl(p._videoInfo.filename, p._videoInfo.type, p._videoInfo.subfolder);
    }
    if (!src) return null;
    const item = { url: src, name: _extractFilename(src) };
    // 携带节点播放器已应用的加载范围（跳过帧数/帧数上限）：
    // 对比预览创建的是全新播放器，不传的话会播放完整视频，与节点内裁剪后预览不一致
    if (typeof p._skipFrames === "number" && p._skipFrames > 0) item.skipFrames = p._skipFrames;
    if (typeof p._frameLimit === "number" && p._frameLimit > 0) item.frameLimit = p._frameLimit;
    return item;
}

/** 按画布位置排序：x 升序（左→右），x 相同按 y 升序（上→下） */
function _sortByCanvasPos(nodes) {
    return [...nodes].sort((a, b) => {
        const ax = (a.pos && a.pos[0]) || 0;
        const bx = (b.pos && b.pos[0]) || 0;
        if (ax !== bx) return ax - bx;
        const ay = (a.pos && a.pos[1]) || 0;
        const by = (b.pos && b.pos[1]) || 0;
        return ay - by;
    });
}

/** 收集当前选中的视频节点（按画布位置排序；兼容 Map/Set/对象三种形态） */
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
    return _sortByCanvasPos(out);
}

/** 画布上所有有视频的节点（按画布位置排序） */
function getAllVideoNodes() {
    return _sortByCanvasPos((app?.graph?._nodes || []).filter((n) => nodeHasVideo(n)));
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
        background: #000; border: 1px solid #3f3f3f; border-radius: 8px;
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
        background: #000 !important; /* 覆盖播放器 _buildDOM 设置的 inline 灰色 #1a1a1a，视频缩小后填充区为黑色 */
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
    /* 划像区域内禁用元素原生拖拽/文本选中，防止按住拖动时出现禁用光标 */
    .xzg-sp-wipe, .xzg-sp-wipe * { -webkit-user-drag: none; user-select: none; }
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
            exclusiveDecoder: true, // 多视频同时 seek 对比：每个播放器独立解码，避免共享解码器渲染状态互相抢占
            // 点击任一视频画面切换播放/暂停时，同步所有视频（与左下角按钮一致：从暂停处继续）
            onPlay: () => syncResume(),
            onPause: () => syncPause(),
        });
        player.setMuted(true); // 多视频同播默认静音，避免声音混杂
        // 应用节点加载范围（跳过帧数/帧数上限）：对比播放器与节点内预览保持相同的裁剪
        if (it.skipFrames || it.frameLimit) {
            try { player.setLoadRange(it.skipFrames || 0, it.frameLimit || 0); } catch (_) {}
        }
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
    const prevFrameBtn = mkBtn("◀ 上一帧", "上一帧（快捷键 ←）");
    const nextFrameBtn = mkBtn("下一帧 ▶", "下一帧（快捷键 →）");
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
        // 同步交换累计平移：_holderT 与 players 索引一一对应，
        // 基线重录（recordHolderBase）依赖它反推布局矩形，错位会导致缩放锚点错乱
        [_holderT[0], _holderT[1]] = [_holderT[1], _holderT[0]];
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
    // 多视频同步播放：定期以主视频为基准软对齐各播放器时间。
    // 各播放器独立 RAF 循环，掉帧/解码延迟会各自累积漂移（不同帧率视频尤其明显），
    // 这里用低频率 seek 校正，抵消漂移；偏差低于阈值不打扰（避免频繁跳帧）。
    let _lastAlignAt = 0;
    const ALIGN_INTERVAL = 500;   // 对齐检查间隔（ms）
    const ALIGN_THRESHOLD = 0.08; // 偏差阈值（秒），低于此不打扰（避免频繁跳帧）
    const alignPlayers = (now) => {
        if (!playing) return; // 暂停时不强制对齐：避免逐帧浏览时各播放器帧位被拉回主时间
        if (_lastAlignAt && now - _lastAlignAt < ALIGN_INTERVAL) return;
        _lastAlignAt = now;
        const main = pickMain();
        const master = main.player.currentTime;
        if (!isFinite(master)) return;
        for (const p of players) {
            if (p === main) continue;
            const d = p.player.duration;
            if (!d || !isFinite(d) || d <= 0) continue;
            const ct = p.player.currentTime || 0;
            if (Math.abs(ct - master) > ALIGN_THRESHOLD) {
                try { p.player.seek(Math.max(0, Math.min(master, d))); } catch (_) {}
            }
        }
    };
    // 播放中每帧平滑刷新进度条（拖动时暂停刷新；仅数值变化时写入 DOM，避免无谓开销）
    const scrubTick = () => {
        const now = performance.now();
        if (!_scrubbing) {
            alignPlayers(now);
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
    // 逐帧浏览：先暂停全部，然后各视频同步跳到「主视频当前帧号 ± delta」对应的帧。
    // 以帧号（而非时间）为同步基准：对比场景下第 N 帧画面才有可比性；
    // 各播放器按自己的帧率 seek 到第 N 帧，帧率不同也能逐帧对齐。
    const stepFrame = (delta) => {
        _syncing = true;
        try {
            for (const p of players) p.player.pause();
        } finally { _syncing = false; }
        playing = false;
        playPauseBtn.textContent = "▶ 播放";
        statusEl.textContent = "已暂停";
        const main = pickMain();
        const mfps = main.player.getFrameRate ? main.player.getFrameRate() : (main.player._frameRate || 24);
        const target = Math.round((main.player.currentTime || 0) * mfps) + delta;
        for (const p of players) {
            const pfps = p.player.getFrameRate ? p.player.getFrameRate() : (p.player._frameRate || 24);
            const skip = p.player._skipFrames || 0;
            let end = 0;
            try { end = p.player._computeEndFrame ? p.player._computeEndFrame() : 0; } catch (_) {}
            if (!end || end <= 0) end = p.player.getSourceTotalFrames ? p.player.getSourceTotalFrames() : 0;
            const f = end > 0 ? Math.max(skip, Math.min(target, end)) : Math.max(0, target);
            try { p.player.seek(f / pfps); } catch (_) {}
        }
    };
    prevFrameBtn.addEventListener("click", () => stepFrame(-1));
    nextFrameBtn.addEventListener("click", () => stepFrame(1));

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

    // 划像交互：鼠标悬停位置即分界线位置（无需按住左键）；左键单击仍由播放器处理播放/暂停。
    // 分界线本身也支持按住拖动微调。
    let _wiping = false;          // 分界线拖动中
    let _wipeX = 50;              // 划像位置（0-100，未缩放坐标，相对 wipe 宽度）
    let _downX = 0, _downY = 0, _downMoved = false; // 按住移动判定：拖动后抑制 click，避免误触播放/暂停
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
        // 鼠标指向的内容在本地坐标中的比例（消除缩放与平移的影响）：
        // clip-path 的 inset 百分比相对未缩放内容坐标，直接取容器比例会在放大/平移后错位
        const t0 = _holderT[0] || { x: 0, y: 0 };
        const s = _zoomScale || 1;
        let x = ((e.clientX - r.left - t0.x) / (r.width * s)) * 100;
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
        _downX = e.clientX; _downY = e.clientY;
        _downMoved = false;
        updateWipe(e);
    });
    // 单击分界线 = 播放/暂停（悬停划像下鼠标总在分界线上，单击即点在分界线上；
    // 拖动分界线后 click 已被 onWipeUp 抑制，不会误触播放）
    wipeDivider.addEventListener("click", (e) => {
        e.stopPropagation();
        if (playing) pauseAll(); else playAll();
    });
    // 悬停划像：鼠标在画面上移动，分界线跟随（无需按住左键）；左键单击由播放器处理播放/暂停
    const onWipeHover = (e) => {
        if (!_downMoved && Math.abs(e.clientX - _downX) + Math.abs(e.clientY - _downY) > 4) _downMoved = true;
        if (_wiping) return; // 分界线拖动中由 onWipeMove 接管
        updateWipe(e);
    };
    wipe.addEventListener("mousemove", onWipeHover);
    wipe.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        _downX = e.clientX; _downY = e.clientY;
        _downMoved = false;
    });
    const onWipeMove = (e) => {
        if (!_wiping) return;
        if (!_downMoved && Math.abs(e.clientX - _downX) + Math.abs(e.clientY - _downY) > 4) _downMoved = true;
        updateWipe(e); // 分界线按住拖动：跟手
    };
    const onWipeUp = () => {
        if (_wiping && _downMoved) _suppressClick = true; // 拖动分界线/画面后抑制 click，避免误触播放/暂停
        _wiping = false;
        _downMoved = false;
    };
    window.addEventListener("mousemove", onWipeMove, true);
    window.addEventListener("mouseup", onWipeUp, true);
    overlay._xzgWipeMove = onWipeMove;
    overlay._xzgWipeUp = onWipeUp;

    ctrl.appendChild(playPauseBtn);
    ctrl.appendChild(prevFrameBtn);
    ctrl.appendChild(nextFrameBtn);
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
        // 记录各窗格的“布局矩形”（消除 holder 自身 transform 的影响）：
        // 视觉矩形 = 布局矩形经 translate(t)+scale(s) 后，反推可得布局矩形。
        // 始终记录布局矩形可保证基线不被缩放/平移污染，缩放锚点计算长期自洽。
        _holderBase = players.map((p, i) => {
            const r = p.holder.getBoundingClientRect();
            const t = _holderT[i] || { x: 0, y: 0 };
            const s = _zoomScale || 1;
            return {
                left: r.left - t.x,
                top: r.top - t.y,
                width: s > 0 ? r.width / s : r.width,
                height: s > 0 ? r.height / s : r.height,
            };
        });
        // 不重置 _holderT：保留现有缩放/平移状态，锚点依赖 基线+平移+倍率 的自洽关系
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
            // 锚点内容坐标：窗格内 rx%/ry% 处的内容点（相对窗格未缩放左上角）。
            // 鼠标所在窗格中该点即鼠标指向的内容点，因此缩放即以鼠标位置为锚点。
            const cX = b.width * rx / 100;
            const cY = b.height * ry / 100;
            // 缩放后保持该内容点位于其缩放前的屏幕位置不动（b.left + t.x + cX*sOld）
            const nX = t.x + cX * (sOld - sNew);
            const nY = t.y + cY * (sOld - sNew);
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
        // 锚点 = 鼠标所在窗格内的相对位置（各窗格统一；鼠标在空白处用中心）。
        // 用布局矩形（基线）判断所在窗格：缩放后窗格视觉溢出会盖住相邻窗格，
        // 若用 getBoundingClientRect 视觉矩形判断，鼠标会被误判到视觉上层的相邻窗格，
        // 导致真正鼠标所在的窗格锚点错乱、逐次累积漂移。
        let rx = 50, ry = 50;
        for (let i = 0; i < players.length; i++) {
            const b = _holderBase[i];
            if (b && b.width > 0 && b.height > 0 &&
                e.clientX >= b.left && e.clientX <= b.left + b.width &&
                e.clientY >= b.top && e.clientY <= b.top + b.height) {
                const t = _holderT[i] || { x: 0, y: 0 };
                rx = ((e.clientX - b.left - t.x) / (b.width * _zoomScale)) * 100;
                ry = ((e.clientY - b.top - t.y) / (b.height * _zoomScale)) * 100;
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

    // Esc 关闭；←/→ 逐帧浏览（焦点在输入控件时不响应，避免干扰进度条等）
    const onKey = (e) => {
        if (e.key === "Escape") {
            closeSyncPreview();
            return;
        }
        const t = e.target;
        const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
        if (typing) return;
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            e.stopPropagation();
            stepFrame(-1);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            e.stopPropagation();
            stepFrame(1);
        }
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
