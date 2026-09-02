/**
 * xzg_node_tools.js —— 内部工具（无菜单入口，仅快捷键）
 *
 * 快捷键：
 *   Ctrl + Alt + Shift + K —— 管理面板
 *   Ctrl + Alt + Shift + L —— 节点整理
 */
import { app } from '/scripts/app.js';

const SERVER = 'lg_local';
const LOCK_TYPE = 'LG_Lock_Local';
const API = {
    read: `/${SERVER}/readauth`,
    update: `/${SERVER}/updateauth`,
    machineId: `/${SERVER}/getmachineid`,
};
const DAY_MS = 24 * 60 * 60 * 1000;

/* ───────────── 基础工具 ───────────── */

function getLockNodes() {
    return (app.graph?._nodes || []).filter((n) => n.type === LOCK_TYPE);
}

function getHiddenWidget(node) {
    return (node.widgets || []).find((w) => (w.name || '').toLowerCase() === 'hiddenjson');
}

function getAdminPassword() {
    try {
        const s = window.__xzgTools?.adminSecret?.();
        if (s) return s;
    } catch (e) { /* 忽略 */ }
    return prompt('请输入管理员密码：') || '';
}

async function postJSON(url, body) {
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return resp.json();
}

function toast(msg, ok = true) {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
        position: 'fixed', left: '50%', bottom: '60px', transform: 'translateX(-50%)',
        padding: '10px 18px', borderRadius: '8px', zIndex: 99999,
        background: ok ? 'rgba(40,140,80,0.95)' : 'rgba(180,50,50,0.95)',
        color: '#fff', fontSize: '13px', boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}

function fmtEndTime(ms) {
    if (!ms || ms <= 0) return '永久';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shortId(id) {
    return id && id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-4) : (id || '');
}

/* ───────────── 节点操作 ───────────── */

// ── 数据解析兜底 ──
// 现象:不同版本保存的工作流里,数据存放位置不一致:
//      新版: widgets_values[2] 与 properties.hiddenJson 都有;
//      旧版: 仅 properties.hiddenJson(控件值加载后为空/被 widgets_values 错位污染)。
//      面板直接把控件值发给后端 -> 后端报"解析失败，数据格式不正确"。
// 修复:发请求前解析有效数据 —— 控件值带特征前缀则直接用;
//      否则按 properties.hiddenJson / originalHiddenJson 兜底,并回写控件值,
//      保证更新返回新数据后保存/重载的往返一致。
// 特征前缀用 unicode 转义存储,不在源码落明文。
const DATA_PREFIX = '\u0067AAAAA\u0042';
function looksLikeCipher(v) {
    return typeof v === 'string' && v.length > 100 && new RegExp('^' + DATA_PREFIX).test(v);
}

function resolveCipher(row) {
    if (looksLikeCipher(row.widget.value)) return row.widget.value;
    const props = row.node.properties || {};
    for (const k of ['hiddenJson', 'originalHiddenJson']) {
        if (looksLikeCipher(props[k])) {
            try { row.widget.value = props[k]; } catch (e) { /* 忽略 */ }
            return props[k];
        }
    }
    return typeof row.widget.value === 'string' ? row.widget.value : '';
}

// 对单个目标节点调用更新接口并回写新数据。
// ── 大负载校验失败防护(实测根因) ──
// 后端重建数据时,大负载(数据 >10 万字符,即复杂工作流)约有 50% 概率
// 产出无法解析的损坏数据(随机性,同一输入多次结果不同)。若直接写回控件并保存,
// 该工作流将永久损坏(数据无法解析,只能重新整理)。
// 防护:更新成功后立即重新读取验证新数据;验证不通过则用上一次的好数据
// 重新提交同一更新(最多 10 次,每次处理随机性独立,实测 2~3 次内必成功)。
// 只有验证通过的新数据才写回控件与 properties。
const UPDATE_MAX_RETRY = 10;
const RETRY_DELAY_MS = 150;

function isParseFailMsg(msg) {
    return typeof msg === 'string' && (msg.indexOf('解析失败') >= 0 || msg.indexOf('格式不正确') >= 0);
}

