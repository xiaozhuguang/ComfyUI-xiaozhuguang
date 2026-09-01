"""小珠光VFI

把原 ComfyUI-GIMM-VFI 的「(Down)Load GIMMVFI Model」+「GIMM-VFI Interpolate」
两个节点合并为单个「小珠光VFI」节点，一次执行即可完成模型加载 + 帧插值。

独立性说明：
  1. 模型/插值代码已整体内置到本插件（xzg_gimmvfi/），小珠光VFI 完全自包含，
     不依赖、也不读取外部的 ComfyUI-GIMM-VFI 插件。
  2. 仅在执行器首次调用时惰性导入 xzg_gimmvfi 及其依赖（torch 等）；缺失依赖时
     仅告警，不影响其它节点。
  3. 相比原两节点拼接，这里增加了模型缓存（按 model/precision/torch_compile 为 key），
     同一会话内重复执行/多次调用不会反复重新加载模型，大幅降低首帧等待。
"""
import os
import logging
import math

log = logging.getLogger(__name__)

# xzg_vfi.py 位于 <插件>/nodes/ 下；内置 GIMM 源码在 <插件>/xzg_gimmvfi/
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_XZG_GIMM_ROOT = os.path.join(os.path.dirname(_THIS_DIR), "xzg_gimmvfi")
CONFIGS_DIR = os.path.join(_XZG_GIMM_ROOT, "configs", "gimmvfi")

# 模块级惰性加载槽位
_GIMM = None          # 已成功导入的符号表
_IMPORT_ERROR = None  # 导入失败原因（首个失败只记一次）


def _load_gimm():
    """惰性导入内置 xzg_gimmvfi 相关的符号，只做一次；失败时记录原因并返回 None。"""
    global _GIMM, _IMPORT_ERROR
    if _GIMM is not None or _IMPORT_ERROR is not None:
        return _GIMM

    try:
        import torch
        import yaml
        from omegaconf import OmegaConf
        import comfy.model_management as mm
        from comfy.utils import load_torch_file

        # 使用相对导入访问本插件内置的 GIMM 源码（xzg_gimmvfi 是插件内子包）
        from ..xzg_gimmvfi.generalizable_INR.gimmvfi_r import GIMMVFI_R
        from ..xzg_gimmvfi.generalizable_INR.gimmvfi_f import GIMMVFI_F
        from ..xzg_gimmvfi.generalizable_INR.configs import GIMMVFIConfig
        from ..xzg_gimmvfi.generalizable_INR.raft import RAFT
        from ..xzg_gimmvfi.generalizable_INR.flowformer.core.FlowFormer.LatentCostFormer.transformer import FlowFormer
        from ..xzg_gimmvfi.generalizable_INR.flowformer.configs.submission import get_cfg
        from ..xzg_gimmvfi.utils.utils import InputPadder, RaftArgs, easydict_to_dict

        _GIMM = dict(
            torch=torch, yaml=yaml, OmegaConf=OmegaConf, mm=mm,
            load_torch_file=load_torch_file,
            GIMMVFI_R=GIMMVFI_R, GIMMVFI_F=GIMMVFI_F, GIMMVFIConfig=GIMMVFIConfig,
            RAFT=RAFT, FlowFormer=FlowFormer, get_cfg=get_cfg,
            InputPadder=InputPadder, RaftArgs=RaftArgs,
            easydict_to_dict=easydict_to_dict,
        )
        log.info("[小珠光] GIMM-VFI 依赖加载成功，节点可用。")
    except Exception as e:
        _IMPORT_ERROR = e
        import traceback
        log.warning(
            "[小珠光] GIMM-VFI 节点导入失败（缺少依赖组件）：%s", e,
        )
        traceback.print_exc()
        _GIMM = None
    return _GIMM


# 型号判定 + 流估计器选择
_MODEL_INFO = {
    "gimmvfi_r_arb_lpips_fp32.safetensors": ("r", "raft-things_fp32.safetensors", "gimmvfi_r_arb.yaml"),
    "gimmvfi_f_arb_lpips_fp32.safetensors": ("f", "flowformer_sintel_fp32.safetensors", "gimmvfi_f_arb.yaml"),
}

# 模型缓存：key -> 已加载并 eval() 的模型（留在 GPU/显存，跨执行复用）
_MODEL_CACHE: dict = {}


