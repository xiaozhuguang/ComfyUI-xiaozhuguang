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


class PaddingRoundtripTest(unittest.TestCase):
    def check_roundtrip(self, device):
        for crop_mode in ("遮罩平滑", "视频稳定跟踪"):
            for alignment in ("变形", "扩充"):
                for use_mask in (False, True):
                    with self.subTest(device=device, crop_mode=crop_mode, alignment=alignment, mask=use_mask):
                        image = torch.full((2, 180, 320, 3), .2)
                        mask = torch.zeros(2, 180, 320)
                        mask[0, :, :85] = 1
                        mask[1, :, 235:] = 1
                        cropped, info, cropped_mask = ATBC().crop_and_resize(
                            image, mask=mask, kilopixels=100, Box_grow_pixels=30,
                            alignment_mode=alignment, crop_mode=crop_mode)
                        for frame in info["crop_infos"]:
                            self.assertIn("output_valid_box", frame)
                        # Make all padding bright magenta: it must never reach the original.
                        for i, frame in enumerate(info["crop_infos"]):
                            x0, y0, x1, y1 = frame["output_valid_box"]
                            valid = cropped[i, y0:y1, x0:x1].clone()
                            cropped[i] = torch.tensor([1., 0., 1.])
                            cropped[i, y0:y1, x0:x1] = valid
                        restored = ATR().restore_image(
                            image, cropped, info, 0, mask=cropped_mask if use_mask else None,
                            compute_device=device)[0]
                        self.assertEqual(restored.shape, image.shape)
                        self.assertLess((restored - image).abs().max().item(), 2 / 255)

    def test_cpu_roundtrip(self):
        self.check_roundtrip("CPU")

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA unavailable")
    def test_gpu_roundtrip(self):
        self.check_roundtrip("GPU")

    def test_pattern_is_not_shifted_and_no_padding_is_compatible(self):
        image = torch.zeros(1, 180, 320, 3)
        image[:, :, :, 0] = torch.linspace(.1, .7, 320)
        image[:, :, :, 1] = torch.linspace(.1, .7, 180)[:, None]
        mask = torch.ones(1, 180, 320)
        for pixels in (0, 30):
            cropped, info, _ = ATBC().crop_and_resize(
                image, mask=mask, kilopixels=100, Box_grow_pixels=pixels, alignment_mode="变形")
            restored = ATR().restore_image(image, cropped, info, 0, compute_device="CPU")[0]
            self.assertLess((restored - image).abs().max().item(), 3 / 255)


if __name__ == "__main__":
    unittest.main()