async function updateNode(row, body, opts = {}) {
    const silent = !!opts.silent; // 静默模式:不弹提示(模式切换等轻量操作用)
    try {
        const goodCipher = resolveCipher(row);
        let res = null;
        for (let attempt = 1; attempt <= UPDATE_MAX_RETRY; attempt++) {
            res = await postJSON(API.update, {
                hiddenJson: goodCipher,
                adminPassword: row.pwd,
                ...body,
            });
            if (!res.success) {
                // 业务错误(密码错误等)不重试;解析类失败可能偶发,允许换次机会
                if (isParseFailMsg(res.msg) && attempt < UPDATE_MAX_RETRY) {
                    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
                    continue;
                }
                if (!silent) toast(`节点 #${row.node.id}：${res.msg || '更新失败'}`, false);
                return null;
            }
            const candidate = res.new_execEncryptText;
            // 验证新数据可解析,才允许写回
            const check = await postJSON(API.read, { hiddenJson: candidate, adminPassword: row.pwd });
            if (check.success) break;
            if (attempt >= UPDATE_MAX_RETRY) {
                if (!silent) toast(`节点 #${row.node.id}：后端多次重建数据均校验失败(大负载竞态),已放弃本次修改,原数据未改动`, false);
                console.error('[xzg] update 新数据验证失败(已重试)', { attempts: attempt, len: candidate && candidate.length });
                return null;
            }
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
        const verified = res.new_execEncryptText;
        row.widget.value = verified;
        try { if (row.node.properties) row.node.properties.hiddenJson = verified; } catch (e) { /* 忽略 */ }
        row.node.setDirtyCanvas?.(true, true);
        app.graph?.change?.();
        return res;
    } catch (err) {
        if (!silent) toast(`节点 #${row.node.id} 请求异常：${err}`, false);
        return null;
    }
}

// 重新读取节点状态
async function readNode(row) {
    try {
        return await postJSON(API.read, { hiddenJson: resolveCipher(row), adminPassword: row.pwd });
    } catch (err) {
        return { success: false, msg: String(err) };
    }
}

/* ───────────── 管理面板 ───────────── */

async function showAuthDialog() {
    const nodes = getLockNodes();
    if (!nodes.length) {
        alert('当前画布没有找到目标节点');
        return;
    }
    const pwd = getAdminPassword();
    if (!pwd) return;

    let myMachineId = '';
    try {
        const r = await fetch(API.machineId).then((r) => r.json());
        if (r.success) myMachineId = r.machine_id || '';
    } catch (e) { /* 忽略 */ }

    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
        position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.5)', zIndex: 99998,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
    });
    const dlg = document.createElement('div');
    Object.assign(dlg.style, {
        background: '#2b2b2b', color: '#ddd', borderRadius: '10px',
        padding: '18px', width: '540px', maxHeight: '78vh', overflowY: 'auto',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)', fontFamily: 'sans-serif', fontSize: '13px',
    });
    dlg.innerHTML = `
        <div style="font-size:15px;font-weight:bold;">🔒 节点管理</div>
        <div style="color:#999;margin:4px 0 10px;">
            设置保存在每个工作流自己的内部数据内，互相独立。
            ${myMachineId ? `本机设备码：<span style="color:#8ab4f8;user-select:all;">${shortId(myMachineId)}</span>` : ''}
        </div>
        <div id="xzg-auth-rows"></div>
        <div style="display:flex;justify-content:flex-end;margin-top:10px;">
            <button id="xzg-auth-close" style="padding:6px 16px;border:1px solid #666;border-radius:6px;background:#3a3a3a;color:#ddd;cursor:pointer;">关闭</button>
        </div>`;
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);
    dlg.querySelector('#xzg-auth-close').onclick = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const rowsBox = dlg.querySelector('#xzg-auth-rows');
    for (const node of nodes) {
        const widget = getHiddenWidget(node);
        if (!widget || !widget.value) continue;
        const row = { node, widget, pwd, box: null };
        const box = document.createElement('div');
        Object.assign(box.style, {
            border: '1px solid #444', borderRadius: '8px', padding: '10px', marginBottom: '10px',
        });
        rowsBox.appendChild(box);
        row.box = box;
        await renderRow(row, myMachineId);
    }
}

