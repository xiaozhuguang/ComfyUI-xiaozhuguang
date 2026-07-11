
window.XZGThemeManager = {
    currentNodes: [],
    styleElement: null,
    panelStyleElement: null,
    canvasHooked: false,
    protoRefs: {},
    linkHighlightActive: false,
    linkHighlightHooked: false,
    linkLaserActive: false,
    laserAnimType: 'flow',
    linkColorActive: false,
    linkColor: '#888888',
    linkAnimRunning: false,
    linkAnimFrameId: null,
    linkHighlightDimAlpha: 0.3,
    wallpaperActive: false,
    wallpaperType: 'image',
    wallpaperData: null,
    wallpaperOpacity: 0.5,
    wallpaperFit: 'cover',
    _wallpaperEl: null,
    _wallpaperVideoEl: null,
    _wpDB: null,
    _wpDBReady: false,
    _wpPendingSave: null,

    init() {
        // 从 localStorage 恢复连线高亮和激光动画状态
        try {
            const saved = localStorage.getItem('xzg-link-highlight');
            if (saved === 'true') {
                this.linkHighlightActive = true;
            }
            // 连线动画功能已取消，强制关闭
            // const laserSaved = localStorage.getItem('xzg-link-laser');
            // if (laserSaved === 'true') {
            //     this.linkLaserActive = true;
            // }
            this.linkLaserActive = false;
            const laserColorSaved = localStorage.getItem('xzg-laser-color');
            if (laserColorSaved) {
                // 兼容旧数据：将旧的 laserColor 迁移到 linkColor
                try { localStorage.setItem('xzg-link-color', laserColorSaved); } catch(e) {}
                localStorage.removeItem('xzg-laser-color');
            }
            // const animTypeSaved = localStorage.getItem('xzg-laser-anim-type');
            // if (animTypeSaved) {
            //     this.laserAnimType = animTypeSaved;
            // }
            const lcSaved = localStorage.getItem('xzg-link-color');
            if (lcSaved) {
                this.linkColor = lcSaved;
            }
            // 连线颜色功能已取消，强制关闭
            // const lcActiveSaved = localStorage.getItem('xzg-link-color-active');
            // if (lcActiveSaved === 'true') {
            //     this.linkColorActive = true;
            // }
            this.linkColorActive = false;
        } catch(e) {}

        // 从 localStorage 恢复壁纸设置（小数据）
        try {
            const wpActive = localStorage.getItem('xzg-wallpaper-active');
            if (wpActive === 'true') {
                this.wallpaperActive = true;
            }
            const wpType = localStorage.getItem('xzg-wallpaper-type');
            if (wpType) {
                this.wallpaperType = wpType;
            }
            const wpData = localStorage.getItem('xzg-wallpaper-data');
            if (wpData) {
                this.wallpaperData = wpData;
            }
            const wpOpacity = localStorage.getItem('xzg-wallpaper-opacity');
            if (wpOpacity) {
                this.wallpaperOpacity = parseFloat(wpOpacity);
            }
            const wpFit = localStorage.getItem('xzg-wallpaper-fit');
            if (wpFit) {
                this.wallpaperFit = wpFit;
            }
        } catch(e) {}

        this.injectPanelStyles();
        this.setupContextMenu();
        this.ensureCanvasHook();
        this.hookSerialize();
        this._initWallpaperDB();
        this.initWallpaper();
    },

    injectPanelStyles() {
        if (document.getElementById("xzg-theme-panel-style")) return;
        
        const css = `
.xzg-theme-panel {
    position: fixed;
    z-index: 99999;
    width: 280px;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif;
    color: #ddd;
    display: none;
    overflow: hidden;
}

.xzg-theme-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 7px 12px;
    background: #2a2a2a;
    border-bottom: 1px solid #444;
    color: #ddd;
    font-size: 14px;
    font-weight: bold;
}

.xzg-theme-title {
    font-size: 13px;
}

.xzg-theme-header-btns {
    display: flex;
    align-items: center;
    gap: 5px;
}

.xzg-theme-shortcut-btn {
    background: rgba(255, 255, 255, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.3);
    color: #fff;
    font-size: 10px;
    font-weight: bold;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    min-width: 70px;
    text-align: center;
    transition: all 0.2s;
}

.xzg-theme-shortcut-btn:hover {
    background: rgba(255, 255, 255, 0.3);
    transform: scale(1.05);
}

.xzg-theme-close {
    background: none;
    border: none;
    color: #999;
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    opacity: 0.8;
    transition: opacity 0.2s;
}

.xzg-theme-close:hover {
    opacity: 1;
}

.xzg-top-tabs {
    display: flex;
    background: #1e1e1e;
    border-bottom: 2px solid #333;
    position: relative;
}

.xzg-top-tab {
    flex: 1;
    padding: 8px 0;
    background: none;
    border: none;
    color: #888;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    position: relative;
    letter-spacing: 1px;
}

.xzg-top-tab:hover {
    color: #ccc;
    background: rgba(255, 255, 255, 0.03);
}

.xzg-top-tab.active {
    color: #FFD700;
    font-weight: bold;
    text-shadow: 0 0 8px rgba(255, 215, 0, 0.4);
}

.xzg-top-tab.active::after {
    content: '';
    position: absolute;
    bottom: -2px;
    left: 15%;
    width: 70%;
    height: 2px;
    background: #FFD700;
    box-shadow: 0 0 6px rgba(255, 215, 0, 0.6);
    border-radius: 2px 2px 0 0;
}

.xzg-tab-content {
    box-sizing: border-box;
}

.xzg-tab-content[data-tab-content="menuhide"] {
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.xzg-theme-content {
    padding: 9px;
    max-height: 500px;
    overflow-y: auto;
}

.xzg-theme-section {
    margin-bottom: 9px;
}

.xzg-theme-section:last-child {
    margin-bottom: 0;
}

.xzg-theme-section-title {
    font-size: 12px;
    color: #888;
    margin-bottom: 5px;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.xzg-theme-preview {
    width: 100%;
    height: 40px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 9px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.xzg-preview-text {
    font-size: 12px;
    font-weight: bold;
    color: #fff;
}

.xzg-theme-color-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    margin-bottom: 5px;
}

.xzg-theme-label {
    font-size: 12px;
    color: #aaa;
    min-width: 60px;
}

.xzg-theme-color-row input[type="color"] {
    width: 50px;
    height: 28px;
    border: 1px solid #555;
    border-radius: 4px;
    cursor: pointer;
    background: #333;
    padding: 0;
}

.xzg-theme-direction-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    margin-bottom: 6px;
    margin-top: 0;
}

.xzg-direction-buttons {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
}

.xzg-dir-btn {
    width: 24px;
    height: 22px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #333;
    color: #aaa;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
}

.xzg-dir-btn:hover {
    background: #444;
    color: #fff;
}

.xzg-dir-btn.active {
    background: #333;
    border-color: #fff;
    color: #fff;
}

.xzg-theme-separator {
    height: 1px;
    background: #444;
    margin: 6px 0;
}

.xzg-theme-font-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    margin-top: 0;
    margin-bottom: 6px;
}

.xzg-font-size-control {
    display: flex;
    align-items: center;
    gap: 3px;
}

.xzg-font-btn {
    width: 28px;
    height: 22px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #333;
    color: #aaa;
    cursor: pointer;
    font-size: 11px;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
}

.xzg-font-btn:hover {
    background: #444;
    color: #fff;
}

.xzg-font-btn:active {
    transform: scale(0.95);
}

.xzg-font-size-value {
    min-width: 30px;
    text-align: center;
    font-size: 12px;
    color: #ccc;
}

.xzg-align-buttons {
    display: flex;
    gap: 4px;
}

.xzg-align-btn {
    width: 32px;
    height: 22px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #333;
    color: #aaa;
    cursor: pointer;
    font-size: 11px;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
}

.xzg-align-btn:hover {
    background: #444;
    color: #fff;
}

.xzg-align-btn.active {
    background: #333;
    border-color: #fff;
    color: #fff;
}

.xzg-apply-btn {
    width: 100%;
    padding: 7px 16px;
    background: #333;
    color: #FFD700;
    border: 1px solid #555;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: bold;
    text-shadow: 0 0 8px rgba(255, 215, 0, 0.6);
    transition: all 0.2s;
    margin-top: 0;
    margin-bottom: 6px;
}

.xzg-apply-btn:hover {
    background: #444;
}

.xzg-apply-btn:active {
    transform: translateY(0);
}

.xzg-reset-btn {
    width: 100%;
    padding: 5px 16px;
    background: #444;
    color: #ccc;
    border: 1px solid #555;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
    margin-top: 0;
    margin-bottom: 6px;
}

.xzg-reset-btn:hover {
    background: #555;
    color: #fff;
}

.xzg-theme-content::-webkit-scrollbar {
    width: 6px;
}

.xzg-theme-content::-webkit-scrollbar-track {
    background: #222;
}

.xzg-theme-content::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 3px;
}

.xzg-theme-content::-webkit-scrollbar-thumb:hover {
    background: #666;
}

.xzg-color-swatches {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-bottom: 6px;
}

.xzg-swatch-group {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
}

.xzg-theme-section > .xzg-swatch-group {
    margin-bottom: 6px;
}

.xzg-theme-section > *:last-child {
    margin-bottom: 0;
}

.xzg-swatch-label {
    font-size: 12px;
    color: #aaa;
    min-width: 40px;
}

.xzg-swatch-row {
    display: flex;
    gap: 3px;
}

.xzg-color-swatch {
    width: 50px;
    height: 22px;
    border: 2px solid #555;
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
    transition: all 0.2s;
}

.xzg-color-swatch:hover {
    border-color: #888;
    transform: scale(1.1);
}

.xzg-color-swatch.active {
    border-color: #fff;
    box-shadow: 0 0 0 2px #667eea;
}

.xzg-color-swatch:active {
    transform: scale(0.95);
}

.xzg-text-swatch {
    border-style: solid;
}

.xzg-picker-section {
    padding: 9px;
    background: #222;
    border-bottom: 1px solid #444;
}

.xzg-sv-area {
    position: relative;
    width: 100%;
    height: 120px;
    border-radius: 6px;
    margin-bottom: 7px;
    cursor: crosshair;
    background-color: hsl(240, 100%, 50%);
    border: 1px solid #555;
    overflow: hidden;
}

.xzg-sv-white {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(to right, #fff, transparent);
}

.xzg-sv-black {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(to top, #000, transparent);
}

.xzg-sv-cursor {
    position: absolute;
    width: 18px;
    height: 18px;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 2;
}

.xzg-hue-row {
    margin-bottom: 0;
}

.xzg-hue-bar {
    position: relative;
    width: 100%;
    height: 16px;
    border-radius: 8px;
    background: linear-gradient(to right, 
        #ff0000 0%, #ffff00 17%, #00ff00 33%, 
        #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%);
    cursor: pointer;
    border: 1px solid #555;
}

.xzg-hue-cursor {
    position: absolute;
    top: 50%;
    width: 16px;
    height: 16px;
    border: 2px solid #fff;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.3);
    pointer-events: none;
}

.xzg-title-toggle-row {
    margin-bottom: 0;
}

.xzg-title-gradient-section.xzg-swatch-group {
    justify-content: flex-end;
}

.xzg-theme-direction-row.xzg-title-gradient-section {
    justify-content: flex-end;
}

.xzg-theme-direction-row.xzg-title-gradient-section .xzg-theme-label {
    margin-right: 10px;
}

.xzg-toggle-switch {
    position: relative;
    width: 48px;
    height: 20px;
    border: none;
    border-radius: 10px;
    background: #555;
    cursor: pointer;
    padding: 0;
    transition: background 0.2s;
    flex-shrink: 0;
}

.xzg-toggle-switch[data-checked="true"] {
    background: #353535;
}

.xzg-toggle-switch .xzg-toggle-slider {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    background: #fff;
    border-radius: 50%;
    transition: left 0.2s;
    pointer-events: none;
}

.xzg-toggle-switch[data-checked="true"] .xzg-toggle-slider {
    left: 30px;
}

.xzg-toggle-switch .xzg-toggle-label {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-size: 11px;
    color: #fff;
    pointer-events: none;
    font-weight: bold;
    user-select: none;
}

.xzg-toggle-switch[data-checked="false"] .xzg-toggle-label {
    right: 8px;
}

.xzg-toggle-switch[data-checked="true"] .xzg-toggle-label {
    left: 8px;
}

.xzg-dialog-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
}

.xzg-dialog {
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 8px;
    min-width: 280px;
    max-width: 90vw;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif;
    color: #ddd;
}

.xzg-dialog-title {
    padding: 12px 16px;
    font-size: 14px;
    font-weight: bold;
    border-bottom: 1px solid #444;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #fff;
    border-radius: 8px 8px 0 0;
}

.xzg-dialog-body {
    padding: 16px;
    font-size: 13px;
}

.xzg-dialog-footer {
    padding: 12px 16px;
    border-top: 1px solid #444;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

.xzg-btn {
    padding: 6px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
}

.xzg-btn-cancel {
    background: #444;
    color: #ddd;
}

.xzg-btn-cancel:hover {
    background: #555;
}

.xzg-presets-section {
    margin-top: 0;
    margin-bottom: 6px;
}

.xzg-presets-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
}

.xzg-presets-row {
    display: flex;
    gap: 4px;
    flex: 1;
    max-width: 180px;
}

.xzg-preset-item {
    flex: 1;
    height: 20px;
    border-radius: 3px;
    cursor: pointer;
    border: 1.5px solid #444;
    transition: all 0.2s;
    position: relative;
    overflow: hidden;
}

.xzg-preset-item:hover {
    border-color: #667eea;
    transform: translateY(-1px);
    box-shadow: 0 1px 4px rgba(102, 126, 234, 0.3);
}

.xzg-preset-item:active {
    transform: translateY(0);
}

.xzg-presets-tip {
    text-align: center;
    color: #ffffff;
    font-size: 10px;
    margin-top: 5px;
    margin-bottom: 0;
}

.xzg-link-highlight-section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
    margin-top: 0;
    margin-bottom: 6px;
}

.xzg-anim-type-btn {
    width: 26px;
    height: 22px;
    border: 1px solid #444;
    border-radius: 3px;
    background: #2a2a2a;
    color: #777;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
}
.xzg-anim-type-btn:hover {
    background: #3a3a3a;
    color: #ccc;
    border-color: #666;
}
.xzg-anim-type-btn.active {
    background: #1a3a2a;
    border-color: #4caf50;
    color: #4caf50;
}

.xzg-wallpaper-section {
    margin-top: 0;
    margin-bottom: 6px;
}

.xzg-wallpaper-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 7px;
}

.xzg-wallpaper-controls {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 6px;
    border-top: 1px solid #444;
}

.xzg-wallpaper-upload-row {
    display: flex;
    gap: 6px;
}

.xzg-wallpaper-btn {
    flex: 1;
    height: 28px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #333;
    color: #ddd;
    cursor: pointer;
    font-size: 12px;
    padding: 0 10px;
    transition: all 0.15s;
}
.xzg-wallpaper-btn:hover {
    background: #444;
    border-color: #666;
}
.xzg-wallpaper-clear {
    flex: none;
    width: 60px;
    background: #3a1a1a;
    border-color: #773333;
    color: #e07070;
}
.xzg-wallpaper-clear:hover {
    background: #4a1a1a;
    border-color: #aa4444;
}

.xzg-wallpaper-row {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 28px;
}

.xzg-wallpaper-row .xzg-swatch-label {
    min-width: 60px;
    flex-shrink: 0;
}

.xzg-wallpaper-value {
    font-size: 11px;
    color: #aaa;
    min-width: 48px;
    text-align: right;
    flex-shrink: 0;
}

.xzg-wallpaper-fit-btns {
    display: flex;
    gap: 4px;
    flex: 1;
}

.xzg-wallpaper-fit-btn {
    flex: 1;
    height: 24px;
    border: 1px solid #444;
    border-radius: 3px;
    background: #2a2a2a;
    color: #888;
    cursor: pointer;
    font-size: 11px;
    padding: 0;
    transition: all 0.15s;
}
.xzg-wallpaper-fit-btn:hover {
    background: #3a3a3a;
    color: #ccc;
    border-color: #666;
}
.xzg-wallpaper-fit-btn.active {
    background: #1a2a3a;
    border-color: #4a90e2;
    color: #6ab0ff;
}

#xzg-wallpaper-opacity {
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    background: #444;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
}
#xzg-wallpaper-opacity::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    background: #6ab0ff;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}
#xzg-wallpaper-opacity::-moz-range-thumb {
    width: 14px;
    height: 14px;
    background: #6ab0ff;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}

.xzg-menu-hide-full {
    flex: 1;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    box-sizing: border-box;
}

.xzg-menu-hide-tabs {
    display: flex;
    gap: 2px;
    background: #1e1e1e;
    padding: 3px;
    border-radius: 4px;
}

.xzg-menu-tab {
    flex: 1;
    padding: 5px 0;
    background: none;
    border: none;
    color: #888;
    font-size: 12px;
    cursor: pointer;
    border-radius: 3px;
    transition: all 0.15s;
}

.xzg-menu-tab:hover {
    color: #ccc;
    background: rgba(255, 255, 255, 0.05);
}

.xzg-menu-tab.active {
    background: #3a3a3a;
    color: #FFD700;
    font-weight: bold;
}

.xzg-menu-hide-toolbar {
    display: flex;
    gap: 4px;
}

.xzg-menu-tool-btn {
    flex: 1;
    height: 26px;
    border: 1px solid #444;
    border-radius: 3px;
    background: #333;
    color: #bbb;
    cursor: pointer;
    font-size: 11px;
    padding: 0 6px;
    transition: all 0.15s;
}

.xzg-menu-tool-btn:hover {
    background: #444;
    border-color: #666;
    color: #fff;
}

.xzg-menu-hide-list {
    flex: 1;
    overflow-y: auto;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    background: #1a1a1a;
    padding: 4px;
    min-height: 0;
}

.xzg-menu-hide-list::-webkit-scrollbar {
    width: 6px;
}

.xzg-menu-hide-list::-webkit-scrollbar-track {
    background: #1a1a1a;
}

.xzg-menu-hide-list::-webkit-scrollbar-thumb {
    background: #444;
    border-radius: 3px;
}

.xzg-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 3px;
    transition: background 0.1s;
    font-size: 12px;
    color: #ccc;
    width: 100%;
    box-sizing: border-box;
}

.xzg-menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
}

.xzg-menu-item input[type="checkbox"] {
    width: 14px;
    height: 14px;
    cursor: pointer;
    flex-shrink: 0;
    accent-color: #FFD700;
}

.xzg-menu-item span {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.xzg-menu-empty-tip {
    text-align: center;
    color: #666;
    font-size: 12px;
    padding: 30px 10px;
    line-height: 1.6;
}

.xzg-menu-reset-btn {
    width: 100%;
    height: 28px;
    border: 1px solid #773333;
    border-radius: 4px;
    background: #3a1a1a;
    color: #e07070;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.15s;
}

.xzg-menu-reset-btn:hover {
    background: #4a1a1a;
    border-color: #aa4444;
    color: #ff8080;
}
        `;
        
        this.panelStyleElement = document.createElement("style");
        this.panelStyleElement.id = "xzg-theme-panel-style";
        this.panelStyleElement.textContent = css;
        document.head.appendChild(this.panelStyleElement);
    },

    _serializeHooksInstalled: false,

    hookSerialize(retryCount = 0) {
        // 如果已安装则跳过
        if (this._serializeHooksInstalled) return;

        const self = this;
        
        function hookProto(proto, name, makeWrapper) {
            const orig = proto[name];
            if (orig && orig._xzgWrapped) return;
            const wrapped = makeWrapper(orig);
            wrapped._xzgWrapped = true;
            self.protoRefs[name] = orig;
            proto[name] = wrapped;
        }

        if (window.LiteGraph && LiteGraph.LGraphNode && LiteGraph.LGraphNode.prototype) {
            hookProto(LiteGraph.LGraphNode.prototype, 'serialize', (orig) => function() {
                const data = orig ? orig.call(this) : {};
                if (this._xzgGradient) {
                    data._xzgGradient = JSON.parse(JSON.stringify(this._xzgGradient));
                }
                return data;
            });

            hookProto(LiteGraph.LGraphNode.prototype, 'configure', (orig) => function(data) {
                if (orig) orig.call(this, data);
                if (data && data._xzgGradient) {
                    this._xzgGradient = JSON.parse(JSON.stringify(data._xzgGradient));
                }
            });

            hookProto(LiteGraph.LGraphNode.prototype, 'onAdded', (orig) => function(graph) {
                if (orig) orig.call(this, graph);
                if (this._xzgGradient) {
                    setTimeout(() => {
                        XZGThemeManager.applyGradientToDOMNode(this);
                    }, 50);
                }
            });

            this._serializeHooksInstalled = true;
            console.log('[小珠光主题] 序列化 Hook 已安装 ✓');
        } else if (retryCount < 60) {
            // LiteGraph 尚未就绪，延迟重试（最多60次=6秒）
            setTimeout(() => self.hookSerialize(retryCount + 1), 100);
        } else {
            console.warn('[小珠光主题] 序列化 Hook 安装失败：LiteGraph 超时未就绪');
        }
    },

    ensureCanvasHook() {
        if (this.canvasHooked) return;
        if (!window.app || !app.canvas) {
            setTimeout(() => this.ensureCanvasHook(), 100);
            return;
        }
        this.hookDrawNodeShape();
        this.setupLinkHighlight();
        this.canvasHooked = true;
    },

    setupLinkHighlight() {
        if (this.linkHighlightHooked) return;
        if (!window.app || !app.canvas) {
            setTimeout(() => this.setupLinkHighlight(), 100);
            return;
        }

        const canvas = app.canvas;
        const self = this;

        // 新版 ComfyUI 前端使用 CanvasPathRenderer.drawLink 逐条绘制连线
        // 通过 canvas.linkRenderer.pathRenderer 访问该实例
        if (!canvas.linkRenderer || !canvas.linkRenderer.pathRenderer) {
            setTimeout(() => this.setupLinkHighlight(), 100);
            return;
        }

        // 在原型上钩住 drawLink，对所有实例生效
        const proto = Object.getPrototypeOf(canvas.linkRenderer.pathRenderer);
        if (!proto || typeof proto.drawLink !== 'function') {
            setTimeout(() => this.setupLinkHighlight(), 100);
            return;
        }
        if (proto.drawLink._xzgLinkHighlightWrapped) {
            this.linkHighlightHooked = true;
            return;
        }

        const origDrawLink = proto.drawLink;
        proto.drawLink = function(ctx, link, renderCtx) {
            // 三个功能都关闭时，正常绘制
            if (!self.linkHighlightActive && !self.linkLaserActive && !self.linkColorActive) {
                return origDrawLink.call(this, ctx, link, renderCtx);
            }

            const nodeIds = self.getHighlightNodeIds();
            const hasSelectedNodes = nodeIds.length > 0;

            // 查找原始 LLink 的 origin_id/target_id
            const graph = self.canvas?.graph || (window.app && app.graph);
            const linksMap = graph?._links;
            let originId = null, targetId = null, linkId = null;

            if (link.origin_id != null) {
                originId = link.origin_id;
                targetId = link.target_id;
                linkId = link.id;
            } else if (linksMap && link.id != null) {
                const origLink = linksMap.get(Number(link.id)) || linksMap.get(link.id) || linksMap.get(String(link.id));
                if (origLink) {
                    originId = origLink.origin_id;
                    targetId = origLink.target_id;
                    linkId = origLink.id;
                }
            }

            if (originId == null) {
                // 找不到 originId 时，仍可应用连线颜色
                if (self.linkColorActive) {
                    const origColor = link.color;
                    link.color = self.linkColor;
                    origDrawLink.call(this, ctx, link, renderCtx);
                    link.color = origColor;
                } else {
                    origDrawLink.call(this, ctx, link, renderCtx);
                }
                // 激光动画仍可尝试绘制（使用 link 的 startPoint/endPoint）
                if (self.linkLaserActive) {
                    self._drawLaserOverlay(ctx, link, null, null);
                    self._ensureAnimLoop();
                }
                return;
            }

            // 判断连线是否与选中节点相连（高亮/动画需要）
            let isConnected = false;
            if (hasSelectedNodes) {
                const idSet = new Set(nodeIds.map(String));
                isConnected = idSet.has(String(originId)) || idSet.has(String(targetId));
            }

            // 连线颜色：覆盖所有连线颜色
            if (self.linkColorActive) {
                const origColor = link.color;
                if (self.linkHighlightActive && hasSelectedNodes) {
                    if (isConnected) {
                        link.color = self._saturateColor(self.linkColor, 0.3);
                        origDrawLink.call(this, ctx, link, renderCtx);
                    } else {
                        link.color = self.linkColor;
                        const origAlpha = ctx.globalAlpha;
                        ctx.globalAlpha = origAlpha * self.linkHighlightDimAlpha;
                        self._drawThinBaseLine(ctx, link);
                        ctx.globalAlpha = origAlpha;
                    }
                } else {
                    link.color = self.linkColor;
                    origDrawLink.call(this, ctx, link, renderCtx);
                }
                link.color = origColor;
            } else if (self.linkHighlightActive && hasSelectedNodes) {
                // 仅高亮：相关连线绘制细原始线 + 1px白色流动虚线 + 七彩星芒，不相关变暗
                if (isConnected) {
                    self._drawThinBaseLine(ctx, link);
                    self._drawWhiteDashLine(ctx, link);
                    // 七彩星芒
                    self._drawRainbowSparkles(ctx, link);
                    self._ensureHighlightAnimLoop();
                } else {
                    const origAlpha = ctx.globalAlpha;
                    ctx.globalAlpha = origAlpha * self.linkHighlightDimAlpha;
                    self._drawThinBaseLine(ctx, link);
                    ctx.globalAlpha = origAlpha;
                }
            } else {
                origDrawLink.call(this, ctx, link, renderCtx);
            }

            // 激光动画：独立作用于所有连线
            if (self.linkLaserActive) {
                self._drawLaserOverlay(ctx, link, originId, targetId);
                self._ensureAnimLoop();
            }
        };
        proto.drawLink._xzgLinkHighlightWrapped = true;

        this.linkHighlightHooked = true;
        console.log('[小珠光主题] 连线高亮 Hook 已安装 ✓');
    },

    getHighlightNodeIds() {
        if (!window.app || !app.canvas) return [];
        const canvas = app.canvas;
        const ids = [];

        // 仅使用选中的节点（点击选中）
        if (canvas.selected_nodes) {
            const nodes = Object.values(canvas.selected_nodes);
            for (const n of nodes) {
                if (n && n.id != null) ids.push(n.id);
            }
        }

        return ids;
    },

    _saturateColor(color, saturateIncrease) {
        if (!color) return color;
        let r, g, b;
        if (typeof color === 'string') {
            const c = color.replace('#', '');
            if (c.length === 3) {
                r = parseInt(c[0] + c[0], 16);
                g = parseInt(c[1] + c[1], 16);
                b = parseInt(c[2] + c[2], 16);
            } else if (c.length >= 6) {
                r = parseInt(c.substring(0, 2), 16);
                g = parseInt(c.substring(2, 4), 16);
                b = parseInt(c.substring(4, 6), 16);
            } else {
                return color;
            }
        } else if (Array.isArray(color)) {
            r = color[0]; g = color[1]; b = color[2];
        } else {
            return color;
        }

        const rn = r / 255, gn = g / 255, bn = b / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        let h, s, l = (max + min) / 2;

        if (max === min) {
            h = s = 0;
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
                case gn: h = (bn - rn) / d + 2; break;
                case bn: h = (rn - gn) / d + 4; break;
            }
            h /= 6;
        }

        s = Math.min(1, s + saturateIncrease);

        let r2, g2, b2;
        if (s === 0) {
            r2 = g2 = b2 = l;
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r2 = hue2rgb(p, q, h + 1/3);
            g2 = hue2rgb(p, q, h);
            b2 = hue2rgb(p, q, h - 1/3);
        }

        return `rgb(${Math.round(r2 * 255)}, ${Math.round(g2 * 255)}, ${Math.round(b2 * 255)})`;
    },

    toggleLinkHighlight() {
        this.linkHighlightActive = !this.linkHighlightActive;
        try {
            localStorage.setItem('xzg-link-highlight', this.linkHighlightActive ? 'true' : 'false');
        } catch(e) {}
        if (!this.linkHighlightActive) {
            this._stopHighlightAnimLoop();
        }
        if (!this.linkHighlightActive && !this.linkLaserActive && !this.linkColorActive) {
            this._stopAnimLoop();
        }
        if (window.app) {
            if (app.canvas?.setDirty) {
                app.canvas.setDirty(true, true);
            } else if (app.graph?.setDirtyCanvas) {
                app.graph.setDirtyCanvas(true, true);
            }
        }
        return this.linkHighlightActive;
    },

    toggleLinkLaser() {
        this.linkLaserActive = !this.linkLaserActive;
        try {
            localStorage.setItem('xzg-link-laser', this.linkLaserActive ? 'true' : 'false');
        } catch(e) {}
        if (!this.linkLaserActive && !this.linkHighlightActive && !this.linkColorActive) {
            this._stopAnimLoop();
        }
        if (window.app) {
            if (app.canvas?.setDirty) {
                app.canvas.setDirty(true, true);
            } else if (app.graph?.setDirtyCanvas) {
                app.graph.setDirtyCanvas(true, true);
            }
        }
        return this.linkLaserActive;
    },

    toggleLinkColor() {
        this.linkColorActive = !this.linkColorActive;
        try {
            localStorage.setItem('xzg-link-color-active', this.linkColorActive ? 'true' : 'false');
        } catch(e) {}
        if (window.app) {
            if (app.canvas?.setDirty) {
                app.canvas.setDirty(true, true);
            } else if (app.graph?.setDirtyCanvas) {
                app.graph.setDirtyCanvas(true, true);
            }
        }
        return this.linkColorActive;
    },

    _drawThinBaseLine(ctx, link) {
        const sp = link.startPoint;
        const ep = link.endPoint;
        if (!sp || !ep) return;

        const sx = sp.x != null ? sp.x : sp[0];
        const sy = sp.y != null ? sp.y : sp[1];
        const ex = ep.x != null ? ep.x : ep[0];
        const ey = ep.y != null ? ep.y : ep[1];
        const cp = link.controlPoints || [];
        const color = link.color || '#888888';

        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        if (cp.length >= 2) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            const c1x = cp[1].x != null ? cp[1].x : cp[1][0];
            const c1y = cp[1].y != null ? cp[1].y : cp[1][1];
            ctx.bezierCurveTo(c0x, c0y, c1x, c1y, ex, ey);
        } else if (cp.length === 1) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            ctx.quadraticCurveTo(c0x, c0y, ex, ey);
        } else {
            ctx.lineTo(ex, ey);
        }
        ctx.stroke();
        ctx.restore();
    },

    _drawWhiteDashLine(ctx, link) {
        const sp = link.startPoint;
        const ep = link.endPoint;
        if (!sp || !ep) return;

        const sx = sp.x != null ? sp.x : sp[0];
        const sy = sp.y != null ? sp.y : sp[1];
        const ex = ep.x != null ? ep.x : ep[0];
        const ey = ep.y != null ? ep.y : ep[1];
        const cp = link.controlPoints || [];
        const t = performance.now();

        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.setLineDash([8, 5]);
        ctx.lineDashOffset = -(t * 0.03);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        if (cp.length >= 2) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            const c1x = cp[1].x != null ? cp[1].x : cp[1][0];
            const c1y = cp[1].y != null ? cp[1].y : cp[1][1];
            ctx.bezierCurveTo(c0x, c0y, c1x, c1y, ex, ey);
        } else if (cp.length === 1) {
            const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
            const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
            ctx.quadraticCurveTo(c0x, c0y, ex, ey);
        } else {
            ctx.lineTo(ex, ey);
        }
        ctx.stroke();
        ctx.restore();
    },

    _drawRainbowSparkles(ctx, link) {
        const sp = link.startPoint;
        const ep = link.endPoint;
        if (!sp || !ep) return;

        const sx = sp.x != null ? sp.x : sp[0];
        const sy = sp.y != null ? sp.y : sp[1];
        const ex = ep.x != null ? ep.x : ep[0];
        const ey = ep.y != null ? ep.y : ep[1];
        const cp = link.controlPoints || [];
        const t = performance.now();

        const getPointAtT = (tVal) => {
            if (cp.length >= 2) {
                const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
                const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
                const c1x = cp[1].x != null ? cp[1].x : cp[1][0];
                const c1y = cp[1].y != null ? cp[1].y : cp[1][1];
                const mt = 1 - tVal;
                const x = mt * mt * mt * sx + 3 * mt * mt * tVal * c0x + 3 * mt * tVal * tVal * c1x + tVal * tVal * tVal * ex;
                const y = mt * mt * mt * sy + 3 * mt * mt * tVal * c0y + 3 * mt * tVal * tVal * c1y + tVal * tVal * tVal * ey;
                return { x, y };
            } else if (cp.length === 1) {
                const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
                const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
                const mt = 1 - tVal;
                const x = mt * mt * sx + 2 * mt * tVal * c0x + tVal * tVal * ex;
                const y = mt * mt * sy + 2 * mt * tVal * c0y + tVal * tVal * ey;
                return { x, y };
            } else {
                return {
                    x: sx + (ex - sx) * tVal,
                    y: sy + (ey - sy) * tVal
                };
            }
        };

        const drawStarburst = (cx, cy, color, size, rotation) => {
            const rayCount = 8;
            const rayLength = size;
            const rayHalfWidth = size * 0.06;
            const coreRadius = size * 0.18;
            const glowRadius = size * 0.6;

            ctx.save();
            ctx.translate(cx, cy);

            const glowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, glowRadius);
            glowGrad.addColorStop(0, color + 'CC');
            glowGrad.addColorStop(0.5, color + '66');
            glowGrad.addColorStop(1, color + '00');
            ctx.fillStyle = glowGrad;
            ctx.beginPath();
            ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
            ctx.fill();

            ctx.rotate(rotation);

            ctx.shadowColor = color;
            ctx.shadowBlur = size * 0.8;

            for (let i = 0; i < rayCount; i++) {
                const angle = (i * Math.PI * 2) / rayCount;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);

                const tipX = cos * rayLength;
                const tipY = sin * rayLength;

                const perpX = -sin;
                const perpY = cos;

                const baseInnerX = cos * coreRadius;
                const baseInnerY = sin * coreRadius;

                ctx.beginPath();
                ctx.moveTo(baseInnerX - perpX * rayHalfWidth, baseInnerY - perpY * rayHalfWidth);
                ctx.lineTo(tipX, tipY);
                ctx.lineTo(baseInnerX + perpX * rayHalfWidth, baseInnerY + perpY * rayHalfWidth);
                ctx.closePath();
                ctx.fillStyle = color;
                ctx.fill();
            }

            ctx.shadowBlur = size * 0.5;
            ctx.beginPath();
            ctx.arc(0, 0, coreRadius, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();

            ctx.restore();
        };

        const rainbowColors = [
            '#FF6B6B',
            '#FFA94D',
            '#FFE066',
            '#69DB7C',
            '#339AF0',
            '#9775FA',
            '#F06595'
        ];

        const sparkleCount = 5;
        const speed = 0.00025;
        const baseOffset = (t * speed) % 1;

        ctx.save();

        for (let i = 0; i < sparkleCount; i++) {
            const tVal = (baseOffset + i / sparkleCount) % 1;
            const pos = getPointAtT(tVal);
            const color = rainbowColors[i % rainbowColors.length];
            const pulse = 0.7 + 0.3 * Math.sin(t * 0.004 + i * 1.2);
            const size = 11 * pulse;
            const rotation = t * 0.001 + i * 0.5;

            drawStarburst(pos.x, pos.y, color, size, rotation);
        }

        ctx.restore();
    },

    _drawLaserOverlay(ctx, link, originId, targetId) {
        const sp = link.startPoint;
        const ep = link.endPoint;
        if (!sp || !ep) return;

        const sx = sp.x != null ? sp.x : sp[0];
        const sy = sp.y != null ? sp.y : sp[1];
        const ex = ep.x != null ? ep.x : ep[0];
        const ey = ep.y != null ? ep.y : ep[1];
        const cp = link.controlPoints || [];
        const laserColor = this.linkColor || '#888888';
        const t = Date.now();

        // 构建路径辅助函数
        const buildPath = () => {
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            if (cp.length >= 2) {
                const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
                const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
                const c1x = cp[1].x != null ? cp[1].x : cp[1][0];
                const c1y = cp[1].y != null ? cp[1].y : cp[1][1];
                ctx.bezierCurveTo(c0x, c0y, c1x, c1y, ex, ey);
            } else if (cp.length === 1) {
                const c0x = cp[0].x != null ? cp[0].x : cp[0][0];
                const c0y = cp[0].y != null ? cp[0].y : cp[0][1];
                ctx.quadraticCurveTo(c0x, c0y, ex, ey);
            } else {
                ctx.lineTo(ex, ey);
            }
        };

        const type = this.laserAnimType || 'flow';

        switch (type) {
            case 'flow':   this._animFlow(ctx, buildPath, sx, sy, ex, ey, laserColor, t); break;
            case 'gradient': this._animGradient(ctx, buildPath, sx, sy, ex, ey, laserColor, t); break;
            case 'breath': this._animBreath(ctx, buildPath, laserColor, t); break;
            case 'glow':   this._animGlow(ctx, buildPath, laserColor, t); break;
            default:       this._animFlow(ctx, buildPath, sx, sy, ex, ey, laserColor, t);
        }
    },

    // 流光溢彩：彩虹渐变沿连线流动
    _animFlow(ctx, buildPath, sx, sy, ex, ey, laserColor, t) {
        const speed = 0.15;
        const dashLen = 14;
        const gapLen = 16;
        const offset = (t * speed) % (dashLen + gapLen);
        const hueShift = (t * 0.05) % 360;

        // 解析基础颜色
        const rgb = this._hexToRgb(laserColor);

        ctx.save();

        // 彩虹发光底层
        const grad = ctx.createLinearGradient(sx, sy, ex, ey);
        for (let i = 0; i <= 4; i++) {
            const hue = (hueShift + i * 90) % 360;
            grad.addColorStop(i / 4, `hsla(${hue}, 100%, 60%, 0.5)`);
        }
        buildPath();
        ctx.strokeStyle = grad;
        ctx.lineWidth = 6;
        ctx.shadowColor = laserColor;
        ctx.shadowBlur = 18;
        ctx.setLineDash([dashLen, gapLen]);
        ctx.lineDashOffset = -offset;
        ctx.stroke();

        // 白色核心
        buildPath();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.6;
        ctx.shadowBlur = 6;
        ctx.setLineDash([dashLen, gapLen]);
        ctx.lineDashOffset = -offset;
        ctx.stroke();

        ctx.restore();
    },

    // 颜色渐变：沿连线静态渐变
    _animGradient(ctx, buildPath, sx, sy, ex, ey, laserColor, t) {
        const rgb = this._hexToRgb(laserColor);
        const pulse = 0.5 + 0.3 * Math.sin(t * 0.003);

        ctx.save();

        // 渐变底层
        const grad = ctx.createLinearGradient(sx, sy, ex, ey);
        grad.addColorStop(0, laserColor);
        grad.addColorStop(0.5, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${pulse})`);
        grad.addColorStop(1, '#ffffff');
        buildPath();
        ctx.strokeStyle = grad;
        ctx.lineWidth = 4;
        ctx.shadowColor = laserColor;
        ctx.shadowBlur = 12;
        ctx.stroke();

        // 明亮核心
        const grad2 = ctx.createLinearGradient(sx, sy, ex, ey);
        grad2.addColorStop(0, `rgba(255,255,255,${pulse * 0.5})`);
        grad2.addColorStop(1, '#ffffff');
        buildPath();
        ctx.strokeStyle = grad2;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.8;
        ctx.stroke();

        ctx.restore();
    },

    // 亮度呼吸：整体亮度正弦波动
    _animBreath(ctx, buildPath, laserColor, t) {
        const breath = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 0.004));
        const rgb = this._hexToRgb(laserColor);

        ctx.save();

        // 呼吸发光层
        buildPath();
        ctx.strokeStyle = laserColor;
        ctx.lineWidth = 4;
        ctx.globalAlpha = breath;
        ctx.shadowColor = laserColor;
        ctx.shadowBlur = 10 + breath * 16;
        ctx.stroke();

        // 核心亮线
        buildPath();
        ctx.strokeStyle = `rgba(${Math.min(255, rgb.r + 100)}, ${Math.min(255, rgb.g + 100)}, ${Math.min(255, rgb.b + 100)}, ${breath})`;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 4;
        ctx.stroke();

        ctx.restore();
    },

    // 辉光：强烈光晕向外扩散
    _animGlow(ctx, buildPath, laserColor, t) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.003);
        const rgb = this._hexToRgb(laserColor);

        ctx.save();

        // 外层大光晕
        buildPath();
        ctx.strokeStyle = laserColor;
        ctx.lineWidth = 8;
        ctx.globalAlpha = 0.15 + pulse * 0.15;
        ctx.shadowColor = laserColor;
        ctx.shadowBlur = 25 + pulse * 15;
        ctx.stroke();

        // 中层光晕
        buildPath();
        ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.6)`;
        ctx.lineWidth = 4;
        ctx.globalAlpha = 0.4 + pulse * 0.3;
        ctx.shadowBlur = 12 + pulse * 8;
        ctx.stroke();

        // 内层亮核心
        buildPath();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5 + pulse * 0.4;
        ctx.shadowBlur = 6;
        ctx.stroke();

        ctx.restore();
    },

    _hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : { r: 0, g: 255, b: 255 };
    },

    _ensureAnimLoop() {
        if (this.linkAnimRunning) return;
        this.linkAnimRunning = true;
        const self = this;
        function loop() {
            // 仅当激光动画关闭时停止循环
            if (!self.linkLaserActive) {
                self.linkAnimRunning = false;
                self.linkAnimFrameId = null;
                return;
            }
            if (window.app?.canvas?.setDirty) {
                app.canvas.setDirty(true, true);
            }
            self.linkAnimFrameId = requestAnimationFrame(loop);
        }
        self.linkAnimFrameId = requestAnimationFrame(loop);
    },

    _ensureHighlightAnimLoop() {
        if (this.linkHighlightAnimRunning) return;
        this.linkHighlightAnimRunning = true;
        const self = this;
        function loop() {
            if (!self.linkHighlightActive || !self._hasSelectedNodes()) {
                self.linkHighlightAnimRunning = false;
                self.linkHighlightAnimFrameId = null;
                return;
            }
            if (window.app?.canvas?.setDirty) {
                app.canvas.setDirty(true, true);
            }
            self.linkHighlightAnimFrameId = requestAnimationFrame(loop);
        }
        self.linkHighlightAnimFrameId = requestAnimationFrame(loop);
    },

    _hasSelectedNodes() {
        if (!window.app || !app.canvas) return false;
        if (app.canvas.selected_nodes) {
            return Object.keys(app.canvas.selected_nodes).length > 0;
        }
        return false;
    },

    _stopAnimLoop() {
        this.linkAnimRunning = false;
        if (this.linkAnimFrameId) {
            cancelAnimationFrame(this.linkAnimFrameId);
            this.linkAnimFrameId = null;
        }
    },

    _stopHighlightAnimLoop() {
        this.linkHighlightAnimRunning = false;
        if (this.linkHighlightAnimFrameId) {
            cancelAnimationFrame(this.linkHighlightAnimFrameId);
            this.linkHighlightAnimFrameId = null;
        }
    },

    hookDrawNodeShape() {
        const canvas = app.canvas;
        if (!canvas) return;

        const self = this;

        function hookMethod(methodName, makeWrapper) {
            const targets = [];
            if (typeof canvas[methodName] === 'function' &&
                Object.prototype.hasOwnProperty.call(canvas, methodName)) {
                targets.push({ obj: canvas, orig: canvas[methodName] });
            }
            let proto = Object.getPrototypeOf(canvas);
            while (proto && proto !== Object.prototype) {
                if (Object.prototype.hasOwnProperty.call(proto, methodName) &&
                    typeof proto[methodName] === 'function') {
                    targets.push({ obj: proto, orig: proto[methodName] });
                }
                proto = Object.getPrototypeOf(proto);
            }
            if (targets.length === 0) {
                const fn = canvas[methodName];
                if (typeof fn === 'function') targets.push({ obj: canvas, orig: fn });
                else return false;
            }
            for (const t of targets) {
                if (t.orig._xzgWrapped) continue;
                const w = makeWrapper(t.orig);
                w._xzgWrapped = true;
                t.obj[methodName] = w;
            }
            return true;
        }

        function makeDrawShapeWrapper(origFn) {
            return function(node, ctx, size, fgcolor, bgcolor, selected, mouseOver) {
                if (!node._xzgGradient) {
                    origFn.call(this, node, ctx, size, fgcolor, bgcolor, selected, mouseOver);
                    return;
                }

                const LG = typeof LiteGraph !== 'undefined' ? LiteGraph : null;
                const th = LG?.NODE_TITLE_HEIGHT || 30;
                const w = size[0], h = size[1];
                const r = node.borderRadius || LG?.NODE_CORNER_RADIUS || 8;
                const cfg = node._xzgGradient;
                const pts = self._gradPts(w, h, th);
                const titlePts = self._titleGradPts(w, th);
                const bodyPts = self._bodyGradPts(w, h);
                const dirSym = self.degToSymbol(cfg.direction);
                const titleDirSym = self.degToSymbol(cfg.titleDirection || cfg.direction);

                ctx.save();
                try {
                    const useTitleGradient = cfg.useTitleGradient && cfg.titleStops && cfg.titleStops.length > 0;
                    
                    if (useTitleGradient) {
                        const [tx1, ty1, tx2, ty2] = titlePts[titleDirSym] || titlePts['↓'];
                        const titleGrad = ctx.createLinearGradient(tx1, ty1, tx2, ty2);
                        cfg.titleStops.forEach(s => titleGrad.addColorStop(s.p, s.color));
                        
                        const [bx1, by1, bx2, by2] = bodyPts[dirSym] || bodyPts['↓'];
                        const bodyGrad = ctx.createLinearGradient(bx1, by1, bx2, by2);
                        cfg.stops.forEach(s => bodyGrad.addColorStop(s.p, s.color));
                        
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(0, -th, w, th, [r, r, 0, 0]);
                        else ctx.rect(0, -th, w, th);
                        ctx.fillStyle = titleGrad;
                        ctx.fill();
                        
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(0, 0, w, h, [0, 0, r, r]);
                        else ctx.rect(0, 0, w, h);
                        ctx.fillStyle = bodyGrad;
                        ctx.fill();
                    } else {
                        const [x1, y1, x2, y2] = pts[dirSym] || pts['↓'];
                        const grad = ctx.createLinearGradient(x1, y1, x2, y2);
                        cfg.stops.forEach(s => grad.addColorStop(s.p, s.color));
                        
                        ctx.beginPath();
                        if (ctx.roundRect) ctx.roundRect(0, -th, w, h + th, r);
                        else ctx.rect(0, -th, w, h + th);
                        ctx.fillStyle = grad;
                        ctx.fill();
                    }

                    const title = node.getTitle ? node.getTitle() : (node.title || '');
                    if (title) {
                        const fontSize = cfg.fontSize || LG?.NODE_TEXT_SIZE || 14;
                        const color = cfg.titleText || '#ffffff';
                        const align = cfg.textAlign || 'left';
                        ctx.save();
                        ctx.font = `${fontSize}px "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "SimHei", Arial, sans-serif`;
                        ctx.fillStyle = color;
                        ctx.textBaseline = 'middle';
                        
                        let textX = 10;
                        if (align === 'center') {
                            ctx.textAlign = 'center';
                            textX = w / 2;
                        } else if (align === 'right') {
                            ctx.textAlign = 'right';
                            textX = w - 10;
                        } else {
                            ctx.textAlign = 'left';
                            textX = 10;
                        }
                        
                        ctx.fillText(title, textX, -th / 2);
                        ctx.restore();
                    }

                    ctx.globalAlpha = 0;
                    origFn.call(this, node, ctx, size, fgcolor, bgcolor, selected, mouseOver);
                } catch(e) {
                    origFn.call(this, node, ctx, size, fgcolor, bgcolor, selected, mouseOver);
                } finally {
                    ctx.restore();
                }
            };
        }

        const ok = hookMethod('drawNodeShape', makeDrawShapeWrapper);
        if (!ok) {
            hookMethod('drawNode', makeDrawShapeWrapper);
        }
    },

    _gradPts(w, h, th) {
        return {
            '↖': [w, h, 0, -th], '↑': [0, h, 0, -th], '↗': [0, h, w, -th],
            '←': [w, 0, 0,  0],  '→': [0, 0, w,  0],
            '↙': [w, -th, 0, h], '↓': [0, -th, 0, h], '↘': [0, -th, w, h],
        };
    },

    _titleGradPts(w, th) {
        return {
            '↖': [w, 0, 0, -th], '↑': [0, 0, 0, -th], '↗': [0, 0, w, -th],
            '←': [w, -th/2, 0, -th/2],  '→': [0, -th/2, w, -th/2],
            '↙': [w, -th, 0, 0], '↓': [0, -th, 0, 0], '↘': [0, -th, w, 0],
        };
    },

    _bodyGradPts(w, h) {
        return {
            '↖': [w, h, 0, 0], '↑': [0, h, 0, 0], '↗': [0, h, w, 0],
            '←': [w, h/2, 0, h/2],  '→': [0, h/2, w, h/2],
            '↙': [w, 0, 0, h], '↓': [0, 0, 0, h], '↘': [0, 0, w, h],
        };
    },

    degToSymbol(deg) {
        const map = {
            '0': '↓', '90': '→', '180': '↑', '270': '←',
            '45': '↘', '135': '↙', '225': '↖', '315': '↗'
        };
        return map[String(deg)] || '↓';
    },

    buildGradientConfig(colors) {
        const stops = [];
        if (colors.useGradient) {
            stops.push({ p: 0, color: colors.color1 });
            stops.push({ p: 0.5, color: colors.color2 });
            stops.push({ p: 1, color: colors.color3 });
        } else {
            stops.push({ p: 0, color: colors.color1 });
            stops.push({ p: 1, color: colors.color1 });
        }
        
        const titleStops = [];
        const useTitleGradient = colors.useTitleGradient !== false && colors.titleColor1;
        if (useTitleGradient) {
            titleStops.push({ p: 0, color: colors.titleColor1 });
            titleStops.push({ p: 0.5, color: colors.titleColor2 || colors.titleColor1 });
            titleStops.push({ p: 1, color: colors.titleColor3 || colors.titleColor1 });
        }
        
        return {
            direction: colors.direction || '90',
            stops: stops,
            titleDirection: colors.titleDirection || '90',
            titleStops: titleStops,
            useTitleGradient: useTitleGradient,
            titleText: colors.titleText || '#ffffff',
            useGradient: colors.useGradient !== false,
            fontSize: colors.fontSize || 14,
            textAlign: colors.textAlign || 'left'
        };
    },

    buildGradientCSS(colors) {
        if (!colors.useGradient) {
            return colors.color1;
        }
        const cssDeg = this.dirToCssDeg(colors.direction);
        return `linear-gradient(${cssDeg}deg, ${colors.color1} 0%, ${colors.color2} 50%, ${colors.color3} 100%)`;
    },

    buildTitleGradientCSS(colors) {
        if (!colors.useTitleGradient || !colors.titleColor1) {
            return null;
        }
        const cssDeg = this.dirToCssDeg(colors.titleDirection || '90');
        return `linear-gradient(${cssDeg}deg, ${colors.titleColor1} 0%, ${colors.titleColor2 || colors.titleColor1} 50%, ${colors.titleColor3 || colors.titleColor1} 100%)`;
    },

    dirToCssDeg(deg) {
        const sym = this.degToSymbol(deg);
        const map = {
            '↑': 0, '→': 90, '↓': 180, '←': 270,
            '↗': 45, '↘': 135, '↖': 225, '↙': 315
        };
        return map[sym] !== undefined ? map[sym] : 180;
    },

    applyThemeToNodes(nodes, colors) {
        if (!nodes || !nodes.length) return;
        
        const cfg = this.buildGradientConfig(colors);
        const gradCSS = this.buildGradientCSS(colors);

        nodes.forEach(node => {
            if (node.type === "XiaozhuguangTitle") return;
            node._xzgGradient = { ...cfg };
            node.color = colors.color1;
            node.bgcolor = colors.color1;
            this.applyGradientToDOMNode(node);
        });

        if (app.graph) {
            app.graph.setDirtyCanvas?.(true, true);
            // 标记工作流已修改，确保更改可被保存
            app.graph.change?.();
        }
    },

    applyGradientToDOMNode(node) {
        if (!node || !node._xzgGradient) return;
        
        const graphCanvas = document.getElementById("graph-canvas");
        if (!graphCanvas) return;

        const cfg = node._xzgGradient;
        const useTitleGradient = cfg.useTitleGradient && cfg.titleStops && cfg.titleStops.length > 0;
        
        const gradCSS = this.buildGradientCSS({
            color1: cfg.stops[0]?.color || '#e49c00',
            color2: cfg.stops[1]?.color || '#000000',
            color3: cfg.stops[2]?.color || '#005149',
            direction: cfg.direction || '90',
            useGradient: cfg.useGradient !== false
        });
        
        const titleGradCSS = useTitleGradient ? this.buildTitleGradientCSS({
            titleColor1: cfg.titleStops[0]?.color,
            titleColor2: cfg.titleStops[1]?.color,
            titleColor3: cfg.titleStops[2]?.color,
            titleDirection: cfg.titleDirection || '90',
            useTitleGradient: true
        }) : null;

        const nodeEls = graphCanvas.querySelectorAll(
            `[data-node-id="${node.id}"], [data-id="${node.id}"], #node-${node.id}`
        );
        
        nodeEls.forEach(nodeEl => {
            const inner = nodeEl.querySelector('[data-testid="node-inner-wrapper"]') || nodeEl;
            
            if (useTitleGradient) {
                inner.style.setProperty('background', gradCSS, 'important');
                inner.style.setProperty('--component-node-background', 'transparent', 'important');
                inner.style.setProperty('--component-node-header', 'transparent', 'important');
            } else {
                inner.style.setProperty('background', gradCSS, 'important');
                inner.style.setProperty('--component-node-background', 'transparent', 'important');
                inner.style.setProperty('--component-node-header', 'transparent', 'important');
            }

            const headerSelectors = [
                '[data-testid*="header"]', '.comfy-header', '.comfy-title', 
                '.node-header', '.node-title', '.litegraph .title',
                '.node-titlebar', '.title-bar', '.litemenu-title'
            ];
            const header = nodeEl.querySelector(headerSelectors.join(', '));
            if (header) {
                if (useTitleGradient && titleGradCSS) {
                    header.style.setProperty('background', titleGradCSS, 'important');
                    header.style.setProperty('background-color', titleGradCSS, 'important');
                } else {
                    header.style.setProperty('background', 'transparent', 'important');
                    header.style.setProperty('background-color', 'transparent', 'important');
                }
                header.style.setProperty('color', cfg.titleText || '#ffffff', 'important');
                if (cfg.fontSize) {
                    header.style.setProperty('font-size', cfg.fontSize + 'px', 'important');
                    const textEls = header.querySelectorAll('*');
                    textEls.forEach(el => {
                        el.style.setProperty('font-size', cfg.fontSize + 'px', 'important');
                    });
                }
                if (cfg.textAlign) {
                    header.style.setProperty('text-align', cfg.textAlign, 'important');
                    if (header.style.display === 'flex' || getComputedStyle(header).display === 'flex') {
                        header.style.setProperty('justify-content', cfg.textAlign === 'left' ? 'flex-start' : (cfg.textAlign === 'right' ? 'flex-end' : 'center'), 'important');
                    }
                    const textEls = header.querySelectorAll('span, div, p, h1, h2, h3, h4');
                    textEls.forEach(el => {
                        el.style.setProperty('text-align', cfg.textAlign, 'important');
                        if (getComputedStyle(el).display === 'flex') {
                            el.style.setProperty('justify-content', cfg.textAlign === 'left' ? 'flex-start' : (cfg.textAlign === 'right' ? 'flex-end' : 'center'), 'important');
                        }
                    });
                }
            }

            const body = nodeEl.querySelector('[data-testid*="body"], .comfy-body, .comfy-content, .node-body, .content');
            if (body) {
                body.style.setProperty('background', 'transparent', 'important');
                body.style.setProperty('background-color', 'transparent', 'important');
            }
        });
    },

    removeThemeFromNodes(nodes) {
        if (!nodes || !nodes.length) return;

        nodes.forEach(node => {
            delete node._xzgGradient;
            node.color = null;
            node.bgcolor = null;
            this.removeGradientFromDOMNode(node);
        });

        if (app.graph) {
            app.graph.setDirtyCanvas?.(true, true);
            app.graph.change?.();
        }
    },

    removeGradientFromDOMNode(node) {
        const graphCanvas = document.getElementById("graph-canvas");
        if (!graphCanvas) return;

        const nodeEls = graphCanvas.querySelectorAll(
            `[data-node-id="${node.id}"], [data-id="${node.id}"], #node-${node.id}`
        );
        
        nodeEls.forEach(nodeEl => {
            const inner = nodeEl.querySelector('[data-testid="node-inner-wrapper"]') || nodeEl;
            inner.style.removeProperty('background');
            inner.style.removeProperty('background-color');
            inner.style.removeProperty('--component-node-background');
            inner.style.removeProperty('--component-node-header');

            const allChilds = nodeEl.querySelectorAll('*');
            allChilds.forEach(child => {
                child.style.removeProperty('background');
                child.style.removeProperty('background-color');
            });

            const headerSelectors = [
                '[data-testid*="header"]', '.comfy-header', '.comfy-title', 
                '.node-header', '.node-title', '.litegraph .title',
                '.node-titlebar', '.title-bar', '.litemenu-title'
            ];
            const header = nodeEl.querySelector(headerSelectors.join(', '));
            if (header) {
                header.style.removeProperty('color');
                header.style.removeProperty('font-size');
                header.style.removeProperty('text-align');
                header.style.removeProperty('justify-content');
                const allChilds = header.querySelectorAll('*');
                allChilds.forEach(child => {
                    child.style.removeProperty('font-size');
                    child.style.removeProperty('text-align');
                    child.style.removeProperty('justify-content');
                    child.style.removeProperty('flex');
                });
            }
        });
    },

    getSelectedNodes() {
        if (!window.app || !app.canvas) return [];
        const canvas = app.canvas;
        if (canvas.selected_nodes) {
            const nodes = Object.values(canvas.selected_nodes);
            if (nodes.length > 0) return nodes;
        }
        return [];
    },

    getTopLeftNode(nodes) {
        if (!nodes || nodes.length === 0) return null;
        if (nodes.length === 1) return nodes[0];
        
        let topLeft = nodes[0];
        for (let i = 1; i < nodes.length; i++) {
            const node = nodes[i];
            const nodeY = node.pos ? node.pos[1] : 0;
            const topLeftY = topLeft.pos ? topLeft.pos[1] : 0;
            const nodeX = node.pos ? node.pos[0] : 0;
            const topLeftX = topLeft.pos ? topLeft.pos[0] : 0;
            
            if (nodeY < topLeftY) {
                topLeft = node;
            } else if (nodeY === topLeftY && nodeX < topLeftX) {
                topLeft = node;
            }
        }
        return topLeft;
    },

    getNodeGradient(node) {
        if (!node || !node._xzgGradient) return null;
        const cfg = node._xzgGradient;
        const useTitleGradient = cfg.useTitleGradient && cfg.titleStops && cfg.titleStops.length > 0;
        return {
            color1: cfg.stops[0]?.color || '#e65c5c',
            color2: cfg.stops[1]?.color || '#4fc94f',
            color3: cfg.stops[2]?.color || '#4d94e6',
            direction: cfg.direction || '90',
            titleColor1: useTitleGradient ? (cfg.titleStops[0]?.color || '#e49c00') : undefined,
            titleColor2: useTitleGradient ? (cfg.titleStops[1]?.color || '#000000') : undefined,
            titleColor3: useTitleGradient ? (cfg.titleStops[2]?.color || '#005149') : undefined,
            titleDirection: cfg.titleDirection || '90',
            useTitleGradient: useTitleGradient,
            titleText: cfg.titleText || '#ffffff',
            useGradient: cfg.useGradient !== false,
            fontSize: cfg.fontSize || 14,
            textAlign: cfg.textAlign || 'left'
        };
    },

    setupContextMenu() {
        const self = this;

        const checkShortcut = (e) => {
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) {
                return false;
            }
            const panel = window.XZGThemePanel;
            if (!panel) return false;
            const shortcut = panel.getShortcut();
            if (!shortcut || !shortcut.key) return false;
            const key = e.key.toLowerCase();
            if (key !== shortcut.key.toLowerCase()) return false;
            if (!!e.ctrlKey !== !!shortcut.ctrl) return false;
            if (!!e.altKey !== !!shortcut.alt) return false;
            if (!!e.shiftKey !== !!shortcut.shift) return false;
            if (!!e.metaKey !== !!shortcut.meta) return false;
            return true;
        };

        this._shortcutHandler = (e) => {
            if (checkShortcut(e)) {
                e.preventDefault();
                const panel = window.XZGThemePanel;
                if (panel && panel.isVisible) {
                    panel.hide();
                } else {
                    const nodes = self.getSelectedNodes();
                    if (nodes.length > 0) {
                        self.currentNodes = nodes;
                        self.showPanelForNodes(nodes);
                    } else {
                        self.showPanel();
                    }
                }
            }
        };
        document.addEventListener("keydown", this._shortcutHandler);

        if (window.XZGThemePanel) {
            window.XZGThemePanel.onThemeChange = (theme) => {
                const nodes = self.getSelectedNodes();
                if (nodes && nodes.length > 0) {
                    self.currentNodes = nodes;
                    const colors = {
                        color1: theme.colors.color1,
                        color2: theme.colors.color2,
                        color3: theme.colors.color3,
                        direction: theme.colors.direction,
                        titleColor1: theme.colors.titleColor1,
                        titleColor2: theme.colors.titleColor2,
                        titleColor3: theme.colors.titleColor3,
                        titleDirection: theme.colors.titleDirection,
                        useTitleGradient: theme.colors.useTitleGradient,
                        titleText: theme.colors.titleText,
                        useGradient: theme.colors.useGradient,
                        fontSize: theme.colors.fontSize,
                        textAlign: theme.colors.textAlign
                    };
                    self.applyThemeToNodes(nodes, colors);
                }
            };
            window.XZGThemePanel.onApply = (colors) => {
                const nodes = self.getSelectedNodes();
                if (nodes && nodes.length > 0) {
                    self.currentNodes = nodes;
                    const themeColors = {
                        color1: colors.color1,
                        color2: colors.color2,
                        color3: colors.color3,
                        direction: colors.direction,
                        titleColor1: colors.titleColor1,
                        titleColor2: colors.titleColor2,
                        titleColor3: colors.titleColor3,
                        titleDirection: colors.titleDirection,
                        useTitleGradient: colors.useTitleGradient,
                        titleText: colors.textColor,
                        useGradient: colors.useGradient,
                        fontSize: colors.fontSize,
                        textAlign: colors.textAlign
                    };
                    self.applyThemeToNodes(nodes, themeColors);
                }
            };
            window.XZGThemePanel.onReset = () => {
                const nodes = self.getSelectedNodes();
                if (nodes && nodes.length > 0) {
                    self.currentNodes = nodes;
                    self.removeThemeFromNodes(nodes);
                }
            };
        }

        this.setupSelectionListener();
        this.setupCanvasContextMenu();

        const observer = new MutationObserver(() => {
            self.refreshDOMGradients();
        });
        
        const graphCanvas = document.getElementById("graph-canvas");
        if (graphCanvas) {
            observer.observe(graphCanvas, { 
                childList: true, 
                subtree: true 
            });
        }
    },

    setupCanvasContextMenu() {
        const self = this;

        if (!window.LGraphCanvas || !LGraphCanvas.prototype) return;

        const origGetCanvasMenuOptions = LGraphCanvas.prototype.getCanvasMenuOptions;
        LGraphCanvas.prototype.getCanvasMenuOptions = function() {
            const options = origGetCanvasMenuOptions.apply(this, arguments);

            let shortcutText = "";
            try {
                const stored = localStorage.getItem("xzg_theme_shortcut");
                if (stored) {
                    const sc = JSON.parse(stored);
                    const parts = [];
                    if (sc.ctrl) parts.push("Ctrl");
                    if (sc.alt) parts.push("Alt");
                    if (sc.shift) parts.push("Shift");
                    parts.push(sc.key.toUpperCase());
                    shortcutText = ` <span style="color:#888;font-size:10px;">快捷键${parts.join("+")}</span>`;
                }
            } catch (e) {}

            options.push(null, {
                content: `<span style="color:#FFD700;">🎨 小珠光主题${shortcutText}</span>`,
                callback: (value, options, event) => {
                    const nodes = self.getSelectedNodes();
                    if (nodes.length > 0) {
                        self.currentNodes = nodes;
                        self.showPanelForNodes(nodes);
                    } else {
                        self.showPanel();
                    }
                }
            });

            return options;
        };
    },

    setupSelectionListener() {
        const self = this;
        let lastSelectedIds = new Set();

        function checkSelectionChange() {
            if (!window.XZGThemePanel || !window.XZGThemePanel.isVisible) {
                lastSelectedIds = new Set();
                return;
            }
            
            const nodes = self.getSelectedNodes();
            const currentIds = new Set(nodes.map(n => n.id));
            
            let changed = false;
            if (currentIds.size !== lastSelectedIds.size) {
                changed = true;
            } else if (currentIds.size > 0) {
                for (const id of currentIds) {
                    if (!lastSelectedIds.has(id)) {
                        changed = true;
                        break;
                    }
                }
            }
            
            if (changed && currentIds.size > 0) {
                lastSelectedIds = currentIds;
                self.currentNodes = nodes;
                const refNode = self.getTopLeftNode(nodes);
                if (refNode) {
                    self.updatePanelFromNode(refNode);
                }
            }
        }

        setInterval(checkSelectionChange, 200);
    },

    updatePanelFromNode(node) {
        if (!window.XZGThemePanel) return;
        
        const grad = this.getNodeGradient(node);
        if (grad) {
            window.XZGThemePanel.setCurrentTheme({
                colors: {
                    color1: grad.color1,
                    color2: grad.color2,
                    color3: grad.color3,
                    direction: grad.direction,
                    titleColor1: grad.titleColor1,
                    titleColor2: grad.titleColor2,
                    titleColor3: grad.titleColor3,
                    titleDirection: grad.titleDirection,
                    useTitleGradient: grad.useTitleGradient,
                    titleText: grad.titleText,
                    useGradient: grad.useGradient,
                    fontSize: grad.fontSize,
                    textAlign: grad.textAlign
                }
            });
        } else {
            window.XZGThemePanel.resetToDefault();
        }
    },

    refreshDOMGradients() {
        if (!window.app || !app.graph) return;
        const nodes = app.graph._nodes || app.graph.nodes;
        if (!nodes) return;
        nodes.forEach(node => {
            if (node._xzgGradient) {
                this.applyGradientToDOMNode(node);
            }
        });
    },

    showPanelForNodes(nodes) {
        if (!window.XZGThemePanel) return;
        
        window.XZGThemePanel.create();
        
        if (nodes && nodes.length > 0) {
            this.currentNodes = nodes;
            const refNode = this.getTopLeftNode(nodes);
            if (refNode) {
                this.updatePanelFromNode(refNode);
            }
        }
        
        window.XZGThemePanel.show();
    },

    showPanel(x, y) {
        this.showPanelForNodes(this.currentNodes);
    },

    _initWallpaperDB() {
        const self = this;
        try {
            if (!window.indexedDB) {
                this._wpDBReady = true;
                return;
            }
            const request = indexedDB.open('XzgThemeWallpaper', 1);
            request.onupgradeneeded = function(e) {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('wallpapers')) {
                    db.createObjectStore('wallpapers', { keyPath: 'id' });
                }
            };
            request.onsuccess = function(e) {
                self._wpDB = e.target.result;
                self._wpDBReady = true;
                self._loadWallpaperFromDB();
                if (self._wpPendingSave) {
                    const pending = self._wpPendingSave;
                    self._wpPendingSave = null;
                    self._doSaveWallpaperToDB(pending.type, pending.data);
                }
            };
            request.onerror = function() {
                self._wpDBReady = true;
                console.warn('[小珠光主题] IndexedDB 打开失败，将使用 localStorage');
                if (self._wpPendingSave) {
                    const pending = self._wpPendingSave;
                    self._wpPendingSave = null;
                    try {
                        localStorage.setItem('xzg-wallpaper-data', pending.data);
                        localStorage.setItem('xzg-wallpaper-type', pending.type);
                    } catch(e) {
                        console.warn('[小珠光主题] 壁纸数据过大，无法保存到 localStorage', e);
                    }
                }
            };
        } catch(e) {
            this._wpDBReady = true;
            console.warn('[小珠光主题] IndexedDB 初始化失败', e);
        }
    },

    _loadWallpaperFromDB() {
        const self = this;
        if (!this._wpDB) return;

        try {
            const oldData = localStorage.getItem('xzg-wallpaper-data');
            if (oldData && oldData.length > 1000) {
                this._saveWallpaperToDB(this.wallpaperType, oldData);
                try { localStorage.removeItem('xzg-wallpaper-data'); } catch(e) {}
                if (this.wallpaperActive && app.canvas) {
                    this._setCanvasTransparent(true);
                    this._applyWallpaper();
                }
                return;
            }
        } catch(e) {}

        try {
            const transaction = this._wpDB.transaction(['wallpapers'], 'readonly');
            const store = transaction.objectStore('wallpapers');
            const request = store.get('current');
            request.onsuccess = function(e) {
                const result = e.target.result;
                if (result && result.data) {
                    self.wallpaperData = result.data;
                    if (result.type) {
                        self.wallpaperType = result.type;
                        try { localStorage.setItem('xzg-wallpaper-type', result.type); } catch(e) {}
                    }
                    const applyWhenReady = () => {
                        if (!app.canvas) {
                            setTimeout(applyWhenReady, 50);
                            return;
                        }
                        if (self.wallpaperActive && self.wallpaperData) {
                            if (!self._wpBgCanvas) {
                                self._createBgCanvas();
                            }
                            if (!self._wpHooked) {
                                self._hookRenderBackground();
                            }
                            self._setCanvasTransparent(true);
                            self._applyWallpaper();
                        }
                    };
                    applyWhenReady();
                }
            };
        } catch(e) {
            console.warn('[小珠光主题] 从 IndexedDB 读取壁纸失败', e);
        }
    },

    _saveWallpaperToDB(type, data) {
        if (!this._wpDBReady) {
            this._wpPendingSave = { type: type, data: data };
            return true;
        }
        if (!this._wpDB) return false;
        return this._doSaveWallpaperToDB(type, data);
    },

    _doSaveWallpaperToDB(type, data) {
        if (!this._wpDB) return false;
        const self = this;
        try {
            const transaction = this._wpDB.transaction(['wallpapers'], 'readwrite');
            const store = transaction.objectStore('wallpapers');
            const request = store.put({ id: 'current', type: type, data: data });
            transaction.oncomplete = function() {
                try { localStorage.removeItem('xzg-wallpaper-data'); } catch(e) {}
            };
            transaction.onerror = function(e) {
                console.warn('[小珠光主题] 保存壁纸到 IndexedDB 失败', e);
                try {
                    localStorage.setItem('xzg-wallpaper-data', data);
                    localStorage.setItem('xzg-wallpaper-type', type);
                } catch(e2) {
                    console.warn('[小珠光主题] 壁纸数据过大，无法保存', e2);
                }
            };
            return true;
        } catch(e) {
            console.warn('[小珠光主题] 保存壁纸到 IndexedDB 异常', e);
            return false;
        }
    },

    _deleteWallpaperFromDB() {
        if (!this._wpDB) {
            this._wpPendingSave = null;
            return;
        }
        try {
            const transaction = this._wpDB.transaction(['wallpapers'], 'readwrite');
            const store = transaction.objectStore('wallpapers');
            store.delete('current');
        } catch(e) {}
    },

    initWallpaper() {
        const self = this;
        const tryInit = () => {
            if (!window.app || !app.canvas) {
                setTimeout(tryInit, 100);
                return;
            }
            self._createBgCanvas();
            self._hookRenderBackground();
            if (self.wallpaperActive && self.wallpaperData) {
                self._setCanvasTransparent(true);
                self._applyWallpaper();
            }
        };
        tryInit();
    },

    _createBgCanvas() {
        if (this._wpBgCanvas) return;
        const canvasEl = app.canvas.canvas;
        if (!canvasEl) return;

        const bgCanvas = document.createElement('canvas');
        bgCanvas.id = 'xzg-wallpaper-canvas';
        bgCanvas.style.position = 'absolute';
        bgCanvas.style.left = '0';
        bgCanvas.style.top = '0';
        bgCanvas.style.zIndex = '0';
        bgCanvas.style.pointerEvents = 'none';

        const parent = canvasEl.parentElement;
        if (parent) {
            parent.insertBefore(bgCanvas, canvasEl);
        }

        this._wpBgCanvas = bgCanvas;
        this._wpBgCtx = bgCanvas.getContext('2d');

        const resizeBgCanvas = () => {
            if (!this._wpBgCanvas) return;
            const rect = canvasEl.getBoundingClientRect();
            this._wpBgCanvas.width = canvasEl.width;
            this._wpBgCanvas.height = canvasEl.height;
            this._wpBgCanvas.style.width = canvasEl.style.width || rect.width + 'px';
            this._wpBgCanvas.style.height = canvasEl.style.height || rect.height + 'px';
            this._wpDrawCache = null;
            if (this.wallpaperActive && this.wallpaperData) {
                this._renderWallpaperToBgCanvas();
            }
        };

        resizeBgCanvas();
        const ro = new ResizeObserver(resizeBgCanvas);
        ro.observe(canvasEl);
        this._wpResizeObserver = ro;
    },

    _hookRenderBackground() {
        if (this._wpHooked) return;
        if (!app.canvas) return;

        const canvas = app.canvas;
        const self = this;
        const origCallback = canvas.onRenderBackground;

        canvas.onRenderBackground = function(cvs, ctx) {
            if (origCallback) {
                const result = origCallback.call(this, cvs, ctx);
                if (result) return true;
            }

            if (self.wallpaperActive && self.wallpaperData) {
                return true;
            }

            return false;
        };

        this._wpOrigOnRenderBackground = origCallback;
        this._wpHooked = true;
        console.log('[小珠光主题] 壁纸背景 Hook 已安装 ✓');
    },

    _drawMediaBackground(cvs, ctx, media) {
        const w = cvs.width;
        const h = cvs.height;
        const mediaW = media.naturalWidth || media.videoWidth || 0;
        const mediaH = media.naturalHeight || media.videoHeight || 0;
        if (!mediaW || !mediaH) return;

        const cacheKey = w + '_' + h + '_' + mediaW + '_' + mediaH + '_' + this.wallpaperFit + '_' + this.wallpaperOpacity;
        if (this._wpDrawCache && this._wpDrawCache.key === cacheKey) {
            const c = this._wpDrawCache;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(c.bgCanvas, 0, 0);
            ctx.save();
            ctx.globalAlpha = this.wallpaperOpacity;
            ctx.drawImage(media, c.dx, c.dy, c.dw, c.dh);
            ctx.restore();
            ctx.restore();
            return;
        }

        const fit = this.wallpaperFit || 'cover';
        let dx = 0, dy = 0, dw = w, dh = h;

        if (fit === 'cover') {
            const scale = Math.max(w / mediaW, h / mediaH);
            dw = mediaW * scale;
            dh = mediaH * scale;
            dx = (w - dw) / 2;
            dy = (h - dh) / 2;
        } else if (fit === 'contain') {
            const scale = Math.min(w / mediaW, h / mediaH);
            dw = mediaW * scale;
            dh = mediaH * scale;
            dx = (w - dw) / 2;
            dy = (h - dh) / 2;
        } else if (fit === 'fill') {
            dw = w;
            dh = h;
        }

        if (!this._wpDrawCache) {
            this._wpDrawCache = {};
        }
        this._wpDrawCache.key = cacheKey;
        this._wpDrawCache.dx = dx;
        this._wpDrawCache.dy = dy;
        this._wpDrawCache.dw = dw;
        this._wpDrawCache.dh = dh;
        if (!this._wpDrawCache.bgCanvas) {
            this._wpDrawCache.bgCanvas = document.createElement('canvas');
        }
        const bgCanvas = this._wpDrawCache.bgCanvas;
        bgCanvas.width = w;
        bgCanvas.height = h;
        const bgCtx = bgCanvas.getContext('2d');
        bgCtx.fillStyle = '#000000';
        bgCtx.fillRect(0, 0, w, h);

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(bgCanvas, 0, 0);
        ctx.save();
        ctx.globalAlpha = this.wallpaperOpacity;
        ctx.drawImage(media, dx, dy, dw, dh);
        ctx.restore();
        ctx.restore();
    },

    _renderWallpaperToBgCanvas() {
        if (!this._wpBgCanvas || !this._wpBgCtx) return;
        if (!this.wallpaperActive || !this.wallpaperData) return;

        const bgCanvas = this._wpBgCanvas;
        const bgCtx = this._wpBgCtx;
        const w = bgCanvas.width;
        const h = bgCanvas.height;

        if (this.wallpaperType === 'image' && this._wpImg && this._wpImgLoaded) {
            this._drawMediaToCtx(bgCanvas, bgCtx, this._wpImg);
        } else if (this.wallpaperType === 'video' && this._wpVideo && this._wpVideo.readyState >= 2) {
            this._drawMediaToCtx(bgCanvas, bgCtx, this._wpVideo);
        } else {
            bgCtx.fillStyle = '#000000';
            bgCtx.fillRect(0, 0, w, h);
        }
    },

    _drawMediaToCtx(cvs, ctx, media) {
        const w = cvs.width;
        const h = cvs.height;
        const mediaW = media.naturalWidth || media.videoWidth || 0;
        const mediaH = media.naturalHeight || media.videoHeight || 0;
        if (!mediaW || !mediaH) return;

        const cacheKey = 'bg_' + w + '_' + h + '_' + mediaW + '_' + mediaH + '_' + this.wallpaperFit + '_' + this.wallpaperOpacity;
        if (this._wpBgDrawCache && this._wpBgDrawCache.key === cacheKey) {
            const c = this._wpBgDrawCache;
            ctx.drawImage(c.bgCanvas, 0, 0);
            ctx.globalAlpha = this.wallpaperOpacity;
            ctx.drawImage(media, c.dx, c.dy, c.dw, c.dh);
            ctx.globalAlpha = 1;
            return;
        }

        const fit = this.wallpaperFit || 'cover';
        let dx = 0, dy = 0, dw = w, dh = h;

        if (fit === 'cover') {
            const scale = Math.max(w / mediaW, h / mediaH);
            dw = mediaW * scale;
            dh = mediaH * scale;
            dx = (w - dw) / 2;
            dy = (h - dh) / 2;
        } else if (fit === 'contain') {
            const scale = Math.min(w / mediaW, h / mediaH);
            dw = mediaW * scale;
            dh = mediaH * scale;
            dx = (w - dw) / 2;
            dy = (h - dh) / 2;
        } else if (fit === 'fill') {
            dw = w;
            dh = h;
        }

        if (!this._wpBgDrawCache) {
            this._wpBgDrawCache = {};
        }
        this._wpBgDrawCache.key = cacheKey;
        this._wpBgDrawCache.dx = dx;
        this._wpBgDrawCache.dy = dy;
        this._wpBgDrawCache.dw = dw;
        this._wpBgDrawCache.dh = dh;
        if (!this._wpBgDrawCache.bgCanvas) {
            this._wpBgDrawCache.bgCanvas = document.createElement('canvas');
        }
        const blackCanvas = this._wpBgDrawCache.bgCanvas;
        blackCanvas.width = w;
        blackCanvas.height = h;
        const blackCtx = blackCanvas.getContext('2d');
        blackCtx.fillStyle = '#000000';
        blackCtx.fillRect(0, 0, w, h);

        ctx.drawImage(blackCanvas, 0, 0);
        ctx.globalAlpha = this.wallpaperOpacity;
        ctx.drawImage(media, dx, dy, dw, dh);
        ctx.globalAlpha = 1;
    },

    _applyWallpaper() {
        if (!this.wallpaperActive || !this.wallpaperData) return;
        if (!this._wpHooked) {
            this._hookRenderBackground();
        }
        if (!this._wpBgCanvas) {
            this._createBgCanvas();
        }

        if (this.wallpaperType === 'image') {
            if (!this._wpImg) {
                this._wpImg = new Image();
                const self = this;
                this._wpImg.onload = function() {
                    self._wpImgLoaded = true;
                    self._renderWallpaperToBgCanvas();
                    if (app.canvas?.setDirty) {
                        app.canvas.setDirty(true, true);
                    }
                };
            }
            this._wpImg.src = this.wallpaperData;
            this._wpImgLoaded = false;
        } else if (this.wallpaperType === 'video') {
            this._startVideoWallpaper();
        }

        if (app.canvas?.setDirty) {
            app.canvas.setDirty(true, true);
        }
    },

    _startVideoWallpaper() {
        if (!app.canvas) return;
        const self = this;

        if (!this._wpVideo) {
            this._wpVideo = document.createElement('video');
            this._wpVideo.muted = true;
            this._wpVideo.loop = true;
            this._wpVideo.playsInline = true;
            this._wpVideo.style.display = 'none';
            document.body.appendChild(this._wpVideo);

            this._wpVideo.addEventListener('loadeddata', function() {
                if (self.wallpaperActive && self.wallpaperType === 'video') {
                    self._renderWallpaperToBgCanvas();
                    if (app.canvas?.setDirty) {
                        app.canvas.setDirty(true, true);
                    }
                }
            });

            document.addEventListener('visibilitychange', () => {
                if (!self._wpVideoPlaying) return;
                if (document.hidden) {
                    self._wpVideo.pause();
                } else {
                    self._wpVideo.play().catch(() => {});
                }
            });
        }

        if (this._wpVideoSrc === this.wallpaperData && this._wpVideoPlaying) {
            return;
        }

        this._wpVideoSrc = this.wallpaperData;
        this._wpVideo.src = this.wallpaperData;
        this._wpVideo.load();
        this._wpVideo.play().then(() => {
            self._wpVideoPlaying = true;
            self._wpVideoFrame();
        }).catch(() => {
            self._wpVideoPlaying = false;
        });
    },

    _wpVideoFrame() {
        if (!this.wallpaperActive || !this._wpVideoPlaying || !this._wpVideo) return;
        if (this.wallpaperType !== 'video') return;

        const now = performance.now();
        const minInterval = 1000 / 30;
        if (this._wpLastFrameTime && (now - this._wpLastFrameTime) < minInterval) {
            const self = this;
            requestAnimationFrame(() => self._wpVideoFrame());
            return;
        }
        this._wpLastFrameTime = now;

        this._renderWallpaperToBgCanvas();

        const video = this._wpVideo;
        if (video.requestVideoFrameCallback) {
            video.requestVideoFrameCallback(() => this._wpVideoFrame());
        } else {
            requestAnimationFrame(() => this._wpVideoFrame());
        }
    },

    setWallpaperActive(active) {
        this.wallpaperActive = active;
        try {
            localStorage.setItem('xzg-wallpaper-active', active ? 'true' : 'false');
        } catch(e) {}

        if (active && this.wallpaperData) {
            this._applyWallpaper();
            this._setCanvasTransparent(true);
        } else if (!active) {
            if (this._wpVideo) {
                this._wpVideo.pause();
                this._wpVideoPlaying = false;
            }
            this._wpImgLoaded = false;
            this._setCanvasTransparent(false);
        }

        if (app.canvas?.setDirty) {
            app.canvas.setDirty(true, true);
        }
    },

    _setCanvasTransparent(transparent) {
        if (!app.canvas) return;
        const canvasEl = app.canvas.canvas;
        if (!canvasEl) return;

        if (transparent) {
            if (app.canvas.clear_color) {
                this._wpOrigClearColor = app.canvas.clear_color;
            }
            app.canvas.clear_color = 'transparent';
            if (app.canvas.bg_color) {
                this._wpOrigBgColor = app.canvas.bg_color;
            }
            app.canvas.bg_color = 'transparent';
            canvasEl.style.backgroundColor = 'transparent';
        } else {
            if (this._wpOrigClearColor !== undefined) {
                app.canvas.clear_color = this._wpOrigClearColor;
            }
            if (this._wpOrigBgColor !== undefined) {
                app.canvas.bg_color = this._wpOrigBgColor;
            }
            canvasEl.style.backgroundColor = '';
        }
    },

    setWallpaperData(type, data) {
        this.wallpaperType = type;
        this.wallpaperData = data;
        this._wpBgDrawCache = null;
        try {
            localStorage.setItem('xzg-wallpaper-type', type);
        } catch(e) {}
        const savedToDB = this._saveWallpaperToDB(type, data);
        if (!savedToDB) {
            try {
                localStorage.setItem('xzg-wallpaper-data', data);
            } catch(e) {
                console.warn('[小珠光主题] 壁纸数据过大，无法保存', e);
            }
        }
        if (!this.wallpaperActive) {
            this.setWallpaperActive(true);
        } else {
            this._applyWallpaper();
        }
    },

    setWallpaperOpacity(opacity) {
        this.wallpaperOpacity = opacity;
        this._wpBgDrawCache = null;
        try {
            localStorage.setItem('xzg-wallpaper-opacity', String(opacity));
        } catch(e) {}
        this._renderWallpaperToBgCanvas();
        if (app.canvas?.setDirty) {
            app.canvas.setDirty(true, true);
        }
    },

    setWallpaperFit(fit) {
        this.wallpaperFit = fit;
        this._wpBgDrawCache = null;
        try {
            localStorage.setItem('xzg-wallpaper-fit', fit);
        } catch(e) {}
        this._renderWallpaperToBgCanvas();
        if (app.canvas?.setDirty) {
            app.canvas.setDirty(true, true);
        }
    },

    clearWallpaper() {
        this.wallpaperData = null;
        this.wallpaperActive = false;
        this._setCanvasTransparent(false);
        this._deleteWallpaperFromDB();
        try {
            localStorage.removeItem('xzg-wallpaper-data');
            localStorage.setItem('xzg-wallpaper-active', 'false');
        } catch(e) {}
        if (this._wpImg) {
            this._wpImg.src = '';
            this._wpImgLoaded = false;
        }
        if (this._wpVideo) {
            this._wpVideo.pause();
            this._wpVideo.src = '';
            this._wpVideoPlaying = false;
            this._wpVideoSrc = '';
        }
        this._wpBgDrawCache = null;
        if (this._wpBgCanvas && this._wpBgCtx) {
            this._wpBgCtx.clearRect(0, 0, this._wpBgCanvas.width, this._wpBgCanvas.height);
        }
        if (app.canvas?.setDirty) {
            app.canvas.setDirty(true, true);
        }
    },

    waitForComfyUI() {
        return new Promise((resolve) => {
            const check = () => {
                if (window.app && window.app.graph && window.LiteGraph) {
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }
};

(function initThemeWhenReady() {
    if (window.XZGThemePresets && window.XZGThemePanel) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => {
                window.XZGThemeManager.init();
            });
        } else {
            window.XZGThemeManager.init();
        }
    } else {
        setTimeout(initThemeWhenReady, 50);
    }
})();

