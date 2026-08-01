"""
小珠光 AudioDiT TTS 节点集合（离线版）
Xiaozhuguang AudioDiT Offline TTS Nodes
----------------------------------------
两个节点，与原 LongCat-AudioDIT-TTS 共享同一 audiodit 建模库 & 模型目录，
但完全剥离「运行时自动 HuggingFace 下载」行为（默认严格离线）：

  · XzgAudioDiTVoiceCloneTTS  —— LongCat 音色克隆 TTS（离线版，自动分句支持长文本）
  · XzgAudioDiTMultiSpeakerTTS —— 多人对话 TTS（离线版，v3 IO，兼容版）

节点分类："小珠光_音频"
节点显示名（双语）：
  "小珠光 LongCat / Xiaozhuguang LongCat"
  "小珠光 AudioDiT 多人对话TTS / Xiaozhuguang AudioDiT Multi-Speaker TTS"
"""

from __future__ import annotations

import logging
import re
from typing import Any, Tuple

import numpy as np
import torch
import torch.nn.functional as F

# —— 依赖我们自己的离线加载器 ——
from .xzg_audiodit_loader import (
    TOKENIZER_AUTO_OPTION,
    approx_duration_from_text,
    load_model_xzg,
    normalize_text,
    numpy_audio_to_comfy,
    register_folder_xzg,
    resolve_device,
    scan_local_models,
    tokenizer_names_or_default,
)

# —— 复用移植到本插件内部的 model_cache 工具（缓存、卸载、动态显存） ——
from .xzg_longcat_model_cache import (
    cancel_event,
    get_cache_key,
    get_cached_model,
    is_offloaded,
    offload_model_to_cpu,
    resume_model_to_cuda,
    set_cached_model,
    set_keep_loaded,
    unload_model,
)


logger = logging.getLogger("XiaozhuguangAudioDiT")

# —— 启动时注册 folder_paths 目录（与原插件共享） ——
register_folder_xzg()


# ---------------- Comfy 环境 / 进度条 ----------------
try:
    from comfy.utils import ProgressBar  # type: ignore
    _PBAR = True
except Exception:
    _PBAR = False

try:
    import comfy.model_management as mm  # type: ignore
    _MM = True
except Exception:
    _MM = False

try:
    from comfy_api.latest import IO  # type: ignore
    _V3 = True
except Exception:
    _V3 = False

MAX_SPEAKERS = 10


# ---------------- 共享辅助函数 ----------------
def comfy_audio_to_tensor(audio_dict: dict, target_sr: int) -> torch.Tensor:
    waveform = audio_dict["waveform"]
    source_sr = audio_dict["sample_rate"]
    wav = waveform[0].float()
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    elif wav.shape[0] == 1:
        pass
    else:
        wav = wav.unsqueeze(0)
    wav_np = wav.squeeze(0).numpy()
    if source_sr != target_sr:
        import librosa  # type: ignore
        wav_np = librosa.resample(wav_np, orig_sr=source_sr, target_sr=target_sr)
    return torch.from_numpy(wav_np).unsqueeze(0)


def _model_names_or_default() -> list[str]:
    """扫描本地模型；若为空，给一个占位项并记录 warning（便于用户知道怎么放目录）。"""
    names = scan_local_models()
    if not names:
        base = (
            __import__("pathlib").Path(__file__).resolve().parent.parent.parent
            / "models"
            / "audiodit"
        )
        try:
            import folder_paths  # type: ignore
            base = __import__("pathlib").Path(folder_paths.models_dir) / "audiodit"
        except Exception:
            pass
        logger.warning(
            "[小珠光AudioDiT] 未检测到任何本地模型。\n"
            "请把模型目录放到: %s\n"
            "常见的目录名示例: LongCat-AudioDiT-3.5B-bf16 / LongCat-AudioDiT-1B / ...",
            base,
        )
        return ["（请先放入本地模型到 ComfyUI/models/audiodit/）"]
    return names


def _interrupt_check():
    if _MM:
        try:
            mm.throw_exception_if_processing_interrupted()
        except Exception:
            cancel_event.set()
            raise