// 渲染单个节点的管理区（每次操作后整行刷新）
async function renderRow(row, myMachineId) {
    const box = row.box;
    box.innerHTML = '';

    const res = await readNode(row);
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;margin-bottom:6px;';
    title.textContent = `节点 #${row.node.id} ${row.node.title || LOCK_TYPE}`;
    box.appendChild(title);

    const status = document.createElement('div');
    status.style.cssText = 'margin-bottom:8px;';
    box.appendChild(status);

    if (!res.success) {
        status.textContent = `读取失败：${res.msg || '未知错误'}`;
        // 区分"数据损坏"与一般错误:数据损坏无法解析,只能重新整理节点组
        if (isParseFailMsg(res.msg)) {
            status.textContent += ' —— 数据已损坏，无法解析，请对该节点组重新整理（旧数据不可恢复）';
        }
        status.style.color = '#e07070';
        return;
    }

    const noBind = !!res.no_machine_bind;
    const machines = res.authorized_machines || [];

    // ── 模式开关 ──
    const toggleLine = document.createElement('label');
    toggleLine.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px;';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = noBind;
    toggleLine.appendChild(checkbox);
    const modeText = document.createElement('span');
    modeText.textContent = ' 不绑定设备（云服务可用，安全性下降）';
    modeText.style.color = noBind ? '#e8b34b' : '#ddd';
    toggleLine.appendChild(modeText);
    box.appendChild(toggleLine);

    if (noBind) {
        const exp = res.no_bind_endTime ? `，有效期至 ${fmtEndTime(res.no_bind_endTime)}` : '';
        status.textContent = `当前模式：不绑定设备（任何设备可运行${exp}）`;
        status.style.color = '#e8b34b';
    } else {
        status.textContent = `当前模式：绑定设备（已授权 ${machines.length} 台设备）`;
        status.style.color = '#6fbf73';
    }

    // ── 设备授权管理（仅绑定设备模式显示） ──
    if (!noBind) {
    const machineSection = document.createElement('div');

    const listBox = document.createElement('div');
    listBox.style.cssText = 'border:1px solid #3a3a3a;border-radius:6px;padding:6px 8px;margin-bottom:8px;max-height:140px;overflow-y:auto;';
    if (!machines.length) {
        listBox.innerHTML = '<div style="color:#888;">（暂无授权设备）</div>';
    }
    for (const m of machines) {
        const line = document.createElement('div');
        line.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 0;';
        let mid, end;
        if (typeof m === 'string') {
            if (m.includes(':')) { const p = m.split(':', 1); mid = p[0]; end = '永久'; }
            else { mid = m; end = '永久'; }
        } else {
            mid = m.machineId; end = fmtEndTime(m.endTime || 0);
        }
        const info = document.createElement('span');
        info.textContent = `${shortId(mid)}　有效期至：${end}`;
        info.style.cssText = 'color:#bbb;user-select:all;';
        const btn = document.createElement('button');
        btn.textContent = '移除';
        btn.style.cssText = 'padding:2px 10px;border:none;border-radius:4px;background:#7a3a3a;color:#fff;cursor:pointer;';
        btn.onclick = async () => {
            if (!confirm(`确定移除设备 ${shortId(mid)} 的授权？`)) return;
            const r = await updateNode(row, { new_machines: [{ machineId: mid }], is_remove: true });
            if (r) { toast(`节点 #${row.node.id}：${r.msg}`, true); await renderRow(row, myMachineId); }
        };
        line.appendChild(info);
        line.appendChild(btn);
        listBox.appendChild(line);
    }
    machineSection.appendChild(listBox);

    // 添加设备（设备码 + 有效天数；相同设备码重复添加 = 更新有效期）
    const addLine = document.createElement('div');
    addLine.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
    const idInput = document.createElement('input');
    idInput.placeholder = '设备码';
    idInput.style.cssText = 'flex:1 1 150px;min-width:140px;background:#1e1e1e;color:#ddd;border:1px solid #555;border-radius:4px;padding:3px 6px;';
    const daysInput = document.createElement('input');
    daysInput.type = 'number'; daysInput.min = '0'; daysInput.value = '0';
    daysInput.title = '有效天数，0=永久';
    daysInput.style.cssText = 'width:64px;background:#1e1e1e;color:#ddd;border:1px solid #555;border-radius:4px;padding:3px 6px;';
    const daysLabel = document.createElement('span');
    daysLabel.textContent = '天';
    daysLabel.style.color = '#999';
    const addBtn = document.createElement('button');
    addBtn.textContent = '添加/更新设备';
    addBtn.title = '设备码已存在时会更新其有效期';
    addBtn.style.cssText = 'padding:3px 12px;border:none;border-radius:4px;background:#3a7bd5;color:#fff;cursor:pointer;';
    const meBtn = document.createElement('button');
    meBtn.textContent = '填入本机';
    meBtn.style.cssText = 'padding:3px 10px;border:1px solid #666;border-radius:4px;background:#3a3a3a;color:#ddd;cursor:pointer;';
    if (!myMachineId) meBtn.disabled = true;
    meBtn.onclick = () => { idInput.value = myMachineId; };
    addBtn.onclick = async () => {
        const mid = idInput.value.trim();
        if (!mid) { alert('请输入设备码'); return; }
        const days = Math.max(0, parseInt(daysInput.value, 10) || 0);
        const now = Date.now();
        const entry = days > 0
            ? { machineId: mid, startTime: now, endTime: now + days * DAY_MS }
            : { machineId: mid, startTime: 0, endTime: 0 };
        const r = await updateNode(row, { new_machines: [entry], is_remove: false });
        if (r) { toast(`节点 #${row.node.id}：${r.msg}`, true); await renderRow(row, myMachineId); }
    };
    addLine.appendChild(idInput);
    addLine.appendChild(daysInput);
    addLine.appendChild(daysLabel);
    addLine.appendChild(addBtn);
    addLine.appendChild(meBtn);
    machineSection.appendChild(addLine);
    box.appendChild(machineSection);
    } // end if (!noBind)

    // ── 有效期（天）：仅不绑定机器模式（专用字段，到期后任何设备都无法运行） ──
    if (noBind) {
        const expiryLine = document.createElement('div');
        expiryLine.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px;';
        const expInput = document.createElement('input');
        expInput.type = 'number'; expInput.min = '0'; expInput.value = '0';
        expInput.style.cssText = 'width:64px;background:#1e1e1e;color:#ddd;border:1px solid #555;border-radius:4px;padding:3px 6px;';
        const expBtn = document.createElement('button');
        expBtn.textContent = '设置有效期';
        expBtn.style.cssText = 'padding:3px 12px;border:none;border-radius:4px;background:#3a7bd5;color:#fff;cursor:pointer;';
        const expHint = document.createElement('span');
        expHint.textContent = '天，0=永久（到期后任何设备都无法运行）';
        expHint.style.color = '#999';
        expBtn.onclick = async () => {
            const days = Math.max(0, parseInt(expInput.value, 10) || 0);
            const r = await updateNode(row, { new_machines: [], expiry_days: days });
            if (r) { toast(`节点 #${row.node.id}：${r.msg}`, true); await renderRow(row, myMachineId); }
        };
        expiryLine.appendChild(expInput);
        expiryLine.appendChild(expHint);
        expiryLine.appendChild(expBtn);
        box.appendChild(expiryLine);
    }

    // ── 模式切换（直接切换，不弹确认框、无提示，行内状态文本即时更新） ──
    checkbox.addEventListener('change', async () => {
        const want = checkbox.checked;
        const r = await updateNode(row, { new_machines: [], no_machine_bind: want }, { silent: true });
        if (r) await renderRow(row, myMachineId);
    });
}

