import importlib.util
from pathlib import Path
import unittest

import torch


spec = importlib.util.spec_from_file_location(
    "xzg_image_size", Path(__file__).resolve().parents[1] / "nodes/xzg_image_size.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ImageSizeTests(unittest.TestCase):
    def setUp(self):
        self.node = module.XiaozhuguangImageSize()

    def test_image_batch(self):
        result = self.node.execute(torch.zeros(2, 32, 64, 3))
        self.assertEqual(result, ([64, 64], [32, 32], [64, 64], [32, 32], ["64×32", "64×32"]))

    def test_cropped_masks_and_empty_mask(self):
        masks = torch.zeros(3, 20, 30)
        masks[0, 4:10, 8:20] = 0.01
        masks[1, 0, 0] = 1
        masks[1, 19, 29] = 1
        result = self.node.execute(masks)
        self.assertEqual(result, ([12, 30, 0], [6, 20, 0], [12, 30, 0], [6, 20, 0], ["12×6", "30×20", "0×0"]))

    def test_single_pixel_2d_mask(self):
        mask = torch.zeros(8, 9)
        mask[3, 5] = 1
        self.assertEqual(self.node.execute(mask), ([1], [1], [1], [1], ["1×1"]))

    def test_invalid_shape(self):
        with self.assertRaisesRegex(ValueError, "请输入 IMAGE"):
            self.node.execute(torch.zeros(8))

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA unavailable")
    def test_cuda_mask(self):
        mask = torch.zeros(1, 10, 12, device="cuda")
        mask[:, 2:8, 4:7] = 1
        self.assertEqual(self.node.execute(mask), ([3], [6], [6], [3], ["3×6"]))


if __name__ == "__main__":
    unittest.main()
