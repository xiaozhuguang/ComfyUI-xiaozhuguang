# ComfyUI 小珠光插件

[![GitHub](https://img.shields.io/badge/GitHub-ComfyUI--xiaozhuguang-FFD700?style=flat-square)](https://github.com/xiaozhuguang/ComfyUI-xiaozhuguang)

## 🎬 视频教程

### 👉 [点击观看 B站详细使用教程](https://www.bilibili.com/video/BV13FT76QEBp/?share_source=copy_web&vd_source=250d70570d87e8baafae534d07d6066b)

[![B站视频教程](https://img.shields.io/badge/B站-视频教程-FF69B4?style=for-the-badge&logo=bilibili)](https://www.bilibili.com/video/BV13FT76QEBp/?share_source=copy_web&vd_source=250d70570d87e8baafae534d07d6066b)

---

ComfyUI 美化增强插件，提供节点收藏管理、工作流管理、主题美化、编组管理、快速节点等功能。

## ✨ 功能特性一览

| 模块 | 核心能力 |
|------|---------|
| ⭐ **节点收藏** | 右键收藏任意节点 / 多节点，拼音搜索、使用频率排序、最近使用、分类管理 |
| 📋 **工作流管理** | 多级嵌套文件夹、拖拽导入节点、拼音搜索、回收站、夺舍模式接管官方 UI |
| 🎨 **主题美化** | 多套预设色系、自定义渐变配色、实时预览、一键导出 / 导入配置 |
| ⚡ **快速节点** | 连线即出常用节点、搜索框快速添加、夺舍模式、配置导入导出 |
| 📐 **田字格对齐** | 6 种对齐 + 4 种分布、拖拽尺子等距分布、长按自动布局、可自定义间距 |
| 📦 **视觉编组** | 半透明框体、彩虹 / 呼吸 / 辉光动画、同级别反选、锁定、组内执行、自动收纳 |
| 🖼 **图像节点** | 图像加载器（拖入上传/多图模式）、图像保存（懒编码+化神级自定义输出）、图像对比、分割/合并、智能裁剪 ATBC、图像回贴 ATR、人脸对齐 Face Align、图像预览 |
| 🎬 **视频节点** | 视频加载器（1GB 分块上传 + 并发重试）、视频信息读取、帧提取、首尾帧、帧优化、合并视频 |
| 🔊 **音频节点** | 音频加载器（大小限制 + 解码律动进度条 + 拖入上传 + 播放头精准交互）、音频保存、AudioDiT 离线 TTS（音色克隆/零样本/多人对话） |
| 🤖 **大模型节点** | Qwen/Qwen-VL 模型加载与推理、MiniMax H3 提示词处理 |
| 🔧 **实用节点** | 选择器 / 布尔（+反向）/ 数据阻断（+比较大小）/ 标题 / 滑条 / 万能滑条 / 编号切换（惰性求值）/ 随机种子 / 获取控件值 / 输入惰性判断 / SAM 点编辑器 / **文本框（数字→中文）** |
| 🌐 **国际化** | 遵循 ComfyUI 官方 i18n 规范，中英文界面自动切换 |

> 💡 全部功能均可通过右键菜单、快捷键或面板一键调用，开箱即用、零外部依赖。

## 📚 参考与致谢

- 化神级视频编辑器（快剪/加载器）的 WebCodecs 解码、统一时钟多轨播放、MediaBunny 集成思路，**参考了 [OpenCut-app/OpenCut](https://github.com/OpenCut-app/OpenCut) 项目的实现**，在此向原作者表示感谢。

## 📑 目录

- [✨ 功能特性一览](#-功能特性一览)
- [📚 参考与致谢](#-参考与致谢)
- [🌐 国际化（i18n）](#-国际化i18n)
- [📦 节点](#-节点)
- [📝 小珠光文本框（数字转中文）](#-小珠光文本框数字转中文)
- [🔊 小珠光 AudioDiT 离线 TTS（音色克隆）](#-小珠光-audiodit-离线-tts音色克隆)
- [⭐ 节点收藏管理](#-节点收藏管理)
- [🎨 主题美化](#-主题美化)
- [⚡ 快速节点](#-快速节点)
- [📋 工作流管理](#-工作流管理)
- [📐 田字格对齐](#-田字格对齐)
- [📦 小珠光编组](#-小珠光编组)
- [⚙️ 安装](#️-安装)
- [📄 文件结构](#-文件结构)
- [📋 更新日志](#-更新日志)

---

## 🌐 国际化（i18n）

本插件遵循 ComfyUI 官方 i18n 规范（[PR #6558](https://github.com/Comfy-Org/ComfyUI/pull/6558)）：

- 所有节点名、输入/输出参数名、分类名均以**英文为源**（符合官方中英文规则），便于被 ComfyUI / Manager 正确索引与翻译。
- 翻译文件位于 `locales/` 目录下，按语言代码分目录：`locales/en/`（英文，与源一致）、`locales/zh/`（中文）。
- 每个语言目录包含 `nodeDefs.json`（节点显示名、输入/输出端口名）与 `main.json`（节点分类名）。
- 切换 ComfyUI 界面语言为中文后，节点标题与端口名将自动显示为对应中文；英文界面则显示英文。

## 📦 节点

| 节点名称 | 说明 |
|---------|------|
| **小珠光选择器** | 点击按钮选择标签，输出对应整数值 |
| **小珠光布尔 / 反向布尔** | 开关切换 True/False；反向布尔输入取反 |
| **小珠光数据阻断 / 比较大小-数据阻断** | 开关控制数据是否传输；按大于/等于/小于比较值决定数据通断 |
| **小珠光标题** | 标题装饰节点，无实际输出 |
| **小珠光滑条** | 通过滑块调整浮点数值 |
| **小珠光万能滑条** | 浮点/整数双模式切换，右键切换类型 |
| **小珠光编号切换** | 0–49 路输入选择器，在多种数据类型间切换；惰性求值：仅执行被选中编号的上游支路，其余支路不计算 |
| **小珠光随机种子** | 标准 seed 输入与随机化功能，防止重复拦截 |
| **小珠光点编辑器** | SAM 点坐标可视化编辑器 |
| **小珠光获取控件值** | 读取工作流中指定节点的控件当前值 |
| **小珠光文本框** | 双通道文本输出，默认将阿拉伯数字智能转换为中文（支持量词、单位、序数、分辨率乘积） |
| **🖼 图像处理节点** | |
| **小珠光图像加载器** | 支持拖入上传、多图/单图模式、拼音搜索、棋盘格透明背景显示；多图网格中心对齐，缩略图黑底无灰框 |
| **小珠光图像预览** | 图像预览节点 |
| **小珠光图像保存** | 保存图像，支持懒编码 + 右键保存真实分辨率 |
| **小珠光图像保存-化神级** | 自定义输出路径、文件夹选择器、JPEG/PNG/WebP 多格式 |
| **小珠光图像对比** | 两张图像并排对比查看 |
| **小珠光 IS (图像分割) / IM (图像合并)** | 将图像按行列分割；将分割图像合并回原图 |
| **小珠光 ATBC (智能裁剪)** | 按目标尺寸智能裁剪与补边 |
| **小珠光 ATR (图像回贴)** | 将处理后的子图按坐标回贴回原图 |
| **小珠光 Face Align (人脸对齐)** | 人脸关键点检测与对齐 |
| **🎬 视频处理节点** | |
| **小珠光视频加载器** | 分块上传支持最大 1GB、3 路并发 + 重试、自定义进度对话框 |
| **小珠光视频信息读取** | 读取视频分辨率、帧率、时长、总帧数等元信息 |
| **小珠光帧提取** | 按步长/间隔从视频抽取指定帧 |
| **小珠光首尾帧** | 提取视频的第一帧与最后一帧 |
| **小珠光帧优化** | 复制首帧填充到指定长度（去首帧闪烁） |
| **小珠光合并视频** | 将图像序列合成为视频（可搭配音频） |
| **🔊 音频处理节点** | |
| **小珠光音频加载器** | 上传大小限制、解码进度律动动画、拖入上传、双击上传、播放头精准交互 |
| **小珠光音频保存** | 保存音频到文件 |
| **🤖 大模型节点** | |
| **小珠光 MiniMax H3 提示词** | MiniMax H3 提示词处理节点 |
| **小珠光 Qwen Model Loader** | Qwen 系列模型加载器 |
| **小珠光qwenVL** | Qwen-VL 多模态指令跟随节点（依赖 transformers） |
| **小珠光 AudioDiT 零样本TTS** | 严格离线版 LongCat-AudioDiT 零样本合成（与原插件共享模型目录，永不触发 HF 下载） |
| **小珠光 AudioDiT 音色克隆TTS** | 严格离线版音色克隆：参考音频 3–15s + 转录文本 → 目标语音，最常用节点 |
| **小珠光 AudioDiT 多人对话TTS** | 严格离线版多说话人对话：2–10 个克隆音色 + [speaker_N]: 台词标签驱动逐段合成 |
| **🧪 实用杂项节点** | |
| **小珠光输入惰性判断** | 判断输入是否被真实连接到下游使用 |

---

## 📝 小珠光文本框（数字转中文）

### 双通道输出

- **text**：原始文本（原样输出，便于其他节点直接复用）
- **text_zh_num**：数字转中文后的文本（默认始终开启，可作为 AI 绘图提示词的中文描述）

### 四条转换规则

| 场景 | 输入示例 | 输出结果 |
|------|---------|---------|
| **① 乘积 / 分辨率**（按位读 + 乘以 连接） | `1280x720`<br>`1920×1080`<br>`1x2x3` | 一二八零乘以七二零<br>一九二零乘以一零八零<br>一乘以二乘以三 |
| **② 数字 + 量词/单位**（完整读数 + 英文缩写自动转中文） | `1个女孩`<br>`12岁`<br>`身高188cm`<br>`体重75kg`<br>`温度36.5℃`<br>`电压220V`<br>`12%` | 一个女孩<br>十二岁<br>身高一百八十八厘米<br>体重七十五千克<br>温度三十六点五摄氏度<br>电压二百二十伏<br>百分之十二 |
| **③ 第 / 其 前缀（序数）** | `第12章`<br>`第1名`<br>`第3次`<br>`第5届` | 第十二章<br>第一名<br>第三次<br>第五届 |
| **④ 其他（纯编号/代码/串号）**（按位读） | `型号1280`<br>`编号12和13` | 型号一二八零<br>编号一二和一三 |

> 💡 **规则说明**：只有当数字紧跟白名单内的量词/单位时，才会按「完整读数」读出；其他场景默认按位读，避免将编号读错。支持的乘号：`x` `X` `×` `*`（前后可带空格）。支持的英文缩写：`cm → 厘米`、`kg → 千克`、`km → 千米`、`mm → 毫米`、`L/mL → 升/毫升`、`V → 伏`、`A → 安`、`W → 瓦`、`℃/℉ → 摄氏度/华氏度` 等。

---

## 🔊 小珠光 AudioDiT 离线 TTS（音色克隆）

> 复用 **LongCat-AudioDiT** 原插件的建模库与推理流程，但 **100% 剥离「推理时自动从 HuggingFace 下载模型/tokenizer」** 的行为。
> 解决原插件痛点：**即便本地已经下载了模型，只要 HuggingFace 不通，tokenizer 检查那一步仍会卡住 / 失败**。

### 前置依赖（一次性准备）

| 依赖 | 说明 |
|------|------|
| `ComfyUI-LongCat-AudioDIT-TTS` 原插件 | 放在 `ComfyUI/custom_nodes/ComfyUI-LongCat-AudioDIT-TTS/`，本节点复用其 `audiodit` 建模库代码（不必卸载原插件，双方节点可共存） |
| LongCat-AudioDiT 模型目录 | 放在 `ComfyUI/models/audiodit/目录名/`，与原插件共享同一目录（**推荐先用原插件自动下载一次**，之后永远切到小珠光离线版用） |
| UMT5 tokenizer | 放在 `ComfyUI/models/audiodit/umt5-base-tokenizer/`，至少含 `tokenizer_config.json` + `spiece.model`（或 `tokenizer.json`） |
| comfy_api v3（可选） | 「多人对话 TTS」节点依赖 `comfy_api.latest.IO`（DynamicCombo），未安装则**仅跳过多人节点**，其它两个节点仍正常 |

### 三个节点（双语显示名）

| Python 类 | 显示名（中/英） | 输入 | 说明 |
|-----------|----------------|------|------|
| `XzgAudioDiTTTS` | 小珠光 AudioDiT 零样本TTS / Xiaozhuguang AudioDiT Zero-Shot TTS | text, steps, guidance, device, dtype, attention, seed, keep_model_loaded | 纯文本文字转语音，无参考音色 |
| `XzgAudioDiTVoiceCloneTTS` | 小珠光 AudioDiT 音色克隆TTS / Xiaozhuguang AudioDiT Voice Clone TTS | text + prompt_audio + prompt_text + steps/guidance/device/dtype/… | **最常用**：参考音频（3–15s）和对应转录文本 → 克隆音色朗读目标文本 |
| `XzgAudioDiTMultiSpeakerTTS` | 小珠光 AudioDiT 多人对话TTS / Xiaozhuguang AudioDiT Multi-Speaker TTS | num_speakers(2–10) + 对应 speaker_N_audio / ref_text + `[speaker_1]: 台词` 文本 | 逐轮克隆多音色合成；每轮后加 configurable 静音；ComfyUI v3 API 可用 |

### 为什么本地已有模型但原插件会卡住？

LongCat 原插件 `nodes/loader.py` 的三条联网路径：

| 原函数 | 行为 | 小珠光离线版怎么替换 |
|--------|------|--------------------|
| `get_model_names()` | 把 `LongCat-AudioDiT-1B (auto download)` 这种**本地不存在**的"虚项"也列到下拉菜单，迷惑用户 | `scan_local_models()` **只列真实存在于磁盘**的目录，空则给占位项带警告 |
| `resolve_model_path()` → `_auto_download_model()` | 本地没找到就 `snapshot_download`，网络不通直接卡 | `resolve_model_path_xzg()` 直接抛**清晰的 FileNotFoundError**，带本地目标路径 + HF 仓库 URL + 手动放置指引 |
| `_ensure_tokenizer_downloaded()` | umt5 缺失 → `snapshot_download` → 网络不通就炸 | `_find_local_tokenizer()` **4 级本地回退**：① models/audiodit/umt5-base-tokenizer ② 同层 umt5-base 目录 ③ `~/.cache/huggingface/hub/...` snapshot ④ 原插件内兜底 → 都没有才报错并给出下载指引 |
| `AudioDiTModel.from_pretrained(...)` | 没写 `local_files_only=True`，transformers 会联网补缺失文件 | 强制 `local_files_only=True`，且 `AutoTokenizer.from_pretrained(本地路径, local_files_only=True)` |

### 推荐的落地流程

```
① 安装原插件 ComfyUI-LongCat-AudioDIT-TTS
      ↓ 让它自动把 3.5B-bf16 模型和 tokenizer 下好
② 从 ComfyUI 节点菜单切换到 「小珠光_音频 / Xiaozhuguang_Audio」分类
      ↓ 使用三个离线节点：零样本 / 音色克隆 / 多人对话
③ 之后即便 HuggingFace 完全无法访问，节点依然正常工作
   （模型和 tokenizer 全走本地，完全不触网）
```

---

## ⭐ 节点收藏管理

在画布任意节点或空白处右键即可使用收藏功能。

### 基本操作

| 操作 | 方式 |
|------|------|
| **收藏节点** | 右键节点 → 选择「收藏节点」 |
| **收藏多节点** | 框选 2+ 节点 → 右键 → 选择「收藏多节点」 |
| **添加到画布** | 点击收藏面板中的节点名称 / 多节点项 |
| **取消收藏** | 右键收藏项 → 选择「取消收藏/删除工作流」 |

### 分类管理

- 默认创建「默认收藏」分类
- 支持**创建/编辑/删除**分类
- 节点/工作流可拖拽到分类上移入
- 通过右键菜单的「修改分类」移动

### 搜索

- 支持**实时搜索过滤**
- 支持**拼音搜索**（首字母 + 完整拼音）
  - 输入 `xzg` 可搜索到「小珠光选择器」「小珠光滑条」等
  - 输入 `xiaozhu` 同样匹配

### 排序

| 按钮 | 模式 | 排序规则 |
|------|------|---------|
| 🔥 | 使用频率 | 使用次数 → 上次使用时间 |
| ⏱️ | 最近使用 | 上次使用时间 |
| A | 名称 | 按名称字母 / 拼音顺序 |

### 重命名

- 右键收藏项 → 选择「重命名」，可自定义显示名称

### 快捷键

- 默认为 `Q` 键，可在面板设置中自定义
- 按快捷键可快速切换收藏面板显示

---

## 🎨 主题美化

提供丰富的节点主题预设与自定义配色功能。

### 主题预设

内置多套主题色系，一键切换节点配色。

### 自定义主题

- 支持自由调整节点颜色
- 主题面板实时预览

---

## ⚡ 快速节点

自定义快速节点功能，从节点拉出连线时可快速选择常用节点，提升工作流搭建效率。

### 添加/移除快速节点

| 操作 | 方式 |
|------|------|
| **添加到快速节点** | 右键节点 → 选择「☆ 添加到快速节点」 |
| **从快速节点移除** | 右键节点 → 选择「⭐ 从快速节点移除」 |

> 💡 快速节点菜单位于节点右键菜单「小珠光主题」上方。

### 使用快速节点

#### 方式一：连线菜单

从节点输出口拉出连线到空白处松开，菜单顶部会显示快速节点列表，点击即可创建并自动连线。

#### 方式二：搜索框

双击空白画布打开节点搜索框，搜索框顶部显示快速节点列表，点击即可添加到画布。

### 管理快速节点

按 `C` 键打开小珠光主题面板，切换到「快速节点」Tab：

| 功能 | 说明 |
|------|------|
| **拖拽排序** | 按住左侧拖拽手柄上下拖动调整顺序 |
| **移除节点** | 点击右侧「移除」按钮 |
| **清空全部** | 一键清空所有快速节点 |
| **导出配置** | 将快速节点配置导出为 JSON 文件备份 |
| **导入配置** | 从 JSON 文件导入快速节点配置 |

### 夺舍模式

在快速节点管理面板中可开启「夺舍模式」，开启后从节点拉出连线时将只显示自定义快速节点，不显示系统默认菜单。

### 其他说明

- 最多支持 **20 个** 快速节点
- 配置自动保存到浏览器本地存储
- 按添加顺序显示，可通过拖拽调整顺序

---

## 📋 工作流管理

完整的工作流管理系统，支持分类存储、搜索、拖拽导入等功能。

### 打开面板

- **快捷键**：默认 `` ` ``（反引号），可点顶部「快捷键」按钮自定义

### 工作流操作

- **打开**：单击工作流项，加载到当前画布并激活对应官方工作流（已打开的仅切换、不重复加载）
- **导入到画布**：直接拖拽工作流项到画布空白处，节点即被导入当前工作流，点击工作流，则为新建标签打开工作流，跟官方完全一致。
- **定位分类**：单击工作流项左侧的四个圆点图标，左侧分类树会自动展开并高亮其所属分类
- **右键菜单**：
  - ✏️ 重命名：修改显示名称，保留你手工加的编号前缀
  - 🗑️ 删除：移入回收站，可恢复
  - 📁 移动到分类：在子菜单中选择目标文件夹或「未分类」

### 分类管理（左侧）

- **全部 / 根目录未分类**：分别显示所有、及未归入文件夹的工作流
- **新建分类**：右键「全部」→ 新建分类；右键文件夹可新建子分类（支持多级嵌套），改动会直接应用到本地文件夹
- **重命名 / 删除分类**：右键文件夹操作；删除分类会将其下工作流一并移入回收站
- **筛选**：单击分类项，右侧只显示该分类的工作流


### 搜索

- 顶部搜索框实时过滤；支持拼音（首字母 + 完整拼音）
- 例如输入 `txlj` 匹配「图像连接」；`tuxiang` 同样匹配
- 搜索自动忽略空格

### 排序

- 🔥 **使用频率**：使用次数
- **A 名称**：按名称字母 / 拼音顺序
- 拖拽工作流到画布不增加使用频率，仅单击打开会计数

### 回收站

- 误删的工作流会进入回收站，可在此恢复
- 回收站保留 3 个月，过期自动清理（不可手动清空）

### 其它设置

- **主题设置**：自定义面板强调色
- **夺舍模式**：开启后隐藏 ComfyUI 官方工作流管理按钮，由本面板接管
- **保存工作流**：使用 ComfyUI 官方保存（`Ctrl+S` / 顶栏），保存后本面板会自动同步显示

### 快捷键

- 默认为 `` ` `` 键，可在面板设置中自定义
- 按快捷键可快速切换工作流面板显示

---

## 📐 田字格对齐

可视化节点对齐工具，通过田字格面板快速对齐和分布多个节点，支持拖拽尺子等距分布和长按自动布局。

### 打开面板

- **快捷键**：默认 `Alt + A`，可在面板设置中自定义
- **条件**：需选中 **≥ 2 个** 节点

### 6 种线对齐

点击田字格中的对应线条即可对齐：

| 线条 | 功能 | 说明 |
|------|------|------|
| │ 左侧竖线 | **左对齐** | 所有节点左边对齐到最上方节点的左边缘 |
| │ 中间竖线 | **水平居中** | 所有节点水平中心对齐到最上方节点的中心 |
| │ 右侧竖线 | **右对齐** | 所有节点右边对齐到最上方节点的右边缘 |
| ─ 上方横线 | **上对齐** | 所有节点顶边对齐到最左侧节点的上边缘 |
| ─ 中间横线 | **垂直居中** | 所有节点垂直中心对齐到最左侧节点的中心 |
| ─ 下方横线 | **下对齐** | 所有节点底边对齐到最左侧节点的下边缘 |

### 4 种区域分布

点击田字格中的四个区域即可分布：

| 区域 | 功能 | 说明 |
|------|------|------|
| ◱ 左上区域 | **左对齐 + 垂直等距分布** | 左对齐的同时垂直方向均匀分布 |
| ◰ 右上区域 | **右对齐 + 垂直等距分布** | 右对齐的同时垂直方向均匀分布 |
| ◳ 左下区域 | **上对齐 + 水平等距分布** | 上对齐的同时水平方向均匀分布 |
| ◲ 右下区域 | **下对齐 + 水平等距分布** | 下对齐的同时水平方向均匀分布 |

### 拖拽尺子等距分布

按住中心点并向四个方向拖拽，出现尺子后根据拖拽距离进行等距分布：

- **拖拽方向**：上下左右四个方向（自动吸附）
- **触发阈值**：拖拽距离 ≥ 60px 时执行
- **尺子刻度**：以中心为 0 点向两侧对称分布，偶数刻度贯穿、奇数刻度仅左侧
- **视觉反馈**：未达阈值时半透明主题色 + 弱发光；达到阈值时金色不透明 + 强发光 + 深色填充

### 长按自动布局

按住中心点 **1.5 秒** 触发自动布局：

- 基于节点连接关系拓扑排序分层排列
- 以最上层最左上方节点为锚点保持位置不动
- 锚点左侧层向左延伸、右侧层向右延伸
- 确保节点无重叠
- **防误操作**：右键点击或按 Escape 可取消长按；拖动距离 ≥ 5px 自动取消长按进入拖拽模式
- **成功反馈**：线宽变粗 + 淡出效果

### 其他设置

| 设置项 | 说明 |
|--------|------|
| **水平间距** | 水平分布时的节点间距（默认 100px） |
| **垂直间距** | 垂直分布时的节点间距（默认 50px） |
| **主题色** | 自定义田字格面板主题色 |
| **快捷键** | 自定义打开面板的快捷键 |

---

## 📦 小珠光编组

视觉化节点编组工具，通过半透明框体将节点组织在一起，支持颜色、动画、绕过等多种功能。

### 创建编组

| 方式 | 操作 |
|------|------|
| **快捷键** | 框选节点后按 `Ctrl + G`（默认，可在设置中修改） |
| **右键菜单** | 框选节点后右键空白画布 → 选择「📦 小珠光编组」 |

### 编组基本操作

| 操作 | 方式 |
|------|------|
| **创建编组** | 选中节点后按 `Ctrl + G` |
| **移动编组** | 按住标题栏拖拽（框内节点跟随移动） |
| **调整大小** | 拖拽右下角 `↘` 手柄 |
| **删除编组** | 点击标题栏右侧的 `×` 按钮 |
| **切换绕过** | 左键单击标题栏中间区域（框内节点被绕过/恢复） |
| **Ctrl+点击框体** | 按住 Ctrl 左键点击框体任意位置，快速切换绕过 |
| **打开设置** | **右键**标题栏任意位置 |
| **滚轮缩放** | 在标题栏滚动滚轮缩放画布 |
| **编组嵌套** | 编组框可以包含其他更小的编组框，支持多层嵌套 |

### 同级别反选模式

通过点击标题栏不同区域，快速切换同级编组的绕过状态：

| 操作 | 效果 |
|------|------|
| **点击标题栏左侧 1/5** | 被点击的编组**开启**，同一级别的其他编组全部**绕过** |
| **点击标题栏右侧 1/5** | 被点击的编组**绕过**，同一级别的其他编组全部**开启** |
| **点击标题栏中间 3/5** | 单独切换当前编组的绕过/开启状态 |

> 💡 **同级别**指拥有相同父编组（或都在根层级）的编组。大编组内的小组与最外层编组不属于同一级别。

### 锁定/解锁编组

| 操作 | 方式 |
|------|------|
| **锁定/解锁单个编组** | 点击标题栏 🔒 锁图标（锁定后无法拖动和调整大小） |
| **一键锁定/解锁所有编组** | 按住 `Ctrl` + 鼠标左键点击任意锁图标 |

锁定后编组框的标题栏锁图标变为红色，禁止拖拽移动和调整大小。

### 执行框内节点

| 操作 | 方式 |
|------|------|
| **执行当前编组** | 鼠标位于编组框内时按 `F` 键 |

按下 `F` 键后，只会执行当前编组（及其子编组）内的输出节点及其上游依赖，不会运行整个工作流。

> 💡 如果安装了 rgthree 插件，会优先调用 rgthree 的排队功能；否则使用内置实现。

### 设置面板

右键标题栏打开设置面板，默认显示在画布右侧，标题栏可拖拽移动。

#### 标题栏设置

| 设置项 | 说明 |
|--------|------|
| **名称** | 自定义编组显示名称，修改后实时显示 |
| **文字大小** | 调整标题文字大小（6–48px），默认 14px |
| **文字颜色** | 点击右侧颜色块可自定义标题文字颜色 |
| **背景色** | 点击七彩渐变条可自定义标题栏背景色 |
| **透明度** | 调整标题栏背景透明度（0–100%） |

#### 边框设置

| 设置项 | 说明 |
|--------|------|
| **边框颜色** | 点击七彩渐变条可自定义边框颜色 |
| **边框粗细** | 调整边框宽度（1–10px），默认 2px |
| **边框透明度** | 调整边框透明度（5–100%） |
| **边框动画** | 选择边框动画效果 |
| **动画速度** | 调整动画速度（1–10） |

#### 边框动画效果

| 效果 | 说明 |
|------|------|
| **无** | 静态边框 |
| **渐变彩虹** 🌈 | 边框色相随时间循环变化 |
| **明暗呼吸** 💨 | 边框亮度按正弦波呼吸变化（使用当前颜色） |
| **辉光** ✨ | 发光效果，亮度脉动变化（使用当前颜色） |
| **流光溢彩** 🎆 | 多色锥形渐变边框旋转流动 |
| **流光溢彩+明暗呼吸** | 流光溢彩 + 亮度呼吸叠加效果 |

#### 渐隐渐入

| 设置 | 说明 |
|------|------|
| **开关** | 开启后画布移动时编组框渐隐，停止后渐入 |
| **渐入时间** | 调整渐入动画时长（1–10秒） |

#### 快捷键设置

- 可自定义新建编组的快捷键（`Ctrl + ?`）
- 支持 a–z 任意字母
- 设置后自动保存

#### 其他功能

| 按钮 | 说明 |
|------|------|
| **使用说明** | 打开编组功能使用说明 |
| **应用到全部** | 一键将当前颜色、动画等设置应用到所有编组 |
| **取消** | 放弃本次修改 |
| **应用** | 保存并应用设置 |

### 自动节点收纳

编组框体会自动检测内部节点：
- 将移入框体内的节点自动加入编组
- 将移出框体的节点自动释放
- 保证编组与实际框选范围一致

### 持久化

编组信息（位置、大小、颜色、动画、绕过状态等）会随工作流自动保存和恢复，保存/加载工作流时无需额外操作。

### 样式更新

- 非动画状态：`2px solid hsla(H,S%,L%,0.65)` 半透明边框
- 绕过状态：紫色边框 `hsla(280,60%,55%,0.55)`
- 标题栏、删除按钮、大小手柄颜色随当前色同步变化

---

## ⚙️ 安装

### 方法一：Git 克隆

```bash
cd ComfyUI/custom_nodes/
git clone https://github.com/xiaozhuguang/ComfyUI-xiaozhuguang.git
```

### 方法二：手动下载

1. 下载 [ComfyUI-xiaozhuguang](https://github.com/xiaozhuguang/ComfyUI-xiaozhuguang) ZIP 包
2. 解压到 `ComfyUI/custom_nodes/` 目录
3. 重启 ComfyUI

---

## 📄 文件结构

```
ComfyUI-xiaozhuguang/
├── __init__.py                  # 节点定义 + NODE_CLASS/DISPLAY_NAME_MAPPINGS + 懒编码/目录浏览等路由
├── extension.json               # 扩展配置（版本 12.0.0 + JS/CSS 资源清单）
├── pyproject.toml                # Comfy Registry 发布元数据
├── LICENSE                      # MIT 许可证
├── README.md                    # 本文档
├── requirements.txt             # 依赖声明
├── workflows.py                 # 工作流管理后端 API
├── .gitignore                   # Git 忽略规则
├── .comfyignore                 # Comfy Registry 忽略规则
├── .github/workflows/
│   └── publish_action.yml       # 推送 tag → 自动创建 Release + 发布到 Comfy Registry
├── docs/
│   ├── code-audit-report.md     # 代码审计报告
│   └── skill-panel-alignment.txt # 设置面板弹出对齐 Skill 文档
├── locales/                     # 官方 i18n 规范翻译文件
│   ├── en/ (nodeDefs.json, main.json)
│   └── zh/ (nodeDefs.json, main.json)
├── example_workflows/
│   └── example_workflows.json
├── _xzg_audiodit/               # AudioDiT 严格离线建模库（本地扫描，完全不触网）
│   ├── __init__.py
│   ├── configuration_audiodit.py
│   ├── fp8_linear.py
│   ├── modeling_audiodit.py
│   └── utils.py
├── nodes/
│   ├── xzg_seed.py              # 小珠光随机种子节点
│   ├── xzg_get_widget.py        # 获取控件值节点
│   ├── xzg_first_last_frame.py  # 首尾帧节点
│   ├── xzg_duplicate_first_frame.py # 帧优化节点（复制首帧填充）
│   ├── xzg_frame_extract.py     # 帧提取节点
│   ├── xzg_image_loader.py      # 图像加载器后端
│   ├── xzg_image_preview.py     # 图像预览节点
│   ├── xzg_image_save.py        # 图像保存（懒编码 + 右键真实分辨率）
│   ├── xzg_image_save_custom.py # 图像保存-化神级（自定义输出路径/格式）
│   ├── xzg_image_compare.py     # 图像对比节点
│   ├── xzg_image_split_merge.py # 图像分割 / 合并节点
│   ├── xzg_atbc.py              # ATBC 智能裁剪
│   ├── xzg_atr.py               # ATR 图像回贴
│   ├── xzg_face_align.py        # Face Align 人脸对齐
│   ├── xzg_video_loader.py      # 视频加载器后端（1GB 分块上传端点）
│   ├── xzg_video_info_reader.py # 视频信息读取节点
│   ├── xzg_video_combine.py     # 合并视频节点
│   ├── xzg_audio_loader.py      # 音频加载器后端（上传大小限制 + 解码进度端点）
│   ├── xzg_audio_save.py        # 音频保存节点
│   ├── xzg_lazy_check.py        # 输入惰性判断节点
│   ├── xzg_text_box.py          # 文本框节点（数字转中文）
│   ├── xzg_universal_slider.py  # 万能滑条节点
│   ├── xzg_h3_prompt.py         # MiniMax H3 提示词节点
│   ├── xzg_qwen_loader.py       # Qwen Model Loader
│   ├── xzg_qwen3_vl_instruct.py # qwenVL 多模态节点
│   ├── xzg_longcat_loader.py    # AudioDiT 严格离线模型加载器
│   ├── xzg_longcat_model_cache.py # AudioDiT 模型缓存
│   ├── xzg_audiodit_tts.py      # AudioDiT 离线 TTS 三节点（零样本/音色克隆/多人对话）
│   └── xzg_points_editor.py / xzg_selector.js 关联等
└── web/
    ├── xzg_seed.js              # 随机种子节点前端
    ├── xzg_image_loader.js      # 图像加载器前端（多图/单图/棋盘格/拖拽）
    ├── xzg_image_preview.js     # 图像预览前端
    ├── xzg_image_save.js        # 图像保存前端（懒编码/右键保存）
    ├── xzg_video_loader.js      # 视频加载器前端（分块上传/自定义进度对话框）
    ├── xzg_video_player.js      # 视频播放器前端
    ├── xzg_video_combine.js     # 合并视频前端
    ├── xzg_audio_loader.js      # 音频加载器前端（解码律动进度条/拖入上传/播放头交互）
    ├── xzg_audio_save.js        # 音频保存前端
    ├── xzg_image_compare.js     # 图像对比前端
    ├── node_favorites.js        # 收藏管理核心逻辑
    ├── node_favorites.css       # 收藏面板样式
    ├── pinyin-pro.esm.js        # 拼音搜索库
    ├── xzg_boolean_selector.js  # 布尔选择器前端
    ├── xzg_group.js             # 编组功能
    ├── xzg_group.css            # 编组样式
    ├── xzg_number_switch.js     # 编号切换节点前端
    ├── xzg_points_editor.js     # 点编辑器前端
    ├── xzg_selector.js          # 选择器前端
    ├── xzg_slider.js            # 滑条前端
    ├── xzg_theme.js             # 主题核心
    ├── xzg_theme_presets.js     # 主题预设
    ├── xzg_theme_panel.js       # 主题面板
    ├── xzg_theme.css            # 主题样式
    ├── xzg_quick_nodes.js       # 快速节点功能
    ├── xzg_universal_slider.js  # 万能滑条前端
    ├── xzg_workflows.js         # 工作流管理前端
    ├── xzg_align.js             # 田字格对齐功能
    ├── xzg_get_widget.js        # 获取控件值前端
    ├── xzg_i18n.js              # 国际化辅助
    ├── xzg_menu_hide.js         # 菜单隐藏（夺舍模式辅助）
    ├── xzg_arrow_tool.js        # 箭头绘制工具
    ├── xzg_save_utils.js        # 保存通用工具
    ├── xzg_h3_prompt.js         # MiniMax H3 前端
    ├── xzg_text_box.js          # 文本框前端（数字转中文）
    └── xzg_qwen.js              # Qwen/qwenVL 前端
```

---

## 📋 更新日志

### V13.0.1 (2026-08-28)

**🖼️ 图像对比节点 Bug 修复**（`nodes/xzg_image_compare.py`、`web/xzg_image_compare.js`）

- **RGBA 输入兼容**：后端 JPG 保存前丢弃 alpha 通道，避免 4 通道（RGBA）保存为 JPG 时透明区域合成到黑色背景，出现「半张黑图」
- **大图异步加载刷新**：前端所有 `new Image()` 路径（首图 / 点击切换 A / 点击切换 B）均添加 `onload → setDirtyCanvas(true, true)`，防止 6400px 级大图/慢加载时 naturalWidth 仍为 0 跳过绘制，导致图片迟迟不显示/显示不全，必须晃动鼠标才刷新
- **鼠标越界裁剪修复**：`sourceWidth/destWidth` 裁剪偏移用 `clamp(cropOffset, 0, targetW)` 限制，鼠标进入右侧留白区时不再 `cropOffset > targetW` → B 图横向拉伸变形

**🏷️ 版本号 / 发布**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `13.0.0` 升至 `13.0.1`
- Release / Registry：由 `.github/workflows/publish_action.yml` 在推送 `v13.0.1` tag 时自动创建 GitHub Release + 发布到 Comfy Registry（版本 13.0.1）
### V13.0.0 (2026-08-28)

**🔤 小珠光文本框：中文朗读输出（`text_zh_num`，`text` 原文不变）优化**

- **`淼` → `邈`**（`nodes/xzg_text_box.py`）：避免 LongCat AudioDiT 等 TTS 读错
- **通用去除间隔号 `・`**：`达・芬奇`→`达芬奇`、`张・芬奇`→`张芬奇` 等
- **空格策略**：保留数字之间的空格（避免拆散数字），删除文字之间/数字与文字之间的空格（`你好 世界`→`你好世界`）
- **`*` 只在非乘法位置删除**：`1920*1080` 仍读「一九二零乘以一零八零」，单独出现的 `*` 删除

**🎵 音频加载器：时间码增加「时长」显示**

- （`web/xzg_audio_loader.js`）时间码右侧新增 `时长XX:XX`，若被红/蓝裁剪则显示裁剪后的时长，否则为总时长

**🎬 视频播放器 / 解码器：修复首帧黑屏**

- （`web/xzg_frame_decoder.js`）取帧带时间容错：`time=0` 边界处部分视频首帧 PTS 非 0 取不到帧（首帧黑屏、播放一次后才正常），改为逐级小偏移重试，且复用 mediabunny「二次确认」路径
- 新增 `renderFrameAwait`：真正等待首帧解码绘制完成后再显示，替代原先只调度不等待的 `renderFrame`
- （`web/xzg_video_player.js`）对齐 VHS：使用原生 `<video>` 的节点加载时不弹转圈动画，加载期间保留上一帧画面，消除「读条」观感

**🎞️ 视频加载器**

- **跳过帧数 / 帧数上限 支持上游连线输入**（`web/xzg_video_loader.js`）：拖拽红/蓝杠或参数变化时写回上游控件（PrimitiveNode / 同名 widget）并触发其回调，红蓝头联动正确；`_resolveLinkedValue` 优先读取连线值（widget 转 input 后自身 value 不更新）
- 修复「合成覆盖预览只盖一瞬间又变回默认比例」：`onLoadedMetadata` 只应用加载范围（`_applyLoadRange`），不再触发 `_resetToSourceVideo` 把刚盖上的预览重置回原视频；参数真正变化时才由 `_syncLoadRange` 重置
- 预览 widget 设为 `serialize=false`：文件名仅作显示产物，不独立持久化/进入缓存，避免与「视频」下拉框值发散

**🎬 合并视频**

- **预览跨浏览器刷新持久化**（`web/xzg_video_combine.js`）：输出信息写入 localStorage（key = 节点 id），刷新后仍能恢复上次预览（对齐 VHS 刷新后仍有输出）；不再写入 `node.properties`，避免并入图/extra_pnginfo 改变缓存签名导致每次重编码
- 预览 widget 设为 `serialize=false`（对齐官方 audioUI 范式）：文件名每次执行都变化，一旦进入 widgets_values/extra_pnginfo 就会改变节点缓存签名 →「上游输入未变时仍被判定为变化 → 每次都重编码合成」
- URL 去掉随机数 + 输出 key（filename|type|subfolder）去重：同名文件（输入未变）不再重复下载/转圈读条；输入真变了文件名变 → 正常刷新预览

**🗑️ 移除「视频加载器 Pro」节点**

- 删除 `nodes/xzg_video_loader_pro.py`、`web/xzg_video_loader_pro.js`（含其前端注册引用），功能以普通视频加载器为准

**🏷️ 版本号 / 发布**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.22.0` 升至 `13.0.0`
- Release / Registry：由 `.github/workflows/publish_action.yml` 在推送 `v13.0.0` tag 时自动创建 GitHub Release + 发布到 Comfy Registry（版本 13.0.0）
### V12.22.0 (2026-08-27)

**🐛 修复：获取控件值节点与「输出到队列」兼容性**

- **`获取控件值` 节点默认值兜底**（`nodes/xzg_get_widget.py`）：
  - 首次执行时，目标节点某个输入（如 WanAnimatePlus LoraSelectMulti 的 `model`）因上游不在「获取控件值」节点可达链，被 ComfyUI 的 prompt 剪枝从 dynprompt inputs 中移除，导致误报「找不到控件」。
  - 新增 `_lookup_default_input()`：从目标节点 `INPUT_TYPES` 定义读取该控件的默认值兜底输出，重跑后目标节点补全即读到真实值，避免首次执行误报。
- **`获取控件值` 节点宽度溢出修复**（`web/xzg_get_widget.js`）：
  - 把 DOM select 宿主的 `widget.width` 定义为只读访问器（返回节点实际宽度），忽略属性面板写入的 368px，防止联动下拉/列表超出节点边界（与视频/音频加载器修复一致）。
- **「输出到队列」不再委托 `rgthree.queueOutputNodes`**（`web/node_favorites.js`、`web/xzg_group.js`）：
  - 该函数内部 `recursiveAddNodes` 在「输出节点不在默认执行链 prompt.output 里」时无空节点保护，会抛 `Cannot read properties of undefined (reading 'inputs')` 并触发 ComfyUI 全局「执行失败」弹窗（晨羽智云等装有 rgthree 的平台必现）。
  - 统一改走自有 hook（自带 `currentNode` 空保护），保证在 rgthree 环境稳定执行。

**🏷️ 版本号 / 发布**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.21.0` 升至 `12.22.0`
- Release / Registry：由 `.github/workflows/publish_action.yml` 在推送 `v12.22.0` tag 时自动创建 GitHub Release + 发布到 Comfy Registry（版本 12.22.0）
### V12.21.0 (2026-08-27)

**🎨 UI 优化：节点收藏器与工作流管理器初始布局尺寸调整**

- **节点收藏器面板**（首次安装无保存宽度时）：
  - 面板总宽 `460px` → `660px`，给左右两列更充裕的展示空间
  - 左列分类栏固定初始宽度 `300px`（配合 `width:660px - min-width:350px` 的右列，实现左定宽右弹性）
  - 右列收藏列表新增 `min-width: 350px`，避免被过度压缩
  - 两列之间的分割 `gap: 10px` → `0`，配合分割栏紧凑布局
- **工作流管理器左栏**（首次安装无保存宽度时）：
  - 分类栏初始宽度 `80px` → `160px`，更贴近日常使用需求（中文分类名不再挤成一列）
  - 拖拽调节范围仍保持 `[80, 500]px`，已有保存宽度的用户不受影响

**🏷️ 版本号 / 发布**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.20.0` 升至 `12.21.0`
- Release / Registry：由 `.github/workflows/publish_action.yml` 在推送 `v12.21.0` tag 时自动创建 GitHub Release + 发布到 Comfy Registry（版本 12.21.0）
### V12.20.0 (2026-08-27)

**☁️ 面板几何（位置/尺寸）纳入云持久化**

延续上版云存储：节点收藏器面板的位置/尺寸/分割宽度、工作流管理器左侧栏宽度，之前只写各自 localStorage 键，云平台刷新/换分配即丢。本次把它们也并入服务端持久化。

- `web/xzg_cloud_store.js` 新增面板几何 UI 态模块：
  - `cloudUIInit()`：拉取云端 `xzg_ui_state`（面板几何合集），写回对应 localStorage 键（云优先）；云端为空时把本地几何首次上云
  - `cloudUIQueueGeometry()`：任一几何键写完后收集全部几何，防抖 400ms 推送到云端
- 节点收藏器：`createPanel` 同步云端后读取几何；宽/高/分割宽/位置四处写点均触发 `cloudUIQueueGeometry()`
- 工作流管理器：左侧栏宽度读取改为云优先回放，写入同步推云
- 主题面板导出/导入：导入除写本地外，一并把面板几何推送云端，避免刷新后旧云端几何覆盖刚导入的几何

### V12.19.0 (2026-08-27)

**☁️ 云平台持久化：收藏节点与工作流元数据从浏览器 localStorage 改为服务端存储**

云平台（晨羽智云等）浏览器 localStorage 无法跨会话持久化（刷新/换设备即丢）。本次为「小珠光节点收藏器」和「小珠光工作流管理器」增加服务端持久化：

- 新增后端 API `GET/POST /xzg_cloud_store`，数据以 JSON 写入 ComfyUI 用户目录 `user/xiaozhuguang/` 磁盘，含路径穿越防护与安全装饰器
- 新增前端通用云存储模块 `web/xzg_cloud_store.js`（`cloudLoad`/`cloudSave`）：读取优先「服务端 → 本地 localStorage → 默认值」；服务端无数据时自动把本地推上去实现首次上云；服务端不可用时静默回落本地兜底
- 收藏数据（`comfyui_xiaozhuguang`）、工作流元数据（`xzg_workflows_meta`）统一改为云优先读写，防抖 600ms 落云，本地仍保留一份兜底
- 主题面板「导出/导入」适配云存储：导出优先取运行实例内存的最新数据，导入除写本地外还会推送到云端并同步刷新收藏器/工作流面板，避免刷新后被旧云端数据覆盖

**🔧 修复：右上角功能区「快剪」设置项不显示**

- `xzg_video_editor_launcher.js` 修正设置项 ID 前缀（`Xiaozhuguang.` → `xiaozhuguang.`），与其余小珠光设置同组显示
- `registerSetting` 增加 `addSetting` 未就绪时的延迟重试与去重标记，避免注册失败后永久缺失

**🏷️ 版本号 / 发布**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.18.0` 升至 `12.19.0`
- Release / Registry：由 `.github/workflows/publish_action.yml` 在推送 `v12.19.0` tag 时自动创建 GitHub Release + 发布到 Comfy Registry（版本 12.19.0）

### V12.18.0 (2026-08-27)

**📦 依赖修复：补全 requirements.txt（git 安装缺 Qwen 依赖）**

- `requirements.txt` 曾被精简为仅 `imageio-ffmpeg>=0.5.1`，导致通过 **git clone 安装**（如晨羽智云）时，ComfyUI Manager 按 `requirements.txt` 安装依赖而漏装 Qwen 相关包（`transformers>=4.57.1`、`qwen-vl-utils`、`llama-cpp-python`、`bitsandbytes` 等），QwenLoader / qwenVL 节点报"未安装 / 依赖缺失"
- 本次补全 `requirements.txt` 必需依赖清单，与 `pyproject.toml` 的 `dependencies` 对齐，并保留可选依赖说明注释；git 安装用户执行 `pip install -r requirements.txt` 即可装上
- Comfy Registry 安装不受影响（一直读取 `pyproject.toml` 的完整依赖）

**🏷️ 版本号 / 发布**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.17.0` 升至 `12.18.0`
- Release / Registry：由 `.github/workflows/publish_action.yml` 在推送 `v12.18.0` tag 时自动创建 GitHub Release + 发布到 Comfy Registry（版本 12.18.0）

### V12.17.0 (2026-08-27)

**🔧 修复：夺舍模式误隐藏小珠光工作流按钮（前端 1.51.9 兼容）**

前端更新至 1.51.9 后，侧边栏按钮标识由 class 变为 `data-testid`，导致夺舍模式把小珠光自己的工作流按钮误判为官方按钮而隐藏。本次统一补全两套选择器（class 与 data-testid）：

- 新增 `_xzgTabBtnSel` / `_officialWfBtnSel` 选择器辅助方法，兼容新旧前端按钮定位
- `_findOfficialWorkflowButtons` 补全 `data-testid` 兼容：`isXzg` 用 `closest()` 检查祖先链，官方按钮识别同时支持 class 与 `data-testid="workflows-tab-button"`
- `_setOfficialWorkflowButtonsHidden` 增加兜底：夺舍模式下强制恢复小珠光按钮显示
- 完全向后兼容低版本前端：低版本仍走 class 分支，行为不变

**🏷️ 版本号 / 发布**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.16.0` 升至 `12.17.0`
- Release / Registry：由 `.github/workflows/publish_action.yml` 在推送 `v12.17.0` tag 时自动创建 GitHub Release + 发布到 Comfy Registry（版本 12.17.0）

### V12.16.0 (2026-08-27)

**🔧 统一修复：属性面板开关导致节点元素溢出（widget.width 污染）**

为所有自定义 canvas/DOM widget 统一添加 `width` 只读访问器，始终跟随节点实际宽度 `node.size[0]`，忽略 ComfyUI（属性面板/线性模式渲染等）写入的面板侧行宽度（例 368px）。当开关右上角"属性面板"时，各行绘制/交互命中区/DOM 预览区宽度稳定，不再超出节点边界、不再随面板开/关拉伸或跳动。覆盖节点如下：

- **视频类**：小珠光视频加载器（预览 + 6 行：强制帧率/视频比例/自定义高度/自定义宽度/跳过帧数/帧数上限）、小珠光视频加载 Pro（编辑器按钮 + 视频下拉）、小珠光视频保存（预览 + 所有行：图像/帧率/文件名前缀/格式/CRF/模式/音频）
- **音频类**：小珠光音频加载器（波形 + 音频/上传/播放控制/循环/双声道）、小珠光音频保存（波形 + 格式/模式/质量/文件名前缀/音量）
- **图像类**：小珠光图像加载器（图片预览 + 按钮栏）、小珠光图像保存 / 小珠光图像保存-化神级（画布预览 + 控件行）
- **控件类**：小珠光万能滑条（自定义滑条 canvas 绘制与命中）、小珠光选择器（整节点 canvas 绘制与命中）、小珠光布尔（整节点 canvas 绘制与命中）、小珠光点编辑器（整 canvas DOM 预览区 + 工具栏/底部帧滑条）

**🏷️ 版本号 / 发布**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.15.0` 升至 `12.16.0`
- Release / Registry：由 `.github/workflows/publish_action.yml` 在推送 `v12.16.0` tag 时自动创建 GitHub Release + 发布到 Comfy Registry（版本 12.16.0）

### V12.15.0 (2026-08-26)

**✨ 新增节点**

- **小珠光从列表获取图像（`XiaozhuguangImageFromList`）**：从 IMAGE 输入（列表/已堆叠 batch/单张）中自 `index` 起连续取 `length` 张图。`index` 支持负数（-1 取最后一张），越界自动钳制；`length` 为连续取图数量（如列表 4 张、index=1、length=3，取第 2/3/4 张；length=1 等价单取）；多张时返回列表并广播，下游逐张执行。与图像加载器「列表」模式一致，支持图片尺寸不一致、可分别预览
- **小珠光列表计数（`XiaozhuguangListCount`）**：计算输入列表的元素总数，常用于小珠光图像加载器「列表」模式等多元素输出；单个批处理张量按 batch 维统计，保证"总数=图片张数"的直觉

**🖼️ 小珠光图像加载器增强**

- **加载图片上限**：多图（追加）模式新增上限输入框，`∞`/空/`0` 表示无限制，大于 0 时最多加载/显示前 N 张（批次/列表模式均生效）；预览网格自适应按该上限数量排布（前端改动刷新页面即生效）
- **批次对齐新增「留边」模式**：批次内目标尺寸以第一张的宽高比为基准、取各图最长边最大值作为基准长边；「裁剪」（默认）等比放大铺满后居中裁剪超出的长边，「留边」改为等比放入并用黑色边填补齐。统一批次内不同尺寸图，避免拼接对齐不一致
- **遮罩 base64 容错**：修复工作流 JSON 保存/载入/复制往返可能丢失 `=` 填充或混入空白引号导致 `Incorrect padding` 的问题；无效脏数据（过滤后为空或解码过短，不足 PNG 签名）静默返回零遮罩、不再打印告警，仅在解码出足量数据但 PIL 仍无法识别时才告警

**🔧 修复 / 改进**

- **视频编辑器右键菜单全局监听泄漏**：`_initCtxMenu` 挂到 document/window 的捕获监听（mousedown/contextmenu/blur/resize）改为挂到实例引用，并在 `close()` 中配对 `removeEventListener` 回收，避免每次打开编辑器都重复注册、捕获层越积越多（长时间运行后可能干扰全局右键，刷新页面才会恢复）
- **随机种子节点视觉统一**：移除三行整块铺底，按钮外的缝隙/边缘直接透出节点主题渐变底色；标签按钮选中态线宽统一为 1px（此前选中加粗会让按钮整体外扩 1~2px）；命中检测与按钮实际绘制范围一致，消除边缘误命中/盲点
- **Qwen 加载器 GPU 层数自动调整优化**：加载前软清理 PyTorch 显存缓存块，让 `free` 读数更真实；新增"该模型上次成功加载的 GPU 层数"兜底，中断/卸载后显存读数偏低时复用上次成功值，避免模型整体掉到 CPU 推理长时间卡顿；输出更明确的调整说明
- **H3 节点模型失效诊断**：检测到底层模型失效时打印诊断日志（llm 类型 / Qwen storage 缓存有无 / 卸载状态），便于区分后端旧代码、模型未加载、已卸载等场景

### V12.14.0 (2026-08-26)

**🖼️ 小珠光图像加载器：多图网格优化**

- **多图网格居中对齐**：网格排布由左上对齐改为上下左右中心对齐，最后一行/列卡片不满时，右侧与下侧留白对称，不再出现左对齐、上对齐导致的留白不均
- **缩略图纯黑底**：缩略图卡片背景由半透明灰改为纯黑，`contain` 显示时图片两侧空白为黑色，观感更干净
- **去掉未选中灰框**：未选中卡片不再显示灰色边框（改为透明边框），只有选中卡片显示金色边框；取消选中后也不会残留灰框

### V12.13.0 (2026-08-25)

**✨ 大字展示（`XiaozhuguangBigDisplay`）全面增强**

- **自动换行**：超出节点宽度的文本自动折行，优先在空格处断行（英文单词不拆），中文/无空格时按字符断行，任何一行都不会溢出节点边界
- **左右 / 上下对齐**：设置面板新增两组图标按钮——左右对齐用「上短下长的横线」表达左/中/右；上下对齐用「长短不一的竖线」表达顶/中/底，选中项金色高亮
- **字号直接填数生效**：字号改为在面板输入数值，绘制严格按该数值渲染（不再自适应缩放）
- **右键专属菜单**：菜单屏蔽默认项，只显示金色「复制文本」「大字样式设置…」；「复制文本」一键复制当前展示的全部文本到剪贴板
- **设置面板改造**：主题色统一为金色；支持按住拖动；默认弹出在屏幕右侧 1/3；面板遮罩透明不再使画布变暗；移除发光、背景透明度、圆角滑条（内置固定 6）、字间距、滑条数值等冗余项
- **配置改为每节点独立并随工作流持久化**：字号/颜色/对齐/内边距/加粗等不再走全局共享，各节点持独立配置，保存工作流即可保留（此前全局共享会在所有节点间串扰）
- **前端注册修复**：`xzg_big_display.js` 此前未登记到 `extension.json` 的 `js` 列表，前端未被加载（新增菜单/绘制等全部失效），现已补上
- **`IS_CHANGED` 兼容节点输入**：接收忽略 ComfyUI 传入的 `input` 等关键字参数，始终返回 `True` 刷新展示，消除 `got an unexpected keyword argument 'input'` 警告

**🐛 小珠光 H3（`XiaozhuguangNinimaxH3Prompt`）模型失效错误提示优化**

- 底层模型（Qwen 加载器）被卸载/关闭导致失效、且自动重载也失败时，报错信息改为明确指出失败原因；若使用 BSAI H3 Model Loader，提示关闭本节点的 `unload_after` 选项或重新执行 Qwen Model Loader 后再运行本节点，便于定位

### V12.12.0 (2026-08-25)

**✨ 新增节点**

- **图片缩放高速版（`XiaozhuguangImageScaleByAspectRatioV2`）**：小珠光图片缩放（按宽高比）的高性能版本，参数与 V2 保持一致，计算速度更快。直接从张量形状获取尺寸避免逐图转 PIL，整批图像通过 `torch.nn.functional.interpolate` 批量插值；对 torch 不支持的 lanczos/hamming 插值自动回退原生 PIL 路径

**🐛 修复 / 改进**

- **点编辑器（`XiaozhuguangPointsEditor`）bbox 输出改为结构化列表**：连接口类型由 `STRING` 调整为 `BOXES`，输出每个框一个元素 `[x1, y1, x2, y2]`（像素坐标取整）的结构化列表，修复连接到小珠光批次计数时始终显示 0 框的问题
- **点编辑器帧逻辑对齐视频加载器**：帧滑条范围由 `0` 到 `总帧数`（如 30 帧为 `0..30`），`0` 对应第 1 帧画面，`29`/`30` 均显示第 30 帧画面，右下角可显示 `30/30`；后端输出的 `frame_index` 取 `min(帧号, 总帧数-1)` 始终落在有效范围内
- **图像加载器（`XiaozhuguangImageLoader`）移除调试输出**：删除遮罩数据长度的控制台 `print`
- **图像加载器缩小画布不再丢失图片**：为 DOM 控件指定 `hideOnZoom: false`，画布缩放到细节级别阈值以下时仍显示已加载图片，与内置图像/视频预览组件行为一致（前端改动刷新页面即生效，无需重启后端）

### V12.11.1 (2026-08-24)

**🐛 修复**

- **大字展示（`XiaozhuguangBigDisplay`）`IS_CHANGED` 调用报错**：原为类属性 `IS_CHANGED = True`（布尔量），ComfyUI 在生成缓存签名时会把 `IS_CHANGED` 当作函数调用，触发 `'bool' object is not callable`，并在控制台打印 `[WARNING] WARNING: 'bool' object is not callable`。已改为返回 `True` 的 `@classmethod`，语义不变（始终刷新大字展示），并消除该警告

### V12.11.0 (2026-08-24)

**⚡ 性能优化：帧优化 / 帧提取 惰性化 + 合并视频 内容级去重**

- **帧优化（`XiaozhuguangDuplicateFirstFrame`）惰性化**：移除强制每次重算的 `IS_CHANGED→NaN`，前置图像输入未变时直接命中 ComfyUI 输入缓存，不再重复计算；同时移除控制台 `print`
- **帧提取（`XiaozhuguangFrameExtract`）惰性化**：同样改为默认缓存（含 `front_fill`/`back_fill` 参数变化时才重算），并移除全部控制台 `print`
- **合并视频（`XiaozhuguangVideoCombine`）内容级惰性去重**：即使上游每次重新生成相同内容的帧，只要送入的图像/音频内容（SHA-256 指纹）与各项参数均未变且上次文件仍在，就直接复用上次编码文件、跳过 `export_to_video`——不再重新编码、不再出现编码读条、不新增编号文件
- 修复 `xzg_video_combine.py` 中遗留的无用变量

**✨ 新增节点**

- **小珠光反转遮罩极速版**（`XiaozhuguangMaskInvert`）：一键反转遮罩
- **小珠光图像-蒙版预览**（`XiaozhuguangImageMaskPreview`）：图像与蒙版同框预览

**🔧 其它优化**

- **ATBC（智能裁剪）/ ATR（图像回贴）**：采用 A+B+C 组合优化——用 cv2 批量处理（PIL 替换为 numpy+cv2），整批 image/mask 各一次转 numpy，消除逐帧多层临时数组；`_compute_crop_box` 的 while 循环改为解析式计算；MASK 按实际维度稳健处理（仅在 `ndim==4` 时去通道，通过 `mask_batched` 决定是否按帧索引，单遮罩直接广播复用，避免 IndexError）

### V12.10.0 (2026-08-24)

**🎬 视频加载 / 视频保存（共享播放器）：修复「加载上限截断视频后，单次播放仍会播完整段声音」**

- 两个节点共用同一个 `XiaozhuguangVideoPlayer`，问题来源于 `_startAudioPlayback`：音频源播放的是 `decodeFullAudio()` 解码出的**完整音频缓冲**，且 `AudioBufferSourceNode.start(0, offset)` 会一路播到缓冲末尾，完全不理会「加载上限」截断的画面结束点
- 同时单次（非循环）播放结束分支原本不会停止音频源，导致截断后画面提前停、声音却继续播完
- 修复：播放音频时用与画面结束点同源的 `_computeEndFrame()` 计算剩余可播时长，通过 `start(0, localTime, playLen)` 的第三参严格限定音频到截断结束点同时停止；未截断时播放长度=剩余全长，声音照常播完，无回归
- 覆盖：初始播放、播放中 seek、循环重播（每轮按 `frameLimit/fps` 限制）均正确

### V12.9.0 (2026-08-24)

**🎬 化神级合并视频节点：修复「文件名前缀含子目录时只能保存、无法预览」**

- 文件名前缀若含目录嵌套（如 `xzg_video/xxx` 而非 `xxx`），后端会把视频正确保存到 `output/xzg_video/xxx_00001.mp4`，但返回给 UI 的 `subfolder` 此前被错误置空，导致前端 `/view` 无法定位子目录文件而预览失败
- 修复：`folder_paths.get_save_image_path` 返回结构中的真实子目录（第 4 位）被正确捕获并透传给前端；同时修正了元组解包顺序（上版误把第 3 位的整数计数器当子目录，导致 `TypeError: expected str, bytes or os.PathLike object, not int`）
- 保存与预览现在统一从同一条结果路径读取，文件名前缀为纯文件名时行为与旧版完全一致，无回归

### V12.8.0 (2026-08-24)

> 📚 **重点参考**：化神级视频编辑器（快剪/加载器）的 WebCodecs 解码、统一时钟多轨播放、MediaBunny 集成思路，参考了 [OpenCut-app/OpenCut](https://github.com/OpenCut-app/OpenCut) 项目的实现。

**🎬 化神级视频编辑器：统一时钟多轨渲染内核（参考 OpenCut 单时钟模型）**

- 时间推进由「墙钟时间（`performance.now`）驱动全局时间 gt」，播放态每个 rAF tick 只渲染当前 gt 一帧，重复 tick 落到同帧号=同一帧，彻底修复「播放几秒后画面与时间码加速快跑」的经典问题
- 抽出 `_renderLayersOnce(gt)` 作为单帧合成内核：播放、seek、拖动、刷新四条路径统一走同一入口，消除旧路径下 17+ 方法各自维护帧号与缓存导致的错乱
- 裁剪片段的取帧从「相对帧号（`localTime - clip.start`）」改为「源视频绝对帧号」，修复裁掉头部的片段仍从源第 0 帧开始播放的 bug

**🎬 化神级视频编辑器：预取节拍锁定 + 缓存淘汰中心锚定播放目标帧**

- 旧实现的预取头按 RAF 调用频率（可达 100Hz）狂奔，约 2–3 秒后领先目标一整段缓存窗口，目标帧被挤出窗口 → 画面显示预取头附近的未来帧 → 视觉上约 2.7× 渐进加速。修复：领先量已足（`topFilled ≥ target+窗口`）时本次预取**零拉帧**，预取速率从「按调用频率」严格锁定为「按播放速率」，领先量稳态保持约 29 帧不再膨胀
- FrameCache 的淘汰中心（`decoder._targetFrame`）锚定「播放目标帧号」（原来是预取头本身），即使领先再多，目标帧也永远处于淘汰中心窗口，不会被挤出缓存

**🎬 化神级视频编辑器：解码器隔离 + 转码兜底（HEVC/MP3 → H.264+AAC）**

- 不同文件的视频轨道使用独立解码器实例（`decoderPool.get(filename)` 为不同文件返回独立实例），快剪编辑器与视频加载器的解码器池完全隔离，避免共享实例引发的资源竞争与画面错乱
- WebCodecs 不支持的编码（H.265/HEVC 或无法解码的 MP3 音频）由后端 imageio-ffmpeg 静态 FFmpeg 转码为 H.264 MP4 + AAC 音频兜底，快剪编辑器产物存 `fastcut-cache/h264/`、加载器产物存 `input/xzg-h264/`，两套转码流程相互独立

**🖼️ 小珠光图像加载器：侧栏图标化 + 预览区最大化**

- 画布态（遮罩/裁剪关闭）侧边栏「上传 / .input / .output / 删除 / 清空 / 遮罩 / 裁剪」全部图标化：20×20、1.5px 细描边、纯图标 + 原生 tooltip，侧栏宽度内容自适应，预览区占比最大化
- 「遮罩」图标采用太极（阴阳）图标：黑鱼纯黑填充、白鱼纯白填充、白鱼内白点保留、黑鱼内黑点去除；其余 6 枚图标使用通用线性风格，画布态为普通文字色（非金色）
- 边框与留白进一步收紧：节点容器 padding/margin/gap 归零，预览网格 `padding:0` 并贴顶贴左对齐，空态说明改为贴顶贴左；四周边框与内容的空隙显著压缩
- 空态无图时的使用说明面板新增「🖌️ 遮罩 / 裁剪」章节，并将标题「小珠光图像加载器」改为与首行内容左对齐绑定（不再单独居中悬浮）
- 画布态与编辑界面（遮罩/裁剪开启）完全解耦：画布态图标化+紧凑，编辑态恢复固定 52px 侧栏 + 金色居中文字；裁剪比例标签与按钮按编辑界面原有规则对齐

**🗂 其他**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.7.0` 升至 `12.8.0`
- 依赖：`requirements.txt` 保持 `imageio-ffmpeg>=0.5.1`，FFmpeg 环境随包自动安装
- 语法校验：`xzg_video_editor.js`、`xzg_image_loader.js`、`xzg_frame_decoder.js`、`xzg_group.js`、`xzg_video_player.js`、`xzg_selector.js`、`xzg_video_combine.js` 通过 `node --check`；相关后端节点 `.py` 通过 Python AST 解析
- Release / Registry：由 `.github/workflows/publish_action.yml` 在推送 `v12.8.0` tag 时自动创建 GitHub Release + 发布到 Comfy Registry（版本 12.8.0）

---

### V12.7.0 (2026-08-22)

**⚡ 小珠光点编辑器：性能优化（长图/高帧拖拽更流畅）**

- **原图离屏缓存**：拖拽点/画框不再每次重绘都解码+缩放整张原图，改为仅换图/换帧时渲染进离屏 `_baseCache`，交互时只做一次同尺寸快速 blit（GPU 加速），显著降低重绘开销
- **rAF 合并重绘**：mousemove 高频路径（拖动点、绘制框）改用 `requestAnimationFrame` 合并，一帧只画一次
- **高度写屏守卫**：container 高度值未变时不写样式，消除 `onDrawForeground` 每帧强制 reflow

**🖼️ 小珠光点编辑器：预览清晰度改为「像素量」**

- 新增 `preview_pixels` 参数（单位：万像素，100 = 100 万像素 / 1MP）：原图总像素超过该值才等比缩放，`0` = 不缩放用原始尺寸；坐标自动等比放大回原图，标注结果不受影响
- 预览清晰度由旧的「比例」改为「总像素量」，更直观地控制预览体积与清晰度

**🎬 快剪：右上角功能区显示开关（ComfyUI 设置项）**

- ComfyUI 左下角「设置」新增「[小珠光] 右上角功能区显示「快剪」」（默认开启）：关闭后顶部菜单栏「快剪」按钮隐藏，仍可从加载器节点的「从快剪加载」联动入口进入视频编辑器；设置变更即时生效，无需刷新

**🗂 其他**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.6.1` 升至 `12.7.0`
- 语法校验：`xzg_points_editor.js`、`xzg_video_editor_launcher.js` 通过 `node --check`；`__init__.py` 通过 Python AST 解析
- Release：GitHub Release v12.7.0 + publish_action.yml `push tags v*` 触发 → Comfy Registry 新版本 12.7.0 发布

---

### V12.2.3 (2026-08-20)

**🎬 化神级视频编辑器：音频模式（从快剪加载音频）布局修复**

- **拖动预览与时间线分界手柄时，A2 下方出现空白**：音频模式下 4 轨道均分 delta 导致隐藏的 V2-上/V1 虚增高度，面板高度公式沿用通用模式的 5px 粗分割线偏移。修复：音频模式 delta 仅分配给 A1/A2，V2-上/V1 保持 0；面板固定偏移改为 71（无 5px 分割线）、最小高度 121
- **Shift+滚轮调高 V1 时 V2 瞬间变高**：音频模式面板高度未同步设置（默认 350px，轨道总高溢出被裁剪），首次按滚轮时面板跳变到正确值释放被裁剪的 A2，视觉上 A2"跳高"。修复：`_applyModeFilter` 面板高度同步设为 `71 + eachH * 2`，与轨道总高一致，滚轮增量保持 10px 无跳变

**🎬 化神级视频编辑器：时间线空隙选中 + Delete 删除（单轨道）**

- 点击轨道空白处（两片段之间、首片段之前）选中空隙，金色虚线框预览；空隙尾部无片段（最后一段之后）不可选
- Delete/Backspace：后方（起点 ≥ 空隙终点）片段前移贴合到前一片段，帧对齐量化；严格单轨道（仅 V1/V2/A1/A2 之一），不影响其他轨道；支持 Ctrl+Z 撤销（删除前压历史栈）
- 与片段选中互斥；每次渲染前校验空隙仍对应实际片段交界（过期自动清除）；视图模式/加载器模式/布局重置时清空空隙选中

**🎬 化神级视频编辑器：播放头驱动片段选中（配合轨道名激活）**

- 单击轨道头名称（V2/V1/A1/A2）→ 该名红色（#ff5252）加粗 700、字号 12→15；再单击同一名称**取消激活**（toggle）
- 激活轨道时播放头拖到哪 → 命中该轨道片段则选中；无激活则默认选最上层（V2 → V1 → A1 → A2，修正 A1 优先于 A2）
- 接入点覆盖全部播放头移动路径：拖播放头（`_scheduleScrubSeek`）、点刻度跳转（`_seekToGlobalTime`）、左右箭头帧步进、自动播放 4 个循环（视频/纯音频/图片片段/空隙等待）
- 守卫：≥2 片段多选时播放头不再覆盖选中，保证 Shift 范围选择 / Ctrl+A 多选的稳定性

**🎬 化神级视频编辑器：多选增强（媒体库 + 时间线）**

- 媒体库：Ctrl+A 全选；Shift+点击两端点选两者之间所有媒体（含锚点/方向兼容）；最近交互区域分流（媒体库/时间线），Ctrl+A 按焦点区域全选对应对象；焦点激活使用 capture 阶段容器监听（一处覆盖全部区域，不受 stopPropagation 影响）
- 时间线：Ctrl+A 全选所有片段；Shift+点选两端 → 该轨道两者之间（含两端）片段全选；视频/音频轨道统一走 `_handleClipClickSelection`，锚点规则与媒体库一致；不同轨道间点选自动退化为单选

**🔊 音频节点：波形缓存 + 红蓝线/音量持久化 + 发送到加载器**

- **波形前后端双层缓存（切工作流免重复解码）**：后端以 `绝对路径 + mtime + size` 为键缓存 peaks/duration/sample_rate（200 条 FIFO），命中缓存直接返回已完成 job 不启 FFmpeg 线程；前端会话缓存 `_xzgWaveformCache`（100 条 FIFO），切工作流恢复同一音频时零网络请求秒出波形；文件被覆盖上传基于 mtime+size 自动失效
- **红蓝标记线 + 音量随波形缓存持久化**：缓存条目扩展 `{peaks, duration, range, volume}`；拖动红/蓝线结束（onRangeChange）、拖音量线/双击（onVolumeChange）、改起始/时长 widget 时局部回写；切换工作流恢复同一音频时 `range + volume` 同步还原（clamp 防御异常）；`syncVolumeFromWidget`（onConfigure 强制 1.0）改为直接赋值不触发回调，避免污染缓存持久化音量
- **重置规则**：切工作流恢复同一音频 → 持久化还原；更换音频/重新上传/快剪导出 → 重置（100% 音量 + 全范围）；刷新浏览器 / 重启 ComfyUI → 重置（前端会话缓存清空，后端仅存 peaks 不含状态）
- **音频保存：右键「发送到音频加载器」**（与图像保存发送功能同构）：画布无音频加载器 → 提示；N 个加载器 → **一键发给全部**（不再弹出选择器 / 不再过滤绕过状态）；标注文件名 `xxx.mp3 [output]` 或 `xzg_preview_{uuid}.mp3 [temp]`，音频加载器原生支持 output/temp/input 三种后缀解析；预览模式（temp）执行后立即发送可用（刷新/重载工作流后恢复禁用，避免 temp 文件被清理后 404）
- **三层拦截屏蔽原生右键菜单**（音频保存波形区）：window capture contextmenu（`preventDefault + stopPropagation + stopImmediatePropagation`）、`processMouseDown` hook 返回 true、`processContextMenu` hook 原 `return;` 改为 `return true`（明确"已处理"）；命中波形区只弹自定义「保存格式 + 发送到音频加载器」菜单，ComfyUI 原生节点菜单不再弹出

**🗂 其他**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.2.1` 升至 `12.2.3`
- 语法校验：`xzg_video_editor.js`、`xzg_audio_save.js`、`xzg_audio_loader.js` 均通过 `node --check`；`xzg_audio_loader.py` 通过 Python AST 解析

---

### V12.2.1 (2026-08-19)

**🔊 修复：小珠光音频加载器 — 点击虚线下（下半区分界线以下）偶发不播放音频**

- **问题现象**：同一音频，有时点波形虚线下能立即播放/暂停，有时点同一个位置却完全没反应 — 呈现出「偶发不播放」。复现路径：拖完播放头立刻点虚线下、或者靠近左侧音量线/红色起始线/蓝色结束线的位置点虚线下，几乎必现
- **根因 1 — 200ms 防误触守卫吞了整个虚线下点击**：`handleMouse` 入口对 `isDragging` 或「拖动播放头结束 200ms 内」做了全量拦截 `return true`，只要上一次操作是拖播放头，立刻点虚线下的 `pointerdown` 直接被吞，不走 `togglePlay`
- **根因 2 — 起始/结束把手「全高度命中」判定**：红色 `startX`、蓝色 `endX` 两侧 ±14px（`handleWidth=14`）范围内，点击在虚线下也被判成 `dragType='start'/'end'` → 进入 `isDragging=true` 分支，pointerdown 不会调用 `togglePlay`，原 `_handleMouseUp` 也没有针对「没拖动」的兜底播放
- **根因 3 — 左侧音量把手命中**：音量（尤其 100% 或更低）的水平线位于中下区域，点虚线下恰好落在 `Math.abs(localY - volY) ≤ 5` 且 `localX ∈ [pad, pad+40]` 时 → 被判 `dragType='volume'` → 同根因 2，无播放

- **修复 1 — 防误触守卫缩小到「仅上半区」**：入口守卫改为 `!lowerHalf && (isDragging || _lastPlayheadEnd < 200ms)`，虚线下（分界线及以下）永远放行，防止拖完播放头后立刻点虚线下被吞

- **修复 2 — 下半区远离把手 → 直接走播放/暂停**：把手命中之前新增分支：`lowerHalf && 距离 startX > handleWidth && 距离 endX > handleWidth` → 直接单单击 `togglePlay()` / 双击 `onUpload()`，**不进入 dragging 态**，杜绝「把手误判导致永远不播放」

- **修复 3 — mouseup 兜底播放**：新增 `_dragStartedInLowerHalf` 标志，pointerdown 按下时记录是否位于虚线下（包括撞到音量把手的特殊情况 `'volume'`）。`_handleMouseUp` 末尾在 `!_dragMoved`（点击没有真正拖动，距离小于 `_dragThreshold`）且 `startedInLowerHalf` 时，补一次 `togglePlay()` —— 即便真的进入了 start/end/volume dragging 判定，只要是虚线下的「单击」，松开时也一定能播放

- 行为一致性：虚线上（上半区）的拖动播放头、范围 start/end 把手、音量拖动手柄完全不变；上半区单点仍会跳转播放头不改变播放状态

**🗂 其他**

- 版本号统一：`pyproject.toml`、`extension.json` 设为 `12.2.1`
- 语法校验：`xzg_audio_loader.js` 通过 `node --check`

---

### V12.6.1 (2026-08-22)

**🚀 小珠光大字展示：显示区精修 + 字号彻底自由缩放**

- **文字显示区上移**：内容区（文字/绿框）整体上移 25px，更紧凑地贴合输入端口下方，减少标题栏与输入行之间的空白
- **取消整节点外圈绿框**：选中节点时不再绘制包裹整个节点（含标题栏/输入端口）的绿色虚线外框，仅保留文字内容区四周的绿框
- **字号彻底自由**：去掉 `Math.min(fs, fs*scale)` 的上限钳制，改为 `fs = fs*scale` 双向自由缩放——节点拉大字号跟着放大，节点缩小字号随之缩小，不再被原设置值锁死
- **输入端口占位**：文字绘制、字号缩放、居中全部限定在「输入端口下方的内容区」内，并加 `clip()` 强制裁剪，文字绝不遮挡输入端或溢出节点

**🗂 其他**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.6.0` 升至 `12.6.1`
- 语法校验：`xzg_big_display.js` 通过 `node --check`
- Release：GitHub Release v12.6.1 + publish_action.yml `push tags v*` 触发 → Comfy Registry 新版本 12.6.1 发布

---

### V12.6.0 (2026-08-22)

**📦 小珠光编组：边框/标题栏与节点、背景完全同步渲染（修复缩放时“边框先动后追平”的时间线抖动）**

- **问题现象**：缩放/平移画布时，编组框的边框、标题栏（DOM overlay 层）先缩放到下一帧尺寸，随后才和背景、节点追平，肉眼可见「先动一下再对齐」的抖动/闪烁；即便把更新从 rAF 移到事件 handler 仍存在，因为 DOM 与 canvas 是两条渲染时间线
- **根因**：DOM 层和 canvas 层在不同时刻更新——旧实现在独立 rAF 或 changeScale/changeOffset/processMouseMove/wheel 事件里直接写 `updatePositions()`（改 DOM 位置/尺寸），随后 canvas 才在下一帧 onDrawBackground 里按新 scale 重绘背景和节点，导致边框“领先”背景一帧
- **编组同步渲染铁律**：`updatePositions()` 的**唯一调用点只能是 `onDrawBackground`**（由 `setupCanvasBgDraw` 挂载的 onDrawBackground 回调，先 `self.updatePositions()` 再 `self._drawGroupBackgrounds()`），绝对禁止在独立 rAF（原 `startSyncLoop`）或任何事件 handler 中提前写 DOM 尺寸；`syncNow` 统一只做 `app.canvas.setDirty(true, true)` 触发重绘，把“编组 DOM → 背景 → 节点”三件事锁在同一 canvas 渲染帧、同一 scale 值下一次性完成，视觉上零抖动
- **渐隐/渐入同步策略升级：去掉移动渐隐，只做停止后的渐入**，配合确定性时间戳透明度计算——停止移动瞬间在 `fadeInStartNow = performance.now()` 记录同刻起点，`_fadeStart / _fadeDur / _fadeTarget` 写入编组对象，canvas 背景渐变与 DOM opacity 过渡按同一时间戳线性插值计算，不再读 `getComputedStyle`（避免 CSS transition 与重绘不同步导致的档位跳变），两者连续无级同步

**⭐ 节点收藏：设置面板紧凑化 + 开关对齐 + 标签永不折行**

- **新增「调入后自动关闭面板」开关**：开启时，点击或拖入收藏的节点到画布后面板自动折叠；关闭时保持展开，仍保留点击空白处/ESC 等原有关闭能力。持久化到 localStorage（`autoCloseAfterInsert`）
- **开关右边缘对齐**：标签 span 用 `flex: 1 1 0` 占满剩余宽度，把 toggle 推到最右端，两行开关严格对齐（此前文字长度不同时开关位置前后错位）
- **标签永不折行**：`white-space: nowrap` + `text-overflow: ellipsis` 兜底，未来再长的中文字符也不会在 210px 窄面板里折行
- **布局紧凑化**：标题栏 padding `12/16px` → `6/16px` 并固定字号 13px；各行 gap `16px` → `6px`；内容区 padding `12px` → `8/12/10px`；使用频率行距 `12px` → `6px`；底部按钮区与按钮高度同步收紧；设置面板整体高度明显压缩

**🗂 其他**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.5.0` 升至 `12.6.0`
- 语法校验：`xzg_group.js`、`node_favorites.js` 通过 `node --check`
- Release：GitHub Release v12.6.0 + publish_action.yml `push tags v*` 触发 → Comfy Registry 新版本 12.6.0 发布

---

### V12.5.0 (2026-08-21)

**🎬 视频加载器：预览视频自动重置为源视频 + 跳过帧数输出**

- **问题现象**：工作流执行后，「预览视频」（执行后转码的临时文件）会覆盖播放器，导致播放条总帧数变为**处理后的帧数**（= 加载上限，而非原视频总帧数），此时拖动「跳过帧数/加载上限」控件，总长度不会恢复，用户看不到原视频后面的帧
- **预览视频自动重置**：新增 `_isPreviewLoaded` 标志 + `_resetToSourceVideo()`；`_syncLoadRange`（跳过帧/加载上限变动时）、下拉切视频、拖入上传三个入口都会触发重置，重新 `player.load(原视频URL)`，总帧数恢复原视频全长，已有 `syncCustomSize()` / `setLoadRange` 机制自动应用当前渲染参数
- **播放头保护**：重置前按 fps 保存当前帧号，重置加载完成后 `clamp(skip, savedFrame, end-1)` 回放到加载范围内对应帧，不会跳回 0；`requestAnimationFrame` 延迟一帧执行 load，避免数字输入框拖动后 pointerup 与重渲染冲突导致意外进入编辑模式
- **视频信息读取节点新增第 6 输出「跳过帧数」**：`RETURN_TYPES` 扩展 `(FLOAT,INT,INT,INT,STRING,INT)`，第 6 口 `skip_frames` 从视频加载器写入的 `info.skip_frames` 读取（旧版加载器无此字段回退 0，`int()` 防御异常），方便下游节点精确对齐到「实际加载的第一帧」而非原视频第 0 帧
- **中英双语翻译同步**：`locales/en/nodeDefs.json` + `locales/zh/nodeDefs.json` 为 `XiaozhuguangVideoInfoReader` 新增 `skip_frames / 跳过帧数` 第 5 输出口翻译（与 RETURN_NAMES index 5 一一对应）
- **冗余日志清理**：删除 `xzg_video_loader.py` 预览视频生成成功后的 `print` 调试行，减少 stdout 刷屏

**🔲 小珠光布尔：节点可自由拖拽大小 + 按钮等比自适应（参照小珠光选择器布局算法）**

- **节点自由缩放**：`this.resizable = true` + `this.flags.resizable = true`；`onResize` 强制最小尺寸 `宽 120 / 高 58`（与选择器一行底线一致）；设置面板「应用」不再强行改回固定尺寸，仅兜底最小尺寸
- **布局算法重写 `getButtonRects(y, W, settings, availableH)`**：左右各 **6px 边距** → `availableW = W-12`；顶部 4px / 底部 8px；`availableH > 自然 btnH` 时按钮等比放大填满，不足时缩小避免溢出；按钮间比例关系（`settings.widths` / `settings.btnWidth` 决定）始终保持不变
- **宽度自适应**：节点够宽时按可用内容区比例放大两按钮（同一 scale 保持比例），不够宽时保持自然宽度不压缩（与选择器「宽度自适应」一致）
- **默认字体默认白**：`DEFAULT_SETTINGS.fontColor` 从 `"#aaa"` 改为 `"#FFFFFF"`，与选择器默认字体色一致
- **字体垂直居中精确化**：`ctx.textBaseline = 'alphabetic'` + `ctx.measureText` 取 `actualBoundingBoxAscent/Descent` 计算基线偏移 `(ascent-descent)/2`，大字体下不再偏上；字体大小 `clamp(8, settings.fontSize, r.h*0.85)` 防止超出按钮
- **点击命中迁移到 `node.onMouseDown`**：原 `widget.mouse` 命中受 `computeSize` 返回高度限制（返回极小值后点击不到），改为 `onMouseDown` 覆盖整个节点区域；`widget.mouse` 仅放行事件；`widget.computeSize` 返回 `[width, 4]` 不干预节点高度，完全交给用户自由拖动
- **初始尺寸用「自然宽度」计算**：`naturalW = falseW + gap + trueW + 12`，保证新建节点按钮不被拉得过宽，符合默认视觉
- **最小高度底线 58**（一行），与小珠光选择器一致

**🗂 其他**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.4.0` 升至 `12.5.0`
- 语法校验：`xzg_boolean_selector.js`、`xzg_video_loader.js` 通过 `node --check`；`xzg_video_info_reader.py`、`xzg_video_loader.py`、`__init__.py` 通过 Python AST 解析
- Release：GitHub Release v12.5.0 + publish_action.yml `push tags v*` 触发 → Comfy Registry 新版本 12.5.0 发布

---

### V12.4.0 (2026-08-21)

**🔀 小珠光编号切换：惰性求值（参考 easy-use anythingIndexSwitch）**

- **仅计算被选中编号的上游支路**：50 个 `valueN` 输入全部声明 `{"lazy": true}`，新增 `check_lazy_status` —— 切换 `select` 编号时，执行引擎只调度被选中编号对应的上游工作流，其余编号的上游**完全不执行**（省去冗余计算 / 大模型加载 / 采样等开销）
- **两阶段引擎流程**：第一次执行时 `check_lazy_status` 返回 `["value{select}"]`，引擎 `make_input_strong_link` 强制求值该支路并返回 PENDING，第二次进入 `switch` 输出结果
- **未连接口安全**：选中口未连接时不在 `kwargs` 中，不发起请求，静默输出 `None`，规避 easy-use 原版会触发的引擎 `NodeInputError`
- **防御加固**：`select` 经 `int()` 转换并 clamp 到 `[0, 49]`；上游输出恰为 `None` 时引擎会过滤请求，不会死循环

**⭐ 节点收藏：自定义使用频率**

- 节点右键菜单新增「自定义使用频率」：以对话框形式直接输入该节点的使用次数（替代浏览器原生 prompt，与工作流管理一致的交互），输入后立即生效并参与使用频率排序
- 配套新增 `showNodeInputDialog` 自定义输入框组件（支持 ESC / 点遮罩取消），后续弹窗类交互统一复用

**📍 SAM 点编辑器：会话级点缓存 + 布局修复**

- **会话级点缓存**：新增 `POINTS_SESSION_CACHE`，切换工作流 / 更换图片均不丢失已标注的点；仅刷新浏览器（模块重载）后清空；key 为 `${workflowKey}::${nodeId}`
- **帧轨道布局修复**：帧切换轨道始终占位 32px，多帧 / 单帧布局统一，避免切换时画布尺寸跳变；单帧时禁用滑条（置灰 + 不响应鼠标），帧信息仍正常显示

**🗂 其他**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.3.1` 升至 `12.4.0`
- 语法校验：`__init__.py` 通过 Python AST 解析；`xzg_number_switch.js`、`xzg_points_editor.js`、`node_favorites.js` 通过 `node --check`
- Release：GitHub Release v12.4.0 + publish_action.yml `push tags v*` 触发 → Comfy Registry 新版本 12.4.0 发布

---

### V12.3.1 (2026-08-21)

**📦 小珠光编组：背景色、背景出现动画、缓入缓出、UI 布局重整**

- **背景色独立控制（不遮挡节点）**：新增 `bgColor` 字段（rgba，默认透明），不写入 DOM 框体（overlay 在画布之上会遮挡节点），改为**挂载到 LiteGraph `onDrawBackground` 回调**（背景网格之后、连线和节点之前），直接在 graph 坐标空间按 `bounds` 绘制；绘制范围 `[b.x, b.y+18, w, h-18]` 不覆盖标题栏（避免透过半透明 headerBgColor 混色）；顶部两角直角、底部两角 8/scale 圆角匹配 DOM
- **背景色跟随渐隐渐入**：透明度读取必须用 `getComputedStyle(el).opacity`（CSS transition 中 `el.style.opacity` 瞬间即终值，computed 才是每帧过渡值）；渐入时动画启动硬上限 700ms（`min(700, max(80, fadeInMs*0.4))`，避免渐入滑块最大 8000ms 时等比例等待长达数秒）
- **背景持续重绘机制**：`updatePositions` 末尾几何 hash 检测（拖框体/resize/收纳）触发 setDirty；渐入+背景动画窗口用 rAF 循环 `_kickCanvasRepaint`；动画中 `_bgAnimRepainting` 防重入标记直到所有编组动画窗口过期
- **8 种出现动画 + 缓入缓出**：缓动统一用 `easeInOutCubic`（先慢→中间快→结尾慢）。`none` 默认无；`wipedown/wipeup/wiperight/wipeleft` 四向卷帘；`centerout` 中心扩散；新增 `edgesin` 从外往内（左右两侧向中间并集 clip）；新增 `clockwipe` 时针旋转（12点方向顺时针扇形扫过，radius=对角线/2+1，极小进度用 lineTo 退化三角防 arc 起止角相同变整圆）
- **出现动画播放时序**：渐入期间重叠启动（背景透明度跟随 domOp 由淡变实，视觉连续）；新建编组立即播放；设置弹窗选择动画立即预览 1 次；仅 fadeEnabled 编组 + bgColor 非透明时触发；`bgAnimation/bgAnimDuration` 序列化、快照回滚、应用到全部、localStorage 新建继承均覆盖
- **设置面板 UI 调整**：背景设置区块新增「出现动画」下拉 + 「动画时长」0.2–5s 滑块；删除无用行距控件（单行标题固定 line-height:1）；边框渐入开关独立一行，「渐入时长」滑条移到开关下一行并加独立标签，切换时面板行宽不再抖动、布局不再跳动
- **编组默认动画首次使用为「无」**，设置后 localStorage 记忆、新编组继承上次配置
- **画布背景钩子健壮性**：`setupCanvasBgDraw` 以链式包装旧回调（兼容 ComfyUI 自身），初始化 canvas 未就绪时最多 60 次 100ms 重试

**🔊 LongCat AudioDiT 节点默认启用开关修复**

- **问题修复（重要）**：此前引入的 `XZG_ENABLE_AUDIODIT` 开关逻辑写反——只要不设环境变量节点就不可见，导致升级后用户画布上原有的 AudioDiT 节点全部消失、模型/tokenizer 缺失错误也无法触发
- **切换为默认启用**：节点注册改为**始终注册**，只有环境变量 `XZG_DISABLE_AUDIODIT=1` 才关闭；模型缺失/目录为空的提示**延迟到首次执行**再打印 stderr（含 `[小珠光]` / `[Xiaozhuguang...]` 前缀），启动阶段保持静默
- **未启用执行保护**：`IS_CHINESE? 中文 : 英文` 双语提示，引导用户设置正确的环境变量或卸载，避免 `resolve_model_path_xzg` 分支走到不存在的方法时抛笼统 ImportError/AttributeError

**📝 小珠光文本框：日期时间整体识别与中文转写（2023.4.16 21:08 → 二零二三年四月十六日九点零八分）**

- **新增 Stage 0 整体正则**：优先匹配「日期时间整体」结构，避免被后面的 量词/单位、编号、乘积 等规则拆碎。支持 4 位年份 + 1–2 位月日 + `./-/.` 任意分隔符，以及 `[空格/T]` + `HH:MM`（分钟限定 2 位，避免误伤 16:9 这类比例）
- **拆分 3 条正则**：
  - `_DATETIME_RE`：同时包含日期 + 时间（`2023.4.16 21:08`）
  - `_DATE_ONLY_RE`：纯日期（`2023-4-16`）
  - `_TIME_ONLY_RE`：纯时间（`9:08`，分钟必须 2 位，防止匹配 `16:9`）
- **年份按位读**：`2023 → 二零二三`、`2000 → 二零零零`
- **月份 / 日期完整读数 + 不加 "零" 前缀**：`4月 → 四月`、`16日 → 十六日`；`1月/2月` 不会写成「零一月」
- **小时 24 制 → 12 制读法**：`9点`、`21点 → 九点`、`13点 → 十三点`、`0点 → 零点`（不按 0-23 机械加「零」前缀）
- **分钟规则**：`00分 → 整`；`1–9分 → 零X分`（`08分 → 零八分`）；`10–59分 → 完整读数 + 分`（`21分 → 二十一分`）
- **示例输出**：`2023.4.16 21:08` → `二零二三年四月十六日九点零八分`
- **placeholder 同步更新**：中英文 placeholder 追加日期时间转换示例与说明

**🔊 音频节点：短横线音量手柄 — 换音频 / 刷新浏览器 / 重启 ComfyUI 一律重置为 100%**

- **问题现象**：音量既存在于 `waveformViewer.volume`（实际播放增益），又被写入序列化（音频保存写入 `waveformWidget.value` JSON 的 `volume` 字段；两个节点的原生「音量」widget 落入 `widgets_values`），重载工作流后会按旧值恢复 —— 导致刷新浏览器 / 重启 ComfyUI / 切换音频文件后，音量一直停在之前的百分比
- **修复思路**：关闭「音量持久化」，把音量视为纯运行时 UI 状态，只在用户**用手柄拖动期间**生效；一旦进入以下任意触发点，立即归零回 100%

**音频加载器（xzg_audio_loader.js）**：
- `syncVolumeFromWidget()`：不再读取 `volWidget.value` 历史值，改成强制 `volWidget.value = 1.0` + `viewer.setVolume(1.0)`
- `_applyAudioWidgetStyles()`：音量 widget 样式初始化处无条件 `w.value = 1.0`（钉死写入 `widgets_values` 的值）
- `onExecuted`（收到后端 `full_peaks` 出图波形）：末尾 `view.setVolume(1.0)` + 音量 widget 写回 `1.0`
- 原已有双保险：`WaveformViewer.setData()` 内部硬重置 `volume = 1.0` + `_applyVolume(1.0)`；`_syncWidgetsFromViewer()` 把音量 widget 强制 `1.0`
- 效果：下拉切音频 / 拖入上传 / 手动 `uploadAudioFiles` / F5 / 重启 ComfyUI / 工作流执行完成 → 音量全部回到 100%

**音频保存（xzg_audio_save.js）**：
- `WaveformViewer.setData()`：顶部加 `volume = 1.0` + `_applyVolume(1.0)`，设置波形时即重置
- `onExecuted` 序列化 JSON：删除 `saveData.volume` 字段，不再把音量写回工作流；末尾显式把音量 widget 写回 `1.0`
- `waveformWidget.callback`（工作流重载后 widget.value 变更触发）：不复用 `data.volume`，不用 `volWidget.value` 初始化，一律 `viewer.volume=1.0` + `viewer._applyVolume(1.0)` + `volW.value = 1.0`
- `node.onConfigure`：同步 widget JSON 后再走一轮「强制 1.0」双保险
- `w.name === '音量'` 样式分支：无条件 `w.value = 1.0` 钉死序列化

**🗂 其他**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.2.3` 升至 `12.3.1`（Registry 侧 12.3.0 已被 2026-08-19 旧提交占用，本次通过 bump patch 版本完成新版本收录）
- 语法校验：`xzg_group.js`、`xzg_audio_save.js`、`xzg_audio_loader.js`、`xzg_workflows.js` 均通过 `node --check`；`xzg_audiodit_loader.py`、`xzg_audiodit_tts.py`、`__init__.py` 通过 Python AST 解析
- Release：GitHub Release v12.3.1 + publish_action.yml `push tags v*` 触发 → Comfy Registry 新版本 12.3.1 成功发布
- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.2.0` 升至 `12.3.0`
- 语法校验：`xzg_audio_save.js`、`xzg_audio_loader.js` 均通过 `node --check`；`xzg_text_box.py` 通过 Python AST 解析

---

### V12.2.0 (2026-08-19)

**🛡 修复：快剪内删光音轨所有音频后，误删音频/视频加载器节点（重要）**

- **问题现象**：从「小珠光音频加载器」点「从快剪加载」进入快剪，在音轨上删除所有音频片段后，点确认时有一定概率导致**音频加载器节点从画布上被删除**
- **根因**：快剪编辑器打开期间，它在 window 上以 **capture 阶段**注册了 keydown 监听（先于 ComfyUI 画布）。进入快剪时加载器节点仍处于画布选中状态。`_onKeyDown` 的 Delete/Backspace 分支中，当快剪内**没有选中片段/媒体**时走 `if (!mediaSel && !clipSel) return;` 直接放行——事件穿透到 LiteGraph，**删除当前选中的加载器节点**。因此「删光所有音频后习惯性再按一次 Delete（或删除最后一个后连按）」就会误删节点
- **修复**：Delete/Backspace 分支改为**无论快剪内有无选中，一律先 `e.preventDefault()` + `e.stopImmediatePropagation()` 拦截**，之后才执行片段/媒体删除逻辑。快剪打开期间 Delete/Backspace 永远归属快剪，不再穿透到 ComfyUI 画布；快剪关闭后监听移除，画布删除节点功能不受任何影响
- **验证方式**：Ctrl+F5 刷新 → 选中音频加载器节点 → 从快剪加载 → 快剪里删光所有音频 → 连续按多次 Delete/Backspace → 关闭快剪 → 节点完好保留

**🗂 其他**

- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.1.0` 升至 `12.2.0`

---

### V12.1.0 (2026-08-19)

**📦 依赖管理大升级（pyproject.toml + requirements.txt 双清单）**

- **pyproject.toml 补齐必需依赖**：`torch / numpy / Pillow / opencv-python / safetensors / librosa / llama-cpp-python` 升级为必需项，确保 Comfy Registry 安装时核心节点（视频加载/快剪、Qwen、TTS）零缺依赖；`transformers` 明确 `>=4.57.1`（Qwen3VLForConditionalGeneration 要求）；`imageio_ffmpeg` 统一横线为 `imageio-ffmpeg`
- **huggingface_hub 降为可选**：从必需清单移除，改为注释标记的可选项，缺失时小珠光所有大模型节点（Qwen/AudioDiT）走本地目录扫描模式，不自动联网下载（与离线版设计一致）
- **requirements.txt 全面重写**：
  - 顶部大标题注释 + 安装指引 `pip install -r requirements.txt`
  - 明确划分为「必需依赖」（缺少插件无法启动或核心节点不可用）与「可选依赖」（按需安装，缺失不影响启动）
  - 每个可选依赖单独一行注释，说明作用与缺失时的降级行为（如 `einops` 仅影响 AudioDiT 推理、`mediapipe`/`insightface` 降级到整图兜底、`flash-attn` 回退到 PyTorch SDPA 等）

**🎬 化神级视频编辑器：使用说明书替换快捷键自定义**

- **移除整套自定义快捷键逻辑**：`_loadShortcuts()` / `_saveShortcuts()` / `_resetShortcuts()` / `_openShortcutSettings()` 及按键录制 handler 全部删除，`_shortcutKeys` 改为直接返回 `_defaultShortcuts()`
- **启动时清理旧缓存**：初始化处 `localStorage.removeItem("xzg_ve_shortcuts")`，清理旧版本用户遗留的自定义键位，避免与固定键位冲突
- **⚙️ → 📖 图标更换**：原「⚙️ 快捷键设置」齿轮按钮替换为**红色书本 SVG 图标**（`<svg viewBox="0 0 24 24">` 双翻页书本，描边色 `#ff5252`），title 改为「使用说明书」
- **全新 `_openManual()` 说明书弹窗**（`z-index:999999`、红色顶边、最大 82vh 滚动），包含 5 大章节：
  1. **基本操作**：导入媒体、拖入时间线、播放预览（逐帧/秒步）、保存/导出/关闭
  2. **时间线编辑**：选择/移动/复制/修剪/分割/删除、磁吸、旗标、缩放、平移、轨道高度调整、撤销重做（每项均标注对应快捷键）
  3. **预览与属性**：预览缩放（Z 重置）、片段属性面板（视频/音频各项调节）、Alt 精调滑条、分辨率帧率设置
  4. **快捷键（固定键位）**：动作名 + 绑定键表格化展示，底部额外说明「←/→ 单帧、Shift+←/→ 按 1 秒按帧率换算」
  5. **导出**：格式（MP4 CRF、MP3 320kbps、WAV/FLAC）、输出目录设置、渲染进度

**🛡 右键菜单隐藏鲁棒性修复**

- `_hideCtxMenu` 的 `hideAll` 事件中，`e.target` 可能是非 Node 对象（如 window 的 blur/resize 事件派发时 `e.target` 为 undefined 或 window），直接调用 `menu.contains(e.target)` 会抛 `TypeError`
- **修复**：解构为 `const t = e && e.target`，再加 `t.nodeType === 1`（元素节点）判断后才走 `menu.contains(t)` 判定，其他情况一律直接隐藏菜单，杜绝偶发报错干扰

**🗂 其他新增与维护**

- 新增 `comfyui.yml` / `editor.yml`：UI 界面元素快照定义（ComfyUI 主界面 + 快剪编辑器元素树引用）
- 版本号统一：`pyproject.toml`、`extension.json` 从 `12.0.0` 升至 `12.1.0`

---

### V12.0.0 (2026-08-18)

**🎬 化神级视频编辑器重磅升级：双视频轨 + 双音频轨（V1/V2/A1/A2）**

- **四轨道架构**：新增 V2 视频轨（叠于 V1 之上）与 A2 音频轨，前端 `clip.track` 字段区分 `v1/v2/a1/a2`，`_yToTrack` 按鼠标 Y 坐标判定目标轨道
- **V2 图像优先覆盖**：`_findClipByGlobalTime` 优先查找 V2 轨道，重叠区画面自动切换为 V2；后端 `render_timeline` 分离 V1/V2，V1 做基底 concat，V2 通过 `setpts` 偏移后逐个 `overlay` 叠加
- **跨轨道拖动**：支持片段在 V1↔V2、A1↔A2 之间垂直拖动切换轨道，拖动时原片段隐藏（`display:none`），仅显示金色虚线预览框；Shift+垂直拖动锁定 X 位置
- **配对片段联动**：拖入带音频的视频媒体（`media.info.has_audio === true`），V2→A2、V1→A1 同步生成金色虚线预览框，位置与宽度完全一致
- **多选拖动独立预览**：Ctrl+多选多轨道片段拖动，每个片段在各自轨道显示独立的金色虚线预览框，同类型片段跟随主片段轨道偏移，不同类型保持原轨道

**🎬 化神级视频编辑器：播放/缩放/间隙/裁剪全面增强**

- **播放循环逐帧查轨**：`_startPlaybackLoop`（视频/图片）与 `_startAudioOnlyPlaybackLoop` 每帧调用 `_findClipByGlobalTime`，自动切换 V2 覆盖画面，修复缩放时播放头与画面错位
- **间隙黑屏替代循环**：`_advanceToNextClip` 按最长轨道算总时长，间隙期直接黑屏，不再错误地回跳重放
- **边界切换无多余帧**：帧推进循环先判定目标帧是否超 `clip.end`，超了就立即切换，修复 V2 结束前多显示一帧的问题；音频起始/结束边界才调用 `_startAudioPlayback`（`_checkAudioBoundary`），正常播放不调用，彻底消除滋滋声
- **裁剪保留轨道字段**：`_splitClipAtPlayhead` / `_splitClipForInsertion` 继承 `clip.track`，修复 V2/A2 裁剪后后半段丢失轨道属性（变灰消失）

**🎬 化神级视频编辑器：时间线 UI/交互大优化**

- **选中高亮边框内缩**：所有轨道选中片段的高亮边框从 clip 外缘向内收（不向外扩展），边框行为统一为 `content-box`，1px 黑边 + 2px 彩边，V2 片段强制 `height:100%` 消除 4px 间隙
- **时间线缩放 Alt+滚轮**：`_tlZoom` 范围 [0.1, 20]，以播放头为中心缩放（`scrollLeft = playheadX - viewWidth/2`），自动 clamp 边界
- **时间码帧计数格式**：播放头时间码由 `MM:SS.cc`（百分秒 0-99）改为 `MM:SS:FF`（帧号 0 到 fps-1），自动进位（30fps 时 5 秒 27 帧 = `00:05:27`，6 秒 0 帧 = `00:06:00`）；媒体库时长/状态提示保持 `MM:SS.cc` 不变
- **精确秒级跳转**：左右箭头单帧移动，Shift+左右箭头按当前帧率移动对应帧数（30fps=30帧、24fps=24帧），精确 1 秒
- **分割手柄整体缩放**：中部分割手柄（视频组 vs 音频组）按组整体压缩/展开，组内轨道按比例分摊压缩，每条轨道硬下限 25px，杜绝被挤出可见区域
- **轨道双击最大化**：双击 V1/V2/A1/A2 轨道头 → 选中轨道铺满显示，其他三轨压缩至 25px；再次双击同轨道恢复四轨均分；恢复默认布局按钮移至 V2 上方左侧功能区（四线 SVG 图标 + 悬停高亮）

**🎬 化神级视频编辑器：旗标 + 批量导出静帧**

- **方旗旗标系统**：工具栏剪刀右侧蓝色方旗按钮 / 快捷键 M → 在播放头位置添加不重复蓝色旗标；右键旗标删除；右键方旗按钮清空所有旗标（状态提示"已清空所有旗标"）；快捷键处自动 `blur()` 避免按钮高亮
- **批量导出静帧**：原「导出帧」统一更名为「批量导出静帧」；有旗标时一键导出所有旗标位置帧（跳过音频片段），文件名格式 `flag_00-05-20.png`
- **导出路径精简**：仅支持「输出目录」或「自定义目录」二选一，移除 `saveas` 手动逐帧选路径；自定义目录模式下先弹一次目录选择框，所有旗标帧静默保存到该目录

**🔊 音频播放稳定性修复 + 默认质量提升**

- **AudioDiT 片段精确时长限制**：`source.start(0, clampedLocal, clip.end - clampedLocal)` 补上第三个 `duration` 参数，修复裁剪后被裁掉部分仍继续发声
- **并发解码去重**：`_startAudioPlayback` 中用 `_audioDecodePending` Set 跟踪正在解码的 clip，`await` 后重检查避免重复并发，修复两片段衔接处第二个无声
- **预解码即将到来的音频**：播放中提前解码 0.3s 内即将开始的音频片段，消除切换延迟
- **MP3 默认 320kbps**：下拉默认项、渲染兜底默认、默认变量、localStorage 回退全部统一为 `320`

**🖼 其他优化与维护**

- 快剪加载器「从快剪加载」按钮改为无背景色，前置 🎬 图标；音频专用加载模式隐藏 V1/V2，仅显示 A1/A2 均分
- 工具栏剪刀/方旗 hover 颜色统一为亮绿色 `rgb(0,255,100)`
- M 键连续添加旗标：`e.stopImmediatePropagation()` 防事件冲突
- 快捷键 S/B/M 触发后自动 `blur()` 对应工具栏按钮，避免意外高亮
- 版本号统一：`pyproject.toml`、`extension.json` 从 `11.7.0` 升至 `12.0.0`

---

### V11.6.0 (2026-08-15)

**🎬 小珠光合并视频节点（视频保存）预览刷新修复：**

- **跨工作流 Tab 预览不刷新核心 Bug**：切换工作流 Tab 时，原 Tab 的节点 + 播放器会被销毁重建，节点级 `executed` 监听器在 `onRemoved` 中被移除，导致后台工作流跑完后视频信息完全丢失，切回 Tab 预览为空，必须手动再运行一次才能刷新
- **修复方案 — 模块级全局视频输出缓存**：借鉴 ComfyUI 原生 `setNodeOutputsByExecutionId` 全局 store 思路，在 `app.registerExtension.init()` 中注册**模块级全局 executed 监听器**（不随节点生命周期销毁），只要工作流执行完成就把视频信息写入 `_xzgVideoOutputCache` Map，key 为节点 id，完全不依赖节点是否存活
- **三重恢复路径**：切回 Tab 重建节点后，通过 ① `onConfigure` rAF 优先读 cache → ② `ResizeObserver` 容器可见时兜底读 cache/properties → ③ `properties._xzgVideoOutput`（工作流保存/加载场景兜底）三层机制确保预览 100% 恢复，不再需要手动再运行
- **API 兼容**：兼容 `output.ui.videos` / `output.video` 两种数据路径，`_lastAppliedKey` 去重避免 onExecuted 与全局 api 事件重复触发
- **ResizeObserver 可见性感知**：Tab 不可见（容器宽高为 0）时只记录 `_pendingVideoUrl`，不立即调用 `player.load()`（否则 canvas 渲染失败导致黑屏）；容器变可见时自动从 pending 或 cache 恢复

**🎬 小珠光视频加载器宽高重置 Bug 修复：**

- **切换工作流宽高被重置为 0**：`_updateRatioWidgets` 在"自定义比例"分支硬编码 `wWidget.value = 0` / `hWidget.value = 0`，但该函数在 `onConfigure` 的 rAF 中被调用，时序为「configure 先恢复数值（如 1024）→ rAF 执行 → 强制重置为 0」，用户设置的分辨率瞬间丢失
- **修复方案**：改为仅在值无效时重置 0 —— 从"边长模式"切来（value 是字符串 "1"-"4"）→ 重置 ✓；configure 恢复的数字 → 保留 ✓；负数 → 重置 0 ✓。VideoLoaderPro 共用同一套逻辑一并修复

**🎬 化神级视频编辑器全面升级（OpenCut 式裁剪 + 桥接手柄 + 历史撤销重做）：**

- **裁剪逻辑全面改写为 OpenCut 模式**：左手柄同步修改 `tlStart` 和 `start`，`end` 不变；右手柄修改 `end`，`tlStart` 和 `start` 不变，彻底替代旧的三模式方向决策逻辑
- **桥接手柄（相邻片段交界处滚动裁剪）**：交界处显示 `←||→` 红色光标（播放头同色 `#ff4444`），触发区域宽 10px（左右各 5px），z-index 高于普通手柄；往右拖=左片段尾扩+右片段头同步右移，往左拖=右片段头扩+左片段尾同步左移，保持相邻且缩略图同步更新
- **片段裁剪拖动期间缩略图循环补全**：`_loadClipThumbs` 中当可用缩略图数量 `inRange.length <= need` 时 `inRange[i % inRange.length]` 循环选取，确保放大时间线后整段有图覆盖
- **吸附阈值加大与新增起点吸附**：拖动/首尾手柄磁吸阈值统一 15px，新增吸附到时间轴起点（0），构建 `clipRects` 检测边缘避免多次吸附冲突
- **从媒体库拖入片段对齐方式**：拖入时鼠标 X 对齐片段最左侧；Alt+拖动复制时鼠标对齐片段中心点；拖入预览仅显示半透明金色虚线边框（不显示缩略图），移除浏览器默认半透明拖动缩略图
- **空格键播放/暂停修复**：在 keydown capture 阶段监听，按住空格忽略 `e.repeat`，焦点在播放按钮上时跳过处理，避免播放↔暂停相互抵消
- **播放头交互精简**：`pointer-events: none`，移除点击轨道空白处跳转逻辑，避免与片段选中冲突
- **片段选中优化**：`_updateClipSelection()` 仅遍历现有 DOM 切换 `xzg-ve-selected` class，不重建 DOM 或重新加载缩略图；清空选中同样只切 class
- **完整撤销/重做支持**：所有修改操作（添加/分割/删除/移动/复制片段、手柄裁剪、桥接手柄裁剪）统一调用 `_pushHistory()` 记录状态，支持 Ctrl+Z 撤销、Ctrl+Shift+Z/Ctrl+Y 重做
- **时间线缩放锁定**：裁剪手柄按下时设置 `_tlBaseLocked=true`，阻止自适应重新计算 `pxPerSec` 导致片段缩放；拖动期间直接更新 DOM `width/left`，通过 `transform: translateX(-offset)` 实现左侧裁剪视觉效果，不重建 DOM 避免缩略图闪烁

**🖼 其他优化与维护：**

- `web/lib/mediabunny.min.mjs`：新增视频解码库（MediaBunny）
- `web/xzg_frame_decoder.js`：新增帧解码器，配合视频播放器实现高效解码
- 版本号统一：`pyproject.toml`、`extension.json` 从 `11.5.8` 升至 `11.6.0`

---

### V11.5.8 (2026-08-14)

**🎛️ 小珠光选择器节点全面优化：**

- **尺寸默认值统一**：新建节点初始高度固定 58px；自然高度计算公式从 `contentH + 38` 调整为 `contentH + 28`，确保默认 1 行节点始终为 58px，不再出现"恢复默认后节点高度被弹回68px"的问题
- **恢复默认按钮**：同时重置节点宽度为 210px、高度为 58px，与新建节点尺寸完全一致
- **字体默认颜色**：新建节点字体颜色默认 `#FFFFFF`（白色），与设置面板默认值保持一致，修复旧 DEFAULT_SETTINGS 中使用灰色 `#aaa` 导致新建节点文字发白不明显的问题
- **滑条/间距调整行为**：调整标签间距、字体大小时，节点尺寸不再突变跳回 210×58，保持用户自定义大小不变

**🖼 小珠光图像保存节点 Bug 修复：**

- **预览模式核心 Bug**：修复切换到"预览"模式后仍然保存图片到输出目录的严重问题。根因是前端 `_normModeVal` 序列化函数只匹配了 `"preview"`（小写p），但切换按钮写入的是 `"Preview"`（大写P），导致后端始终收到 `mode="Save"`。现已同时匹配 `"预览" / "Preview" / "preview"` 三种写法
- **化神级节点同步生效**：两个图像保存节点（普通版 + 化神级自定义输出版）共享同一前端逻辑，此修复对两个节点同时有效

**🖼 小珠光图像保存-化神级节点清理与修复：**

- **清理死代码**：移除函数签名中未在 INPUT_TYPES 声明的 `output_path` 参数，避免混淆
- **相对路径 base_dir 修复**：自定义输出模式下，当 `base_dir` 为相对路径（如 `"my_folder"` 或 `"{date}"`）时，之前因 `resolved_path` 始终为空导致文件被错误保存到 output 根目录。现已简化为：绝对路径 → 直接使用；相对路径 → 正确拼接到 `ComfyUI output/` 下；空 → output/ 根目录
- **路径分支逻辑精简**：删除 `resolved_path` 相关的无用分支（三选一判定中有两个分支永远不可达）

**🔧 其他优化与维护：**

- `locales/zh/nodeDefs.json`：选择器输出端口名"数值"已改为 `*` 占位，更简洁
- `xzg_group.js`：视觉编组代码大幅重构精简（-1200+ 行），移除冗余逻辑
- `xzg_audiodit_tts.py`、`xzg_longcat_model_cache.py`、`xzg_qwen_loader.py`、`xzg_workflows.js`：多处细节调优与稳定性修复
- 版本号统一：`extension.json` 从 `11.5.0` 升至 `11.5.8`，与 `pyproject.toml` 同步

---

### V11.4.0 (2026-08-11)

**🎵 小珠光音频加载器全面升级：**

- **上传大小限制**：与官方一致，通过 `/features` 端点获取 `max_upload_size`，前端预检 + 服务端 HTTP 413 兜底双重校验
- **解码进度条动画**：新增后台线程解码进度端点，前端 Canvas 绘制**音符律动风格均衡器条**动画，多频率叠加实现自然律动感，进度联动调整幅度，底部金色→顶部亮金渐变色
- **解码动画最短时长**：已完成解码后动画至少持续 0.3 秒（300ms），避免动画闪烁
- **动画宽度与竖条优化**：整体宽度拉宽，竖条调细，视觉更轻盈
- **多色彩支持**：音轨波形颜色支持红、橙、青、绿等多种配色
- **拖入上传功能**：支持直接将音频文件拖拽到节点上完成上传，通过 `convertEventToCanvasOffset` 转换坐标 + `onDragOver`/`onDragDrop` 回调实现
- **双击上传区域扩展**：虚线以上（播放条区域）双击同样支持上传音频，与虚线以下区域保持一致
- **禁止拖动移动节点**：音轨点击区域禁止拖动节点本体，避免误操作
- **播放头交互优化**：白色播放头始终可见；点击波形任意位置跳转播放；播放头支持拖拽调整；波形中线上下分区：上半区按下即切换播放/暂停（无延迟），下半区点击或拖动移动播放头；双击波形触发上传
- **音频播放头默认位置**：新生成音频播放头默认位于起始位置 0，而非中间

**🎬 小珠光视频加载器大文件支持：**

- **分块上传实现**：参考官方 Load Video UI，将大文件切分为 **20MB 固定块**，**3 路并发**上传，每块支持**重试 3 次**，支持服务端偏移量写入与会话管理
- **1GB 大小限制**：严格限制单视频最大 1GB，超出立即报错
- **自定义上传限制对话框**：与音频加载器风格一致，使用插件内对话框而非浏览器原生 alert，视觉统一
- **进度条显示精简**：只显示「上传视频中...」文案、进度条和百分比，隐藏「XX/XX 分块」等技术细节，用户体验更清爽
- **视频预览交互**：鼠标悬停视频帧显示手型指针；单击切换播放/暂停；双击触发新视频上传；仅实际视频帧区域响应点击（黑边区域不触发）；播放条与播放信息始终可见；白色时间码与帧计数显示在播放条上方右侧

**🌱 新增小珠光随机种子节点：**

- 新增 `XiaozhuguangSeed` 节点（双语显示：小珠光随机种子 / Xiaozhuguang Seed）
- 使用 `_xzgQueuePromptIntercepted` 标志防止重复拦截
- 支持标准 seed 输入与随机化功能

**🖼 图像加载器 / 保存器优化：**

- 图像加载器、图像保存、图像保存-化神级节点多处功能增强与 bug 修复
- 节点中英双语翻译同步更新（`locales/en/nodeDefs.json`、`locales/zh/nodeDefs.json`）

**📚 文档与国际化：**

- 节点功能中英双语显示名同步维护，符合 ComfyUI 官方 i18n 规范

---

### V9.4.0 (2026-07-30)

**🎉 重磅新增：小珠光文本框节点（双通道文本输出 + 数字智能转中文）**

- 双通道输出：
  - `text`：原始文本原样输出，便于其他节点直接复用
  - `text_zh_num`：数字转中文后的文本，默认始终开启，可作为 AI 绘图提示词的中文描述
- 四条智能转换规则：
  1. **乘积 / 分辨率**（按位读 + 乘以 连接）：`1280x720 → 一二八零乘以七二零`、`1920×1080 → 一九二零乘以一零八零`、`1x2x3 → 一乘以二乘以三`，支持乘号 `x / X / × / *`（前后可带空格）
  2. **数字 + 量词 / 单位**（完整读数 + 英文缩写自动转中文）：`12岁 → 十二岁`、`188cm → 一百八十八厘米`、`75kg → 七十五千克`、`36.5℃ → 三十六点五摄氏度`、`220V → 二百二十伏`、`12% → 百分之十二`、`3小时 → 三小时` 等（覆盖年龄、长度、重量、温度/电学/容量/货币/时间/百分比等白名单）
  3. **第 / 其 前缀（序数）**：`第12章 → 第十二章`、`第1名 → 第一名`、`第5届 → 第五届`
  4. **其他（纯编号/代码/串号）按位读**：`型号1280 → 型号一二八零`、`12 → 一二`
- 英文公制/物理单位自动转中文：`cm → 厘米`、`kg → 千克`、`km → 千米`、`mm → 毫米`、`L/mL → 升/毫升`、`V/A/W/℃/℉/Ω/Pa…` 等均有对应转换
- 空输入时 placeholder 显示完整使用说明 + 全部转换示例，节点显示名双语（「小珠光文本框 / Xiaozhuguang Text Box」）

**文档更新：**
- README 功能特性总览表新增「文本框（数字→中文）」
- README 节点汇总表新增「小珠光文本框」
- README 新增独立章节「📝 小珠光文本框（数字转中文）」，含双通道输出说明与四条转换规则对照表
- README 文件结构中新增 `nodes/xzg_text_box.py`

---

### V9.3.0 (2026-07-30)

**编组拖动跟随缺陷修复：**
- 编组全部节点选中后拖动时，新增「拖动会话锁定」机制：一旦进入真实拖动（|dx|>0.0001 或 |dy|>0.0001），锁定本次涉及的编组 GID 与初始选中快照，拖动过程中不再重新计算完全选中编组集合，避免编组框碰到其他节点时被 `syncNodeMembership`（每 10 帧自动添加框内节点到 group.nodeIds）意外破坏，导致编组框突然停止跟随
- 拖动锁定在鼠标松开、按 Esc、或实际选择集合发生变化时自动释放

**视频播放条视觉优化：**
- 播放条金色改为白色，高度缩减 50%；默认轨道为暗白色，进度填充亮白色，拖动播放头与结束/暂停状态下进度填充始终保持亮白色不再消失
- 新增播放头位置「极小激光亮点」效果：3px×3px 白色圆点，位于进度边界精确位置，配备 `xzgLaserPulse` 呼吸脉冲动画，辉光层数与强度较初版降低 45%–60%

**API 修复：**
- `xzg_get_output_dir` 路由函数补齐 `request` 形参，解决 aiohttp 自动注入 request 对象时 `takes 0 positional arguments but 1 was given` 的 TypeError

---

### V9.2.0 (2026-07-29)

**界面交互优化：**
- 工作流面板：左侧分类联动时，激活分类自动滚动至左侧列表可视区**正中央**，并在面板容器内居中（不影响整页滚动）
- 主题面板（快捷键 `C`）：「应用主题并关闭」「恢复默认颜色」「导出」「导入」「快捷键」按钮统一为**仅边框、无底色**风格，与其他面板一致
- 主题面板按钮圆角统一为 4px，视觉更协调

**文档更新：**
- README 新增「田字格对齐」完整功能说明（6 种对齐、4 种分布、拖拽尺子、长按自动布局）
- 节点收藏移除过时的「评分星标」描述，更新为「最近使用」排序

**国际化：**
- 上述界面文案均遵循 ComfyUI 官方 i18n 规范，中英文界面自动切换

### V9.1.0 / V5.1.0 (2026-07-17 ~ 2026-07-24)

**工作流加载安全与体验修复：**
- 修复反复快速点击工作流导致画布图与官方标签/保存目标不一致的竞态 bug（避免两个工作流被覆盖成一样）
- 加载改为串行队列 + 代际校验：同一时刻仅一个加载在跑，连点只加载最后一次点击的目标，杜绝画布被旧图覆盖
- 修复已打开工作流反复点击会虚增使用频率的问题：已打开/已激活的仅切换画布、不再累加频率

**夺舍模式（接管官方工作流 UI）优化：**
- 提前初始化，刷新浏览器后无需先打开面板即可隐藏官方按钮
- 隐藏范围覆盖侧边栏官方「工作流」标签、顶栏「进入应用模式」「图像」按钮，且不影响画布上方工作流切换标签
- 激活态风格由绿色改为红色

### V4.0.0 (2026-07-15)

**重磅新增：工作流管理功能**
- 完整的工作流管理面板，支持保存、加载、重命名、删除工作流
- 支持**多级嵌套文件夹**分类，右键新建分类/子分类
- 工作流拖拽到画布直接导入节点
- 单击工作流加载到当前画布，已打开的工作流自动切换（不重复加载）
- 支持**拼音搜索**（首字母 + 完整拼音），搜索自动忽略空格
- 多种排序方式：使用频率 / 名称
- 「根目录未分类」自动归类未放入文件夹的工作流
- 默认快捷键 `` ` ``（反引号），可自定义
- 后端 API 完整支持，数据持久化存储到 user/default/workflows 目录

**节点收藏优化：**
- 移除星标评分功能，简化界面
- 新增「最近使用」排序方式
- 搜索自动忽略空格，提升匹配体验
- 拖拽节点时搜索栏自动失焦

**主题面板优化：**
- 快速节点功能增强与修复
- 界面细节优化

**修复与优化：**
- 多处 UI 细节调整，用户体验持续优化

### V3.0.0 (2026-07-14)

**新增：自定义快速节点功能**
- 节点右键菜单「添加到快速节点/从快速节点移除」（位于「小珠光主题」上方）
- 从节点拉出连线时，菜单顶部显示自定义快速节点，点击自动创建并连线
- 搜索框顶部快速显示自定义快速节点列表
- 小珠光主题面板新增「快速节点」Tab 管理界面
  - 支持拖拽排序
  - 支持单个移除和一键清空
  - 支持配置导出/导入（JSON 格式）
- 支持「夺舍模式」隐藏系统默认连线菜单（仅显示自定义快速节点）
- 最多支持 20 个快速节点，配置自动保存到本地存储

**修复：**
- 布尔选择器颜色选择器弹出位置不一致问题（改为靠近元素弹出）
- 开关按钮样式重叠问题
- 菜单项翻译后无法被收集导致搜索不到的问题

### v1.8.2 (2026-07-10)

**新增：**
- 选中输出节点按 `D` 键：快速执行选中的输出节点及其依赖
  - 优先调用 rgthree 的排队功能（如果已安装）
  - 内置独立实现，不依赖 rgthree 也可使用
- 编组功能新增 `F` 键快捷键：鼠标位于编组内按 F 执行框内节点
  - 支持嵌套编组，自动包含子编组内的输出节点
  - 优先调用 rgthree 的排队功能（如果已安装）
- 完善同级别反选模式说明
  - 标题栏左侧 1/5：点击的编组开启，同级其他全部绕过
  - 标题栏右侧 1/5：点击的编组绕过，同级其他全部开启

### v1.5.3 (2026-07-07)

**新增：**
- 编组锁定功能：
  - 标题栏删除按钮左侧新增锁图标，点击切换锁定/解锁
  - 锁定后禁止拖拽和调整大小，锁图标显示红色
  - 锁定状态随工作流持久化保存
  - Ctrl+鼠标左键点击锁图标：一键锁定/解锁所有编组
- 编组支持复制粘贴：
  - 复制粘贴节点时自动携带编组框
  - 新编组自动继承原编组的标题、颜色、样式等属性
  - 编组边界根据粘贴位置自动计算

### v1.5.2 (2026-07-07)

**新增：**
- 收藏栏右侧增加拖动调节宽度功能：
  - 面板右边缘新增拖拽手柄，鼠标拖动即可调整收藏栏宽度
  - 宽度范围限制 280px ~ 800px，防止过窄或过宽
  - 宽度自动持久化保存，下次打开恢复上次宽度
  - 修复原有浮动式 resizer 手柄不随面板移动的 bug，改用面板子元素方式实现

### v1.4.0 (2026-07-05)

**新增：**
- 标题编辑面板全面重构：
  - 新增「高级」折叠区域（背景、辉光、炫彩），默认折叠，可点击展开
  - 背景色支持透明度滑条（5%-100%）和圆角滑条（0-30px）
  - 色调色条高度加宽一倍（10px → 20px）
  - 新增编辑状态实时预览颜色变化
  - 编辑面板拦截浏览器右键菜单
  - 编辑面板点击空白处关闭，拖拽超出面板不关闭
- 标题节点支持左/右/居中对齐，边距统一为2px
- 文字垂直居中改用 textBaseline=middle，避免偏移
- 双击编辑时高级选项自动展开（有选项开启时）
- 关闭所有高级选项时自动折叠回"高级"按钮
- 编辑面板新增「使用说明」按钮，金色高亮
- 编组设置面板新增「使用说明」按钮，金色高亮
- 分类上下移动修正：交换数组位置而非仅交换 order 值
- 数字输入框取消上下箭头（多值定格填写框）

**优化：**
- 标题默认文字恢复为"双击编辑"
- 新建标题默认文本简化
- 编辑和正常状态文字位置完全对齐（消除1px偏移）
- 背景色开启时，关闭 auto-size，可自由拖拽缩放

### v1.3.0 (2026-07-04)

**优化：**
- 选择器设置面板布局全面重构：
  - 颜色控件重排：文字颜色、标签底色合并到第一行
  - 渐变方向改为紧凑符号下拉（→/↓/●）
  - 统一面板间距，改善视觉一致性
  - 面板宽度优化（520px → 460px）
  - 颜色选择器改为28x28小方块节省空间
  - 减小滑条行距和长度，更紧凑
- 文字颜色标签改为中文"文字颜色"，默认色改为白色

**修复：**
- 修复选择器颜色调整不能即时预览的问题
  - 移除了使用未定义变量的死代码（`applyPreviewColors`）
  - 新增轻量级 `applyColorPreview`，颜色变更时即时刷新Canvas
  - 文字颜色、标签底色新增事件监听，实现实时预览
- 修复渐变方向选择器事件处理（恢复change事件）

**其他：**
- 移除渐变方向按钮相关CSS样式（已改用下拉选择器）

---

### v1.2.0 (2026-07-03)

**新增：**
- 新增「小珠光布尔」节点，开关切换输出 0/1 整数值
- 设置面板弹出定位 Skill 文档 (`docs/skill-panel-alignment.txt`)

**修复：**
- 点编辑器大下巴问题：统一 `computeSize` 与 container 高度控制逻辑
- 布尔选择器标签文字长度自适应节点宽度
- 布尔选择器设置面板实时预览时同步更新节点边框尺寸
- 未选中标签颜色过暗 (#555 → #aaa)
- 标签字号上限提升 (24 → 50)

**优化：**
- 右键菜单位置排序统一规范：
  - 滑条/布尔/选择器设置：永远第 1 行 (`splice(0,0)`)
  - 收藏/取消收藏：永远第 7 行 (`splice(6,0)`)
  - 小珠光主题设置：永远第 13 行 (`splice(12,0)`)
- 设置面板弹出对齐节点（参考滑条规则），避免遮挡
- 布尔节点支持拖拽调整大小
- 布尔输出类型从 BOOLEAN 改为 INT（兼容性更好）
- 选择器右键菜单改用标准 `getExtraMenuOptions`，不再覆盖原型

---

## 📝 许可证

[MIT License](LICENSE)

---

> 💡 如有问题或建议，欢迎在 GitHub 提 Issue 或 PR。

