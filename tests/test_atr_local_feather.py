import runpy
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
ATR = runpy.run_path(str(ROOT / 'nodes/xzg_atr.py'))['XiaozhuguangATR']


def full_frame_blend(restored, original, box, blur, expand):
    x1, y1, x2, y2 = box
    mask = np.zeros(restored.shape[:2], dtype=np.uint8)
    mask[y1:y2, x1:x2] = 255
    if expand:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (abs(expand) * 2 + 1,) * 2)
        mask = (cv2.dilate if expand > 0 else cv2.erode)(mask, kernel, iterations=1)
    if blur:
        mask = cv2.GaussianBlur(mask, (blur * 2 + 1,) * 2, 0)
    weights = np.stack([mask.astype(np.float32) / 255.0] * 3, axis=-1)
    return (restored.astype(np.float32) * weights + original.astype(np.float32) * (1 - weights)).astype(np.uint8)


class ATRLocalFeatherTests(unittest.TestCase):
    def test_matches_full_frame_at_edges_and_large_radii(self):
        original = np.random.default_rng(4).integers(0, 256, (120, 160, 3), dtype=np.uint8)
        boxes = [(50, 40, 90, 80), (0, 0, 40, 50), (110, 80, 160, 120),
                 (0, 0, 160, 120), (0, 30, 160, 70), (79, 59, 81, 61)]
        for box in boxes:
            x1, y1, x2, y2 = box
            restored = original.copy()
            restored[y1:y2, x1:x2] = 177
            for radius in (0, 1, 3, 15, 30, 100):
                for expand in (-radius, 0, radius):
                    with self.subTest(box=box, radius=radius, expand=expand):
                        expected = full_frame_blend(restored, original, box, radius, expand)
                        actual = ATR()._apply_bbox_edge_blur(restored.copy(), original, box, radius, expand)
                        np.testing.assert_array_equal(actual, expected)

    def test_decomposed_ellipse_matches_opencv(self):
        rng = np.random.default_rng(17)
        for shape in ((1, 1), (8, 13), (100, 160)):
            for mask in (rng.integers(0, 256, shape, dtype=np.uint8),
                         np.full(shape, 255, dtype=np.uint8),
                         rng.integers(0, 2, shape, dtype=np.uint8) * 255):
                for radius in (1, 3, 15, 60, 100):
                    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1,) * 2)
                    expected = cv2.erode(mask, kernel)
                    actual = ATR()._erode_mask(mask, radius)
                    np.testing.assert_array_equal(actual, expected)

    def test_blur_only_receives_local_region(self):
        original = np.zeros((1200, 1600, 3), dtype=np.uint8)
        restored = original.copy()
        restored[400:500, 600:700] = 255
        gaussian_blur = cv2.GaussianBlur
        with patch.object(cv2, 'GaussianBlur', wraps=gaussian_blur) as mock:
            ATR()._apply_bbox_edge_blur(restored, original, (600, 400, 700, 500), 30, -30)
        self.assertEqual(mock.call_args.args[0].shape, (222, 222))
        self.assertTrue(np.all(restored[:300] == 0))


if __name__ == '__main__':
    unittest.main()