def _get_model(g, model, precision, torch_compile):
    """加载（或从缓存取出）GIMM-VFI 模型，返回带 flow_estimator 的 eval 模型。"""
    import folder_paths
    key = (model, precision, bool(torch_compile))
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]

    torch = g["torch"]
    mm = g["mm"]
    OmegaConf = g["OmegaConf"]
    yaml = g["yaml"]
    load_torch_file = g["load_torch_file"]

    device = mm.get_torch_device()
    dtype = {
        "fp8_e4m3fn": torch.float8_e4m3fn,
        "fp8_e4m3fn_fast": torch.float8_e4m3fn,
        "bf16": torch.bfloat16,
        "fp16": torch.float16,
        "fp16_fast": torch.float16,
        "fp32": torch.float32,
    }[precision]

    kind, flow_model_name, cfg_name = _MODEL_INFO[model]

    download_path = os.path.join(folder_paths.models_dir, "interpolation", "gimm-vfi")
    model_path = os.path.join(download_path, model)

    def _ensure(path, name, allow_pattern):
        if not os.path.exists(path):
            from huggingface_hub import snapshot_download
            log.info("[小珠光] 下载 GIMM-VFI 模型 %s 到: %s", name, path)
            snapshot_download(
                repo_id="Kijai/GIMM-VFI_safetensors",
                allow_patterns=[f"*{allow_pattern}*"],
                local_dir=download_path,
                local_dir_use_symlinks=False,
            )

    _ensure(model_path, model, model)
    flow_model_path = os.path.join(download_path, flow_model_name)
    _ensure(flow_model_path, flow_model_name, flow_model_name)

    config_path = os.path.join(CONFIGS_DIR, cfg_name)
    with open(config_path) as f:
        config = yaml.load(f, Loader=yaml.FullLoader)
    config = g["easydict_to_dict"](config)
    config = OmegaConf.create(config)
    arch_defaults = g["GIMMVFIConfig"].create(config.arch)
    config = OmegaConf.merge(arch_defaults, config.arch)

    if kind == "r":
        m = g["GIMMVFI_R"](dtype, config)
        raft_args = g["RaftArgs"](small=False, mixed_precision=False, alternate_corr=False)
        raft_model = g["RAFT"](raft_args)
        raft_model.load_state_dict(load_torch_file(flow_model_path), strict=True)
        raft_model.to(dtype).to(device)
        m.flow_estimator = raft_model
    else:
        m = g["GIMMVFI_F"](dtype, config)
        cfg = g["get_cfg"]()
        flowformer = g["FlowFormer"](cfg.latentcostformer)
        flowformer.load_state_dict(load_torch_file(flow_model_path), strict=True)
        m.flow_estimator = flowformer.to(dtype).to(device)

    sd = load_torch_file(model_path)
    m.load_state_dict(sd, strict=False)
    m = m.eval().to(dtype).to(device)
    if torch_compile:
        m = torch.compile(m)

    _MODEL_CACHE[key] = m
    log.info("[小珠光] GIMM-VFI 模型 %s 加载完成%s", model, "（torch.compile）" if torch_compile else "")
    return m


