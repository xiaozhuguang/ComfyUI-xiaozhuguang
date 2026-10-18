# VNCCS 工具集 XZG

本 ComfyUI 扩展复刻 VNCCS Utils 中的 Pose Studio（姿势工作室）：在浏览器中调整 3D 人体姿势、体型、灯光和相机，管理姿势库，并制作关键帧动画或从图片导入姿势。

本扩展不包含 UniCanvas、Prompt Designer、3D Factory、BBox Extractor 和其他 VNCCS 工具节点。当前处于忠实复刻阶段；确认复制的工作流和行为后，再逐步改进。

使用说明：[Pose Studio](docs/VNCCS_POSE_STUDIO_USAGE.md)、[交互设计约定](docs/WIDGET_DESIGN.md)。

姿势图片导入所需模型统一保存在 `ComfyUI/models/vnccs-xzg/`：SAM 3D Body 位于 `sam3dbody/`，BiRefNet Lite 位于 `birefnet/BiRefNet_lite/`。首次使用时如果文件缺失，会下载到对应目录。旧目录 `models/sam3dbody/` 和 `models/birefnet/BiRefNet_lite/` 仍可读取；迁移已有模型时，保持各自子目录结构即可。
