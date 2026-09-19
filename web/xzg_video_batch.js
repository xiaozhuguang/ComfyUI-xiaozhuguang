import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { cloudLoad, cloudSave } from "./xzg_cloud_store.js";

/**
 * 小珠光 · 场景逐段批处理
 *
 * 在「小珠光视频加载-化神级」节点（XiaozhuguangVideoLoaderDaVinci，继承视频批处理 + 片段窗口）上
 * 注入「🎬 场景逐段批处理」按钮，流程：
 *   1. 调用快剪后端场景探测接口获取切点（不打开快剪编辑器，快剪无需加载任何视频）
 *   2. 相邻切点构成片段列表，逐段改写批处理节点的「片段起点/片段终点」控件
 *   3. 每段只执行该节点及其下游分支（hook queuePrompt 过滤 output），等待执行完成
 *   4. 若工作流中有「小珠光视频批处理合并」节点（XiaozhuguangVideoBatchMerge，缓冲式过渡）：
 *      逐段阶段它把每段缓冲到 temp（无音轨视频 + WAV）并把数据直通下游（下游保存节点被
 *      编排器排除，不会逐段输出）；最后编排器置位「执行合并」单独跑一次，合并节点把
 *      完整视频解码为 图像/音频 输出 → 下游「小珠光视频保存」产出并预览最终完整视频；
 *      若没有合并节点：保存节点逐段产出 → 后端 /xzg_video_batch_concat 拼接（回退路径）
 *
 * 现有三个视频加载器节点（加载器/低内存版/化神级）不做任何改动。
 */

const DETECT_API = "/xzg_video_editor_detect_scenes";
const CONCAT_API = "/xzg_video_batch_concat";
const BUFFER_RESET_API = "/xzg_video_batch_buffer_reset";
const BUFFER_LIST_API = "/xzg_video_batch_buffer_list";
const BATCH_NODE_TYPE = "XiaozhuguangVideoLoaderDaVinci"; // 小珠光视频加载-化神级
const MERGE_NODE_TYPE = "XiaozhuguangVideoBatchMerge";  // 小珠光视频批处理合并（缓冲式过渡节点）
const MIN_SEGMENT = 0.3; // 最短片段时长（秒），与快剪一致
const VIDEO_EXTS = new Set(["mp4", "webm", "mkv", "mov", "avi", "gif", "m4v", "ts"]);

// ═══════════════════════════════════════════════════════════════════════
// 窗口位置持久化（参考工作流管理器云端持久化方案：
// 服务端 ComfyUI 用户目录磁盘优先，localStorage 仅做离线兜底，
// 云平台刷新/换设备不丢）
// ═══════════════════════════════════════════════════════════════════════
const WIN_POS_KEY = "xzg_batch_win_pos";
let winPosTouched = false; // 本会话已拖动保存过：云端晚到的旧位置不再覆盖

function readLocalWinPos() {
    try {
        const p = JSON.parse(localStorage.getItem(WIN_POS_KEY) || "null");
        const left = Number(p?.left), top = Number(p?.top);
        if (!isFinite(left) || !isFinite(top)) return null;
        return { left, top };
    } catch (e) { return null; }
}

function saveWinPos(left, top) {
    if (!isFinite(left) || !isFinite(top)) return;
    const pos = { left, top };
    try { localStorage.setItem(WIN_POS_KEY, JSON.stringify(pos)); } catch (e) {}
    cloudSave(WIN_POS_KEY, pos).catch(() => {});
    winPosTouched = true;
}

/** 应用位置并 clamp 到当前视口（与拖动限制一致，防止换小屏设备后窗口落在视口外） */
function applyWinPos(overlay, pos) {
    overlay.style.left = Math.max(0, Math.min(window.innerWidth - 100, pos.left)) + "px";
    overlay.style.top = Math.max(0, Math.min(window.innerHeight - 50, pos.top)) + "px";
}

// ═══════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════

function fmtTime(t) {
    if (t == null || !isFinite(t)) return "-";
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

/** 收集 loader 节点下游所有可达节点 id（含自身） */
function collectDownstream(loaderNode) {
    const nodes = app.graph?._nodes || [];
    const links = app.graph?.links || {};
    const consumers = new Map(); // srcId -> [nodeId]
    for (const n of nodes) {
        for (const inp of n.inputs || []) {
            if (inp?.link == null) continue;
            const link = links[inp.link];
            if (!link) continue;
            const srcId = String(link.origin_id);
            if (!consumers.has(srcId)) consumers.set(srcId, []);
            consumers.get(srcId).push(String(n.id));
        }
    }
    const seen = new Set([String(loaderNode.id)]);
    const stack = [String(loaderNode.id)];
    while (stack.length) {
        const cur = stack.pop();
        for (const c of consumers.get(cur) || []) {
            if (!seen.has(c)) { seen.add(c); stack.push(c); }
        }
    }
    return seen;
}

/** hook 期间过滤 prompt.output：只保留下游分支（其余分支的输出节点不会执行） */
function filterPromptOutput(prompt, nodeIds) {
    if (!prompt?.output || !nodeIds?.size) return;
    const oldOutput = prompt.output;
    const newOutput = {};
    const visited = new Set();

    function collectValue(val) {
        if (!Array.isArray(val)) return;
        if (val.length >= 1) {
            const sourceId = String(val[0]);
            if (oldOutput[sourceId]) { addNode(sourceId); return; }
        }
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
        for (const key of Object.keys(inputs)) collectValue(inputs[key]);
    }

    for (const id of nodeIds) addNode(id);
    prompt.output = newOutput;
}

/** 从 executed 事件的 output 里提取视频类文件（只收保存到 output/ 的） */
function extractVideoOutputs(output) {
    const files = [];
    if (!output) return files;
    for (const key of Object.keys(output)) {
        if (key === "buffered") continue; // 合并节点的缓冲上报不是真实输出，防止误报文件名
        const arr = output[key];
        if (!Array.isArray(arr)) continue;
        for (const it of arr) {
            if (!it || typeof it !== "object" || !it.filename) continue;
            const ext = String(it.filename).split(".").pop().toLowerCase();
            if (!VIDEO_EXTS.has(ext)) continue;
            if ((it.type || "output") !== "output") continue; // temp/预览输出不收集
            files.push({ filename: it.filename, subfolder: it.subfolder || "", type: "output" });
        }
    }
    return files;
}

/** 从 ComfyUI 执行历史按 prompt_id 查本次运行产出的视频。
 * 最终合并整轮被缓存命中时 ComfyUI 不会重发 executed 事件（文件实际已产出），
 * 只能查历史兜底。nodeIds: 允许收集输出的节点 id 集合。返回 [{filename,...}] 或 [] */
async function fetchHistoryOutputByPrompt(promptId, nodeIds) {
    try {
        const resp = await fetch(`/history/${promptId}`);
        if (!resp.ok) return [];
        const j = await resp.json();
        const entry = j?.[String(promptId)];
        const outputs = entry?.outputs || {};
        for (const nid of nodeIds) {
            const o = outputs[String(nid)];
            if (o) {
                const vids = extractVideoOutputs(o);
                if (vids.length) return vids;
            }
        }
        return [];
    } catch (e) {
        return [];
    }
}

/** 查询缓冲目录的当前状态（以服务端为准，避免 executed 事件竞态） */
async function fetchBufferList() {
    try {
        const resp = await fetch(BUFFER_LIST_API, { method: "POST" });
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        return null;
    }
}

/** 轮询 /history/{prompt_id}，等待 prompt 真正执行完成（可选的精确等待路径）。
 * /history 只在 prompt 结束（成功或出错）后才有记录，绝对可靠。
 * 仅当 api.queuePrompt 能返回 prompt_id（新版 ComfyUI）时使用；
 * 老版本不返回 prompt_id，回退到 waitExecutionDone 事件等待 + waitQueueIdle 兜底。 */
async function waitForPromptDone(promptId, timeoutMs = 3600000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const r = await fetch(`/history/${promptId}`);
            if (r.ok) {
                const j = await r.json();
                const entry = j ? j[String(promptId)] : null;
                if (entry) {
                    const status = entry.status || {};
                    if (status.status_str === "error") {
                        const msgs = (status.messages || []).filter((m) => m && m[0] === "execution_error");
                        const errInfo = msgs.length ? (msgs[0][1] || {}) : {};
                        throw new Error(errInfo.exception_message || "工作流执行出错（详情见 ComfyUI 控制台）");
                    }
                    return; // completed
                }
            }
        } catch (e) {
            // 只向上传播明确的执行错误；网络抖动继续轮询
            if (e && typeof e.message === "string" && e.message.indexOf("执行出错") >= 0) throw e;
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("等待工作流执行完成超时");
}

/** 等待当前 prompt 执行完成（executing 置空 / execution_error）。
 * 与合成前（原批处理节点）使用的原始实现保持一致；idBox.id 为空（老版本 api.queuePrompt
 * 不返回 prompt_id）时 isCurrent 走宽松匹配。可能的提前 resolve 由 waitQueueIdle
 * （超时足够长）兜底，等到队列真正空闲后再做缓冲判定。 */
function waitExecutionDone(idBox) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            api.removeEventListener("executing", onExecuting);
            api.removeEventListener("execution_error", onError);
            api.removeEventListener("execution_success", onExecuting);
        };
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(arg);
        };
        const isCurrent = (pid) => !idBox.id || !pid || String(pid) === String(idBox.id);
        function onExecuting(e) {
            const d = e.detail || {};
            if (d.node_id != null || d.node != null) return; // 还在跑
            if (!isCurrent(d.prompt_id)) return;
            finish(resolve);
        }
        function onError(e) {
            const d = e.detail || {};
            if (!isCurrent(d.prompt_id)) return;
            finish(reject, new Error(d.exception_message || "工作流执行出错"));
        }
        api.addEventListener("executing", onExecuting);
        api.addEventListener("execution_error", onError);
        api.addEventListener("execution_success", onExecuting);
    });
}

