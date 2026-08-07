import os
import sys
import subprocess

_ffmpeg_bin = r"E:\ComfyUI-aki-XZG\ffmpeg\bin"
if os.path.isdir(_ffmpeg_bin) and _ffmpeg_bin not in os.environ.get('PATH', ''):
    os.environ['PATH'] = _ffmpeg_bin + os.pathsep + os.environ.get('PATH', '')


def _patch_subprocess_encoding():
    if getattr(subprocess, '_xzg_patched', False):
        return
    _orig_Popen_init = subprocess.Popen.__init__

    def _patched_init(self, *args, **kwargs):
        has_text = (
            kwargs.get('text', False)
            or kwargs.get('universal_newlines', False)
            or kwargs.get('encoding') is not None
            or kwargs.get('errors') is not None
        )
        if has_text and kwargs.get('errors') is None:
            kwargs['errors'] = 'replace'
        _orig_Popen_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _patched_init
    subprocess._xzg_patched = True


_patch_subprocess_encoding()


# ---------- 通用：小珠光 aiohttp 路由 handler 安全装饰器 ----------
# 所有 @routes.get/post 注册的 async handler 都应加上 @xzg_safe_handler，
# 这样即便内部抛异常，也会：
#   1) 用 stderr print 完整 traceback（避免只截到 aiohttp.web_protocol.py）
#   2) 返回 HTTP 500 + {error, traceback} JSON，前端能直接看到报错点
import asyncio as _asyncio
import functools as _ft
import traceback as _tb
from aiohttp import web as _xzg_web


def _patch_comfyapi_first_real_override():
    """comfy_api.internal.first_real_override 把普通函数误当绑定方法（读 .__func__），
    导致 V3 节点只要 def execute(self, ...) 是"普通未绑定函数"形式就炸：
      AttributeError: 'function' object has no attribute '__func__'
    这里做一次全局兼容 patch，保证我们及其他 V3 节点均不受影响。
    """
    try:
        from comfy_api import internal as _cai
    except Exception:
        return  # 无 comfy_api 无所谓

    if not hasattr(_cai, "first_real_override"):
        return
    if getattr(_cai.first_real_override, "_xzg_patched", False):
        return

    import inspect as _insp
    from typing import Callable as _C, Optional as _O

    def _unbind(func):
        """取一个 callable 的"底层真函数"。兼容 bound method / classmethod / staticmethod / 普通函数。"""
        if hasattr(func, "__func__"):
            return func.__func__          # bound method / classmethod descriptor
        if isinstance(func, staticmethod):
            return func.__func__
        if isinstance(func, classmethod):
            return func.__func__
        if callable(func):
            return func                   # 普通函数 / 任意 callable，本身就是真函数
        return func

    def _first_real_override_new(cls: type, name: str, *, base: type = None) -> _O[_C]:
        if base is None:
            if not hasattr(cls, "GET_BASE_CLASS"):
                raise ValueError(
                    "base is required if cls does not have a GET_BASE_CLASS; is this a valid ComfyNode subclass?"
                )
            base = cls.GET_BASE_CLASS()
        base_attr = getattr(base, name, None)
        if base_attr is None:
            return None
        base_func = _unbind(base_attr)
        for c in cls.mro():
            if c is base:
                break
            if name in c.__dict__:
                raw = c.__dict__[name]       # 取类 __dict__ 里的"原始描述符"
                func = _unbind(raw)
                if func is not base_func:
                    return getattr(cls, name)
        return None

    _first_real_override_new._xzg_patched = True
    try:
        _cai.first_real_override = _first_real_override_new
        # 若有其它模块已经 from comfy_api.internal import first_real_override，需要顺手修
        try:
            import comfy_api.latest._io as _cio
            if hasattr(_cio, "first_real_override"):
                _cio.first_real_override = _first_real_override_new
        except Exception:
            pass
    except Exception as _e:
        print("[xiaozhuguang] 尝试 patch comfy_api.first_real_override 失败（无影响）：", _e)


_patch_comfyapi_first_real_override()


