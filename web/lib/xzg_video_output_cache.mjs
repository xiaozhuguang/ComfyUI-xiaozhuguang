const SAVE_TYPES = new Set(["XiaozhuguangVideoCombine", "XiaozhuguangVideoSaveDaVinci"]);

export function createVideoOutputCache(storage = globalThis.localStorage) {
    const outputs = new Map();
    const jobs = new Map();
    const subscribers = new Map();
    const graphKeys = new WeakMap();
    const early = new Map();
    const received = new Map();
    let sequence = 0;
    let eventSequence = 0;
    let queuing = 0;
    let installed = false;

    function identity(graph) {
        if (!graph) return "";
        if (graph.id) return `workflow:${graph.id}`;
        // 老工作流没有 UUID 时仅在当前图实例内恢复，不能按节点结构猜归属。
        if (!graphKeys.has(graph)) graphKeys.set(graph, `session:${++sequence}`);
        return graphKeys.get(graph);
    }

    const key = (owner, nodeId) => JSON.stringify([owner, String(nodeId)]);
    const storeKey = (outputKey) => `xzg_video_output_v2:${outputKey}`;

    function receive(detail, order = ++eventSequence) {
        if (!detail?.output || detail.prompt_id == null) return;
        const promptId = String(detail.prompt_id);
        const job = jobs.get(promptId);
        if (!job) {
            // WebSocket 可能先于 /prompt 的响应返回，只暂存正在提交期间的事件。
            if (queuing) {
                if (!early.has(promptId)) early.set(promptId, []);
                early.get(promptId).push({ detail, order });
            }
            return;
        }
        const nodeId = [detail.node, detail.display_node]
            .filter(id => id != null).map(String).find(id => job.ids.has(id));
        if (!nodeId) return;
        const ui = detail.output.ui || detail.output;
        const info = (ui.videos || ui.video)?.[0];
        if (!info?.filename) return;
        const outputKey = key(job.owner, nodeId);
        if ((received.get(outputKey) || 0) > order) return;
        received.set(outputKey, order);
        const saved = { ...info, type: info.type || "output", subfolder: info.subfolder || "" };
        outputs.set(outputKey, saved);
        if (job.owner.startsWith("workflow:")) {
            try { storage?.setItem(storeKey(outputKey), JSON.stringify(saved)); } catch {}
        }
        for (const [node, apply] of subscribers) {
            if (identity(node.graph) === job.owner && String(node.id) === nodeId) apply(detail.output);
        }
    }

    return {
        get(graph, nodeId) {
            const owner = identity(graph);
            if (!owner) return null;
            const outputKey = key(owner, nodeId);
            if (outputs.has(outputKey)) return outputs.get(outputKey);
            if (!owner.startsWith("workflow:")) return null;
            try { return JSON.parse(storage?.getItem(storeKey(outputKey)) || "null"); } catch { return null; }
        },
        subscribe(node, apply) {
            subscribers.set(node, apply);
            return () => subscribers.delete(node);
        },
        install(api, app) {
            if (installed) return;
            installed = true;
            const original = api.queuePrompt;
            api.queuePrompt = async function (index, prompt, ...rest) {
                const graph = app.graph;
                const owner = prompt?.workflow?.id ? `workflow:${prompt.workflow.id}` : identity(graph);
                const ids = new Set(Object.entries(prompt?.output || {})
                    .filter(([, value]) => SAVE_TYPES.has(value.class_type)).map(([id]) => id));
                queuing++;
                try {
                    const result = await original.call(this, index, prompt, ...rest);
                    if (result?.prompt_id != null && owner && ids.size) {
                        const promptId = String(result.prompt_id);
                        jobs.set(promptId, { owner, ids });
                        for (const item of early.get(promptId) || []) receive(item.detail, item.order);
                        early.delete(promptId);
                    }
                    return result;
                } finally {
                    if (--queuing === 0) early.clear();
                }
            };
            api.addEventListener("executed", (event) => receive(event.detail));
            for (const type of ["execution_success", "execution_error", "execution_interrupted"]) {
                api.addEventListener(type, (event) => jobs.delete(String(event.detail?.prompt_id)));
            }
        },
    };
}