/** 执行一轮：hook queuePrompt 过滤 output 分支 → 队列 → 等完成 → 收集输出 */
async function runOnce(downIds, idBox, collected) {
    const done = waitExecutionDone(idBox);
    const orig = api.queuePrompt;
    try {
        api.queuePrompt = async function (index, prompt, ...rest) {
            filterPromptOutput(prompt, downIds);
            const r = await orig.call(api, index, prompt, ...rest);
            if (r?.prompt_id) idBox.id = r.prompt_id;
            return r;
        };
        await app.queuePrompt(0);
    } finally {
        api.queuePrompt = orig;
    }
    if (idBox.id) {
        // 新版：/history 权威等待（绝对可靠，不受事件时序影响）
        await waitForPromptDone(idBox.id);
    } else {
        // 老版本 api.queuePrompt 不返回 prompt_id：走原始事件等待
        await done;
    }
    await waitQueueIdle();
    return collected;
}

/** 监听 executed 事件收集输出（必须在 queue 之前挂上）；
 * collected 只收保存到 output/ 的视频；buffered 收合并节点的缓冲上报 */
/** 等待服务端队列真正空闲（running 和 pending 都为空）。
 * runOnce 的事件监听可能提前返回，导致下一轮 queue 与上一轮重叠执行（同段被缓冲两次的根源之一） */
async function waitQueueIdle(timeoutMs = 3600000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const r = await fetch("/queue");
            const j = await r.json();
            if (!(j.queue_running || []).length && !(j.queue_pending || []).length) return true;
        } catch (e) { /* 查询失败按空闲处理，由后续缓冲校验兜底 */ return true; }
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

/** 从 executed 事件的 output 里提取合并节点的缓冲上报（ui.buffered） */
function extractBuffered(output) {
    const arr = output?.buffered;
    if (!Array.isArray(arr)) return [];
    return arr
        .filter((it) => it && it.filename)
        .map((it) => ({
            filename: it.filename,
            subfolder: it.subfolder || "",
            type: it.type || "temp",
            frames: it.frames,       // 段帧数（行内"XX 帧"显示用）
            with_audio: it.with_audio,
        }));
}

/** 监听 executed 事件：collected 收保存到 output 的视频；buffered 收合并节点的缓冲上报 */
function attachCollector(collected, buffered) {
    const onExecuted = (e) => {
        const d = e.detail || {};
        collected.push(...extractVideoOutputs(d.output));
        if (buffered) buffered.push(...extractBuffered(d.output));
    };
    api.addEventListener("executed", onExecuted);
    return () => api.removeEventListener("executed", onExecuted);
}

// ═══════════════════════════════════════════════════════════════════════
// 对话框 UI
// ═══════════════════════════════════════════════════════════════════════

const GOLD = "#dcc85b";

