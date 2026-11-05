import importlib.util
from pathlib import Path
import unittest

import torch


spec = importlib.util.spec_from_file_location(
    "xzg_image_scale_aspect", Path(__file__).resolve().parents[1] / "nodes/xzg_image_scale_aspect.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OriginalRatioTest(unittest.TestCase):
    def test_total_pixels_preserves_full_frame_for_all_fit_modes(self):
        node = module.XiaozhuguangImageScaleByAspectRatioV2()
        for height, width in ((101, 307), (307, 101), (101, 101)):
            # 坐标渐变同时检查整幅画面的空间映射与 image/mask 对齐。
            mask = torch.linspace(0, 1, height * width).reshape(1, height, width)
            image = mask.unsqueeze(-1).expand(-1, -1, -1, 3).clone()
            for method in ("bilinear", "bicubic", "nearest", "lanczos"):
                results = []
                for fit in ("fill", "crop", "letterbox"):
                    result = node.execute(
                        "原始比例", 1, 1, fit, method, "None",
                        "total_pixel(kilo pixel)", 4, "#ff0000", image, mask)
                    results.append(result)
                expected_image, expected_mask, w, h = results[0]
                scale = (4000 / (width * height)) ** 0.5
                self.assertEqual((w, h), (round(width * scale), round(height * scale)))
                for out_image, out_mask, ow, oh in results:
                    self.assertEqual((ow, oh), (w, h))
                    torch.testing.assert_close(out_image, expected_image)
                    torch.testing.assert_close(out_mask, expected_mask)
                    torch.testing.assert_close(out_image[..., 0], out_mask)

    def test_explicit_alignment_still_applies(self):
        node = module.XiaozhuguangImageScaleByAspectRatioV2()
        _, mask, w, h = node.execute(
            "原始比例", 1, 1, "letterbox", "bilinear", "8",
            "total_pixel(kilo pixel)", 4, "#000000",
            mask=torch.ones(1, 101, 307))
        self.assertEqual((w % 8, h % 8), (0, 0))
        self.assertEqual(tuple(mask.shape), (1, h, w))
        self.assertEqual(mask.min().item(), 0)


if __name__ == "__main__":
    unittest.main()
