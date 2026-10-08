import { app } from '/scripts/app.js';
import { api } from '/scripts/api.js';


app.registerExtension({
    name: 'xiaozhuguang.pose-editor',
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== 'ComfyUIPoseSequenceEditor') return;
        const hideEditsWidget = node => {
            const widget = node.widgets?.find(w => w.name === 'edits_json');
            if (!widget) return;
            node.poseEditsWidget = widget;
            widget.origType ??= widget.type;
            widget.origComputeSize ??= widget.computeSize;
            widget.origSerializeValue ??= widget.serializeValue;
            widget.hidden = true;
            widget.type = 'converted-widget';
            widget.computeSize = () => [0, -4];
            const hideElement = () => { if (widget.element) widget.element.style.display = 'none'; };
            hideElement();
            requestAnimationFrame(hideElement);
            setTimeout(hideElement, 60);
        };
        const compactNode = node => {
            hideEditsWidget(node);
            node.setSize([Math.max(node.size[0], 360), node.computeSize()[1]]);
        };
        const updateButtons = node => {
            const hasPose = !!node.poseSession;
            const hasPoseInput = !!node.inputs?.some(input => input.name === 'pose_keypoint' && input.link != null);
            if (node.poseGetDataButton) node.poseGetDataButton.disabled = !hasPoseInput;
            if (node.poseOpenEditorButton) node.poseOpenEditorButton.disabled = !hasPose;
            if (node.poseClearDataButton) node.poseClearDataButton.disabled = !hasPose;
            app.graph.setDirtyCanvas(true, true);
        };
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            created?.apply(this, arguments);
            this.poseGetDataButton = this.addWidget('button', '获取姿势数据', null, () => {
                if (this.inputs?.some(input => input.name === 'pose_keypoint' && input.link != null)) runToNode(this);
            }, { serialize: false });
            this.poseGetDataButton.serialize = false;
            this.poseGetDataButton.draw = function (ctx, node, width, y, height) {
                const hasInput = !!node.inputs?.some(input => input.name === 'pose_keypoint' && input.link != null);
                drawActionButton(ctx, this, width, y, height, !hasInput ? 'disabled' : node.poseSession ? 'normal' : 'primary');
            };
            this.poseOpenEditorButton = this.addWidget('button', '打开姿势编辑器', null, () => {
                if (this.poseSession) openEditor(this);
            }, { serialize: false });
            this.poseOpenEditorButton.serialize = false;
            this.poseOpenEditorButton.draw = function (ctx, node, width, y, height) {
                drawActionButton(ctx, this, width, y, height, node.poseSession ? 'primary' : 'disabled');
            };
            this.poseClearDataButton = this.addWidget('button', '清除数据', null, () => {
                if (this.poseClearDataButton.disabled) return;
                const widget = this.poseEditsWidget;
                if (widget) { widget.value = '{"version":1,"operations":[]}'; widget.callback?.(widget.value); }
                this.poseSessionValidation = null;
                this.poseSession = null;
                if (this.properties) delete this.properties.xzg_pose_session;
                updateButtons(this);
                app.graph.setDirtyCanvas(true, true);
                showNotice('调整已清除。请执行一次工作流，再打开编辑器。');
            }, { serialize: false });
            this.poseClearDataButton.serialize = false;
            this.poseClearDataButton.draw = function (ctx, node, width, y, height) {
                const hasPose = !!node.poseSession;
                drawActionButton(ctx, this, width, y, height, hasPose ? 'normal' : 'disabled');
            };
            updateButtons(this);
            compactNode(this);
        };
        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            configured?.apply(this, arguments);
            compactNode(this);
            const restoredSession = this.properties?.xzg_pose_session || this.poseSession || null;
            this.poseSession = null;
            updateButtons(this);
            if (restoredSession) {
                const validation = {};
                this.poseSessionValidation = validation;
                api.fetchApi('/xiaozhuguang/pose/session/' + encodeURIComponent(restoredSession))
                    .then(response => {
                        if (this.poseSessionValidation !== validation) return;
                        if (response.ok) this.poseSession = restoredSession;
                        else if (response.status === 404 && this.properties) delete this.properties.xzg_pose_session;
                        updateButtons(this);
                    })
                    .catch(() => {
                        if (this.poseSessionValidation === validation) updateButtons(this);
                    });
            }
        };
        const connectionsChanged = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            connectionsChanged?.apply(this, arguments);
            updateButtons(this);
        };
        const resized = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            resized?.apply(this, arguments);
            const height = this.computeSize()[1];
            this.size[1] = height;
            if (size) size[1] = height;
        };
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            executed?.apply(this, arguments);
            this.poseSessionValidation = null;
            this.poseSession = message.pose_session?.[0] || null;
            this.properties ??= {};
            if (this.poseSession) this.properties.xzg_pose_session = this.poseSession;
            else delete this.properties.xzg_pose_session;
            updateButtons(this);
        };
    },
});

