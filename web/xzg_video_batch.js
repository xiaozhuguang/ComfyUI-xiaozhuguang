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

/** 节点 id → 磁盘/byNode 用的安全名：节点 id 形如 "1120:1116"，
    其中 : \ / * ? " < > | 在 Windows 文件名非法，统一替换为 _（与后端 get_batch_buffer_dir 同规则）。 */
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
            🎬 视频切点探测及批处理<span style="font-size:11px;color:#999;font-weight:normal;">　（双击标题栏最小化为悬浮球）</span>
          </div>
          <div style="padding:14px 18px;display:flex;flex-direction:column;gap:10px;flex:1;overflow:hidden;min-height:0;">
            <div>源视频：<b id="xzg-batch-video" style="color:#fff;"></b></div>
            <div style="display:flex;align-items:center;justify-content:flex-end;">
              <button id="xzg-batch-detect" style="background:#333;color:${GOLD};border:1px solid #555;
                     border-radius:5px;padding:5px 12px;cursor:pointer;">自动探测视频切点</button>
            </div>
            <div id="xzg-batch-selbar" style="display:none;align-items:center;justify-content:space-between;gap:8px;min-height:24px;">
              <span id="xzg-batch-seltext" style="color:#9ab;font-size:12px;">已选 0/0 段</span>
              <button id="xzg-batch-selall" style="background:#333;color:${GOLD};border:1px solid #555;
                     border-radius:5px;padding:2px 10px;cursor:pointer;font-size:12px;">全不选</button>
            </div>
            <div id="xzg-batch-segments" style="background:#262626;border:1px solid #3a3a3a;border-radius:6px;
                padding:8px 10px;min-height:60px;flex:1;overflow:auto;line-height:1.7;"></div>
            <div id="xzg-batch-status" style="color:#9ab;min-height:18px;"></div>
            <div id="xzg-batch-log" style="background:#191919;border:1px solid #333;border-radius:6px;
                padding:6px 10px;max-height:150px;overflow:auto;font-size:12px;color:#8a8;line-height:1.6;display:none;"></div>
          </div>
          <div style="padding:10px 18px 14px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid #333;">
            <button id="xzg-batch-close" style="background:#5a2a2a;color:#faa;border:1px solid #744;
                   border-radius:5px;padding:6px 14px;cursor:pointer;">关闭</button>
            <button id="xzg-batch-run" style="margin-left:auto;background:#14501a;color:#3ee06a;border:1px solid #1f7a33;
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
            if (Array.isArray(s.mergeIds) && s.mergeIds.length) {
                s.mergeNodes = s.mergeIds.map((id) => findLiveNode(id, MERGE_NODE_TYPE)).filter(Boolean);
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

async function runBatch(node, segments, ui, abortFlag, session = null, selected = null) {
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
    // 把「恢复红蓝杠/段窗口到批处理前位置」挂到会话上：点中断时立即调用，
    // 不必等 runBatch 走到 finally（卡死后 finally 可能迟迟不执行）
    if (session) {
        session.restoreWidgets = () => {
            try {
                resolveLive();
                if (wSkip) wSkip.value = origSkip;
                if (wLimit) wLimit.value = origLimit;
                if (wStart) wStart.value = origStart;
                if (wEnd) wEnd.value = origEnd;
                liveNode.setDirtyCanvas?.(true, true);
            } catch (e) { /* ignore */ }
        };
    }
    // 缓冲式合并节点（支持多个）：逐段各缓冲到专属子目录，最后逐个单独跑合并。
    // 一条加载器链上分叉出的每条处理链可各接一个合并节点；只驱动位于本加载器
    // 下游的合并节点，不属于本链的（其他加载器的）保持原样并在日志明确提示
    const loaderDownIds = collectDownstream(node);
    const allMergeInGraph = (app.graph?._nodes || []).filter((n) => n.type === MERGE_NODE_TYPE);
    const mergeNodes = allMergeInGraph.filter((n) => loaderDownIds.has(String(n.id)));
    const foreignMerges = allMergeInGraph.filter((n) => !loaderDownIds.has(String(n.id)));
    if (foreignMerges.length) {
        const hint = `检测到 ${foreignMerges.length} 个「小珠光视频批处理合并」节点不在当前加载器下游（属于其他加载器的链路），本次批处理不驱动它们；请用对应加载器上的批处理按钮单独编排`;
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
                throw new Error(`${label}的「图像」输入未连接：请把处理链的图像输出接到合并节点（否则逐段阶段不会缓冲，最终合并会报缓冲区为空）`);
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
            await fetch(BUFFER_RESET_API, { method: "POST" });
        } catch (e) { /* 重置失败不阻塞，finalize 会校验缓冲 */ }
    }


    // 逐段执行的输出节点集合（白名单式，绝对排除下游）：
    // 有合并节点 → 只保留合并节点为输出节点。其上游（加载器/处理链）作为依赖由后端
    // 连带执行；其下游（保存视频节点等）不在执行图里，逐段阶段不可能被触发输出；
    // 最终合并阶段单独用 collectDownstream(各合并节点) 恢复下游，产出完整视频。
    // 无合并节点（回退路径）→ 保留批处理节点下游全部输出节点（逐段直接产出，最后拼接）。
    let downIds;
    if (mergeNodes.length) {
        const allDown = collectDownstream(node);
        const excludeFromSeg = new Set();
        for (const mn of mergeNodes) {
            for (const id of collectDownstream(mn)) {
                if (id !== String(mn.id)) excludeFromSeg.add(id);
            }
        }
        downIds = new Set([...allDown].filter((id) => !excludeFromSeg.has(id)));
    } else {
        downIds = collectDownstream(node);
        const hint = "编排模式：回退拼接（未找到「小珠光视频批处理合并」节点），逐段直接产出最后拼接";
        if (hint !== lastOrchHint) { ui.log(hint, true); lastOrchHint = hint; }
    }

    const allOutputs = [];
    const skippedSegments = [];
    // 用户点选跳过的段（1-based）：只执行勾选片段，跳过段不计失败、同步减少最终合并预期
    const userSkipped = new Set();
    const totalSel = selected ? segments.filter((_, i) => selected[i]).length : segments.length;
    let execCount = 0;
    // 按合并节点记录缺段（多链时某链某段未缓冲，最终按各节点预期分别校验）
    const skippedByNode = new Map(mergeIds.map((id) => [id, new Set()]));
    let aborted = false;
    ui.abortBtn && (ui.abortBtn.style.display = "");
    let detach = null;
    // 缓冲是否成功以服务端缓冲目录为准（避免 executed 事件竞态导致误判/漏判）
    let prevCount = 0;
    if (mergeNodes.length) {
        const bl = await fetchBufferList();
        prevCount = bl ? (bl.count || 0) : 0;
    }
    // 分段行内状态复位
    segments.forEach((_, i) => { ui.segStatus?.(i, "待执行"); }); // 不清空帧数：探测阶段已显示预计帧数，执行完再覆盖为实际帧数
    if (selected) {
        const nSkipped = segments.length - totalSel;
        if (nSkipped > 0) {
            ui.log(`已按选择跳过 ${nSkipped} 个片段，本次只执行 ${totalSel} 段`);
        }
    }

    try {
        for (let i = 0; i < segments.length; i++) {
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
            updateBatchBall(execCount, totalSel); // 悬浮球实时显示 当前段/总段数（按已选段计数）

            // 每段最多尝试 3 次：与之前运行参数完全相同时 ComfyUI 会缓存命中（整链跳过执行），
            // 导致合并节点不缓冲 → 重试时对片段窗口做 1ms 级微移绕过缓存（画面无感知）
            const MAX_ATTEMPTS = 3;
            const collected = [];
            const buffered = [];
            let newFiles = [];
            // 段级快照：本段开始前各合并节点缓冲子目录的文件清单。成功判定用「按节点文件 diff」
            // 而非计数对比——计数会受文件系统延迟/执行重叠影响而误判，diff 能精确识别本段新增
            const segSets = new Map();
            if (mergeNodes.length) {
                const segBl = await fetchBufferList();
                for (const nid of mergeIds) segSets.set(nid, new Set(bufNodeFiles(segBl, nid)));
            }
            // 本段仍需缓冲的合并节点（部分节点失败时收窄到只重试失败节点的链）
            let pendingIds = mergeIds.slice();
            for (let attempt = 1; attempt <= MAX_ATTEMPTS && !abortFlag.v && (mergeNodes.length === 0 || pendingIds.length > 0); attempt++) {
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
                    // 首次执行传 downIds（合并节点缓冲 + 直连在链上的保存节点逐段输出）；
                    // 重试才收窄到失败合并节点的链（已成功节点不重复执行/重复保存）。
                    const segDownIds = mergeNodes.length
                        ? (attempt === 1 ? downIds : new Set(pendingIds))
                        : downIds;
                    await runOnce(segDownIds, idBox, collected);
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
                    // 成功判定：以「各合并节点缓冲子目录的文件 diff」为权威（相对本段开始前的快照）。
                    // 不能用 ui.buffered 事件判断：缓存命中时 ComfyUI 会原样重放上次的 ui，
                    // 事件有假阳性（表现为"已缓冲"但磁盘上什么都没写）。
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
                    if (fr) ui.segFrames?.(i, fr);
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
        }
    } finally {
        ui.abortBtn && (ui.abortBtn.style.display = "none");
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
        if (mergeNodes.length) {
            try { await fetch(BUFFER_RESET_API, { method: "POST" }); } catch (e) { /* ignore */ }
        }
        return { aborted: true, outputs: allOutputs, merged: [], usedMergeNode: mergeNodes.length > 0 };
    }

    // 最终合并阶段也要等回本工作流（合并节点控件只存在于挂载的图上）
    if (session) {
        await session.waitActive(ui);
        resolveLive();
        if (abortFlag.v) {
            return { aborted: true, outputs: allOutputs, merged: [], usedMergeNode: mergeNodes.length > 0 };
        }
    }

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
                throw new Error(`合并节点 ${mi + 1}（id ${nid}）缓冲区有 ${cnt} 个分段，但预期是 ${expected} 个` +
                    (cnt > expected
                        ? "（存在重复缓冲，可能因执行时序异常）。已取消合并，请点「开始」重新运行（开始时会自动清空缓冲）"
                        : "（部分段未缓冲成功）。已取消合并，请重新运行批处理"));
            }
        }
        // 最终合并：逐个合并节点串行执行（置位「执行合并」→ 单独跑一次 → 恢复）。
        // 串行是刻意的：finalize 要把完整视频解码为帧张量（内存≈整支视频），并行会叠加峰值内存
        // 「帧数上限=1」让合并空跑时的上游开销降到最低且必然解出 1 帧
        // （不用极小时间窗口：某些视频 0.05s 内解不出帧会报 No frames decoded）
        const wCap = findWidget(liveNode, "帧数上限");
        const anyMergeLinked = mergeNodes.some((mn) => (mn.inputs || []).some((inp) => inp.link != null));
        const savedCap = (anyMergeLinked && wCap) ? wCap.value : null;
        if (savedCap != null) {
            wCap.value = 1;
            liveNode.setDirtyCanvas?.(true, true);
        }
        try {
            for (let mi = 0; mi < mergeIds.length; mi++) {
                const nid = mergeIds[mi];
                const liveMerge = findLiveNode(nid, MERGE_NODE_TYPE) || mergeNodes[mi];
                const wGo = findWidget(liveMerge, "执行合并");
                if (!wGo) throw new Error("「小珠光视频批处理合并」节点缺少「执行合并」控件，请刷新页面后重试");
                ui.status(`合并缓冲中的片段…（${mi + 1}/${mergeIds.length}）`);
                const savedGo = wGo.value;
                wGo.value = true;
                liveMerge.setDirtyCanvas?.(true, true);
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
            if (savedCap != null) {
                wCap.value = savedCap;
            }
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
        merged.push(j);
    }
    liveNode._xzgResetLoaderPreview?.();
    return { aborted: false, outputs: allOutputs, merged, usedMergeNode: mergeNodes.length > 0 };
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
    const wVideo = findWidget(node, "视频");

    $("xzg-batch-video").textContent = wVideo?.value || "(未选择)";
    $("xzg-batch-segments").innerHTML = `<span style="color:#666;">点击「自动探测视频切点」探测场景切换位置</span>`;
    $("xzg-batch-selbar").style.display = "none";
    $("xzg-batch-seltext").textContent = "已选 0/0 段";
    $("xzg-batch-status").textContent = "";
    $("xzg-batch-log").style.display = "none";
    $("xzg-batch-log").innerHTML = "";
    $("xzg-batch-run").disabled = false;
    $("xzg-batch-run").textContent = "开始任务";
    // 复位上一次会话遗留的按钮状态（中断按钮隐藏、关闭按钮恢复可点）
    $("xzg-batch-close").style.cssText = "background:#5a2a2a;color:#faa;border:1px solid #744;" +
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
    let segSelected = null; // 探测后点选要执行的片段（默认全选），null=未探测
    let running = false;
    const abortFlag = { v: false };

    // 会话：归属打开时的工作流（graphId）。切走只暂停，清空/删节点/别处重开才中止。
    // 节点实例切换标签页后会重建，runBatch 内一律按 nodeId 实时解析。
    const session = {
        graphId: app.graph?.id || NIL_GRAPH_ID,
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
            requestAbort();
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
        abortBtn: null,
    };

    const resetUiToIdle = () => {
        running = false;
        session.isRunning = false;
        $("xzg-batch-run").disabled = false;
        $("xzg-batch-run").textContent = "开始任务";
        setChecksEnabled(true);
        ui.abortBtn && (ui.abortBtn.style.display = "none");
        $("xzg-batch-close").style.cssText =
            "background:#5a2a2a;color:#faa;border:1px solid #744;" +
            "border-radius:5px;padding:6px 14px;cursor:pointer;";
    };
    const requestAbort = () => {
        abortFlag.v = true;
        try { api.interrupt(); } catch (e) { /* ignore */ }
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

    // ═══════════════════════════════════════════════════════════
    // 点选执行：探测后勾选要执行的片段（默认全选），未勾选段运行时跳过
    // ═══════════════════════════════════════════════════════════
    const updateSelUI = () => {
        const total = segments ? segments.length : 0;
        const n = segSelected ? segSelected.filter(Boolean).length : 0;
        $("xzg-batch-seltext").textContent = total > 0 ? `已选 ${n}/${total} 段` : "未探测";
        const allOn = total > 0 && n === total;
        $("xzg-batch-selall").textContent = allOn ? "全不选" : "全选";
        $("xzg-batch-selall").disabled = total === 0;
        if (segments) {
            overlay.querySelectorAll(".xzg-batch-seg-row").forEach((rowEl, i) => {
                rowEl.style.opacity = (segSelected && segSelected[i]) ? "1" : "0.4";
            });
        }
    };
    $("xzg-batch-selall").onclick = () => {
        if (!segments || !segSelected || running) return;
        const allOn = segSelected.every(Boolean);
        segSelected = segments.map(() => !allOn);
        overlay.querySelectorAll(".xzg-batch-seg-check").forEach((cb, i) => { cb.checked = segSelected[i]; });
        updateSelUI();
    };
    const setChecksEnabled = (enabled) => {
        overlay.querySelectorAll(".xzg-batch-seg-check").forEach((cb) => { cb.disabled = !enabled; });
        $("xzg-batch-selall").disabled = !enabled || !segments;
    };

    $("xzg-batch-detect").onclick = async () => {
        if (running) return;
        const dNode = session.node; // 切回后 syncSession 已重绑为实时实例
        const filename = findWidget(dNode, "视频")?.value;
        if (!filename) { ui.status("加载器未选择视频", true); return; }
        const threshold = 0.35; // 与快剪默认阈值一致
        ui.status("正在探测切点（大视频可能需要数十秒）…");
        $("xzg-batch-log").style.display = "none";
        $("xzg-batch-log").innerHTML = "";
        try {
            const cuts = await detectScenes(filename, threshold);
            // 用户预设的裁剪窗口（跳过帧数/帧数上限）：探测结果与分段都限制在该范围内——
            // 相当于先按红蓝杠裁剪，再在裁剪后的视频上自动探测切点并分段
            const srcFps = Number(dNode._xzgSourceFps) || Number(dNode._xzgVideoPlayer?.getFrameRate?.()) || 0;
            // 源总帧数：末段 end=0（到片尾）时用它算出真实帧数，不再显示「片尾」
            const totalFrames = Number(dNode._xzgVideoPlayer?.getSourceTotalFrames?.()) || 0;
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
            segSelected = segments.map(() => true); // 默认全选，可点选只执行某几段
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
                    const frameText = (srcFps > 0 && lenFrames > 0) ? `${lenFrames} 帧` : "";
                    const endTimeStr = s.end > 0
                        ? fmtTime(s.end)
                        : (totalFrames > 0 && srcFps > 0 ? fmtTime(totalFrames / srcFps) : "片尾");
                    return `<div id="xzg-batch-seg-row-${i}" class="xzg-batch-seg-row" style="display:flex;align-items:center;gap:6px;">` +
                        `<label style="flex:1;display:flex;align-items:center;gap:6px;cursor:pointer;min-width:0;">` +
                            `<input type="checkbox" class="xzg-batch-seg-check" data-i="${i}" checked` +
                                   ` style="accent-color:#dcc85b;cursor:pointer;flex:none;" title="勾选=执行该段，取消=跳过">` +
                            `<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">#${i + 1} &nbsp;${fmtTime(s.start)} → ${endTimeStr}</span>` +
                            `<span id="xzg-batch-seg-f-${i}" style="color:#7a9;flex:none;">${frameText}</span>` +
                            `<span id="xzg-batch-seg-s-${i}" style="color:#888;flex:none;">待执行</span>` +
                        `</label>` +
                    `</div>`;
                })
                .join("");
            overlay.querySelectorAll(".xzg-batch-seg-check").forEach((cb) => {
                cb.addEventListener("change", () => {
                    if (running || !segSelected) return;
                    const i = Number(cb.dataset.i);
                    if (i >= 0 && i < segments.length) { segSelected[i] = cb.checked; updateSelUI(); }
                });
            });
            $("xzg-batch-selbar").style.display = "flex";
            updateSelUI();
            const rangeNote = (winStart > 0 || winEnd > 0)
                ? `（裁剪范围 ${fmtTime(winStart)} → ${winEnd > 0 ? fmtTime(winEnd) : "片尾"}）`
                : "";
            ui.status(`检测到 ${cuts.length} 个切点，共 ${segments.length} 段${rangeNote}（可勾选只执行部分段）`);
        } catch (e) {
            ui.status(String(e.message || e), true);
        }
    };

    $("xzg-batch-run").onclick = async () => {
        if (running) return;
        if (!segments) { ui.status("请先自动探测视频切点", true); return; }
        const selArr = (segSelected || segments.map(() => true)).slice(); // 快照：运行中勾选不再生效
        if (!selArr.some(Boolean)) { ui.status("请先勾选要执行的片段（至少一段）", true); return; }
        running = true;
        session.isRunning = true;
        abortFlag.v = false;
        $("xzg-batch-run").disabled = true;
        setChecksEnabled(false); // 运行期间禁止改勾选，避免与快照不一致
        // 运行期间「关闭」按钮保持可点：点它=中断并关闭（不再置灰）
        try {
            const result = await runBatch(session.node, segments, ui, abortFlag, session, selArr);
            if (result.aborted) {
                ui.status("已中断任务", true);
            } else {
                const mergedArr = Array.isArray(result.merged) ? result.merged : [];
                const msg = mergedArr.length
                    ? `全部完成！已合并产出 ${mergedArr.length} 支视频：` +
                      mergedArr.map((f) => `output/${f.subfolder ? f.subfolder + "/" : ""}${f.filename}`).join("、") +
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
            if ((session.mergeIds || []).length) {
                try { await fetch(BUFFER_RESET_API, { method: "POST" }); } catch (_) { /* ignore */ }
            }
        } finally {
            running = false;
            session.isRunning = false;
            $("xzg-batch-run").disabled = false;
            setChecksEnabled(true);
            $("xzg-batch-close").style.cssText = "background:#5a2a2a;color:#faa;border:1px solid #744;" +
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
                            xzgBatchToast(`打开批处理对话框失败: ${e?.message || e}`);
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
