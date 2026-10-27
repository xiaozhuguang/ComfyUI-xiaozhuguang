import { app } from "../../scripts/app.js";

import { api } from "../../scripts/api.js";


import { cloudLoad, cloudSave } from "./xzg_cloud_store.js";





/**
 * 小珠光 · 场景逐段批处理
 *
 * 入口：图里存在「小珠光场景切点分段」（XiaozhuguangVideoScheduler）时，点「运行工作流」
 * 自动触发（见文件末尾 setup 里的 queuePrompt hook）；加载器上不再注入任何批处理/探测按钮。
 *
 * 流程：
 *   1. 调用快剪后端场景探测接口获取切点（不打开快剪编辑器，快剪无需加载任何视频）；
 *   2. 相邻切点构成片段列表，逐段改写加载器的「跳过帧数/帧数上限」（执行期窗口）；
 *   3. 每段只执行加载器及其下游分支（hook queuePrompt 过滤 output），等待执行完成；
 *   4. 若工作流中有「小珠光视频分段合并」节点（内存式硬切拼接）：
 *      逐段阶段把每段结果保存在进程内存并直通下游（下游保存节点被排除）；
 *      最后置位「执行合并」单独跑一次，合并节点输出完整视频给保存节点；
 *      若没有合并节点：保存节点逐段产出 → 后端 /xzg_video_batch_concat 拼接（回退路径）。
 */





const CONCAT_API = "/xzg_video_batch_concat";


const BUFFER_RESET_API = "/xzg_video_batch_buffer_reset";


const BUFFER_LIST_API = "/xzg_video_batch_buffer_list";


// 后端视频探测：给「小珠光场景切点分段」自己解码的视频量真实帧数/帧率
// （分段只按本节点视频算，不用加载器播放器 duration×fps 的估算值）
const VIDEO_PROBE_API = "/xzg_video_editor_probe";


const BATCH_NODE_TYPE = "XiaozhuguangVideoLoaderDaVinci"; // 小珠光视频加载-化神级


const MERGE_NODE_TYPE = "XiaozhuguangVideoBatchMerge";  // 小珠光视频分段合并（内存式硬切拼接节点）

const SCHEDULER_NODE_TYPE = "XiaozhuguangVideoScheduler"; // 小珠光场景切点分段（分段配置中心，存在即自动跑批）

const BATCH_CHECKPOINT_KEY = "xzg_video_batch_checkpoint_v1";
let batchRestoring = false;
const BATCH_RUN_LOCK = "xzg-video-batch-run-v1";
function saveBatchCheckpoint(session, patch = {}) {
    if (!session?.checkpoint) return;
    Object.assign(session.checkpoint, patch);
    localStorage.setItem(BATCH_CHECKPOINT_KEY, JSON.stringify(session.checkpoint));
}

async function restoreBatchAfterRefresh() {
    if (globalThis.navigator?.locks?.request) {
        return navigator.locks.request(BATCH_RUN_LOCK, {ifAvailable: true}, lock =>
            lock ? restoreBatchAfterRefreshLocked(true) : undefined);
    }
    return restoreBatchAfterRefreshLocked(false);
}

async function restoreBatchAfterRefreshLocked(lockHeld) {
    if (batchRestoring || activeSession?.isRunning) return;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(BATCH_CHECKPOINT_KEY) || "null"); } catch (_) { return; }
    if (saved?.state !== "running" || saved.signature !== graphSignature()) return;
    const loader = findLiveNode(saved.nodeId, BATCH_NODE_TYPE);
    const sched = findLiveNode(saved.schedulerId, SCHEDULER_NODE_TYPE);
    if (!loader || !sched || String(findWidget(loader, "视频")?.value || "") !== saved.video) return;
    batchRestoring = true;
    const status = text => { sched._xzgBatchStatus = {text, warn: true}; xzgRenderSegRows(sched); };
    try {
        status("刷新恢复：正在确认后台当前段状态，请勿重复提交…");
        // 提交响应尚未返回就刷新：从服务端按节点、片源、段号及提交时间找回任务。
        if (saved.submitting && !saved.promptId) {
            for (let attempt = 0; attempt < 20 && !saved.promptId; attempt++) {
                const [queue, history] = await Promise.all([
                    fetch("/queue", {cache: "no-store"}).then(r => r.json()),
                    fetch("/history?max_items=100", {cache: "no-store"}).then(r => r.json()),
                ]);
                const matches = new Set();
                const matchesInput = output => output?.[saved.schedulerId]?.inputs?.["当前段"] === saved.segmentIndex
                    && output?.[saved.nodeId]?.inputs?.["视频"] === saved.video;
                for (const item of [...(queue.queue_running || []), ...(queue.queue_pending || [])]) {
                    if (matchesInput(item[2])) matches.add(String(item[1]));
                }
                for (const [id, entry] of Object.entries(history)) {
                    const started = entry.status?.messages?.find(m => m[0] === "execution_start")?.[1]?.timestamp || 0;
                    if (started >= saved.queuedAt - 1000 && matchesInput(entry.prompt?.[2])) matches.add(id);
                }
                if (matches.size > 1) throw new Error("发现多个相同分段任务，无法安全自动续跑，请检查任务历史");
                saved.promptId = [...matches][0] || null;
                if (!saved.promptId) await new Promise(resolve => setTimeout(resolve, 500));
            }
            if (!saved.promptId) throw new Error("无法确认刷新前的任务是否入队，已保留缓冲，停止自动重提以避免重复分段");
        }
        if (saved.promptId) {
            await waitForPromptDone(saved.promptId);
            const response = await fetch(`/history/${saved.promptId}`, {cache: "no-store"});
            if (!response.ok) throw new Error("无法读取刷新前任务的完成记录");
            const entry = (await response.json())[saved.promptId];
            if (entry?.status?.status_str !== "success") throw new Error("刷新前的任务未成功完成，请检查执行历史");
            if (saved.phase === "merging") {
                // 最终合并可能已清理缓冲，不能再次生成或盲目重复合并。
                if (saved.mergeIds.length !== 1) throw new Error("最终合并期间刷新，请先核对各输出节点的完成记录；已停止自动重提");
                saved.state = "completed";
                localStorage.setItem(BATCH_CHECKPOINT_KEY, JSON.stringify(saved));
                status("刷新前的最终合并已执行成功，请查看视频保存节点或执行历史。");
                return;
            }
            const buffers = await fetchBufferList();
            if (saved.mergeIds.length && !buffers) throw new Error("无法核对已完成分段的缓冲，已暂停恢复");
            for (const id of saved.mergeIds) {
                const produced = entry.outputs?.[id]?.buffered || [];
                const files = new Set(bufNodeFiles(buffers, id));
                if (!produced.length || produced.some(item => !files.has(item.filename))) {
                    throw new Error(`合并节点 ${id} 的分段缓冲缺失，已停止恢复以避免重复或缺段`);
                }
            }
            if (!saved.mergeIds.length) saved.outputs.push(...Object.values(entry.outputs || {}).flatMap(extractVideoOutputs));
            saved.nextIndex = saved.segmentIndex + 1;
            saved.promptId = null;
            saved.submitting = false;
        }
        if (saved.mergeIds.length && saved.bufferFiles) {
            const buffers = await fetchBufferList();
            for (const [id, expected] of Object.entries(saved.bufferFiles)) {
                const files = new Set(bufNodeFiles(buffers, id));
                if (expected.some(file => !files.has(file))) throw new Error("已完成分段缓冲被清理，无法安全续跑");
            }
        }
        localStorage.setItem(BATCH_CHECKPOINT_KEY, JSON.stringify(saved));
        if (saved.signature !== graphSignature()) return;
        const liveLoader = findLiveNode(saved.nodeId, BATCH_NODE_TYPE);
        if (!liveLoader || String(findWidget(liveLoader, "视频")?.value || "") !== saved.video) return;
        await openBatchDialog(liveLoader, true, saved, lockHeld);
    } catch (error) {
        saved.state = "error";
        localStorage.setItem(BATCH_CHECKPOINT_KEY, JSON.stringify(saved));
        status(`刷新恢复停止：${error.message || error}。已保留现有缓冲。`);
        console.error("[小珠光批处理] 刷新恢复失败:", error);
    } finally { batchRestoring = false; }
}


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





/** 节点 id → 磁盘/byNode 用的安全名：节点 id 形如 "1120:1116"，


    其中 : \ / * ? " < > | 在 Windows 文件名非法，统一替换为 _（与后端内存缓存查询使用同一规则）。 */