function drawActionButton(ctx, widget, width, y, height, state) {
    const disabled = state === 'disabled';
    ctx.fillStyle = disabled ? '#242424' : '#2a2a2a';
    ctx.strokeStyle = disabled ? '#333' : '#444';
    ctx.beginPath();
    ctx.rect(16, y + 1, width - 32, height - 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = state === 'primary' ? '#FFD700' : disabled ? '#555' : '#fff';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(widget.name, width / 2, y + height / 2);
}

function openEditor(node) {
    if (!node.poseSession) { showNotice('请先执行一次节点，加载 SDPOSE 骨骼序列。'); return; }
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'position:fixed;inset:0;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;border-radius:0;background:#10141b;';
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;';
    const url = new URL('/extensions/ComfyUI-xiaozhuguang/editor/index.html', location.origin);
    url.searchParams.set('session', node.poseSession);
    url.searchParams.set('api', api.apiURL('/xiaozhuguang/pose/session/'));
    iframe.src = url.href;
    dialog.append(iframe); document.body.append(dialog);
    const widget = node.poseEditsWidget;
    const listen = event => {
        if (event.origin !== location.origin || event.source !== iframe.contentWindow) return;
        if (event.data?.type === 'comfyui-pose:ready') {
            iframe.contentWindow.postMessage({ type: 'comfyui-pose:init', edits: widget?.value }, location.origin);
        }
        if (event.data?.type === 'comfyui-pose:save' && widget) {
            widget.value = JSON.stringify(event.data.edits);
            const fpsWidget = node.widgets.find(w => w.name === 'fps');
            if (fpsWidget && Number.isFinite(event.data.fps)) fpsWidget.value = event.data.fps;
            widget.callback?.(widget.value); app.graph.setDirtyCanvas(true, true);
            dialog.close();
        }
        if (event.data?.type === 'comfyui-pose:close') dialog.close();
    };
    window.addEventListener('message', listen);
    dialog.addEventListener('close', () => { window.removeEventListener('message', listen); dialog.remove(); }, { once: true });
    dialog.showModal();
}

async function runToNode(node) {
    const nodeId = String(node.id);
    const originalQueuePrompt = api.queuePrompt;
    const queuePromptForNode = async function (number, prompt, ...args) {
        if (!prompt?.output?.[nodeId]) {
            api.queuePrompt = originalQueuePrompt;
            throw new Error('当前工作流中找不到此节点');
        }
        const source = prompt.output;
        const downstream = new Map();
        const addConsumerLinks = (value, consumerId) => {
            if (!Array.isArray(value)) return;
            const upstreamId = value.length ? String(value[0]) : '';
            if (source[upstreamId]) {
                if (!downstream.has(upstreamId)) downstream.set(upstreamId, new Set());
                downstream.get(upstreamId).add(consumerId);
                return;
            }
            value.forEach(item => addConsumerLinks(item, consumerId));
        };
        for (const [consumerId, promptNode] of Object.entries(source)) {
            for (const value of Object.values(promptNode.inputs || {})) addConsumerLinks(value, String(consumerId));
        }
        const reachable = new Set([nodeId]);
        const queue = [nodeId];
        while (queue.length) {
            const currentId = queue.shift();
            for (const consumerId of downstream.get(currentId) || []) {
                if (reachable.has(consumerId)) continue;
                reachable.add(consumerId);
                queue.push(consumerId);
            }
        }
        const target = app.graph._nodes?.find(candidate =>
            reachable.has(String(candidate.id)) && candidate.constructor?.nodeData?.output_node && source[String(candidate.id)]
        );
        if (!target) {
            api.queuePrompt = originalQueuePrompt;
            throw new Error('请将 image 输出连接到下游输出节点，再执行；若惰性开关选择假分支，姿势编辑器会被跳过。');
        }
        const output = {};
        const visited = new Set();
        const addNode = id => {
            id = String(id);
            if (visited.has(id) || !source[id]) return;
            visited.add(id);
            output[id] = source[id];
            const visitInput = value => {
                if (!Array.isArray(value)) return;
                if (value.length && source[String(value[0])]) {
                    addNode(value[0]);
                    return;
                }
                value.forEach(visitInput);
            };
            Object.values(source[id].inputs || {}).forEach(visitInput);
        };
        addNode(String(target.id));
        prompt.output = output;
        api.queuePrompt = originalQueuePrompt;
        return originalQueuePrompt.call(api, number, prompt, ...args);
    };

    try {
        api.queuePrompt = queuePromptForNode;
        await app.queuePrompt(0);
    } catch (error) {
        showNotice(`获取姿势数据失败：${error.message}`);
    } finally {
        if (api.queuePrompt === queuePromptForNode) api.queuePrompt = originalQueuePrompt;
    }
}

function showNotice(message) {
    if (!document.getElementById('pose-notice-style')) {
        const style = document.createElement('style');
        style.id = 'pose-notice-style';
        style.textContent = `
            .pose-notice-overlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
            .pose-notice{min-width:280px;max-width:calc(100vw - 40px);overflow:hidden;border:1px solid rgba(255,255,255,.15);border-radius:10px;background:#1e1e1e;box-shadow:0 8px 32px rgba(0,0,0,.6);font:13px sans-serif;color:#aaa}
            .pose-notice-title{padding:14px 16px 8px;font-weight:600}
            .pose-notice-message{padding:0 16px 16px;line-height:1.6}
            .pose-notice-footer{display:flex;justify-content:flex-end;padding:0 16px 16px}
            .pose-notice button{height:30px;padding:0 16px;border:1px solid #555;border-radius:6px;background:#2a2a2a;color:#FFD700;font:inherit;cursor:pointer;outline:none;box-shadow:none}
            .pose-notice button:focus,.pose-notice button:focus-visible{outline:none;box-shadow:none}
            .pose-notice button:hover{background:#383838}
        `;
        document.head.appendChild(style);
    }
    const overlay = document.createElement('div');
    overlay.className = 'pose-notice-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pose-notice';
    const title = document.createElement('div');
    title.className = 'pose-notice-title';
    title.textContent = '小珠光提示';
    const body = document.createElement('div');
    body.className = 'pose-notice-message';
    body.textContent = message;
    const footer = document.createElement('div');
    footer.className = 'pose-notice-footer';
    const button = document.createElement('button');
    button.textContent = '知道了';
    footer.append(button);
    dialog.append(title, body, footer);
    overlay.append(dialog);
    const close = () => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
    };
    const onKey = event => {
        if (event.key === 'Escape' || event.key === 'Enter') {
            event.preventDefault();
            close();
        }
    };
    button.addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    button.focus();
}