def xzg_safe_handler(fn):
    """给小珠光自定义 aiohttp 路由 handler 统一兜底异常 + 打完整 traceback。"""

    def _fmt_resp(exc: BaseException, status: int = 500):
        tb_str = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
        # 真实返回给前端（含完整 traceback，方便定位）
        try:
            return _xzg_web.json_response(
                {"error": f"{type(exc).__name__}: {exc}", "traceback": tb_str},
                status=status,
            )
        except Exception:
            return _xzg_web.Response(status=500, text=f"{type(exc).__name__}: {exc}\n\n{tb_str}")

    if _asyncio.iscoroutinefunction(fn):
        @_ft.wraps(fn)
        async def _async_wrap(*a, **kw):
            try:
                return await fn(*a, **kw)
            except _xzg_web.HTTPException:
                raise  # aiohttp 自带的 3xx/4xx 正常上抛
            except BaseException as e:
                print(f"[小珠光路由异常] {fn.__name__}: {type(e).__name__}: {e}")
                _tb.print_exc()
                return _fmt_resp(e)

        return _async_wrap
    else:
        @_ft.wraps(fn)
        def _sync_wrap(*a, **kw):
            try:
                return fn(*a, **kw)
            except _xzg_web.HTTPException:
                raise
            except BaseException as e:
                print(f"[小珠光路由异常] {fn.__name__}: {type(e).__name__}: {e}")
                _tb.print_exc()
                return _fmt_resp(e)

        return _sync_wrap


def _safe_dir(fn_name: str, fallback_subdir: str):
    """folder_paths.*_directory() 可能返回 None → 兜底到 ComfyUI/models/<fallback_subdir>，os.path.join 不会炸。"""
    import folder_paths as _fp

    d = getattr(_fp, fn_name)()
    if d:
        os.makedirs(d, exist_ok=True)
        return d
    # 兜底到相对 ComfyUI 根的约定目录
    fallback = os.path.join(getattr(_fp, "models_dir", os.getcwd()), fallback_subdir)
    os.makedirs(fallback, exist_ok=True)
    print(f"[小珠光] folder_paths.{fn_name}() 返回 None，兜底使用: {fallback}")
    return fallback


import torch
import numpy as np
from PIL import Image
import hashlib
import json
import random
import folder_paths

# —— 无额外大依赖的基础节点，直接强导入（炸了就直接暴露真实问题） ——
from .nodes.xzg_get_widget import XiaozhuguangGetWidget
from .nodes.xzg_first_last_frame import XiaozhuguangFirstLastFrame
from .nodes.xzg_duplicate_first_frame import XiaozhuguangDuplicateFirstFrame
from .nodes.xzg_frame_extract import XiaozhuguangFrameExtract
from .nodes.xzg_image_loader import XiaozhuguangImageLoader
from .nodes.xzg_video_loader import XiaozhuguangVideoLoader
from .nodes.xzg_audio_loader import XiaozhuguangAudioLoader
from .nodes.xzg_video_info_reader import XiaozhuguangVideoInfoReader
from .nodes.xzg_video_combine import XiaozhuguangVideoCombine
from .nodes.xzg_image_compare import XiaozhuguangImageCompare
from .nodes.xzg_image_save import XiaozhuguangImageSave
from .nodes.xzg_audio_save import XiaozhuguangAudioSave
from .nodes.xzg_lazy_check import XiaozhuguangInputLazyCheck
from .nodes.xzg_text_box import XiaozhuguangTextBox
from .nodes.xzg_h3_prompt import XiaozhuguangNinimaxH3Prompt
from .nodes.xzg_qwen_loader import XiaozhuguangQwenModelLoader
from .nodes.xzg_atbc import XiaozhuguangATBC
from .nodes.xzg_atr import XiaozhuguangATR
from .nodes.xzg_face_align import XiaozhuguangFaceAlign
from .nodes.xzg_image_split_merge import XiaozhuguangImageSplitter, XiaozhuguangImageMerger

# —— 依赖 transformers / 大库的「可选节点」，导入失败只警告，不影响其它 20+ 个节点 ——
# (这些节点用户"找不到"最常见的原因就是 ComfyUI 环境没装 transformers)
XiaozhuguangQwenVLInstruct = None
try:
    from .nodes.xzg_qwen3_vl_instruct import XiaozhuguangQwenVLInstruct
except Exception as _qwen_err:
    print(
        "[小珠光] 跳过 qwenVL 节点（依赖缺失，如需使用请安装 transformers）：",
        _qwen_err,
    )