function safeBufId(nid) {


    return String(nid).replace(/[\\/:*?"<>|]/g, "_");


}


/** 取缓冲列表中某合并节点专属子目录的分段文件（后端 byNode 分组；取不到视为空） */


function bufNodeFiles(bl, nid) {


    const info = bl?.byNode?.[safeBufId(nid)];


    return Array.isArray(info?.files) ? info.files : [];


}





/** 轮询 /history/{prompt_id}，等待 prompt 真正执行完成（可选的精确等待路径）。


 * /history 只在 prompt 结束（成功或出错）后才有记录，绝对可靠。


 * 仅当 api.queuePrompt 能返回 prompt_id（新版 ComfyUI）时使用；


 * 老版本不返回 prompt_id，回退到 waitExecutionDone 事件等待 + waitQueueIdle 兜底。 */


async function waitForPromptDone(promptId, timeoutMs = 3600000) {


    const t0 = Date.now();


    while (Date.now() - t0 < timeoutMs) {


        let entry = null;
        try {


            const r = await fetch(`/history/${promptId}`, {cache: "no-store"});


            if (r.ok) {


                const j = await r.json();


                entry = j ? j[String(promptId)] : null;


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


            // 已取得历史记录后抛出的错误是执行错误，不是网络抖动。
            if (entry) throw e;


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


async function runOnce(downIds, idBox, collected, promptPatch = null, session = null) {
    if (session) session.currentPrompt = idBox;
    saveBatchCheckpoint(session, {submitting: true, promptId: null, queuedAt: Date.now()});


    const done = waitExecutionDone(idBox);
    // 有 prompt_id 时走 history 等待，仍需消费事件分支的拒绝，避免未处理异常。
    done.catch(() => {});
    let submitted = false;


    const orig = api.queuePrompt;


    try {


        api.queuePrompt = async function (index, prompt, ...rest) {


            filterPromptOutput(prompt, downIds);

            // 本轮提交的就地改写（如最终合并时摘掉合并节点的上游依赖），失败不影响排队
            if (promptPatch) {
                try { promptPatch(prompt); } catch (e) { console.error("[小珠光批处理] prompt 改写失败:", e); }
            }


            const r = await orig.call(api, index, prompt, ...rest);
            submitted = true;


            if (r?.prompt_id) idBox.id = r.prompt_id;
            saveBatchCheckpoint(session, {promptId: idBox.id, submitting: !idBox.id});
            // 用户可能在提交请求返回前点击中断，拿到任务 id 后补发定向中断。
            if (session?.abortFlag.v) interruptSessionPrompt(session, "提交期间已请求停止");


            return r;


        };


        await app.queuePrompt(0);
        // app.queuePrompt 会自行处理部分校验/提交错误，可能正常返回但并未入队。
        // 此时不能等待一个永远不会产生的 execution_success 事件。
        if (!submitted) throw new Error("本段未成功提交到执行队列，请检查节点校验错误或其他插件的排队拦截");


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
    if (session?.currentPrompt === idBox) session.currentPrompt = null;
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

// ═══════════════════════════════════════════════════════════════════════
// 面板参数跟随工作流：写入节点 properties，随工作流 JSON 保存/加载，
// 不同节点、不同工作流互不影响（此前是复用同一个对话框 DOM，等同全局）
// ═══════════════════════════════════════════════════════════════════════
const BATCH_SETTINGS_KEY = "xzg_batch_settings";
const BATCH_SETTINGS_DEFAULTS = Object.freeze({
    targetFrames: 120,
});

// 「小珠光场景切点分段」节点：存在时作为分段的唯一配置源（对话框只做展示/编辑）
function findSchedulerNode() {
    const nodes = (typeof app !== "undefined" && app.graph?._nodes) || [];
    return nodes.find((n) => n?.type === SCHEDULER_NODE_TYPE) || null;
}

// 探测视频的真实帧数与帧率（后端 ffprobe / ffmpeg 计数）：
// 调度节点自己整片解码，分段必须以它自己那份视频的实测帧数为准，
// 不能用加载器播放器的 duration×fps 估算值（VFR/音轨更长时会明显虚高）
async function probeVideoMeta(filename) {
    const name = String(filename || "").trim();
    if (!name) return null;
    try {
        const resp = await fetch(VIDEO_PROBE_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: name, type: "input" }),
        });
        if (!resp.ok) return null;
        const info = await resp.json();
        const frames = Math.floor(Number(info?.frame_count) || 0);
        const fps = Number(info?.fps) || 0;
        if (frames <= 0 || fps <= 0) return null;
        return { frames, fps };
    } catch (_) {
        return null;
    }
}

// ── 分段信息镜像到调度节点：直接显示在节点上，免开批处理弹窗 ─────────────────
// rows: [{time, frames, status, color}]，由探测/批处理流程在更新弹窗的同时镜像。
// 用 DOM 控件承载（而不是 canvas 自绘）：新旧内核下都由节点自身布局，高度自动跟随内容，
// 不会出现「画到节点顶部盖住控件」「节点留一大片空白」这类坐标错位。
const SEG_ROWS_WIDGET_NAME = "xzg_seg_rows";
const SEG_ROW_PX = 16;

function xzgBindSegRowsWheel(node, element) {
    // 内层 pointer-events:none 不能穿透内核创建的 DOM widget 包装层。
    // 在捕获阶段按列表实际位置识别事件，再交给画布自身的滚轮处理。
    const onWheel = event => {
        const canvas = app.canvas?.canvas;
        if (!element.isConnected || !canvas || event.target === canvas) return;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX > rect.right
            || event.clientY < rect.top || event.clientY > rect.bottom) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        canvas.dispatchEvent(new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaZ: event.deltaZ,
            deltaMode: event.deltaMode,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
        }));
    };
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    const onRemoved = node.onRemoved;
    node.onRemoved = function () {
        document.removeEventListener("wheel", onWheel, true);
        return onRemoved?.apply(this, arguments);
    };
}

function xzgBindSegRowsDrag(node, element) {
    // 分段列表是纯展示区（pointer-events:none），按下事件的落点两种渲染模式不同：
    // 旧画布落到 canvas、Vue 节点落到内核包装层，都不会启动「按住列表拖动节点」。
    // 与滚轮转发同一套「文档捕获 + 坐标命中」方案：捕获阶段识别按下列表区域，
    // 吃掉原始事件后自行驱动节点位移（不依赖 LiteGraph/内核各自的拖动实现，模式间行为一致）。
    let drag = null;
    const onPointerDown = (event) => {
        if (event.button !== 0 || !element.isConnected) return;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX > rect.right
            || event.clientY < rect.top || event.clientY > rect.bottom) return;
        // 等价于点在节点本体上：顺手选中节点，保住「点一下再按 Delete 删除」的习惯
        try {
            const canvas = app.canvas;
            if (canvas?.selectedNodes && !canvas.selectedNodes[node.id]) canvas.selectNode?.(node);
        } catch (_) { /* ignore */ }
        drag = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            posX: node.pos?.[0] ?? 0,
            posY: node.pos?.[1] ?? 0,
            scale: app.canvas?.ds?.scale || 1,
        };
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    const onPointerMove = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (node.pos) {
            node.pos[0] = drag.posX + (event.clientX - drag.clientX) / drag.scale;
            node.pos[1] = drag.posY + (event.clientY - drag.clientY) / drag.scale;
            node.setDirtyCanvas?.(true, true);
        }
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    const onPointerUp = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag = null;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    document.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
    document.addEventListener("pointerup", onPointerUp, { capture: true });
    document.addEventListener("pointercancel", onPointerUp, { capture: true });
    const onRemoved = node.onRemoved;
    node.onRemoved = function () {
        drag = null;
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("pointermove", onPointerMove, true);
        document.removeEventListener("pointerup", onPointerUp, true);
        document.removeEventListener("pointercancel", onPointerUp, true);
        return onRemoved?.apply(this, arguments);
    };
}

function xzgMirrorSegRows(schedNode, rows) {
    if (!schedNode) return;
    schedNode._xzgSegRows = Array.isArray(rows) ? rows : [];
    xzgRenderSegRows(schedNode);
}

function xzgSegRowPatch(i, patch) {
    const sched = findSchedulerNode();
    if (!sched || !Array.isArray(sched._xzgSegRows) || !sched._xzgSegRows[i]) return;
    Object.assign(sched._xzgSegRows[i], patch);
    xzgRenderSegRows(sched);
}

function xzgSegRowsHeight(node) {
    const n = Array.isArray(node?._xzgSegRows) ? node._xzgSegRows.length : 0;
    // 布局阶段内核常会重设 DOM 控件样式，这里顺手再压一次指针穿透，
    // 保证滚轮停在分段列表上时仍然缩放画布。
    try {
        node?._xzgSegRowsEl?.style.setProperty("pointer-events", "none", "important");
    } catch (_) { /* ignore */ }
    return (n ? n * SEG_ROW_PX + 6 : 0) + (node?._xzgBatchStatus?.text ? 38 : 0);
}

function xzgEscapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

function xzgRenderSegRows(node) {
    const el = node?._xzgSegRowsEl;
    if (!el) return;
    // 纯展示容器必须穿透指针事件：某些内核会在挂载/重排时把 pointer-events 改回 auto，
    // 那样滚轮停在分段列表上只会滚 DOM，画布缩放就失效了。这里每次渲染都压回 none。
    try { el.style.setProperty("pointer-events", "none", "important"); } catch (_) { /* ignore */ }
    const rows = Array.isArray(node._xzgSegRows) ? node._xzgSegRows : [];
    const message = node._xzgBatchStatus;
    if (!rows.length && !message?.text) {
        el.innerHTML = "";
        el.style.display = "none";
        return;
    }
    el.style.display = "block";
    el.innerHTML = rows.map((row, i) => {
        const time = xzgEscapeHtml(row.time || `#${i + 1}`);
        const frames = xzgEscapeHtml(row.frames || "");
        const status = xzgEscapeHtml(row.status || "");
        const color = /^#[0-9a-fA-F]{3,8}$/.test(String(row.color || "")) ? row.color : "#888";
        return `<div style="display:flex;gap:6px;height:${SEG_ROW_PX}px;line-height:${SEG_ROW_PX}px;">`
            + `<span style="flex:1 1 0;color:#93a1b3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${time}</span>`
            + `<span style="flex:0 0 auto;color:#7a9c8f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%;">${frames}</span>`
            + `<span style="flex:0 0 auto;color:${color};">${status}</span>`
            + `</div>`;
    }).join("") + (message?.text
        ? `<div title="${xzgEscapeHtml(message.text)}" style="margin-top:4px;line-height:16px;max-height:32px;overflow:hidden;overflow-wrap:anywhere;color:${message.warn ? '#f90' : '#9ab'};">${xzgEscapeHtml(message.text)}</div>`
        : "");
    // 旧画布：内容放不下时才增高，保留用户拉大并保存的尺寸。
    // （绝不能传 node.size 进去，那会把尺寸写坏）
    try {
        if (typeof node.computeSize === "function") {
            const h = Number(node.computeSize()[1]);
            if (Number.isFinite(h) && node.size && h > node.size[1] + 0.5) {
                node.setSize?.([node.size[0], h]);
            }
        }
    } catch (_) { /* 忽略：Vue 模式由布局自动处理 */ }
}

function findNodeWidget(node, name) {
    return node ? (node.widgets || []).find((w) => w?.name === name) || null : null;
}

function setNodeWidgetValue(node, name, value) {
    const w = findNodeWidget(node, name);
    if (!w) return false;
    w.value = value;
    node.setDirtyCanvas?.(true, true);
    // 「当前段」是隐藏控件，部分前端要靠图变更通知才会把新值纳入下一次 graphToPrompt；
    // 漏掉这一步时第 2 段起提交的仍是上一段的值，表现为「只跑第一段」。
    try { (node.graph || (typeof app !== "undefined" ? app.graph : null))?.change?.(); } catch (_) { /* ignore */ }
    return true;
}

function readBatchSettings(node) {
    const raw = node?.properties?.[BATCH_SETTINGS_KEY];
    const src = (raw && typeof raw === "object") ? raw : {};
    const settings = { ...BATCH_SETTINGS_DEFAULTS, ...src };
    return settings;
}

function writeBatchSettings(node, patch) {
    if (!node) return;
    if (!node.properties || typeof node.properties !== "object") node.properties = {};
    const merged = { ...readBatchSettings(node), ...patch };
    delete merged.overlapFrames;
    node.properties[BATCH_SETTINGS_KEY] = merged;
    // 标记工作流已修改，触发星号提示与自动保存，参数随工作流一起存盘
    const graph = node.graph || (typeof app !== "undefined" ? app.graph : null);
    graph?.setDirtyCanvas?.(true, true);
    try { graph?.change?.(); } catch (_) { /* 旧版前端的 change 可能不存在 */ }
}

function applyBatchSettings(overlay) {
    if (!overlay) return null;
    return {};
}


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


            🎬 视频批处理<span style="font-size:11px;color:#999;font-weight:normal;">　（双击标题栏最小化为悬浮球）</span>
            <button id="xzg-batch-close" title="关闭（运行中=中断并关闭）" style="float:right;background:transparent;border:none;color:#999;font-size:16px;line-height:1;padding:0 4px;cursor:pointer;">✕</button>


          </div>


          <div style="padding:14px 18px;display:flex;flex-direction:column;gap:10px;flex:1;overflow:hidden;min-height:0;">




            <style>
              #xzg-batch-frame-options input[type="number"]::-webkit-inner-spin-button,
              #xzg-batch-frame-options input[type="number"]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
              #xzg-batch-frame-options input[type="number"] { -moz-appearance:textfield; appearance:textfield; }
              /* 输入框聚焦改用金色描边，避免宿主/浏览器默认的黑色焦点框 */
              #xzg-batch-frame-options input[type="number"]:focus,
              #xzg-batch-frame-options input[type="number"]:focus-visible {
                outline: none !important;
                border-color: #dcc85b !important;
                background-color: #171717 !important;
                color: #eee !important;
                box-shadow: 0 0 0 1px rgba(220, 200, 91, 0.35);
              }
            </style>
            <!-- 任务自动开始：按钮保留为隐藏元素供编排器触发，不显示 -->
            <button id="xzg-batch-run" style="display:none;">开始任务</button>
            <!-- 配置已收进「小珠光场景切点分段」节点：这里只保留隐藏控件供分段逻辑取值，不显示 -->
            <div style="display:none;align-items:flex-start;gap:8px;">
              <div id="xzg-batch-frame-options" style="display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:6px;color:#bbb;font-size:12px;">
              </div>
              <button id="xzg-batch-detect" style="flex:none;margin-left:auto;background:#333;color:${GOLD};border:1px solid #555;
                     border-radius:5px;padding:5px 12px;cursor:pointer;white-space:nowrap;">预览分段</button>
            </div>
            <div id="xzg-batch-segments" style="background:#262626;border:1px solid #3a3a3a;border-radius:6px;


                padding:8px 10px;min-height:60px;flex:1;overflow:auto;line-height:1.7;"></div>


            <div id="xzg-batch-status" style="color:#9ab;min-height:18px;"></div>


            <div id="xzg-batch-log" style="background:#191919;border:1px solid #333;border-radius:6px;


                padding:6px 10px;max-height:150px;overflow:auto;font-size:12px;color:#8a8;line-height:1.6;display:none;"></div>


          </div>


        </div>`;


    document.body.appendChild(overlay);


    // 标题栏拖动窗口


    const head = overlay.querySelector("#xzg-batch-head");


    head.addEventListener("mousedown", (e) => {


        const rect = overlay.getBoundingClientRect();


        const dx = e.clientX - rect.left, dy = e.clientY - rect.top;


        const move = (ev) => {


            // 拖动结束后保存位置（下次打开恢复）
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


    // 双击标题栏：最小化为一个圆形悬浮球（不占画布），再双击恢复。


    // 最小化时隐藏内容区与按钮栏，面板收成 48px 正圆居中显示 🎬；球可拖动、双击恢复。


    const bodyEl = head.nextElementSibling;


    const footEl = bodyEl ? bodyEl.nextElementSibling : null;


    let savedW = "", savedH = "", minimized = false;


    head.addEventListener("dblclick", () => {


        const panel = head.parentElement;


        if (!panel || !bodyEl || !footEl) return;


        minimized = !minimized;


        if (minimized) {


            savedW = panel.style.width;


            savedH = panel.style.height;


            bodyEl.style.display = "none";


            footEl.style.display = "none";


            panel.style.width = "48px";


            panel.style.height = "48px";


            panel.style.borderRadius = "50%";


            panel.style.resize = "none";


            head.style.padding = "0";


            head.style.borderBottom = "none";


            head.style.fontSize = "24px";


            head.style.lineHeight = "48px";


            head.style.textAlign = "center";


            batchBallState.minimized = true;
            batchBallState.head = head;
            updateBatchBall(batchBallState.cur, batchBallState.total);


            head.title = "双击恢复批处理窗口";


            // 呼吸 + 彩色渐变动画（keyframes 只注入一次）


            if (!document.getElementById("xzg-ball-anim")) {


                const st = document.createElement("style");


                st.id = "xzg-ball-anim";


                st.textContent = "@keyframes xzgBallBreathe {" +


                    "0%{box-shadow:0 0 10px 2px rgba(245,215,110,.45);background:radial-gradient(circle at 35% 30%,#3a2f1c,#161616);}" +


                    "50%{box-shadow:0 0 30px 11px rgba(200,120,255,.75);background:radial-gradient(circle at 65% 70%,#2d1a45,#161616);}" +


                    "100%{box-shadow:0 0 10px 2px rgba(90,190,255,.5);background:radial-gradient(circle at 35% 30%,#14283a,#161616);}" +


                "}";


                document.head.appendChild(st);


            }


            panel.style.animation = "xzgBallBreathe 2.6s ease-in-out infinite";


        } else {


            panel.style.width = savedW || "340px";


            panel.style.height = savedH || "600px";


            panel.style.borderRadius = "10px";


            panel.style.resize = "both";


            head.style.padding = "";


            head.style.borderBottom = "";


            head.style.fontSize = "";


            head.style.lineHeight = "";


            head.style.textAlign = "";


            bodyEl.style.display = "";


            footEl.style.display = "";


            panel.style.animation = "";
            batchBallState.minimized = false;


            head.innerHTML = '🎬 视频切点探测及批处理<span style="font-size:11px;color:#999;font-weight:normal;">　（双击标题栏最小化为悬浮球）</span>';


            head.title = "";


        }


    });


    return overlay;


}





function getDialog() {


    return document.querySelector(".xzg-batch-overlay") || buildDialog();


}





/** 插件自有的轻提示（深色金边框，与对话框同风格），替代浏览器原生 alert。


    固定于右下角，3.5 秒后自动淡出；重复调用会更新内容并重置计时。 */


function xzgBatchToast(msg) {


    let el = document.getElementById("xzg-batch-toast");


    if (!el) {


        el = document.createElement("div");


        el.id = "xzg-batch-toast";


        el.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:100000;max-width:380px;text-align:center;" +


            "background:#1e1e1e;border:1px solid #b8860b;border-radius:8px;color:#f5d76e;" +


            "padding:12px 16px;font-family:sans-serif;font-size:13px;line-height:1.6;" +


            "box-shadow:0 6px 24px rgba(0,0,0,.55);opacity:0;transition:opacity .2s;pointer-events:none;";


        document.body.appendChild(el);


    }


    el.textContent = msg;


    el.style.opacity = "1";


    clearTimeout(el._xzgT);


    el._xzgT = setTimeout(() => { el.style.opacity = "0"; }, 3500);


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

// 悬浮球（最小化）状态：跑批时球内显示「当前段/总段数」（如 3/11），不再显示 🎬。
let batchBallState = { minimized: false, head: null, cur: 0, total: 0 };
// runBatch 每段开始时调用：记录进度；若当前已最小化，立即把球内文字刷新成 cur/total。
function updateBatchBall(cur, total) {
    batchBallState.cur = cur;
    batchBallState.total = total;
    if (batchBallState.minimized && batchBallState.head) {
        const h = batchBallState.head;
        h.style.fontSize = "14px";
        h.style.lineHeight = "48px";
        h.textContent = (cur > 0 && total > 0) ? `${cur}/${total}` : "🎬";
    }
}


let graphLoading = false; // loadGraphData 执行中（切换标签页会触发 graph.clear → onRemoved）





function hideOverlay() {


    const overlay = document.querySelector(".xzg-batch-overlay");


    if (overlay) overlay.style.display = "none";


}


// ── 防抢焦点护栏 ──────────────────────────────────────────────────────────────
// 浏览器把最小化窗口拉回前台只有几个渠道：alert/confirm/prompt/window.focus/window.open。
// 批处理逐段执行期间，任何扩展在这些渠道上的弹窗/聚焦都会反复把最小化的浏览器
// 激活到最前端。运行期间静默拦截并记日志，结束后还原。
const _XZG_BATCH_FOCUS_HOOK = "_xzgBatchFocusHooks";

function installBatchFocusGuard() {
    if (window[_XZG_BATCH_FOCUS_HOOK]) return;
    const hook = {
        alert: window.alert,
        confirm: window.confirm,
        prompt: window.prompt,
        focus: window.focus,
        open: window.open,
        print: window.print,
        elementFocus: HTMLElement.prototype.focus,
        inputClick: HTMLInputElement.prototype.click,
        requestFullscreen: Element.prototype.requestFullscreen,
        notification: window.Notification,
        saveFilePicker: window.showSaveFilePicker,
        directoryPicker: window.showDirectoryPicker,
        openFilePicker: window.showOpenFilePicker,
    };
    window[_XZG_BATCH_FOCUS_HOOK] = hook;
    // 每次拦截都打调用栈：能直接指到是哪个模块在抢焦点，不用再猜。
    const stack = () => {
        try { return "\n" + (new Error().stack || ""); } catch (_) { return ""; }
    };
    const silent = (name) => (...args) => {
        console.warn(`[小珠光批处理] 运行期间已拦截 ${name}（防抢焦点）:`, ...args, stack());
        return undefined;
    };
    try {
        window.alert = silent("alert()");
        window.confirm = silent("confirm()");
        window.prompt = silent("prompt()");
        window.focus = (...args) => {
            console.warn("[小珠光批处理] 运行期间已拦截 window.focus()（防抢焦点）" + stack());
        };
        window.open = (...args) => {
            console.warn("[小珠光批处理] 运行期间已拦截 window.open()（防抢焦点）:", ...args, stack());
            return null;
        };
        window.print = silent("print()");
        // 系统文件对话框一定会把浏览器窗口带到前台；批处理期间没有用户手势，直接拦掉。
        if (typeof window.showSaveFilePicker === "function") window.showSaveFilePicker = silent("showSaveFilePicker()");
        if (typeof window.showDirectoryPicker === "function") window.showDirectoryPicker = silent("showDirectoryPicker()");
        if (typeof window.showOpenFilePicker === "function") window.showOpenFilePicker = silent("showOpenFilePicker()");
        if (typeof Element.prototype.requestFullscreen === "function") {
            Element.prototype.requestFullscreen = silent("requestFullscreen()");
        }
        // 文件选择框同理：后台状态下 input[type=file].click() 会直接弹系统对话框。
        if (typeof HTMLInputElement.prototype.click === "function") {
            HTMLInputElement.prototype.click = function (...args) {
                try {
                    if (String(this?.type || "").toLowerCase() === "file" && !document.hasFocus()) {
                        console.warn("[小珠光批处理] 运行期间已忽略后台 file input.click()（防抢焦点）" + stack());
                        return undefined;
                    }
                } catch (_) { /* ignore */ }
                return hook.inputClick.apply(this, args);
            };
        }
        // 元素 focus()：窗口已失焦时只忽略非画布元素（画布保留，避免快捷键失效）。
        if (typeof HTMLElement.prototype.focus === "function") {
            HTMLElement.prototype.focus = function (...args) {
                try {
                    if (this?.tagName !== "CANVAS" && !document.hasFocus()) {
                        console.warn("[小珠光批处理] 运行期间已忽略后台元素 focus():", this, stack());
                        return undefined;
                    }
                } catch (_) { /* ignore */ }
                return hook.elementFocus.apply(this, args);
            };
        }
        // 桌面通知在部分系统上会把窗口拉回前台。
        if (typeof window.Notification === "function") {
            const Original = window.Notification;
            const Blocked = function (...args) {
                console.warn("[小珠光批处理] 运行期间已拦截 new Notification()（防抢焦点）:", ...args, stack());
                return { close() {}, addEventListener() {}, removeEventListener() {} };
            };
            try {
                Blocked.permission = Original.permission;
                Blocked.maxActions = Original.maxActions;
            } catch (_) { /* ignore */ }
            Blocked.requestPermission = silent("Notification.requestPermission()");
            window.Notification = Blocked;
        }
    } catch (e) { /* ignore */ }
}

function removeBatchFocusGuard() {
    const hook = window[_XZG_BATCH_FOCUS_HOOK];
    if (!hook) return;
    try {
        window.alert = hook.alert;
        window.confirm = hook.confirm;
        window.prompt = hook.prompt;
        window.focus = hook.focus;
        window.open = hook.open;
        if (hook.print) window.print = hook.print;
        if (hook.elementFocus) HTMLElement.prototype.focus = hook.elementFocus;
        if (hook.inputClick) HTMLInputElement.prototype.click = hook.inputClick;
        if (hook.requestFullscreen) Element.prototype.requestFullscreen = hook.requestFullscreen;
        if (hook.notification) window.Notification = hook.notification;
        if (hook.saveFilePicker) window.showSaveFilePicker = hook.saveFilePicker;
        if (hook.directoryPicker) window.showDirectoryPicker = hook.directoryPicker;
        if (hook.openFilePicker) window.showOpenFilePicker = hook.openFilePicker;
    } catch (e) { /* ignore */ }
    delete window[_XZG_BATCH_FOCUS_HOOK];
}


function showOverlay() {
    // 已集成到分段节点的工作流不再显示旧浮窗（包括错误与切回工作流）。
    if (findSchedulerNode()) { hideOverlay(); return; }


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


/** 清理旧版本节点残留的输入接口：不在 keep 白名单里的输入一律移除（断开链接）。
 *  用于参数删除后，旧工作流里被"转为输入"的控件残留（如 重叠帧/重叠表/过渡方式）。 */
function pruneLegacyInputs(node, keep) {
    const inputs = node.inputs || [];
    for (let i = inputs.length - 1; i >= 0; i--) {
        const inp = inputs[i];
        if (inp && keep.has(inp.name)) continue;
        try {
            if (inp && inp.link != null) {
                const link = app.graph?.links?.[inp.link];
                if (link) app.graph.removeLink(link.id);
            }
        } catch (e) { /* ignore */ }
        try {
            node.removeInput(i);
        } catch (e) {
            inputs.splice(i, 1);
        }
    }
    node.setDirtyCanvas?.(true, true);
}


/** 清理旧版本节点残留的输出接口：不在 keep 白名单里的输出一律移除（断开链接）。 */
function pruneLegacyOutputs(node, keep) {
    const outputs = node.outputs || [];
    for (let i = outputs.length - 1; i >= 0; i--) {
        const out = outputs[i];
        if (out && keep.has(out.name)) continue;
        try {
            if (out && Array.isArray(out.links)) {
                for (const lid of out.links.slice()) {
                    if (lid != null) app.graph?.removeLink(lid);
                }
            }
        } catch (e) { /* ignore */ }
        try {
            node.removeOutput(i);
        } catch (e) {
            outputs.splice(i, 1);
        }
    }
    node.setDirtyCanvas?.(true, true);
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


            if (Array.isArray(s.mergeIds) && s.mergeIds.length) {


                s.mergeNodes = s.mergeIds.map((id) => findLiveNode(id, MERGE_NODE_TYPE)).filter(Boolean);


            }


            // 自动跑批的会话窗口默认隐藏（进度显示在分段节点上），切回工作流时也不要弹出来
            if (s.open && !s.hidden) showOverlay();


            return;


        }


    }


    s.active = false;


    hideOverlay();


}





/** 只中断本会话提交的任务；不使用会影响其他工作流的全局中断。 */
async function interruptSessionPrompt(s, reason) {
    const promptId = s?.currentPrompt?.id;
    console.info("[小珠光批处理] 请求停止:", { reason, promptId: promptId || null });
    if (!promptId) return;
    try {
        const response = await api.fetchApi("/interrupt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt_id: String(promptId) }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (e) {
        console.error("[小珠光批处理] 定向中断失败:", reason, e);
    }
}

/** 清理前端会话；只有明确要求时才中断该会话的后台任务。 */


function abortSession(s, reason = "清理旧会话", interrupt = false) {


    if (!s) return;
    saveBatchCheckpoint(s, {state: "stopped"});


    if (activeSession === s) activeSession = null;


    s.open = false;


    s.active = false;


    s.abortFlag.v = true;


    hideOverlay();


    console.info("[小珠光批处理] 清理会话:", { reason, interrupt });
    if (interrupt && s.isRunning) interruptSessionPrompt(s, reason);


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
    // 工作流载入也会清空画布，此时由 syncSession 处理暂停/续跑。
    if (graphLoading) return;
    if (activeSession?.active) abortSession(activeSession, "清空当前工作流", true);


});





// ═══════════════════════════════════════════════════════════════════════


// 主流程


// ═══════════════════════════════════════════════════════════════════════





// 编排模式提示去重：同一编排模式只提示一次，中断后再次开始不重复刷屏


let lastOrchHint = "";





async function runBatch(node, segments, ui, abortFlag, session = null, selected = null) {


    const nodeId = String(node.id);


    // 工作流标签页切换会重建节点实例：节点/控件一律按 id 实时解析，


    // 不长期持有打开对话框时的旧实例（旧实例在 graph.clear 后已脱离画布）。


    let liveNode = node;


    let wSkip, wLimit;


    const resolveLive = () => {


        liveNode = findLiveNode(nodeId, BATCH_NODE_TYPE) || node;


        wSkip = findWidget(liveNode, "跳过帧数");


        wLimit = findWidget(liveNode, "帧数上限");


        // 加载器已无 片段起点/片段终点/补帧到 控件：段窗口只由 跳过帧数/帧数上限 表达


        return liveNode;


    };


    resolveLive();

    // 合并节点末尾裁帧：切点修复补出来的重复末帧，在拼接成片前裁掉
    const setMergeTailTrim = (frames) => {
        const trim = Math.max(0, Math.floor(Number(frames) || 0));
        for (let mi = 0; mi < mergeIds.length; mi++) {
            const mn = findLiveNode(mergeIds[mi], MERGE_NODE_TYPE) || mergeNodes[mi];
            const w = mn && findWidget(mn, "末尾裁帧");
            if (w) w.value = trim;
            mn?.setDirtyCanvas?.(true, true);
        }
    };

    // 收尾清掉补帧参数，避免之后手动运行加载器时仍带着上一段的补帧值
    const resetPadWidget = () => {
        setMergeTailTrim(0);
    };


    // 段窗口用「跳过帧数/帧数上限」（帧）表达，与红杠/蓝杠/右下角帧号显示天然一致：


    // 红杠=跳过帧数（段起点帧），蓝杠=跳过帧数+帧数上限（段终点帧），控件值即执行参数。


    // 「片段起点/片段终点」（秒）置 0，避免两套窗口参数叠加造成双重偏移。


    if (!wSkip || !wLimit) {


        throw new Error("加载器缺少「跳过帧数/帧数上限」控件，请刷新页面后重试");


    }


    // 段边界秒→帧换算需要源帧率（视频加载后由解码探测，onSourceFpsDetected 写入）


    const srcFps = Number(session?.resume?.fps) || Number(node._xzgVideoPlayer?.getFrameRate?.()) || Number(node._xzgSourceFps) || 0;


    if (!srcFps || srcFps <= 0) {


        throw new Error("未探测到源视频帧率：请先在加载器里加载一次视频（或运行一次工作流）后再开始批处理");


    }


    // 批处理前的控件原值：结束后恢复，避免影响用户后续手动执行


    const origSkip = Number(wSkip.value) || 0;


    const origLimit = Number(wLimit.value) || 0;


    // 旧工作流没有基准属性时，用本次运行前的值补记一次（下次「预览分段」用它复位）
    try {
        const lv = liveNode || session.node;
        if (lv) {
            const p = (lv.properties = lv.properties || {});
            if (p.xzgBaseSkip == null) p.xzgBaseSkip = origSkip;
            if (p.xzgBaseLimit == null) p.xzgBaseLimit = origLimit;
        }
    } catch (e) { /* ignore */ }


    // 把「恢复红蓝杠/段窗口到批处理前位置」挂到会话上：点中断时立即调用，


    // 不必等 runBatch 走到 finally（卡死后 finally 可能迟迟不执行）


    if (session) {


        session.restoreWidgets = () => {


            try {


                resolveLive();


                if (wSkip) wSkip.value = origSkip;


                if (wLimit) wLimit.value = origLimit;


                liveNode.setDirtyCanvas?.(true, true);


            } catch (e) { /* ignore */ }


        };


    }


    // 内存合并节点（支持多个）：逐段各存入进程内存，最后逐个单独运行合并。


    // 一条加载器链上分叉出的每条处理链可各接一个合并节点；只驱动位于本加载器


    // 下游的合并节点，不属于本链的（其他加载器的）保持原样并在日志明确提示


    // 方案 B：存在分段处理节点时，执行分支从它开始（上游加载器不在执行图里）
    const rootNode = findSchedulerNode() || node;
    const loaderDownIds = collectDownstream(rootNode);


    const allMergeInGraph = (app.graph?._nodes || []).filter((n) => n.type === MERGE_NODE_TYPE);


    const mergeNodes = allMergeInGraph.filter((n) => loaderDownIds.has(String(n.id)));


    const foreignMerges = allMergeInGraph.filter((n) => !loaderDownIds.has(String(n.id)));


    if (foreignMerges.length) {


        const hint = `检测到 ${foreignMerges.length} 个「小珠光视频分段合并」节点不在当前加载器下游（属于其他加载器的链路），本次批处理不驱动它们；请用对应加载器上的批处理按钮单独编排`;


        if (hint !== lastOrchHint) { ui.log(hint, true); lastOrchHint = hint; }


    }


    const mergeIds = mergeNodes.map((n) => String(n.id));
    if (session && mergeIds.length) session.mergeIds = mergeIds;


    if (mergeNodes.length) {


        // 前置检查：每个合并节点必须接了「图像」输入（位于加载器下游已由过滤保证），


        // 且下游接有输出节点（如「小珠光视频保存」），否则最终合并的完整视频无处产出


        for (let mi = 0; mi < mergeNodes.length; mi++) {


            const mn = mergeNodes[mi];


            const label = mergeNodes.length > 1 ? `合并节点${mi + 1}（id ${mn.id}）` : "合并节点";


            const imgInput = (mn.inputs || []).find((inp) => inp.name === "图像");


            if (!imgInput || imgInput.link == null) {


                throw new Error(`${label}的「图像」输入未连接：请把处理链的图像输出接到合并节点（否则逐段阶段不会缓存，最终合并会报内存缓存为空）`);


            }


            const belowNodes = [...collectDownstream(mn)]


                .filter((id) => id !== String(mn.id))


                .map((id) => (app.graph?._nodes || []).find((n) => String(n.id) === id))


                .filter((n) => n && n.constructor?.nodeData?.output_node);


            if (!belowNodes.length) {


                throw new Error(`${label}的下游没有连接任何输出节点（如「小珠光视频保存」）：\n请把合并节点的「图像」「音频」输出接到保存视频节点，最终合并的完整视频才会被保存/预览`);


            }


        }


        try {


            if (!session?.resume) await fetch(BUFFER_RESET_API, { method: "POST" });


        } catch (e) { /* 重置失败不阻塞，finalize 会校验缓冲 */ }


    }








    // 逐段执行的输出节点集合（白名单式，绝对排除下游）：


    // 有合并节点 → 只保留合并节点为输出节点。其上游（加载器/处理链）作为依赖由后端


    // 连带执行；其下游（保存视频节点等）不在执行图里，逐段阶段不可能被触发输出；


    // 最终合并阶段单独用 collectDownstream(各合并节点) 恢复下游，产出完整视频。


    // 无合并节点（回退路径）→ 保留批处理节点下游全部输出节点（逐段直接产出，最后拼接）。


    let downIds;


    if (mergeNodes.length) {


        const allDown = collectDownstream(rootNode);
        const excludeFromSeg = new Set();
        for (const mn of mergeNodes) {
            for (const id of collectDownstream(mn)) {
                if (id !== String(mn.id)) excludeFromSeg.add(id);
            }
        }
        downIds = new Set([...allDown].filter((id) => !excludeFromSeg.has(id)));


    } else {


        downIds = collectDownstream(rootNode);


        const hint = "编排模式：回退拼接（未找到「小珠光视频分段合并」节点），逐段直接产出最后拼接";


        if (hint !== lastOrchHint) { ui.log(hint, true); lastOrchHint = hint; }


    }





    if (session) {
        session.checkpoint = session.resume || {
            state: "running", signature: graphSignature(), nodeId, schedulerId: String(rootNode.id),
            video: String(findWidget(liveNode, "视频")?.value || ""),
            segments: segments.map(segment => ({...segment})), lastPadFrames: segments.lastPadFrames || 0, fps: srcFps,
            table: String(findWidget(rootNode, "段表")?.value || ""), mergeIds,
            nextIndex: 0, promptId: null, outputs: [], skippedByNode: {},
        };
        saveBatchCheckpoint(session);
    }
    const allOutputs = (session?.resume?.outputs || []).slice();

    const skippedSegments = [];

    // 用户点选跳过的段（1-based）：只执行勾选片段，跳过段不计失败、同步减少最终合并预期

    const userSkipped = new Set();

    const totalSel = selected ? segments.filter((_, i) => selected[i]).length : segments.length;

    let execCount = 0;


    // 按合并节点记录缺段（多链时某链某段未缓冲，最终按各节点预期分别校验）


    const skippedByNode = new Map(mergeIds.map((id) => [id, new Set(session?.resume?.skippedByNode?.[id] || [])]));


    let aborted = false;


    ui.abortBtn && (ui.abortBtn.style.display = "");


    let detach = null;


    // 缓冲是否成功以服务端缓冲目录为准（避免 executed 事件竞态导致误判/漏判）


    let prevCount = 0;


    if (mergeNodes.length) {


        const bl = await fetchBufferList();


        prevCount = bl ? (bl.count || 0) : 0;


    }


    // 分段行内状态复位（刷新恢复时 nextIndex 之前的段已完成：标成「已完成」，
    // 不能一律重置成「待执行」盖掉恢复分支镜像好的状态）
    const resumeDone = session?.resume?.nextIndex || 0;
    segments.forEach((_, i) => {
        if (i < resumeDone) ui.segStatus?.(i, "已完成", "#8c8");
        else ui.segStatus?.(i, "待执行");
    }); // 不清空帧数：探测阶段已显示预计帧数，执行完再覆盖为实际帧数

    if (selected) {

        const nSkipped = segments.length - totalSel;

        if (nSkipped > 0) {

            ui.log(`已按选择跳过 ${nSkipped} 个片段，本次只执行 ${totalSel} 段`);

        }

    }





    try {


        for (let i = session?.resume?.nextIndex || 0; i < segments.length; i++) {
            saveBatchCheckpoint(session, {phase: "segments", segmentIndex: i, promptId: null, submitting: false});

            if (abortFlag.v) { aborted = true; ui.segStatus?.(i, "已中断", "#fa0"); break; }

            const seg = segments[i];

            // 用户点选跳过（只执行勾选的片段）：不执行、不缓冲，

            // 并入 skippedByNode 使最终合并预期段数同步减少，合并/拼接自动忽略该段

            if (selected && !selected[i]) {

                ui.segStatus?.(i, "已跳过", "#888");

                skippedSegments.push(i + 1);

                userSkipped.add(i + 1);

                for (const nid of mergeIds) skippedByNode.get(nid)?.add(i + 1);

                continue;

            }

            // 切到了其他工作流：在段边界暂停（不中断，已在跑的当前段继续跑完），

            // 切回本工作流后自动续跑

            if (session) {

                await session.waitActive(ui);

                resolveLive();

                if (abortFlag.v) { aborted = true; ui.segStatus?.(i, "已中断", "#fa0"); break; }

            }

            execCount++;

            ui.segStatus?.(i, "执行中", "#fa0");

            updateBatchBall(i + 1, segments.length); // 悬浮球显示全局进度 当前段/总段数（刷新恢复时含之前已完成的段）





            // 每段最多尝试 3 次：与之前运行参数完全相同时 ComfyUI 会缓存命中（整链跳过执行），


            // 导致合并节点不缓冲 → 重试时对片段窗口做 1ms 级微移绕过缓存（画面无感知）


            const MAX_ATTEMPTS = 3;


            const collected = [];


            const buffered = [];


            let newFiles = [];


            // 段级快照：本段开始前各合并节点缓冲子目录的段清单。成功判定用「按节点内存段 diff」


            // 而非计数对比——计数会受文件系统延迟/执行重叠影响而误判，diff 能精确识别本段新增


            const segSets = new Map();


            if (mergeNodes.length) {


                const segBl = await fetchBufferList();


                for (const nid of mergeIds) segSets.set(nid, new Set(bufNodeFiles(segBl, nid)));


            }


            // 本段仍需缓冲的合并节点（部分节点失败时收窄到只重试失败节点的链）


            let pendingIds = mergeIds.slice();


            // 方案 B：存在「小珠光场景切点分段」时，由它自己解码本段，加载器不再被逐段改写
            const schedNode = findSchedulerNode();


            // 末段补帧要读满片尾后复制末帧，只有分段处理节点能做到（加载器窗口读不满就只能少帧）
            if ((segments.lastPadFrames || 0) > 0 && !schedNode) {
                ui.log(`提示：末段需补 ${segments.lastPadFrames} 帧（复制末帧对齐切点规则），` +
                    "但工作流没有「小珠光场景切点分段」节点，加载器路径无法补帧：末段会短于规则长度", true);
            }


            for (let attempt = 1; attempt <= MAX_ATTEMPTS && !abortFlag.v && (mergeNodes.length === 0 || pendingIds.length > 0); attempt++) {


                // 段窗口 → 帧参数：红杠（跳过帧数）= 段起点帧，帧数上限 = 段长帧数（0=到片尾）；


                // 控件值即执行参数，也与红蓝杠/右下角帧号显示完全一致


                const segSkipFrames = Math.max(0, Math.round(seg.start * srcFps));


                const segLimitFrames = seg.end > 0


                    ? Math.max(0, Math.round(seg.end * srcFps) - segSkipFrames)


                    : 0;


                if (attempt === 1) {


                    // 方案 B：只写「当前段」，由分段处理节点自己解码本段（加载器不参与执行）
                    if (schedNode) {
                        setNodeWidgetValue(schedNode, "当前段", i);
                    } else {
                        wSkip.value = segSkipFrames;
                        wLimit.value = segLimitFrames;
                    }


                    setMergeTailTrim(0);


                } else if (!schedNode) {


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


                    // 首次执行传 downIds（合并节点缓冲 + 直连在链上的保存节点逐段输出）；
                    // 重试才收窄到失败合并节点的链（已成功节点不重复执行/重复保存）。
                    const segDownIds = mergeNodes.length
                        ? (attempt === 1 ? downIds : new Set(pendingIds))
                        : downIds;
                    await runOnce(segDownIds, idBox, collected, null, session);


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


                if (mergeNodes.length) {


                    // 关键：先等队列真正空闲，防止重试队列与当前执行重叠（同段被缓冲两次的根源）


                    await waitQueueIdle();


                    // 成功判定：以「各合并节点缓冲子目录的段 diff」为权威（相对本段开始前的快照）。


                    // 不能用 ui.buffered 事件判断：缓存命中时 ComfyUI 会原样重放上次的 ui，


                    // 事件有假阳性（表现为"已缓存"但服务端没有新增内存段）。


                    // 多合并节点：每个节点本段都有新增才算成功；部分失败时只重试失败节点的链


                    // （成功节点不在本轮执行图里，不会重复缓冲）


                    const addedMap = new Map();


                    for (let k = 0; k < 7 && !abortFlag.v; k++) {


                        const bl = await fetchBufferList();


                        if (bl === null) break; // 查询失败：无法判定，按未缓冲处理走重试


                        for (const nid of pendingIds) {


                            if (addedMap.has(nid)) continue;


                            const before = segSets.get(nid) || new Set();


                            const added = bufNodeFiles(bl, nid).filter((f) => !before.has(f));


                            if (added.length >= 1) addedMap.set(nid, added);


                        }


                        if (addedMap.size >= pendingIds.length) break;


                        await new Promise((r) => setTimeout(r, 300));


                    }


                    if (addedMap.size) {


                        for (const [nid, added] of addedMap) {


                            if (added.length > 1) {


                                ui.log(`警告：第 ${i + 1} 段合并节点 ${mergeIds.indexOf(nid) + 1} 检测到 ${added.length} 个缓冲文件（执行重叠所致），以最后缓冲的分段为准`, true);


                            }


                            segSets.set(nid, new Set([...(segSets.get(nid) || []), ...added]));


                            newFiles.push(...added.map((f) => ({ filename: f })));


                        }


                        const blNow = await fetchBufferList();


                        prevCount = blNow ? (blNow.count || 0) : 0;


                    }


                    // 本段仍有未成功的节点 → 收窄到只重试失败节点的链；全部成功/中断 → 结束重试


                    pendingIds = pendingIds.filter((nid) => !addedMap.has(nid));


                    if (!pendingIds.length || abortFlag.v) break;


                } else if (collected.length) {


                    break;


                }


            }


            allOutputs.push(...collected);





            if (mergeNodes.length) {


                if (!pendingIds.length) {


                    // 行内状态：该分镜已完成 + 帧数（成功那次执行的真实缓冲上报，最终合并成功后再标「已执行」）


                    ui.segStatus?.(i, "该分镜已完成", "#8c8");


                    const fr = buffered.length ? buffered[buffered.length - 1].frames : null;


                    if (fr) ui.segFrames?.(i, fr, Math.max(0, Math.round(seg.start * srcFps)));


                } else if (!abortFlag.v) {


                    // 仅在非中断时才判定"未缓冲"：中断属用户主动行为，不是执行失败。


                    // 多合并节点：部分节点失败 → 仅这些链缺本段；全部失败 → 整段未缓冲


                    const failedNos = pendingIds.map((nid) => mergeIds.indexOf(nid) + 1).join("、");


                    for (const nid of pendingIds) skippedByNode.get(nid)?.add(i + 1);


                    if (pendingIds.length < mergeIds.length) {


                        ui.segStatus?.(i, "部分链未缓冲", "#fc6");


                        ui.log(`第 ${i + 1} 段：合并节点 ${failedNos} 未缓冲成功（对应链的最终视频将缺少该段）`, true);


                    } else {


                        skippedSegments.push(i + 1);


                        ui.segStatus?.(i, "未完成", "#f66");


                        ui.status(`第 ${i + 1} 段未缓冲成功（该段不会进入最终合并）`, true);


                        ui.log(`第 ${i + 1} 段重试 ${MAX_ATTEMPTS} 次仍未缓冲。常见原因：合并节点「图像」输入未连接 / 「帧率」输入值 ≤ 0 / 上游节点执行失败`, true);


                    }


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
            const checkpointBuffers = mergeIds.length ? await fetchBufferList() : null;
            saveBatchCheckpoint(session, {
                nextIndex: i + 1, promptId: null, submitting: false, outputs: allOutputs,
                bufferFiles: Object.fromEntries(mergeIds.map(id => [id, bufNodeFiles(checkpointBuffers, id)])),
                skippedByNode: Object.fromEntries([...skippedByNode].map(([id, values]) => [id, [...values]])),
            });
        }


        // 一段都没继续跑时，这行能直接说明是「段数只有 1」「被勾选跳过」还是「被中断」。
        ui.log(
            `批处理主体结束：共 ${segments.length} 段，已执行 ${execCount} 段，`
            + `跳过 ${skippedSegments.length} 段${aborted ? "（已中断）" : ""}`,
            true,
        );


    } catch (e) {
        // 段级异常会被 throw 到这里。以前直接向上抛，面板上看不到任何提示，
        // 表现就是「跑完第一段就没了」，所以这里显式报出来。
        if (!aborted) {
            const msg = e && e.message ? e.message : String(e);
            ui.status(`批处理中止：${msg}`, true);
            ui.log(`批处理中止：${msg}`, true);
            console.error("[小珠光逐段批处理] 分段执行中止，保留已有缓冲:", e);
            throw e;
        }


    } finally {


        ui.abortBtn && (ui.abortBtn.style.display = "none");


        // 无论批次如何结束，恢复批处理前的控件原值（段窗口参数全部还原，不影响手动执行）


        resolveLive();


        if (wSkip) wSkip.value = origSkip;


        if (wLimit) wLimit.value = origLimit;


        liveNode.setDirtyCanvas?.(true, true);


    }





    // 结束时恢复加载器预览：批处理期间预览跟随每段输出，最后一次执行往往是


    // "合并空跑"的极小窗口（约 1 帧），需要重置回原始加载的视频


    resolveLive();


    liveNode._xzgResetLoaderPreview?.();


    if (aborted) {


        // 运行完毕（中断）：立即清理缓冲，不留缓存


        if (mergeNodes.length) {


            try { await fetch(BUFFER_RESET_API, { method: "POST" }); } catch (e) { /* ignore */ }


        }


        resetPadWidget();

        return { aborted: true, outputs: allOutputs, merged: [], usedMergeNode: mergeNodes.length > 0 };


    }





    // 最终合并阶段也要等回本工作流（合并节点控件只存在于挂载的图上）


    if (session) {


        await session.waitActive(ui);


        resolveLive();


        if (abortFlag.v) {


            resetPadWidget();

        return { aborted: true, outputs: allOutputs, merged: [], usedMergeNode: mergeNodes.length > 0 };


        }


    }





    saveBatchCheckpoint(session, {phase: "merging", promptId: null, submitting: false});
    const merged = [];


    if (mergeNodes.length) {


        // 各链缺段警告（多合并节点按各自缓冲独立校验）


        for (let mi = 0; mi < mergeIds.length; mi++) {


            const sk = skippedByNode.get(mergeIds[mi]);

            if (sk && sk.size) {

                // 用户点选跳过的段不算失败：只对真正未缓冲成功的段告警

                const missing = [...sk].filter((x) => !userSkipped.has(x)).sort((a, b) => a - b);

                if (missing.length) {

                    ui.log(`警告：合并节点 ${mi + 1} 缺少第 ${missing.join("、")} 段（未成功缓冲），其最终视频将缺少这些段落`, true);

                } else if (sk.size > 0) {

                    ui.log(`合并节点 ${mi + 1}：按选择跳过了第 ${[...sk].sort((a, b) => a - b).join("、")} 段，最终视频不包含这些段落`);

                }

            }


        }


        // 最终合并前校验：每个合并节点的缓冲数量必须与其预期段数严格一致


        // （少了=缺段，多了=重复缓冲，两种情况拼出来都是坏视频，直接拦下）


        const bl = await fetchBufferList();


        for (let mi = 0; mi < mergeIds.length; mi++) {


            const nid = mergeIds[mi];


            const expected = segments.length - (skippedByNode.get(nid)?.size || 0);


            const cnt = (bl?.byNode?.[safeBufId(nid)]?.count) || 0;


            if (cnt !== expected) {


                throw new Error(`合并节点 ${mi + 1}（id ${nid}）内存中有 ${cnt} 个分段，但预期是 ${expected} 个` +


                    (cnt > expected


                        ? "（存在重复缓存，可能因执行时序异常）。已取消合并，请点「开始」重新运行（开始时会自动清空缓冲）"


                        : "（部分段未缓存成功）。已取消合并，请重新运行批处理"));


            }


        }


        // 最终合并：逐个合并节点串行执行（置位「执行合并」→ 单独跑一次 → 恢复）。


        // 串行是刻意的：finalize 要把完整视频解码为帧张量（内存≈整支视频），并行会叠加峰值内存


        // 合并不再借用加载器：「图像/音频」已从本次提交里摘掉（见下方 stripUpstreamInputs），
        // 上游整条链完全不执行，因此这里不再临时改写加载器的「帧数上限」——
        // 以前那句「帧数上限=1」是为了让空跑少解码，恢复语句与活动节点重解析一旦错位，
        // 批处理结束后控件就会停留在 1。


        try {


            for (let mi = 0; mi < mergeIds.length; mi++) {


                const nid = mergeIds[mi];


                const liveMerge = findLiveNode(nid, MERGE_NODE_TYPE) || mergeNodes[mi];


                const wGo = findWidget(liveMerge, "执行合并");


                if (!wGo) throw new Error("「小珠光视频分段合并」节点缺少「执行合并」控件，请刷新页面后重试");


                ui.status(`合并内存中的片段…（${mi + 1}/${mergeIds.length}）`);


                const savedGo = wGo.value;




                wGo.value = true;


                liveMerge.setDirtyCanvas?.(true, true);


                try {


                    const mCollected = [];


                    const mDetach = attachCollector(mCollected);


                    const mBox = { id: null };


                    try {


                        // 最终合并这一跑不需要上游：合并节点直接从缓冲目录解码整段视频。
                        // 「图像/音频/帧率」都是可选输入 → 从本次提交里把三个依赖全摘掉，
                        // 上游处理链/模型完全不执行（不再为了触发合并白跑一遍上游）。
                        // 漏掉「帧率」时：它连着加载器/分段节点，后端仍会连带执行整条上游，
                        // 表现为「明明跑完了又激活上游再跑一次」。
                        const mergeApiId = String(nid);
                        const stripUpstreamInputs = (p) => {
                            const out = p?.output;
                            const mergeNode = out?.[mergeApiId];
                            if (!mergeNode?.inputs) {
                                console.warn(
                                    "[小珠光批处理] 合并节点不在本次提交里，跳过上游裁剪:",
                                    mergeApiId,
                                    Object.keys(out || {}),
                                );
                                return;
                            }
                            delete mergeNode.inputs["图像"];
                            delete mergeNode.inputs["音频"];
                            delete mergeNode.inputs["帧率"];
                            // filterPromptOutput 是按「下游 + 其依赖」重建 output 的，摘掉输入后
                            // 上游节点仍留在表里；而加载器是 OUTPUT_NODE=true，即使没人引用也会被
                            // 执行，表现就是"合并已经出片，上游又白跑一次"。这里按摘掉输入后的
                            // 真实引用关系重算可达集，未达的节点（整条上游链）从本次提交里移除。
                            const keep = new Set();
                            const visit = (id) => {
                                const key = String(id);
                                if (keep.has(key) || !out[key]) return;
                                keep.add(key);
                                for (const v of Object.values(out[key].inputs || {})) {
                                    if (Array.isArray(v) && v.length >= 1) visit(v[0]);
                                }
                            };
                            visit(mergeApiId);
                            for (const id of collectDownstream(liveMerge)) visit(id);
                            const beforeCount = Object.keys(out).length;
                            for (const id of Object.keys(out)) {
                                if (!keep.has(id)) delete out[id];
                            }
                            console.log(
                                "[小珠光批处理] 合并阶段裁剪上游:",
                                { before: beforeCount, after: Object.keys(out).length, kept: [...keep] },
                            );
                        };

                        await runOnce(collectDownstream(liveMerge), mBox, mCollected, stripUpstreamInputs, session);


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


                        throw new Error(`合并节点 ${mi + 1}（id ${nid}）已执行但未收集到最终视频：请确认「小珠光视频保存」节点连接在该合并节点的「图像」「音频」输出之后（完整视频经保存节点产出），并查看 ComfyUI 控制台报错`);


                    }


                    merged.push(vid);


                    ui.log(`合并节点 ${mi + 1}/${mergeIds.length} 完成 → ${vid.filename || ""}`);


                } finally {


                    wGo.value = savedGo;


                    liveMerge.setDirtyCanvas?.(true, true);


                }


            }


        } finally {


            liveNode.setDirtyCanvas?.(true, true);


        }


    } else {


        // 回退（工作流无合并节点）：保存节点逐段产出 → 后端直接拼接


        if (!allOutputs.length) {


            throw new Error("未收集到任何保存到 output 的视频输出，无法合并。请在工作流中添加「小珠光视频分段合并」节点（推荐），或检查末端保存节点");


        }


        if ((segments.lastPadFrames || 0) > 0) {
            // 回退拼接没有「末尾裁帧」，末段补出来的重复末帧会留在成片末尾
            ui.log(`提示：末段为满足切点规则补了 ${segments.lastPadFrames} 帧（复制末帧），` +
                "但工作流没有「小珠光视频分段合并」节点，回退拼接无法裁掉这些补帧，成片末尾会多出静帧", true);
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


        merged.push(j);


    }


    liveNode._xzgResetLoaderPreview?.();


    resetPadWidget();

    return { aborted: false, outputs: allOutputs, merged, usedMergeNode: mergeNodes.length > 0 };


}





function openBatchDialog(node, autoStart = false, resume = null, resumeLockHeld = false) {


    // 同一工作流同一节点重入（窗口被切换隐藏后又点按钮）：只重绑实例并重新显示


    if (activeSession && activeSession.open


        && String(activeSession.nodeId) === String(node.id)


        && graphMatchesSession(activeSession)) {


        activeSession.node = node;


        activeSession.active = true;


        // 参数跟随节点/工作流：重入时重新按该节点保存的设置渲染面板
        applyBatchSettings(getDialog(), node);
        // 自动触发（点「运行工作流」被拦截后进入）：分段探测完成后自动开始任务
        if (autoStart) {
            activeSession.autoStart = true;
            // 上次手动打开过窗口时这里要收回：自动跑批一律不弹窗（进度在分段节点上）
            activeSession.hidden = true;
            hideOverlay();
        } else {
            // 手动打开（加载器上的批处理按钮）：显示窗口，运行中也方便看进度/中断
            activeSession.hidden = false;
            showOverlay();
        }


        return;


    }


    // 已有批处理正在别的工作流运行：不打断它（避免误杀正在跑的任务），提示先处理旧的。


    // 批处理 hook 全局 queuePrompt + 全局缓冲目录，两个同时跑必然冲突，故只允许一个在跑。


    if (activeSession && activeSession.isRunning) {


        xzgBatchToast("已有一个「小珠光视频批处理」正在运行中。\n请先切回原窗口完成或点「中断」后，再打开新的批处理。");


        return;


    }


    // 旧会话已空闲：顶掉重开


    if (activeSession) abortSession(activeSession);





    const overlay = getDialog();


    const $ = (id) => overlay.querySelector("#" + id);

    // 从节点 properties 恢复本节点上次的分割参数（随工作流保存，不跨工作流共享）
    applyBatchSettings(overlay, node);








    $("xzg-batch-segments").innerHTML = '<span style="color:#666;">正在按节点参数自动分段…</span>';


    $("xzg-batch-status").textContent = "";


    $("xzg-batch-log").style.display = "none";


    $("xzg-batch-log").innerHTML = "";


    $("xzg-batch-run").disabled = false;


    $("xzg-batch-run").textContent = "开始任务";


    // 复位上一次会话遗留的按钮状态（关闭按钮恢复可点样式）


    $("xzg-batch-close").style.cssText = "background:transparent;border:none;color:#999;font-size:16px;line-height:1;padding:0 4px;cursor:pointer;";


    // 自动触发（点「运行工作流」即跑批）不弹窗：分段与执行进度直接显示在
    // 「小珠光场景切点分段」节点底部；需要看日志或中断时，点加载器上的批处理按钮可随时调出。
    // 必须显式写 display（不能只在非自动时设 block）：DOM 可能上次会话遗留为可见状态
    overlay.style.display = (autoStart || findSchedulerNode()) ? "none" : "block";


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
        resume,


        graphId: app.graph?.id || NIL_GRAPH_ID,

        // 自动触发（点「运行工作流」被拦截后进入）：探测完成后自动点「开始任务」，只消费一次
        autoStart: !!autoStart,

        // 自动跑批时窗口保持隐藏：进度直接画在分段节点上，不挡画布
        hidden: !!autoStart || !!findSchedulerNode(),


        graphSig: graphSignature(),


        node,


        nodeId: String(node.id),


        mergeIds: [],


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


            // 运行中点「关闭」= 先中断（复位红蓝杠 + 兜底复位），随即关闭窗口


            requestAbort("关闭批处理窗口");


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
            const sched = session.active ? findSchedulerNode() : null;
            if (sched) {
                sched._xzgBatchStatus = { text: String(t || ""), warn: !!warn };
                xzgRenderSegRows(sched);
            }


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


            xzgSegRowPatch(i, { status: text, color: color || "#888" });


        },


        segFrames: (i, frames, segStart = NaN) => {


            const el = overlay.querySelector(`#xzg-batch-seg-f-${i}`);


            if (!el) return;


            if (!frames) { el.textContent = ""; xzgSegRowPatch(i, { frames: "" }); return; }


            const base = Number(segStart);


            const txt = Number.isFinite(base)
                ? `${frames} 帧 ${base}-${base + frames - 1}`
                : `${frames} 帧`;


            el.textContent = txt;


            xzgSegRowPatch(i, { frames: txt });


        },


        abortBtn: null,


    };





    const resetUiToIdle = () => {
        // 中断后立即解锁全部控件（runBatch 的 finally 会再兜底一次）
        try { setUiLocked(false); } catch (e) { /* ignore */ }

        running = false;

        removeBatchFocusGuard(); // 中断/卡死兜底：确保护栏被还原

        session.isRunning = false;

        $("xzg-batch-run").disabled = false;

        $("xzg-batch-run").textContent = "开始任务";


        ui.abortBtn && (ui.abortBtn.style.display = "none");


        $("xzg-batch-close").style.cssText =


            "background:transparent;border:none;color:#999;font-size:16px;line-height:1;padding:0 4px;cursor:pointer;";


    };


    const requestAbort = (reason = "用户请求中断") => {
        saveBatchCheckpoint(session, {state: "stopped"});


        abortFlag.v = true;


        interruptSessionPrompt(session, reason);


        // 立即把加载器红蓝杠（跳过帧数/帧数上限/片段起止）恢复到批处理前位置


        session.restoreWidgets?.();


        ui.status("已请求中断，红蓝杠已复位…", true);


        // 兜底：runBatch 若卡在某个 await（等 history / 队列空闲，最坏可达 1 小时）一直不返回，


        // 5 秒后仍未复位就强制把对话框恢复到可操作态，避免「中断无反应、关闭置灰」死局


        setTimeout(() => {


            if (running) {


                resetUiToIdle();


                ui.status("已强制停止（后台可能仍有残留任务，可直接重新开始）", true);


            }


        }, 5000);


    };





    // 运行期间锁定对话框：除「关闭」外全部置灰禁用
    // （帧数规则/切点修复/探测按钮/开始任务）
    const setUiLocked = (locked) => {
        const targets = [
            "#xzg-batch-detect",
            "#xzg-batch-run",
        ];
        for (const sel of targets) {
            const el = overlay.querySelector(sel);
            if (!el) continue;
            el.disabled = !!locked;
            el.style.opacity = locked ? "0.45" : "";
            // 按钮原本是内联 cursor:pointer，解锁时要还原，否则变回默认箭头
            el.style.cursor = locked ? "not-allowed" : (el.tagName === "BUTTON" ? "pointer" : "");
        }
    };

    $("xzg-batch-detect").onclick = async () => {
        if (running) return;


        const dNode = session.node; // 切回后 syncSession 已重绑为实时实例

        // 探测基线图：探测是异步的（取视频信息需要网络往返），期间切到其他工作流
        // 标签的话 app.graph 会变成别的图——若不校验，本图视频算出的段表会写进
        // 别的工作流的调度节点（其视频帧数对不上 → 报「当前段没有帧」），
        // 自动开始执行也会跑错图
        const probeGraph = app.graph;

        const filename = findWidget(dNode, "视频")?.value;


        if (!filename) { ui.status("加载器未选择视频", true); return; }

        // ── 每次分段前先把加载器复位到「用户设定的加载窗口」────────────────
        // 逐段运行会把 跳过帧数/帧数上限 改成每段的窗口；若上次任务被终止或异常退出，
        // 残留值会让这次分段基于上一段的窗口计算（表现为「不读 200 帧加载上限」）。
        // 基准值取自加载器在用户手动修改时写入的 node.properties.xzgBaseSkip / xzgBaseLimit。
        const resetLoaderWindow = async () => {
            const wS = findWidget(dNode, "跳过帧数");
            const wL = findWidget(dNode, "帧数上限");
            const props = dNode.properties || {};
            const asInt = (v, dflt) => {
                const n = Math.floor(Number(v));
                return Number.isFinite(n) && n >= 0 ? n : dflt;
            };
            const baseSkip = asInt(props.xzgBaseSkip, asInt(wS?.value, 0));
            const baseLimit = asInt(props.xzgBaseLimit, asInt(wL?.value, 0));
            if (wS && asInt(wS.value, 0) !== baseSkip) wS.value = baseSkip;
            if (wL && asInt(wL.value, 0) !== baseLimit) wL.value = baseLimit;
            // 回到源视频（清掉上一次执行覆盖的分段预览），再按基准窗口应用红蓝杠
            try { dNode._xzgResetLoaderPreview?.(); } catch (e) { /* ignore */ }
            dNode.setDirtyCanvas?.(true, true);
            await new Promise((r) => setTimeout(r, 200)); // 等播放器重新加载源视频、刷新总帧数
        };
        await resetLoaderWindow();


        ui.status("正在探测场景切点…");

        $("xzg-batch-log").style.display = "none";

        $("xzg-batch-log").innerHTML = "";


        try {


            // 用户预设的裁剪窗口（跳过帧数/帧数上限）：分段限制在该范围内（相当于先按红蓝杠裁剪再分段）
            // 有「小珠光场景切点分段」节点时该窗口不适用：它自己整片解码再按段切片，
            // 加载器的跳过/上限完全作用不到它身上（见下方按其自身视频重新取帧数）


            let srcFps = Number(dNode._xzgVideoPlayer?.getFrameRate?.()) || Number(dNode._xzgSourceFps) || 0;


            // 源总帧数：末段 end=0（到片尾）时用它算出真实帧数，不再显示「片尾」


            let totalFrames = Number(dNode._xzgVideoPlayer?.getSourceTotalFrames?.()) || 0;


            const wSkipD = findWidget(dNode, "跳过帧数");


            const wLimitD = findWidget(dNode, "帧数上限");


            let skipF = Number(wSkipD?.value) || 0;
            const sourceWindowStart = Math.max(0, Math.floor(skipF));


            let limitF = Number(wLimitD?.value) || 0;

            // ── 以「小珠光场景切点分段」实际收到的整片图像为准 ─────────────────
            // 节点收到的就是加载器按「跳过帧数 / 帧数上限」裁好的那段图像：它的第 0 帧
            // 对应窗口起点，总帧数 = 窗口长度（不是源视频总帧数）。段表若按源片总帧数
            // 生成，就会报「当前段没有帧（50-183）：段表与当前视频不匹配（实际只有 50 帧）」。
            const schedProbeNode = findSchedulerNode();
            if (schedProbeNode) {
                const loaderVideo = String(findWidget(dNode, "视频")?.value || "");
                const meta = await probeVideoMeta(loaderVideo);
                if (meta) {
                    // 源片实测帧数 + 加载窗口 → 窗口长度（帧数上限 50 就按 50 帧分段）
                    const winStart = Math.min(Math.max(0, Math.floor(skipF)), meta.frames);
                    const winEnd = limitF > 0
                        ? Math.min(meta.frames, winStart + Math.floor(limitF))
                        : meta.frames;
                    totalFrames = Math.max(0, winEnd - winStart);
                    srcFps = meta.fps;
                    // 段表坐标系 = 窗口内坐标：起点归零，区间就是 0..窗口长度
                    skipF = 0;
                    limitF = 0;
                }
            }


            if (!srcFps || totalFrames <= 0) throw new Error("请先加载视频并探测到有效帧率和总帧数");
            const rangeStart = Math.max(0, Math.min(totalFrames, Math.floor(skipF)));
            const rangeEnd = limitF > 0 ? Math.min(totalFrames, rangeStart + Math.floor(limitF)) : totalFrames;
            const threshold = Number(findNodeWidget(schedProbeNode, "场景阈值")?.value ?? 0.35);
            const response = await api.fetchApi("/xzg_video_editor_detect_scenes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename, file_type: "input", threshold }),
            });
            const detection = await response.json();
            if (!response.ok || !Array.isArray(detection.scenes)) {
                throw new Error(detection.error || "场景切点探测失败");
            }
            // 场景时间属于源视频；调度节点的段表属于加载窗口，从窗口起点归零。
            const origin = schedProbeNode ? sourceWindowStart : 0;
            const cuts = [...new Set(detection.scenes
                .map(time => Math.round(Number(time) * srcFps) - origin)
                .filter(frame => Number.isFinite(frame) && frame > rangeStart && frame < rangeEnd))]
                .sort((a, b) => a - b);
            const points = [rangeStart, ...cuts, rangeEnd];
            const nominal = points.slice(0, -1).map((start, i) => [start, points[i + 1]]);
            segments = nominal.map(([a, b], i) => ({
                start: a / srcFps,
                end: (i === nominal.length - 1 && limitF <= 0 && b >= totalFrames) ? 0 : b / srcFps,
            }));
            segments.lastPadFrames = 0;
            $("xzg-batch-status").textContent = `场景切点探测完成：${cuts.length} 个切点，共 ${segments.length} 段（${srcFps} fps）`;
            // 全部段参与执行（不支持点选）
            // 段表写回「小珠光场景切点分段」：节点上直接可见本次分段结果（下游节点/后端也能读到）
            // 写入前校验仍在探测开始时的图：期间切走了就放弃写入与自动执行，
            // 避免把段表污染到别的工作流（切回后重新探测即可）
            if (app.graph !== probeGraph) {
                session.autoStart = false;
                ui.status("探测期间切换到了其他工作流：已取消写入段表与自动执行，请切回本工作流重新预览分段", true);
                return;
            }
            // 段行数据先收集，等段列表渲染完成后再一次性镜像到调度节点（免弹窗）
            const nodeRows = [];
            const schedNode = findSchedulerNode();
            if (schedNode) {
                const table = segments.map((s) => {
                    const a = Math.max(0, Math.round(Number(s.start || 0) * srcFps));
                    const b = Number(s.end) > 0 ? Math.round(Number(s.end) * srcFps) : totalFrames;
                    return `${a}:${Math.max(a, b)}`;
                }).join(",");
                setNodeWidgetValue(schedNode, "段表", table);
                setNodeWidgetValue(schedNode, "当前段", 0);
            }

            // 探测完即显示每段预计帧数（秒→帧换算，与 runBatch 段窗口公式一致）：

            // 段 end>0 时终点=段末秒；end=0 表示到片尾，终点=源总帧数。

            // 执行后 segFrames 会用实际缓冲帧数覆盖，二者通常一致。

            $("xzg-batch-segments").innerHTML = segments

                .map((s, i) => {

                    const startFrame = Math.max(0, Math.round(s.start * srcFps));

                    const endFrame = s.end > 0

                        ? Math.round(s.end * srcFps)

                        : (totalFrames > 0 ? totalFrames : 0);

                    const lenFrames = endFrame > 0 ? Math.max(0, endFrame - startFrame) : 0;

                    // 帧区间按真实帧数显示；末段为满足 17N+5 复制末帧补齐的部分单独标注
                    const padFrames = 0;
                    const rangeEndShown = Math.max(startFrame, endFrame - 1);
                    const frameRange = `${startFrame}-${rangeEndShown}`;
                    const frameText = (srcFps > 0 && lenFrames > 0)
                        ? `${lenFrames} 帧 ${frameRange}${padFrames > 0 ? `（含补 ${padFrames} 帧）` : ""}`
                        : "";

                    const endTimeStr = s.end > 0

                        ? fmtTime(s.end)

                        : (totalFrames > 0 && srcFps > 0 ? fmtTime(totalFrames / srcFps) : "片尾");

                    nodeRows.push({
                        time: `#${i + 1}  ${fmtTime(s.start)} → ${endTimeStr}`,
                        frames: frameText,
                        status: "待执行",
                        color: "#888",
                    });

                    return `<div id="xzg-batch-seg-row-${i}" class="xzg-batch-seg-row" style="display:flex;align-items:center;gap:6px;">` +

                        `<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">#${i + 1} &nbsp;${fmtTime(s.start)} → ${endTimeStr}</span>` +

                        `<span id="xzg-batch-seg-f-${i}" style="color:#7a9;flex:none;">${frameText}</span>` +

                        `<span id="xzg-batch-seg-s-${i}" style="color:#888;flex:none;">待执行</span>` +

                    `</div>`;

                })

                .join("");

            // 段列表渲染完成后再镜像到调度节点：此前在 nodeRows 还没填充（甚至还没声明）时就调用，
            // 会抛 "Cannot access 'nodeRows' before initialization"，节点上也显示不出分段行
            xzgMirrorSegRows(schedNode, nodeRows);

            const rangeNote = (skipF > 0 || limitF > 0)
                ? `（裁剪范围 ${rangeStart}-${Math.max(rangeStart, rangeEnd - 1)} 帧）`
                : "";

            ui.status(`分段预览完成，共 ${segments.length} 段${rangeNote}，自动开始执行…`);

            // 自动触发：分段就绪后直接开始任务（等价于用户点一次「开始任务」），只消费一次
            if (session.autoStart) {
                session.autoStart = false;
                setTimeout(() => {
                    try { $("xzg-batch-run").click(); }
                    catch (e) { console.error("[小珠光批处理] 自动开始失败:", e); }
                }, 0);
            }


        } catch (e) {


            // 自动触发时探测失败：消费掉标记，避免残留导致后续手动探测后自动开始任务
            session.autoStart = false;

            ui.status(String(e.message || e), true);


        }


    };





    const startBatch = async () => {

        if (running) return;

        if (!segments) { ui.status("请先预览帧数分段", true); return; }

        const selArr = segments.map(() => true); // 全部段参与执行

        running = true;

        installBatchFocusGuard(); // 防抢焦点：运行期间拦截 alert/confirm/prompt/focus/open

        session.autoStart = false; // 一开始任务即消费自动触发标记，避免下次误触发

        session.isRunning = true;

        // 悬浮球进度从全局位置起步：刷新恢复时直接显示已完成段数（如 4/12），普通运行为 0/总段数
        updateBatchBall(session?.resume?.nextIndex || 0, segments.length);

        abortFlag.v = false;

        // 运行期间除「关闭」外全部置灰禁用
        setUiLocked(true);

        // 运行期间「关闭」按钮保持可点：点它=中断并关闭（不再置灰）

        try {

            const result = await runBatch(session.node, segments, ui, abortFlag, session, selArr);
            saveBatchCheckpoint(session, {state: result.aborted ? "stopped" : "completed", promptId: null});


            if (result.aborted) {


                ui.status("已中断任务", true);


            } else {


                const mergedArr = Array.isArray(result.merged) ? result.merged : [];


                const msg = mergedArr.length


                    ? `全部完成！已合并产出 ${mergedArr.length} 支视频：` +


                      mergedArr.map((f) => `output/${f.subfolder ? f.subfolder + "/" : ""}${f.filename}`).join("、") +


                      (result.usedMergeNode ? "" : "（提示：工作流中添加「小珠光视频分段合并」节点，可只输出最终视频且更省内存）")


                    : `全部完成！共 ${result.outputs.length} 个片段产物（未合并）`;


                ui.status(msg);


                ui.log(msg);


                // 所有分镜完成、合并成功：日志区绿色大字提示


                ui.logDone();


                // 全部完成：不自动关闭，由用户手工点 ✕ 关闭（出错/中断同样保持打开）


            }


        } catch (e) {


            console.error("[小珠光逐段批处理]", e);
            saveBatchCheckpoint(session, {state: "error"});


            ui.status(String(e.message || e), true);


            // 出错时保留已完成分段，避免排查或重试前丢失所有产物。
            ui.log(`任务停止：${String(e.message || e)}；已完成分段的缓冲已保留。`, true);
            const sched = findSchedulerNode();
            if (sched) {
                for (const row of sched._xzgSegRows || []) {
                    if (row.status === "执行中") { row.status = "失败"; row.color = "#f66"; }
                }
                xzgRenderSegRows(sched);
                hideOverlay();
            }


        } finally {

            running = false;

            removeBatchFocusGuard(); // 任务结束：还原 alert/confirm/prompt/focus/open

            session.isRunning = false;

            setUiLocked(false); // 任务结束/出错：恢复全部控件

            $("xzg-batch-close").style.cssText = "background:transparent;border:none;color:#999;font-size:16px;line-height:1;padding:0 4px;cursor:pointer;";

        }

    };

    $("xzg-batch-run").onclick = () => {
        if (!globalThis.navigator?.locks?.request) return startBatch();
        return navigator.locks.request(BATCH_RUN_LOCK, {ifAvailable: true}, lock => {
            if (!lock) { ui.status("已有浏览器页面正在执行分段任务，请勿重复启动。", true); return; }
            return startBatch();
        });
    };
    if (resume) {
        segments = resume.segments.map(segment => ({...segment}));
        segments.lastPadFrames = resume.lastPadFrames || 0;
        const sched = findLiveNode(resume.schedulerId, SCHEDULER_NODE_TYPE);
        setNodeWidgetValue(sched, "段表", resume.table);
        setNodeWidgetValue(sched, "当前段", resume.nextIndex);
        xzgMirrorSegRows(sched, segments.map((segment, index) => ({
            time: `#${index + 1}`,
            frames: (() => {
                const [start, end] = (resume.table.split(",")[index] || "").split(":").map(Number);
                return Number.isFinite(start) && Number.isFinite(end) ? `${end - start} 帧 ${start}-${end - 1}` : "";
            })(),
            status: index < resume.nextIndex ? "已完成" : "待执行",
            color: index < resume.nextIndex ? "#8c8" : "#888",
        })));
        ui.status(`刷新恢复完成，从第 ${Math.min(resume.nextIndex + 1, segments.length)} / ${segments.length} 段继续…`);
        return resumeLockHeld ? startBatch() : $("xzg-batch-run").onclick();
    }
}