function buildDialog() {
    const overlay = document.createElement("div");
    overlay.className = "xzg-batch-overlay";
    // 独立浮动窗口（非全屏遮罩）：不挡画布，可拖动，边跑批处理边看画布
    overlay.style.cssText = `
        position:fixed; left:70px; top:70px; z-index:99999; display:none;
        font-family:sans-serif; font-size:13px; color:#ddd;`;
    overlay.innerHTML = `
        <div style="background:#1e1e1e;border:1px solid #444;border-radius:10px;width:340px;height:600px;max-width:92vw;
                    max-height:88vh;overflow:hidden;resize:both;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.6);">
          <div id="xzg-batch-head" style="padding:10px 18px;border-bottom:1px solid #333;font-size:15px;font-weight:600;
                      color:${GOLD};cursor:move;user-select:none;">
            🎬 视频切点探测及批处理
          </div>
          <div style="padding:14px 18px;display:flex;flex-direction:column;gap:10px;flex:1;overflow:hidden;min-height:0;">
            <div>源视频：<b id="xzg-batch-video" style="color:#fff;"></b></div>
            <div style="display:flex;align-items:center;justify-content:flex-end;">
              <button id="xzg-batch-detect" style="background:#333;color:${GOLD};border:1px solid #555;
                     border-radius:5px;padding:5px 12px;cursor:pointer;">自动探测视频切点</button>
            </div>
            <div id="xzg-batch-segments" style="background:#262626;border:1px solid #3a3a3a;border-radius:6px;
                padding:8px 10px;min-height:60px;flex:1;overflow:auto;line-height:1.7;"></div>
            <div id="xzg-batch-status" style="color:#9ab;min-height:18px;"></div>
            <div id="xzg-batch-log" style="background:#191919;border:1px solid #333;border-radius:6px;
                padding:6px 10px;max-height:150px;overflow:auto;font-size:12px;color:#8a8;line-height:1.6;display:none;"></div>
          </div>
          <div style="padding:10px 18px 14px;display:flex;gap:10px;align-items:center;border-top:1px solid #333;">
            <button id="xzg-batch-close" style="margin-right:auto;background:#5a2a2a;color:#faa;border:1px solid #744;
                   border-radius:5px;padding:6px 14px;cursor:pointer;">关闭</button>
            <button id="xzg-batch-abort" style="display:none;background:#3a3a10;color:#ffd24a;border:1px solid #665b1e;
                   border-radius:5px;padding:6px 14px;cursor:pointer;font-weight:bold;">中断</button>
            <button id="xzg-batch-run" style="background:#14501a;color:#3ee06a;border:1px solid #1f7a33;
                   border-radius:5px;padding:8px 22px;cursor:pointer;font-size:15px;font-weight:bold;">开始任务</button>
          </div>
        </div>`;
    document.body.appendChild(overlay);
    // 标题栏拖动窗口
    const head = overlay.querySelector("#xzg-batch-head");
    head.addEventListener("mousedown", (e) => {
        const rect = overlay.getBoundingClientRect();
        const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
        const move = (ev) => {
            overlay.style.left = Math.max(0, Math.min(window.innerWidth - 100, ev.clientX - dx)) + "px";
            overlay.style.top = Math.max(0, Math.min(window.innerHeight - 50, ev.clientY - dy)) + "px";
        };
        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            saveWinPos(parseFloat(overlay.style.left), parseFloat(overlay.style.top));
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
        e.preventDefault();
    });
    return overlay;
}

function getDialog() {
    return document.querySelector(".xzg-batch-overlay") || buildDialog();
}

// ═══════════════════════════════════════════════════════════════════════
// 会话归属：对话框与批处理任务都属于「打开它时所在的工作流」。
//   · 切到其他工作流标签页：隐藏窗口并在段边界【暂停】，不中断后端，
//     已在队列里的当前段会继续跑完；切回本工作流自动重新显示并续跑；
//   · 菜单「清空工作流」/ 在本工作流内删除绑定节点 / 在别的加载器上
//     重新打开对话框：会话彻底失效，中止任务。
// 工作流身份用 LGraph.id（序列化时持久化，标签页切换保持稳定），
// 节点实例切换后会重建，一律按 id 实时解析，不持有旧实例。
// ═══════════════════════════════════════════════════════════════════════

const NIL_GRAPH_ID = "00000000-0000-0000-0000-000000000000";
let activeSession = null; // 见 openBatchDialog 中的会话结构
let graphLoading = false; // loadGraphData 执行中（切换标签页会触发 graph.clear → onRemoved）

function hideOverlay() {
    const overlay = document.querySelector(".xzg-batch-overlay");
    if (overlay) overlay.style.display = "none";
}
function showOverlay() {
    const overlay = getDialog();
    if (overlay) overlay.style.display = "block";
}
function findLiveNode(id, type) {
    return (app.graph?._nodes || []).find((n) =>
        String(n.id) === String(id) && (!type || n.type === type)) || null;
}
/** 无 id 的旧工作流兜底身份：节点 id:type 集合签名 */
function graphSignature() {
    return (app.graph?._nodes || [])
        .map((n) => `${n.id}:${n.type}`).sort().join("|");
}
function graphMatchesSession(s) {
    const gid = app.graph?.id;
    if (s.graphId && s.graphId !== NIL_GRAPH_ID) return gid === s.graphId;
    return !!s.graphSig && graphSignature() === s.graphSig;
}

/** 新图载入后（标签页切换/打开文件/载入 JSON 都会走到）：
 *  绑定工作流重新挂载 → 重新绑定节点实例、重新显示；否则隐藏并暂停。 */
function syncSession() {
    const s = activeSession;
    if (!s) return;
    if (graphMatchesSession(s)) {
        const live = findLiveNode(s.nodeId, BATCH_NODE_TYPE);
        if (live) {
            s.node = live;
            s.active = true;
            if (s.mergeId != null) {
                const m = findLiveNode(s.mergeId, MERGE_NODE_TYPE);
                if (m) s.mergeNode = m;
            }
            if (s.open) showOverlay();
            return;
        }
    }
    s.active = false;
    hideOverlay();
}

/** 会话彻底失效（清空工作流/删除绑定节点/被新会话取代）：隐藏并中止任务 */
function abortSession(s) {
    if (!s) return;
    if (activeSession === s) activeSession = null;
    s.open = false;
    s.active = false;
    s.abortFlag.v = true;
    hideOverlay();
    try { api.interrupt(); } catch (e) { /* ignore */ }
}

// 切换工作流标签页 / 打开工作流文件 / 载入 JSON / 历史记录载入，
// 最终都会走 app.loadGraphData，hook 它在新图载入后同步会话归属状态。
const _origLoadGraphData = app.loadGraphData?.bind(app);
if (typeof _origLoadGraphData === "function") {
    app.loadGraphData = async function (...args) {
        graphLoading = true;
        try {
            return await _origLoadGraphData(...args);
        } finally {
            graphLoading = false;
            try { syncSession(); } catch (e) { /* ignore */ }
            // 二次同步：个别场景节点异步创建，300ms 后再核对一次（幂等）
            setTimeout(() => { try { syncSession(); } catch (e) { /* ignore */ } }, 300);
        }
    };
}
// 菜单「清空工作流」：clean() 直接 rootGraph.clear()，不经过 loadGraphData。
// 它只作用于当前活动工作流，会话处于 active 才说明被清空的是绑定工作流。
document.addEventListener("graphCleared", () => {
    if (activeSession?.active) abortSession(activeSession);
});

// ═══════════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════════

async function detectScenes(filename, threshold) {
    const resp = await fetch(DETECT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, file_type: "input", threshold }),
    });
    const j = await resp.json();
    if (!resp.ok) throw new Error(j.error || "切点探测失败");
    return j.scenes || [];
}

/** 切点列表 → 片段区间。
 *  winStart/winEnd：批处理窗口（全片秒，来自用户预设的跳过帧数/帧数上限）。
 *  有窗口时：切点只在窗口内取，首段起点=窗口起点，末段终点=窗口终点（秒）；
 *  无窗口（默认）：全片切分，最后一段终点为 0（表示"到片尾"）。 */
