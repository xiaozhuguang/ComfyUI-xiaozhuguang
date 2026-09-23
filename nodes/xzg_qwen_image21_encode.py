"""稳定端口版 Text Encode Qwen Image 2.1。

原生节点使用 Autogrow 图片端口，转换/解开子图时端口会随中间连接状态收缩。
本节点固定提供 10 个 image_N 端口，端口序号永不变化，保证子图往返连线稳定。
"""
import math

import torch
import node_helpers
import comfy.model_management
import comfy.utils


class XiaozhuguangTextEncodeQwenImage21:
    MAX_IMAGES = 10

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            "vae": ("VAE",),
        }
        for i in range(1, cls.MAX_IMAGES + 1):
            optional[f"image_{i}"] = ("IMAGE",)
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True}),
                "negative_prompt": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": True}),
                "resolution": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 32}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "negative", "latent")
    FUNCTION = "encode"
    CATEGORY = "xiaozhuguang/Qwen Image"
    DESCRIPTION = "稳定端口版 Qwen Image 2.1 文本编码；固定 16 个图片输入，支持安全转换/解开子图。"

    def encode(self, clip, prompt, negative_prompt, resolution=1024, vae=None, **kwargs):
        ref_latents = []
        images_vl = []
        latent_w = latent_h = resolution or 1024

        for i in range(1, self.MAX_IMAGES + 1):
            image = kwargs.get(f"image_{i}")
            if image is None:
                continue
            samples = image[:1].movedim(-1, 1)
            if resolution > 0:
                ratio = samples.shape[3] / samples.shape[2]
                width = round(math.sqrt(resolution * resolution * ratio) / 32) * 32
                height = round(math.sqrt(resolution * resolution / ratio) / 32) * 32
            else:
                width = round(samples.shape[3] / 32) * 32
                height = round(samples.shape[2] / 32) * 32
            width, height = max(32, width), max(32, height)
            if (width, height) == (samples.shape[3], samples.shape[2]):
                scaled = image[:1]
            else:
                scaled = comfy.utils.common_upscale(samples, width, height, "lanczos", "disabled").movedim(1, -1)
            if not images_vl:
                latent_w, latent_h = width, height
            rgb = scaled[:, :, :, :3]
            if scaled.shape[-1] > 3:
                rgb = rgb * scaled[:, :, :, 3:] + (1.0 - scaled[:, :, :, 3:])
            images_vl.append(rgb)
            if vae is not None:
                ref_latents.append(vae.encode(scaled))

        keep_vision = len(ref_latents) == 0
        positive = clip.encode_from_tokens_scheduled(
            clip.tokenize(prompt, images=images_vl, keep_vision=keep_vision, prevent_empty_text=True)
        )
        negative = clip.encode_from_tokens_scheduled(
            clip.tokenize(negative_prompt, images=images_vl, keep_vision=keep_vision, prevent_empty_text=True)
        )
        if ref_latents:
            positive = node_helpers.conditioning_set_values(positive, {"reference_latents": ref_latents}, append=True)
            negative = node_helpers.conditioning_set_values(negative, {"reference_latents": ref_latents}, append=True)
        latent = torch.zeros(
            [1, 64, latent_h // 16, latent_w // 16],
            device=comfy.model_management.intermediate_device(),
        )
        return positive, negative, {"samples": latent}