class XiaozhuguangVFI:
    """小珠光VFI：合并模型加载与帧插值，一次执行出图。"""

    @classmethod
    def INPUT_TYPES(cls):
        try:
            import folder_paths as _fp
            _dir = os.path.join(_fp.models_dir, "interpolation", "gimm-vfi")
        except Exception:
            _dir = os.path.join("ComfyUI", "models", "interpolation", "gimm-vfi")
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "待插值的图像序列"}),
                "model": (["gimmvfi_r_arb_lpips_fp32.safetensors",
                           "gimmvfi_f_arb_lpips_fp32.safetensors"],
                          {"tooltip": f"模型文件存放位置：{_dir}\n"
                                      f"（对应型号的流估计器权重 raft-things_fp32.safetensors / "
                                      f"flowformer_sintel_fp32.safetensors 也放在同一目录）\n"
                                      f"缺失时会自动从 HuggingFace 下载（需联网）。"}),
                "interpolation_factor": ("INT", {"default": 2, "min": 1, "max": 100, "step": 1}),
                "ds_factor": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 1.0, "step": 0.01}),
                "precision": (["fp32", "bf16", "fp16"], {"default": "fp32"}),
                "torch_compile": ("BOOLEAN", {"default": False,
                                              "tooltip": "compile 部分模型，需要 Triton"}),
            },
            "optional": {
                # 原始帧率：以可连接输入端口形式提供（连接后用传入值，未连接时用默认 25）
                "input_fps": ("FLOAT", {"default": 25.0, "min": 1, "max": 240, "step": 1,
                                        "forceInput": True, "label": "原始帧率"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "FLOAT")
    RETURN_NAMES = ("images", "output_fps")
    FUNCTION = "execute"
    CATEGORY = "小珠光"
    DESCRIPTION = "小珠光VFI：GIMM-VFI 模型加载 + 帧插值合并节点，输出帧率 = 原始帧率 × 插值倍率"

    def execute(self, images, model, interpolation_factor, ds_factor,
                precision="fp32", torch_compile=False, input_fps=25.0):
        g = _load_gimm()
        if g is None:
            raise RuntimeError(f"[小珠光] GIMM-VFI 节点不可用：{_IMPORT_ERROR}")

        torch = g["torch"]
        mm = g["mm"]
        mm.soft_empty_cache()

        images = images.permute(0, 3, 1, 2)

        # ── 4N+1 尾补帧：复制尾帧拼到原视频末尾，插值结束后从尾部切掉 ──
        # 补帧数公式与「小珠光帧优化」一致
        orig_count = images.shape[0]
        tail_fill = 0
        if orig_count > 0:
            tail_fill = math.ceil(orig_count / 4) * 4 + 5 - orig_count
            if tail_fill > 0:
                last_frame = images[-1:].clone()
                tail_dup = [last_frame] * tail_fill
                images = torch.cat([images] + tail_dup, dim=0)

        model_obj = _get_model(g, model, precision, torch_compile)
        device = mm.get_torch_device()
        dtype = model_obj.dtype

        from comfy.utils import ProgressBar
        from contextlib import nullcontext

        out_images_list = []
        start = 0
        end = images.shape[0] - 1
        pbar = ProgressBar(images.shape[0] - 1)

        autocast_device = mm.get_autocast_device(device)
        cast_context = (torch.autocast(device_type=autocast_device, dtype=dtype)
                        if dtype != torch.float32 else nullcontext())

        from tqdm import tqdm
        with cast_context:
            for j in tqdm(range(start, end)):
                I0 = images[j].unsqueeze(0)
                I2 = images[j + 1].unsqueeze(0)

                if j == start:
                    out_images_list.append(I0.squeeze(0).permute(1, 2, 0))

                padder = g["InputPadder"](I0.shape, 32)
                I0, I2 = padder.pad(I0, I2)
                xs = torch.cat((I0.unsqueeze(2), I2.unsqueeze(2)), dim=2).to(device, non_blocking=True)

                batch_size = xs.shape[0]
                s_shape = xs.shape[-2:]

                coord_inputs = [
                    (
                        model_obj.sample_coord_input(
                            batch_size,
                            s_shape,
                            [1 / interpolation_factor * i],
                            device=xs.device,
                            upsample_ratio=ds_factor,
                        ),
                        None,
                    )
                    for i in range(1, interpolation_factor)
                ]
                timesteps = [
                    i * 1 / interpolation_factor * torch.ones(xs.shape[0]).to(xs.device)
                    for i in range(1, interpolation_factor)
                ]

                all_outputs = model_obj(xs, coord_inputs, t=timesteps, ds_factor=ds_factor)
                out_frames = [padder.unpad(im) for im in all_outputs["imgt_pred"]]
                I1_pred_img = [
                    I1_pred[0].detach().cpu().permute(1, 2, 0) for I1_pred in out_frames
                ]

                for i in range(interpolation_factor - 1):
                    out_images_list.append(I1_pred_img[i])

                out_images_list.append(
                    padder.unpad(I2).squeeze().detach().cpu().permute(1, 2, 0)
                )
                pbar.update(1)

        image_tensors = torch.stack(out_images_list).cpu().float()

        # 输出对齐：直接从前面截取「原帧数 × 补帧倍数」帧
        # 既去掉尾补帧产生的多余帧，又保证严格整数倍（如 10帧×2倍 = 20帧）
        target = max(1, orig_count * interpolation_factor)
        if image_tensors.shape[0] > target:
            image_tensors = image_tensors[:target].contiguous()

        mm.soft_empty_cache()
        output_fps = float(input_fps) * float(interpolation_factor)
        return (image_tensors, output_fps)


NODE_CLASS_MAPPINGS = {"XiaozhuguangVFI": XiaozhuguangVFI}
NODE_DISPLAY_NAME_MAPPINGS = {"XiaozhuguangVFI": "小珠光VFI防丢帧"}