
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
                <span class="xzg-theme-title">小珠光</span>
                <div class="xzg-theme-header-btns">
                    <button type="button" class="xzg-theme-shortcut-btn" id="xzg-theme-shortcut-btn"></button>
                    <button type="button" class="xzg-theme-close">×</button>
                </div>
            </div>
            <div class="xzg-top-tabs">
                <button type="button" class="xzg-top-tab active" data-top-tab="theme">主题</button>
                <button type="button" class="xzg-top-tab" data-top-tab="menuhide">菜单隐藏</button>
                <button type="button" class="xzg-top-tab" data-top-tab="quicknodes">快速节点</button>
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
                            <span class="xzg-swatch-label">标题栏</span>
                            <button type="button" class="xzg-toggle-switch xzg-title-gradient-toggle" data-checked="false">
                                <span class="xzg-toggle-slider"></span>
                                <span class="xzg-toggle-label">关</span>
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
                            <span class="xzg-swatch-label">主体</span>
                            <div class="xzg-swatch-row">
                                <button type="button" class="xzg-color-swatch" data-color="color1" style="background-color: ${this.defaults.color1}"></button>
                                <button type="button" class="xzg-color-swatch" data-color="color2" style="background-color: ${this.defaults.color2}"></button>
                                <button type="button" class="xzg-color-swatch" data-color="color3" style="background-color: ${this.defaults.color3}"></button>
                            </div>
                        </div>
                    </div>
                    
                    <div class="xzg-theme-direction-row">
                        <span class="xzg-theme-label">主体方向</span>
                        <div class="xzg-direction-buttons">
                            <button type="button" class="xzg-dir-btn" data-dir="0">↓</button>
                            <button type="button" class="xzg-dir-btn" data-dir="90">→</button>
                            <button type="button" class="xzg-dir-btn" data-dir="45">↘</button>
                            <button type="button" class="xzg-dir-btn" data-dir="315">↗</button>
                        </div>
                    </div>
                    
                    <div class="xzg-theme-separator"></div>
                    
                    <div class="xzg-swatch-group">
                        <span class="xzg-swatch-label">文字颜色</span>
                        <div class="xzg-swatch-row">
                            <button type="button" class="xzg-color-swatch xzg-text-swatch" data-color="textColor" style="background-color: ${this.defaults.textColor}"></button>
                        </div>
                    </div>
                    
                    <div class="xzg-theme-font-row">
                        <span class="xzg-theme-label">文字大小</span>
                        <div class="xzg-font-size-control">
                            <button type="button" class="xzg-font-btn" data-size-action="decrease">A-</button>
                            <span class="xzg-font-size-value" id="xzg-font-size-value">${this.defaults.fontSize}</span>
                            <button type="button" class="xzg-font-btn" data-size-action="increase">A+</button>
                        </div>
                    </div>
                    
                    <div class="xzg-theme-font-row">
                        <span class="xzg-theme-label">文字位置</span>
                        <div class="xzg-align-buttons">
                            <button type="button" class="xzg-align-btn" data-align="left">左</button>
                            <button type="button" class="xzg-align-btn active" data-align="center">中</button>
                            <button type="button" class="xzg-align-btn" data-align="right">右</button>
                        </div>
                    </div>
                    
                    <button type="button" id="xzg-apply-btn" class="xzg-apply-btn">应用主题并关闭</button>
                    <button type="button" id="xzg-reset-btn" class="xzg-reset-btn">恢复默认颜色</button>
                    
                    <div class="xzg-theme-separator"></div>
                    
                    <div class="xzg-presets-section">
                        <div class="xzg-presets-header">
                            <span class="xzg-swatch-label">预设主题</span>
                            <div class="xzg-presets-row">
                                <div class="xzg-preset-item" data-preset="0"></div>
                                <div class="xzg-preset-item" data-preset="1"></div>
                                <div class="xzg-preset-item" data-preset="2"></div>
                                <div class="xzg-preset-item" data-preset="3"></div>
                                <div class="xzg-preset-item" data-preset="4"></div>
                            </div>
                        </div>
                        <p class="xzg-presets-tip">左键应用，右键保存当前设置</p>
                    </div>

                    <div class="xzg-theme-separator"></div>

                    <div class="xzg-link-highlight-section">
                        <span class="xzg-swatch-label">连线高亮</span>
                        <button type="button" id="xzg-link-highlight-btn" class="xzg-toggle-switch xzg-link-highlight-toggle" data-checked="false" title="开启后，选中节点的连线高亮，其他变暗">
                            <span class="xzg-toggle-slider"></span>
                            <span class="xzg-toggle-label">关</span>
                        </button>
                    </div>

                    <div class="xzg-theme-separator"></div>

                    <div class="xzg-wallpaper-section">
                        <div class="xzg-wallpaper-header">
                            <span class="xzg-swatch-label">画布壁纸</span>
                            <button type="button" id="xzg-wallpaper-btn" class="xzg-toggle-switch xzg-wallpaper-toggle" data-checked="false" title="开启画布壁纸背景">
                                <span class="xzg-toggle-slider"></span>
                                <span class="xzg-toggle-label">关</span>
                            </button>
                        </div>

                        <div class="xzg-wallpaper-controls" id="xzg-wallpaper-controls" style="display:none;">
                            <div class="xzg-wallpaper-upload-row">
                                <input type="file" id="xzg-wallpaper-file-input" accept="image/*,video/*" style="display:none;">
                                <button type="button" id="xzg-wallpaper-upload-btn" class="xzg-wallpaper-btn">选择图片</button>
                                <button type="button" id="xzg-wallpaper-clear-btn" class="xzg-wallpaper-btn xzg-wallpaper-clear">清除</button>
                            </div>

                            <div class="xzg-wallpaper-row">
                                <span class="xzg-swatch-label" style="font-size:12px;">透明度</span>
                                <input type="range" id="xzg-wallpaper-opacity" min="0" max="1" step="0.05" value="0.5" style="flex:1;">
                                <span class="xzg-wallpaper-value" id="xzg-wallpaper-opacity-val">50%</span>
                            </div>

                            <div class="xzg-wallpaper-row">
                                <span class="xzg-swatch-label" style="font-size:12px;">填充方式</span>
                                <div class="xzg-wallpaper-fit-btns">
                                    <button type="button" class="xzg-wallpaper-fit-btn active" data-fit="cover">覆盖</button>
                                    <button type="button" class="xzg-wallpaper-fit-btn" data-fit="contain">包含</button>
                                    <button type="button" class="xzg-wallpaper-fit-btn" data-fit="fill">拉伸</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- <div class="xzg-link-highlight-section">
                        <span class="xzg-swatch-label">连线颜色</span>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <button type="button" class="xzg-color-swatch xzg-linkcolor-swatch" data-color="linkColor" style="background-color: ${this.defaults.linkColor};width:18px;height:18px;min-width:18px;border-radius:3px;" title="连线颜色"></button>
                            <button type="button" id="xzg-link-color-btn" class="xzg-toggle-switch xzg-link-color-toggle" data-checked="false" title="开启后，所有连线使用自定义颜色">
                                <span class="xzg-toggle-slider"></span>
                                <span class="xzg-toggle-label">关</span>
                            </button>
                        </div>
                    </div> -->

                    <!-- <div class="xzg-link-highlight-section">
                        <span class="xzg-swatch-label">连线动画</span>
                        <button type="button" id="xzg-link-laser-btn" class="xzg-toggle-switch xzg-link-laser-toggle" data-checked="false" title="开启后，连线显示动画效果">
                            <span class="xzg-toggle-slider"></span>
                            <span class="xzg-toggle-label">关</span>
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
            </div>
            <div class="xzg-tab-content" data-tab-content="menuhide" style="display:none;">
                <div class="xzg-menu-hide-full">
                    <div class="xzg-menu-hide-tabs">
                        <button type="button" class="xzg-menu-tab active" data-menu-tab="canvas">画布菜单</button>
                        <button type="button" class="xzg-menu-tab" data-menu-tab="node">节点菜单</button>
                    </div>
                    <div class="xzg-menu-search-box">
                        <input type="text" id="xzg-menu-search-input" placeholder="🔍 搜索菜单项..." />
                        <button type="button" class="xzg-menu-search-clear" id="xzg-menu-search-clear" title="清除搜索" style="display: none;">✕</button>
                    </div>
                    <div class="xzg-menu-hide-toolbar">
                        <button type="button" id="xzg-menu-refresh-btn" class="xzg-menu-tool-btn">刷新列表</button>
                        <button type="button" id="xzg-menu-selectall-btn" class="xzg-menu-tool-btn">隐藏全部</button>
                        <button type="button" id="xzg-menu-unselectall-btn" class="xzg-menu-tool-btn">显示全部</button>
                    </div>
                    <div class="xzg-menu-hide-toolbar">
                        <button type="button" id="xzg-menu-export-btn" class="xzg-menu-tool-btn">导出配置</button>
                        <button type="button" id="xzg-menu-import-btn" class="xzg-menu-tool-btn">导入配置</button>
                        <input type="file" id="xzg-menu-import-file" accept=".json" style="display:none;" />
                    </div>
                    <div class="xzg-menu-hide-list" id="xzg-menu-hide-list">
                        <div class="xzg-menu-empty-tip">点击「刷新列表」加载菜单项<br><span style="font-size:11px;color:#888;">提示：先在画布上右键一次再刷新</span></div>
                    </div>
                    <button type="button" id="xzg-menu-reset-btn" class="xzg-menu-reset-btn">恢复所有隐藏菜单</button>
                </div>
            </div>
            <div class="xzg-tab-content" data-tab-content="quicknodes" style="display:none;">
                <div class="xzg-menu-hide-full">
                    <div class="xzg-quick-nodes-count">已添加 <span id="xzg-quick-count">0</span> / 20 个快速节点</div>
                    <div class="xzg-quick-setting-row">
                        <span>隐藏默认连线菜单</span>
                        <button type="button" id="xzg-quick-hide-default-btn" class="xzg-toggle-switch" data-checked="false" title="开启后，连线菜单只显示快速节点">
                            <span class="xzg-toggle-slider"></span>
                            <span class="xzg-toggle-label">关</span>
                        </button>
                    </div>
                    <div class="xzg-menu-hide-toolbar" style="margin-bottom:6px;">
                        <button type="button" class="xzg-menu-tool-btn" id="xzg-quick-export-btn">导出配置</button>
                        <button type="button" class="xzg-menu-tool-btn" id="xzg-quick-import-btn">导入配置</button>
                        <button type="button" class="xzg-menu-tool-btn" id="xzg-quick-clear-btn">清空全部</button>
                    </div>
                    <input type="file" id="xzg-quick-import-file" accept=".json" style="display:none;" />
                    <div class="xzg-menu-hide-list" id="xzg-quick-nodes-list">
                        <div class="xzg-menu-empty-tip">暂无快速节点<br><span style="font-size:11px;">右键节点可添加到快速节点</span></div>
                    </div>
                    <p style="margin-top:8px;font-size:11px;color:#888;text-align:center;">拖拽可调整顺序，从节点拉出连线时搜索框顶部显示</p>
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
                if (label) label.textContent = newChecked ? "开" : "关";
                
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

            item.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const index = parseInt(item.dataset.preset);
                self.saveCurrentToPreset(index);
            });
        });

        const linkHighlightBtn = panel.querySelector("#xzg-link-highlight-btn");
        if (linkHighlightBtn) {
            linkHighlightBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (window.XZGThemeManager) {
                    const active = window.XZGThemeManager.toggleLinkHighlight();
                    linkHighlightBtn.setAttribute("data-checked", active ? "true" : "false");
                    const label = linkHighlightBtn.querySelector(".xzg-toggle-label");
                    if (label) label.textContent = active ? "开" : "关";
                }
            });

            // 同步初始状态
            if (window.XZGThemeManager && window.XZGThemeManager.linkHighlightActive) {
                linkHighlightBtn.setAttribute("data-checked", "true");
                const label = linkHighlightBtn.querySelector(".xzg-toggle-label");
                if (label) label.textContent = "开";
            }
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
                    if (label) label.textContent = next ? "开" : "关";
                    if (wallpaperControls) {
                        wallpaperControls.style.display = next ? "block" : "none";
                    }
                }
            });

            if (window.XZGThemeManager && window.XZGThemeManager.wallpaperActive) {
                wallpaperBtn.setAttribute("data-checked", "true");
                const label = wallpaperBtn.querySelector(".xzg-toggle-label");
                if (label) label.textContent = "开";
                if (wallpaperControls) {
                    wallpaperControls.style.display = "block";
                }
            }
        }

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
                        if (label) label.textContent = "关";
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
        //             if (label) label.textContent = active ? "开" : "关";
        //             // 显示/隐藏动画风格选择
        //             if (animTypeSection) animTypeSection.style.display = active ? 'flex' : 'none';
        //         }
        //     });
        //
        //     // 同步初始状态
        //     if (window.XZGThemeManager && window.XZGThemeManager.linkLaserActive) {
        //         linkLaserBtn.setAttribute("data-checked", "true");
        //         const label = linkLaserBtn.querySelector(".xzg-toggle-label");
        //         if (label) label.textContent = "开";
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
        //             if (label) label.textContent = active ? "开" : "关";
        //         }
        //     });
        //
        //     // 同步初始状态
        //     if (window.XZGThemeManager && window.XZGThemeManager.linkColorActive) {
        //         linkColorBtn.setAttribute("data-checked", "true");
        //         const label = linkColorBtn.querySelector(".xzg-toggle-label");
        //         if (label) label.textContent = "开";
        //     }
        // }

        // 菜单隐藏功能
        const menuHideBtn = panel.querySelector("#xzg-menu-hide-btn");
        const menuHideControls = panel.querySelector("#xzg-menu-hide-controls");
        const menuHideList = panel.querySelector("#xzg-menu-hide-list");
        const menuTabs = panel.querySelectorAll(".xzg-menu-tab");
        const menuRefreshBtn = panel.querySelector("#xzg-menu-refresh-btn");
        const menuSelectAllBtn = panel.querySelector("#xzg-menu-selectall-btn");
        const menuUnselectAllBtn = panel.querySelector("#xzg-menu-unselectall-btn");
        const menuResetBtn = panel.querySelector("#xzg-menu-reset-btn");
        const menuExportBtn = panel.querySelector("#xzg-menu-export-btn");
        const menuImportBtn = panel.querySelector("#xzg-menu-import-btn");
        const menuImportFile = panel.querySelector("#xzg-menu-import-file");
        const menuSearchInput = panel.querySelector("#xzg-menu-search-input");
        const menuSearchClear = panel.querySelector("#xzg-menu-search-clear");

        let currentMenuTab = 'canvas';
        let currentMenuSearch = '';

        const updateMenuSearchClearVisibility = () => {
            if (menuSearchClear && menuSearchInput) {
                menuSearchClear.style.display = menuSearchInput.value ? '' : 'none';
            }
        };

        const renderMenuList = () => {
            if (!window.XZGMenuHide || !menuHideList) return;
            const mh = window.XZGMenuHide;
            const hiddenMap = mh.config[currentMenuTab] || {};
            const items = mh._collectedItems?.[currentMenuTab] || [];

            if (items.length === 0) {
                menuHideList.innerHTML = '<div class="xzg-menu-empty-tip">点击「刷新列表」加载菜单项<br><span style="font-size:11px;color:#888;">提示：先在画布上右键一次再刷新</span></div>';
                return;
            }

            let filteredItems = items;
            if (currentMenuSearch) {
                const searchLower = currentMenuSearch.toLowerCase();
                filteredItems = items.filter(item => mh._searchMatch(item, searchLower));
            }

            if (filteredItems.length === 0) {
                menuHideList.innerHTML = '<div class="xzg-menu-empty-tip">没有匹配的菜单项</div>';
                return;
            }

            let html = '';
            filteredItems.forEach(item => {
                const isHidden = !!hiddenMap[item];
                const displayName = item.length > 28 ? item.substring(0, 28) + '...' : item;
                html += `
                    <label class="xzg-menu-item" title="${item.replace(/"/g, '&quot;')}">
                        <input type="checkbox" data-menu-item="${item.replace(/"/g, '&quot;')}" ${isHidden ? 'checked' : ''}>
                        <span>${displayName}</span>
                    </label>
                `;
            });
            menuHideList.innerHTML = html;

            menuHideList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const item = cb.dataset.menuItem;
                    const checked = cb.checked;
                    if (window.XZGMenuHide) {
                        window.XZGMenuHide.setHidden(currentMenuTab, item, checked);
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
            if (t === 'menuhide' || t === 'theme' || t === 'quicknodes') savedTab = t;
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
                    renderMenuList();
                });
            });
        }

        if (menuRefreshBtn) {
            menuRefreshBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.XZGMenuHide) {
                    window.XZGMenuHide.collectCurrentMenu(currentMenuTab);
                    renderMenuList();
                }
            });
        }

        if (menuSelectAllBtn) {
            menuSelectAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!window.XZGMenuHide) return;
                const mh = window.XZGMenuHide;
                const items = mh._collectedItems?.[currentMenuTab] || [];
                items.forEach(item => mh.setHidden(currentMenuTab, item, true));
                renderMenuList();
            });
        }

        if (menuUnselectAllBtn) {
            menuUnselectAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!window.XZGMenuHide) return;
                const mh = window.XZGMenuHide;
                const items = mh._collectedItems?.[currentMenuTab] || [];
                items.forEach(item => mh.setHidden(currentMenuTab, item, false));
                renderMenuList();
            });
        }

        if (menuResetBtn) {
            menuResetBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!window.XZGMenuHide) return;
                if (confirm('确定要恢复所有被隐藏的菜单项吗？')) {
                    window.XZGMenuHide.resetAll();
                    renderMenuList();
                }
            });
        }

        if (menuExportBtn) {
            menuExportBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!window.XZGMenuHide) return;
                const mh = window.XZGMenuHide;
                const exportData = {
                    version: 1,
                    type: 'xzg-menu-hide-config',
                    config: JSON.parse(JSON.stringify(mh.config)),
                    exportedAt: new Date().toISOString()
                };
                const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const dateStr = new Date().toISOString().slice(0, 10);
                a.download = `xzg-menu-hide-config-${dateStr}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            });
        }

        if (menuImportBtn && menuImportFile) {
            menuImportBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                menuImportFile.click();
            });
            menuImportFile.addEventListener('change', (e) => {
                e.stopPropagation();
                if (!window.XZGMenuHide) return;
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        const config = data.config || data;
                        if (!config.canvas && !config.node) {
                            alert('配置文件格式不正确');
                            return;
                        }
                        if (!confirm('导入配置将覆盖当前的菜单隐藏设置，确定继续吗？')) {
                            return;
                        }
                        const mh = window.XZGMenuHide;
                        mh.config = {
                            canvas: config.canvas || {},
                            node: config.node || {}
                        };
                        mh.saveConfig();
                        mh._applyHideToOpenMenus();
                        renderMenuList();
                        alert('导入成功');
                    } catch (err) {
                        alert('导入失败：文件格式不正确');
                        console.warn('[小珠光] 菜单配置导入失败:', err);
                    }
                };
                reader.readAsText(file);
                menuImportFile.value = '';
            });
        }

        if (menuSearchInput) {
            menuSearchInput.addEventListener('input', (e) => {
                e.stopPropagation();
                currentMenuSearch = e.target.value;
                renderMenuList();
                updateMenuSearchClearVisibility();
            });
            menuSearchInput.addEventListener('click', (e) => e.stopPropagation());
            menuSearchInput.addEventListener('pointerdown', (e) => e.stopPropagation());
            menuSearchInput.addEventListener('mousedown', (e) => e.stopPropagation());
        }

        if (menuSearchClear) {
            menuSearchClear.addEventListener('click', (e) => {
                e.stopPropagation();
                if (menuSearchInput) {
                    menuSearchInput.value = '';
                    currentMenuSearch = '';
                    renderMenuList();
                    updateMenuSearchClearVisibility();
                    menuSearchInput.focus();
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
                listEl.innerHTML = '<div class="xzg-menu-empty-tip">暂无快速节点<br><span style="font-size:11px;">右键节点可添加到快速节点</span></div>';
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
                removeBtn.textContent = '移除';
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
                if (window.XZGQuickNodes && confirm('确定要清空所有快速节点吗？')) {
                    const nodes = window.XZGQuickNodes.getQuickNodeList();
                    nodes.forEach(n => window.XZGQuickNodes.removeQuickNode(n.type));
                    renderQuickNodesList();
                }
            });
        }

        const quickHideDefaultBtn = panel.querySelector('#xzg-quick-hide-default-btn');

        const quickExportBtn = panel.querySelector('#xzg-quick-export-btn');
        const quickImportBtn = panel.querySelector('#xzg-quick-import-btn');
        const quickImportFile = panel.querySelector('#xzg-quick-import-file');

        if (quickExportBtn) {
            quickExportBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!window.XZGQuickNodes) return;
                const qn = window.XZGQuickNodes;
                const exportData = {
                    version: 1,
                    type: 'xzg-quick-nodes-config',
                    quickNodes: JSON.parse(JSON.stringify(qn.getQuickNodeList())),
                    config: JSON.parse(JSON.stringify(qn.config)),
                    exportedAt: new Date().toISOString()
                };
                const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const dateStr = new Date().toISOString().slice(0, 10);
                a.download = `xzg-quick-nodes-config-${dateStr}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            });
        }

        if (quickImportBtn && quickImportFile) {
            quickImportBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                quickImportFile.click();
            });
            quickImportFile.addEventListener('change', (e) => {
                e.stopPropagation();
                if (!window.XZGQuickNodes) return;
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const data = JSON.parse(ev.target.result);
                        const quickNodes = data.quickNodes || data;
                        if (!Array.isArray(quickNodes)) {
                            alert('配置文件格式不正确');
                            return;
                        }
                        if (!confirm('导入配置将覆盖当前的快速节点设置，确定继续吗？')) {
                            return;
                        }
                        const qn = window.XZGQuickNodes;
                        qn.quickNodes = quickNodes.slice(0, 20);
                        qn.saveQuickNodes();
                        if (data.config && typeof data.config === 'object') {
                            qn.config = Object.assign({}, qn.config, data.config);
                            qn.saveConfig();
                        }
                        renderQuickNodesList();
                        if (quickHideDefaultBtn) {
                            const checked = qn.isHideDefaultMenu();
                            quickHideDefaultBtn.setAttribute("data-checked", checked ? "true" : "false");
                            const label = quickHideDefaultBtn.querySelector(".xzg-toggle-label");
                            if (label) label.textContent = checked ? "开" : "关";
                        }
                        alert('导入成功');
                    } catch (err) {
                        alert('导入失败：文件格式不正确');
                        console.warn('[小珠光] 快速节点配置导入失败:', err);
                    }
                };
                reader.readAsText(file);
                quickImportFile.value = '';
            });
        }

        if (quickHideDefaultBtn) {
            if (window.XZGQuickNodes) {
                const checked = window.XZGQuickNodes.isHideDefaultMenu();
                quickHideDefaultBtn.setAttribute("data-checked", checked ? "true" : "false");
                const label = quickHideDefaultBtn.querySelector(".xzg-toggle-label");
                if (label) label.textContent = checked ? "开" : "关";
            }
            quickHideDefaultBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.XZGQuickNodes) {
                    const checked = window.XZGQuickNodes.isHideDefaultMenu();
                    const newChecked = !checked;
                    window.XZGQuickNodes.setHideDefaultMenu(newChecked);
                    quickHideDefaultBtn.setAttribute("data-checked", newChecked ? "true" : "false");
                    const label = quickHideDefaultBtn.querySelector(".xzg-toggle-label");
                    if (label) label.textContent = newChecked ? "开" : "关";
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
                        if (label) label.textContent = checked ? "开" : "关";
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
            if (label) label.textContent = this.defaults.useTitleGradient ? "开" : "关";
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
            if (label) label.textContent = useTitleGradient ? "开" : "关";
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
        display.textContent = "快捷键: " + parts.join("+");
    },

    showShortcutDialog() {
        const self = this;
        const originalShortcut = this.getShortcut();
        let pendingShortcut = null;
        const dialog = document.createElement("div");
        dialog.className = "xzg-dialog-overlay";
        dialog.innerHTML = `
            <div class="xzg-dialog">
                <div class="xzg-dialog-title">设置快捷键</div>
                <div class="xzg-dialog-body">
                    <p style="margin-bottom: 16px; color: #888; font-size: 12px; text-align: center;">请按下你想要的快捷键</p>
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
                        ">请按快捷键...</div>
                    </div>
                </div>
                <div class="xzg-dialog-footer">
                    <button class="xzg-btn xzg-btn-cancel" id="xzg-dialog-cancel" type="button">取消</button>
                    <button class="xzg-btn xzg-btn-ok" id="xzg-dialog-ok" type="button" disabled>确定</button>
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
            if (label) label.textContent = useTitleGradient ? "开" : "关";
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
