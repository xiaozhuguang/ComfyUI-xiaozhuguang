# ComfyUI-xiaozhuguang 代码质量审计报告

## 🔴 严重问题（阻塞/崩溃风险）

| # | 问题 | 文件 | 位置 |
|---|------|------|------|
| 1 | `nodes/xzg_universal_slider.py` 与 `__init__.py` 重复定义 `XiaozhuguangUniversalSlider`，双模块可能冲突 | `nodes/xzg_universal_slider.py` | 全文 |
| 2 | `XiaozhuguangPointsEditor.state` 类变量共享，多实例缓存串扰 | `__init__.py` | L43-46 |
| 3 | 根目录存在垃圾文件 `{` | `/` | - |
| 4 | `.playwright-cli/` 测试残留文件 | `/` | - |
| 5 | `comfyui-state.png` 截图残留 | `/` | - |

## 🔶 中等问题（稳定性/兼容性）

| # | 问题 | 文件 | 位置 |
|---|------|------|------|
| 6 | `xzg_slider.js` 引用 `XiaozhuguangSlider` 但后端未注册 | `xzg_slider.js` | L407 |
| 7 | `extension.json` 缺少 `xzg_slider.js`、`xzg_selector.js`、`xzg_boolean_selector.js`、`xzg_points_editor.js` 声明 | `extension.json` | - |
| 8 | `xzg_slider.js` 使用 `LGraphCanvas.prototype.getNodeMenuOptions` 覆盖（与收藏/选择器冲突风险） | `xzg_slider.js` | L446-460 |
| 9 | `BooleanSelector` 输出类型为 INT 但节点名为"布尔"，语义不一致 | `__init__.py` | L195 |
| 10 | `nodes/xzg_universal_slider.py` 重复定义 `AnyType` 和 `any_type` | `__init__.py` + `nodes/xzg_universal_slider.py` | - |

## 🔹 轻微问题（代码风格/可维护性）

| # | 问题 | 文件 |
|---|------|------|
| 11 | 中文变量名（`预览清晰度`、`标签`、`值`等） | `__init__.py` |
| 12 | 多余空行 | `__init__.py` L177-178, L248-249 |
| 13 | `XiaozhuguangTitle` 空节点无功能 | `__init__.py` |
| 14 | `xzg_group.css` 内容极简（几乎为空） | `xzg_group.css` |
| 15 | `xzg_theme.js` 主题样式通过 JS 注入而非独立 CSS | `xzg_theme.js` |