function cutsToSegments(cuts, winStart = 0, winEnd = 0) {
    const segs = [];
    let prev = winStart;
    for (const t of cuts) {
        if (t <= prev) continue;
        if (winEnd > 0 && t >= winEnd) break;
        if (t - prev < MIN_SEGMENT) continue;
        segs.push({ start: prev, end: t });
        prev = t;
    }
    let lastEnd = winEnd > 0 ? winEnd : 0;
    // 末段过短且已有前段：并入前段（终点外扩到窗口终点/片尾）
    if (lastEnd > 0 && lastEnd - prev < MIN_SEGMENT && segs.length) {
        segs[segs.length - 1].end = lastEnd;
        return segs;
    }
    segs.push({ start: prev, end: lastEnd });
    return segs;
}

// 编排模式提示去重：同一编排模式只提示一次，中断后再次开始不重复刷屏
let lastOrchHint = "";

async function runBatch(node, segments, ui, abortFlag, session = null) {
    const nodeId = String(node.id);
    // 工作流标签页切换会重建节点实例：节点/控件一律按 id 实时解析，
    // 不长期持有打开对话框时的旧实例（旧实例在 graph.clear 后已脱离画布）。
    let liveNode = node;
    let wSkip, wLimit, wStart, wEnd;
    const resolveLive = () => {
        liveNode = findLiveNode(nodeId, BATCH_NODE_TYPE) || node;
        wSkip = findWidget(liveNode, "跳过帧数");
        wLimit = findWidget(liveNode, "帧数上限");
        wStart = findWidget(liveNode, "片段起点");
        wEnd = findWidget(liveNode, "片段终点");
        return liveNode;
    };
    resolveLive();
    // 段窗口用「跳过帧数/帧数上限」（帧）表达，与红杠/蓝杠/右下角帧号显示天然一致：
    // 红杠=跳过帧数（段起点帧），蓝杠=跳过帧数+帧数上限（段终点帧），控件值即执行参数。
    // 「片段起点/片段终点」（秒）置 0，避免两套窗口参数叠加造成双重偏移。
    if (!wSkip || !wLimit) {
        throw new Error("加载器缺少「跳过帧数/帧数上限」控件，请刷新页面后重试");
    }
    // 段边界秒→帧换算需要源帧率（视频加载后由解码探测，onSourceFpsDetected 写入）
    const srcFps = Number(node._xzgSourceFps) || Number(node._xzgVideoPlayer?.getFrameRate?.()) || 0;
    if (!srcFps || srcFps <= 0) {
        throw new Error("未探测到源视频帧率：请先在加载器里加载一次视频（或运行一次工作流）后再开始批处理");
    }
    // 批处理前的控件原值：结束后恢复，避免影响用户后续手动执行
    const origSkip = Number(wSkip.value) || 0;
    const origLimit = Number(wLimit.value) || 0;
    const origStart = Number(wStart?.value) || 0;
    const origEnd = Number(wEnd?.value) || 0;
    // 缓冲式合并节点（存在时）：逐段缓冲到 temp，最后单独跑一次合并
    const mergeNode = (app.graph?._nodes || []).find((n) => n.type === MERGE_NODE_TYPE);
    const mergeId = mergeNode ? String(mergeNode.id) : null;
    if (session && mergeId != null) session.mergeId = mergeId;
    // 合并节点同样按 id 实时解析（切走再切回后实例已重建）
    const resolveMerge = () => {
        if (!mergeNode) return null;
        return findLiveNode(mergeId, MERGE_NODE_TYPE) || mergeNode;
    };
    if (mergeNode) {
        // 前置检查：合并节点必须接了「图像」输入、且位于批处理节点下游，否则逐段阶段不会缓冲
        const imgInput = (mergeNode.inputs || []).find((i) => i.name === "图像");
        if (!imgInput || imgInput.link == null) {
            throw new Error("合并节点的「图像」输入未连接：请把处理链的图像输出接到合并节点（否则逐段阶段不会缓冲，最终合并会报缓冲区为空）");
        }
        if (!collectDownstream(node).has(String(mergeNode.id))) {
            throw new Error("合并节点不在「视频批处理」的下游链路中：请检查 图像/音频 连线（逐段缓冲依赖数据流经合并节点）");
        }
        // 前置检查：合并节点下游必须接有输出节点（如「小珠光视频保存」），
        // 否则最终合并的完整视频无处输出（表现为整轮跑完无预览、无保存）
        const belowNodes = [...collectDownstream(mergeNode)]
            .filter((id) => id !== String(mergeNode.id))
            .map((id) => (app.graph?._nodes || []).find((n) => String(n.id) === id))
            .filter((n) => n && n.constructor?.nodeData?.output_node);
        if (!belowNodes.length) {
            throw new Error("合并节点的下游没有连接任何输出节点（如「小珠光视频保存」）：\n请把合并节点的「图像」「音频」输出接到保存视频节点，最终合并的完整视频才会被保存/预览");
        }
        try {
            await fetch(BUFFER_RESET_API, { method: "POST" });
        } catch (e) { /* 重置失败不阻塞，finalize 会校验缓冲 */ }
    }

    // 逐段执行的输出节点集合（白名单式，绝对排除下游）：
    // 有合并节点 → 只保留合并节点为输出节点。其上游（加载器/处理链）作为依赖由后端
    // 连带执行；其下游（保存视频节点等）不在执行图里，逐段阶段不可能被触发输出；
    // 最终合并阶段单独用 collectDownstream(mergeNode) 恢复下游，产出完整视频。
    // 无合并节点（回退路径）→ 保留批处理节点下游全部输出节点（逐段直接产出，最后拼接）。
    let downIds;
    if (mergeNode) {
        downIds = new Set([String(mergeNode.id)]);
    } else {
        downIds = collectDownstream(node);
        const hint = "编排模式：回退拼接（未找到「小珠光视频批处理合并」节点），逐段直接产出最后拼接";
        if (hint !== lastOrchHint) { ui.log(hint, true); lastOrchHint = hint; }
    }

    const allOutputs = [];
    const skippedSegments = [];
    let aborted = false;
    ui.abortBtn.style.display = "";
    let detach = null;
    // 缓冲是否成功以服务端缓冲目录为准（避免 executed 事件竞态导致误判/漏判）
    let prevCount = 0;
    if (mergeNode) {
        const bl = await fetchBufferList();
        prevCount = bl ? (bl.count || 0) : 0;
    }
    // 分段行内状态复位
    segments.forEach((_, i) => { ui.segStatus?.(i, "待执行"); ui.segFrames?.(i, 0); });

    try {
        for (let i = 0; i < segments.length; i++) {
            if (abortFlag.v) { aborted = true; ui.segStatus?.(i, "已中断", "#fa0"); break; }
            // 切到了其他工作流：在段边界暂停（不中断，已在跑的当前段继续跑完），
            // 切回本工作流后自动续跑
            if (session) {
                await session.waitActive(ui);
                resolveLive();
                if (abortFlag.v) { aborted = true; ui.segStatus?.(i, "已中断", "#fa0"); break; }
            }
            const seg = segments[i];
            ui.segStatus?.(i, "执行中", "#fa0");

            // 每段最多尝试 3 次：与之前运行参数完全相同时 ComfyUI 会缓存命中（整链跳过执行），
            // 导致合并节点不缓冲 → 重试时对片段窗口做 1ms 级微移绕过缓存（画面无感知）
            const MAX_ATTEMPTS = 3;
            const collected = [];
            const buffered = [];
            let newFiles = [];
            // 段级快照：本段开始前的缓冲文件清单。成功判定用「文件 diff」而非计数对比——
            // 计数会受文件系统延迟 / 执行重叠影响而误判（少算→多余重试→重复缓冲；
            // 多算→误判成功），diff 能精确识别本段新增的缓冲文件
            const segBl = mergeNode ? await fetchBufferList() : null;
            const segSet = new Set(segBl ? segBl.files : []);
            for (let attempt = 1; attempt <= MAX_ATTEMPTS && !abortFlag.v; attempt++) {
                // 段窗口 → 帧参数：红杠（跳过帧数）= 段起点帧，帧数上限 = 段长帧数（0=到片尾）；
                // 控件值即执行参数，也与红蓝杠/右下角帧号显示完全一致
                const segSkipFrames = Math.max(0, Math.round(seg.start * srcFps));
                const segLimitFrames = seg.end > 0
                    ? Math.max(0, Math.round(seg.end * srcFps) - segSkipFrames)
                    : 0;
                if (attempt === 1) {
                    wSkip.value = segSkipFrames;
                    wLimit.value = segLimitFrames;
                    if (wStart) wStart.value = 0;
                    if (wEnd) wEnd.value = 0;
                } else {
                    // 静默微移：与历史运行参数相同会命中 ComfyUI 缓存（不执行、不缓冲），
                    // 跳过帧数 +N 帧（1 帧 ≈ 数十毫秒，画面无感知）强制真实执行
                    wSkip.value = segSkipFrames + (attempt - 1);
                    wLimit.value = segLimitFrames;
                }
                liveNode.setDirtyCanvas?.(true, true);
                collected.length = 0;
                buffered.length = 0;
                detach = attachCollector(collected, buffered);
                const idBox = { id: null };
                try {
                    await runOnce(downIds, idBox, collected);
                } catch (e) {
                    // 用户中断会让当前段执行被 ComfyUI 中止并抛错（如"工作流执行出错"）。
                    // 此时按中断处理，不再把执行错误向上抛出误报
                    if (abortFlag.v) {
                        aborted = true;
                        ui.segStatus?.(i, "已中断", "#fa0");
                        break;
                    }
                    throw e;
                } finally {
                    detach?.();
                    detach = null;
                }
                if (mergeNode) {
                    // 关键：先等队列真正空闲，防止重试队列与当前执行重叠（同段被缓冲两次的根源）
                    await waitQueueIdle();
                    // 成功判定：以「缓冲目录文件 diff」为权威（相对本段开始前的快照）。
                    // 不能用 ui.buffered 事件判断：缓存命中时 ComfyUI 会原样重放上次的 ui，
                    // 事件有假阳性（表现为"已缓冲"但磁盘上什么都没写）
                    let ok = false;
                    let added = [];
                    for (let k = 0; k < 7 && !abortFlag.v; k++) {
                        const bl = await fetchBufferList();
                        if (bl === null) break; // 查询失败：无法判定，下面按未缓冲处理
                        added = (bl.files || []).filter((f) => !segSet.has(f));
                        if (added.length >= 1) { ok = true; break; }
                        await new Promise((r) => setTimeout(r, 300));
                    }
                    if (ok) {
                        newFiles = added.map((f) => ({ filename: f }));
                        if (added.length > 1) {
                            ui.log(`警告：第 ${i + 1} 段检测到 ${added.length} 个缓冲文件（执行重叠所致），以最后缓冲的分段为准`, true);
                        }
                        const blNow = await fetchBufferList();
                        prevCount = blNow ? (blNow.count || 0) : 0;
                        break;
                    }
                    if (attempt < MAX_ATTEMPTS) {
                        // 静默重试：缓存命中段自动微移窗口后重新执行，不再显示"跳过"提示
                    }
                } else if (collected.length) {
                    break;
                }
            }
            allOutputs.push(...collected);

            if (mergeNode) {
                if (newFiles.length) {
                    // 行内状态：该分镜已完成 + 帧数（成功那次执行的真实缓冲上报，最终合并成功后再标「已执行」）
                    ui.segStatus?.(i, "该分镜已完成", "#8c8");
                    const fr = buffered.length ? buffered[buffered.length - 1].frames : null;
                    if (fr) ui.segFrames?.(i, fr);
                } else if (!abortFlag.v) {
                    // 仅在非中断时才判定"未缓冲"：中断属用户主动行为，不是执行失败
                    skippedSegments.push(i + 1);
                    ui.segStatus?.(i, "未完成", "#f66");
                    ui.status(`第 ${i + 1} 段未缓冲成功（该段不会进入最终合并）`, true);
                    ui.log(`第 ${i + 1} 段重试 ${MAX_ATTEMPTS} 次仍未缓冲。常见原因：合并节点「图像」输入未连接 / 「帧率」输入值 ≤ 0 / 上游节点执行失败`, true);
                }
            } else if (collected.length) {
                ui.segStatus?.(i, "已执行", "#8c8");
                ui.log(`第 ${i + 1} 段完成 → ${collected.map((f) => f.filename).join(", ")}`);
            } else if (!abortFlag.v) {
                skippedSegments.push(i + 1);
                ui.segStatus?.(i, "未完成", "#f66");
                ui.status(`第 ${i + 1} 段未收集到视频输出（该段不会参与合并）`, true);
                ui.log(`第 ${i + 1} 段完成，但未收集到保存到 output 的视频输出。常见原因：末端保存节点不在「视频批处理」下游 / 是图像类保存节点 / 第三方预览节点输出到 temp`, true);
            }
        }
    } finally {
        ui.abortBtn.style.display = "none";
        // 无论批次如何结束，恢复批处理前的控件原值（段窗口参数全部还原，不影响手动执行）
        resolveLive();
        if (wSkip) wSkip.value = origSkip;
        if (wLimit) wLimit.value = origLimit;
        if (wStart) wStart.value = origStart;
        if (wEnd) wEnd.value = origEnd;
        liveNode.setDirtyCanvas?.(true, true);
    }

    // 结束时恢复加载器预览：批处理期间预览跟随每段输出，最后一次执行往往是
    // "合并空跑"的极小窗口（约 1 帧），需要重置回原始加载的视频
    resolveLive();
    liveNode._xzgResetLoaderPreview?.();
    if (aborted) {
        // 运行完毕（中断）：立即清理缓冲，不留缓存
        if (mergeNode) {
            try { await fetch(BUFFER_RESET_API, { method: "POST" }); } catch (e) { /* ignore */ }
        }
        return { aborted: true, outputs: allOutputs, merged: null, usedMergeNode: !!mergeNode };
    }

    // 最终合并阶段也要等回本工作流（合并节点控件只存在于挂载的图上）
    if (session) {
        await session.waitActive(ui);
        resolveLive();
        if (abortFlag.v) {
            return { aborted: true, outputs: allOutputs, merged: null, usedMergeNode: !!mergeNode };
        }
    }

    let merged = null;
    if (mergeNode) {
        if (skippedSegments.length) {
            ui.log(`警告：第 ${skippedSegments.join("、")} 段未成功缓冲，最终视频将缺少这些段落`, true);
            ui.status(`警告：${skippedSegments.length} 段未缓冲，详见日志`, true);
        }
        // 最终合并前校验：缓冲数量必须与段数严格一致（少了=缺段，多了=重复缓冲，
        // 两种情况拼出来都是坏视频，直接拦下）
        const bl = await fetchBufferList();
        const expected = segments.length - skippedSegments.length;
        if (bl && (bl.count || 0) !== expected) {
            throw new Error(`缓冲区有 ${bl.count || 0} 个分段，但预期是 ${expected} 个` +
                ((bl.count || 0) > expected
                    ? "（存在重复缓冲，可能因执行时序异常）。已取消合并，请点「开始」重新运行（开始时会自动清空缓冲）"
                    : "（部分段未缓冲成功）。已取消合并，请重新运行批处理"));
        }
        // 最终合并：编排器把「执行合并」置位 → 单独跑一次合并节点
        // （concat 全部缓冲 → 直接产出最终完整视频到 output/）
        const liveMerge = resolveMerge();
        const wGo = findWidget(liveMerge, "执行合并");
        if (!wGo) throw new Error("「小珠光视频批处理合并」节点缺少「执行合并」控件，请刷新页面后重试");
        ui.status(`合并缓冲中的片段…`);
        const savedGo = wGo.value;
        wGo.value = true;
        liveMerge.setDirtyCanvas?.(true, true);
        // 合并节点的图像输入若连着逐段链路，本轮上游会被连带执行一次；
        // 把批处理节点临时设为「帧数上限=1」，让上游空跑开销降到最低且必然解出 1 帧
        // （不用极小时间窗口：某些视频 0.05s 内解不出帧会报 No frames decoded）
        const wCap = findWidget(liveNode, "帧数上限");
        let savedCap = null;
        if (liveMerge.inputs?.some((i) => i.link != null) && wCap) {
            savedCap = wCap.value;
            wCap.value = 1;
            liveNode.setDirtyCanvas?.(true, true);
        }
        try {
            const mCollected = [];
            const mDetach = attachCollector(mCollected);
            const mBox = { id: null };
            try {
                await runOnce(collectDownstream(liveMerge), mBox, mCollected);
            } finally {
                mDetach();
            }
            await waitQueueIdle();
            let vid = mCollected[mCollected.length - 1] || null;
            // 兜底 1：executed 事件可能晚到，稍等再查
            for (let k = 0; k < 6 && !vid && !abortFlag.v; k++) {
                await new Promise((r) => setTimeout(r, 300));
                vid = mCollected[mCollected.length - 1] || null;
            }
            // 兜底 2：整轮被缓存命中时事件不会重发，但文件实际已产出（上轮同参数运行）
            // → 按 prompt_id 查执行历史，从合并节点下游节点取真实输出
            if (!vid && mBox.id) {
                const vids = await fetchHistoryOutputByPrompt(mBox.id, collectDownstream(liveMerge));
                if (vids.length) vid = vids[vids.length - 1];
            }
            if (!vid) {
                throw new Error("合并已执行但未收集到最终视频：请确认「小珠光视频保存」节点连接在合并节点的「图像」「音频」输出之后（完整视频经保存节点产出），并查看 ComfyUI 控制台报错");
            }
            merged = vid;
        } finally {
            wGo.value = savedGo;
            if (savedCap != null) {
                wCap.value = savedCap;
            }
            liveMerge.setDirtyCanvas?.(true, true);
            liveNode.setDirtyCanvas?.(true, true);
        }
    } else {
        // 回退（工作流无合并节点）：保存节点逐段产出 → 后端直接拼接
        if (!allOutputs.length) {
            throw new Error("未收集到任何保存到 output 的视频输出，无法合并。请在工作流中添加「小珠光视频批处理合并」节点（推荐），或检查末端保存节点");
        }
        ui.status(`合并 ${allOutputs.length} 个片段产物…`);
        // 拼接产物前缀自动取源视频名
        const videoBase = (findWidget(liveNode, "视频")?.value || "batch")
            .replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_");
        const resp = await fetch(CONCAT_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ files: allOutputs, prefix: `${videoBase}_batch_full`, format: "mp4" }),
        });
        const j = await resp.json();
        if (!resp.ok || !j.filename) throw new Error(j.error || "合并失败");
        merged = j;
    }
    liveNode._xzgResetLoaderPreview?.();
    return { aborted: false, outputs: allOutputs, merged, usedMergeNode: !!mergeNode };
}

