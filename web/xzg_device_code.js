// -*- coding: utf-8 -*-
/**
 * xzg_device_code.js —— 「设置 → xiaozhuguang → 其他」中的本机设备码查询
 *
 * 用途:
 *   需要授权的用户打开 ComfyUI 左下角「设置」→ xiaozhuguang 分类 →
 *   「本机设备码」，点击「获取」即可查询并复制本机设备码，
 *   发送给工作流作者完成设备授权。
 *
 * 说明:
 *   - 仅读取设备标识（只读），不涉及任何修改操作，无需任何密码。
 *   - 独立成单文件，不与其它内部工具耦合，可随插件公开分发。
 */

const ENDPOINT = '/lg_local/getmachineid';

async function fetchDeviceCode() {
    const resp = await fetch(ENDPOINT);
    const data = await resp.json();
    if (data && data.success && data.machine_id) {
        return { ok: true, code: data.machine_id };
    }
    return { ok: false, msg: (data && data.msg) || '未知错误' };
}

function buildWidget() {
    const wrap = document.createElement('div');
    wrap.style.cssText =
        'display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;';

    // 设备码显示区（等宽字体、可选中，方便手动复制）
    const codeEl = document.createElement('span');
    codeEl.style.cssText =
        'font-family:ui-monospace,Consolas,monospace;font-size:12px;user-select:all;' +
        'word-break:break-all;max-width:340px;color:var(--fg-color,#ccc);line-height:1.4;';

    // 获取按钮
    const getBtn = document.createElement('button');
    getBtn.type = 'button';
    getBtn.textContent = '获取';
    getBtn.style.cssText =
        'padding:4px 14px;border:none;border-radius:6px;background:#3a7bd5;color:#fff;' +
        'cursor:pointer;font-size:12px;white-space:nowrap;';

    // 复制按钮（查询成功后才显示）
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = '复制';
    copyBtn.disabled = true;
    copyBtn.style.cssText =
        'padding:4px 14px;border:1px solid #666;border-radius:6px;background:transparent;' +
        'color:inherit;cursor:pointer;font-size:12px;white-space:nowrap;display:none;';

    getBtn.onclick = async () => {
        getBtn.disabled = true;
        getBtn.textContent = '查询中…';
        codeEl.textContent = '';
        copyBtn.style.display = 'none';
        try {
            const r = await fetchDeviceCode();
            if (r.ok) {
                codeEl.textContent = r.code;
                copyBtn.style.display = '';
                copyBtn.disabled = false;
            } else {
                // 常见失败：后端组件依赖缺失（如 Windows 缺 wmi / pywin32），直接展示后端提示
                codeEl.textContent = '获取失败：' + r.msg;
            }
        } catch (err) {
            codeEl.textContent = '获取失败：' + (err?.message || err);
        } finally {
            getBtn.disabled = false;
            getBtn.textContent = '重新获取';
        }
    };

    copyBtn.onclick = async () => {
        try {
            await navigator.clipboard.writeText(codeEl.textContent);
            copyBtn.textContent = '已复制';
            setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
        } catch (err) {
            // 剪贴板不可用（非安全上下文等）时兜底：选中文本让用户 Ctrl+C
            const range = document.createRange();
            range.selectNodeContents(codeEl);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    };

    wrap.appendChild(codeEl);
    wrap.appendChild(getBtn);
    wrap.appendChild(copyBtn);
    return wrap;
}

function injectDeviceCodeSetting() {
    if (document.getElementById('xzg-device-code-setting')) return true;

    // 将设备码控件放入 xzg_shortcuts.js 创建的“小珠光 → 其他”区域，
    // 避免以 setting ID 单独生成另一个“其他”分类。
    const shortcutSetting = document.getElementById('xzg-shortcuts-setting-btn');
    if (!shortcutSetting?.parentNode) return false;

    const wrapper = document.createElement('div');
    wrapper.className = 'setting-item mb-3';
    wrapper.id = 'xzg-device-code-setting';
    wrapper.innerHTML = `
        <div class="flex min-h-8 flex-row items-center gap-2">
            <div class="form-label flex grow items-center">
                <span class="text-sm text-muted">[小珠光] 本机设备码</span>
            </div>
            <div class="form-input flex justify-end"></div>
        </div>
    `;
    wrapper.querySelector('.form-input').appendChild(buildWidget());
    shortcutSetting.parentNode.insertBefore(wrapper, shortcutSetting);
    return true;
}

const deviceCodeObserver = new MutationObserver(() => {
    // ComfyUI 关闭设置窗口时会销毁其内容 DOM；保留观察器，
    // 下次打开并重建“小珠光 → 其他”区域后重新插入设备码控件。
    injectDeviceCodeSetting();
});
deviceCodeObserver.observe(document.body, { childList: true, subtree: true });
injectDeviceCodeSetting();
