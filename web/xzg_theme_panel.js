
import { xzgT } from "./xzg_i18n.js";
import { api } from "../../scripts/api.js";
import { cloudLoad, cloudSave, cloudUIInit, cloudUIQueueGeometry } from "./xzg_cloud_store.js";

// 主题面板设置云存储键（预设/快捷键/最近色/标签页）
const THEME_PANEL_STATE_KEY = "xzg_theme_panel_state";
const XZG_EXPORT_CATEGORIES = [
    ["theme", "主题与外观", "Theme & Appearance", "已云端持久化", "Cloud-backed"],
    ["favorites", "节点收藏", "Node Favorites", "部分云端同步", "Partially cloud-backed"],
    ["title", "标题与标题样式", "Titles & Styles", "已云端持久化", "Cloud-backed"],
    ["workflows", "工作流管理器", "Workflow Manager", "已云端持久化", "Cloud-backed"],
    ["groups", "编组与标题节点", "Groups & Title Nodes", "已云端持久化", "Cloud-backed"],
    ["quickLinks", "快速连线", "Quick Links", "已云端持久化", "Cloud-backed"],
    ["menuHide", "菜单隐藏", "Menu Hiding", "已云端持久化", "Cloud-backed"],
    ["skills", "提示词规则预设", "Prompt Rule Presets", "已云端持久化", "Cloud-backed"],
    ["textBoxGodPresets", "文本框化神级预设（含缩略图）", "Text Box God-Tier Presets (with previews)", "云端及服务端持久化", "Cloud and server-backed"],
    ["mediaLibrary", "资源媒体库图片", "Media Library Images", "服务端持久化", "Server-backed"],
    ["audioLibrary", "资源媒体库音频", "Media Library Audio", "服务端持久化", "Server-backed"],
    ["videoLibrary", "资源媒体库视频", "Media Library Videos", "服务端持久化", "Server-backed"],
    ["notes", "记事本", "Notepad", "已云端持久化", "Cloud-backed"],
    ["align", "田字格对齐", "Grid Alignment", "已云端持久化", "Cloud-backed"],
    ["sidebar", "侧边栏偏好", "Sidebar Preferences", "已云端持久化", "Cloud-backed"],
    ["monitor", "GPU/CPU 监控悬浮窗", "GPU/CPU Monitor", "已云端持久化", "Cloud-backed"],
    ["shortcuts", "小珠光自定义快捷键", "XZG Custom Shortcuts", "服务端持久化", "Server-backed"],
];

function xzgExportCategoryForKey(key) {
    // Internal cloud snapshots combine several selectable categories; omit them from export
    // so they cannot smuggle unchecked categories into an otherwise granular backup.
    if (key === "xzg_vram_settings") return null;
    if (key === "xzg_favorites_state" || key === "xzg_ui_state") return null;
    if (key === "xzg_audio_media_library_geometry") return "audioLibrary";
    if (key === "xzg_video_media_library_geometry") return "videoLibrary";
    if (key === "xzg_media_library_geometry" || key === "xzg_folder_dialog_geometry") return "mediaLibrary";
    if (key === "xiaozhuguang.notes") return "notes";
    if (key === "comfyui_xiaozhuguang" || /^xiaozhuguang\.Panel(Pos|Width|Height|SplitWidth)$/.test(key)) return "favorites";
    if (/^xzg_(title_presets|last_title_|last_title_config)/.test(key) || key === "xz_selector_dialog_pos") return "title";
    if (key === "xzg_workflows_meta" || /^xzg_wf_/.test(key) || key === "xzg_possess_mode" || key === "xiaozhuguang.Toggle.EnableWorkflows") return "workflows";
    if (/^xzg_(group_|toggle_|deleted_groups|groups_backup|shortcut$|toggle_shortcut$)/.test(key) || key === "xzg_title_state") return "groups";
    if (/^xzg_quick_nodes/.test(key)) return "quickLinks";
    if (key === "xzg-display-v1" || key === "xzg-float-state-v1") return "monitor";
    if (/^xzg-menu-hide/.test(key)) return "menuHide";
    if (/^xzg_prompt_(skill|rule)_/.test(key)) return "skills";
    if (key === "xzg_text_box_god_presets") return "textBoxGodPresets";
    if (/^xiaozhuguang\.tian\./.test(key) || key === "xzg_align_state") return "align";
    if (key === "xzg_comfy_sidebar_state") return "sidebar";
    if (/^(xzg_theme_|xzg-theme-|xzg_recent_colors$|xzg-link-|xzg-node-|xzg-wallpaper-|xzg-laser-)/.test(key)) return "theme";
    return null;
}

