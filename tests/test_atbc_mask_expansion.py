import runpy
import unittest
from pathlib import Path

import cv2
import numpy as np
import torch


ATBC = runpy.run_path(str(Path(__file__).resolve().parents[1] / "nodes" / "xzg_atbc.py"))["XiaozhuguangATBC"]


class MaskExpansionTests(unittest.TestCase):
    def test_pixel_expansion_preserves_mask_with_padding(self):
        node = ATBC()
        mask = np.random.default_rng(3).integers(0, 256, (96, 128), dtype=np.uint8)
        image = np.zeros((96, 128, 3), dtype=np.uint8)
        for box in [(20, 15, 70, 65), (-10, -10, 60, 60), (60, 50, 140, 110)]:
            for radius in [0, 1, 10, 128, 129, 300]:
                with self.subTest(box=box, radius=radius):
                    _, actual, info = node._process_single_image(
                        image, mask, "lanczos", 20, 8, 128, 96, box, Box_grow_pixels=radius
                    )
                    left, top, right, bottom = info["pad_info"]
                    expected = np.pad(mask, ((top, bottom), (left, right)))
                    x0, y0, x1, y1 = info["original_coords"]
                    expected = cv2.resize(expected[y0:y1, x0:x1], (actual.shape[1], actual.shape[0]),
                                          interpolation=cv2.INTER_LANCZOS4)
                    np.testing.assert_array_equal(actual, expected)

    def test_pixel_expansion_only_enlarges_crop(self):
        node = ATBC()
        image = torch.zeros((2, 200, 200, 3))
        mask = torch.zeros((2, 200, 200))
        mask[:, 75:125, 75:125] = 1
        for summed in [False, True]:
            kwargs = dict(mask=mask, ratio="1:1", Box_grow_factor=2, Box_grow_pixels=10,
                          kilopixels=14.4, divisible_by=1, sum_mask=summed)
            expanded = node.crop_and_resize(image, "nearest-exact", **kwargs)
            self.assertEqual(expanded[1]["crop_infos"][0]["original_coords"], (40, 40, 160, 160))
            self.assertEqual(expanded[2].sum().item(), 2 * 50 ** 2)
            self.assertEqual(tuple(expanded[2].shape), (2, 120, 120))

    def test_auto_threshold_preserves_mask(self):
        node = ATBC()
        image = torch.zeros((1, 100, 100, 3))
        mask = torch.zeros((1, 100, 100))
        mask[:, 10:90, 10:90] = 1
        result = node.crop_and_resize(image, "nearest-exact", mask=mask,
                                      Box_grow_pixels=10, kilopixels=10, divisible_by=1)
        self.assertEqual(result[1]["crop_infos"][0]["original_coords"], (0, 0, 100, 100))
        self.assertTrue(torch.equal(result[2], mask))

    def test_smoothed_edge_mask_expands_outward_with_fill_like_sum_mode(self):
        node = ATBC()
        image = torch.zeros((2, 100, 100, 3))
        mask = torch.zeros((2, 100, 100))
        mask[:, 25:75, :50] = 1
        options = dict(mask=mask, ratio="1:1", Box_grow_factor=2,
                       kilopixels=10, divisible_by=1, fill_color="#FF0000")

        per_frame = node.crop_and_resize(image, "nearest-exact", mask_smooth=0.5,
                                         sum_mask=False, **options)
        summed = node.crop_and_resize(image, "nearest-exact", sum_mask=True, **options)

        info = per_frame[1]["crop_infos"][0]
        self.assertEqual(info["pad_info"], (25, 0, 0, 0))
        self.assertEqual(info["padded_size"], (125, 100))
        torch.testing.assert_close(per_frame[0], summed[0])
        torch.testing.assert_close(per_frame[2], summed[2])
        torch.testing.assert_close(per_frame[0][:, 0, 0], torch.tensor([[1., 0., 0.], [1., 0., 0.]]))


if __name__ == "__main__":
    unittest.main()
