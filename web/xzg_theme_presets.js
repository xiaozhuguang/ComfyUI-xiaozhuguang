
window.XZGThemePresets = {
    defaultTheme: {
        id: "default",
        name: "默认",
        colors: {
            titleBg: "linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)",
            titleText: "#ffffff",
            color1: "#667eea",
            color2: "#764ba2",
            color3: "#f093fb",
            direction: "135",
            useGradient: true
        }
    },

    getDefault() {
        return JSON.parse(JSON.stringify(this.defaultTheme));
    }
};