/* ───────────── 快捷键动作 ───────────── */

// 节点整理：与画布「节点组（本地）」入口等价的快捷方式
async function encryptSelectedNodes() {
    const tools = window.__xzgTools;
    if (!tools || typeof tools.addHiddenNode !== 'function') {
        alert('步骤1失败：工具未就绪（window.__xzgTools 不可用）');
        return;
    }
    // 注意: addHiddenNode 期望节点对象数组(内部读取 node.pos/widgets 等),
    // 必须用 Object.values 而不是 Object.keys
    const nodes = Object.values(app.canvas.selected_nodes ?? {});
    if (nodes.length < 2) {
        alert('步骤2失败：请先框选至少两个节点');
        return;
    }
    // 密码：优先取会话内已保存的；没有则直接输入。
    // 不依赖核心的设置对话框(其回读不稳定)——addHiddenNode 内部会自行保存传入的密码。
    let secret = tools.adminSecret?.() || '';
    if (!secret) {
        secret = prompt('请输入密码：') || '';
        if (!secret) {
            toast('已取消', false);
            return;
        }
    }
    try {
        const result = await tools.addHiddenNode(nodes, secret, 0);
        if (result === false) {
            // 仅失败时提示, 成功完全静默
            alert('步骤5失败：整理流程返回 false（详见控制台）');
        }
    } catch (err) {
        console.error('[xzg] op failed:', err);
        alert('步骤6失败：' + (err?.message || err));
    }
}

/* ───────────── 快捷键注册 ───────────── */

// 静默加载标记：无任何功能信息
console.log('[xzg] ready');

// 快捷键（capture 阶段拦截，避免被画布吞掉）
window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.altKey || !e.shiftKey || e.metaKey) return;
    if (e.code === 'KeyK') {
        e.preventDefault();
        e.stopPropagation();
        showAuthDialog();
    } else if (e.code === 'KeyL') {
        e.preventDefault();
        e.stopPropagation();
        encryptSelectedNodes();
    }
}, true);