function openBatchDialog(node) {
    // 同一工作流同一节点重入（窗口被切换隐藏后又点按钮）：只重绑实例并重新显示
    if (activeSession && activeSession.open
        && String(activeSession.nodeId) === String(node.id)
        && graphMatchesSession(activeSession)) {
        activeSession.node = node;
        activeSession.active = true;
        showOverlay();
        return;
    }
    // 在别的加载器/别的工作流上打开：旧会话彻底失效（运行中则中止）
    if (activeSession) abortSession(activeSession);

    const overlay = getDialog();
    const $ = (id) => overlay.querySelector("#" + id);
    const wVideo = findWidget(node, "视频");

    $("xzg-batch-video").textContent = wVideo?.value || "(未选择)";
    $("xzg-batch-segments").innerHTML = `<span style="color:#666;">点击「自动探测视频切点」探测场景切换位置</span>`;
    $("xzg-batch-status").textContent = "";
    $("xzg-batch-log").style.display = "none";
    $("xzg-batch-log").innerHTML = "";
    $("xzg-batch-run").disabled = false;
    $("xzg-batch-run").textContent = "开始任务";
    // 复位上一次会话遗留的按钮状态（中断按钮隐藏、关闭按钮恢复可点）
    $("xzg-batch-abort").style.display = "none";
    $("xzg-batch-close").style.cssText = "margin-right:auto;background:#5a2a2a;color:#faa;border:1px solid #744;" +
        "border-radius:5px;padding:6px 14px;cursor:pointer;";
    overlay.style.display = "block";
    // 窗口位置持久化：本地缓存命中立即恢复（同步、无闪烁），否则用默认位置；
    // 云端数据异步到达后再校正一次（换设备/清缓存场景，云优先）
    const localPos = readLocalWinPos();
    if (localPos) {
        applyWinPos(overlay, localPos);
    } else {
        // 默认位置：水平贴左侧工具栏，垂直在画布中心（按面板实际高度动态计算）
        const panel = overlay.firstElementChild;
        const ph = panel?.offsetHeight || 600;
        overlay.style.left = "70px";
        overlay.style.top = Math.max(60, Math.round((window.innerHeight - ph) / 2)) + "px";
    }
    cloudLoad(WIN_POS_KEY, { fallbackValue: null }).then((remote) => {
        if (winPosTouched) {
            // 打开后、云端响应到达前用户已拖动：cloudLoad 可能把云端旧值回写了
            // localStorage，以窗口当前实际位置为准重写本地+云端，纠正竞态
            const left = parseFloat(overlay.style.left), top = parseFloat(overlay.style.top);
            if (isFinite(left) && isFinite(top)) saveWinPos(left, top);
            return;
        }
        if (remote) applyWinPos(overlay, remote);
    }).catch(() => {});

    let segments = null;
    let running = false;
    const abortFlag = { v: false };

    // 会话：归属打开时的工作流（graphId）。切走只暂停，清空/删节点/别处重开才中止。
    // 节点实例切换标签页后会重建，runBatch 内一律按 nodeId 实时解析。
    const session = {
        graphId: app.graph?.id || NIL_GRAPH_ID,
        graphSig: graphSignature(),
        node,
        nodeId: String(node.id),
        mergeId: null,
        active: true,   // 绑定工作流是否为当前挂载的图
        open: true,     // 对话框是否处于打开状态
        abortFlag,
        /** 切走时在段边界等待：不中断后端、不提交新段；切回本工作流自动继续 */
        async waitActive(uiObj) {
            if (this.active) return;
            uiObj?.status?.("已切换到其他工作流：任务已暂停，切回本工作流自动继续", true);
            while (activeSession === this && !this.abortFlag.v && !this.active) {
                await new Promise((r) => setTimeout(r, 300));
            }
            if (this.abortFlag.v) return;
            uiObj?.status?.("已切回本工作流，继续执行…");
        },
    };
    activeSession = session;

    // 关闭：运行中不可关，提醒先中断；空闲时直接关
    const close = () => {
        if (running) {
            $("xzg-batch-status").textContent = "请先中断任务";
            $("xzg-batch-status").style.color = "#f8b";
            return;
        }
        overlay.style.display = "none";
        if (activeSession === session) {
            session.open = false;
            activeSession = null;
        }
    };
    $("xzg-batch-close").onclick = close;

    const ui = {
        status: (t, warn) => {
            $("xzg-batch-status").textContent = t;
            $("xzg-batch-status").style.color = warn ? "#f90" : "#9ab";
        },
        log: (t, warn) => {
            const box = $("xzg-batch-log");
            box.style.display = "";
            const line = document.createElement("div");
            line.textContent = t;
            if (warn) line.style.color = "#f90";
            box.appendChild(line);
            box.scrollTop = box.scrollHeight;
        },
        // 大字提示：所有分镜完成、合并成功（绿色大字，居中）
        logDone: () => {
            const box = $("xzg-batch-log");
            box.style.display = "";
            const line = document.createElement("div");
            line.textContent = "分段任务已完成";
            line.style.cssText = "color:#22c55e;font-size:18px;font-weight:700;text-align:center;padding:8px 0;" +
                "text-shadow:0 0 10px rgba(34,197,94,.45);";
            box.appendChild(line);
            box.scrollTop = box.scrollHeight;
        },
        // 分段行内状态：待执行 / 执行中(橙) / 已执行(绿) / 未完成(红)
        segStatus: (i, text, color) => {
            const el = overlay.querySelector(`#xzg-batch-seg-s-${i}`);
            if (el) { el.textContent = text; el.style.color = color || "#888"; }
        },
        segFrames: (i, frames) => {
            const el = overlay.querySelector(`#xzg-batch-seg-f-${i}`);
            if (el) el.textContent = frames ? `${frames} 帧` : "";
        },
        abortBtn: $("xzg-batch-abort"),
    };

    const requestAbort = () => {
        abortFlag.v = true;
        try { api.interrupt(); } catch (e) { /* ignore */ }
        ui.status("已请求中断，等待当前段结束…", true);
    };
    $("xzg-batch-abort").onclick = requestAbort;

    $("xzg-batch-detect").onclick = async () => {
        if (running) return;
        const dNode = session.node; // 切回后 syncSession 已重绑为实时实例
        const filename = findWidget(dNode, "视频")?.value;
        if (!filename) { ui.status("加载器未选择视频", true); return; }
        const threshold = 0.35; // 与快剪默认阈值一致
        ui.status("正在探测切点（大视频可能需要数十秒）…");
        try {
            const cuts = await detectScenes(filename, threshold);
            // 用户预设的裁剪窗口（跳过帧数/帧数上限）：探测结果与分段都限制在该范围内——
            // 相当于先按红蓝杠裁剪，再在裁剪后的视频上自动探测切点并分段
            const srcFps = Number(dNode._xzgSourceFps) || Number(dNode._xzgVideoPlayer?.getFrameRate?.()) || 0;
            const wSkipD = findWidget(dNode, "跳过帧数");
            const wLimitD = findWidget(dNode, "帧数上限");
            const skipF = Number(wSkipD?.value) || 0;
            const limitF = Number(wLimitD?.value) || 0;
            let winStart = 0, winEnd = 0;
            if (srcFps > 0 && (skipF > 0 || limitF > 0)) {
                winStart = skipF / srcFps;
                winEnd = limitF > 0 ? (skipF + limitF) / srcFps : 0;
            }
            segments = cutsToSegments(cuts, winStart, winEnd);
            $("xzg-batch-segments").innerHTML = segments
                .map((s, i) => `<div>#${i + 1} &nbsp;${fmtTime(s.start)} → ${s.end > 0 ? fmtTime(s.end) : "片尾"}` +
                    ` &nbsp;<span id="xzg-batch-seg-f-${i}" style="color:#7a9;"></span>` +
                    ` <span id="xzg-batch-seg-s-${i}" style="color:#888;">待执行</span></div>`)
                .join("");
            const rangeNote = (winStart > 0 || winEnd > 0)
                ? `（裁剪范围 ${fmtTime(winStart)} → ${winEnd > 0 ? fmtTime(winEnd) : "片尾"}）`
                : "";
            ui.status(`检测到 ${cuts.length} 个切点，共 ${segments.length} 段${rangeNote}`);
        } catch (e) {
            ui.status(String(e.message || e), true);
        }
    };

    $("xzg-batch-run").onclick = async () => {
        if (running) return;
        if (!segments) { ui.status("请先自动探测视频切点", true); return; }
        running = true;
        abortFlag.v = false;
        $("xzg-batch-run").disabled = true;
        // 运行期间关闭按钮置灰（仍可点击，点击会提示"请先中断任务"）
        $("xzg-batch-close").style.cssText = "margin-right:auto;background:#333;color:#666;border:1px solid #444;" +
            "border-radius:5px;padding:6px 14px;cursor:not-allowed;";
        try {
            const result = await runBatch(session.node, segments, ui, abortFlag, session);
            if (result.aborted) {
                ui.status("已中断任务", true);
            } else {
                const msg = result.merged
                    ? `全部完成！已合并为：output/${result.merged.subfolder ? result.merged.subfolder + "/" : ""}${result.merged.filename}` +
                      (result.usedMergeNode ? "" : "（提示：工作流中添加「小珠光视频批处理合并」节点，可只输出最终视频且更省内存）")
                    : `全部完成！共 ${result.outputs.length} 个片段产物（未合并）`;
                ui.status(msg);
                ui.log(msg);
                // 所有分镜完成、合并成功：日志区绿色大字提示
                ui.logDone();
                // 全部完成：不自动关闭，由用户手工点 ✕ 关闭（出错/中断同样保持打开）
            }
        } catch (e) {
            console.error("[小珠光逐段批处理]", e);
            ui.status(String(e.message || e), true);
            // 运行完毕（出错）：立即清理缓冲，不留缓存（按 id 定位，避免误清别的工作流）
            const _merge = session.mergeId != null
                ? findLiveNode(session.mergeId, MERGE_NODE_TYPE)
                : null;
            if (_merge) {
                try { await fetch(BUFFER_RESET_API, { method: "POST" }); } catch (_) { /* ignore */ }
            }
        } finally {
            running = false;
            $("xzg-batch-run").disabled = false;
            $("xzg-batch-close").style.cssText = "margin-right:auto;background:#5a2a2a;color:#faa;border:1px solid #744;" +
                "border-radius:5px;padding:6px 14px;cursor:pointer;";
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════
// 注入按钮
// ═══════════════════════════════════════════════════════════════════════

app.registerExtension({
    name: "XZG.VideoBatchRunner",
    beforeRegisterNodeDef(nodeType, nodeData) {
        // 「小珠光视频批处理合并」：隐藏「执行合并」开关（内部信号，编排器自动控制；
        // 保留控件对象以维持序列化，仅不在画布上显示/占位）
        if (nodeData?.name === MERGE_NODE_TYPE) {
            const origCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = origCreated?.apply(this, arguments);
                try {
                    const w = (this.widgets || []).find((x) => x.name === "执行合并");
                    if (w) {
                        w.computeSize = () => [0, -1]; // 高度折叠，不占节点空间
                        w.draw = () => {};             // 不绘制
                    }
                } catch (e) { /* ignore */ }
                return r;
            };
            // 载入工作流时强制复位为关，避免遗留勾选导致"每次队列都试图合并"
            const origConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                const r = origConfigure?.apply(this, arguments);
                try {
                    const w = (this.widgets || []).find((x) => x.name === "执行合并");
                    if (w) w.value = false;
                } catch (e) { /* ignore */ }
                return r;
            };
            return;
        }
        if (nodeData?.name !== BATCH_NODE_TYPE) return;
        // 载入工作流时片段窗口归零（恢复完整视频状态），
        // 避免上次批处理中途保存的片段窗口残留在工作流里
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure?.apply(this, arguments);
            try {
                for (const name of ["片段起点", "片段终点"]) {
                    const w = (this.widgets || []).find((x) => x.name === name);
                    if (w) w.value = 0;
                }
            } catch (e) { /* ignore */ }
            return r;
        };
        // 绑定节点被删除：仅「同工作流内手动删除」才中止会话。
        // 切换工作流标签页时新图载入会先 graph.clear()，同样触发 onRemoved，
        // 但那是暂停场景（graphLoading=true），绝不能中止正在跑的任务；
        // 菜单「清空工作流」先把图 id 置 nil 再删节点（graphMatchesSession 为 false），
        // 由 graphCleared 事件负责中止。
        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            const r = origOnRemoved?.apply(this, arguments);
            try {
                const s = activeSession;
                if (s && !graphLoading
                    && String(s.nodeId) === String(this.id)
                    && graphMatchesSession(s)) {
                    abortSession(s);
                }
            } catch (e) { /* ignore */ }
            return r;
        };
        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            const node = this;
            // 延迟到所有扩展的控件都创建完成后再注入：
            // ① 位置固定在「上传视频」按钮之后（预览区之前），不因扩展注册时序漂移
            // ② 按加载器自定义控件的圆角风格绘制，与其他控件统一
            setTimeout(() => {
                try {
                    const NAME = "🎬 视频切点探测及批处理";
                    const ws = node.widgets || [];
                    if (ws.some((w) => w.name === NAME)) return; // 防重复注入
                    const w = node.addWidget("button", NAME, null, () => {
                        try {
                            openBatchDialog(node);
                        } catch (e) {
                            console.error("[小珠光逐段批处理] 打开对话框失败:", e);
                            alert(`打开批处理对话框失败: ${e?.message || e}`);
                        }
                    });
                    w.options = w.options || {};
                    w.options.serialize = false; // 按钮回调不可序列化，与「上传视频」按钮一致
                    w.computeSize = (width) => [width, 24];
                    w.draw = function (ctx, node, widget_width, y, H) {
                        const pad = 16, r = 6;
                        ctx.fillStyle = "#2a2a2a";
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(pad, y + 1, widget_width - pad * 2, H - 2, r);
                        else ctx.rect(pad, y + 1, widget_width - pad * 2, H - 2);
                        ctx.fill();
                        ctx.strokeStyle = "#555";
                        ctx.stroke();
                        ctx.fillStyle = "#dcc85b";
                        ctx.textAlign = "center";
                        ctx.textBaseline = "middle";
                        ctx.font = "600 12px sans-serif";
                        ctx.fillText(NAME, widget_width / 2, y + H / 2);
                    };
                    // 把按钮移到「上传视频」按钮之后（预览区之前），而非控件列表最末尾
                    const uploadIdx = (node.widgets || []).findIndex((x) => x.name === "上传视频");
                    if (uploadIdx >= 0) {
                        const curIdx = node.widgets.indexOf(w);
                        if (curIdx >= 0) node.widgets.splice(curIdx, 1);
                        node.widgets.splice(uploadIdx + 1, 0, w);
                    }
                    // 隐藏「片段起点/片段终点」：它们由编排器自动驱动，用户无需看到/手填。
                    // 仅折叠显示（computeSize 高度 -1 + 不绘制），值仍在并参与序列化/缓存键
                    for (const nm of ["片段起点", "片段终点"]) {
                        const hw = (node.widgets || []).find((x) => x.name === nm);
                        if (hw) {
                            hw.computeSize = () => [0, -1]; // 高度折叠，不占节点空间
                            hw.draw = () => {};             // 不绘制
                        }
                    }
                    // 节点高度随新增控件增长，避免被裁切
                    node.setSize(node.computeSize());
                    node.setDirtyCanvas?.(true, true);
                } catch (e) {
                    console.warn("[小珠光逐段批处理] 注入按钮失败:", e);
                }
            }, 0);
            return r;
        };
    },
});
