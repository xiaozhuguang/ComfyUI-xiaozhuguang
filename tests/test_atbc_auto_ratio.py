import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np
import torch


spec = importlib.util.spec_from_file_location(
    "xzg_atbc", Path(__file__).resolve().parents[1] / "nodes" / "xzg_atbc.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AutoRatioTest(unittest.TestCase):
    def test_sum_mask_locks_aligned_source_window_and_preserves_motion(self):
        node = module.XiaozhuguangATBC()
        image = torch.zeros(3, 96, 160, 3)
        image[:, :, 78:82, 1] = 1
        mask = torch.zeros(3, 96, 160)
        for frame, x in enumerate((28, 64, 100)):
            mask[frame, 24:54, x:x+22] = 1
        image[..., 0] = mask

        with patch.object(node, "_fit_crop_to_output", wraps=node._fit_crop_to_output) as fit:
            cropped, info, cropped_mask = node.crop_and_resize(
                image, mask=mask, sum_mask=True, ratio="auto", kilopixels=100)
        fit.assert_called_once()
        boxes = info["crop_infos"]
        for key in ("original_coords", "subpixel_box", "pad_info", "output_content_box"):
            self.assertTrue(all(box.get(key) == boxes[0].get(key) for box in boxes))
        torch.testing.assert_close(cropped[..., 1], cropped[0, ..., 1].expand_as(cropped[..., 1]))
        centers = [torch.where(frame > 0.5)[1].float().mean().item() for frame in cropped_mask]
        self.assertLess(centers[0], centers[1])
        self.assertLess(centers[1], centers[2])

    def test_face_composition_tracks_approaching_subject(self):
        node = module.XiaozhuguangATBC()
        frame_count = 49
        image = torch.zeros(frame_count, 144, 192, 3)
        mask = torch.zeros(frame_count, 144, 192)
        for i in range(frame_count):
            size = 16 + i
            x, y = 52 + i + (-1) ** i * 2, 72
            if i != 24:
                mask[i, y-size//2:y-size//2+size, x-size//2:x-size//2+size] = 1

        cropped, info, cropped_mask = node.crop_and_resize(
            image, mask=mask, crop_mode="人脸构图", ratio="1:1",
            Box_grow_factor=1.5, kilopixels=100)
        boxes = info["crop_infos"]
        self.assertEqual(cropped.shape[:3], cropped_mask.shape)
        self.assertEqual(len(boxes), frame_count)
        self.assertGreater(boxes[-1]["source_crop_size"][1], 2 * boxes[0]["source_crop_size"][1])
        self.assertGreater(boxes[-1]["min_margin"], boxes[0]["min_margin"])
        self.assertGreater(boxes[24]["source_crop_size"][1], boxes[0]["source_crop_size"][1])
        for box in boxes:
            subject = box["subject_box"]
            if subject is None:
                continue
            x0, y0, x1, y1 = box["original_coords"]
            left, top, _, _ = box["pad_info"]
            sx0, sy0, sx1, sy1 = subject
            margin = box["min_margin"]
            self.assertLessEqual(x0 - left, sx0 - margin)
            self.assertLessEqual(y0 - top, sy0 - margin)
            self.assertGreaterEqual(x1 - left, sx1 + margin)
            self.assertGreaterEqual(y1 - top, sy1 + margin)
            self.assertGreater((sy1 - sy0) / (y1 - y0), 0.45)
            self.assertLess(abs((sx0 + sx1 - x0 - x1 + 2 * left) / (2 * (x1 - x0))), 0.14)

    def test_face_crop_crosses_source_height_without_padding_or_jump(self):
        node = module.XiaozhuguangATBC()
        image = torch.full((6, 64, 96, 3), 0.5)
        mask = torch.zeros(6, 64, 96)
        for i in range(6):
            mask[i, max(0, 3 - i):33, 35:61] = 1
        for alignment in ("扩充", "变形"):
            with self.subTest(alignment=alignment):
                result, info, _ = node.crop_and_resize(
                    image, mask=mask, crop_mode="人脸构图", ratio="1:1",
                    alignment_mode=alignment, Box_grow_factor=2.0, kilopixels=100,
                    fill_color="#000000", face_position_smoothing=0, face_scale_smoothing=0)
                boxes = np.array([item["subpixel_box"] for item in info["crop_infos"]])
                np.testing.assert_allclose(boxes[:, 1], 0)
                self.assertLessEqual(boxes[:, 3].max(), 64)
                self.assertLessEqual(np.abs(np.diff(boxes[:, 3])).max(), 2.000001)
                torch.testing.assert_close(result, torch.full_like(result, 0.5))

    def test_face_composition_rejects_isolated_bbox_spike(self):
        node = module.XiaozhuguangATBC()
        masks = np.zeros((15, 96, 96), dtype=np.float32)
        masks[:, 38:58, 38:58] = 1
        masks[7, 10:20, 10:20] = 1
        boxes = node._tracking_boxes(
            masks, 96, 96, 1.2, 0, "1:1", "稳定优先", "动态缩放", face_composition=True)
        self.assertEqual(boxes[6], boxes[7])
        self.assertEqual(boxes[7], boxes[8])

    def test_face_smoothing_controls_independent_position_and_scale(self):
        node = module.XiaozhuguangATBC()
        frames = np.zeros((15, 90, 90), dtype=np.float32)
        for i, frame in enumerate(frames):
            offset = 2 * (i % 2)
            frame[30:50 + offset, 30 + offset:50 + offset] = 1

        def geometry(position, scale):
            boxes = np.asarray(node._tracking_boxes(
                frames, 90, 90, 2, 0, "1:1", "稳定优先", "动态缩放", face_composition=True,
                face_position_smoothing=position, face_scale_smoothing=scale))
            return (boxes[:, 0] + boxes[:, 2]) / 2, boxes[:, 3] - boxes[:, 1]

        raw_x, raw_h = geometry(0, 0)
        smooth_x, position_only_h = geometry(3, 0)
        scale_only_x, smooth_h = geometry(0, 6)
        np.testing.assert_allclose(raw_h, position_only_h, rtol=1e-12)
        self.assertLess(np.ptp(smooth_x), np.ptp(raw_x))
        self.assertLess(np.ptp(smooth_h), np.ptp(raw_h))
        self.assertGreaterEqual(np.ptp(scale_only_x), np.ptp(smooth_x))

    def test_free_ratio_and_32_alignment(self):
        node = module.XiaozhuguangATBC()
        self.assertEqual(node.INPUT_TYPES()["optional"]["divisible_by"][1]["default"], 32)
        image = torch.zeros(1, 240, 400, 3)
        mask = torch.zeros(1, 240, 400)
        mask[:, 50:150, 50:300] = 1
        box, ar = node._compute_crop_box(mask[0].numpy() * 255, 400, 240, 1, "auto")
        self.assertEqual(ar[0] / ar[1], 2.5)
        self.assertEqual(box, (50, 50, 300, 150))
        expanded, _ = node._compute_crop_box(
            mask[0].numpy() * 255, 400, 240, 1, "auto", min_margin=10)
        self.assertEqual(expanded, (40, 40, 310, 160))
        output, _, _ = node.crop_and_resize(image, mask=mask, kilopixels=100, divisible_by=32)
        self.assertEqual(tuple(output.shape[1:3]), (224, 448))
        _, manual = node._compute_crop_box(mask[0].numpy() * 255, 400, 240, 1, "16:9")
        self.assertAlmostEqual(manual[0] / manual[1], 16 / 9)

    def test_all_crop_modes_pad_only_when_subject_cannot_fit(self):
        node = module.XiaozhuguangATBC()
        image = torch.full((2, 64, 96, 3), 0.5)
        mask = torch.zeros(2, 64, 96)
        mask[0, :40, :45] = 1
        mask[1, 24:40, 8:88] = 1
        for mode in ("逐帧裁剪", "视频稳定跟踪", "人脸构图"):
            with self.subTest(mode=mode):
                result, info, _ = node.crop_and_resize(
                    image, mask=mask, crop_mode=mode, ratio="1:1", kilopixels=100,
                    Box_grow_factor=2, fill_color="#000000")
                first, second = info["crop_infos"]
                self.assertEqual(first["pad_info"], (0, 0, 0, 0))
                self.assertGreater(sum(second["pad_info"]), 0)
                torch.testing.assert_close(result[0], torch.full_like(result[0], 0.5), atol=1/255, rtol=0)
                for frame in (first, second):
                    l, t, _, _ = frame["pad_info"]
                    x0, y0, x1, y1 = frame["original_coords"]
                    x0, y0, x1, y1 = frame.get("subpixel_box", (x0-l, y0-t, x1-l, y1-t))
                    a, b, c, d = frame["subject_box"]
                    self.assertLessEqual(x0, a)
                    self.assertLessEqual(y0, b)
                    self.assertGreaterEqual(x1, c)
                    self.assertGreaterEqual(y1, d)

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
        self.assertEqual(tuple(output.shape[1:3]), (672, 1504))
        crop = info["crop_infos"][0]
        pl, pt, _, _ = crop["pad_info"]
        x0, y0, x1, y1 = crop["original_coords"]
        self.assertLessEqual(x0 - pl, 50)
        self.assertLessEqual(y0 - pt, 50)
        self.assertGreaterEqual(x1 - pl, 300)
        self.assertGreaterEqual(y1 - pt, 150)
        x0, y0, x1, y1 = crop.get("subpixel_box", (x0, y0, x1, y1))
        self.assertAlmostEqual((x1-x0)/(y1-y0), 1504/672)

    def test_stable_tracking_smoothing_preserves_coverage(self):
        node = module.XiaozhuguangATBC()
        masks = np.zeros((21, 160, 200), dtype=np.float32)
        for i, frame in enumerate(masks):
            x = 50 + i + (8 if i >= 10 else 0)
            frame[55:105, x:x+50] = 1
        masks[16, 53:107, 72:126] = 1

        def plan(scaling, position, scale):
            boxes = np.asarray(node._tracking_boxes(
                masks, 200, 160, 1, 0, "1:1", "稳定优先", scaling,
                face_position_smoothing=position, face_scale_smoothing=scale))
            for frame, (x0, y0, x1, y1) in zip(masks, boxes):
                ys, xs = np.where(frame)
                self.assertLessEqual(x0, xs.min() + 1e-9)
                self.assertLessEqual(y0, ys.min() + 1e-9)
                self.assertGreaterEqual(x1 + 1e-9, xs.max() + 1)
                self.assertGreaterEqual(y1 + 1e-9, ys.max() + 1)
            return (boxes[:, 0] + boxes[:, 2]) / 2, boxes[:, 3] - boxes[:, 1]

        raw_x, fixed = plan("固定大小", 0, 0)
        smooth_x, still_fixed = plan("固定大小", 3, 6)
        np.testing.assert_allclose(fixed, fixed[0])
        np.testing.assert_allclose(still_fixed, still_fixed[0])
        np.testing.assert_allclose(plan("固定大小", 3, 0)[1], still_fixed)
        self.assertLess(np.abs(np.diff(smooth_x)).max(), np.abs(np.diff(raw_x)).max())
        _, raw_h = plan("动态缩放", 0, 0)
        _, smooth_h = plan("动态缩放", 0, 3)
        self.assertGreater(smooth_h[15], raw_h[15])
        self.assertLess(np.abs(np.diff(smooth_h)).max(), np.abs(np.diff(raw_h)).max())

    def test_tight_fixed_crop_reserves_room_for_position_smoothing(self):
        node = module.XiaozhuguangATBC()
        image = torch.zeros(12, 96, 128, 3)
        mask = torch.zeros(12, 96, 128)
        mask[:6, 24:64, 32:72] = 1
        mask[6:, 24:64, 40:80] = 1

        def centers(strength):
            _, info, _ = node.crop_and_resize(
                image, mask=mask, crop_mode="视频稳定跟踪", ratio="1:1",
                tracking_scale="固定大小", tracking_preference="紧凑优先",
                face_position_smoothing=strength, margin_percent=0, kilopixels=100)
            boxes = []
            for frame in info["crop_infos"]:
                box = frame.get("subpixel_box", frame["original_coords"])
                self.assertEqual(frame["pad_info"], (0, 0, 0, 0))
                subject = frame["subject_box"]
                self.assertLessEqual(box[0], subject[0])
                self.assertGreaterEqual(box[2], subject[2])
                boxes.append(box)
            boxes = np.asarray(boxes)
            np.testing.assert_allclose(boxes[:, 2] - boxes[:, 0], boxes[0, 2] - boxes[0, 0])
            return (boxes[:, 0] + boxes[:, 2]) / 2

        self.assertLess(np.abs(np.diff(centers(3))).max(), np.abs(np.diff(centers(0))).max() / 2)

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
                        {"alignment_mode": "变形"}, {"ratio": "16:9"},
                        {"ratio": "3:2"}, {"ratio": "2:3"}):
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
                    sx0, sy0, sx1, sy1 = crop.get("subpixel_box", (x0-pl, y0-pt, x1-pl, y1-pt))
                    self.assertLessEqual(sx0, xs.min())
                    self.assertLessEqual(sy0, ys.min())
                    self.assertGreaterEqual(sx1, xs.max() + 1)
                    self.assertGreaterEqual(sy1, ys.max() + 1)
                    self.assertAlmostEqual((sx1-sx0)/(sy1-sy0), width/height)



if __name__ == "__main__":
    unittest.main()
