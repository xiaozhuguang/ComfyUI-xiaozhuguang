
import { xzgT } from "./xzg_i18n.js";
import { cloudSave, cloudUIQueueGeometry } from "./xzg_cloud_store.js";

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
                    <button type="button" class="xzg-theme-config-btn" id="xzg-theme-export-btn">${xzgT('导出','Export')}</button>
                    <button type="button" class="xzg-theme-config-btn" id="xzg-theme-import-btn">${xzgT('导入','Import')}</button>
                    <input type="file" id="xzg-theme-import-file" accept=".json,application/json" style="display:none;" />
                    <button type="button" class="xzg-theme-shortcut-btn" id="xzg-theme-shortcut-btn"></button>
                    <button type="button" class="xzg-theme-close">×</button>
                </div>
            </div>
            <div class="xzg-top-tabs">
                <button type="button" class="xzg-top-tab active" data-top-tab="theme">${xzgT('主题','Theme')}</button>
                <button type="button" class="xzg-top-tab" data-top-tab="themeplus">${xzgT('主题+','Theme+')}</button>
                <button type="button" class="xzg-top-tab" data-top-tab="menuhide">${xzgT('菜单隐藏','Menu Hide')}</button>
                <button type="button" class="xzg-top-tab" data-top-tab="quicknodes">${xzgT('快速节点','Quick Nodes')}</button>
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
                    <div class="xzg-quick-nodes-count">${xzgT('已添加','Added')} <span id="xzg-quick-count">0</span> / 20 ${xzgT('个快速节点','quick nodes')}</div>
                    <div class="xzg-quick-setting-row">
                        <span>${xzgT('夺舍模式','Possession Mode')}</span>
                        <button type="button" id="xzg-quick-hide-default-btn" class="xzg-toggle-switch" data-checked="false" title="${xzgT('夺舍模式：开启后，连线菜单只显示快速节点','Possession mode: when on, link menu shows only quick nodes')}">
                            <span class="xzg-toggle-slider"></span>
                            <span class="xzg-toggle-label">${xzgT('关','Off')}</span>
                        </button>
                    </div>
                    <div class="xzg-quick-setting-row">
                        <span>${xzgT('文字颜色','Text Color')}</span>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <input type="color" id="xzg-quick-text-color" value="#FFD700" style="width:24px;height:24px;border:none;background:none;cursor:pointer;padding:0;">
                            <span id="xzg-quick-text-color-value" style="font-size:12px;color:#888;">#FFD700</span>
                        </div>
                    </div>
                    <div class="xzg-menu-hide-toolbar" style="margin-bottom:6px;">
                        <button type="button" class="xzg-menu-tool-btn" id="xzg-quick-clear-btn">${xzgT('清空全部','Clear All')}</button>
                    </div>
                    <div class="xzg-menu-hide-list" id="xzg-quick-nodes-list">
                        <div class="xzg-menu-empty-tip">${xzgT('暂无快速节点','No quick nodes yet')}<br><span style="font-size:11px;">${xzgT('右键节点可添加到快速节点','Right-click a node to add to quick nodes')}</span></div>
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

        // 统一配置导出 / 导入（覆盖收藏 / 工作流 / 快速节点 / 隐藏菜单 / 主题等所有模块）
        const configExportBtn = panel.querySelector("#xzg-theme-export-btn");
        const configImportBtn = panel.querySelector("#xzg-theme-import-btn");
        const configImportFile = panel.querySelector("#xzg-theme-import-file");

        if (configExportBtn) {
            configExportBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                self.exportAllConfig().catch(err => {
                    console.error("[XZG] Export error:", err);
                    alert(xzgT('导出失败：', 'Export failed: ') + err.message);
                });
            });
        }
        if (configImportBtn && configImportFile) {
            configImportBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                configImportFile.click();
            });
            configImportFile.addEventListener("change", (e) => {
                e.stopPropagation();
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const obj = JSON.parse(ev.target.result);
                        self.importAllConfig(obj).then((result) => {
                            if (result && result.applied) {
                                const parts = [];
                                if (result.appliedXzgConfig || result.appliedNotes) parts.push(xzgT('小珠光配置', 'Xiaozhuguang config'));
                                if (result.appliedComfySettings) parts.push(xzgT('ComfyUI 设置', 'ComfyUI settings'));
                                const imported = parts.join(' + ');
                                alert(xzgT('导入成功（', 'Import succeeded (') + imported + xzgT('），正在刷新以应用全部配置…', '). Refreshing to apply all settings…'));
                                setTimeout(() => location.reload(), 300);
                            }
                            // 用户取消则不做任何操作
                        }).catch((err) => {
                            alert(xzgT('导入失败：配置文件无效', 'Import failed: invalid config file') + ' (' + err.message + ')');
                        });
                    } catch (err) {
                        alert(xzgT('导入失败：配置文件无效', 'Import failed: invalid config file') + ' (' + err.message + ')');
                    }
                };
                reader.readAsText(file);
                configImportFile.value = '';
            });
        }

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

        topTabs.forEach(tab => {
            tab.addEventListener('click', (e) => {
                e.stopPropagation();
                switchTopTab(tab.dataset.topTab);
            });
        });

        let savedTab = 'theme';
        try {
            const t = localStorage.getItem('xzg-theme-panel-tab');
            if (t === 'menuhide' || t === 'theme' || t === 'quicknodes' || t === 'themeplus') savedTab = t;
        } catch(e) {}

        if (savedTab === 'menuhide' || savedTab === 'quicknodes') {
            const themeTab = panel.querySelector('.xzg-tab-content[data-tab-content="theme"]');
            const targetTab = panel.querySelector(`.xzg-tab-content[data-tab-content="${savedTab}"]`);
            if (themeTab && targetTab) {
                themeTab.style.display = '';
                targetTab.style.display = 'none';
                requestAnimationFrame(() => {
                    if (themeTab.offsetHeight > 0) {
                        targetTab.style.height = themeTab.offsetHeight + 'px';
                    }
                    switchTopTab(savedTab);
                });
            } else {
                switchTopTab(savedTab);
            }
        } else {
            switchTopTab(savedTab);
        }

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
            if (this._menuListVisible && panel.style.display !== 'none') {
                const menuContent = panel.querySelector('.xzg-tab-content[data-tab-content="menuhide"]');
                if (menuContent && menuContent.style.display !== 'none') {
                    renderMenuList();
                }
            }
        };

        function renderQuickNodesList() {
            const listEl = panel.querySelector('#xzg-quick-nodes-list');
            const countEl = panel.querySelector('#xzg-quick-count');
            if (!listEl || !countEl) return;

            const quickNodes = window.XZGQuickNodes?.getQuickNodeList() || [];
            countEl.textContent = quickNodes.length;

            if (quickNodes.length === 0) {
                listEl.innerHTML = '<div class="xzg-menu-empty-tip">' + xzgT('暂无快速节点','No quick nodes yet') + '<br><span style="font-size:11px;">' + xzgT('右键节点可添加到快速节点','Right-click a node to add to quick nodes') + '</span></div>';
                return;
            }

            listEl.innerHTML = '';
            quickNodes.forEach((node, index) => {
                const item = document.createElement('div');
                item.className = 'xzg-quick-node-manage-item';
                item.draggable = true;
                item.dataset.index = index;
                item.dataset.type = node.type;

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
                if (window.XZGQuickNodes && confirm(xzgT('确定要清空所有快速节点吗？','Sure to clear all quick nodes?'))) {
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

        const quickTextColorInput = panel.querySelector('#xzg-quick-text-color');
        const quickTextColorValue = panel.querySelector('#xzg-quick-text-color-value');
        if (quickTextColorInput && quickTextColorValue) {
            if (window.XZGQuickNodes) {
                const color = window.XZGQuickNodes.getTextColor();
                quickTextColorInput.value = color;
                quickTextColorValue.textContent = color.toUpperCase();
            }
            quickTextColorInput.addEventListener('input', (e) => {
                const color = e.target.value;
                quickTextColorValue.textContent = color.toUpperCase();
                if (window.XZGQuickNodes) {
                    window.XZGQuickNodes.setTextColor(color);
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
                    if (quickTextColorInput && quickTextColorValue && window.XZGQuickNodes) {
                        const color = window.XZGQuickNodes.getTextColor();
                        quickTextColorInput.value = color;
                        quickTextColorValue.textContent = color.toUpperCase();
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
            // 点击面板内部 → 不关闭
            if (self.panel && self.panel.contains(e.target)) return;
            // 点击面板的弹出层（取色器 / 对话框）→ 不关闭
            if (e.target.closest(".xzg-dialog-overlay") || e.target.closest(".xzg-color-picker-popup") || e.target.closest(".xzg-wf-dialog-overlay")) return;
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

    /**
     * 显示导出选项对话框
     */
    showExportDialog() {
        return new Promise((resolve) => {
            const self = this;
            self._ensureGlobalDialogCSS();
            const overlay = document.createElement("div");
            overlay.className = "xzg-modal-overlay";
            overlay.style.zIndex = "2000001";
            overlay.innerHTML = `
                <div class="xzg-modal-dialog">
                    <div class="xzg-modal-title">${xzgT('导出配置', 'Export Config')}</div>
                    <div class="xzg-modal-body">
                        <label class="xzg-modal-checkbox">
                            <input type="checkbox" id="xzg-export-include-xzg" checked />
                            <span>${xzgT('包含小珠光配置（主题配色 / 收藏节点 / 工作流使用频率 / 菜单隐藏 / 快速节点 / 记事本）', 'Include Xiaozhuguang config (theme colors / favorites / workflow usage / menu hide / quick nodes / notepad)')}</span>
                        </label>
                        <label class="xzg-modal-checkbox">
                            <input type="checkbox" id="xzg-export-include-comfy" checked />
                            <span>${xzgT('包含 ComfyUI 设置（快捷键、界面主题、布局偏好等）', 'Include ComfyUI settings (keybindings, UI theme, layout preferences, etc.)')}</span>
                        </label>
                        <div class="xzg-modal-hint">${xzgT('提示：ComfyUI 设置包含您自定义的快捷键、颜色主题、界面布局偏好等。', 'Tip: ComfyUI settings include your custom keybindings, color theme, UI layout preferences, etc.')}</div>
                    </div>
                    <div class="xzg-modal-footer">
                        <button type="button" class="xzg-modal-btn xzg-modal-cancel">${xzgT('取消', 'Cancel')}</button>
                        <button type="button" class="xzg-modal-btn xzg-modal-confirm">${xzgT('导出', 'Export')}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const close = (result) => {
                overlay.remove();
                resolve(result);
            };

            overlay.querySelector(".xzg-modal-cancel").addEventListener("click", () => close(null));
            overlay.querySelector(".xzg-modal-confirm").addEventListener("click", () => {
                const includeXzg = overlay.querySelector("#xzg-export-include-xzg").checked;
                const includeComfy = overlay.querySelector("#xzg-export-include-comfy").checked;
                // 备注/记事本已合并到小珠光配置
                close({ includeXzgConfig: includeXzg, includeNotes: includeXzg, includeComfySettings: includeComfy });
            });
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) close(null);
            });
        });
    },

    /**
     * 显示导入选项对话框
     */
    showImportDialog(hasComfySettings, hasXzg) {
        return new Promise((resolve) => {
            const self = this;
            self._ensureGlobalDialogCSS();
            const overlay = document.createElement("div");
            overlay.className = "xzg-modal-overlay";
            overlay.style.zIndex = "2000001";
            const comfyCheckbox = hasComfySettings ? `
                <label class="xzg-modal-checkbox">
                    <input type="checkbox" id="xzg-import-include-comfy" checked />
                    <span>${xzgT('导入 ComfyUI 设置（快捷键、界面主题、布局偏好等）', 'Import ComfyUI settings (keybindings, UI theme, layout preferences, etc.)')}</span>
                </label>
            ` : `
                <div class="xzg-modal-hint">${xzgT('此配置文件不包含 ComfyUI 设置。', 'This config file does not contain ComfyUI settings.')}</div>
            `;
            const xzgHint = hasXzg ? `` : `
                <div class="xzg-modal-hint">${xzgT('此配置文件不包含小珠光配置。', 'This config file does not contain Xiaozhuguang config.')}</div>
            `;
            overlay.innerHTML = `
                <div class="xzg-modal-dialog">
                    <div class="xzg-modal-title">${xzgT('导入配置', 'Import Config')}</div>
                    <div class="xzg-modal-body">
                        <label class="xzg-modal-checkbox" style="${hasXzg ? '' : 'opacity:0.5;pointer-events:none;'}">
                            <input type="checkbox" id="xzg-import-include-xzg" ${hasXzg ? 'checked' : 'disabled'} />
                            <span>${xzgT('导入小珠光配置（主题配色 / 收藏节点 / 工作流使用频率 / 菜单隐藏 / 快速节点 / 记事本）', 'Import Xiaozhuguang config (theme colors / favorites / workflow usage / menu hide / quick nodes / notepad)')}</span>
                        </label>
                        ${xzgHint}
                        ${comfyCheckbox}
                        <div class="xzg-modal-warning">${xzgT('警告：导入将覆盖当前的对应设置，建议先导出备份。', 'Warning: Importing will overwrite current corresponding settings. Export a backup first is recommended.')}</div>
                    </div>
                    <div class="xzg-modal-footer">
                        <button type="button" class="xzg-modal-btn xzg-modal-cancel">${xzgT('取消', 'Cancel')}</button>
                        <button type="button" class="xzg-modal-btn xzg-modal-confirm">${xzgT('导入', 'Import')}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const close = (result) => {
                overlay.remove();
                resolve(result);
            };

            overlay.querySelector(".xzg-modal-cancel").addEventListener("click", () => close(null));
            overlay.querySelector(".xzg-modal-confirm").addEventListener("click", () => {
                const includeXzgEl = overlay.querySelector("#xzg-import-include-xzg");
                const includeXzg = includeXzgEl && !includeXzgEl.disabled ? includeXzgEl.checked : false;
                const includeComfyEl = overlay.querySelector("#xzg-import-include-comfy");
                const includeComfy = includeComfyEl ? includeComfyEl.checked : false;
                // 备注/记事本已合并到小珠光配置
                close({ includeXzgConfig: includeXzg, includeNotes: includeXzg, includeComfySettings: includeComfy });
            });
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) close(null);
            });
        });
    },

    // ====== 小珠光统一配置导出 / 导入（覆盖收藏 / 工作流 / 快速节点 / 隐藏菜单 / 主题 / 备注 / ComfyUI设置 等所有模块） ======
    async exportAllConfig() {
        // 1) 先弹导出选项，等用户确认各模块的勾选
        const opt = await this.showExportDialog();
        if (!opt) return; // 用户取消
        const includeXzg = opt.includeXzgConfig !== false;    // 默认true
        const includeNotes = opt.includeNotes !== false;      // 默认true
        const includeComfy = opt.includeComfySettings !== false;

        const NOTES_KEY = "xiaozhuguang.notes";

        const prefixes = ["xzg_", "xzg-", "xiaozhuguang.", "xz_"];
        const extraKeys = ["comfyui_xiaozhuguang", "xzg_workflows_meta"];
        let ls = {};
        if (includeXzg) {
            // 优先从实例内存导出（云存储生效时本地可能没最新数据）
            if (window.xiaozhuguangFavorites && typeof window.xiaozhuguangFavorites.favorites === "object") {
                try {
                    ls["comfyui_xiaozhuguang"] = JSON.stringify(window.xiaozhuguangFavorites.favorites);
                } catch (e) {}
            }
            if (window.XZGWorkflows && typeof window.XZGWorkflows.meta === "object") {
                try {
                    ls["xzg_workflows_meta"] = JSON.stringify(window.XZGWorkflows.meta);
                } catch (e) {}
            }
            // 兜底遍历 localStorage（覆盖实例导出不到的其他键）
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k) continue;
                // 备注单独处理（根据 includeNotes 决定）
                if (!includeNotes && k === NOTES_KEY) continue;
                if (prefixes.some(p => k.startsWith(p)) || extraKeys.includes(k)) {
                    if (!ls[k]) { // 实例已经导出则不覆盖
                        try { ls[k] = localStorage.getItem(k); } catch (e) {}
                    }
                }
            }
        } else if (includeNotes) {
            // 不导出小珠光配置，但导出备注时只带 notes 键
            try {
                const v = localStorage.getItem(NOTES_KEY);
                if (v !== null) ls[NOTES_KEY] = v;
            } catch (e) {}
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
        if (includeXzg) {
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
        if (includeXzg) {
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

        const cfg = {
            format: "xiaozhuguang-config",
            version: 4,
            exportedAt: new Date().toISOString(),
            flags: { includeXzgConfig: includeXzg, includeNotes: includeNotes, includeComfySettings: includeComfy },
            localStorage: ls,
            notes: notesTop,
            favoritesPreviews: favoritesPreviews,
            comfySettings: comfySettings,
            shortcuts: shortcuts
        };
        const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const d = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
        a.href = url;
        a.download = `xiaozhuguang-config-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    async importAllConfig(obj) {
        if (!obj || typeof obj !== "object") throw new Error("not an object");
        if (obj.format && obj.format !== "xiaozhuguang-config") {
            throw new Error("unknown format: " + obj.format);
        }

        const NOTES_KEY = "xiaozhuguang.notes";

        // 先检测此文件是否包含两类可选模块（用于弹窗显示复选框）
        const hasComfy = !!(obj.comfySettings && typeof obj.comfySettings === "object" && Object.keys(obj.comfySettings).length > 0);
        // hasXzg：只要文件包含 localStorage / notes / favoritesPreviews / workflowUsage / shortcuts 之一，就视为包含小珠光配置
        const hasXzg = !!(
            (obj.localStorage && typeof obj.localStorage === "object" && Object.keys(obj.localStorage).length > 0) ||
            (obj.notes && typeof obj.notes === "object" && Array.isArray(obj.notes.groups)) ||
            (obj.favoritesPreviews && Array.isArray(obj.favoritesPreviews) && obj.favoritesPreviews.length > 0) ||
            (obj.workflowUsage && typeof obj.workflowUsage === "object" && Object.keys(obj.workflowUsage).length > 0) ||
            (Array.isArray(obj.shortcuts) && obj.shortcuts.length > 0)
        );
        const hasNotes = !!(
            (obj.notes && typeof obj.notes === "object") ||
            (obj.localStorage && obj.localStorage["xiaozhuguang.notes"])
        );

        // 弹导入选项（备注/记事本已合并进小珠光配置，不再单独复选）
        const opt = await this.showImportDialog(hasComfy, hasXzg);
        if (!opt) return { applied: false };
        const includeXzg = opt.includeXzgConfig !== false;
        const includeNotes = opt.includeNotes !== false;
        const includeComfy = opt.includeComfySettings !== false;

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
        let importedXzg = false;
        if (includeXzg) {
            if (obj.localStorage && typeof obj.localStorage === "object") {
                for (const k in obj.localStorage) {
                    // notes 已在上面单独按 includeNotes 决策导入，此处跳过避免强制覆盖
                    if (k === NOTES_KEY) continue;
                    try { localStorage.setItem(k, obj.localStorage[k]); } catch (e) {}
                }
                importedXzg = true;
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
                                if (typeof inst.renderWorkflowList === "function") inst.renderWorkflowList();
                            }
                            cloudSave("xzg_workflows_meta", meta).catch(() => {});
                        }
                    } catch (e) {}
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
            appliedComfySettings: importedComfy
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
            .xzg-modal-cancel {
                background: #3a3a3a; color: #ccc;
            }
            .xzg-modal-confirm {
                background: #FFD700;color: #333;border-color: #FFD700;font-weight: bold;
            }
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