(function registerExtensionEarly() {
    function tryRegister() {
        if (window.app && typeof window.app.registerExtension === "function") {
            try {
                app.registerExtension({
                    name: "XZG.Theme",
                    
                    getNodeMenuItems(node) {
                        if (!window.XZGThemeManager) return [];
                        
                        const canvas = app.canvas;
                        let nodes = [];
                        if (canvas.selected_nodes && canvas.selected_nodes[node.id]) {
                            nodes = Object.values(canvas.selected_nodes);
                        } else {
                            nodes = [node];
                        }
                        nodes = nodes.filter(n => n.type !== "XiaozhuguangTitle");
                        if (!nodes.length) return [];
                        
                        let shortcutText = "";
                        try {
                            const stored = localStorage.getItem("xzg_theme_shortcut");
                            if (stored) {
                                const sc = JSON.parse(stored);
                                const parts = [];
                                if (sc.ctrl) parts.push("Ctrl");
                                if (sc.alt) parts.push("Alt");
                                if (sc.shift) parts.push("Shift");
                                parts.push(sc.key.toUpperCase());
                                shortcutText = ` <span style="color:#888;font-size:10px;">快捷键${parts.join("+")}</span>`;
                            }
                        } catch (e) {}
                        return [
                            null,
                            {
                                content: nodes.length > 1
                                    ? `<span style="color:#FFD700;">🎨 小珠光主题 (${nodes.length})${shortcutText}</span>`
                                    : `<span style="color:#FFD700;">🎨 小珠光主题${shortcutText}</span>`,
                                callback: () => {
                                    if (window.XZGThemeManager) {
                                        window.XZGThemeManager.currentNodes = nodes;
                                        window.XZGThemeManager.showPanelForNodes(nodes);
                                    }
                                }
                            }
                        ];
                    }
                });
            } catch(e) {}
        } else {
            setTimeout(tryRegister, 100);
        }
    }
    tryRegister();
})();