# ---------------- 长文本分句工具 ----------------
def _split_text_into_segments(
    text: str,
    available_duration: float,
    sr: int,
    full_hop: int,
) -> list[tuple[str, int]]:
    """
    将长文本按标点切分为多个小段，每段时长不超过 available_duration。
    返回 [(segment_text, duration_in_latent_frames), ...]

    策略：
    1. 按句末标点（。！？.!?；;）切分
    2. 单句超长则按逗号/冒号切分
    3. 仍超长则按字数硬切
    4. 将短句合批，尽量填满 available_duration
    """
    # Step 1: 按句末标点切分
    raw_sentences = re.split(r'(?<=[。！？.!?；;])\s*', text)
    raw_sentences = [s.strip() for s in raw_sentences if s.strip()]

    # Step 2: 检查每句时长，超长则继续切分
    sentences: list[str] = []
    for sent in raw_sentences:
        sent_dur = approx_duration_from_text(sent, max_duration=available_duration)
        if sent_dur <= available_duration:
            sentences.append(sent)
        else:
            # 按逗号/冒号切分
            comma_parts = re.split(r'(?<=[，,、：:])\s*', sent)
            comma_parts = [p.strip() for p in comma_parts if p.strip()]
            for cp in comma_parts:
                cp_dur = approx_duration_from_text(cp, max_duration=available_duration)
                if cp_dur <= available_duration:
                    sentences.append(cp)
                else:
                    # 仍超长 → 按字数硬切（按比例估算每段字数）
                    chars_per_sec = len(cp) / max(cp_dur, 0.1)
                    max_chars = max(1, int(available_duration * chars_per_sec * 0.85))
                    for i in range(0, len(cp), max_chars):
                        chunk = cp[i : i + max_chars]
                        if chunk:
                            sentences.append(chunk)

    # Step 3: 将短句合批为不超时的段
    segments: list[tuple[str, int]] = []
    cur_text = ""
    cur_dur = 0.0

    for sent in sentences:
        sent_dur = approx_duration_from_text(sent, max_duration=available_duration)
        if cur_dur + sent_dur > available_duration and cur_text:
            dur_frames = max(1, int(cur_dur * sr // full_hop))
            segments.append((cur_text, dur_frames))
            cur_text = sent
            cur_dur = sent_dur
        else:
            cur_text = (cur_text + sent) if cur_text else sent
            cur_dur += sent_dur

    if cur_text:
        dur_frames = max(1, int(cur_dur * sr // full_hop))
        segments.append((cur_text, dur_frames))

    return segments


def _concat_audio_segments(chunks: list[np.ndarray], pause: float, sr: int) -> np.ndarray:
    """将多段音频拼接，段间插入 pause 秒静音。"""
    if not chunks:
        return np.zeros(int(sr * 0.1), dtype=np.float32)
    if pause <= 0:
        return np.concatenate(chunks, axis=-1)
    sil = np.zeros(int(sr * pause), dtype=np.float32)
    out_parts: list[np.ndarray] = []
    for i, c in enumerate(chunks):
        out_parts.append(c)
        if i < len(chunks) - 1:
            out_parts.append(sil)
    return np.concatenate(out_parts, axis=-1)


# ====================================================================
# 1. 零样本 TTS（离线版）
# ====================================================================
class XzgAudioDiTTTS:
    """小珠光 AudioDiT 零样本TTS（严格离线，自动分句支持长文本）。"""

    @classmethod
    def INPUT_TYPES(cls):
        model_names = _model_names_or_default()
        tokenizer_names = tokenizer_names_or_default()
        return {
            "required": {
                "model_path": (
                    model_names,
                    {
                        "tooltip": (
                            "【严格离线】仅列出已放置到 ComfyUI/models/audiodit/ 下的本地模型。\n"
                            "未下载时，请手动拷贝 LongCat-AudioDiT 模型目录到此路径，或先用原插件下载一次。"
                        ),
                    },
                ),
                "tokenizer": (
                    tokenizer_names,
                    {
                        "default": TOKENIZER_AUTO_OPTION,
                        "tooltip": (
                            "文本分词器目录（UMT5 tokenizer）。\n"
                            "auto = 自动按 4 级回退查找（umt5-base-tokenizer → umt5-base → HF 缓存 → 环境变量）。\n"
                            "选择具体目录则直接使用该目录，缺失时回退到 auto。"
                        ),
                    },
                ),
                "text": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "你好，这里是小珠光 AudioDiT 离线 TTS 节点。所有模型均从本地加载，无需保持 HuggingFace 网络畅通。",
                        "tooltip": "要合成的文本。自动分句，支持长文本。",
                    },
                ),
                "steps": (
                    "INT", {"default": 16, "min": 4, "max": 64, "step": 1,
                            "tooltip": "ODE Euler 步数。越多音质越好但越慢。"},
                ),
                "guidance_strength": (
                    "FLOAT", {"default": 4.0, "min": 0.0, "max": 10.0, "step": 0.5,
                              "tooltip": "CFG/APG 引导强度。越大越贴近提示。"},
                ),
                "guidance_method": (
                    ["cfg", "apg"],
                    {"default": "cfg", "tooltip": "引导方式。音色克隆场景推荐 apg。"},
                ),
                "device": (
                    ["auto", "cuda", "cpu", "mps"],
                    {"default": "auto", "tooltip": "计算设备。auto: CUDA > MPS > CPU。"},
                ),
                "dtype": (
                    ["auto", "bf16", "fp16", "fp32"],
                    {"default": "auto",
                     "tooltip": "精度。auto: CUDA→bf16，MPS→fp16，CPU→fp32。"},
                ),
                "attention": (
                    ["auto", "sdpa", "sage_attention", "flash_attention"],
                    {"default": "auto", "tooltip": "注意力实现。flash/sage 需额外包。"},
                ),
                "seed": (
                    "INT", {"default": 0, "min": 0, "max": 2**31 - 1,
                            "tooltip": "随机种子。0 = 每次随机。"},
                ),
                "keep_model_loaded": (
                    "BOOLEAN", {"default": True,
                                "tooltip": "保持模型常驻；生成后自动把权重踢回 CPU 省显存，下次推理再切 GPU。"},
                ),
                "pause_between_segments": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 2.0, "step": 0.1,
                    "tooltip": "自动分句时各段之间的静音秒数。长文本分句拼接时使用。"}),
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "generate"
    CATEGORY = "xiaozhuguang"

    def generate(
        self,
        model_path: str,
        tokenizer: str,
        text: str,
        steps: int,
        guidance_strength: float,
        guidance_method: str,
        device: str,
        dtype: str,
        attention: str,
        seed: int,
        keep_model_loaded: bool,
        pause_between_segments: float = 0.3,
    ) -> Tuple[dict]:
        cancel_event.clear()
        _interrupt_check()

        if not text.strip():
            raise ValueError("[小珠光AudioDiT] 文本不能为空。")

        model, tokenizer = self._get_model(
            model_path, tokenizer, device, dtype, attention, keep_model_loaded
        )

        sr = model.config.sampling_rate
        full_hop = model.config.latent_hop
        max_duration = model.config.max_wav_duration

        text_norm = normalize_text(text)
        logger.info(f"零样本 TTS: {text_norm[:80]}{'…' if len(text_norm) > 80 else ''}")

        # 自动分句
        segments = _split_text_into_segments(text_norm, max_duration, sr, full_hop)
        if len(segments) > 1:
            logger.info(f"文本自动分为 {len(segments)} 段（每段 ≤ {max_duration:.1f}s）")
        else:
            logger.info(f"单段生成，预计 ≤ {max_duration:.1f}s")

        actual_seed = seed if seed != 0 else torch.randint(0, 2**31, (1,)).item()
        torch.manual_seed(actual_seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed(actual_seed)

        # 逐段生成
        chunks: list[np.ndarray] = []
        total_segments = len(segments)
        pbar = ProgressBar(total_segments + 1) if _PBAR else None

        for seg_idx, (seg_text, seg_dur_frames) in enumerate(segments):
            _interrupt_check()
            seg_dur_sec = seg_dur_frames * full_hop / sr
            logger.info(f"段 {seg_idx + 1}/{total_segments}: '{seg_text[:40]}…' 约 {seg_dur_sec:.1f}s")

            inputs = tokenizer([seg_text], padding="longest", return_tensors="pt")
            input_ids = inputs.input_ids.to(model.device)
            attention_mask = inputs.attention_mask.to(model.device)

            seg_seed = (actual_seed + seg_idx * 1000003) % (2**31)
            with torch.no_grad():
                output = model(
                    input_ids=input_ids,
                    attention_mask=attention_mask,
                    duration=seg_dur_frames,
                    steps=steps,
                    cfg_strength=guidance_strength,
                    guidance_method=guidance_method,
                    seed=seg_seed,
                )
            wav = output.waveform.squeeze().detach().cpu().numpy()
            chunks.append(wav)
            if pbar:
                pbar.update_absolute(seg_idx + 1, total_segments + 1)

        # 拼接所有段
        final_wav = _concat_audio_segments(chunks, pause_between_segments, sr)
        logger.info(f"零样本 TTS 总时长 {len(final_wav) / sr:.2f}s @ {sr}Hz（{total_segments} 段）")
        result = numpy_audio_to_comfy(final_wav, sr)
        if pbar:
            pbar.update_absolute(total_segments + 1, total_segments + 1)

        try:
            if not keep_model_loaded:
                unload_model()
            else:
                offload_model_to_cpu()
        except Exception:
            pass
        return (result,)

    def _get_model(self, model_path, tokenizer, device, dtype, attention, keep_loaded=False):
        key = get_cache_key(model_path, device, dtype, attention, tokenizer)
        cached_model, cached_tokenizer, cached_key = get_cached_model()
        if cached_model is not None and cached_key != key:
            logger.info(f"参数变化 → 卸载旧缓存模型。旧: {cached_key}, 新: {key}")
            unload_model()
        if cached_model is not None and cached_key == key:
            set_keep_loaded(keep_loaded)
            if is_offloaded():
                device_str, _ = resolve_device(device)
                logger.info(f"恢复已卸载的模型到 {device_str}…")
                resume_model_to_cuda(device_str)
            else:
                logger.info("复用缓存模型（严格离线）。")
            return cached_model, cached_tokenizer
        model, tokenizer = load_model_xzg(model_path, device, dtype, attention, tokenizer)
        set_cached_model(model, tokenizer, key, keep_loaded=keep_loaded)
        return model, tokenizer


# ====================================================================
# 2. 音色克隆 TTS（离线版）
# ====================================================================
class XzgAudioDiTVoiceCloneTTS:
    """小珠光 LongCat 音色克隆 TTS（严格离线，自动分句支持长文本）。参考音频 3–15 秒效果最佳。"""

    @classmethod
    def INPUT_TYPES(cls):
        model_names = _model_names_or_default()
        tokenizer_names = tokenizer_names_or_default()
        return {
            "required": {
                "model_path": (
                    model_names,
                    {"tooltip": (
                        "【严格离线】仅列出 ComfyUI/models/audiodit/ 下的本地模型。"
                    )},
                ),
                "tokenizer": (
                    tokenizer_names,
                    {
                        "default": TOKENIZER_AUTO_OPTION,
                        "tooltip": (
                            "文本分词器目录（UMT5 tokenizer）。auto = 自动回退查找。"
                        ),
                    },
                ),
                "text": (
                    "STRING", {
                        "multiline": True,
                        "default": "这是用参考音色克隆出来的语音，可以自由改变要说的文本内容。",
                        "tooltip": "目标文本（用克隆出来的音色朗读）。自动分句，支持长文本。",
                    },
                ),
                "prompt_audio": (
                    "AUDIO", {"tooltip": "参考音频（要克隆的音色）。3–15 秒效果最佳。"},
                ),
                "prompt_text": (
                    "STRING", {
                        "multiline": True,
                        "default": "",
                        "tooltip": "参考音频的文字转录（强烈建议提供，会显著提升克隆质量）。",
                    },
                ),
                "steps": ("INT", {"default": 16, "min": 4, "max": 64, "step": 1,
                                 "tooltip": "ODE Euler 步数。"}),
                "guidance_strength": ("FLOAT", {"default": 4.0, "min": 0.0, "max": 10.0, "step": 0.5,
                                                "tooltip": "CFG/APG 引导强度。"}),
                "guidance_method": (["cfg", "apg"], {"default": "apg",
                                                     "tooltip": "音色克隆推荐 apg。"}),
                "device": (["auto", "cuda", "cpu", "mps"], {"default": "auto"}),
                "dtype": (["auto", "bf16", "fp16", "fp32"], {"default": "auto",
                                                             "tooltip": "音色克隆推荐 bf16，fp16 会数值溢出。"}),
                "attention": (["auto", "sdpa", "sage_attention", "flash_attention"], {"default": "auto"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**31 - 1}),
                "keep_model_loaded": ("BOOLEAN", {"default": True}),
                "pause_between_segments": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 2.0, "step": 0.1,
                    "tooltip": "自动分句时各段之间的静音秒数。长文本分句拼接时使用。"}),
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "generate"
    CATEGORY = "xiaozhuguang"

    def generate(
        self,
        model_path: str,
        tokenizer: str,
        text: str,
        prompt_audio: dict,
        prompt_text: str,
        steps: int,
        guidance_strength: float,
        guidance_method: str,
        device: str,
        dtype: str,
        attention: str,
        seed: int,
        keep_model_loaded: bool,
        pause_between_segments: float = 0.3,
    ) -> Tuple[dict]:
        cancel_event.clear()
        _interrupt_check()

        if not text.strip():
            raise ValueError("[小珠光LongCat] 目标文本不能为空。")
        if not prompt_text.strip():
            logger.warning(
                "未提供参考音频转录（prompt_text）。克隆质量可能下降，强烈建议填写。"
            )

        if dtype == "fp16":
            logger.warning(
                "音色克隆不支持 fp16（latent 条件路径会数值溢出），自动升级为 bf16。"
            )
            dtype = "bf16"

        model, tokenizer = self._get_model(
            model_path, tokenizer, device, dtype, attention, keep_model_loaded
        )

        sr = model.config.sampling_rate
        full_hop = model.config.latent_hop
        max_duration = model.config.max_wav_duration

        logger.info("编码参考音频…")
        prompt_wav = comfy_audio_to_tensor(prompt_audio, sr).to(model.device)
        prompt_duration = prompt_wav.shape[-1] / sr
        if prompt_duration > 30:
            logger.warning(
                f"参考音频时长 {prompt_duration:.1f}s > 30s。可能影响生成，建议裁剪。"
            )

        prompt_text_norm = normalize_text(prompt_text) if prompt_text.strip() else ""
        if prompt_text_norm:
            approx_pd = approx_duration_from_text(prompt_text_norm, max_duration=max_duration)
            prompt_time = prompt_duration if prompt_duration > 0 else approx_pd
        else:
            prompt_time = prompt_duration

        available_duration = max_duration - prompt_time
        if available_duration <= 1.0:
            raise ValueError(
                f"可用时长 {available_duration:.1f}s 太短（参考音频占 {prompt_time:.1f}s）。"
                f"请缩短参考音频或增加文本。"
            )

        text_norm = normalize_text(text)
        logger.info(f"LongCat 音色克隆: {text_norm[:80]}{'…' if len(text_norm) > 80 else ''}")

        # 自动分句
        segments = _split_text_into_segments(text_norm, available_duration, sr, full_hop)
        if len(segments) > 1:
            logger.info(f"文本自动分为 {len(segments)} 段（每段 ≤ {available_duration:.1f}s）")
        else:
            logger.info(f"单段生成，预计 ≤ {available_duration:.1f}s")

        # 预编码参考音频 VAE latent（所有段共享）
        prompt_audio_tensor = prompt_wav.unsqueeze(0)
        off = 3
        pw = prompt_wav.clone()
        if pw.shape[-1] % full_hop != 0:
            pw = F.pad(pw, (0, full_hop - pw.shape[-1] % full_hop))
        pw = F.pad(pw, (0, full_hop * off))
        with torch.no_grad():
            plt = model.vae.encode(pw.unsqueeze(0))
        if off:
            plt = plt[..., :-off]
        prompt_dur = plt.shape[-1]

        actual_seed = seed if seed != 0 else torch.randint(0, 2**31, (1,)).item()
        torch.manual_seed(actual_seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed(actual_seed)

        # 逐段生成
        chunks: list[np.ndarray] = []
        total_segments = len(segments)
        pbar = ProgressBar(total_segments + 1) if _PBAR else None

        for seg_idx, (seg_text, seg_dur_frames) in enumerate(segments):
            _interrupt_check()
            seg_dur_sec = seg_dur_frames * full_hop / sr
            logger.info(f"段 {seg_idx + 1}/{total_segments}: '{seg_text[:40]}…' 约 {seg_dur_sec:.1f}s")

            seg_full_text = f"{prompt_text_norm} {seg_text}" if prompt_text_norm else seg_text
            inputs = tokenizer([seg_full_text], padding="longest", return_tensors="pt")
            input_ids = inputs.input_ids.to(model.device)
            attention_mask = inputs.attention_mask.to(model.device)

            duration = seg_dur_frames + prompt_dur
            duration = min(duration, int(max_duration * sr // full_hop))

            seg_seed = (actual_seed + seg_idx * 1000003) % (2**31)
            with torch.no_grad():
                output = model(
                    input_ids=input_ids,
                    attention_mask=attention_mask,
                    prompt_audio=prompt_audio_tensor,
                    duration=duration,
                    steps=steps,
                    cfg_strength=guidance_strength,
                    guidance_method=guidance_method,
                    seed=seg_seed,
                )
            wav = output.waveform.squeeze().detach().cpu().numpy()
            chunks.append(wav)
            if pbar:
                pbar.update_absolute(seg_idx + 1, total_segments + 1)

        # 拼接所有段
        final_wav = _concat_audio_segments(chunks, pause_between_segments, sr)
        logger.info(f"LongCat 总时长 {len(final_wav) / sr:.2f}s @ {sr}Hz（{total_segments} 段）")
        result = numpy_audio_to_comfy(final_wav, sr)
        if pbar:
            pbar.update_absolute(total_segments + 1, total_segments + 1)

        try:
            if not keep_model_loaded:
                unload_model()
            else:
                offload_model_to_cpu()
        except Exception:
            pass
        return (result,)

    def _get_model(self, model_path, tokenizer, device, dtype, attention, keep_loaded=False):
        key = get_cache_key(model_path, device, dtype, attention, tokenizer)
        cached_model, cached_tokenizer, cached_key = get_cached_model()
        if cached_model is not None and cached_key != key:
            unload_model()
        if cached_model is not None and cached_key == key:
            set_keep_loaded(keep_loaded)
            if is_offloaded():
                device_str, _ = resolve_device(device)
                resume_model_to_cuda(device_str)
            return cached_model, cached_tokenizer
        model, tokenizer = load_model_xzg(model_path, device, dtype, attention, tokenizer)
        set_cached_model(model, tokenizer, key, keep_loaded=keep_loaded)
        return model, tokenizer


# ====================================================================
# 3. 多人对话 TTS（离线版，v3 IO DynamicCombo，支持 v2 兜底）
# ====================================================================
def _parse_dialogue_lines(text: str):
    tag_re = re.compile(r"^\s*\[speaker_(\d+)\]:\s*(.*)$")
    lines = text.splitlines()
    turns: list[tuple[int, str]] = []
    cur_speaker: int | None = None
    cur_parts: list[str] = []
    for raw in lines:
        m = tag_re.match(raw)
        if m:
            if cur_speaker is not None and cur_parts:
                turns.append((cur_speaker, " ".join(cur_parts).strip()))
            cur_speaker = int(m.group(1)) - 1
            cur_parts = [m.group(2)] if m.group(2).strip() else []
        else:
            stripped = raw.strip()
            if stripped and cur_speaker is not None:
                cur_parts.append(stripped)
    if cur_speaker is not None and cur_parts:
        turns.append((cur_speaker, " ".join(cur_parts).strip()))
    return turns


if _V3:
    def _speaker_inputs(count: int) -> list:
        inputs: list[Any] = []
        for i in range(1, count + 1):
            inputs.append(
                IO.Audio.Input(
                    f"speaker_{i}_audio",
                    optional=True,
                    tooltip=(
                        f"说话人 {i} 的参考音频（3–15 秒）。"
                        f"在文本里写 [speaker_{i}]: 台词。"
                    ),
                )
            )
            inputs.append(
                IO.String.Input(
                    f"speaker_{i}_ref_text",
                    multiline=False,
                    default="",
                    optional=True,
                    tooltip=f"说话人 {i} 参考音频的文字转录（强烈推荐填写）。",
                )
            )
        return inputs

    class XzgAudioDiTMultiSpeakerTTS(IO.ComfyNode):
        """小珠光 AudioDiT 多人对话 TTS（离线版）。v3 DynamicCombo 输入，支持长文本自动分句。"""

        @classmethod
        def define_schema(cls) -> Any:
            model_names = _model_names_or_default()
            tokenizer_names = tokenizer_names_or_default()
            speaker_options = [
                IO.DynamicCombo.Option(key=str(n), inputs=_speaker_inputs(n))
                for n in range(2, MAX_SPEAKERS + 1)
            ]
            return IO.Schema(
                node_id="XzgAudioDiTMultiSpeakerTTS",
                display_name="小珠光 AudioDiT 多人对话TTS",
                category="xiaozhuguang",
                description=(
                    "【严格离线版】多说话人对话合成。调整 num_speakers 动态出现对应参考音频输入。"
                    "文本中使用 [speaker_1]: / [speaker_2]: / … 分配台词。支持长文本自动分句。"
                ),
                inputs=[
                    IO.Combo.Input("model_path", options=model_names,
                                   tooltip="严格离线：仅列本地模型。未找到时放 ComfyUI/models/audiodit/"),
                    IO.Combo.Input("tokenizer", options=tokenizer_names, default=TOKENIZER_AUTO_OPTION,
                                   tooltip="文本分词器目录（UMT5 tokenizer）。auto = 自动回退查找。"),
                    IO.DynamicCombo.Input(
                        "num_speakers",
                        options=speaker_options,
                        tooltip="说话人数量（2–10）。调整后会自动增减对应 speaker_N_audio / ref_text 输入。",
                    ),
                    IO.String.Input(
                        "text",
                        multiline=True,
                        default="[speaker_1]: 你好，我是第一位。\n[speaker_2]: 你好，我是第二位！",
                        tooltip="多人台本文本。使用 [speaker_N]: 分配每句话的说话人（1 起算）。支持长文本自动分句。",
                    ),
                    IO.Int.Input("steps", default=16, min=4, max=64, step=1),
                    IO.Float.Input("guidance_strength", default=4.0, min=0.0, max=10.0, step=0.5),
                    IO.Combo.Input("guidance_method", options=["cfg", "apg"], default="apg"),
                    IO.Combo.Input("device", options=["auto", "cuda", "cpu", "mps"], default="auto"),
                    IO.Combo.Input("dtype", options=["auto", "bf16", "fp16", "fp32"], default="auto",
                                   tooltip="音色克隆路径推荐 bf16；fp16 自动升级为 bf16。"),
                    IO.Combo.Input("attention", options=["auto", "sdpa", "sage_attention", "flash_attention"], default="auto"),
                    IO.Int.Input("seed", default=0, min=0, max=2**31 - 1),
                    IO.Boolean.Input("keep_model_loaded", default=True),
                    IO.Float.Input("pause_after_speaker", default=0.4, min=0.0, max=2.0, step=0.1,
                                   tooltip="每轮说话结束后追加的静音秒数。"),
                    IO.Float.Input("pause_between_segments", default=0.3, min=0.0, max=2.0, step=0.1,
                                   tooltip="同一段台词自动分句时，各段之间的静音秒数。"),
                ],
                outputs=[IO.Audio.Output("audio")],
            )

        def execute(self, *_, **inputs):
            model_path = inputs["model_path"]
            tokenizer = inputs.get("tokenizer", TOKENIZER_AUTO_OPTION)
            num_speakers = int(inputs.get("num_speakers", 2))
            text = inputs["text"]
            steps = int(inputs["steps"])
            guidance_strength = float(inputs["guidance_strength"])
            guidance_method = inputs["guidance_method"]
            device = inputs["device"]
            dtype = inputs["dtype"]
            attention = inputs["attention"]
            seed = int(inputs["seed"])
            keep_model_loaded = bool(inputs["keep_model_loaded"])
            pause = float(inputs.get("pause_after_speaker", 0.4))
            pause_seg = float(inputs.get("pause_between_segments", 0.3))

            cancel_event.clear()
            _interrupt_check()
            if dtype == "fp16":
                logger.warning("多人对话走音色克隆路径，不支持 fp16；自动升级为 bf16。")
                dtype = "bf16"

            turns = _parse_dialogue_lines(text)
            if not turns:
                raise ValueError(
                    "[小珠光AudioDiT] 多人台本文本为空或未匹配 [speaker_N]: 标签。\n"
                    "示例:\n  [speaker_1]: 你好\n  [speaker_2]: 你好呀"
                )

            # 读取每个说话人的参考音频 + 转录
            audios: dict[int, dict] = {}
            refs: dict[int, str] = {}
            for i in range(num_speakers):
                spk = i + 1
                a = inputs.get(f"speaker_{spk}_audio")
                r = inputs.get(f"speaker_{spk}_ref_text", "") or ""
                if a is None:
                    raise ValueError(
                        f"[小珠光AudioDiT] 缺少 speaker_{spk}_audio（num_speakers={num_speakers}，"
                        f"1…{num_speakers} 都必须接参考音频）。"
                    )
                audios[i] = a
                refs[i] = r

            model, tokenizer = load_model_xzg(model_path, device, dtype, attention, tokenizer)
            try:
                set_cached_model(model, tokenizer, get_cache_key(model_path, device, dtype, attention, tokenizer),
                                 keep_loaded=keep_model_loaded)
            except Exception:
                pass

            sr = model.config.sampling_rate
            full_hop = model.config.latent_hop
            max_duration = model.config.max_wav_duration

            actual_seed = seed if seed != 0 else torch.randint(0, 2**31, (1,)).item()
            torch.manual_seed(actual_seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed(actual_seed)

            chunks: list[np.ndarray] = []
            for idx, (speaker_0b, line) in enumerate(turns):
                if speaker_0b < 0 or speaker_0b >= num_speakers:
                    logger.warning(f"第 {idx + 1} 轮的 [speaker_{speaker_0b + 1}] 超过 num_speakers={num_speakers}，已跳过。")
                    continue
                if not line.strip():
                    continue
                _interrupt_check()
                logger.info(f"第 {idx + 1}/{len(turns)} 轮，speaker_{speaker_0b + 1}: {line[:60]}{'…' if len(line) > 60 else ''}")

                prompt_wav = comfy_audio_to_tensor(audios[speaker_0b], sr).to(model.device)
                prompt_text_norm = normalize_text(refs[speaker_0b]) if refs[speaker_0b].strip() else ""
                text_norm = normalize_text(line)

                # 计算该轮可用时长
                prompt_duration = prompt_wav.shape[-1] / sr
                prompt_time = prompt_duration
                if prompt_text_norm:
                    approx_pd = approx_duration_from_text(prompt_text_norm, max_duration=max_duration)
                    prompt_time = max(prompt_duration, approx_pd)
                available_dur = max_duration - prompt_time
                if available_dur <= 1.0:
                    logger.warning(f"第 {idx + 1} 轮可用时长过短 ({available_dur:.1f}s)，跳过。")
                    continue

                # 自动分句（支持长台词）
                turn_segments = _split_text_into_segments(text_norm, available_dur, sr, full_hop)
                if len(turn_segments) > 1:
                    logger.info(f"第 {idx + 1} 轮自动分为 {len(turn_segments)} 段")

                # 预编码 VAE latent
                prompt_audio_tensor = prompt_wav.unsqueeze(0)
                pw = prompt_wav.clone()
                if pw.shape[-1] % full_hop != 0:
                    pw = F.pad(pw, (0, full_hop - pw.shape[-1] % full_hop))
                pw_pad = F.pad(pw, (0, full_hop * 3))
                with torch.no_grad():
                    plt = model.vae.encode(pw_pad.unsqueeze(0))
                plt = plt[..., :-3]
                prompt_dur = plt.shape[-1]

                # 逐段生成该轮
                turn_chunks: list[np.ndarray] = []
                for seg_idx, (seg_text, seg_dur_frames) in enumerate(turn_segments):
                    seg_full_text = f"{prompt_text_norm} {seg_text}" if prompt_text_norm else seg_text
                    t_inputs = tokenizer([seg_full_text], padding="longest", return_tensors="pt")
                    input_ids = t_inputs.input_ids.to(model.device)
                    attention_mask = t_inputs.attention_mask.to(model.device)
                    duration = seg_dur_frames + prompt_dur
                    duration = min(duration, int(max_duration * sr // full_hop))
                    turn_seed = (actual_seed + idx * 1000003 + seg_idx * 7919) % (2**31)
                    with torch.no_grad():
                        output = model(
                            input_ids=input_ids,
                            attention_mask=attention_mask,
                            prompt_audio=prompt_audio_tensor,
                            duration=duration,
                            steps=steps,
                            cfg_strength=guidance_strength,
                            guidance_method=guidance_method,
                            seed=turn_seed,
                        )
                    turn_chunks.append(output.waveform.squeeze().detach().cpu().numpy())

                # 该轮内部拼接
                if len(turn_chunks) > 1:
                    turn_wav = _concat_audio_segments(turn_chunks, pause_seg, sr)
                else:
                    turn_wav = turn_chunks[0]
                chunks.append(turn_wav)

            final_wav = _concat_audio_segments(chunks, pause, sr)
            logger.info(f"多人对话总时长 {len(final_wav) / sr:.2f}s @ {sr}Hz（共 {len(chunks)} 轮）")
            result = numpy_audio_to_comfy(final_wav, sr)
            try:
                if not keep_model_loaded:
                    unload_model()
                else:
                    offload_model_to_cpu()
            except Exception:
                pass
            return (result,)