# ============ 小珠光 LongCat 离线 TTS（建模库已移植到本插件内部，无需外部插件） ============
# 原插件 ComfyUI-LongCat-AudioDIT-TTS 的 audiodit/ 建模包与 loader/model_cache 工具
# 已移植到本插件内部（_xzg_audiodit/、nodes/xzg_longcat_loader.py、nodes/xzg_longcat_model_cache.py），
# 本节点不再依赖外部插件，可独立运行。
#
# 核心特性：
#   1) 严格离线扫描 ComfyUI/models/audiodit/ 下的本地模型目录（不显示 "xxx (auto download)" 虚项）
#   2) 不会调用 huggingface_hub.snapshot_download；缺少模型/tokenizer 时给出清晰报错
#   3) transformers / safetensors 等大依赖缺失时静默跳过，不影响其它节点
_AUDIODIT_NODES: dict[str, tuple[type, str]] = {}
try:
    from .nodes.xzg_audiodit_tts import XzgAudioDiTVoiceCloneTTS
    _AUDIODIT_NODES["XzgAudioDiTVoiceCloneTTS"] = (
        XzgAudioDiTVoiceCloneTTS,
        "小珠光 LongCat",
    )
except Exception as _audiodit_init_err:
    print(
        "[小珠光AudioDiT] 未启用 LongCat TTS 节点（可能缺少 transformers / safetensors 等依赖）：",
        _audiodit_init_err,
    )
    _AUDIODIT_NODES = {}


# ============ 懒编码路由：右键保存真实分辨率图时，才临时编码全分辨率 PNG ============
try:
    from server import PromptServer
    from aiohttp import web
    from .nodes.xzg_image_save import REAL_STORE

    _xzg_save_real_routes = getattr(PromptServer, 'instance', None)
    if _xzg_save_real_routes is not None:
        _xzg_save_real_routes = _xzg_save_real_routes.routes
    else:
        # 兜底：空 decorator，仅让后续代码不出错
        class _Nop:
            def post(self, p):
                def deco(fn): return fn
                return deco
        _xzg_save_real_routes = _Nop()

    @_xzg_save_real_routes.post("/xzg_save_real")
    @xzg_safe_handler
    async def xzg_save_real(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "bad request"}, status=400)

        token = data.get("token")
        try:
            index = int(data.get("index", 0))
        except Exception:
            return web.json_response({"error": "bad index"}, status=400)

        store = REAL_STORE.get(token)
        if not store or index < 0 or index >= len(store):
            return web.json_response({"error": "not found"}, status=404)

        arr = store[index]
        if arr is None:
            return web.json_response({"error": "already served"}, status=404)

        output_dir = _safe_dir("get_temp_directory", "temp")
        fname = "xzg_real_" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(12)) + ".png"
        Image.fromarray(arr).save(os.path.join(output_dir, fname), "PNG")

        # 不销毁数据，允许重复保存（内存由 REAL_STORE 的 100 条上限自动清理）

        return web.json_response({"filename": fname, "subfolder": "", "type": "temp"})
except Exception as _e:
    print("[xiaozhuguang] 注册 /xzg_save_real 路由失败:", _e)


def tensor_to_pil(tensor):
    result = []
    for i in range(tensor.shape[0]):
        img = tensor[i].cpu().numpy()
        img = (img * 255).clip(0, 255).astype(np.uint8)
        result.append(Image.fromarray(img))
    return result


def save_images_for_preview(images, prefix="xzg_points_"):
    output_dir = folder_paths.get_temp_directory()
    os.makedirs(output_dir, exist_ok=True)
    results = []
    pil_images = tensor_to_pil(images)
    for i, img in enumerate(pil_images):
        filename = f"{prefix}{''.join(random.choice('abcdefghijklmnopqrstuvwxyz') for _ in range(6))}_{i}.png"
        filepath = os.path.join(output_dir, filename)
        img.save(filepath, compress_level=4)
        results.append({
            "filename": filename,
            "subfolder": "",
            "type": "temp"
        })
    return results


