import logging
from contextlib import suppress
from fractions import Fraction
from pathlib import Path
from uuid import uuid4

import folder_paths
import torch.nn.functional as F
from comfy_api.latest import InputImpl, Types


def prepare_reference(images, fps, info):
    directory = Path(folder_paths.get_temp_directory()) / "xzg_video_compare"
    path = directory / f"{uuid4().hex}.mp4"
    try:
        directory.mkdir(parents=True, exist_ok=True)
        height, width = images.shape[1:3]
        if height % 2 or width % 2:
            images = F.pad(images.movedim(-1, 1), (0, width % 2, 0, height % 2),
                           mode="replicate").movedim(1, -1)
        video = InputImpl.VideoFromComponents(
            Types.VideoComponents(images=images, frame_rate=Fraction(str(fps))),
        )
        video.save_to(str(path), format=Types.VideoContainer("mp4"), codec=Types.VideoCodec("h264"),
                      chroma_subsampling="420")
    except Exception:
        with suppress(OSError):
            path.unlink(missing_ok=True)
        logging.exception("Unable to prepare XZG reference video")
        info["message"] = "参考画面准备失败，详情见 ComfyUI 控制台。"
        info["message_en"] = "Unable to prepare the reference. See the ComfyUI console."
    else:
        info["video"] = {"filename": path.name, "subfolder": directory.name, "type": "temp"}