window.XZGThemePanel = {
    panel: null,
    colorPicker: null,
    isVisible: false,
    currentTheme: null,
    onThemeChange: null,
    onApply: null,
    onReset: null,
    onClose: null,
    isDragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
    positionKey: "xzg_theme_panel_pos",
    isUpdatingFromNode: false,
    activeColorInput: null,
    pickerState: { h: 240, s: 80, l: 60, a: 1 },
    isDraggingSV: false,
    isDraggingHue: false,
    isDraggingAlpha: false,
    eyedropperActive: false,
    // 缓存最近使用颜色 (最多12个)
    recentColors: [],
    maxRecentColors: 12,
    // 主题面板设置云持久化
    _themePanelCloudTimer: null,

    defaults: {
        color1: "#e49c00",
        color2: "#000000",
        color3: "#005149",
        direction: "90",
        titleColor1: "#e49c00",
        titleColor2: "#000000",
        titleColor3: "#005149",
        titleDirection: "90",
        useTitleGradient: false,
        textColor: "#ffffff",
        useGradient: true,
        fontSize: 14,
        textAlign: "left",
        linkColor: "#888888"
    },

    defaultPresets: [
        {
            color1: "#ff6b6b", color2: "#feca57", color3: "#48dbfb",
            direction: "135",
            titleColor1: "#ee5a24", titleColor2: "#f368e0", titleColor3: "#ff9f43",
            titleDirection: "135", useTitleGradient: false,
            textColor: "#ffffff", fontSize: 14, textAlign: "left"
        },
        {
            color1: "#667eea", color2: "#764ba2", color3: "#f093fb",
            direction: "135",
            titleColor1: "#5f2c82", titleColor2: "#49a09d", titleColor3: "#6dd5ed",
            titleDirection: "135", useTitleGradient: false,
            textColor: "#ffffff", fontSize: 14, textAlign: "left"
        },
        {
            color1: "#11998e", color2: "#38ef7d", color3: "#56ab2f",
            direction: "0",
            titleColor1: "#134e5e", titleColor2: "#71b280", titleColor3: "#a8e063",
            titleDirection: "0", useTitleGradient: false,
            textColor: "#ffffff", fontSize: 14, textAlign: "left"
        },
        {
            color1: "#232526", color2: "#414345", color3: "#5d6d7e",
            direction: "0",
            titleColor1: "#0f0c29", titleColor2: "#302b63", titleColor3: "#24243e",
            titleDirection: "0", useTitleGradient: false,
            textColor: "#ffffff", fontSize: 14, textAlign: "left"
        },
        {
            color1: "#f093fb", color2: "#f5576c", color3: "#fa709a",
            direction: "90",
            titleColor1: "#ff758c", titleColor2: "#ff7eb3", titleColor3: "#fbc2eb",
            titleDirection: "90", useTitleGradient: false,
            textColor: "#ffffff", fontSize: 14, textAlign: "left"
        }
    ],

    create() {
        if (this.panel) return this.panel;

        const panel = document.createElement("div");
        panel.id = "xzg-theme-panel";
        panel.className = "xzg-theme-panel";
        // 加载最近颜色
        this.loadRecentColors();

        panel.innerHTML = `
            <div class="xzg-theme-header">
                <span class="xzg-theme-title">${xzgT('小珠光','Xiaozhuguang')}</span>
                <div class="xzg-theme-header-btns">
                    <button type="button" class="xzg-theme-shortcut-btn" id="xzg-theme-shortcut-btn"></button>
                    <button type="button" class="xzg-theme-close">×</button>
                </div>
            </div>
            <div class="xzg-top-tabs">
                <button type="button" class="xzg-top-tab active" data-top-tab="theme">${xzgT('主题','Theme')}</button>
                <button type="button" class="xzg-top-tab" data-top-tab="themeplus">${xzgT('主题+','Theme+')}</button>
                <button type="button" class="xzg-top-tab" data-top-tab="menuhide">${xzgT('菜单隐藏','Menu Hide')}</button>
                <button type="button" class="xzg-top-tab" data-top-tab="quicknodes">${xzgT('快速连线','Quick Links')}</button>
            </div>
            <div class="xzg-tab-content" data-tab-content="theme">
            <div class="xzg-picker-section">
                <div class="xzg-sv-area" id="xzg-sv-area">
                    <div class="xzg-sv-white"></div>
                    <div class="xzg-sv-black"></div>
                    <div class="xzg-sv-cursor" id="xzg-sv-cursor"><svg viewBox="0 0 18 18" width="18" height="18" style="position:absolute;left:-9px;top:-9px;pointer-events:none;"><circle cx="9" cy="9" r="7" fill="none" stroke="#fff" stroke-width="2"/><circle cx="9" cy="9" r="3" fill="none" stroke="#fff" stroke-width="1.5"/></svg></div>
                </div>
                <div class="xzg-hue-row">
                    <div class="xzg-hue-bar" id="xzg-hue-bar">
                        <div class="xzg-hue-cursor" id="xzg-hue-cursor"></div>
                    </div>
                </div>

            </div>
            <div class="xzg-theme-content">
                <div class="xzg-theme-section">
                    <div class="xzg-color-swatches">
                        <div class="xzg-swatch-group">
                            <span class="xzg-swatch-label">${xzgT('标题栏','Title Bar')}</span>
                            <button type="button" class="xzg-toggle-switch xzg-title-gradient-toggle" data-checked="false">
                                <span class="xzg-toggle-slider"></span>
                                <span class="xzg-toggle-label">${xzgT('关','Off')}</span>
                            </button>
                        </div>
                        <div class="xzg-swatch-group xzg-title-swatch-section" style="display: none;">
                            <div class="xzg-swatch-row">
                                <button type="button" class="xzg-color-swatch" data-color="titleColor1" style="background-color: ${this.defaults.titleColor1}"></button>
                                <button type="button" class="xzg-color-swatch" data-color="titleColor2" style="background-color: ${this.defaults.titleColor2}"></button>
                                <button type="button" class="xzg-color-swatch" data-color="titleColor3" style="background-color: ${this.defaults.titleColor3}"></button>
                            </div>
                            <div class="xzg-direction-buttons xzg-title-dir-buttons" style="display:flex;gap:2px;margin-left:4px;">
                                <button type="button" class="xzg-dir-btn" data-title-dir="0">↓</button>
                                <button type="button" class="xzg-dir-btn" data-title-dir="90">→</button>
                            </div>
                        </div>
                    </div>
                    
                    <div class="xzg-theme-separator"></div>
                    
                    <div class="xzg-color-swatches">
                        <div class="xzg-swatch-group">
                            <span class="xzg-swatch-label">${xzgT('主体','Body')}</span>
                            <div class="xzg-swatch-row">
                                <button type="button" class="xzg-color-swatch" data-color="color1" style="background-color: ${this.defaults.color1}"></button>
                                <button type="button" class="xzg-color-swatch" data-color="color2" style="background-color: ${this.defaults.color2}"></button>
                                <button type="button" class="xzg-color-swatch" data-color="color3" style="background-color: ${this.defaults.color3}"></button>
                            </div>
                        </div>
                    </div>
                    
                    <div class="xzg-theme-direction-row">
                        <span class="xzg-theme-label">${xzgT('主体方向','Body Direction')}</span>
                        <div class="xzg-direction-buttons">
                            <button type="button" class="xzg-dir-btn" data-dir="0">↓</button>
                            <button type="button" class="xzg-dir-btn" data-dir="90">→</button>
                            <button type="button" class="xzg-dir-btn" data-dir="45">↘</button>
                            <button type="button" class="xzg-dir-btn" data-dir="315">↗</button>
                        </div>
                    </div>
                    
                    <div class="xzg-theme-separator"></div>
                    
                    <div class="xzg-swatch-group">
                        <span class="xzg-swatch-label">${xzgT('文字颜色','Text Color')}</span>
                        <div class="xzg-swatch-row">
                            <button type="button" class="xzg-color-swatch xzg-text-swatch" data-color="textColor" style="background-color: ${this.defaults.textColor}"></button>
                        </div>
                    </div>
                    
                    <div class="xzg-theme-font-row">
                        <span class="xzg-theme-label">${xzgT('文字大小','Font Size')}</span>
                        <div class="xzg-font-size-control">
                            <button type="button" class="xzg-font-btn" data-size-action="decrease">A-</button>
                            <span class="xzg-font-size-value" id="xzg-font-size-value">${this.defaults.fontSize}</span>
                            <button type="button" class="xzg-font-btn" data-size-action="increase">A+</button>
                        </div>
                    </div>
                    
                    <div class="xzg-theme-font-row">
                        <span class="xzg-theme-label">${xzgT('文字位置','Text Align')}</span>
                        <div class="xzg-align-buttons">
                            <button type="button" class="xzg-align-btn" data-align="left">${xzgT('左','L')}</button>
                            <button type="button" class="xzg-align-btn active" data-align="center">${xzgT('中','C')}</button>
                            <button type="button" class="xzg-align-btn" data-align="right">${xzgT('右','R')}</button>
                        </div>
                    </div>
                    
                    <div style="display:flex;gap:6px;margin-bottom:6px;">
                        <button type="button" id="xzg-apply-btn" class="xzg-apply-btn" style="flex:1;margin:0;height:28px;padding:0 8px;line-height:28px;font-size:12px;">${xzgT('应用主题并关闭','Apply Theme & Close')}</button>
                        <button type="button" id="xzg-reset-btn" class="xzg-reset-btn" style="flex:1;margin:0;height:28px;padding:0 8px;line-height:28px;">${xzgT('恢复默认颜色','Reset Colors')}</button>
                    </div>
                    
                    <div class="xzg-theme-separator"></div>
                    
                    <div class="xzg-presets-section">
                        <div class="xzg-presets-header">
                            <span class="xzg-swatch-label">${xzgT('预设主题','Preset Themes')}</span>
                            <div class="xzg-presets-row">
                                <div class="xzg-preset-item" data-preset="0"></div>
                                <div class="xzg-preset-item" data-preset="1"></div>
                                <div class="xzg-preset-item" data-preset="2"></div>
                                <div class="xzg-preset-item" data-preset="3"></div>
                                <div class="xzg-preset-item" data-preset="4"></div>
                            </div>
                        </div>
                        <p class="xzg-presets-tip">${xzgT('左键应用，右键保存当前设置','Left-click apply, right-click save current')}</p>
                    </div>
                    </div>

                    <!-- <div class="xzg-link-highlight-section">
                        <span class="xzg-swatch-label">连线颜色</span>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <button type="button" class="xzg-color-swatch xzg-linkcolor-swatch" data-color="linkColor" style="background-color: ${this.defaults.linkColor};width:18px;height:18px;min-width:18px;border-radius:3px;" title="连线颜色"></button>
                            <button type="button" id="xzg-link-color-btn" class="xzg-toggle-switch xzg-link-color-toggle" data-checked="false" title="开启后，所有连线使用自定义颜色">
                                <span class="xzg-toggle-slider"></span>
                                <span class="xzg-toggle-label">${xzgT('关','Off')}</span>
                            </button>
                        </div>
                    </div> -->

                    <!-- <div class="xzg-link-highlight-section">
                        <span class="xzg-swatch-label">连线动画</span>
                        <button type="button" id="xzg-link-laser-btn" class="xzg-toggle-switch xzg-link-laser-toggle" data-checked="false" title="开启后，连线显示动画效果">
                            <span class="xzg-toggle-slider"></span>
                            <span class="xzg-toggle-label">${xzgT('关','Off')}</span>
                        </button>
                    </div>

                    <div class="xzg-link-highlight-section" id="xzg-anim-type-section" style="display:none;">
                        <span class="xzg-swatch-label" style="font-size:11px;color:#888;">动画风格</span>
                        <div style="display:flex;gap:3px;">
                            <button type="button" class="xzg-anim-type-btn active" data-anim="flow" title="流光溢彩">✦</button>
                            <button type="button" class="xzg-anim-type-btn" data-anim="gradient" title="颜色渐变">◆</button>
                            <button type="button" class="xzg-anim-type-btn" data-anim="breath" title="亮度呼吸">●</button>
                            <button type="button" class="xzg-anim-type-btn" data-anim="glow" title="辉光">☀</button>
                        </div>
                    </div> -->

                </div>
            </div>
            <div class="xzg-tab-content" data-tab-content="themeplus" style="display:none;">
                <div class="xzg-theme-content">

                    <div class="xzg-theme-separator"></div>

                    <div class="xzg-link-highlight-section">
                        <span class="xzg-swatch-label">${xzgT('连线高亮','Link Highlight')}</span>
                        <button type="button" id="xzg-link-highlight-btn" class="xzg-toggle-switch xzg-link-highlight-toggle" data-checked="false" title="${xzgT('开启后，选中节点的连线高亮，其他变暗','Highlight links of selected node, dim others')}">
                            <span class="xzg-toggle-slider"></span>
                            <span class="xzg-toggle-label">${xzgT('关','Off')}</span>
                        </button>
                    </div>

                    <div class="xzg-link-highlight-section" id="xzg-link-highlight-anim-type-row" style="display:none;">
                        <span class="xzg-swatch-label">${xzgT('高亮动画','Highlight Anim')}</span>
                        <select id="xzg-link-highlight-anim-type" style="background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:2px 6px;font-size:11px;">
                            <option value="none">${xzgT('无','None')}</option>
                            <option value="sparkle">${xzgT('七彩星芒','Sparkle')}</option>
                            <option value="pulse">${xzgT('吃豆人','Pac-Man')}</option>
                            <option value="crystal">${xzgT('水晶溪流','Crystal Stream')}</option>
                            <option value="quantum">${xzgT('量子场','Quantum Field')}</option>
                            <option value="energy">${xzgT('能量脉冲','Energy Pulse')}</option>
                            <option value="lava">${xzgT('熔岩流','Lava Flow')}</option>
                            <option value="stellar">${xzgT('恒星等离子','Stellar Plasma')}</option>
                            <option value="transfer">${xzgT('高速穿梭','Simple Transfer')}</option>
                            <option value="randspark">${xzgT('随机闪烁','Random Sparkle')}</option>
                            <option value="diy1">${xzgT('金星流动','Gold Star Flow')}</option>
                            <option value="diy2">${xzgT('紫色箭头','Purple Arrow')}</option>
                        </select>
                    </div>

                    <div class="xzg-link-highlight-section">
                        <span class="xzg-swatch-label">${xzgT('连线动画','Link Animation')}</span>
                        <button type="button" id="xzg-link-anim-btn" class="xzg-toggle-switch xzg-link-anim-toggle" data-checked="false" title="${xzgT('开启后，所有连线显示动画效果','Show animation effect on all links')}">
                            <span class="xzg-toggle-slider"></span>
                            <span class="xzg-toggle-label">${xzgT('关','Off')}</span>
                        </button>
                    </div>

                    <div class="xzg-link-highlight-section" id="xzg-link-anim-type-row" style="display:none;">
                        <span class="xzg-swatch-label">${xzgT('动画类型','Anim Type')}</span>
                        <select id="xzg-link-anim-type" style="background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:2px 6px;font-size:11px;">
                            <option value="sparkle">${xzgT('七彩星芒','Sparkle')}</option>
                            <option value="pulse">${xzgT('吃豆人','Pac-Man')}</option>
                            <option value="crystal">${xzgT('水晶溪流','Crystal Stream')}</option>
                            <option value="quantum">${xzgT('量子场','Quantum Field')}</option>
                            <option value="energy">${xzgT('能量脉冲','Energy Pulse')}</option>
                            <option value="lava">${xzgT('熔岩流','Lava Flow')}</option>
                            <option value="stellar">${xzgT('恒星等离子','Stellar Plasma')}</option>
                            <option value="transfer">${xzgT('高速穿梭','Simple Transfer')}</option>
                            <option value="randspark">${xzgT('随机闪烁','Random Sparkle')}</option>
                            <option value="diy1">${xzgT('金星流动','Gold Star Flow')}</option>
                            <option value="diy2">${xzgT('紫色箭头','Purple Arrow')}</option>
                        </select>
                    </div>

                    <div class="xzg-link-highlight-section" id="xzg-link-anim-speed-row" style="display:none;">
                        <span class="xzg-swatch-label">${xzgT('动画速度','Anim Speed')}</span>
                        <input type="range" id="xzg-link-anim-speed" min="0.1" max="3" step="0.1" value="1" style="flex:1;accent-color:#FFD700;">
                        <span id="xzg-link-anim-speed-val" style="min-width:32px;text-align:right;font-size:11px;color:#FFD700;">1.0x</span>
                    </div>

                    <div class="xzg-theme-separator"></div>

                    <div class="xzg-wallpaper-section">
                        <div class="xzg-wallpaper-header">
                            <span class="xzg-swatch-label">${xzgT('画布壁纸','Canvas Wallpaper')}</span>
                            <button type="button" id="xzg-wallpaper-btn" class="xzg-toggle-switch xzg-wallpaper-toggle" data-checked="false" title="${xzgT('开启画布壁纸背景','Enable canvas wallpaper background')}">
                                <span class="xzg-toggle-slider"></span>
                                <span class="xzg-toggle-label">${xzgT('关','Off')}</span>
                            </button>
                        </div>

                        <div class="xzg-wallpaper-controls" id="xzg-wallpaper-controls" style="display:none;">
                            <div class="xzg-wallpaper-upload-row">
                                <input type="file" id="xzg-wallpaper-file-input" accept="image/*,video/*" style="display:none;">
                                <button type="button" id="xzg-wallpaper-upload-btn" class="xzg-wallpaper-btn">${xzgT('选择图片','Choose Image')}</button>
                                <button type="button" id="xzg-wallpaper-clear-btn" class="xzg-wallpaper-btn xzg-wallpaper-clear">${xzgT('清除','Clear')}</button>
                            </div>

                            <div class="xzg-wallpaper-row">
                                <span class="xzg-swatch-label" style="font-size:12px;">${xzgT('透明度','Opacity')}</span>
                                <input type="range" id="xzg-wallpaper-opacity" min="0" max="1" step="0.05" value="0.5" style="flex:1;">
                                <span class="xzg-wallpaper-value" id="xzg-wallpaper-opacity-val">50%</span>
                            </div>

                            <div class="xzg-wallpaper-row">
                                <span class="xzg-swatch-label" style="font-size:12px;">${xzgT('填充方式','Fill Mode')}</span>
                                <div class="xzg-wallpaper-fit-btns">
                                    <button type="button" class="xzg-wallpaper-fit-btn active" data-fit="cover">${xzgT('覆盖','Cover')}</button>
                                    <button type="button" class="xzg-wallpaper-fit-btn" data-fit="contain">${xzgT('包含','Contain')}</button>
                                    <button type="button" class="xzg-wallpaper-fit-btn" data-fit="fill">${xzgT('拉伸','Stretch')}</button>
                                </div>
                            </div>
                        </div>
                    <div class="xzg-theme-separator"></div>
                    <div class="xzg-node-highlight-section">
                        <div class="xzg-link-highlight-section xzg-node-highlight-header">
                            <span class="xzg-swatch-label">${xzgT('节点执行高亮','Node Highlight')}</span>
                            <button type="button" id="xzg-node-highlight-btn" class="xzg-toggle-switch xzg-node-highlight-toggle" data-checked="false" title="${xzgT('开启后，运行中的节点显示高亮框','Show a highlight box on the running node')}">
                                <span class="xzg-toggle-slider"></span>
                                <span class="xzg-toggle-label">${xzgT('关','Off')}</span>
                            </button>
                        </div>
                        <div id="xzg-node-highlight-options" style="display:none;">
                            <div class="xzg-link-highlight-section" id="xzg-node-highlight-preset-row">
                                <span class="xzg-swatch-label">${xzgT('预设','Presets')}</span>
                                <select id="xzg-node-highlight-preset-select" title="${xzgT('渐变彩色预设','Gradient presets')}" style="flex:1;min-width:0;background:#2a2a2a;color:#ddd;border:1px solid rgba(255,255,255,0.18);border-radius:4px;padding:2px 4px;font-size:11px;">
                                    <option value="custom1">${xzgT('自定义单色','Custom Single')}</option>
                                    <option value="fire">${xzgT('火','Fire')}</option>
                                    <option value="cyber">${xzgT('赛博','Cyber')}</option>
                                    <option value="ocean">${xzgT('海洋','Ocean')}</option>
                                    <option value="rainbow">${xzgT('彩虹','Rainbow')}</option>
                                </select>
                            </div>
                            <div class="xzg-link-highlight-section" id="xzg-node-highlight-color-row" style="display:none;">
                                <span class="xzg-swatch-label">${xzgT('自定义颜色','Custom Color')}</span>
                                <div style="display:flex;align-items:center;gap:6px;flex:1;">
                                    <input type="color" id="xzg-node-highlight-color-1" value="#22FF22" title="${xzgT('颜色','Color')}" style="width:30px;height:24px;border:none;background:none;cursor:pointer;padding:0;">
                                </div>
                            </div>


                            <div class="xzg-link-highlight-section">
                                <span class="xzg-swatch-label">${xzgT('呼吸动画','Breathing')}</span>
                                <button type="button" id="xzg-node-highlight-breath-btn" class="xzg-toggle-switch xzg-node-highlight-breath-toggle" data-checked="false" title="${xzgT('开启后，高亮框明暗起伏（呼吸灯）','Breathing pulse on the highlight box')}">
                                    <span class="xzg-toggle-slider"></span>
                                    <span class="xzg-toggle-label">${xzgT('关','Off')}</span>
                                </button>
                            </div>

                            <div class="xzg-link-highlight-section" id="xzg-node-highlight-breath-row" style="display:none;">
                                <span class="xzg-swatch-label">${xzgT('呼吸周期','Breath Periodic')}</span>
                                <input type="range" id="xzg-node-highlight-breath-period" min="0.3" max="5" step="0.1" value="2" style="flex:1;accent-color:#FFD700;">
                                <span id="xzg-node-highlight-breath-period-val" style="flex:0 0 44px;text-align:right;font-size:11px;color:#FFD700;">2.0s</span>
                            </div>

                            <div class="xzg-link-highlight-section">
                                <span class="xzg-swatch-label">${xzgT('描边粗细','Stroke Width')}</span>
                                <input type="range" id="xzg-node-highlight-width" min="1" max="12" step="1" value="3" style="flex:1;accent-color:#FFD700;">
                                <span id="xzg-node-highlight-width-val" style="flex:0 0 44px;text-align:right;font-size:11px;color:#FFD700;">3px</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            </div>
            <div class="xzg-tab-content" data-tab-content="menuhide" style="display:none;">
                <div class="xzg-menu-hide-full">
                    <div class="xzg-menu-hide-tabs">
                        <button type="button" class="xzg-menu-tab active" data-menu-tab="canvas">${xzgT('画布菜单','Canvas Menu')}</button>
                        <button type="button" class="xzg-menu-tab" data-menu-tab="node">${xzgT('节点菜单','Node Menu')}</button>
                        <button type="button" class="xzg-menu-tab xzg-menu-tab-help" data-menu-tab="help">${xzgT('使用说明','Help')}</button>
                    </div>
                    <div class="xzg-menu-hide-list" id="xzg-menu-hide-list">
                        <div class="xzg-menu-empty-tip">${xzgT('当前没有已隐藏的菜单','No hidden menus currently')}</div>
                    </div>
                    <div class="xzg-menu-hide-help" id="xzg-menu-hide-help" style="display:none;">
                        <div class="xzg-menu-help-title">${xzgT('菜单隐藏使用说明','Menu Hide Guide')}</div>
                        <div class="xzg-menu-help-block">
                            <div class="xzg-menu-help-step"><b>1.</b> ${xzgT('在画布空白处右键打开「画布菜单」；在节点上右键打开「节点菜单」。','Right-click empty canvas for the canvas menu; right-click a node for the node menu.')}</div>
                            <div class="xzg-menu-help-step"><b>2.</b> ${xzgT('在想要隐藏的菜单项上，按下鼠标中键（滚轮）。','Press the middle mouse button (wheel) on the item you want to hide.')}</div>
                            <div class="xzg-menu-help-step"><b>3.</b> ${xzgT('菜单项旁会弹出「隐藏此菜单项」按钮，点击即可隐藏该项。','A "Hide this item" button pops up; click it to hide the item.')}</div>
                            <div class="xzg-menu-help-step"><b>4.</b> ${xzgT('已隐藏的菜单项会显示在上方「画布菜单 / 节点菜单」列表中，点击「恢复」可取消隐藏。','Hidden items are listed above under Canvas Menu / Node Menu; click "Restore" to unhide.')}</div>
                            <div class="xzg-menu-help-step"><b>5.</b> ${xzgT('「恢复所有隐藏菜单」可一键还原全部。','"Restore All Hidden Menus" resets everything at once.')}</div>
                        </div>
                    </div>
                    <button type="button" id="xzg-menu-reset-btn" class="xzg-menu-reset-btn">${xzgT('恢复所有隐藏菜单','Restore All Hidden Menus')}</button>
                </div>
            </div>
            <div class="xzg-tab-content" data-tab-content="quicknodes" style="display:none;">
                <div class="xzg-menu-hide-full">
                    <div class="xzg-quick-nodes-count">${xzgT('已添加','Added')} <span id="xzg-quick-count">0</span> / 20 ${xzgT('个快速连线','quick links')}</div>
                    <div class="xzg-quick-setting-row">
                        <span>${xzgT('夺舍模式','Possession Mode')}</span>
                        <button type="button" id="xzg-quick-hide-default-btn" class="xzg-toggle-switch" data-checked="false" title="${xzgT('夺舍模式：开启后，连线菜单只显示快速连线','Possession mode: when on, link menu shows only quick links')}">
                            <span class="xzg-toggle-slider"></span>
                            <span class="xzg-toggle-label">${xzgT('关','Off')}</span>
                        </button>
                    </div>
                    <div class="xzg-menu-hide-toolbar" style="margin-bottom:6px;">
                        <button type="button" class="xzg-menu-tool-btn" id="xzg-quick-clear-btn">${xzgT('清空全部','Clear All')}</button>
                    </div>
                    <div class="xzg-menu-hide-list" id="xzg-quick-nodes-list">
                        <div class="xzg-menu-empty-tip">${xzgT('暂无快速连线','No quick links yet')}<br><span style="font-size:11px;">${xzgT('右键节点可添加到快速连线','Right-click a node to add to quick links')}</span></div>
                    </div>
                    <p style="margin-top:8px;font-size:11px;color:#888;text-align:center;">${xzgT('拖拽可调整顺序，从节点拉出连线时搜索框顶部显示','Drag to reorder; shown atop the search box when dragging a link from a node')}</p>
                </div>
            </div>

        `;

        this.panel = panel;
        this.colorPicker = panel.querySelector(".xzg-picker-section");
        this.bindEvents();
        document.body.appendChild(panel);
        
        const defaultDirBtn = panel.querySelector(`[data-dir="${this.defaults.direction}"]`);
        if (defaultDirBtn) defaultDirBtn.classList.add("active");

        const defaultTitleDirBtn = panel.querySelector(`[data-title-dir="${this.defaults.titleDirection}"]`);
        if (defaultTitleDirBtn) defaultTitleDirBtn.classList.add("active");

        const firstSwatch = panel.querySelector('.xzg-color-swatch[data-color="color1"]');
        if (firstSwatch) {
            firstSwatch.classList.add("active");
            this.activeColorInput = "color1";
            this.setColorFromHex(this.defaults.color1, false);
        }

        this.updateShortcutDisplay();
        this.renderPresets();

        // 语言切换时重建面板，刷新所有静态文案（双语支持）
        try {
            const appRef = (typeof app !== "undefined" && app) || window.app;
            const lookup = appRef?.ui?.settings?.settingsLookup?.["Comfy.Locale"];
            if (lookup && !this.__xzg_theme_lang_hooked) {
                this.__xzg_theme_lang_hooked = true;
                const origOnChange = lookup.onChange;
                lookup.onChange = function () {
                    try {
                        const p = window.XZGThemePanel;
                        if (p && p.panel) { p.hide(); p.panel.remove(); p.panel = null; p.create(); p.show(); }
                    } catch (e) {}
                    return origOnChange?.apply(this, arguments);
                };
            }
        } catch (e) {}

        return panel;
    },

    bindEvents() {
        const panel = this.panel;
        const self = this;

        panel.querySelector(".xzg-theme-close").addEventListener("click", () => {
            self.hide();
        });

        const shortcutBtn = panel.querySelector("#xzg-theme-shortcut-btn");
        if (shortcutBtn) {
            shortcutBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                self.showShortcutDialog();
            });
        }

        const header = panel.querySelector(".xzg-theme-header");
        header.style.cursor = "move";
        header.addEventListener("mousedown", (e) => {
            if (e.target.classList.contains("xzg-theme-close") || 
                e.target.classList.contains("xzg-theme-shortcut-btn") ||
                e.target.closest(".xzg-theme-shortcut-btn")) return;
            self.isDragging = true;
            const rect = panel.getBoundingClientRect();
            self.dragOffsetX = e.clientX - rect.left;
            self.dragOffsetY = e.clientY - rect.top;
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener("mousemove", (e) => {
            if (!self.isDragging) return;
            let left = e.clientX - self.dragOffsetX;
            let top = e.clientY - self.dragOffsetY;
            const rect = panel.getBoundingClientRect();
            if (left + rect.width > window.innerWidth) {
                left = window.innerWidth - rect.width;
            }
            if (top + rect.height > window.innerHeight) {
                top = window.innerHeight - rect.height;
            }
            if (left < 0) left = 0;
            if (top < 0) top = 0;
            panel.style.left = left + "px";
            panel.style.top = top + "px";
        });

        document.addEventListener("mouseup", () => {
            if (self.isDragging) {
                self.isDragging = false;
                self.savePosition();
            }
            self.isDraggingSV = false;
            self.isDraggingHue = false;
            self.isDraggingAlpha = false;
        });

        panel.querySelectorAll(".xzg-color-swatch").forEach(swatch => {
            swatch.addEventListener("click", (e) => {
                e.stopPropagation();
                const colorKey = swatch.dataset.color;
                self.activeColorInput = colorKey;
                panel.querySelectorAll(".xzg-color-swatch").forEach(s => s.classList.remove("active"));
                swatch.classList.add("active");
                const currentColor = self.getSwatchColor(colorKey);
                self.setColorFromHex(currentColor, false);
                requestAnimationFrame(() => {
                    self.syncPickerCursors();
                });
            });
        });

        panel.querySelectorAll(".xzg-direction-buttons:not(.xzg-title-dir-buttons) .xzg-dir-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                panel.querySelectorAll(".xzg-direction-buttons:not(.xzg-title-dir-buttons) .xzg-dir-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                if (self.isUpdatingFromNode) return;
                self.notifyChange();
            });
        });

        panel.querySelectorAll(".xzg-title-dir-buttons .xzg-dir-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                panel.querySelectorAll(".xzg-title-dir-buttons .xzg-dir-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                if (self.isUpdatingFromNode) return;
                self.notifyChange();
            });
        });

        const titleToggle = panel.querySelector(".xzg-title-gradient-toggle");
        if (titleToggle) {
            titleToggle.addEventListener("click", () => {
                const isChecked = titleToggle.dataset.checked === "true";
                const newChecked = !isChecked;
                titleToggle.dataset.checked = String(newChecked);
                const label = titleToggle.querySelector(".xzg-toggle-label");
                if (label) label.textContent = newChecked ? xzgT("开","On") : xzgT("关","Off");
                
                const titleSections = panel.querySelectorAll(".xzg-title-swatch-section");
                titleSections.forEach(sec => {
                    sec.style.display = newChecked ? "" : "none";
                });
                
                if (self.isUpdatingFromNode) return;
                self.notifyChange();
            });
        }

        panel.querySelectorAll(".xzg-font-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const action = btn.dataset.sizeAction;
                const sizeEl = panel.querySelector("#xzg-font-size-value");
                let size = parseInt(sizeEl.textContent) || 14;
                if (action === "increase") {
                    size = Math.min(24, size + 1);
                } else {
                    size = Math.max(10, size - 1);
                }
                sizeEl.textContent = size;
                if (self.isUpdatingFromNode) return;
                self.notifyChange();
            });
        });

        panel.querySelectorAll(".xzg-align-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                panel.querySelectorAll(".xzg-align-btn").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                if (self.isUpdatingFromNode) return;
                self.notifyChange();
            });
        });

        panel.querySelector("#xzg-apply-btn").addEventListener("click", () => {
            if (self.onApply) {
                self.onApply(self.getCurrentColors());
            }
            self.hide();
        });

        panel.querySelector("#xzg-reset-btn").addEventListener("click", () => {
            if (self.onReset) {
                self.onReset();
            }
            self.hide();
        });

        panel.querySelectorAll(".xzg-preset-item").forEach(item => {
            item.addEventListener("click", (e) => {
                e.stopPropagation();
                const index = parseInt(item.dataset.preset);
                self.applyPreset(index);
            });

            item.addEventListener("contextmenu", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const index = parseInt(item.dataset.preset);
                const confirmed = await self.showConfirmDialog(
                    xzgT('保存预设', 'Save Preset'),
                    xzgT(`确定要将当前主题设置保存到预设${index + 1}吗？`, `Are you sure you want to save current theme settings to preset ${index + 1}?`)
                );
                if (confirmed) {
                    self.saveCurrentToPreset(index);
                }
            });
        });

        const linkHighlightBtn = panel.querySelector("#xzg-link-highlight-btn");
        const linkHighlightAnimTypeRow = panel.querySelector("#xzg-link-highlight-anim-type-row");
        const linkHighlightAnimTypeSelect = panel.querySelector("#xzg-link-highlight-anim-type");

        // 速度行可见性：连线动画开启，或高亮动画选中了非 none 类型时显示
        const updateSpeedRowVisibility = () => {
            const tm = window.XZGThemeManager;
            if (!tm || !linkAnimSpeedRow) return;
            const animOn = !!tm.linkAnimActive;
            const hlAnimOn = !!tm.linkHighlightActive && tm.linkHighlightAnimType && tm.linkHighlightAnimType !== 'none';
            linkAnimSpeedRow.style.display = (animOn || hlAnimOn) ? "" : "none";
        };

        if (linkHighlightBtn) {
            linkHighlightBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (window.XZGThemeManager) {
                    const active = window.XZGThemeManager.toggleLinkHighlight();
                    linkHighlightBtn.setAttribute("data-checked", active ? "true" : "false");
                    const label = linkHighlightBtn.querySelector(".xzg-toggle-label");
                    if (label) label.textContent = active ? xzgT("开","On") : xzgT("关","Off");
                    if (linkHighlightAnimTypeRow) linkHighlightAnimTypeRow.style.display = active ? "" : "none";
                    // 互斥：如果连线高亮开启了，关闭连线动画的面板状态
                    if (active && linkAnimBtn) {
                        linkAnimBtn.setAttribute("data-checked", "false");
                        const l = linkAnimBtn.querySelector(".xzg-toggle-label");
                        if (l) l.textContent = xzgT("关","Off");
                        if (linkAnimTypeRow) linkAnimTypeRow.style.display = "none";
                    }
                    updateSpeedRowVisibility();
                }
            });

            // 同步初始状态
            if (window.XZGThemeManager && window.XZGThemeManager.linkHighlightActive) {
                linkHighlightBtn.setAttribute("data-checked", "true");
                const label = linkHighlightBtn.querySelector(".xzg-toggle-label");
                if (label) label.textContent = xzgT("开","On");
                if (linkHighlightAnimTypeRow) linkHighlightAnimTypeRow.style.display = "";
            }
        }

        if (linkHighlightAnimTypeSelect) {
            // 同步初始值
            if (window.XZGThemeManager && window.XZGThemeManager.linkHighlightAnimType) {
                linkHighlightAnimTypeSelect.value = window.XZGThemeManager.linkHighlightAnimType;
            }
            linkHighlightAnimTypeSelect.addEventListener("change", (e) => {
                e.stopPropagation();
                if (window.XZGThemeManager) {
                    window.XZGThemeManager.setLinkHighlightAnimType(linkHighlightAnimTypeSelect.value);
                    updateSpeedRowVisibility();
                }
            });
        }

        const linkAnimBtn = panel.querySelector("#xzg-link-anim-btn");
        const linkAnimTypeRow = panel.querySelector("#xzg-link-anim-type-row");
        const linkAnimTypeSelect = panel.querySelector("#xzg-link-anim-type");
        const linkAnimSpeedRow = panel.querySelector("#xzg-link-anim-speed-row");
        const linkAnimSpeedSlider = panel.querySelector("#xzg-link-anim-speed");
        const linkAnimSpeedVal = panel.querySelector("#xzg-link-anim-speed-val");
        if (linkAnimBtn) {
            linkAnimBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (window.XZGThemeManager) {
                    const active = window.XZGThemeManager.toggleLinkAnim();
                    linkAnimBtn.setAttribute("data-checked", active ? "true" : "false");
                    const label = linkAnimBtn.querySelector(".xzg-toggle-label");
                    if (label) label.textContent = active ? xzgT("开","On") : xzgT("关","Off");
                    if (linkAnimTypeRow) linkAnimTypeRow.style.display = active ? "" : "none";
                    // 互斥：如果连线动画开启了，关闭连线高亮的面板状态
                    if (active && linkHighlightBtn) {
                        linkHighlightBtn.setAttribute("data-checked", "false");
                        const l = linkHighlightBtn.querySelector(".xzg-toggle-label");
                        if (l) l.textContent = xzgT("关","Off");
                        if (linkHighlightAnimTypeRow) linkHighlightAnimTypeRow.style.display = "none";
                    }
                    updateSpeedRowVisibility();
                }
            });

            // 同步初始状态
            if (window.XZGThemeManager && window.XZGThemeManager.linkAnimActive) {
                linkAnimBtn.setAttribute("data-checked", "true");
                const label = linkAnimBtn.querySelector(".xzg-toggle-label");
                if (label) label.textContent = xzgT("开","On");
                if (linkAnimTypeRow) linkAnimTypeRow.style.display = "";
            }
        }

        // 初始同步速度行可见性
        updateSpeedRowVisibility();

        if (linkAnimTypeSelect) {
            // 同步初始值
            if (window.XZGThemeManager && window.XZGThemeManager.linkAnimType) {
                linkAnimTypeSelect.value = window.XZGThemeManager.linkAnimType;
            }
            linkAnimTypeSelect.addEventListener("change", (e) => {
                e.stopPropagation();
                if (window.XZGThemeManager) {
                    window.XZGThemeManager.setLinkAnimType(linkAnimTypeSelect.value);
                }
            });
        }

        if (linkAnimSpeedSlider) {
            // 同步初始值
            if (window.XZGThemeManager && window.XZGThemeManager.linkAnimSpeed) {
                const v = window.XZGThemeManager.linkAnimSpeed;
                linkAnimSpeedSlider.value = v;
                if (linkAnimSpeedVal) linkAnimSpeedVal.textContent = v.toFixed(1) + "x";
            }
            linkAnimSpeedSlider.addEventListener("input", (e) => {
                e.stopPropagation();
                const v = parseFloat(linkAnimSpeedSlider.value);
                if (window.XZGThemeManager) {
                    window.XZGThemeManager.setLinkAnimSpeed(v);
                }
                if (linkAnimSpeedVal) linkAnimSpeedVal.textContent = v.toFixed(1) + "x";
            });
        }

        // 壁纸开关
        const wallpaperBtn = panel.querySelector("#xzg-wallpaper-btn");
        const wallpaperControls = panel.querySelector("#xzg-wallpaper-controls");
        const wallpaperFileInput = panel.querySelector("#xzg-wallpaper-file-input");
        const wallpaperUploadBtn = panel.querySelector("#xzg-wallpaper-upload-btn");
        const wallpaperClearBtn = panel.querySelector("#xzg-wallpaper-clear-btn");
        const wallpaperOpacity = panel.querySelector("#xzg-wallpaper-opacity");
        const wallpaperOpacityVal = panel.querySelector("#xzg-wallpaper-opacity-val");
        const wallpaperFitBtns = panel.querySelectorAll(".xzg-wallpaper-fit-btn");

        if (wallpaperBtn) {
            wallpaperBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (window.XZGThemeManager) {
                    const current = window.XZGThemeManager.wallpaperActive;
                    const next = !current;
                    window.XZGThemeManager.setWallpaperActive(next);
                    wallpaperBtn.setAttribute("data-checked", next ? "true" : "false");
                    const label = wallpaperBtn.querySelector(".xzg-toggle-label");
                    if (label) label.textContent = next ? xzgT("开","On") : xzgT("关","Off");
                    if (wallpaperControls) {
                        wallpaperControls.style.display = next ? "block" : "none";
                    }
                }
            });

            if (window.XZGThemeManager && window.XZGThemeManager.wallpaperActive) {
                wallpaperBtn.setAttribute("data-checked", "true");
                const label = wallpaperBtn.querySelector(".xzg-toggle-label");
                if (label) label.textContent = xzgT("开","On");
                if (wallpaperControls) {
                    wallpaperControls.style.display = "block";
                }
            }
        }

        // 节点执行高亮开关（含颜色与呼吸动画选项）
        const nodeHighlightBtn = panel.querySelector("#xzg-node-highlight-btn");
        const nodeHighlightOptions = panel.querySelector("#xzg-node-highlight-options");
        const nodeHighlightColorInput = panel.querySelector("#xzg-node-highlight-color-1");
        const nodeHighlightBreathBtn = panel.querySelector("#xzg-node-highlight-breath-btn");
        const nodeHighlightBreathRow = panel.querySelector("#xzg-node-highlight-breath-row");
        const nodeHighlightBreathPeriod = panel.querySelector("#xzg-node-highlight-breath-period");
        const nodeHighlightBreathPeriodVal = panel.querySelector("#xzg-node-highlight-breath-period-val");
        const nodeHighlightWidth = panel.querySelector("#xzg-node-highlight-width");
        const nodeHighlightWidthVal = panel.querySelector("#xzg-node-highlight-width-val");
        const applySwatches = (tm) => {
            const el = panel.querySelector("#xzg-node-highlight-color-1");
            if (el) {
                el.style.display = "";
                const parts = ((tm && tm.nodeHighlightColor) || "#22FF22").split(",").map(s => s.trim()).filter(Boolean);
                el.value = parts[0] || "#22FF22";
            }
        };
        const syncNodeHighlightUI = () => {
            if (!window.XZGThemeManager) return;
            const tm = window.XZGThemeManager;
            if (nodeHighlightBtn) {
                nodeHighlightBtn.setAttribute("data-checked", tm.nodeHighlightActive ? "true" : "false");
                const nodeLabel = nodeHighlightBtn.querySelector(".xzg-toggle-label");
                if (nodeLabel) nodeLabel.textContent = tm.nodeHighlightActive ? xzgT("开","On") : xzgT("关","Off");
            }
            if (nodeHighlightOptions) nodeHighlightOptions.style.display = tm.nodeHighlightActive ? "block" : "none";
            applySwatches(tm);
            if (nodeHighlightBreathBtn) {
                nodeHighlightBreathBtn.setAttribute("data-checked", tm.nodeHighlightBreath ? "true" : "false");
                const breathLabel = nodeHighlightBreathBtn.querySelector(".xzg-toggle-label");
                if (breathLabel) breathLabel.textContent = tm.nodeHighlightBreath ? xzgT("开","On") : xzgT("关","Off");
            }
            if (nodeHighlightBreathRow) nodeHighlightBreathRow.style.display = tm.nodeHighlightBreath ? "flex" : "none";
            if (nodeHighlightBreathPeriod) nodeHighlightBreathPeriod.value = tm.nodeHighlightBreathPeriod || 2;
            if (nodeHighlightBreathPeriodVal) nodeHighlightBreathPeriodVal.textContent = (tm.nodeHighlightBreathPeriod || 2).toFixed(1) + "s";
            if (nodeHighlightWidth) nodeHighlightWidth.value = tm.nodeHighlightWidth || 3;
            if (nodeHighlightWidthVal) nodeHighlightWidthVal.textContent = (tm.nodeHighlightWidth || 3) + "px";
        };

        if (nodeHighlightBtn) {
            nodeHighlightBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (window.XZGThemeManager) {
                    const active = window.XZGThemeManager.toggleNodeHighlight();
                    nodeHighlightBtn.setAttribute("data-checked", active ? "true" : "false");
                    const label = nodeHighlightBtn.querySelector(".xzg-toggle-label");
                    if (label) label.textContent = active ? xzgT("开","On") : xzgT("关","Off");
                    syncNodeHighlightUI();
                }
            });
        }

        const syncFromSwatches = () => {
            if (!window.XZGThemeManager) return;
            const el = panel.querySelector("#xzg-node-highlight-color-1");
            if (el) window.XZGThemeManager.setNodeHighlightColor(el.value);
        };
        {
            const el = panel.querySelector("#xzg-node-highlight-color-1");
            if (el) {
                el.addEventListener("input", (e) => { e.stopPropagation(); syncFromSwatches(); if (nodeHighlightPresetSelect) syncPresetSelect(); });
                el.addEventListener("change", (e) => { e.stopPropagation(); syncFromSwatches(); if (nodeHighlightPresetSelect) syncPresetSelect(); });
            }
        }

        // 渐变彩色预设下拉框
        const nodeHighlightPresetSelect = panel.querySelector("#xzg-node-highlight-preset-select");
        const nodeHighlightPresetMap = {
            fire: "#FF0000,#FFFF00",
            cyber: "#00FFFF,#FF00FF",
            ocean: "#0000FF,#00FFFF",
            rainbow: "#FF0000,#FFFF00,#00FF00,#00FFFF,#0000FF,#FF00FF",
        };
        if (nodeHighlightPresetSelect) {
            const syncPresetSelect = () => {
                const tm = window.XZGThemeManager;
                const cur = ((tm && tm.nodeHighlightColor) || "").replace(/\s+/g, "").toLowerCase();
                const parts = cur.split(",").filter(Boolean);
                let matched = "custom1";
                for (const k of Object.keys(nodeHighlightPresetMap)) {
                    if (cur === nodeHighlightPresetMap[k].toLowerCase()) { matched = k; break; }
                }
                nodeHighlightPresetSelect.value = matched;
                applySwatches(tm);
                const cr = panel.querySelector("#xzg-node-highlight-color-row");
                if (cr) cr.style.display = matched === "custom1" ? "" : "none";
            };
            nodeHighlightPresetSelect.addEventListener("change", (e) => {
                e.stopPropagation();
                const v = e.target.value;
                const cr = panel.querySelector("#xzg-node-highlight-color-row");
                if (v === "custom1") {
                    if (cr) cr.style.display = "";
                    const tm = window.XZGThemeManager;
                    if (tm) {
                        const el = panel.querySelector("#xzg-node-highlight-color-1");
                        if (el) {
                            tm.setNodeHighlightColor(el.value);
                            applySwatches(tm);
                            el.focus();
                        }
                    }
                    return;
                }
                if (cr) cr.style.display = "none";
                if (window.XZGThemeManager && nodeHighlightPresetMap[v]) {
                    window.XZGThemeManager.setNodeHighlightColor(nodeHighlightPresetMap[v]);
                    syncNodeHighlightUI();
                }
            });
            syncPresetSelect();
        }

        if (nodeHighlightBreathBtn) {
            nodeHighlightBreathBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (window.XZGThemeManager) {
                    window.XZGThemeManager.setNodeHighlightBreath(!window.XZGThemeManager.nodeHighlightBreath);
                    syncNodeHighlightUI();
                }
            });
        }
        if (nodeHighlightBreathPeriod) {
            const updateBreathPeriod = () => {
                const v = parseFloat(nodeHighlightBreathPeriod.value);
                if (window.XZGThemeManager && !isNaN(v) && v > 0) {
                    window.XZGThemeManager.setNodeHighlightBreathPeriod(v);
                    if (nodeHighlightBreathPeriodVal) nodeHighlightBreathPeriodVal.textContent = v.toFixed(1) + "s";
                }
            };
            nodeHighlightBreathPeriod.addEventListener("input", updateBreathPeriod);
            nodeHighlightBreathPeriod.addEventListener("change", updateBreathPeriod);
        }
        if (nodeHighlightWidth) {
            const updateWidth = () => {
                const v = parseInt(nodeHighlightWidth.value, 10);
                if (window.XZGThemeManager && !isNaN(v) && v > 0) {
                    window.XZGThemeManager.setNodeHighlightWidth(v);
                    if (nodeHighlightWidthVal) nodeHighlightWidthVal.textContent = v + "px";
                }
            };
            nodeHighlightWidth.addEventListener("input", updateWidth);
            nodeHighlightWidth.addEventListener("change", updateWidth);
        }

        syncNodeHighlightUI();

        // 壁纸文件上传
        if (wallpaperUploadBtn && wallpaperFileInput) {
            wallpaperUploadBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                wallpaperFileInput.click();
            });

            wallpaperFileInput.addEventListener("change", (e) => {
                const file = e.target.files?.[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = (ev) => {
                    const dataUrl = ev.target.result;
                    const isVideo = file.type.startsWith('video/');
                    const type = isVideo ? 'video' : 'image';
                    if (window.XZGThemeManager) {
                        window.XZGThemeManager.setWallpaperData(type, dataUrl);
                    }
                };
                reader.readAsDataURL(file);
            });
        }

        // 清除壁纸
        if (wallpaperClearBtn) {
            wallpaperClearBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (window.XZGThemeManager) {
                    window.XZGThemeManager.clearWallpaper();
                    if (wallpaperBtn) {
                        wallpaperBtn.setAttribute("data-checked", "false");
                        const label = wallpaperBtn.querySelector(".xzg-toggle-label");
                        if (label) label.textContent = xzgT("关","Off");
                    }
                    if (wallpaperControls) {
                        wallpaperControls.style.display = "none";
                    }
                }
            });
        }

        // 壁纸透明度
        if (wallpaperOpacity && wallpaperOpacityVal) {
            wallpaperOpacity.addEventListener("input", (e) => {
                const val = parseFloat(e.target.value);
                wallpaperOpacityVal.textContent = Math.round(val * 100) + "%";
                if (window.XZGThemeManager) {
                    window.XZGThemeManager.setWallpaperOpacity(val);
                }
            });

            if (window.XZGThemeManager) {
                const op = window.XZGThemeManager.wallpaperOpacity ?? 0.5;
                wallpaperOpacity.value = op;
                wallpaperOpacityVal.textContent = Math.round(op * 100) + "%";
            }
        }

        // 填充方式
        if (wallpaperFitBtns.length > 0) {
            wallpaperFitBtns.forEach(btn => {
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const fit = btn.dataset.fit;
                    if (window.XZGThemeManager) {
                        window.XZGThemeManager.setWallpaperFit(fit);
                    }
                    wallpaperFitBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                });
            });

            if (window.XZGThemeManager) {
                const currentFit = window.XZGThemeManager.wallpaperFit || 'cover';
                wallpaperFitBtns.forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.fit === currentFit);
                });
            }
        }

        // 连线动画功能已取消
        // const linkLaserBtn = panel.querySelector("#xzg-link-laser-btn");
        // const animTypeSection = panel.querySelector("#xzg-anim-type-section");
        // if (linkLaserBtn) {
        //     linkLaserBtn.addEventListener("click", (e) => {
        //         e.stopPropagation();
        //         if (window.XZGThemeManager) {
        //             const active = window.XZGThemeManager.toggleLinkLaser();
        //             linkLaserBtn.setAttribute("data-checked", active ? "true" : "false");
        //             const label = linkLaserBtn.querySelector(".xzg-toggle-label");
        //             if (label) label.textContent = active ? xzgT("开","On") : xzgT("关","Off");
        //             // 显示/隐藏动画风格选择
        //             if (animTypeSection) animTypeSection.style.display = active ? 'flex' : 'none';
        //         }
        //     });
        //
        //     // 同步初始状态
        //     if (window.XZGThemeManager && window.XZGThemeManager.linkLaserActive) {
        //         linkLaserBtn.setAttribute("data-checked", "true");
        //         const label = linkLaserBtn.querySelector(".xzg-toggle-label");
        //         if (label) label.textContent = xzgT("开","On");
        //         if (animTypeSection) animTypeSection.style.display = 'flex';
        //     }
        // }

        // // 动画风格按钮事件
        // const animTypeBtns = panel.querySelectorAll('.xzg-anim-type-btn');
        // animTypeBtns.forEach(btn => {
        //     btn.addEventListener('click', (e) => {
        //         e.stopPropagation();
        //         const type = btn.dataset.anim;
        //         if (window.XZGThemeManager) {
        //             window.XZGThemeManager.laserAnimType = type;
        //             try { localStorage.setItem('xzg-laser-anim-type', type); } catch(e) {}
        //             if (app.canvas?.setDirty) app.canvas.setDirty(true, true);
        //         }
        //         animTypeBtns.forEach(b => b.classList.remove('active'));
        //         btn.classList.add('active');
        //     });
        // });
        // // 同步初始动画风格
        // if (window.XZGThemeManager) {
        //     const currentType = window.XZGThemeManager.laserAnimType || 'flow';
        //     animTypeBtns.forEach(btn => {
        //         btn.classList.toggle('active', btn.dataset.anim === currentType);
        //     });
        // }

        // 连线颜色功能已取消
        // const linkColorBtn = panel.querySelector("#xzg-link-color-btn");
        // if (linkColorBtn) {
        //     linkColorBtn.addEventListener("click", (e) => {
        //         e.stopPropagation();
        //         if (window.XZGThemeManager) {
        //             const active = window.XZGThemeManager.toggleLinkColor();
        //             linkColorBtn.setAttribute("data-checked", active ? "true" : "false");
        //             const label = linkColorBtn.querySelector(".xzg-toggle-label");
        //             if (label) label.textContent = active ? xzgT("开","On") : xzgT("关","Off");
        //         }
        //     });
        //
        //     // 同步初始状态
        //     if (window.XZGThemeManager && window.XZGThemeManager.linkColorActive) {
        //         linkColorBtn.setAttribute("data-checked", "true");
        //         const label = linkColorBtn.querySelector(".xzg-toggle-label");
        //         if (label) label.textContent = xzgT("开","On");
        //     }
        // }

        // 菜单隐藏功能
        const menuHideBtn = panel.querySelector("#xzg-menu-hide-btn");
        const menuHideControls = panel.querySelector("#xzg-menu-hide-controls");
        const menuHideList = panel.querySelector("#xzg-menu-hide-list");
        const menuHelp = panel.querySelector("#xzg-menu-hide-help");
        const menuTabs = panel.querySelectorAll(".xzg-menu-tab");
        const menuResetBtn = panel.querySelector("#xzg-menu-reset-btn");

        let currentMenuTab = 'canvas';

        const renderMenuList = () => {
            if (!window.XZGMenuHide || !menuHideList) return;
            if (currentMenuTab === 'help') return; // 使用说明页不渲染列表
            const mh = window.XZGMenuHide;
            const hiddenMap = mh.config[currentMenuTab] || {};
            const keys = Object.keys(hiddenMap);

            if (keys.length === 0) {
                menuHideList.innerHTML = '<div class="xzg-menu-empty-tip">' + xzgT('当前没有已隐藏的菜单','No hidden menus currently') + '</div>';
                return;
            }

            let html = '';
            keys.forEach(item => {
                const displayName = item.length > 28 ? item.substring(0, 28) + '...' : item;
                html += `
                    <div class="xzg-menu-item" title="${item.replace(/"/g, '&quot;')}">
                        <span>${displayName}</span>
                        <button type="button" class="xzg-menu-unhide-btn" data-menu-item="${item.replace(/"/g, '&quot;')}">${xzgT('恢复','Restore')}</button>
                    </div>
                `;
            });
            menuHideList.innerHTML = html;

            menuHideList.querySelectorAll('.xzg-menu-unhide-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const item = btn.dataset.menuItem;
                    if (window.XZGMenuHide) {
                        window.XZGMenuHide.setHidden(currentMenuTab, item, false);
                        renderMenuList();
                    }
                });
            });
        };

        if (menuHideBtn && menuHideBtn.parentNode) {
            menuHideBtn.parentNode.removeChild(menuHideBtn);
        }

        const topTabs = panel.querySelectorAll(".xzg-top-tab");
        const tabContents = panel.querySelectorAll(".xzg-tab-content");
        let themeTabHeight = 0;

        const switchTopTab = (tabName) => {
            if (tabName === 'menuhide' || tabName === 'quicknodes') {
                const themeTab = panel.querySelector('.xzg-tab-content[data-tab-content="theme"]');
                if (themeTab && themeTab.offsetHeight > 0) {
                    themeTabHeight = themeTab.offsetHeight;
                }
                const targetTab = panel.querySelector(`.xzg-tab-content[data-tab-content="${tabName}"]`);
                if (targetTab && themeTabHeight > 0) {
                    targetTab.style.height = themeTabHeight + 'px';
                }
            }
            topTabs.forEach(t => t.classList.toggle('active', t.dataset.topTab === tabName));
            tabContents.forEach(c => {
                c.style.display = c.dataset.tabContent === tabName ? '' : 'none';
            });

            try { localStorage.setItem('xzg-theme-panel-tab', tabName); } catch(e) {}
            this._queueThemePanelCloudSave();

            if (tabName === 'menuhide') {
                if (window.XZGMenuHide) {
                    window.XZGMenuHide.setEnabled(true);
                    window.XZGMenuHide.init();
                }
                setTimeout(renderMenuList, 100);
            } else if (tabName === 'quicknodes') {
                setTimeout(renderQuickNodesList, 50);
            }
        };
        // 供每次打开面板时重置到默认「主题」标签使用。
        this._switchTopTab = switchTopTab;

        topTabs.forEach(tab => {
            tab.addEventListener('click', (e) => {
                e.stopPropagation();
                switchTopTab(tab.dataset.topTab);
            });
        });

        // 创建时始终先显示主题页，不恢复上次停留的「主题+ / 菜单隐藏 / 快速连线」。
        switchTopTab('theme');

        if (menuTabs && menuTabs.length > 0) {
            menuTabs.forEach(tab => {
                tab.addEventListener('click', (e) => {
                    e.stopPropagation();
                    currentMenuTab = tab.dataset.menuTab;
                    menuTabs.forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    const isHelp = currentMenuTab === 'help';
                    if (menuHideList) menuHideList.style.display = isHelp ? 'none' : '';
                    if (menuHelp) menuHelp.style.display = isHelp ? '' : 'none';
                    if (menuResetBtn) menuResetBtn.style.display = isHelp ? 'none' : '';
                    if (!isHelp) renderMenuList();
                });
            });
        }

        if (menuResetBtn) {
            menuResetBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!window.XZGMenuHide) return;
                if (confirm(xzgT('确定要恢复所有被隐藏的菜单项吗？','Sure to restore all hidden menu items?'))) {
                    window.XZGMenuHide.resetAll();
                    renderMenuList();
                }
            });
        }

        if (window.XZGMenuHide) {
            setTimeout(renderMenuList, 200);
        }

        this._menuListVisible = true;
        this._refreshMenuListUI = () => {
            // 无条件更新隐藏列表 DOM：即使面板当前折叠/未显示，也先把列表渲染成最新，
            // 这样隐藏菜单项后下次打开面板(show)时无需手动切换“画布/节点”标签即显示最新隐藏项。
            // 面板未创建时 _menuListVisible 为 false，此处直接跳过。
            if (this._menuListVisible) {
                renderMenuList();
            }
        };

        function showQuickNodeRenameDialog(node) {
            return new Promise(resolve => {
                const overlay = document.createElement("div");
                overlay.className = "xzg-quick-link-rename-overlay";
                overlay.style.cssText = "position:fixed;inset:0;z-index:2000020;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);padding:20px;box-sizing:border-box";
                overlay.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); });
                const dialog = document.createElement("div");
                dialog.style.cssText = "box-sizing:border-box;width:min(420px,100%);padding:16px;background:var(--comfy-menu-bg,#25282c);color:#fff;border:1px solid var(--border-color,#555);border-radius:8px;box-shadow:0 12px 36px #0009;font:13px Arial,sans-serif";
                const title = document.createElement("div");
                title.textContent = xzgT("重命名快速连线", "Rename Quick Link");
                title.style.cssText = "font-size:15px;font-weight:bold;color:#FFD700;margin-bottom:12px";
                const input = document.createElement("input");
                input.type = "text"; input.maxLength = 100; input.value = node.title || node.type;
                input.style.cssText = "box-sizing:border-box;width:100%;padding:8px;background:var(--comfy-input-bg,#151617);color:#fff;border:1px solid var(--border-color,#555);border-radius:4px;outline:none";
                const error = document.createElement("div");
                error.style.cssText = "min-height:18px;margin-top:5px;color:#ff7777;font-size:12px";
                const footer = document.createElement("div");
                footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:10px";
                const makeButton = (label, confirm = false) => {
                    const button = document.createElement("button"); button.type = "button"; button.textContent = label;
                    button.style.cssText = `padding:6px 14px;background:${confirm ? "#FFD700" : "var(--comfy-input-bg,#3a3a3a)"};color:${confirm ? "#222" : "#ddd"};border:1px solid ${confirm ? "#FFD700" : "var(--border-color,#555)"};border-radius:4px;cursor:pointer`;
                    return button;
                };
                const cancel = makeButton(xzgT("取消", "Cancel"));
                const confirm = makeButton(xzgT("确认", "Confirm"), true);
                footer.append(cancel, confirm); dialog.append(title, input, error, footer); overlay.appendChild(dialog); document.body.appendChild(overlay);
                const finish = value => { document.removeEventListener("keydown", onKey, true); overlay.remove(); resolve(value); };
                const save = () => { const value = input.value.trim(); if (!value) { error.textContent = xzgT("名称不能为空", "Name cannot be empty"); input.focus(); return; } finish(value); };
                const onKey = event => { if (event.key === "Escape") { event.preventDefault(); finish(null); } else if (event.key === "Enter") { event.preventDefault(); save(); } };
                cancel.addEventListener("click", () => finish(null)); confirm.addEventListener("click", save);
                overlay.addEventListener("click", event => { if (event.target === overlay) finish(null); });
                dialog.addEventListener("pointerdown", event => event.stopPropagation());
                document.addEventListener("keydown", onKey, true); input.focus(); input.select();
            });
        }

        async function renameQuickNode(node) {
            const nextTitle = await showQuickNodeRenameDialog(node);
            if (!nextTitle || !window.XZGQuickNodes?.renameQuickNode?.(node.type, nextTitle)) return;
            renderQuickNodesList();
        }

        function showQuickNodeContextMenu(node, event) {
            document.querySelectorAll(".xzg-quick-link-context-menu").forEach(menu => menu.remove());
            const menu = document.createElement("div");
            menu.className = "xzg-quick-link-context-menu";
            menu.setAttribute("role", "menu");
            menu.style.cssText = "position:fixed;z-index:2000019;min-width:0;padding:2px;background:rgba(37,40,44,.97);color:#d6ad55;border:1px solid #d6ad55;border-radius:4px;box-shadow:0 3px 10px rgba(0,0,0,.35);font:12px Arial,sans-serif";
            const rename = document.createElement("button");
            rename.type = "button";
            rename.setAttribute("role", "menuitem");
            rename.textContent = xzgT("重命名", "Rename");
            rename.style.cssText = "display:block;width:100%;padding:5px 8px;text-align:left;white-space:nowrap;background:transparent;color:#d6ad55;border:0;border-radius:3px;cursor:pointer;font:inherit";
            rename.addEventListener("mouseenter", () => { rename.style.background = "rgba(214,173,85,.12)"; });
            rename.addEventListener("mouseleave", () => { rename.style.background = "transparent"; });

            let disposed = false;
            const dispose = () => {
                if (disposed) return;
                disposed = true;
                document.removeEventListener("pointerdown", onOutside, true);
                document.removeEventListener("keydown", onKey, true);
                menu.remove();
            };
            const onOutside = e => { if (!menu.contains(e.target)) dispose(); };
            const onKey = e => { if (e.key === "Escape") { e.preventDefault(); dispose(); } };
            rename.addEventListener("click", () => { dispose(); renameQuickNode(node); });
            menu.appendChild(rename);
            document.body.appendChild(menu);
            const rect = menu.getBoundingClientRect();
            menu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - rect.width))}px`;
            menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - rect.height))}px`;
            document.addEventListener("pointerdown", onOutside, true);
            document.addEventListener("keydown", onKey, true);
        }

        function renderQuickNodesList() {
            const listEl = panel.querySelector('#xzg-quick-nodes-list');
            const countEl = panel.querySelector('#xzg-quick-count');
            if (!listEl || !countEl) return;

            const quickNodes = window.XZGQuickNodes?.getQuickNodeList() || [];
            countEl.textContent = quickNodes.length;

            if (quickNodes.length === 0) {
                listEl.innerHTML = '<div class="xzg-menu-empty-tip">' + xzgT('暂无快速连线','No quick links yet') + '<br><span style="font-size:11px;">' + xzgT('右键节点可添加到快速连线','Right-click a node to add to quick links') + '</span></div>';
                return;
            }

            listEl.innerHTML = '';
            quickNodes.forEach((node, index) => {
                const item = document.createElement('div');
                item.className = 'xzg-quick-node-manage-item';
                item.draggable = true;
                item.dataset.index = index;
                item.dataset.type = node.type;
                item.title = xzgT("右键重命名快速连线", "Right-click to rename this quick link");
                item.addEventListener("contextmenu", event => {
                    event.preventDefault(); event.stopPropagation();
                    showQuickNodeContextMenu(node, event);
                });

                const dragHandle = document.createElement('span');
                dragHandle.className = 'xzg-quick-drag-handle';
                dragHandle.textContent = '⠿';
                item.appendChild(dragHandle);

                const info = document.createElement('div');
                info.className = 'xzg-quick-node-info';
                
                const name = document.createElement('div');
                name.className = 'xzg-quick-node-name';
                name.textContent = node.title;
                info.appendChild(name);

                const type = document.createElement('div');
                type.className = 'xzg-quick-node-type';
                type.textContent = node.type;
                info.appendChild(type);

                item.appendChild(info);

                // 每个快速连线独立色块：点击可选择该快速连线的菜单颜色
                const colorBox = document.createElement('input');
                colorBox.type = 'color';
                colorBox.className = 'xzg-quick-node-color';
                colorBox.value = node.color || '#FFD700';
                colorBox.title = xzgT('设置该快速连线的菜单颜色','Set this quick link menu color');
                colorBox.style.cssText = 'width:24px;height:24px;border:none;background:none;cursor:pointer;padding:0;flex:none;';
                colorBox.addEventListener('click', (e) => e.stopPropagation());
                colorBox.addEventListener('input', (e) => {
                    e.stopPropagation();
                    if (window.XZGQuickNodes) {
                        window.XZGQuickNodes.setNodeColor(node.type, e.target.value);
                    }
                });
                item.appendChild(colorBox);

                const removeBtn = document.createElement('button');
                removeBtn.className = 'xzg-quick-node-remove-btn';
                removeBtn.textContent = xzgT('移除','Remove');
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (window.XZGQuickNodes) {
                        window.XZGQuickNodes.removeQuickNode(node.type);
                        renderQuickNodesList();
                    }
                });
                item.appendChild(removeBtn);

                item.addEventListener('dragstart', (e) => {
                    item.classList.add('dragging');
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', index.toString());
                });

                item.addEventListener('dragend', () => {
                    item.classList.remove('dragging');
                    document.querySelectorAll('.xzg-quick-node-manage-item').forEach(i => {
                        i.classList.remove('drag-over');
                    });
                });

                item.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    item.classList.add('drag-over');
                });

                item.addEventListener('dragleave', () => {
                    item.classList.remove('drag-over');
                });

                item.addEventListener('drop', (e) => {
                    e.preventDefault();
                    item.classList.remove('drag-over');
                    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
                    const toIndex = parseInt(item.dataset.index);
                    if (!isNaN(fromIndex) && !isNaN(toIndex) && fromIndex !== toIndex) {
                        if (window.XZGQuickNodes) {
                            window.XZGQuickNodes.moveQuickNode(fromIndex, toIndex);
                            renderQuickNodesList();
                        }
                    }
                });

                listEl.appendChild(item);
            });
        }

        const quickClearBtn = panel.querySelector('#xzg-quick-clear-btn');
        if (quickClearBtn) {
            quickClearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.XZGQuickNodes && confirm(xzgT('确定要清空所有快速连线吗？','Sure to clear all quick links?'))) {
                    const nodes = window.XZGQuickNodes.getQuickNodeList();
                    nodes.forEach(n => window.XZGQuickNodes.removeQuickNode(n.type));
                    renderQuickNodesList();
                }
            });
        }

        const quickHideDefaultBtn = panel.querySelector('#xzg-quick-hide-default-btn');

        if (quickHideDefaultBtn) {
            if (window.XZGQuickNodes) {
                const checked = window.XZGQuickNodes.isHideDefaultMenu();
                quickHideDefaultBtn.setAttribute("data-checked", checked ? "true" : "false");
                const label = quickHideDefaultBtn.querySelector(".xzg-toggle-label");
                if (label) label.textContent = checked ? xzgT("开","On") : xzgT("关","Off");
            }
            quickHideDefaultBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.XZGQuickNodes) {
                    const checked = window.XZGQuickNodes.isHideDefaultMenu();
                    const newChecked = !checked;
                    window.XZGQuickNodes.setHideDefaultMenu(newChecked);
                    quickHideDefaultBtn.setAttribute("data-checked", newChecked ? "true" : "false");
                    const label = quickHideDefaultBtn.querySelector(".xzg-toggle-label");
                    if (label) label.textContent = newChecked ? xzgT("开","On") : xzgT("关","Off");
                }
            });
        }

        window.XZGThemePanel = window.XZGThemePanel || {};
        window.XZGThemePanel.refreshQuickNodesTab = () => {
            if (panel.style.display !== 'none') {
                const quickTab = panel.querySelector('.xzg-tab-content[data-tab-content="quicknodes"]');
                if (quickTab && quickTab.style.display !== 'none') {
                    renderQuickNodesList();
                    if (quickHideDefaultBtn && window.XZGQuickNodes) {
                        const checked = window.XZGQuickNodes.isHideDefaultMenu();
                        quickHideDefaultBtn.setAttribute("data-checked", checked ? "true" : "false");
                        const label = quickHideDefaultBtn.querySelector(".xzg-toggle-label");
                        if (label) label.textContent = checked ? xzgT("开","On") : xzgT("关","Off");
                    }
                }
            }
        };

        panel.addEventListener("pointerdown", (e) => e.stopPropagation());
        panel.addEventListener("mousedown", (e) => e.stopPropagation());
        panel.addEventListener("contextmenu", (e) => e.stopPropagation());

        this.bindPickerEvents();
    },

    bindPickerEvents() {
        const picker = this.colorPicker;
        const self = this;

        const svArea = picker.querySelector("#xzg-sv-area");
        
        const startSV = (e) => {
            self.isDraggingSV = true;
            self.updateSVFromEvent(e);
            e.preventDefault();
        };
        svArea.addEventListener("mousedown", startSV);
        
        document.addEventListener("mousemove", (e) => {
            if (self.isDraggingSV) {
                self.updateSVFromEvent(e);
            }
            if (self.isDraggingHue) {
                self.updateHueFromEvent(e);
            }
            if (self.isDraggingAlpha) {
                self.updateAlphaFromEvent(e);
            }
        });

        const hueBar = picker.querySelector("#xzg-hue-bar");
        const startHue = (e) => {
            self.isDraggingHue = true;
            self.updateHueFromEvent(e);
            e.preventDefault();
        };
        hueBar.addEventListener("mousedown", startHue);

        // Alpha slider events
        const alphaBar = picker.querySelector("#xzg-alpha-bar");
        if (alphaBar) {
            const startAlpha = (e) => {
                self.isDraggingAlpha = true;
                self.updateAlphaFromEvent(e);
                e.preventDefault();
            };
            alphaBar.addEventListener("mousedown", startAlpha);
        }

        // Hex input events
        const hexInput = picker.querySelector("#xzg-hex-input");
        if (hexInput) {
            hexInput.addEventListener("input", (e) => {
                e.stopPropagation();
            });
            hexInput.addEventListener("change", () => {
                const val = hexInput.value.trim();
                if (/^#?[0-9a-fA-F]{3,8}$/.test(val)) {
                    const hex = val.startsWith('#') ? val : '#' + val;
                    self.setColorFromHex(hex, true);
                    if (self.isVisible) requestAnimationFrame(() => self.syncPickerCursors());
                }
            });
            hexInput.addEventListener("keydown", (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    hexInput.blur();
                }
            });
        }

        // Eyedropper events
        const eyedropperBtn = picker.querySelector("#xzg-eyedropper-btn");
        if (eyedropperBtn) {
            eyedropperBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                self.startEyedropper();
            });
        }

        picker.addEventListener("pointerdown", (e) => e.stopPropagation());
        picker.addEventListener("mousedown", (e) => e.stopPropagation());
        picker.addEventListener("contextmenu", (e) => e.stopPropagation());
    },

    updateSVFromEvent(e) {
        const svArea = this.colorPicker.querySelector("#xzg-sv-area");
        const svCursor = this.colorPicker.querySelector("#xzg-sv-cursor");
        const rect = svArea.getBoundingClientRect();
        let x = e.clientX - rect.left;
        let y = e.clientY - rect.top;
        x = Math.max(0, Math.min(rect.width, x));
        y = Math.max(0, Math.min(rect.height, y));
        
        svCursor.style.left = x + "px";
        svCursor.style.top = y + "px";
        
        const hsvS = (x / rect.width) * 100;
        const hsvV = 100 - (y / rect.height) * 100;
        
        const hsl = this.hsvToHsl(this.pickerState.h, hsvS, hsvV);
        this.pickerState.s = hsl.s;
        this.pickerState.l = hsl.l;
        
        this.applyColorFromPicker();
    },

    updateHueFromEvent(e) {
        const hueBar = this.colorPicker.querySelector("#xzg-hue-bar");
        const hueCursor = this.colorPicker.querySelector("#xzg-hue-cursor");
        const rect = hueBar.getBoundingClientRect();
        let x = e.clientX - rect.left;
        x = Math.max(0, Math.min(rect.width, x));
        
        hueCursor.style.left = x + "px";
        
        const h = (x / rect.width) * 360;
        this.pickerState.h = h;
        
        const svArea = this.colorPicker.querySelector("#xzg-sv-area");
        svArea.style.backgroundColor = `hsl(${h}, 100%, 50%)`;
        
        // Update alpha bar gradient color
        this.updateAlphaBarPreview();
        
        this.applyColorFromPicker();
    },

    updateAlphaFromEvent(e) {
        const alphaBar = this.colorPicker.querySelector("#xzg-alpha-bar");
        const alphaCursor = this.colorPicker.querySelector("#xzg-alpha-cursor");
        const rect = alphaBar.getBoundingClientRect();
        let x = e.clientX - rect.left;
        x = Math.max(0, Math.min(rect.width, x));
        
        alphaCursor.style.left = x + "px";
        
        this.pickerState.a = x / rect.width;
        
        this.applyColorFromPicker();
    },

    updateAlphaBarPreview() {
        const { h, s, l } = this.pickerState;
        const rgb = this.hslToRgb(h, s, l);
        const color = `hsl(${h}, ${s}%, ${l}%)`;
        const alphaColor = this.colorPicker.querySelector("#xzg-alpha-color");
        if (alphaColor) {
            alphaColor.style.background = `linear-gradient(to right, transparent, ${color})`;
        }
    },

    hsvToHsl(h, s, v) {
        s = s / 100;
        v = v / 100;
        const l = v * (1 - s / 2);
        const hslS = v === 0 ? 0 : (v - l) / Math.min(l, 1 - l);
        return { h: h, s: hslS * 100, l: l * 100 };
    },

    hslToHsv(h, s, l) {
        s = s / 100;
        l = l / 100;
        const v = l + s * Math.min(l, 1 - l);
        const hsvS = v === 0 ? 0 : 2 * (1 - l / v);
        return { h: h, s: hsvS * 100, v: v * 100 };
    },

    setColorFromHex(hex, updateSwatch = true, fromRgb = false) {
        const rgb = this.hexToRgb(hex);
        if (!rgb) return;
        
        const hsl = this.rgbToHsl(rgb.r, rgb.g, rgb.b);
        this.pickerState.h = hsl.h;
        this.pickerState.s = hsl.s;
        this.pickerState.l = hsl.l;
        
        if (updateSwatch && this.activeColorInput) {
            this.setActiveColor(hex);
        }
    },

    applyColorFromPicker() {
        if (!this.activeColorInput) return;
        const { h, s, l } = this.pickerState;
        const rgb = this.hslToRgb(h, s, l);
        const hex = this.rgbToHex(rgb.r, rgb.g, rgb.b);
        this.setActiveColor(hex);
    },

    setActiveColor(color) {
        if (!this.activeColorInput) return;
        
        const swatch = this.panel.querySelector(`[data-color="${this.activeColorInput}"]`);
        if (swatch) {
            swatch.style.backgroundColor = color;
        }
        
        // 连线颜色功能已取消
        // 连线颜色特殊处理：同步到 XZGThemeManager 并保存
        // if (this.activeColorInput === 'linkColor') {
        //     if (window.XZGThemeManager) {
        //         window.XZGThemeManager.linkColor = color;
        //     }
        //     try {
        //         localStorage.setItem('xzg-link-color', color);
        //     } catch(e) {}
        //     // 触发重绘以更新连线颜色
        //     if (window.app?.canvas?.setDirty) {
        //         app.canvas.setDirty(true, true);
        //     }
        // }
        
        // Update hex input
        this.updateHexInput();
        // Update gradient preview
        this.updateGradientPreview();
        // Add to recent colors
        if (this.isVisible) this.addRecentColor(color);
        
        if (this.isUpdatingFromNode) return;
        // 连线颜色不需要触发节点主题变更（功能已取消）
        // if (this.activeColorInput === 'linkColor') return;
        this.notifyChange();
    },

    updateHexInput() {
        if (!this.activeColorInput) return;
        const hexInput = this.colorPicker.querySelector("#xzg-hex-input");
        if (hexInput) {
            const swatch = this.panel.querySelector(`[data-color="${this.activeColorInput}"]`);
            if (swatch) {
                const bg = swatch.style.backgroundColor;
                const rgbMatch = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                if (rgbMatch) {
                    hexInput.value = this.rgbToHex(parseInt(rgbMatch[1]), parseInt(rgbMatch[2]), parseInt(rgbMatch[3]));
                } else if (bg.startsWith('#')) {
                    hexInput.value = bg;
                }
            }
        }
    },

    updateGradientPreview() {
        const preview = this.panel?.querySelector("#xzg-gradient-preview");
        if (!preview) return;
        
        const colors = this.getCurrentColors();
        const cssDeg = this.presetDirToCssDeg(colors.direction);
        const useTitleGradient = colors.useTitleGradient;
        
        if (useTitleGradient) {
            preview.style.background = `
                linear-gradient(${cssDeg}deg, ${colors.color1} 0%, ${colors.color2} 50%, ${colors.color3} 100%),
                linear-gradient(to bottom, ${colors.titleColor1}, ${colors.titleColor2}, ${colors.titleColor3})
            `;
            // Show split preview: top 40% title, bottom 60% body
            const titleDeg = this.presetDirToCssDeg(colors.titleDirection);
            preview.style.background = `linear-gradient(${titleDeg}deg, ${colors.titleColor1} 0%, ${colors.titleColor2} 50%, ${colors.titleColor3} 100%)`;
            preview.style.borderBottom = `2px solid ${colors.titleColor3}`;
        } else {
            preview.style.background = `linear-gradient(${cssDeg}deg, ${colors.color1} 0%, ${colors.color2} 50%, ${colors.color3} 100%)`;
            preview.style.borderBottom = 'none';
        }
    },

    hslToRgb(h, s, l) {
        h = h / 360;
        s = s / 100;
        l = l / 100;
        
        let r, g, b;
        
        if (s === 0) {
            r = g = b = l;
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
            r = hue2rgb(p, q, h + 1/3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1/3);
        }
        
        return { r: r * 255, g: g * 255, b: b * 255 };
    },

    rgbToHsl(r, g, b) {
        r = r / 255;
        g = g / 255;
        b = b / 255;
        
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;
        
        if (max === min) {
            h = s = 0;
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            
            switch (max) {
                case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
                case g: h = ((b - r) / d + 2) / 6; break;
                case b: h = ((r - g) / d + 4) / 6; break;
            }
        }
        
        return { h: h * 360, s: s * 100, l: l * 100 };
    },

    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    },

    rgbToHex(r, g, b) {
        r = Math.round(Math.max(0, Math.min(255, r)));
        g = Math.round(Math.max(0, Math.min(255, g)));
        b = Math.round(Math.max(0, Math.min(255, b)));
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    },

    getSwatchColor(colorKey) {
        const swatch = this.panel.querySelector(`[data-color="${colorKey}"]`);
        if (swatch) {
            const bg = swatch.style.backgroundColor || swatch.style.background || "#667eea";
            const rgbMatch = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (rgbMatch) {
                return this.rgbToHex(
                    parseInt(rgbMatch[1]),
                    parseInt(rgbMatch[2]),
                    parseInt(rgbMatch[3])
                );
            }
            return bg || "#667eea";
        }
        return "#667eea";
    },

    notifyChange() {
        const colors = this.getCurrentColors();
        const theme = {
            id: "custom",
            name: "自定义",
            colors: {
                titleText: colors.textColor,
                color1: colors.color1,
                color2: colors.color2,
                color3: colors.color3,
                direction: colors.direction,
                titleColor1: colors.titleColor1,
                titleColor2: colors.titleColor2,
                titleColor3: colors.titleColor3,
                titleDirection: colors.titleDirection,
                useTitleGradient: colors.useTitleGradient,
                useGradient: colors.useGradient,
                fontSize: colors.fontSize,
                textAlign: colors.textAlign
            }
        };

        if (this.onThemeChange) {
            this.onThemeChange(theme);
        }
    },

    savePosition() {
        if (!this.panel) return;
        const rect = this.panel.getBoundingClientRect();
        try {
            localStorage.setItem(this.positionKey, JSON.stringify({
                left: rect.left,
                top: rect.top
            }));
            cloudUIQueueGeometry();
        } catch(e) {}
    },

    loadPosition() {
        try {
            const saved = localStorage.getItem(this.positionKey);
            if (saved) return JSON.parse(saved);
        } catch(e) {}
        return null;
    },

    getCurrentColors() {
        const panel = this.panel;
        const color1 = this.getSwatchColor("color1");
        const color2 = this.getSwatchColor("color2");
        const color3 = this.getSwatchColor("color3");
        const titleColor1 = this.getSwatchColor("titleColor1");
        const titleColor2 = this.getSwatchColor("titleColor2");
        const titleColor3 = this.getSwatchColor("titleColor3");
        const textColor = this.getSwatchColor("textColor");
        const direction = panel.querySelector(".xzg-direction-buttons:not(.xzg-title-dir-buttons) .xzg-dir-btn.active")?.dataset.dir || "135";
        const titleDirection = panel.querySelector(".xzg-title-dir-buttons .xzg-dir-btn.active")?.dataset.titleDir || "135";
        const fontSize = parseInt(panel.querySelector("#xzg-font-size-value")?.textContent) || 14;
        const textAlign = panel.querySelector(".xzg-align-btn.active")?.dataset.align || "left";
        const titleToggle = panel.querySelector(".xzg-title-gradient-toggle");
        const useTitleGradient = titleToggle ? titleToggle.dataset.checked === "true" : false;

        return { 
            color1, color2, color3, 
            titleColor1, titleColor2, titleColor3,
            textColor, 
            direction, 
            titleDirection,
            useGradient: true, 
            useTitleGradient: useTitleGradient,
            fontSize, 
            textAlign 
        };
    },

    resetToDefault() {
        const panel = this.panel;
        if (!panel) return;

        this.isUpdatingFromNode = true;

        const c1 = panel.querySelector('[data-color="color1"]');
        const c2 = panel.querySelector('[data-color="color2"]');
        const c3 = panel.querySelector('[data-color="color3"]');
        const tc1 = panel.querySelector('[data-color="titleColor1"]');
        const tc2 = panel.querySelector('[data-color="titleColor2"]');
        const tc3 = panel.querySelector('[data-color="titleColor3"]');
        const ct = panel.querySelector('[data-color="textColor"]');
        // const lkc = panel.querySelector('[data-color="linkColor"]');
        if (c1) c1.style.backgroundColor = this.defaults.color1;
        if (c2) c2.style.backgroundColor = this.defaults.color2;
        if (c3) c3.style.backgroundColor = this.defaults.color3;
        if (tc1) tc1.style.backgroundColor = this.defaults.titleColor1;
        if (tc2) tc2.style.backgroundColor = this.defaults.titleColor2;
        if (tc3) tc3.style.backgroundColor = this.defaults.titleColor3;
        if (ct) ct.style.backgroundColor = this.defaults.textColor;
        // if (lkc) lkc.style.backgroundColor = this.defaults.linkColor;
        // 连线颜色功能已取消
        // if (window.XZGThemeManager) {
        //     window.XZGThemeManager.linkColor = this.defaults.linkColor;
        // }
        // try {
        //     localStorage.setItem('xzg-link-color', this.defaults.linkColor);
        // } catch(e) {}

        panel.querySelectorAll(".xzg-direction-buttons:not(.xzg-title-dir-buttons) .xzg-dir-btn").forEach(b => b.classList.remove("active"));
        const defaultDir = panel.querySelector(`[data-dir="${this.defaults.direction}"]`);
        if (defaultDir) defaultDir.classList.add("active");

        panel.querySelectorAll(".xzg-title-dir-buttons .xzg-dir-btn").forEach(b => b.classList.remove("active"));
        const defaultTitleDir = panel.querySelector(`[data-title-dir="${this.defaults.titleDirection}"]`);
        if (defaultTitleDir) defaultTitleDir.classList.add("active");

        const titleToggle = panel.querySelector(".xzg-title-gradient-toggle");
        if (titleToggle) {
            titleToggle.dataset.checked = String(this.defaults.useTitleGradient);
            const label = titleToggle.querySelector(".xzg-toggle-label");
            if (label) label.textContent = this.defaults.useTitleGradient ? xzgT("开","On") : xzgT("关","Off");
        }
        const titleSections = panel.querySelectorAll(".xzg-title-swatch-section");
        titleSections.forEach(sec => {
            sec.style.display = this.defaults.useTitleGradient ? "" : "none";
        });

        const fontSizeEl = panel.querySelector("#xzg-font-size-value");
        if (fontSizeEl) fontSizeEl.textContent = this.defaults.fontSize;

        panel.querySelectorAll(".xzg-align-btn").forEach(b => b.classList.remove("active"));
        const defaultAlign = panel.querySelector(`[data-align="${this.defaults.textAlign}"]`);
        if (defaultAlign) defaultAlign.classList.add("active");

        panel.querySelectorAll(".xzg-color-swatch").forEach(s => s.classList.remove("active"));
        const firstSwatch = panel.querySelector('[data-color="color1"]');
        if (firstSwatch) {
            firstSwatch.classList.add("active");
            this.activeColorInput = "color1";
        }
        this.setColorFromHex(this.defaults.color1, false);
        if (this.isVisible) {
            requestAnimationFrame(() => {
                this.syncPickerCursors();
            });
        }

        this.isUpdatingFromNode = false;
    },

    setCurrentTheme(themeData) {
        const panel = this.panel;
        if (!panel || !themeData || !themeData.colors) return;

        this.isUpdatingFromNode = true;

        const c = themeData.colors;
        const c1 = panel.querySelector('[data-color="color1"]');
        const c2 = panel.querySelector('[data-color="color2"]');
        const c3 = panel.querySelector('[data-color="color3"]');
        const tc1 = panel.querySelector('[data-color="titleColor1"]');
        const tc2 = panel.querySelector('[data-color="titleColor2"]');
        const tc3 = panel.querySelector('[data-color="titleColor3"]');
        const ct = panel.querySelector('[data-color="textColor"]');
        if (c1 && c.color1) c1.style.backgroundColor = c.color1;
        if (c2 && c.color2) c2.style.backgroundColor = c.color2;
        if (c3 && c.color3) c3.style.backgroundColor = c.color3;
        if (tc1 && c.titleColor1) tc1.style.backgroundColor = c.titleColor1;
        if (tc2 && c.titleColor2) tc2.style.backgroundColor = c.titleColor2;
        if (tc3 && c.titleColor3) tc3.style.backgroundColor = c.titleColor3;
        if (ct && c.titleText) ct.style.backgroundColor = c.titleText;

        const dir = c.direction || "135";
        panel.querySelectorAll(".xzg-direction-buttons:not(.xzg-title-dir-buttons) .xzg-dir-btn").forEach(b => b.classList.remove("active"));
        const dirBtn = panel.querySelector(`[data-dir="${dir}"]`);
        if (dirBtn) dirBtn.classList.add("active");

        const titleDir = c.titleDirection || "135";
        panel.querySelectorAll(".xzg-title-dir-buttons .xzg-dir-btn").forEach(b => b.classList.remove("active"));
        const titleDirBtn = panel.querySelector(`[data-title-dir="${titleDir}"]`);
        if (titleDirBtn) titleDirBtn.classList.add("active");

        const useTitleGradient = c.useTitleGradient === true;
        const titleToggle = panel.querySelector(".xzg-title-gradient-toggle");
        if (titleToggle) {
            titleToggle.dataset.checked = String(useTitleGradient);
            const label = titleToggle.querySelector(".xzg-toggle-label");
            if (label) label.textContent = useTitleGradient ? xzgT("开","On") : xzgT("关","Off");
        }
        const titleSections = panel.querySelectorAll(".xzg-title-swatch-section");
        titleSections.forEach(sec => {
            sec.style.display = useTitleGradient ? "" : "none";
        });

        if (c.fontSize !== undefined) {
            const fontSizeEl = panel.querySelector("#xzg-font-size-value");
            if (fontSizeEl) fontSizeEl.textContent = c.fontSize;
        }

        const align = c.textAlign || "left";
        panel.querySelectorAll(".xzg-align-btn").forEach(b => b.classList.remove("active"));
        const alignBtn = panel.querySelector(`[data-align="${align}"]`);
        if (alignBtn) alignBtn.classList.add("active");

        this.isUpdatingFromNode = false;
        
        if (this.isVisible) {
            const activeColor = this.getSwatchColor(this.activeColorInput || "color1");
            this.setColorFromHex(activeColor, false);
            requestAnimationFrame(() => {
                this.syncPickerCursors();
            });
        }
    },

    show(x, y) {
        if (!this.panel) this.create();
        this.isVisible = true;
        this.panel.style.display = "block";
        cloudUIInit().then(() => {
            if (!this.isVisible || !this.panel) return;
            const remotePosition = this.loadPosition();
            if (remotePosition && Number.isFinite(remotePosition.left) && Number.isFinite(remotePosition.top)) {
                const rect = this.panel.getBoundingClientRect();
                const left = Math.max(10, Math.min(remotePosition.left, window.innerWidth - rect.width - 10));
                const top = Math.max(10, Math.min(remotePosition.top, window.innerHeight - rect.height - 10));
                this.panel.style.left = `${left}px`;
                this.panel.style.top = `${top}px`;
            }
        }).catch(() => {});
        // 面板每次重新打开都回到「主题」页；其他标签只在本次打开期间切换。
        if (typeof this._switchTopTab === "function") this._switchTopTab("theme");
        // 打开面板时兜底刷新菜单隐藏列表，避免隐藏菜单项后重新打开仍显示旧列表
        try {
            if (this._refreshMenuListUI) this._refreshMenuListUI();
        } catch (e) {}
        
        const rect = this.panel.getBoundingClientRect();
        let left, top;

        const savedPos = this.loadPosition();
        if (savedPos) {
            left = savedPos.left;
            top = savedPos.top;
        } else if (x !== undefined && y !== undefined) {
            left = x;
            top = y;
        } else {
            left = window.innerWidth - rect.width - 10;
            top = Math.max(10, (window.innerHeight - rect.height) / 2);
        }

        if (left + rect.width > window.innerWidth) {
            left = window.innerWidth - rect.width - 10;
        }
        if (top + rect.height > window.innerHeight) {
            top = window.innerHeight - rect.height - 10;
        }
        if (left < 10) left = 10;
        if (top < 10) top = 10;

        this.panel.style.left = left + "px";
        this.panel.style.top = top + "px";
        
        requestAnimationFrame(() => {
            this.syncPickerCursors();
            this.updateGradientPreview();
            this.updateRecentDisplay();
        });

        // 点击空白画布关闭面板
        this._setupCanvasBgClose();

        // Bind clear recent colors button (re-bind on each show for safety)
        const clearBtn = document.getElementById("xzg-clear-recent");
        if (clearBtn && !clearBtn._bound) {
            clearBtn._bound = true;
            clearBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.clearRecentColors();
            });
        }
    },

    _setupCanvasBgClose() {
        if (this._canvasBgCloseHandler) return;
        const self = this;
        this._canvasBgCloseHandler = (e) => {
            if (!self.isVisible) return;
            // 主题入口按钮单独负责开关面板，避免捕获阶段先关闭、随后 click 又立即打开。
            if (e.target.closest("#xzg-theme-menu-btn")) return;
            // 点击面板内部 → 不关闭
            if (self.panel && self.panel.contains(e.target)) return;
            // 点击面板的弹出层（取色器 / 对话框）→ 不关闭
            if (e.target.closest(".xzg-dialog-overlay") || e.target.closest(".xzg-color-picker-popup") || e.target.closest(".xzg-wf-dialog-overlay") || e.target.closest(".xzg-quick-link-context-menu") || e.target.closest(".xzg-quick-link-rename-overlay")) return;
            // 点击菜单 / 右键菜单 → 不关闭
            if (e.target.closest(".comfy-menu") || e.target.closest(".litecontextmenu") || e.target.closest(".context-menu")) return;

            // 判断点击位置是否在画布区域内
            const graphCanvas = document.getElementById("graph-canvas");
            if (!graphCanvas) return;
            const canvasRect = graphCanvas.getBoundingClientRect();
            if (e.clientX < canvasRect.left || e.clientX > canvasRect.right ||
                e.clientY < canvasRect.top || e.clientY > canvasRect.bottom) {
                return; // 不在画布区域
            }

            // 判断是否点击在节点上：优先使用 DOM 检测，再尝试 LiteGraph API
            const nodeEl = e.target.closest(".comfy-node") || e.target.closest(".litegraph .node");
            if (nodeEl) return;
            if (app?.canvas?.graph) {
                try {
                    const pos = app.canvas.convertEventToCanvasOffset(e);
                    const node = app.canvas.graph.getNodeOnPos(pos[0], pos[1]);
                    if (node) return;
                } catch (_) {}
            }

            // 点击在空白画布上 → 关闭面板
            self.hide();
        };
        document.addEventListener("pointerdown", this._canvasBgCloseHandler, true);
    },

    _removeCanvasBgClose() {
        if (this._canvasBgCloseHandler) {
            document.removeEventListener("pointerdown", this._canvasBgCloseHandler, true);
            this._canvasBgCloseHandler = null;
        }
    },

    syncPickerCursors() {
        const picker = this.colorPicker;
        const { h, s, l, a } = this.pickerState;
        
        const svArea = picker.querySelector("#xzg-sv-area");
        const svCursor = picker.querySelector("#xzg-sv-cursor");
        const hueBar = picker.querySelector("#xzg-hue-bar");
        const hueCursor = picker.querySelector("#xzg-hue-cursor");
        const alphaBar = picker.querySelector("#xzg-alpha-bar");
        const alphaCursor = picker.querySelector("#xzg-alpha-cursor");
        
        if (svArea) svArea.style.backgroundColor = `hsl(${h}, 100%, 50%)`;
        
        if (svCursor) {
            const hsv = this.hslToHsv(h, s, l);
            const svRect = svArea.getBoundingClientRect();
            const cursorX = (hsv.s / 100) * svRect.width;
            const cursorY = (1 - hsv.v / 100) * svRect.height;
            svCursor.style.left = cursorX + "px";
            svCursor.style.top = cursorY + "px";
        }
        
        if (hueCursor) {
            const hueRect = hueBar.getBoundingClientRect();
            hueCursor.style.left = (h / 360) * hueRect.width + "px";
        }
        
        // Sync alpha cursor
        if (alphaCursor && alphaBar) {
            const alphaRect = alphaBar.getBoundingClientRect();
            alphaCursor.style.left = ((a !== undefined ? a : 1) * alphaRect.width) + "px";
        }
        
        // Update alpha bar color preview
        this.updateAlphaBarPreview();
        
        // Update hex input
        this.updateHexInput();
    },

    hide() {
        this.isVisible = false;
        if (this.panel) {
            this.panel.style.display = "none";
        }
        this._removeCanvasBgClose();
        if (this.onClose) {
            this.onClose();
        }
    },

    getShortcut() {
        try {
            const stored = localStorage.getItem("xzg_theme_shortcut");
            if (stored) {
                return JSON.parse(stored);
            }
        } catch (e) {}
        return { key: "c", ctrl: false, alt: false, shift: false, meta: false };
    },

    saveShortcut(shortcut) {
        localStorage.setItem("xzg_theme_shortcut", JSON.stringify(shortcut));
        this._queueThemePanelCloudSave();
    },

    updateShortcutDisplay() {
        const display = this.panel?.querySelector("#xzg-theme-shortcut-btn");
        if (!display) return;

        const shortcut = this.getShortcut();
        const parts = [];
        if (shortcut.ctrl) parts.push("Ctrl");
        if (shortcut.alt) parts.push("Alt");
        if (shortcut.shift) parts.push("Shift");
        parts.push(shortcut.key.toUpperCase());
        display.textContent = xzgT('快捷键','Shortcut') + ": " + parts.join("+");
    },

    showShortcutDialog() {
        const self = this;
        const originalShortcut = this.getShortcut();
        let pendingShortcut = null;
        const dialog = document.createElement("div");
        dialog.className = "xzg-dialog-overlay";
        dialog.innerHTML = `
            <div class="xzg-dialog">
                <div class="xzg-dialog-title">${xzgT('设置快捷键','Set Shortcut')}</div>
                <div class="xzg-dialog-body">
                    <p style="margin-bottom: 16px; color: #888; font-size: 12px; text-align: center;">${xzgT('请按下你想要的快捷键','Press the shortcut keys you want')}</p>
                    <div style="text-align: center; margin-bottom: 16px;">
                        <div id="xzg-listen-display" style="
                            padding: 16px 24px;
                            background: #667eea;
                            border: 2px solid #667eea;
                            border-radius: 6px;
                            color: #fff;
                            font-size: 16px;
                            font-weight: bold;
                            min-width: 180px;
                            display: inline-block;
                        ">${xzgT('请按快捷键...','Press keys...')}</div>
                    </div>
                </div>
                <div class="xzg-dialog-footer">
                    <button class="xzg-btn xzg-btn-cancel" id="xzg-dialog-cancel" type="button">${xzgT('取消','Cancel')}</button>
                    <button class="xzg-btn xzg-btn-ok" id="xzg-dialog-ok" type="button" disabled>${xzgT('确定','OK')}</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);

        const display = dialog.querySelector("#xzg-listen-display");
        const okBtn = dialog.querySelector("#xzg-dialog-ok");
        let isListening = true;
        let keydownHandler = null;

        const cleanup = () => {
            isListening = false;
            document.removeEventListener("keydown", keydownHandler, true);
            dialog.remove();
        };

        const showPreview = (shortcut) => {
            const parts = [];
            if (shortcut.ctrl) parts.push("Ctrl");
            if (shortcut.alt) parts.push("Alt");
            if (shortcut.shift) parts.push("Shift");
            parts.push(shortcut.key.toUpperCase());
            display.textContent = parts.join(" + ");
            display.style.background = "#2a2a2a";
            display.style.color = "#667eea";
            okBtn.disabled = false;
        };

        keydownHandler = (e) => {
            if (!isListening) return;
            e.preventDefault();
            e.stopPropagation();

            if (e.key === "Escape") return;

            const key = e.key.toLowerCase();
            if (key === "control" || key === "alt" || key === "shift" || key === "meta") {
                return;
            }

            pendingShortcut = {
                key: key,
                ctrl: e.ctrlKey,
                alt: e.altKey,
                shift: e.shiftKey,
                meta: e.metaKey
            };

            showPreview(pendingShortcut);
        };

        document.addEventListener("keydown", keydownHandler, true);

        // 取消：不做任何变更
        dialog.querySelector("#xzg-dialog-cancel").addEventListener("click", () => {
            cleanup();
        });

        // 确定：保存并生效
        okBtn.addEventListener("click", () => {
            if (!pendingShortcut) return;
            this.saveShortcut(pendingShortcut);
            this.updateShortcutDisplay();
            cleanup();
            setTimeout(() => {
                if (this.onShortcutChange) {
                    this.onShortcutChange(pendingShortcut);
                }
            }, 100);
        });


    },

    getPresets() {
        try {
            const stored = localStorage.getItem("xzg_theme_presets");
            if (stored) {
                const presets = JSON.parse(stored);
                if (Array.isArray(presets) && presets.length === 5) {
                    return presets;
                }
            }
        } catch (e) {}
        return JSON.parse(JSON.stringify(this.defaultPresets));
    },

    savePresets(presets) {
        localStorage.setItem("xzg_theme_presets", JSON.stringify(presets));
        this._queueThemePanelCloudSave();
    },

    // ====== 主题面板设置（预设/快捷键/最近色/标签页）云持久化 ======
    _collectThemePanelState() {
        let tab = "theme";
        try { tab = localStorage.getItem('xzg-theme-panel-tab') || "theme"; } catch(e) {}
        return {
            presets: this.getPresets(),
            shortcut: this.getShortcut(),
            recentColors: Array.isArray(this.recentColors) ? this.recentColors : [],
            tab: tab
        };
    },

    _queueThemePanelCloudSave() {
        if (this._themePanelCloudTimer) clearTimeout(this._themePanelCloudTimer);
        const self = this;
        this._themePanelCloudTimer = setTimeout(() => {
            this._themePanelCloudTimer = null;
            cloudSave(THEME_PANEL_STATE_KEY, self._collectThemePanelState()).catch(() => {});
        }, 500);
    },

    async _cloudRestoreThemePanel() {
        try {
            const s = await cloudLoad(THEME_PANEL_STATE_KEY, { fallbackValue: null });
            if (!s || typeof s !== "object") return;
            let changed = false;
            if (Array.isArray(s.presets) && s.presets.length === 5) {
                try { localStorage.setItem("xzg_theme_presets", JSON.stringify(s.presets)); changed = true; } catch(e) {}
            }
            if (s.shortcut && typeof s.shortcut === "object" && s.shortcut.key) {
                try { localStorage.setItem("xzg_theme_shortcut", JSON.stringify(s.shortcut)); changed = true; } catch(e) {}
            }
            if (Array.isArray(s.recentColors)) {
                this.recentColors = s.recentColors.slice(0, this.maxRecentColors || 12);
                try { localStorage.setItem("xzg_recent_colors", JSON.stringify(this.recentColors)); changed = true; } catch(e) {}
            }
            if (s.tab === "theme" || s.tab === "themeplus" || s.tab === "menuhide" || s.tab === "quicknodes") {
                try { localStorage.setItem('xzg-theme-panel-tab', s.tab); changed = true; } catch(e) {}
            }
            if (!changed) return;
            // 面板已打开时刷新相关 UI
            if (this.panel) {
                this.updateShortcutDisplay();
                this.renderPresets();
                this.updateRecentDisplay();
            }
        } catch (e) {
            console.warn("[小珠光] 从云同步主题面板设置失败:", e);
        }
    },

    // ====== ComfyUI 设置（含快捷键）导出导入辅助方法 ======
    // 需要导出的 ComfyUI 设置键的前缀（匹配这些前缀的设置会被导出）
    comfySettingsKeyPrefixes: [
        "Comfy.Keybinding.",     // 快捷键设置（最核心）
        "Comfy.Locale",          // 语言设置
        "Comfy.ColorPalette",    // 颜色主题
        "Comfy.CustomColor",     // 自定义颜色
        "Comfy.LinkRenderMode",  // 连线渲染模式
        "Comfy.Workflow.",       // 工作流相关设置
        "Comfy.NodeLibrary.",    // 节点库收藏等
        "Comfy.RightSidePanel.", // 右侧面板
        "Comfy.Minimap.",        // 小地图
        "Comfy.LinkRenderMode",  // 连线渲染模式
        "Comfy.Validation.",     // 工作流校验
        "Comfy.Tutorial",        // 教程完成状态
        "Comfy.VueNodes.",       // Vue节点开关
        "Comfy.MaskEditor.",     // 遮罩编辑器
        "Comfy.Pointer.",        // 指针交互
        "LiteGraph.",            // LiteGraph 画布设置
        "AddNodeMenu.",          // 添加节点菜单
        "AutoLayout.",           // 自动布局
        "FastLink.",             // 快速连线
        "AlignLayout.",          // 对齐布局
        "pysssss.",              // pysssss 扩展设置
        "HAIGC.",                // HAIGC 扩展设置
        "PromptAssistant.",      // 提示词助手
        "Crystools.",            // Crystools 扩展
        "zml.",                  // 悬浮球等扩展
        "WOSAI.",                // 万赛扩展
    ],

    /**
     * 获取 API 基础路径（兼容不同版本的 ComfyUI）
     */
    getApiBaseUrl() {
        // 优先使用全局 api 对象
        if (typeof api !== "undefined" && api && api.apiURL) {
            return "";
        }
        // 否则使用当前页面的相对路径
        return "";
    },

    /**
     * 从 ComfyUI 服务器获取全部设置
     */
    async getComfySettings() {
        try {
            // 优先使用全局 api 对象（如果存在）
            if (typeof api !== "undefined" && api && typeof api.fetchApi === "function") {
                const resp = await api.fetchApi("/settings", { method: "GET", cache: "no-store" });
                if (!resp.ok) return null;
                return await resp.json();
            }
            // 降级使用原生 fetch
            const resp = await fetch("/settings", {
                method: "GET",
                cache: "no-store",
                headers: { "Content-Type": "application/json" }
            });
            if (!resp.ok) return null;
            return await resp.json();
        } catch (e) {
            console.warn("[XZG] Failed to fetch comfy settings:", e);
            return null;
        }
    },

    /**
     * 筛选需要导出的 ComfyUI 设置（只导出匹配前缀的设置项）
     */
    filterComfySettingsForExport(allSettings) {
        if (!allSettings || typeof allSettings !== "object") return {};
        const filtered = {};
        const prefixes = this.comfySettingsKeyPrefixes;
        for (const key in allSettings) {
            if (prefixes.some(p => key.startsWith(p))) {
                filtered[key] = allSettings[key];
            }
        }
        return filtered;
    },

    /**
     * 将 ComfyUI 设置写回服务器
     */
    async applyComfySettings(settings) {
        if (!settings || typeof settings !== "object") return false;
        try {
            // 优先使用全局 api 对象（如果存在）
            if (typeof api !== "undefined" && api && typeof api.fetchApi === "function") {
                const resp = await api.fetchApi("/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(settings)
                });
                return resp.ok;
            }
            // 降级使用原生 fetch
            const resp = await fetch("/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(settings)
            });
            return resp.ok;
        } catch (e) {
            console.warn("[XZG] Failed to apply comfy settings:", e);
            return false;
        }
    },

    /** 从 XZG 顶部按钮的右键菜单打开统一配置导入/导出入口。 */
    async openConfigTransferDialog() {
        this._ensureGlobalDialogCSS();
        const overlay = document.createElement("div");
        overlay.className = "xzg-modal-overlay";
        overlay.style.zIndex = "2000001";
        overlay.innerHTML = `
            <div class="xzg-modal-dialog">
                <div class="xzg-modal-title">${xzgT('导入导出配置', 'Import / Export Config')}</div>
                <div class="xzg-modal-body" style="gap:8px">
                    <div class="xzg-modal-hint">${xzgT('导出或导入小珠光与 ComfyUI 的配置。', 'Export or import Xiaozhuguang and ComfyUI settings.')}</div>
                </div>
                <div class="xzg-modal-footer">
                    <button type="button" class="xzg-modal-btn xzg-modal-danger" data-action="initialize">${xzgT('初始化', 'Initialize')}</button>
                    <button type="button" class="xzg-modal-btn xzg-modal-cancel xzg-transfer-neutral">${xzgT('取消', 'Cancel')}</button>
                    <button type="button" class="xzg-modal-btn xzg-transfer-neutral" data-action="import">${xzgT('导入配置', 'Import')}</button>
                    <button type="button" class="xzg-modal-btn xzg-transfer-neutral" data-action="export">${xzgT('导出配置', 'Export')}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.querySelector(".xzg-modal-cancel").addEventListener("click", close);
        overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
        overlay.querySelector('[data-action="initialize"]').addEventListener("click", () => {
            close();
            this.confirmInitialize().then(confirmed => {
                if (confirmed) this.initializePersistedState().catch(err => {
                    console.error("[XZG] Initialization error:", err);
                    alert(xzgT('初始化失败：', 'Initialization failed: ') + err.message);
                });
            });
        });
        overlay.querySelector('[data-action="import"]').addEventListener("click", () => {
            close();
            this.openConfigImportPicker();
        });
        overlay.querySelector('[data-action="export"]').addEventListener("click", () => {
            close();
            this.exportAllConfig().catch(err => {
                console.error("[XZG] Export error:", err);
                alert(xzgT('导出失败：', 'Export failed: ') + err.message);
            });
        });
    },

    /** 初始化前显示三次独立警告确认；任一步取消都不会清理数据。 */
    async confirmInitialize() {
        for (let step = 1; step <= 3; step++) {
            const confirmed = await new Promise(resolve => {
            this._ensureGlobalDialogCSS();
            const overlay = document.createElement("div");
            overlay.className = "xzg-modal-overlay";
            overlay.style.zIndex = "2000002";
            const finalStep = step === 3;
            const warning = step === 1
                ? xzgT('将清除快速连线、隐藏菜单规则及其他小珠光自定义配置，并初始化为初始状态。', 'This will clear quick links, hidden-menu rules, and other Xiaozhuguang custom settings, returning to the initial state.')
                : step === 2
                    ? xzgT('此操作不可撤销，浏览器与服务端的小珠光持久化都会被清理。', 'This cannot be undone. Xiaozhuguang persistence in both the browser and server will be cleared.')
                : xzgT('最后一次确认：继续后立即清除配置并初始化，随后刷新页面。', 'Final warning: continuing will immediately clear the configuration, initialize it, and reload the page.');
            overlay.innerHTML = `
                <div class="xzg-modal-dialog" style="width:min(520px,calc(100vw - 32px))">
                    <div class="xzg-modal-title">${xzgT(`初始化警告（${step}/3）`, `Initialization Warning (${step}/3)`)}</div>
                    <div class="xzg-modal-body" style="gap:8px">
                        <div>${warning}</div>
                        <div>${xzgT('同时清空收藏预览和主题壁纸数据，并载入初始默认快捷键。', 'Favorite previews and theme wallpapers will also be cleared, and initial default shortcuts loaded.')}</div>
                        <div style="color:#ffb4a9">${xzgT('包括主题、快速连线、隐藏菜单自定义规则、预设、收藏、工作流管理器偏好等。操作不可撤销；不会删除工作流文件或 ComfyUI 核心设置。', 'This includes theme, quick links, custom hidden-menu rules, presets, favorites, and workflow-manager preferences. This cannot be undone; workflow files and core ComfyUI settings are not deleted.')}</div>
                    </div>
                    <div class="xzg-modal-footer">
                        <button type="button" class="xzg-modal-btn xzg-modal-cancel">${xzgT('取消', 'Cancel')}</button>
                        <button type="button" class="xzg-modal-btn xzg-modal-danger" data-confirm-initialize>${finalStep ? xzgT('确认初始化', 'Confirm Initialization') : xzgT(`继续（${step}/3）`, `Continue (${step}/3)`)}</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            const close = value => {
                document.removeEventListener("keydown", onKey, true);
                overlay.remove();
                resolve(value);
            };
            overlay.querySelector(".xzg-modal-cancel").addEventListener("click", () => close(false));
            overlay.querySelector("[data-confirm-initialize]").addEventListener("click", () => close(true));
            overlay.addEventListener("click", event => { if (event.target === overlay) close(false); });
            const onKey = event => { if (event.key === "Escape") close(false); };
            document.addEventListener("keydown", onKey, true);
            });
            if (!confirmed) return false;
        }
        return true;
    },

    async _clearPersistedIndexedStore(dbName, storeName) {
        if (!window.indexedDB) return;
        if (typeof indexedDB.databases === "function") {
            const dbs = await indexedDB.databases();
            if (!dbs.some(db => db.name === dbName)) return;
        }
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(dbName);
            let created = false;
            request.onupgradeneeded = () => { created = true; };
            request.onerror = () => reject(request.error || new Error(`Cannot open ${dbName}`));
            request.onsuccess = () => {
                if (created) {
                    const fresh = request.result;
                    fresh.close();
                    const deletion = indexedDB.deleteDatabase(dbName);
                    deletion.onsuccess = () => resolve(null);
                    deletion.onerror = () => reject(deletion.error || new Error(`Cannot remove ${dbName}`));
                    deletion.onblocked = () => reject(new Error(`Database ${dbName} is busy`));
                    return;
                }
                resolve(request.result);
            };
        });
        if (!db || !db.objectStoreNames.contains(storeName)) { db?.close(); return; }
        await new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, "readwrite");
            tx.objectStore(storeName).clear();
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error(`Cannot clear ${dbName}`));
            tx.onabort = () => reject(tx.error || new Error(`Cannot clear ${dbName}`));
        }).finally(() => db.close());
    },

    /** 清除小珠光专属持久化配置，成功后刷新页面使所有模块进入初始状态。 */
    async initializePersistedState() {
        const fetchFn = (typeof api !== "undefined" && api?.fetchApi) ? api.fetchApi.bind(api) : fetch;

        // ComfyUI 将功能开关值保存在服务器设置中；这些开关的注册默认值均为 true。
        // 只初始化小珠光功能开关，不改动用户的 ComfyUI 核心设置。
        try {
            const settingsResponse = await fetchFn("/settings", { method: "GET", cache: "no-store" });
            if (settingsResponse.ok) {
                const savedSettings = await settingsResponse.json();
                const defaults = {};
                for (const [key, value] of Object.entries(savedSettings || {})) {
                    if (key.startsWith("xiaozhuguang.Toggle.Enable") && typeof value === "boolean") defaults[key] = true;
                }
                if (Object.keys(defaults).length) {
                    const resetSettingsResponse = await fetchFn("/settings", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(defaults),
                    });
                    if (!resetSettingsResponse.ok) throw new Error("Unable to reset Xiaozhuguang feature toggles");
                }
            }
        } catch (error) {
            throw new Error(xzgT('初始化小珠光功能开关失败：', 'Failed to initialize Xiaozhuguang feature toggles: ') + (error.message || error));
        }

        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.startsWith("xzg") || key.startsWith("xiaozhuguang.") || key === "comfyui_xiaozhuguang" || key === "xz_selector_dialog_pos")) keys.push(key);
        }
        for (const key of keys) localStorage.removeItem(key);

        const idbErrors = [];
        for (const [dbName, storeName] of [["XiaozhuguangFavorites", "nodePreviews"], ["XzgThemeWallpaper", "wallpapers"]]) {
            try { await this._clearPersistedIndexedStore(dbName, storeName); }
            catch (error) { idbErrors.push(error.message || String(error)); }
        }
        // 最后清理服务端快照并重建默认快捷键，避免页面当前模块的待完成同步把旧配置留在云端。
        const response = await fetchFn("/xzg/reset_persistence", { method: "POST", cache: "no-store" });
        if (!response.ok) {
            let detail = "HTTP " + response.status;
            try { detail = (await response.json()).error || detail; } catch (_) {}
            throw new Error(detail);
        }
        if (idbErrors.length) {
            alert(xzgT('小珠光已初始化，但部分 IndexedDB 数据未能清理：', 'Xiaozhuguang was initialized, but some IndexedDB data could not be cleared: ') + idbErrors.join('; '));
        } else {
            alert(xzgT('小珠光已完成初始化，页面即将刷新。', 'Xiaozhuguang initialization is complete. The page will reload.'));
        }
        setTimeout(() => location.reload(), 500);
    },

    async configTransfer(label, action) {
        if (this._configTransferBusy) throw new Error(xzgT("备份或还原正在进行，请稍候", "A backup or restore is already running. Please wait."));
        this._configTransferBusy = true;
        const overlay = document.createElement("div");
        overlay.className = "xzg-modal-overlay";
        overlay.style.zIndex = "2000002";
        const message = document.createElement("div");
        message.className = "xzg-modal-dialog";
        message.textContent = label;
        message.setAttribute("role", "status");
        overlay.appendChild(message);
        document.body.appendChild(overlay);
        try { return await action(); }
        finally { overlay.remove(); this._configTransferBusy = false; }
    },

    async uploadConfigArchive(file, restore = false, libraries = null) {
        return this.configTransfer(restore
            ? xzgT("正在校验并还原媒体库，请稍候…", "Validating and restoring the media library…")
            : xzgT("正在读取 ZIP 备份，请稍候…", "Reading ZIP backup…"), async () => {
            const response = await api.fetchApi(`/xzg/media-library/archive${restore ? "/restore" : ""}`, {
                method: "POST",
                headers: { "Content-Type": restore ? "application/json" : "application/zip" },
                body: restore ? JSON.stringify({ token: file, ...(libraries ? { libraries } : {}) }) : file,
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
            return result;
        });
    },

    /** 选择并应用统一配置文件。 */
    openConfigImportPicker() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".zip,.json,application/zip,application/json";
        input.style.display = "none";
        document.body.appendChild(input);
        input.addEventListener("cancel", () => input.remove(), { once: true });
        input.addEventListener("change", async () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) return;
            let archiveToken = null;
            try {
                let obj;
                if (/\.zip$/i.test(file.name)) {
                    const archive = await this.uploadConfigArchive(file);
                    archiveToken = archive.token;
                    obj = archive.config;
                } else {
                    obj = JSON.parse(await file.text());
                }
                const result = await this.importAllConfig(obj, archiveToken);
                if (result?.applied) {
                    const parts = [];
                    if (result.appliedXzgConfig || result.appliedNotes) parts.push(xzgT('小珠光配置', 'Xiaozhuguang config'));
                    if (result.appliedComfySettings) parts.push(xzgT('ComfyUI 设置', 'ComfyUI settings'));
                    if (result.restoredAudioCount != null) parts.push(xzgT(`媒体库 ${result.restoredAudioCount} 个音频`, `Media library: ${result.restoredAudioCount} audio files`));
                    if (result.restoredVideoCount != null) parts.push(xzgT(`媒体库 ${result.restoredVideoCount} 个视频`, `Media library: ${result.restoredVideoCount} videos`));
                    if (result.restoredMediaCount != null) parts.push(xzgT(`媒体库 ${result.restoredMediaCount} 张图片`, `Media library: ${result.restoredMediaCount} images`));
                    if (result.restoredTextBoxPreviews != null) parts.push(xzgT(`文本框缩略图 ${result.restoredTextBoxPreviews} 张`, `Text-box previews: ${result.restoredTextBoxPreviews}`));
                    alert(xzgT('导入成功（', 'Import succeeded (') + parts.join(' + ') + xzgT('），正在刷新以应用全部配置…', '). Refreshing to apply all settings…'));
                    setTimeout(() => location.reload(), 300);
                }
            } catch (err) {
                alert(xzgT('导入失败：配置文件无效', 'Import failed: invalid config file') + ' (' + err.message + ')');
            } finally {
                if (archiveToken) {
                    try {
                        await api.fetchApi("/xzg/media-library/archive", {
                            method: "DELETE", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ token: archiveToken }),
                        });
                    } catch (_) { /* 后端会自动清理到期的临时备份 */ }
                }
            }
        }, { once: true });
        input.click();
    },

    /**
     * 显示导出选项对话框
     */
    showExportDialog(importAvailability = null) {
        return new Promise((resolve) => {
            this._ensureGlobalDialogCSS();
            const overlay = document.createElement("div");
            overlay.className = "xzg-modal-overlay";
            overlay.style.zIndex = "2000001";
            const importing = importAvailability !== null;
            const rows = XZG_EXPORT_CATEGORIES.map(([id, zh, en], index) => {
                const available = !importing || importAvailability[id];
                return `
                <label class="xzg-modal-checkbox xzg-export-category-row" style="align-items:center;padding:4px 7px;border:1px solid #444;border-radius:5px;margin:0;gap:6px;min-height:24px;opacity:${available ? 1 : 0.5}">
                    <input type="checkbox" data-export-category="${id}" ${available ? "checked" : "disabled"} />
                    <span style="flex:1;min-width:0">${String(index + 1).padStart(2, "0")}. ${xzgT(zh, en)}${available ? "" : xzgT("（文件中无此项）", " (not in file)")}</span>
                </label>`;
            }).join("");
            overlay.innerHTML = `
                <div class="xzg-modal-dialog" style="width:min(620px,calc(100vw - 32px));max-height:85vh;display:flex;flex-direction:column">
                    <div class="xzg-modal-title" style="justify-content:space-between">
                        <span>${importing ? xzgT('导入配置', 'Import Config') : xzgT('导出配置', 'Export Config')}</span>
                        <div style="display:flex;gap:8px">
                            <button type="button" class="xzg-modal-btn" data-select-all="true" style="padding:4px 12px">${xzgT('全选','Select all')}</button>
                            <button type="button" class="xzg-modal-btn" data-select-all="false" style="padding:4px 12px">${xzgT('全不选','Select none')}</button>
                        </div>
                    </div>
                    <div class="xzg-modal-body" style="overflow:auto;gap:6px">
                        ${importing ? `<div class="xzg-modal-warning">${xzgT("导入将覆盖勾选项的当前设置。", "Import will overwrite the selected settings.")}</div>` : ""}
                        <div class="xzg-export-category-list" style="display:flex;flex-direction:column;gap:2px">${rows}</div>
                        <label class="xzg-modal-checkbox" style="align-items:center;padding:4px 7px;margin:0;gap:6px;min-height:24px;border:1px solid #444;border-radius:5px">
                            <input type="checkbox" id="xzg-export-include-comfy" ${!importing || importAvailability.comfy ? "checked" : "disabled"} />
                            <span style="flex:1;opacity:${!importing || importAvailability.comfy ? 1 : 0.5}">${String(XZG_EXPORT_CATEGORIES.length + 1).padStart(2, "0")}. ${xzgT('ComfyUI 设置','ComfyUI settings')}${!importing || importAvailability.comfy ? "" : xzgT("（文件中无此项）", " (not in file)")}</span>
                        </label>
                    </div>
                    <div class="xzg-modal-footer">
                        <button type="button" class="xzg-modal-btn xzg-modal-cancel">${xzgT('取消', 'Cancel')}</button>
                        <button type="button" class="xzg-modal-btn xzg-modal-confirm">${importing ? xzgT('导入', 'Import') : xzgT('导出', 'Export')}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const close = (result) => {
                overlay.remove();
                resolve(result);
            };

            overlay.querySelector(".xzg-modal-cancel").addEventListener("click", () => close(null));
            overlay.querySelectorAll("[data-select-all]").forEach(button => {
                button.addEventListener("click", () => {
                    const checked = button.dataset.selectAll === "true";
                    overlay.querySelectorAll("[data-export-category]").forEach(input => { input.checked = checked && !input.disabled; });
                    const comfy = overlay.querySelector("#xzg-export-include-comfy");
                    comfy.checked = checked && !comfy.disabled;
                });
            });
            overlay.querySelector(".xzg-modal-confirm").addEventListener("click", () => {
                const categories = {};
                overlay.querySelectorAll("[data-export-category]").forEach(input => { categories[input.dataset.exportCategory] = input.checked; });
                const includeComfy = overlay.querySelector("#xzg-export-include-comfy").checked;
                if (!includeComfy && !Object.values(categories).some(Boolean)) {
                    alert(importing ? xzgT('至少选择一项要导入的内容。', 'Select at least one item to import.') : xzgT('至少选择一项要导出的内容。', 'Select at least one item to export.'));
                    return;
                }
                close({ categories, includeComfySettings: includeComfy });
            });
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) close(null);
            });
        });
    },

    /**
     * 显示导入选项对话框
     */
    showImportDialog(obj) {
        const available = Object.fromEntries(XZG_EXPORT_CATEGORIES.map(([id]) => [id, false]));
        for (const key of Object.keys(obj.localStorage || {})) {
            const category = xzgExportCategoryForKey(key);
            if (category) available[category] = true;
        }
        if (obj.notes != null) available.notes = true;
        if (Array.isArray(obj.favoritesPreviews) && obj.favoritesPreviews.length) available.favorites = true;
        if (obj.workflowUsage && Object.keys(obj.workflowUsage).length) available.workflows = true;
        if (Array.isArray(obj.shortcuts) && obj.shortcuts.length) available.shortcuts = true;
        if (obj.mediaLibrary && Array.isArray(obj.mediaLibrary.files)) available.mediaLibrary = true;
        if (obj.videoLibrary && Array.isArray(obj.videoLibrary.files)) available.videoLibrary = true;
        if (obj.audioLibrary && Array.isArray(obj.audioLibrary.files)) available.audioLibrary = true;
        if (obj.textBoxPreviews && Array.isArray(obj.textBoxPreviews.files)) available.textBoxGodPresets = true;
        available.comfy = !!(obj.comfySettings && Object.keys(obj.comfySettings).length);
        return this.showExportDialog(available);
    },

    // ====== 小珠光统一配置导出 / 导入（覆盖收藏 / 工作流 / 快速连线 / 隐藏菜单 / 主题 / 备注 / ComfyUI设置 等所有模块） ======
    async exportAllConfig() {
        // 1) 先弹导出选项，等用户确认各模块的勾选
        const opt = await this.showExportDialog();
        if (!opt) return; // 用户取消
        const selected = opt.categories || Object.fromEntries(XZG_EXPORT_CATEGORIES.map(([id]) => [id, true]));
        const includeNotes = selected.notes === true;
        const includeXzg = Object.entries(selected).some(([id, enabled]) => enabled && id !== "shortcuts");
        const includeComfy = opt.includeComfySettings !== false;

        const NOTES_KEY = "xiaozhuguang.notes";

        if (includeXzg) {
            await cloudUIInit();
            if (selected.skills) try {
                const presets = await cloudLoad("xzg_prompt_rule_presets", { fallbackValue: null })
                    ?? await cloudLoad("xzg_prompt_skill_presets", { fallbackValue: null });
                if (presets && typeof presets === "object" && !Array.isArray(presets)) {
                    const normalized = {};
                    for (const [name, entry] of Object.entries(presets)) {
                        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
                        const { skill: _legacySkill, ...rest } = entry;
                        const rule = typeof entry.rule === "string" ? entry.rule : entry.skill;
                        if (typeof rule === "string") normalized[name] = { ...rest, rule };
                    }
                    localStorage.setItem("xzg_prompt_rule_presets", JSON.stringify(normalized));
                }
            } catch (e) {}
            if (selected.textBoxGodPresets) try {
                const presets = await cloudLoad("xzg_text_box_god_presets", { fallbackValue: null });
                if (presets && typeof presets === "object" && !Array.isArray(presets)) {
                    localStorage.setItem("xzg_text_box_god_presets", JSON.stringify(presets));
                }
            } catch (e) {}
        }

        let ls = {};
        // 逐键按导出类别筛选，避免此前前缀匹配把未勾选类别也写进备份。
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            const category = xzgExportCategoryForKey(key);
            if (!category || !selected[category]) continue;
            try { ls[key] = localStorage.getItem(key); } catch (e) {}
        }
        // 运行中的云同步实例可能比 localStorage 更新，以实例状态覆盖。
        if (selected.favorites && window.xiaozhuguangFavorites && typeof window.xiaozhuguangFavorites.favorites === "object") {
            try { ls["comfyui_xiaozhuguang"] = JSON.stringify(window.xiaozhuguangFavorites.favorites); } catch (e) {}
        }
        if (selected.workflows && window.XZGWorkflows && typeof window.XZGWorkflows.meta === "object") {
            try { ls["xzg_workflows_meta"] = JSON.stringify(window.XZGWorkflows.meta); } catch (e) {}
        }
        if (selected.quickLinks && window.XZGQuickNodes) {
            try {
                ls["xzg_quick_nodes"] = JSON.stringify(window.XZGQuickNodes.getQuickNodeList?.() || window.XZGQuickNodes.quickNodes || []);
                ls["xzg_quick_nodes_config"] = JSON.stringify(window.XZGQuickNodes.config || { hideDefaultMenu: false });
            } catch (e) { console.warn("[XZG] Failed to export quick links:", e); }
        }

        // 顶层 notes 字段（结构化，方便未来扩展和跨工具识别）
        let notesTop = null;
        if (includeNotes) {
            try {
                const raw = localStorage.getItem(NOTES_KEY);
                if (raw !== null) {
                    try {
                        const parsed = JSON.parse(raw);
                        if (parsed && Array.isArray(parsed.groups) && parsed.groups.length > 0) {
                            notesTop = parsed;
                        } else {
                            // 旧版单字符串或空结构 → 包一层兼容
                            notesTop = {
                                groups: [{ id: "xzg_nt_migrated", name: xzgT("导入的笔记","Imported Notes"), content: (typeof raw === "string" ? raw : ""), color: "#FF5252", order: 0 }],
                                activeId: "xzg_nt_migrated",
                            };
                        }
                    } catch (_) {
                        // parse失败，按纯字符串包装成一组
                        notesTop = {
                            groups: [{ id: "xzg_nt_imported", name: xzgT("导入的笔记","Imported Notes"), content: raw || "", color: "#FF5252", order: 0 }],
                            activeId: "xzg_nt_imported",
                        };
                    }
                }
            } catch (e) {}
        }

        // 收藏截图存于 IndexedDB，单独收集（仅当 includeXzg 时）
        let favoritesPreviews = null;
        if (selected.favorites) {
            try {
                const fav = window.xiaozhuguangFavorites;
                if (fav && typeof fav._getAllPreviewImages === "function") {
                    favoritesPreviews = await fav._getAllPreviewImages();
                }
            } catch (e) {}
        }

        // 导出 ComfyUI 设置（含快捷键）
        let comfySettings = null;
        if (includeComfy) {
            try {
                const allSettings = await this.getComfySettings();
                if (allSettings) {
                    comfySettings = this.filterComfySettingsForExport(allSettings);
                }
            } catch (e) {
                console.warn("[XZG] Failed to export comfy settings:", e);
            }
        }

        // 导出自定义快捷键（后端存储 xzg_shortcuts.json）
        let shortcuts = null;
        if (selected.shortcuts) {
            try {
                const fetchFn = (typeof api !== "undefined" && api?.fetchApi) ? api.fetchApi.bind(api) : fetch;
                const resp = await fetchFn("/xzg/shortcuts", { method: "GET", cache: "no-store" });
                if (resp.ok) {
                    const data = await resp.json();
                    if (Array.isArray(data.shortcuts) && data.shortcuts.length > 0) {
                        shortcuts = data.shortcuts;
                    }
                }
            } catch (e) {
                console.warn("[XZG] Failed to export shortcuts:", e);
            }
        }

        // 媒体文件本体纳入配置备份，避免仅保存文件名后换服务器丢失图片。
        let mediaLibrary = null;
        let folderDialogGeometry = null;
        if (selected.mediaLibrary) {
            mediaLibrary = {};
            mediaLibrary.geometry = await cloudLoad("xzg_media_library_geometry", { fallbackValue: null });
            folderDialogGeometry = await cloudLoad("xzg_folder_dialog_geometry", { fallbackValue: null });
        }

        const videoLibrary = selected.videoLibrary ? {
            geometry: await cloudLoad("xzg_video_media_library_geometry", { fallbackValue: null }),
        } : null;
        const audioLibrary = selected.audioLibrary ? {
            geometry: await cloudLoad("xzg_audio_media_library_geometry", { fallbackValue: null }),
        } : null;
        const cfg = {
            format: "xiaozhuguang-config",
            version: 11,
            exportedAt: new Date().toISOString(),
            flags: { includeXzgConfig: includeXzg, includeNotes: includeNotes, includeComfySettings: includeComfy, selectedCategories: selected },
            localStorage: ls,
            notes: notesTop,
            favoritesPreviews: favoritesPreviews,
            comfySettings: comfySettings,
            shortcuts: shortcuts,
            mediaLibrary: mediaLibrary,
            videoLibrary: videoLibrary,
            audioLibrary: audioLibrary,
            textBoxPreviews: selected.textBoxGodPresets ? {} : null,
            folderDialogGeometry: folderDialogGeometry
        };
        const blob = await this.configTransfer(xzgT("正在打包并下载 ZIP 备份，请稍候…", "Preparing and downloading ZIP backup…"), async () => {
            const response = await api.fetchApi("/xzg/media-library/backup", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg),
            });
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || `HTTP ${response.status}`);
            }
            return response.blob();
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const d = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
        a.href = url;
        a.download = `xiaozhuguang-config-${stamp}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    async importAllConfig(obj, archive = null) {
        if (!obj || typeof obj !== "object") throw new Error("not an object");
        if (obj.format && obj.format !== "xiaozhuguang-config") {
            throw new Error("unknown format: " + obj.format);
        }

        const NOTES_KEY = "xiaozhuguang.notes";

        // 与导出共享分类和编号，先过滤载荷，后续写入和运行时恢复仅接触勾选项。
        const opt = await this.showImportDialog(obj);
        if (!opt) return { applied: false };
        const selected = opt.categories;
        obj = {
            ...obj,
            localStorage: Object.fromEntries(Object.entries(obj.localStorage || {}).filter(([key]) => selected[xzgExportCategoryForKey(key)] === true)),
            notes: selected.notes ? obj.notes : null,
            favoritesPreviews: selected.favorites ? obj.favoritesPreviews : null,
            workflowUsage: selected.workflows ? obj.workflowUsage : null,
            shortcuts: selected.shortcuts ? obj.shortcuts : null,
            mediaLibrary: selected.mediaLibrary ? obj.mediaLibrary : null,
            videoLibrary: selected.videoLibrary ? obj.videoLibrary : null,
            audioLibrary: selected.audioLibrary ? obj.audioLibrary : null,
            folderDialogGeometry: selected.mediaLibrary ? obj.folderDialogGeometry : null,
        };
        const includeXzg = Object.values(selected).some(Boolean);
        const includeNotes = selected.notes === true;
        const includeComfy = opt.includeComfySettings === true;
        const hasComfy = !!(obj.comfySettings && Object.keys(obj.comfySettings).length);
        const hasNotes = obj.notes != null || obj.localStorage[NOTES_KEY] != null;

        let mediaRestored = false;
        let restoredMediaCount = 0;
        let restoredVideoCount = null;
        let restoredAudioCount = null;
        let restoredTextBoxPreviews = null;
        const restoreImages = !!(obj.mediaLibrary && Array.isArray(obj.mediaLibrary.files));
        const restoreVideos = !!(obj.videoLibrary && Array.isArray(obj.videoLibrary.files));
        const restoreAudio = !!(obj.audioLibrary && Array.isArray(obj.audioLibrary.files));
        const restoreTextBoxPreviews = !!(selected.textBoxGodPresets && obj.textBoxPreviews && Array.isArray(obj.textBoxPreviews.files));
        const archiveResult = archive && (restoreImages || restoreVideos || restoreAudio || restoreTextBoxPreviews)
            ? await this.uploadConfigArchive(archive, true, { mediaLibrary: restoreImages, videoLibrary: restoreVideos, audioLibrary: restoreAudio, textBoxPreviews: restoreTextBoxPreviews })
            : null;
        if (restoreTextBoxPreviews && archiveResult) restoredTextBoxPreviews = archiveResult.restoredTextBoxPreviews ?? 0;
        if (restoreVideos) {
            if (!archiveResult) throw new Error(xzgT("视频媒体库需要 ZIP 备份文件", "Video media library requires a ZIP backup."));
            restoredVideoCount = archiveResult.restoredVideos;
            const geometry = obj.videoLibrary.geometry;
            if (geometry && Number.isFinite(Number(geometry.width)) && Number.isFinite(Number(geometry.height))) {
                const restoredGeometry = { width: Number(geometry.width), height: Number(geometry.height) };
                if (geometry.x != null && geometry.y != null && Number.isFinite(Number(geometry.x)) && Number.isFinite(Number(geometry.y))) {
                    restoredGeometry.x = Number(geometry.x);
                    restoredGeometry.y = Number(geometry.y);
                }
                await cloudSave("xzg_video_media_library_geometry", restoredGeometry);
            }
        }
        if (restoreAudio) {
            if (!archiveResult) throw new Error(xzgT("音频媒体库需要 ZIP 备份文件", "Audio media library requires a ZIP backup."));
            restoredAudioCount = archiveResult.restoredAudios;
            const geometry = obj.audioLibrary.geometry;
            if (geometry && Number.isFinite(Number(geometry.width)) && Number.isFinite(Number(geometry.height))) {
                const restoredGeometry = { width: Number(geometry.width), height: Number(geometry.height) };
                if (geometry.x != null && geometry.y != null && Number.isFinite(Number(geometry.x)) && Number.isFinite(Number(geometry.y))) {
                    restoredGeometry.x = Number(geometry.x);
                    restoredGeometry.y = Number(geometry.y);
                }
                await cloudSave("xzg_audio_media_library_geometry", restoredGeometry);
            }
        }
        if (includeXzg && obj.mediaLibrary && Array.isArray(obj.mediaLibrary.files)) {
            if (archive) {
                restoredMediaCount = archiveResult.restored;
            } else {
                const response = await api.fetchApi("/xzg/media-library/restore", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(obj.mediaLibrary),
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || xzgT("媒体库恢复失败", "Media library restore failed"));
                restoredMediaCount = result.restored;
            }
            const geometry = obj.mediaLibrary.geometry;
            if (geometry && Number.isFinite(Number(geometry.width)) && Number.isFinite(Number(geometry.height))) {
                const restoredGeometry = {
                    width: Number(geometry.width),
                    height: Number(geometry.height),
                };
                if (geometry.x != null && geometry.y != null && Number.isFinite(Number(geometry.x)) && Number.isFinite(Number(geometry.y))) {
                    restoredGeometry.x = Number(geometry.x);
                    restoredGeometry.y = Number(geometry.y);
                }
                await cloudSave("xzg_media_library_geometry", restoredGeometry);
            }
            const folderGeometry = obj.folderDialogGeometry;
            if (folderGeometry && Number.isFinite(Number(folderGeometry.width)) && Number.isFinite(Number(folderGeometry.height))) {
                const restoredFolderGeometry = {
                    width: Number(folderGeometry.width),
                    height: Number(folderGeometry.height),
                };
                if (folderGeometry.x != null && folderGeometry.y != null && Number.isFinite(Number(folderGeometry.x)) && Number.isFinite(Number(folderGeometry.y))) {
                    restoredFolderGeometry.x = Number(folderGeometry.x);
                    restoredFolderGeometry.y = Number(folderGeometry.y);
                }
                await cloudSave("xzg_folder_dialog_geometry", restoredFolderGeometry);
            }
            mediaRestored = true;
        }

        // ============ 1) 导入备注（优先从顶层 notes，回退到 localStorage[NOTES_KEY]） ============
        let importedNotes = false;
        if (includeNotes && hasNotes) {
            let notesObj = null;
            if (obj.notes && typeof obj.notes === "object") {
                notesObj = obj.notes;
            } else if (obj.localStorage && obj.localStorage[NOTES_KEY]) {
                try {
                    const parsed = JSON.parse(obj.localStorage[NOTES_KEY]);
                    if (parsed && (Array.isArray(parsed.groups) || typeof parsed === "string")) {
                        notesObj = parsed;
                    }
                } catch (_) {
                    // 旧版字符串格式
                    notesObj = {
                        groups: [{ id: "xzg_nt_imported", name: xzgT("导入的笔记","Imported Notes"), content: obj.localStorage[NOTES_KEY], color: "#FF5252", order: 0 }],
                        activeId: "xzg_nt_imported",
                    };
                }
            }
            if (notesObj) {
                try {
                    if (typeof notesObj === "string") {
                        // 单字符串兼容
                        localStorage.setItem(NOTES_KEY, notesObj);
                    } else {
                        localStorage.setItem(NOTES_KEY, JSON.stringify(notesObj));
                    }
                    importedNotes = true;
                } catch (e) {
                    console.warn("[XZG] Failed to import notes:", e);
                }
            }
        }

        // ============ 2) 导入小珠光配置（除 notes 外的所有 localStorage，以及收藏预览） ============
        let importedXzg = mediaRestored || restoredVideoCount != null || restoredAudioCount != null || restoredTextBoxPreviews != null;
        if (includeXzg) {
            if (obj.localStorage && typeof obj.localStorage === "object") {
                for (const k in obj.localStorage) {
                    // notes 已在上面单独按 includeNotes 决策导入，此处跳过避免强制覆盖
                    if (k === NOTES_KEY) continue;
                    try { localStorage.setItem(k, obj.localStorage[k]); } catch (e) {}
                }
                importedXzg = true;
            }
            if (obj.localStorage && obj.localStorage["xzg-display-v1"] !== undefined) {
                try {
                    window.XZGMonitorConfig?.reloadFromStorage?.();
                    importedXzg = true;
                } catch (e) { console.warn("[XZG] Failed to import monitor display config:", e); }
            }
            // 云存储同步：收藏 / 工作流元数据除写本地外，还要推送到云端并刷新实例与面板，
            // 否则云优先加载会在刷新时用旧云端数据覆盖刚导入的配置。
            if (obj.localStorage && typeof obj.localStorage === "object") {
                // 收藏
                const favRaw = obj.localStorage["comfyui_xiaozhuguang"];
                if (typeof favRaw === "string") {
                    try {
                        const fav = JSON.parse(favRaw);
                        if (fav && typeof fav === "object") {
                            const inst = window.xiaozhuguangFavorites;
                            if (inst && typeof inst._normalizeFavorites === "function") {
                                inst.favorites = inst._normalizeFavorites(fav);
                                try { inst.persistLocal(); } catch (e) {}
                                if (typeof inst.renderFavorites === "function") inst.renderFavorites();
                            }
                            cloudSave("comfyui_xiaozhuguang", fav).catch(() => {});
                        }
                    } catch (e) {}
                }
                // 工作流元数据
                const wfRaw = obj.localStorage["xzg_workflows_meta"];
                if (typeof wfRaw === "string") {
                    try {
                        const meta = JSON.parse(wfRaw);
                        if (meta && typeof meta === "object") {
                            const inst = window.XZGWorkflows;
                            if (inst && typeof inst._normalizeMeta === "function") {
                                inst.meta = inst._normalizeMeta(meta);
                                inst.sortMode = inst.meta.sortMode || "default";
                                try { inst.persistLocal(); } catch (e) {}
                                if (typeof inst.renderCategories === "function") inst.renderCategories();
                                if (typeof inst.renderWorkflowList === "function") inst.renderWorkflowList();
                            }
                            cloudSave("xzg_workflows_meta", meta).catch(() => {});
                        }
                    } catch (e) {}
                }
                // 快速连线的运行时列表/开关也要同步回实例；只写 localStorage 后，
                // 全局云推送会用旧实例状态覆盖导入值，刷新后看起来像导入丢失。
                const quickNodesRaw = obj.localStorage["xzg_quick_nodes"];
                const quickConfigRaw = obj.localStorage["xzg_quick_nodes_config"];
                if (typeof quickNodesRaw === "string" || typeof quickConfigRaw === "string") {
                    try {
                        const quickInstance = window.XZGQuickNodes;
                        await quickInstance?._cloudRestorePromise?.catch?.(() => {});
                        const currentNodes = Array.isArray(quickInstance?.quickNodes) ? quickInstance.quickNodes : [];
                        const currentConfig = quickInstance?.config && typeof quickInstance.config === "object" ? quickInstance.config : { hideDefaultMenu: false };
                        const nodes = typeof quickNodesRaw === "string" ? JSON.parse(quickNodesRaw) : currentNodes;
                        const config = typeof quickConfigRaw === "string" ? JSON.parse(quickConfigRaw) : currentConfig;
                        if (!Array.isArray(nodes) || !config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid quick-link backup data");
                        const normalizedNodes = nodes.filter(node => node && typeof node.type === "string");
                        const normalizedConfig = Object.assign({}, { hideDefaultMenu: false }, config);
                        localStorage.setItem("xzg_quick_nodes", JSON.stringify(normalizedNodes));
                        localStorage.setItem("xzg_quick_nodes_config", JSON.stringify(normalizedConfig));
                        if (quickInstance) {
                            quickInstance.quickNodes = normalizedNodes;
                            quickInstance.config = normalizedConfig;
                            if (quickInstance._cloudSaveTimer) clearTimeout(quickInstance._cloudSaveTimer);
                            quickInstance._cloudSaveTimer = null;
                        }
                        const quickCloudResult = await cloudSave("xzg_quick_nodes_state", { nodes: normalizedNodes, config: normalizedConfig });
                        if (quickCloudResult?.ok !== true) console.warn("[XZG] Quick links were imported locally but cloud save failed.");
                        window.XZGThemePanel?.refreshQuickNodesTab?.();
                        importedXzg = true;
                    } catch (e) { console.warn("[XZG] Failed to import quick links:", e); }
                }
                // 提示词规则预设：同时兼容旧备份字段和旧内容格式。
                const promptRulesRaw = obj.localStorage["xzg_prompt_rule_presets"] ?? obj.localStorage["xzg_prompt_skill_presets"];
                if (typeof promptRulesRaw === "string") {
                    try {
                        const rawPresets = JSON.parse(promptRulesRaw);
                        if (rawPresets && typeof rawPresets === "object" && !Array.isArray(rawPresets)) {
                            const presets = {};
                            for (const [name, entry] of Object.entries(rawPresets)) {
                                if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
                                const { skill: _legacySkill, ...rest } = entry;
                                const rule = typeof entry.rule === "string" ? entry.rule : entry.skill;
                                if (typeof rule === "string") presets[name] = { ...rest, rule };
                            }
                            await cloudSave("xzg_prompt_rule_presets", presets);
                            localStorage.setItem("xzg_prompt_rule_presets", JSON.stringify(presets));
                            localStorage.removeItem("xzg_prompt_skill_presets");
                            window.XZGRefreshPromptRulePresetTypes?.();
                        }
                    } catch (e) {}
                }
                // 文本框化神级提示词预设：导入后同步到 user/xiaozhuguang 云端并刷新现有节点。
                const textBoxGodPresetsRaw = obj.localStorage["xzg_text_box_god_presets"];
                if (typeof textBoxGodPresetsRaw === "string") {
                    try {
                        const presets = JSON.parse(textBoxGodPresetsRaw);
                        if (presets && typeof presets === "object" && !Array.isArray(presets)) {
                            const result = await cloudSave("xzg_text_box_god_presets", presets);
                            await window.XZGRefreshTextBoxGodPresets?.(presets);
                            if (result?.ok !== true) console.warn("[XZG] Text-box presets were imported locally but cloud save failed.");
                        }
                    } catch (e) {
                        console.warn("[XZG] Failed to import text-box presets:", e);
                    }
                }
                // 面板几何（位置/尺寸，位于 xiaozhuguang.* / xzg_* 前缀，已随上面循环写入本地）——
                // 一并推送云端，避免刷新后旧云端几何覆盖刚导入的几何。
                cloudUIQueueGeometry();
            }
            if (obj.favoritesPreviews && window.xiaozhuguangFavorites &&
                typeof window.xiaozhuguangFavorites._saveAllPreviewImages === "function") {
                try { await window.xiaozhuguangFavorites._saveAllPreviewImages(obj.favoritesPreviews); importedXzg = true; } catch (e) {}
            }
            // 兼容旧版（仅使用次数）配置
            if (obj.workflowUsage && typeof obj.workflowUsage === "object") {
                try {
                    const raw = localStorage.getItem("xzg_workflows_meta");
                    const meta = raw ? JSON.parse(raw) : { workflows: {} };
                    if (!meta.workflows) meta.workflows = {};
                    for (const path in obj.workflowUsage) {
                        const cnt = parseInt(obj.workflowUsage[path], 10);
                        if (!meta.workflows[path]) meta.workflows[path] = { useCount: 0, lastUsed: 0, categoryId: null, createdAt: Date.now() };
                        meta.workflows[path].useCount = isNaN(cnt) ? 0 : cnt;
                    }
                    localStorage.setItem("xzg_workflows_meta", JSON.stringify(meta));
                    importedXzg = true;
                } catch (e) {}
            }
            // 菜单隐藏配置：写回本地后刷新实例并推送云端，避免内存仍为旧值 / 被旧云端数据覆盖
            if (obj.localStorage && obj.localStorage["xzg-menu-hide"] !== undefined) {
                try {
                    const MH = window.XZGMenuHide;
                    if (MH) {
                        if (typeof MH.reload === "function") {
                            MH.reload();
                        } else {
                            MH.loadConfig();
                            MH.loadEnabled();
                            if (MH._applyHideToOpenMenus) MH._applyHideToOpenMenus();
                            if (MH._cloudPush) MH._cloudPush();
                        }
                        if (this._refreshMenuListUI) this._refreshMenuListUI();
                        importedXzg = true;
                    }
                } catch (e) {
                    console.warn("[XZG] Failed to import menu hide config:", e);
                }
            }
            // 导入自定义快捷键（写入后端 xzg_shortcuts.json）
            if (Array.isArray(obj.shortcuts) && obj.shortcuts.length > 0) {
                try {
                    const fetchFn = (typeof api !== "undefined" && api?.fetchApi) ? api.fetchApi.bind(api) : fetch;
                    const resp = await fetchFn("/xzg/shortcuts", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ shortcuts: obj.shortcuts })
                    });
                    if (resp.ok) {
                        // 同步刷新内存中的快捷键
                        if (window.xzgShortcuts && typeof window.xzgShortcuts.load === "function") {
                            try { await window.xzgShortcuts.load(); } catch (e) {}
                        }
                        importedXzg = true;
                    }
                } catch (e) {
                    console.warn("[XZG] Failed to import shortcuts:", e);
                }
            }
        }
        // 云同步推送：导入写回本地后，把本次云化模块的设置一并推上云，
        // 避免刷新时“云优先覆盖”用旧云端数据覆盖刚导入的配置。
        if (includeXzg && window.__xzgCloudPush && typeof window.__xzgCloudPush === "object") {
            for (const _k in window.__xzgCloudPush) {
                try { window.__xzgCloudPush[_k](); } catch (e) {}
            }
        }

        // ============ 3) 导入备注即使没勾选XZG也允许单独生效（因此 notes 独立）===========
        // 最终 importedXzg 只反映非 notes 的模块；而 importedNotes 单独记录
        const anyXzgApplied = importedXzg;

        // ============ 4) 导入 ComfyUI 设置（含快捷键） ============
        let importedComfy = false;
        if (includeComfy && hasComfy) {
            try {
                const ok = await this.applyComfySettings(obj.comfySettings);
                importedComfy = !!ok;
            } catch (e) {
                console.warn("[XZG] Failed to import comfy settings:", e);
            }
        }

        return {
            applied: anyXzgApplied || importedNotes || importedComfy,
            appliedXzgConfig: anyXzgApplied,
            appliedNotes: importedNotes,
            appliedComfySettings: importedComfy,
            restoredMediaCount: mediaRestored ? restoredMediaCount : null,
            restoredVideoCount: restoredVideoCount,
            restoredAudioCount: restoredAudioCount,
            restoredTextBoxPreviews: restoredTextBoxPreviews
        };
    },

    renderPresets() {
        const presets = this.getPresets();
        const items = this.panel?.querySelectorAll(".xzg-preset-item");
        if (!items) return;

        items.forEach((item, index) => {
            const preset = presets[index];
            if (preset) {
                const cssDeg = this.presetDirToCssDeg(preset.direction);
                item.style.background = `linear-gradient(${cssDeg}deg, ${preset.color1} 0%, ${preset.color2} 50%, ${preset.color3} 100%)`;
            }
        });
    },

    presetDirToCssDeg(deg) {
        const map = {
            '0': 180, '90': 90, '180': 0, '270': 270,
            '45': 135, '135': 225, '225': 315, '315': 45
        };
        return map[String(deg)] !== undefined ? map[String(deg)] : 135;
    },

    applyPreset(index) {
        const presets = this.getPresets();
        const preset = presets[index];
        if (!preset) return;

        this.isUpdatingFromNode = true;

        const panel = this.panel;
        const c1 = panel.querySelector('[data-color="color1"]');
        const c2 = panel.querySelector('[data-color="color2"]');
        const c3 = panel.querySelector('[data-color="color3"]');
        const tc1 = panel.querySelector('[data-color="titleColor1"]');
        const tc2 = panel.querySelector('[data-color="titleColor2"]');
        const tc3 = panel.querySelector('[data-color="titleColor3"]');
        const ct = panel.querySelector('[data-color="textColor"]');

        if (c1 && preset.color1) c1.style.backgroundColor = preset.color1;
        if (c2 && preset.color2) c2.style.backgroundColor = preset.color2;
        if (c3 && preset.color3) c3.style.backgroundColor = preset.color3;
        if (tc1 && preset.titleColor1) tc1.style.backgroundColor = preset.titleColor1;
        if (tc2 && preset.titleColor2) tc2.style.backgroundColor = preset.titleColor2;
        if (tc3 && preset.titleColor3) tc3.style.backgroundColor = preset.titleColor3;
        if (ct && preset.textColor) ct.style.backgroundColor = preset.textColor;

        panel.querySelectorAll(".xzg-direction-buttons:not(.xzg-title-dir-buttons) .xzg-dir-btn").forEach(b => b.classList.remove("active"));
        const dirBtn = panel.querySelector(`[data-dir="${preset.direction || '135'}"]`);
        if (dirBtn) dirBtn.classList.add("active");

        panel.querySelectorAll(".xzg-title-dir-buttons .xzg-dir-btn").forEach(b => b.classList.remove("active"));
        const titleDirBtn = panel.querySelector(`[data-title-dir="${preset.titleDirection || '135'}"]`);
        if (titleDirBtn) titleDirBtn.classList.add("active");

        const useTitleGradient = preset.useTitleGradient === true;
        const titleToggle = panel.querySelector(".xzg-title-gradient-toggle");
        if (titleToggle) {
            titleToggle.dataset.checked = String(useTitleGradient);
            const label = titleToggle.querySelector(".xzg-toggle-label");
            if (label) label.textContent = useTitleGradient ? xzgT("开","On") : xzgT("关","Off");
        }
        const titleSections = panel.querySelectorAll(".xzg-title-swatch-section");
        titleSections.forEach(sec => {
            sec.style.display = useTitleGradient ? "" : "none";
        });

        if (preset.fontSize !== undefined) {
            const fontSizeEl = panel.querySelector("#xzg-font-size-value");
            if (fontSizeEl) fontSizeEl.textContent = preset.fontSize;
        }

        panel.querySelectorAll(".xzg-align-btn").forEach(b => b.classList.remove("active"));
        const alignBtn = panel.querySelector(`[data-align="${preset.textAlign || 'left'}"]`);
        if (alignBtn) alignBtn.classList.add("active");

        panel.querySelectorAll(".xzg-color-swatch").forEach(s => s.classList.remove("active"));
        const firstSwatch = panel.querySelector('[data-color="color1"]');
        if (firstSwatch) {
            firstSwatch.classList.add("active");
            this.activeColorInput = "color1";
        }
        this.setColorFromHex(preset.color1, false);

        this.isUpdatingFromNode = false;
        this.notifyChange();

        if (this.isVisible) {
            requestAnimationFrame(() => {
                this.syncPickerCursors();
            });
        }
    },

    /** 一次性注入全局模态框样式：xzg-modal-*（导出/导入对话框）+ xzg-wf-dialog-* */
    _ensureGlobalDialogCSS() {
        if (document.getElementById("xzg-dialog-global-css")) return;
        const s = document.createElement("style");
        s.id = "xzg-dialog-global-css";
        s.textContent = `
            /* ========= xzg-modal：导出/导入配置对话框 ========= */
            .xzg-modal-overlay {
                position: fixed;top: 0;left: 0;right: 0;bottom: 0;
                background: rgba(0, 0, 0, 0.65);
                display: flex;align-items: center;justify-content: center;
                z-index: 2000000;
            }
            .xzg-modal-dialog {
                background: var(--comfy-menu-bg, #2a2a2a);
                border: 1px solid var(--border-color, #555);
                border-radius: 10px;
                min-width: 380px;
                max-width: 520px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
                color: #ddd;
                font-family: Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
                animation: xzgModalPop 0.35s cubic-bezier(0.25, 0.8, 0.3, 1);
            }
            @keyframes xzgModalPop {
                from { opacity: 0; transform: scale(0.97); }
                to   { opacity: 1; transform: scale(1); }
            }
            .xzg-modal-title {
                display: flex;align-items: center;justify-content: center;
                padding: 14px 16px;font-size: 15px;font-weight: bold;color: #FFD700;
                border-bottom: 1px solid var(--border-color, #444);
            }
            .xzg-modal-body { padding: 16px 18px;display: flex;flex-direction: column;gap: 12px; }
            .xzg-modal-footer {
                padding: 12px 16px;border-top: 1px solid var(--border-color, #444);
                display: flex;justify-content: center;gap: 10px;
            }
            .xzg-modal-btn {
                padding: 6px 18px;font-size: 13px;
                background: var(--comfy-input-bg, #3a3a3a);
                color: var(--fg, #ddd);
                border: 1px solid var(--border-color, #555);
                border-radius: 4px;cursor: pointer;transition: all 0.15s;
            }
            .xzg-modal-btn:hover { background: rgba(255,255,255,0.1); }
            .xzg-modal-btn.xzg-transfer-neutral {
                background: var(--comfy-input-bg, #3a3a3a);color: var(--fg, #ddd);
                border: 1px solid var(--border-color, #555);font-weight: normal;
            }
            .xzg-modal-btn.xzg-transfer-neutral:hover { background: rgba(255,255,255,0.1); }
            .xzg-modal-cancel {
                background: #3a3a3a; color: #ccc;
            }
            .xzg-modal-confirm {
                background: #FFD700;color: #333;border-color: #FFD700;font-weight: bold;
            }
            .xzg-modal-danger {
                background: #7a3030;color: #fff;border-color: #a94a4a;font-weight: bold;
            }
            .xzg-modal-danger:hover:not(:disabled) { background: #963b3b; }
            .xzg-modal-confirm:hover:not(:disabled) { background: #FFC700; }
            .xzg-modal-confirm:disabled { opacity: 0.4;cursor: not-allowed; }
            .xzg-modal-checkbox {
                display: flex;align-items: flex-start;gap: 8px;cursor: pointer;
                padding: 6px 4px;border-radius: 4px;
                font-size: 13px;color: #ddd;line-height: 1.4;
                user-select: none;
            }
            .xzg-modal-checkbox:hover { background: rgba(255,255,255,0.05); }
            .xzg-modal-checkbox > input[type="checkbox"] {
                margin-top: 3px;
                width: 14px;height: 14px;
                accent-color: #FFD700;
                cursor: pointer;flex-shrink: 0;
            }
            .xzg-modal-hint {
                font-size: 11px;color: #888;padding: 2px 4px;line-height: 1.5;
            }
            .xzg-modal-warning {
                font-size: 11px;color: #FF6B6B;padding: 8px 10px;
                background: rgba(255,82,82,0.08);
                border: 1px dashed rgba(255,82,82,0.35);
                border-radius: 4px;line-height: 1.5;
            }

            /* ========= xzg-wf-dialog：通用确认对话框 ========= */
            .xzg-wf-dialog-overlay {
                position: fixed;top: 0;left: 0;right: 0;bottom: 0;
                background: rgba(0, 0, 0, 0.6);
                display: flex;align-items: center;justify-content: center;
                z-index: 100002;
            }
            .xzg-wf-dialog {
                background: var(--comfy-menu-bg, #2a2a2a);
                border: 1px solid var(--border-color, #555);
                border-radius: 8px;min-width: 320px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            }
            .xzg-wf-dialog-title {
                position: relative;display: flex;align-items: center;justify-content: center;
                padding: 14px 16px;font-size: 15px;font-weight: bold;color: #fff;
                border-bottom: 1px solid var(--border-color, #444);text-align: center;
            }
            .xzg-wf-dialog-body { padding: 20px 16px; }
            .xzg-wf-dialog-footer {
                padding: 12px 16px;border-top: 1px solid var(--border-color, #444);
                display: flex;justify-content: center;gap: 10px;
            }
            .xzg-wf-dialog-btn {
                padding: 6px 16px;font-size: 13px;
                background: var(--comfy-input-bg, #3a3a3a);
                color: var(--fg, #ddd);
                border: 1px solid var(--border-color, #555);
                border-radius: 4px;cursor: pointer;transition: all 0.15s;
            }
            .xzg-wf-dialog-btn:hover { background: rgba(255, 255, 255, 0.1); }
            .xzg-wf-dialog-btn-cancel {
                background: var(--comfy-input-bg, #3a3a3a);color: var(--fg, #ddd);
            }
            .xzg-wf-dialog-btn-confirm {
                background: #4a4a4a;color: #fff;border-color: #666;font-weight: bold;
            }
            .xzg-wf-dialog-btn-confirm:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
            .xzg-wf-dialog-btn-confirm:disabled { opacity: 0.4;cursor: not-allowed; }
        `;
        document.head.appendChild(s);
    },

    showConfirmDialog(title, message) {
        return new Promise((resolve) => {
            const self = this;
            self._ensureGlobalDialogCSS();
            const escapeAttr = (v) => String(v == null ? "" : v)
                .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
                .replace(/</g, "&lt;").replace(/>/g, "&gt;");

            const overlay = document.createElement("div");
            overlay.className = "xzg-wf-dialog-overlay";
            overlay.style.zIndex = "100003";
            overlay.innerHTML = `
                <div class="xzg-wf-dialog" style="min-width:320px;max-width:420px;">
                    <div class="xzg-wf-dialog-title" style="color:#FFD700;">${escapeAttr(title)}</div>
                    <div class="xzg-wf-dialog-body" style="padding:18px 20px;font-size:13px;color:#ddd;line-height:1.6;">
                        ${escapeAttr(message)}
                    </div>
                    <div class="xzg-wf-dialog-footer">
                        <button class="xzg-wf-dialog-btn xzg-wf-dialog-btn-cancel" id="xzg-confirm-cancel">${xzgT('取消','Cancel')}</button>
                        <button class="xzg-wf-dialog-btn xzg-wf-dialog-btn-confirm" id="xzg-confirm-ok" style="background:#FFD700;color:#333;border-color:#FFD700;">${xzgT('确认','Confirm')}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const dialogEl = overlay.querySelector(".xzg-wf-dialog");

            const stopAll = (e) => { e.stopPropagation(); e.preventDefault(); };
            overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) { e.stopPropagation(); } });
            if (dialogEl) {
                dialogEl.addEventListener("mousedown", stopAll);
                dialogEl.addEventListener("pointerdown", stopAll);
                dialogEl.addEventListener("click", (e) => e.stopPropagation());
            }

            const finish = (result) => {
                document.removeEventListener("keydown", onKey, true);
                overlay.remove();
                resolve(result);
            };

            const onKey = (e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    finish(false);
                } else if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    finish(true);
                }
            };
            document.addEventListener("keydown", onKey, true);

            overlay.querySelector("#xzg-confirm-cancel").addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); finish(false); });
            overlay.querySelector("#xzg-confirm-ok").addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); finish(true); });
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) { e.stopPropagation(); e.preventDefault(); finish(false); }
            });
        });
    },

    saveCurrentToPreset(index) {
        const presets = this.getPresets();
        const colors = this.getCurrentColors();
        presets[index] = {
            color1: colors.color1,
            color2: colors.color2,
            color3: colors.color3,
            direction: colors.direction,
            titleColor1: colors.titleColor1,
            titleColor2: colors.titleColor2,
            titleColor3: colors.titleColor3,
            titleDirection: colors.titleDirection,
            useTitleGradient: colors.useTitleGradient,
            textColor: colors.textColor,
            fontSize: colors.fontSize,
            textAlign: colors.textAlign
        };
        this.savePresets(presets);
        this.renderPresets();
    },

    /* ── 最近颜色 ── */
    addRecentColor(hex) {
        if (!hex || typeof hex !== 'string') return;
        hex = hex.toUpperCase();
        // 移除重复
        this.recentColors = this.recentColors.filter(c => c !== hex);
        // 添加到开头
        this.recentColors.unshift(hex);
        // 限制数量
        if (this.recentColors.length > this.maxRecentColors) {
            this.recentColors = this.recentColors.slice(0, this.maxRecentColors);
        }
        this.saveRecentColors();
        this.updateRecentDisplay();
    },

    loadRecentColors() {
        try {
            const stored = localStorage.getItem("xzg_recent_colors");
            if (stored) {
                this.recentColors = JSON.parse(stored);
                if (!Array.isArray(this.recentColors)) this.recentColors = [];
            }
        } catch (e) { this.recentColors = []; }
    },

    saveRecentColors() {
        try {
            localStorage.setItem("xzg_recent_colors", JSON.stringify(this.recentColors));
        } catch (e) {}
        this._queueThemePanelCloudSave();
    },

    updateRecentDisplay() {
        const section = document.getElementById("xzg-recent-section");
        const row = document.getElementById("xzg-recent-row");
        if (!section || !row) return;
        
        if (this.recentColors.length === 0) {
            section.style.display = "none";
            return;
        }
        section.style.display = "";
        row.innerHTML = this.recentColors.map((c, i) => `
            <div class="xzg-recent-swatch" data-color="${c}" style="width:22px;height:22px;border-radius:3px;cursor:pointer;background:${c};border:1px solid rgba(255,255,255,0.2);transition:transform 0.15s;" title="${c}"></div>
        `).join("");
        
        // Bind clicks
        row.querySelectorAll(".xzg-recent-swatch").forEach(sw => {
            sw.addEventListener("click", (e) => {
                e.stopPropagation();
                const hex = sw.dataset.color;
                if (this.activeColorInput) {
                    this.setActiveColor(hex);
                    this.setColorFromHex(hex, true);
                    if (this.isVisible) requestAnimationFrame(() => this.syncPickerCursors());
                }
            });
        });
    },

    clearRecentColors() {
        this.recentColors = [];
        this.saveRecentColors();
        this.updateRecentDisplay();
    },

    /* ── 取色吸管 ── */
    startEyedropper() {
        if (this.eyedropperActive) {
            this.stopEyedropper();
            return;
        }
        
        this.eyedropperActive = true;
        
        // 高亮吸管按钮
        const eyedropperBtn = document.getElementById("xzg-eyedropper-btn");
        if (eyedropperBtn) {
            eyedropperBtn.style.background = "#667eea";
            eyedropperBtn.style.color = "#fff";
        }
        
        // 在canvas上显示十字光标
        const canvas = document.getElementById("graph-canvas") || document.querySelector("canvas");
        if (canvas) {
            canvas.style.cursor = "crosshair";
        }
        
        const self = this;
        
        // 鼠标移动时预览颜色（不选，仅预览）
        this._eyedropperMove = (e) => {
            self._eyedropperPreview(e);
        };
        
        // 点击取色
        this._eyedropperClick = (e) => {
            self._eyedropperPick(e);
        };
        
        // Esc取消
        this._eyedropperEsc = (e) => {
            if (e.key === 'Escape') self.stopEyedropper();
        };
        
        document.addEventListener("mousemove", this._eyedropperMove);
        document.addEventListener("click", this._eyedropperClick, true);
        document.addEventListener("keydown", this._eyedropperEsc);
    },

    stopEyedropper() {
        this.eyedropperActive = false;
        
        const eyedropperBtn = document.getElementById("xzg-eyedropper-btn");
        if (eyedropperBtn) {
            eyedropperBtn.style.background = "#2a2a2a";
            eyedropperBtn.style.color = "#aaa";
        }
        
        const canvas = document.getElementById("graph-canvas") || document.querySelector("canvas");
        if (canvas) {
            canvas.style.cursor = "";
        }
        
        if (this._eyedropperMove) {
            document.removeEventListener("mousemove", this._eyedropperMove);
            this._eyedropperMove = null;
        }
        if (this._eyedropperClick) {
            document.removeEventListener("click", this._eyedropperClick, true);
            this._eyedropperClick = null;
        }
        if (this._eyedropperEsc) {
            document.removeEventListener("keydown", this._eyedropperEsc);
            this._eyedropperEsc = null;
        }
    },

    _eyedropperPreview(e) {
        // 使用canvas截图方式取色
        const canvas = document.getElementById("graph-canvas") || document.querySelector("canvas");
        if (!canvas) return;
        
        // 简单方式：在canvas上用临时overlay显示放大镜效果
        // 由于canvas跨域等限制，这里用简化方式
    },

    _eyedropperPick(e) {
        if (!this.activeColorInput) return;
        
        const canvas = document.getElementById("graph-canvas") || document.querySelector("canvas");
        if (!canvas) return;
        
        try {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            // 尝试用浏览器的 EyeDropper API
            if (window.EyeDropper) {
                const dropper = new EyeDropper();
                dropper.open().then(result => {
                    const hex = result.sRGBHex;
                    const swatch = this.panel.querySelector(`[data-color="${this.activeColorInput}"]`);
                    if (swatch) swatch.style.backgroundColor = hex;
                    this.setColorFromHex(hex, false);
                    this.setActiveColor(hex);
                    if (this.isVisible) requestAnimationFrame(() => this.syncPickerCursors());
                }).catch(() => {}).finally(() => this.stopEyedropper());
            } else {
                // Fallback: 用 canvas 取色
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                    const pixel = ctx.getImageData(x, y, 1, 1).data;
                    const hex = this.rgbToHex(pixel[0], pixel[1], pixel[2]);
                    const swatch = this.panel.querySelector(`[data-color="${this.activeColorInput}"]`);
                    if (swatch) swatch.style.backgroundColor = hex;
                    this.setColorFromHex(hex, false);
                    this.setActiveColor(hex);
                    if (this.isVisible) requestAnimationFrame(() => this.syncPickerCursors());
                }
                this.stopEyedropper();
            }
        } catch (err) {
            this.stopEyedropper();
        }
    }
};

// 主题面板设置（预设/快捷键/最近色/标签页）云持久化：模块加载即异步拉取并回写本地
(function xzgThemePanelCloudRestore() {
    try {
        if (window.XZGThemePanel && window.XZGThemePanel._cloudRestoreThemePanel) {
            window.XZGThemePanel._cloudRestoreThemePanel();
        } else {
            setTimeout(xzgThemePanelCloudRestore, 100);
        }
    } catch (e) {}
})();
// 云同步统一入口：供“导入配置”后一键推送主题面板设置
window.__xzgCloudPush = window.__xzgCloudPush || {};
window.__xzgCloudPush.themePanel = () => { try { window.XZGThemePanel?._queueThemePanelCloudSave?.(); } catch (e) {} };
