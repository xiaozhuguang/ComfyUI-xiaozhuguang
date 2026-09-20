"""
小珠光音频保存（精简版）
========================

与化神级共用保存/波形预览能力，但不提供「导出到达芬奇」「发送到快剪」高级功能：
- INPUT_TYPES 去掉「自动发送到快剪」「自动导出到达芬奇」两个开关
- save_audio 沿用父类（开关缺省 False，不触发达芬奇导入 / 快剪入库）

高级导出功能仅「小珠光音频保存-化神级」（XiaozhuguangAudioSaveDaVinci）具备。
前端（web/xzg_audio_save.js）据此节点类型区分：波形预览两者都有，
达芬奇/快剪悬浮按钮与右键菜单项仅化神级显示。
"""

from .xzg_audio_save import XiaozhuguangAudioSaveDaVinci


class XiaozhuguangAudioSave(XiaozhuguangAudioSaveDaVinci):
    """小珠光音频保存：精简版——仅基础保存/预览，无达芬奇/快剪导出。"""

    DESCRIPTION = (
        "小珠光音频保存：将 AUDIO tensor 保存为 MP3/WAV/FLAC（精简版）。\n"
        "（精简版无「导出到达芬奇」「发送到快剪」；需要这些功能请用化神级节点）"
    )

    @classmethod
    def INPUT_TYPES(cls):
        base = super().INPUT_TYPES()
        # 去掉高级导出开关，仅保留基础参数
        base["optional"].pop("自动发送到快剪", None)
        base["optional"].pop("自动导出到达芬奇", None)
        return base
