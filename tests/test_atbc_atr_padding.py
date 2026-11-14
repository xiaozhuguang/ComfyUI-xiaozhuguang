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
        for crop_mode in ("逐帧裁剪", "视频稳定跟踪"):
            for alignment in ("变形", "扩充"):
                for use_mask in (False, True):
                    with self.subTest(device=device, crop_mode=crop_mode, alignment=alignment, mask=use_mask):
                        image = torch.full((2, 180, 320, 3), .2)
                        mask = torch.zeros(2, 180, 320)
                        mask[0, 50:130, :250] = 1
                        mask[1, 50:130, 70:] = 1
                        cropped, info, cropped_mask = ATBC().crop_and_resize(
                            image, mask=mask, kilopixels=100, Box_grow_pixels=30,
                            alignment_mode=alignment, crop_mode=crop_mode, ratio="1:1")
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

    def test_face_crop_keeps_fractional_motion_and_restores_registration(self):
        image = torch.zeros(5, 64, 64, 3)
        image[..., 0] = torch.arange(64) / 64
        image[..., 1] = (torch.arange(64) / 64)[:, None]
        mask = torch.zeros(5, 64, 64)
        mask[:2, 24:38, 20:34] = 1
        mask[2:, 24:39, 21:35] = 1
        cropped, info, cropped_mask = ATBC().crop_and_resize(
            image, mask=mask, crop_mode="人脸构图", ratio="1:1", Box_grow_factor=1.6,
            alignment_mode="扩充", kilopixels=100)
        boxes = [item["subpixel_box"] for item in info["crop_infos"]]
        center_x = [(box[0] + box[2]) / 2 for box in boxes]
        self.assertTrue(all(0 < b - a < 1 for a, b in zip(center_x, center_x[1:])))
        center_colors = cropped[:, cropped.shape[1] // 2, cropped.shape[2] // 2, 0]
        self.assertTrue(torch.all(torch.diff(center_colors) > 0))
        devices = ["CPU", "GPU"] if torch.cuda.is_available() else ["CPU"]
        for device in devices:
            with self.subTest(device=device):
                restored = ATR().restore_image(
                    image, cropped, info, mask=cropped_mask, compute_device=device)[0]
                self.assertLess((restored - image).abs().max().item(), 3 / 255)

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
