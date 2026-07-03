import torch
import numpy as np
from PIL import Image
import hashlib
import json
import os
import random
import folder_paths


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
                "预览清晰度": ("FLOAT", {"default": 1.0, "min": 0.05, "max": 1.0, "step": 0.05}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "INT")
    RETURN_NAMES = ("正面点坐标", "负面点坐标", "边界框", "帧索引")
    FUNCTION = "execute"
    CATEGORY = "小珠光"
    OUTPUT_NODE = True

    def execute(self, image, info, 预览清晰度=1.0):
        positive_coords = None
        negative_coords = None
        bboxes_str = None
        frame_index = 0

        needs_scaling = 预览清晰度 > 0 and 预览清晰度 < 1.0
        scale_factor = 1.0 / 预览清晰度 if needs_scaling else 1.0

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
            new_height = int(height * 预览清晰度)
            new_width = int(width * 预览清晰度)
            pil_images = tensor_to_pil(image)
            resized_pil = [img.resize((new_width, new_height), Image.LANCZOS) for img in pil_images]
            preview_images = torch.from_numpy(np.stack([np.array(img).astype(np.float32) / 255.0 for img in resized_pil]))

        images_hash = hashlib.md5(preview_images.cpu().numpy().tobytes()).hexdigest()
        rescale_hash = f"{images_hash}_{预览清晰度}"

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
                "标签": ("STRING", {"default": "0"}),
                "_xz_settings": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("数值",)
    FUNCTION = "select"
    CATEGORY = "小珠光"

    def select(self, 标签, _xz_settings=""):
        try:
            val = int(标签)
            return (val,)
        except (ValueError, TypeError):
            return (0,)




class XiaozhuguangBooleanSelector:
    """
    小珠光布尔选择器
    开关切换 True/False，输出布尔值
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "布尔值": ("BOOLEAN", {"default": False}),
                "_xz_settings": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("输出",)
    FUNCTION = "execute"
    CATEGORY = "小珠光"
    OUTPUT_NODE = False

    def execute(self, 布尔值, _xz_settings=""):
        return (int(bool(布尔值)),)


class XiaozhuguangTitle:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    OUTPUT_NODE = False
    FUNCTION = "execute"
    CATEGORY = "小珠光"

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
            optional[f"值{i}"] = ("*", {})
        return {
            "required": {
                "选择": ("INT", {"default": 0, "min": 0, "max": 49, "step": 1, "display": "number", "forceInput": True}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("输出",)
    FUNCTION = "switch"
    CATEGORY = "小珠光"

    def switch(self, 选择, **kwargs):
        选择 = min(max(选择, 0), 49)
        val = kwargs.get(f"值{选择}")
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
                "值": ("FLOAT", {
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
    RETURN_NAMES = ("*",)
    FUNCTION = "execute"
    CATEGORY = "小珠光"

    def execute(self, 值, output_type="float"):
        processed_value = round(float(值), 10)
        if output_type == "int":
            return (int(round(processed_value)),)
        else:
            return (processed_value,)

    @classmethod
    def IS_CHANGED(cls, 值, output_type="float"):
        processed_value = round(float(值), 10)
        if output_type == "int":
            return int(round(processed_value))
        return processed_value


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangSelector": XiaozhuguangSelector,
    "XiaozhuguangBooleanSelector": XiaozhuguangBooleanSelector,
    "XiaozhuguangTitle": XiaozhuguangTitle,
    "XiaozhuguangNumberSwitch": XiaozhuguangNumberSwitch,
    "XiaozhuguangUniversalSlider": XiaozhuguangUniversalSlider,
    "XiaozhuguangPointsEditor": XiaozhuguangPointsEditor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangSelector": "小珠光选择器",
    "XiaozhuguangBooleanSelector": "小珠光布尔",
    "XiaozhuguangTitle": "小珠光标题",
    "XiaozhuguangNumberSwitch": "小珠光编号切换",
    "XiaozhuguangUniversalSlider": "小珠光万能滑条",
    "XiaozhuguangPointsEditor": "小珠光点编辑器",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
