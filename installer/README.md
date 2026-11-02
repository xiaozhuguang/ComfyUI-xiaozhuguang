# 小珠光依赖安装器（Windows）

双击插件根目录的 `一键安装依赖.exe`。仅显示安装界面，不弹出命令窗口。
无需先加载插件，也不要求Python安装Tk。EXE为轻量启动器，须与installer目录一起保留。

1. 确认Python为ComfyUI实际使用的环境，支持常见整合包、便携版和venv自动寻找。
2. 选择下载源。默认检测官方、清华、阿里云的可达性和响应速度；也可指定HTTPS源。
3. 选择基础或完整依赖，点击检查查看预检结果，或直接点击安装（会先预检）。

安装前关闭ComfyUI。当前环境必须已有PyTorch和torchvision；本工具不创建ComfyUI环境。
固定已有torch、torchvision、torchaudio和NumPy版本，发现冲突即停止，不强制覆盖。
只接受兼容二进制轮子，不在用户环境临时编译CUDA组件。

基础范围包含插件加载、图像/视频常用依赖。完整范围还包含姿势、插帧、水印检测等依赖。
依赖从插件requirements.txt读取，不自动下载安装模型权重。
Qwen专用llama轮子只在仓库支持的Windows/Python3.12/CUDA13环境匹配；已有轮子保留。
CuPy按PyTorch编译CUDA主版本选择12或13轮子，由pip预检可用性。
无法匹配的特殊功能会明确列为未适配，不将“部分完成”显示成全部成功。

普通包使用所选下载源，专用轮子保留其原始下载地址。源选择只影响本次命令，
不改全局pip配置，也不绕过HTTPS证书验证。
检查阶段可能下载包元数据或轮子到pip缓存，但不安装包。

设置与日志保存在 `%LOCALAPPDATA%\XiaozhuguangInstaller`，不放入插件目录。
失败时可切换源后重试；已满足版本的包跳过。pip不是事务安装工具，失败时可能有部分包已安装，
此时日志与下次检查会反映实际状态。本工具不修改原有ComfyUI-Manager的install.py入口。

开发验证：`powershell -NoProfile -STA -File installer\install.ps1 -ValidateOnly`。
重新构建EXE：`powershell -NoProfile -File installer\build.ps1`，使用系统.NET Framework编译器，无需下载打包工具。
命令行检查：使用目标Python运行 `installer/engine.py --action check --profile base --source auto`。
