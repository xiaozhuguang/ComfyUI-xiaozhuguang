import importlib.util
from pathlib import Path
import unittest

import numpy as np
import torch


spec = importlib.util.spec_from_file_location(
    "xzg_atbc", Path(__file__).resolve().parents[1] / "nodes" / "xzg_atbc.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AutoRatioTest(unittest.TestCase):
    def test_free_ratio_and_32_alignment(self):
        node = module.XiaozhuguangATBC()
        self.assertEqual(node.INPUT_TYPES()["optional"]["divisible_by"][1]["default"], 32)
        image = torch.zeros(1, 240, 400, 3)
        mask = torch.zeros(1, 240, 400)
        mask[:, 50:150, 50:300] = 1
        box, ar = node._compute_crop_box(mask[0].numpy() * 255, 400, 240, 1, "auto")
        self.assertEqual(ar[0] / ar[1], 2.5)
        self.assertEqual(box, (50, 50, 300, 150))
        output, _, _ = node.crop_and_resize(image, mask=mask, kilopixels=100, divisible_by=32)
        self.assertEqual(tuple(output.shape[1:3]), (192, 512))
        _, manual = node._compute_crop_box(mask[0].numpy() * 255, 400, 240, 1, "16:9")
        self.assertAlmostEqual(manual[0] / manual[1], 16 / 9)

    def test_budget_selection_and_crop_coverage(self):
        node = module.XiaozhuguangATBC()
        self.assertEqual(node._calculate_auto_dimensions(1000, (2.5, 1)), (1568, 640))
        self.assertEqual(node._calculate_auto_dimensions(1000, (1, 2.5)), (640, 1568))
        self.assertEqual(sorted(node._calculate_auto_dimensions(1000, (1, 1))), [992, 1024])
        for multiple in (1, 8, 32, 64):
            w, h = node._calculate_auto_dimensions(1000, (2.5, 1), multiple)
            self.assertEqual(w % 32, 0)
            self.assertEqual(h % 32, 0)
            self.assertEqual(w % multiple, 0)
            self.assertEqual(h % multiple, 0)
        image = torch.zeros(1, 240, 400, 3)
        mask = torch.zeros(1, 240, 400)
        mask[:, 50:150, 50:300] = 1
        output, info, _ = node.crop_and_resize(image, mask=mask, kilopixels=1000)
        self.assertEqual(tuple(output.shape[1:3]), (640, 1568))
        crop = info["crop_infos"][0]
        pl, pt, _, _ = crop["pad_info"]
        x0, y0, x1, y1 = crop["original_coords"]
        self.assertLessEqual(x0 - pl, 50)
        self.assertLessEqual(y0 - pt, 50)
        self.assertGreaterEqual(x1 - pl, 300)
        self.assertGreaterEqual(y1 - pt, 150)
        self.assertAlmostEqual((x1-x0)/(y1-y0), 1568/640)

    def test_tracking_uses_free_median_ratio_and_covers_masks(self):
        node = module.XiaozhuguangATBC()
        masks = np.zeros((2, 240, 400), dtype=np.float32)
        masks[0, 50:150, 50:300] = 1
        masks[1, 51:152, 51:302] = 1
        expected = 250.5 / 100.5
        boxes = node._tracking_boxes(masks, 400, 240, 1, 0, "auto", "紧凑优先", "固定大小")
        for frame, (x0, y0, x1, y1) in zip(masks, boxes):
            ys, xs = np.where(frame > 0)
            self.assertLessEqual(x0, xs.min())
            self.assertLessEqual(y0, ys.min())
            self.assertGreaterEqual(x1, xs.max() + 1)
            self.assertGreaterEqual(y1, ys.max() + 1)
            self.assertAlmostEqual((x1 - x0) / (y1 - y0), expected, delta=.02)
        image = torch.zeros(2, 240, 400, 3)
        output, _, _ = node.crop_and_resize(
            image, mask=torch.from_numpy(masks), kilopixels=100, divisible_by=32,
            crop_mode="视频稳定跟踪")
        self.assertEqual(output.shape[1] % 32, 0)
        self.assertEqual(output.shape[2] % 32, 0)

    def test_batch_selects_one_budget_before_resizing(self):
        node = module.XiaozhuguangATBC()
        image = torch.zeros(3, 240, 400, 3)
        mask = torch.zeros(3, 240, 400)
        mask[0, 80:120, 40:340] = 1
        mask[1, 20:220, 160:200] = 1
        mask[2, 50:150, 100:300] = 1
        for options in ({}, {"sum_mask": True}, {"mask_smooth": .5},
                        {"alignment_mode": "变形"}, {"ratio": "16:9"}):
            with self.subTest(options=options):
                output, info, output_mask = node.crop_and_resize(
                    image, mask=mask, kilopixels=1000, Box_grow_pixels=10, **options)
                height, width = output.shape[1:3]
                self.assertEqual(output_mask.shape, output.shape[:3])
                self.assertEqual(width % 32, 0)
                self.assertEqual(height % 32, 0)
                self.assertLess(abs(width * height - 1000000), 100000)
                for i, crop in enumerate(info["crop_infos"]):
                    self.assertEqual(crop["output_size"], (width, height))
                    self.assertEqual(crop["output_content_box"], (0, 0, width, height))
                    pl, pt, _, _ = crop["pad_info"]
                    x0, y0, x1, y1 = crop["original_coords"]
                    ys, xs = np.where(mask[i].numpy() > 0)
                    self.assertLessEqual(x0 - pl, xs.min() - 10)
                    self.assertLessEqual(y0 - pt, ys.min() - 10)
                    self.assertGreaterEqual(x1 - pl, xs.max() + 11)
                    self.assertGreaterEqual(y1 - pt, ys.max() + 11)
                    if options.get("alignment_mode") != "变形":
                        self.assertAlmostEqual((x1-x0)/(y1-y0), width/height)


if __name__ == "__main__":
    unittest.main()
