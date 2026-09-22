// 拼音搜索库体积较大，仅在收藏器/工作流搜索实际需要时加载。
// 统一单例可避免两个模块同时请求并重复初始化。
let _pinyin = window.pinyinPro?.pinyin || null;
let _loading = null;
let _idleScheduled = false;

export function getPinyin() {
    return _pinyin;
}

export function ensurePinyin() {
    if (_pinyin) return Promise.resolve(_pinyin);
    if (!_loading) {
        _loading = import("./pinyin-pro.esm.js")
            .then(({ pinyin }) => {
                _pinyin = pinyin;
                window.pinyinPro = { ...(window.pinyinPro || {}), pinyin };
                return pinyin;
            })
            .catch((error) => {
                _loading = null;
                throw error;
            });
    }
    return _loading;
}

// 不阻塞 ComfyUI 首屏：浏览器空闲后预热，常规使用时搜索不会感觉到首次加载。
export function warmupPinyinWhenIdle() {
    if (_idleScheduled || _pinyin) return;
    _idleScheduled = true;
    const load = () => { ensurePinyin().catch(() => {}); };
    if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(load, { timeout: 2000 });
    } else {
        setTimeout(load, 800);
    }
}