class XiaozhuguangPointsEditor:
    """
    小珠光点编辑器
    在图像上标注正面点、负面点和边界框
    """

    state = {
        "last_images_hash": None,
        "cached_preview": None,
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "info": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "preview_clarity": ("FLOAT", {"default": 1.0, "min": 0.05, "max": 1.0, "step": 0.05}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "INT")
    RETURN_NAMES = ("positive_coords", "negative_coords", "bbox", "frame_index")
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    OUTPUT_NODE = True

    def execute(self, image, info, preview_clarity=1.0):
        positive_coords = None
        negative_coords = None
        bboxes_str = None
        frame_index = 0

        needs_scaling = preview_clarity > 0 and preview_clarity < 1.0
        scale_factor = 1.0 / preview_clarity if needs_scaling else 1.0

        if info != '':
            try:
                info_data = json.loads(info)
            except json.JSONDecodeError:
                info_data = None

            if info_data is not None:
                positive_coords = info_data.get("positive_coords", None)
                negative_coords = info_data.get("negative_coords", None)
                box = info_data.get("bbox", None)
                frame_index = info_data.get("frame_index", 0)

                if needs_scaling:
                    if positive_coords is not None:
                        positive_coords = [{"x": coord["x"] * scale_factor, "y": coord["y"] * scale_factor} for coord in positive_coords]
                    if negative_coords is not None:
                        negative_coords = [{"x": coord["x"] * scale_factor, "y": coord["y"] * scale_factor} for coord in negative_coords]

                bbox_list = []
                if box is not None and len(box) > 0:
                    for i in box:
                        if needs_scaling:
                            x = i['x'] * scale_factor
                            y = i['y'] * scale_factor
                            w = i['w'] * scale_factor
                            h = i['h'] * scale_factor
                        else:
                            x = i['x']
                            y = i['y']
                            w = i['w']
                            h = i['h']
                        bbox_list.append([x, y, x + w, y + h])

                bboxes_str = json.dumps(bbox_list, ensure_ascii=False)

                if positive_coords is not None:
                    positive_coords = json.dumps(positive_coords, ensure_ascii=False)
                if negative_coords is not None:
                    negative_coords = json.dumps(negative_coords, ensure_ascii=False)

        preview_images = image
        if needs_scaling:
            _, height, width, _ = image.shape
            new_height = int(height * preview_clarity)
            new_width = int(width * preview_clarity)
            pil_images = tensor_to_pil(image)
            resized_pil = [img.resize((new_width, new_height), Image.LANCZOS) for img in pil_images]
            preview_images = torch.from_numpy(np.stack([np.array(img).astype(np.float32) / 255.0 for img in resized_pil]))

        images_hash = hashlib.md5(preview_images.cpu().numpy().tobytes()).hexdigest()
        rescale_hash = f"{images_hash}_{preview_clarity}"

        if 'last_images_hash' in self.state and self.state['last_images_hash'] == rescale_hash:
            preview_str = self.state['cached_preview']
            is_init = False
        else:
            preview = save_images_for_preview(preview_images)
            preview_str = json.dumps(preview, ensure_ascii=False)
            self.state['last_images_hash'] = rescale_hash
            self.state['cached_preview'] = preview_str
            is_init = True

        return {
            "ui": {
                "preview": [{"preview_str": preview_str, "is_init": is_init}]
            },
            "result": (
                positive_coords if positive_coords is not None else "[]",
                negative_coords if negative_coords is not None else "[]",
                bboxes_str if bboxes_str is not None else "[]",
                frame_index,
            )
        }


class XiaozhuguangSelector:
    """
    小珠光标签选择器
    通过点击按钮选择标签，输出对应的整数值
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "label": ("STRING", {"default": "0"}),
                "_xz_settings": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("value",)
    FUNCTION = "select"
    CATEGORY = "xiaozhuguang"

    def select(self, label, _xz_settings=""):
        try:
            val = int(label)
            return (val,)
        except (ValueError, TypeError):
            return (0,)




class XiaozhuguangBooleanSelector:
    """
    小珠光布尔选择器
    开关切换 True/False，支持自定义外观
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "boolean_value": ("BOOLEAN", {"default": False}),
                "_xz_settings": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("boolean",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"

    def execute(self, boolean_value, _xz_settings=""):
        return (boolean_value,)


class XiaozhuguangBoolNot:
    """
    小珠光反向布尔
    输入布尔值，输出反向布尔值
    输入 true 输出 false，输入 false 输出 true
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "boolean": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("inverted_boolean",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"

    def execute(self, boolean):
        return (not boolean,)


class XiaozhuguangDataBlock:
    """
    小珠光数据阻断
    开关开启时数据通过，关闭时阻断输出 None
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "输入": ("*", {}),
                "传输数据": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("输出",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"

    @classmethod
    def VALIDATE_INPUTS(cls, input_types):
        return True

    def execute(self, 传输数据, 输入=None):
        if 传输数据:
            return (输入,)
        else:
            return (None,)


class XiaozhuguangCompareDataBlock:
    """
    小珠光比较大小-数据阻断
    比较输入整数与设定值的大小关系，大于/等于/小于时传输数据，否则阻断输出 None
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "输入": ("*", {}),
                "输入整数": ("INT", {"default": 0, "min": -999999, "max": 999999, "step": 1, "forceInput": True}),
                "比较方式": (["大于", "等于", "小于"], {"default": "大于"}),
                "比较值": ("INT", {"default": 0, "min": -999999, "max": 999999, "step": 1}),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("输出",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"

    @classmethod
    def VALIDATE_INPUTS(cls, input_types):
        return True

    def execute(self, 输入整数, 比较方式, 比较值, 输入=None):
        # 确保比较值是整数
        try:
            val = int(比较值)
        except (ValueError, TypeError):
            return (None,)

        # 确保输入整数有效
        try:
            input_val = int(输入整数)
        except (ValueError, TypeError):
            return (None,)

        if 比较方式 == "大于":
            if input_val > val:
                return (输入,)
        elif 比较方式 == "等于":
            if input_val == val:
                return (输入,)
        elif 比较方式 == "小于":
            if input_val < val:
                return (输入,)

        return (None,)


class XiaozhuguangTitle:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    OUTPUT_NODE = False
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"

    def execute(self):
        return ()


class XiaozhuguangNumberSwitch:
    """
    小珠光编号切换
    通过选择器在多个任意类型数据之间切换输出
    选择器 0-49 对应输入口 值0~值49
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(50):
            optional[f"value{i}"] = ("*", {})
        return {
            "required": {
                "select": ("INT", {"default": 0, "min": 0, "max": 49, "step": 1, "display": "number", "forceInput": True}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("output",)
    FUNCTION = "switch"
    CATEGORY = "xiaozhuguang"

    def switch(self, select, **kwargs):
        select = min(max(select, 0), 49)
        val = kwargs.get(f"value{select}")
        return (val,)




class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False

any_type = AnyType("*")


class XiaozhuguangUniversalSlider:
    """
    小珠光万能滑条
    支持浮点 / 整数双模式切换，右键切换类型
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": ("FLOAT", {
                    "default": 0.50,
                    "min": -999999,
                    "max": 999999,
                    "step": 0.01,
                    "display": "slider",
                }),
            },
            "hidden": {
                "output_type": (["float", "int"], {"default": "float"}),
            },
        }

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("output",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"

    def execute(self, value, output_type="float"):
        processed_value = round(float(value), 10)
        if output_type == "int":
            return (int(round(processed_value)),)
        else:
            return (processed_value,)

    @classmethod
    def IS_CHANGED(cls, value, output_type="float"):
        processed_value = round(float(value), 10)
        if output_type == "int":
            return int(round(processed_value))
        return processed_value


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangPointsEditor": XiaozhuguangPointsEditor,
    "XiaozhuguangSelector": XiaozhuguangSelector,
    "XiaozhuguangBooleanSelector": XiaozhuguangBooleanSelector,
    "XiaozhuguangBoolNot": XiaozhuguangBoolNot,
    "XiaozhuguangDataBlock": XiaozhuguangDataBlock,
    "XiaozhuguangCompareDataBlock": XiaozhuguangCompareDataBlock,
    "XiaozhuguangTitle": XiaozhuguangTitle,
    "XiaozhuguangNumberSwitch": XiaozhuguangNumberSwitch,
    "XiaozhuguangUniversalSlider": XiaozhuguangUniversalSlider,
    "XiaozhuguangGetWidget": XiaozhuguangGetWidget,
    "XiaozhuguangFirstLastFrame": XiaozhuguangFirstLastFrame,
    "XiaozhuguangDuplicateFirstFrame": XiaozhuguangDuplicateFirstFrame,
    "XiaozhuguangFrameExtract": XiaozhuguangFrameExtract,
    "XiaozhuguangImageLoader": XiaozhuguangImageLoader,
    "XiaozhuguangVideoLoader": XiaozhuguangVideoLoader,
    "XiaozhuguangAudioLoader": XiaozhuguangAudioLoader,
    "XiaozhuguangVideoInfoReader": XiaozhuguangVideoInfoReader,
    "XiaozhuguangVideoCombine": XiaozhuguangVideoCombine,
    "XiaozhuguangImageCompare": XiaozhuguangImageCompare,
    "XiaozhuguangImageSave": XiaozhuguangImageSave,
    "XiaozhuguangAudioSave": XiaozhuguangAudioSave,
    "XiaozhuguangInputLazyCheck": XiaozhuguangInputLazyCheck,
    "XiaozhuguangTextBox": XiaozhuguangTextBox,
    "XiaozhuguangNinimaxH3Prompt": XiaozhuguangNinimaxH3Prompt,
    "XiaozhuguangQwenModelLoader": XiaozhuguangQwenModelLoader,
    "XiaozhuguangATBC": XiaozhuguangATBC,
    "XiaozhuguangATR": XiaozhuguangATR,
    "XiaozhuguangFaceAlign": XiaozhuguangFaceAlign,
    "XiaozhuguangImageSplitter": XiaozhuguangImageSplitter,
    "XiaozhuguangImageMerger": XiaozhuguangImageMerger,
}
# 可选大依赖节点：只有导入成功才加入映射
if XiaozhuguangQwenVLInstruct is not None:
    NODE_CLASS_MAPPINGS["XiaozhuguangQwenVLInstruct"] = XiaozhuguangQwenVLInstruct
NODE_CLASS_MAPPINGS.update({k: v[0] for k, v in _AUDIODIT_NODES.items()})

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangSelector": "小珠光选择器",
    "XiaozhuguangBooleanSelector": "小珠光布尔",
    "XiaozhuguangBoolNot": "小珠光反向布尔",
    "XiaozhuguangDataBlock": "小珠光数据阻断",
    "XiaozhuguangCompareDataBlock": "小珠光比较大小-数据阻断",
    "XiaozhuguangTitle": "小珠光标题",
    "XiaozhuguangNumberSwitch": "小珠光编号切换",
    "XiaozhuguangUniversalSlider": "小珠光万能滑条",
    "XiaozhuguangPointsEditor": "小珠光点编辑器",
    "XiaozhuguangGetWidget": "小珠光获取控件值",
    "XiaozhuguangFirstLastFrame": "小珠光首尾帧",
    "XiaozhuguangDuplicateFirstFrame": "小珠光帧优化",
    "XiaozhuguangFrameExtract": "小珠光帧提取",
    "XiaozhuguangImageLoader": "小珠光图像加载器",
    "XiaozhuguangVideoLoader": "小珠光视频加载器",
    "XiaozhuguangAudioLoader": "小珠光音频加载器",
    "XiaozhuguangVideoInfoReader": "小珠光视频信息读取",
    "XiaozhuguangVideoCombine": "小珠光合并视频",
    "XiaozhuguangImageCompare": "小珠光图像对比",
    "XiaozhuguangImageSave": "小珠光图像保存",
    "XiaozhuguangAudioSave": "小珠光音频保存",
    "XiaozhuguangInputLazyCheck": "小珠光输入惰性判断",
    "XiaozhuguangTextBox": "小珠光文本框",
    "XiaozhuguangNinimaxH3Prompt": "小珠光 MiniMax H3 提示词",
    "XiaozhuguangQwenModelLoader": "小珠光 Qwen Model Loader",
    "XiaozhuguangATBC": "小珠光 ATBC (智能裁剪)",
    "XiaozhuguangATR": "小珠光 ATR (图像回贴)",
    "XiaozhuguangFaceAlign": "小珠光 Face Align (人脸对齐)",
    "XiaozhuguangImageSplitter": "小珠光 IS (图像分割)",
    "XiaozhuguangImageMerger": "小珠光 IM (图像合并)",
}
if XiaozhuguangQwenVLInstruct is not None:
    NODE_DISPLAY_NAME_MAPPINGS["XiaozhuguangQwenVLInstruct"] = "小珠光qwenVL"
NODE_DISPLAY_NAME_MAPPINGS.update({k: v[1] for k, v in _AUDIODIT_NODES.items()})

WEB_DIRECTORY = "./web"

from . import workflows

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
