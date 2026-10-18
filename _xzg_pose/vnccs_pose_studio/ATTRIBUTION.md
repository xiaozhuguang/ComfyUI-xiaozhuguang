# 姿势编辑器第三方许可与归属

来源链：上游项目 [AHEKOT/ComfyUI_VNCCS_Utils](https://github.com/AHEKOT/ComfyUI_VNCCS_Utils) → 基于上游项目的本机派生版 `ComfyUI_VNCCS_Utils-XZG` → 并入 `ComfyUI-xiaozhuguang` 总插件。

本目录代码是从上述本机派生版移植并适配到总插件的；更上游的代码来源为 AHEKOT 项目。适配、合并或改名不会取消第三方原有版权和各组件许可。分发时应保留相关上游版权声明及许可文本。

## Pose Studio

- AHEKOT 上游仓库标注 MIT License，随附版权行为 Copyright (c) 2025 MiuProject；可在上游 `LICENSE` 核对。
- 本目录的 `LICENSE` 保留了本次移植源目录所附 MIT 声明。来源链中间的 XZG 派生版由本插件维护者提供；本说明不把其贡献误记为上游作者贡献。
- 分发时保留源许可证中的版权行和完整 MIT 文本，并在适当位置注明本插件对移植代码所作的修改。

## SAM 3D Body

- SAM 3D Body 代码及相关材料由 Meta Platforms, Inc. and affiliates 提供。
- 适用 Meta SAM License；另有 MHR 部分适用 Apache License 2.0。
- 完整条款、NOTICE 和第三方归属见 `vnccs_sam3d/licenses/` 中的 `LICENSE`、`LICENSE-SAM`、`LICENSE-MIT`、`LICENSE-MHR`、`NOTICE-MHR` 和 `THIRD_PARTY_NOTICES`。
- SAM License 包含使用与再分发条件；分发 SAM 材料前应阅读并遵守该许可。

## 浏览器资源

- 插件根目录的 `web/vnccs_pose_vendor/spark/`：SparkJS 与 Three.js 的来源、版本和归属见该目录的 `README.md`、`LICENSE.spark` 和 `LICENSE.three`。
- 插件根目录的 `web/pose_studio/assets/pose_studio_makehuman.v2.bin.gz`：MakeHuman 衍生资源。许可说明见同目录的 `pose_studio_makehuman.v2.LICENSE.md` 和 `pose_studio_makehuman.v2.CC0-1.0.md`。
- 前端统一由插件根目录的 `web/` 提供；本后端子包不再保留上游重复的 `web/` 副本。

## 源项目

- AHEKOT 上游：[https://github.com/AHEKOT/ComfyUI_VNCCS_Utils](https://github.com/AHEKOT/ComfyUI_VNCCS_Utils)
- 本次移植输入：本机 `ComfyUI_VNCCS_Utils-XZG` 派生目录中的 Pose Studio 组件。
- 移植目标：`ComfyUI-xiaozhuguang` 总插件；节点显示名改为“小珠光VNCCS姿势编辑器”。

## 分发清单

分发包含本姿势编辑器的副本或实质部分时，应保留与该部分对应的版权声明、许可证文本和 NOTICE。顶层插件的 `LICENSE` 只声明小珠光主插件部分的许可，不替代本文件所列第三方组件的许可。
