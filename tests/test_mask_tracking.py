import runpy
import unittest
from pathlib import Path

import cv2
import numpy as np


track_outline = runpy.run_path(
    str(Path(__file__).resolve().parents[1] / "_xzg_watermark/mask_tracking.py")
)["track_outline"]


class Frames(np.ndarray):
    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return np.asarray(self)


class MaskTrackingTest(unittest.TestCase):
    def setUp(self):
        self.reference = np.full((180, 320), 38, np.uint8)
        self.blank = np.full_like(self.reference, 80)
        self.target = np.full_like(self.reference, 118)
        patch = np.random.default_rng(123).integers(30, 190, (26, 32), dtype=np.uint8)
        self.reference[75:101, 70:102] = patch
        self.target[59:85, 141:173] = patch + 50
        self.outline = np.array([[70, 75], [102, 75], [102, 101], [70, 101]])

    def track(self, images):
        size = np.array(self.reference.shape[::-1])
        rgb = np.repeat(np.stack(images)[..., None], 3, axis=-1)
        frames = (rgb.astype(np.float32) / 255).view(Frames)
        return track_outline(frames, list(range(len(images))), 0, len(images) - 1,
                             (self.outline / size).tolist())

    def test_patch_recovers_after_gap_and_brightness_change(self):
        result = self.track([self.reference, self.blank, self.target])
        self.assertEqual(result["reliable"], [False, True])
        matrix = np.asarray(result["transforms"][-1])
        np.testing.assert_allclose(matrix[:2, 2] * [320, 180], [71, -16])

    def test_repeated_patch_does_not_pick_an_arbitrary_copy(self):
        ambiguous = self.target.copy()
        ambiguous[59:85, 34:66] = self.target[59:85, 141:173]
        self.assertEqual(self.track([self.reference, ambiguous])["reliable"], [False])

    def test_perspective_still_moves_all_four_corners(self):
        reference = cv2.GaussianBlur(
            np.random.default_rng(21).integers(0, 256, self.reference.shape, dtype=np.uint8),
            (5, 5), 0)
        self.outline = np.float32([[54, 30], [265, 30], [265, 150], [54, 150]])
        expected = np.float32([[57, 27], [263, 36], [253, 148], [62, 145]])
        warp = cv2.getPerspectiveTransform(self.outline, expected)
        result = self.track([reference, cv2.warpPerspective(reference, warp, (320, 180))])
        self.assertEqual(result["reliable"], [True])
        size = np.array([320, 180])
        projected = cv2.perspectiveTransform(
            np.float32([self.outline / size]), np.asarray(result["transforms"][0]))[0] * size
        self.assertLess(np.linalg.norm(projected - expected, axis=1).max(), 1)


if __name__ == "__main__":
    unittest.main()
