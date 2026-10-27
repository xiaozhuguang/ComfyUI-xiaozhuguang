"""MiniMax H3 reference conditioning with fixed sockets for subgraph round trips."""

import nodes
from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo


class XiaozhuguangMiniMaxH3ReferenceToVideo:
    REFERENCE_INPUTS = (
        ("ref_images", "ref_image", "IMAGE", 9),
        ("ref_videos", "ref_video", "IMAGE", 3),
        ("ref_video_audios", "ref_video_audio", "AUDIO", 3),
        ("ref_audios", "ref_audio", "AUDIO", 3),
    )

    @classmethod
    def INPUT_TYPES(cls):
        optional = {"vae": ("VAE",), "audio_vae": ("VAE",)}
        for _, prefix, input_type, count in cls.REFERENCE_INPUTS:
            for index in range(count):
                optional[f"{prefix}_{index}"] = (input_type,)
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True}),
                "width": ("INT", {"default": 1344, "min": 32, "max": nodes.MAX_RESOLUTION, "step": 32}),
                "height": ("INT", {"default": 768, "min": 32, "max": nodes.MAX_RESOLUTION, "step": 32}),
                "length": ("INT", {"default": 124, "min": 5, "max": 3600, "step": 17}),
                "ref_image_size": (["match", "max"], {"default": "match"}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "LATENT")
    FUNCTION = "encode"
    CATEGORY = "小珠光/其他"
    DESCRIPTION = "MiniMax H3 参考转视频稳定端口版；固定 9 个图片、3 个视频、3 个视频音轨和 3 个音频输入，支持转换/解开子图。视频和对应音轨按相同编号配对，提示词使用 <Picture i> / <Video k> / <Audio j>。"

    def encode(self, clip, prompt, width, height, length, ref_image_size="match",
               vae=None, audio_vae=None, **kwargs):
        references = {}
        for group, prefix, _, count in self.REFERENCE_INPUTS:
            references[group] = {
                f"{prefix}_{index}": kwargs[f"{prefix}_{index}"]
                for index in range(count)
                if kwargs.get(f"{prefix}_{index}") is not None
            }
        return MiniMaxH3ReferenceToVideo.execute(
            clip=clip, prompt=prompt, width=width, height=height, length=length,
            ref_image_size=ref_image_size, vae=vae, audio_vae=audio_vae, **references,
        ).result
