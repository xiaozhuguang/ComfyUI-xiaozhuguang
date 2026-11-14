import importlib.util
from pathlib import Path
import unittest

import torch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / "nodes" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ATBC = load("xzg_atbc").XiaozhuguangATBC
ATR = load("xzg_atr").XiaozhuguangATR


class SeamContextTest(unittest.TestCase):
    def test_context_does_not_move_seam(self):
        devices = ["CPU"] + (["GPU"] if torch.cuda.is_available() else [])
        image = torch.zeros(2, 180, 320, 3)
        mask = torch.zeros(2, 180, 320)
        mask[0, :, 60:140] = 1
        mask[1, :, 100:180] = 1
        for device in devices:
            for mode in ("逐帧裁剪", "视频稳定跟踪"):
                for alignment in ("扩充", "变形"):
                    for blur, expand in ((0, 0), (7, -5)):
                        results = []
                        for factor, pixels in ((1, 0 if blur == 0 else 10), (1, 30), (1.5, 40)):
                            with self.subTest(device=device, mode=mode, alignment=alignment,
                                              blur=blur, factor=factor, pixels=pixels):
                                cropped, info, _ = ATBC().crop_and_resize(
                                    image, mask=mask, kilopixels=100, Box_grow_factor=factor,
                                    Box_grow_pixels=pixels, crop_mode=mode, alignment_mode=alignment)
                                self.assertEqual(info["crop_infos"][0]["seam_box"], (60, 0, 140, 180))
                                changed = torch.full_like(cropped, .8)
                                restored = ATR().restore_image(
                                    image, changed, info, blur, mask_expand=expand,
                                    compute_device=device)[0]
                                results.append(restored)
                        for result in results[1:]:
                            self.assertLess((result-results[0]).abs().max().item(), 2/255,
                                            (device, mode, alignment, blur, expand))
                        if blur == 0:
                            self.assertLess(results[-1][0, :, :60].max().item(), 1/255)
                            self.assertGreater(results[-1][0, :, 60:140].min().item(), .79)

    def test_explicit_mask_overrides_seam_and_old_metadata_works(self):
        image = torch.zeros(1, 180, 320, 3)
        mask = torch.zeros(1, 180, 320)
        mask[:, 50:130, 100:180] = 1
        cropped, info, _ = ATBC().crop_and_resize(image, mask=mask, kilopixels=100,
                                                Box_grow_pixels=20, alignment_mode="变形")
        changed = torch.full_like(cropped, .8)
        explicit = torch.zeros(cropped.shape[:3])
        result = ATR().restore_image(image, changed, info, 0, mask=explicit, compute_device="CPU")[0]
        self.assertEqual(result.max().item(), 0)
        del info["crop_infos"][0]["seam_box"]
        legacy = ATR().restore_image(image, changed, info, 0, compute_device="CPU")[0]
        self.assertGreater(legacy[0, 40, 90].min().item(), .79)


if __name__ == "__main__":
    unittest.main()