// ═══════════════════════════════════════════════════════════════════════


// 注入按钮


// ═══════════════════════════════════════════════════════════════════════





app.registerExtension({


    name: "XZG.VideoBatchRunner",
    afterConfigureGraph() {
        setTimeout(() => restoreBatchAfterRefresh(), 800);
    },

    // 「点一次运行工作流」即自动跑批：仅当图里存在「小珠光场景切点分段」节点时
    // 拦截本次提交，改为打开批处理对话框并自动分段/开始；
    // 没有该节点时完全不干预，普通运行照旧。
    setup() {
        // 兜底：上一次运行异常退出可能留下未还原的全局钩子，页面初始化时先清干净
        try { removeBatchFocusGuard(); } catch (_) { /* ignore */ }
        const origQueuePrompt = api.queuePrompt;
        api.queuePrompt = async function (index, prompt, ...rest) {
            try {
                const nodes = app.graph?._nodes || [];
                const batchBusy = !!activeSession && activeSession.isRunning;
                const schedNode = nodes.find((n) => n?.type === SCHEDULER_NODE_TYPE) || null;
                const loaderNode = nodes.find((n) => n?.type === BATCH_NODE_TYPE) || null;
                // 局部执行与编辑器加载画面不启动批处理；加载器、分段节点均在提交内才拦截。
                const out = prompt?.output || {};
                const inBranch = !!(loaderNode && out[String(loaderNode.id)] && schedNode && out[String(schedNode.id)]);
                if (inBranch && loaderNode?.properties?.xzgMultiVideo) {
                    return origQueuePrompt.call(api, index, prompt, ...rest);
                }
                if (!batchBusy && !prompt?.xzgExecuteToNode && inBranch) {
                    // 吞掉这次提交（不真正入队），改为跑批处理
                    setTimeout(() => {
                        try {
                            openBatchDialog(loaderNode, true);
                            document.querySelector("#xzg-batch-detect")?.click();
                        } catch (e) {
                            console.error("[小珠光批处理] 自动触发失败:", e);
                            try { xzgBatchToast(`自动批处理启动失败: ${e?.message || e}`); } catch (_) { /* ignore */ }
                        }
                    }, 0);
                    return {};
                }
            } catch (e) {
                console.error("[小珠光批处理] 自动触发检测失败:", e);
            }
            return origQueuePrompt.call(api, index, prompt, ...rest);
        };
    },


    beforeRegisterNodeDef(nodeType, nodeData) {


        // 「小珠光场景切点分段」：「段表」「当前段」是前端内部驱动字段，不显示在节点面板上
        if (nodeData?.name === SCHEDULER_NODE_TYPE) {
            const origSchedCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const ret = origSchedCreated?.apply(this, arguments);
                const hiddenNames = new Set(["段表", "当前段"]);
                for (const w of this.widgets || []) {
                    if (w && hiddenNames.has(w.name)) {
                        w.type = "hidden";
                        w.computeSize = () => [0, -4];
                        w.draw = () => {};
                    }
                }
                // 分段行容器：DOM 控件（随节点布局、高度跟随行数），
                // 不再用 canvas 自绘——Vue 节点下自绘坐标和 DOM 控件对不上，会盖到输入上
                const segEl = document.createElement("div");
                // pointer-events:none：纯展示容器，点击必须穿透到画布/节点上，
                // 否则点过这里后焦点被 DOM 抢走，Delete 键就删不掉节点了
                segEl.style.cssText = "width:100%;box-sizing:border-box;padding:2px 8px 4px;"
                    + "font:11px 'Segoe UI',system-ui,sans-serif;color:#93a1b3;user-select:none;overflow:hidden;"
                    + "pointer-events:none;";
                segEl.style.display = "none";
                this._xzgSegRowsEl = segEl;
                xzgBindSegRowsWheel(this, segEl);
                // 按住分段列表区域拖动 = 移动节点（列表是纯展示区，见 xzgBindSegRowsDrag）
                xzgBindSegRowsDrag(this, segEl);
                try {
                    this.addDOMWidget(SEG_ROWS_WIDGET_NAME, SEG_ROWS_WIDGET_NAME, segEl, {
                        serialize: false,
                        hideOnZoom: false,
                        getHeight: () => xzgSegRowsHeight(this),
                    });
                } catch (e) {
                    console.warn("[小珠光场景切点分段] 分段行控件创建失败:", e);
                }
                // addDOMWidget 可能把 element 的 pointer-events 改写为 auto（DOM 控件默认要可交互），
                // 那样滚轮停在分段列表上就只滚 DOM、画布不再缩放。用 !important 压死，
                // 保证这块纯展示区域始终把滚轮/点击穿透给画布。
                try { segEl.style.setProperty("pointer-events", "none", "important"); } catch (_) { /* ignore */ }
                if (Array.isArray(this._xzgSegRows) && this._xzgSegRows.length) xzgRenderSegRows(this);
                return ret;
            };
            // 载入旧工作流时清理已删除参数的残留输入/输出
            // （输入：分割方式/切点重叠/自动批处理；输出：总帧数/段数/段序号）
            // 白名单动态取自当前节点定义：只清理定义里已不存在的端口，
            // 避免误删新版参数（如新增端口）或 widget 输入槽（否则控件会跟着消失）
            const origSchedConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                // 清理旧端口及重建 DOM 控件可能触发尺寸重算，保存载入前的目标尺寸。
                const savedSize = Array.from(arguments[0]?.size || this.size || []);
                const r = origSchedConfigure?.apply(this, arguments);
                try {
                    pruneLegacyInputs(this, new Set([
                        ...Object.keys(nodeData.input?.required || {}),
                        ...Object.keys(nodeData.input?.optional || {}),
                    ]));
                    // 输出端口名取 output_name（显示名，与 out.name 对应）；
                    // nodeData.output 是类型名（IMAGE/AUDIO…），拿它当白名单会把输出全剪光
                    pruneLegacyOutputs(this, new Set(nodeData.output_name || nodeData.output || []));
                    // 从段表控件重建节点上的分段行（基础信息；时间/状态由批处理流程镜像更新），
                    // 避免切换工作流标签（节点实例重建）后节点上一片空白
                    const tableW = (this.widgets || []).find((x) => x?.name === "段表");
                    const table = String(tableW?.value || "").trim();
                    if (table) {
                        this._xzgSegRows = table.split(",").map((part, i) => {
                            const seg = part.split(":").map((n) => Math.floor(Number(n) || 0));
                            if (seg.length !== 2 || seg[1] <= seg[0]) return null;
                            return {
                                time: `#${i + 1}`,
                                frames: `${seg[1] - seg[0]} 帧 ${seg[0]}-${seg[1] - 1}`,
                                status: "",
                                color: "#888",
                            };
                        }).filter(Boolean);
                    } else {
                        this._xzgSegRows = [];
                    }
                    xzgRenderSegRows(this);
                } catch (e) { /* ignore */ }
                if (savedSize.length === 2 && savedSize.every(v => Number.isFinite(v) && v > 0)) {
                    this.setSize?.([
                        Math.max(savedSize[0], this.size?.[0] || 0),
                        Math.max(savedSize[1], this.size?.[1] || 0),
                    ]);
                }
                return r;
            };
            return;
        }


        // 「小珠光视频分段合并」：隐藏「执行合并」开关（内部信号，编排器自动控制；


        // 保留控件对象以维持序列化，仅不在画布上显示/占位）


        if (nodeData?.name === MERGE_NODE_TYPE) {


            const origCreated = nodeType.prototype.onNodeCreated;


            nodeType.prototype.onNodeCreated = function () {


                const r = origCreated?.apply(this, arguments);


                try {


                    // 「末尾裁帧」也是编排器专用信号：切点修复补出的重复末帧在合并前裁掉
                    for (const name of ["执行合并", "末尾裁帧"]) {


                        const w = (this.widgets || []).find((x) => x.name === name);


                        if (!w) continue;


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


                    // 清理旧版本残留的输入接口（如 重叠帧/重叠表/过渡方式 被转为输入后的残留）。
                    // 白名单动态取自当前节点定义：只清理定义里已不存在的端口。
                    pruneLegacyInputs(this, new Set([
                        ...Object.keys(nodeData.input?.required || {}),
                        ...Object.keys(nodeData.input?.optional || {}),
                    ]));

                    // 「执行合并/末尾裁帧」是编排器内部信号：控件本体已隐藏，但旧工作流里
                    // 它们被转换成的 widget 输入槽还在，会在节点底部渲染成两个悬空的
                    // 空端口圆点。未连线时直接移除（保存工作流后即不再出现；
                    // 控件本体仍保留在 widgets_values 里，编排器照常读写其值）
                    for (let i = (this.inputs || []).length - 1; i >= 0; i--) {
                        const inp = this.inputs[i];
                        if (!inp || !inp.widget) continue;
                        if (inp.name !== "执行合并" && inp.name !== "末尾裁帧") continue;
                        if (inp.link != null) continue; // 已连线的不动
                        try {
                            this.removeInput(i);
                        } catch (_) {
                            this.inputs.splice(i, 1);
                        }
                    }


                } catch (e) { /* ignore */ }


                return r;


            };


            return;


        }


    },


});
