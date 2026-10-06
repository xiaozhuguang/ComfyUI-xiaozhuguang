import runpy
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
import torch

ATR = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'nodes/xzg_atr.py'))['XiaozhuguangATR']

@unittest.skipUnless(torch.cuda.is_available(), 'CUDA required')
class ATRGPUTests(unittest.TestCase):
    def test_ellipse_erosion_matches_opencv(self):
        rng = np.random.default_rng(11)
        for shape in ((1, 1), (12, 17), (100, 160)):
            for radius in (1, 3, 15, 60):
                mask = rng.integers(0, 256, shape, dtype=np.uint8)
                mask[shape[0]//4:, shape[1]//4:] = 255
                kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1,) * 2)
                expected = cv2.erode(mask, kernel)
                actual = ATR._gpu_erode(torch.tensor(mask, device='cuda', dtype=torch.float32)[None, None], radius)
                np.testing.assert_array_equal(actual.cpu().numpy()[0, 0], expected)

    def test_resize_matches_lanczos4(self):
        image = np.random.default_rng(7).integers(0, 256, (19, 31, 3), dtype=np.uint8)
        tensor = torch.tensor(image, device='cuda', dtype=torch.float32).movedim(-1, 0)[None]
        for size in ((43, 27), (12, 8), (1, 1)):
            expected = cv2.resize(image, size, interpolation=cv2.INTER_LANCZOS4)
            actual = ATR._gpu_resize(tensor, *size)[0].movedim(0, -1).cpu().numpy()
            self.assertLessEqual(np.abs(actual - expected).max(), 2)

    def test_restore_batches_padding_masks_and_frame_order(self):
        node = ATR()
        image = torch.rand((10, 64, 96, 4), generator=torch.Generator().manual_seed(8))
        processed = torch.rand((10, 32, 48, 4), generator=torch.Generator().manual_seed(12))
        boxes = [
            dict(original_coords=(16, 12, 64, 44), padded_size=(96, 64), original_image_size=(96, 64), pad_info=(0,0,0,0)),
            dict(original_coords=(0, 0, 96, 64), padded_size=(96, 64), original_image_size=(96, 64), pad_info=(0,0,0,0)),
            dict(original_coords=(0, 0, 48, 32), padded_size=(104, 72), original_image_size=(96, 64), pad_info=(8,8,0,0)),
        ]
        mask = torch.ones((1, 32, 48))
        mask[:, 8:15, 13:20] = 0
        for infos in ([boxes[0]] * 10, [boxes[i % 3] for i in range(10)]):
            crop = dict(batch_size=10, crop_infos=infos)
            for radius in (0, 3, 15, 60):
                for masks in (None, mask, mask[0], mask.unsqueeze(-1)):
                    # CPU reference broadcasts a 2D single mask.
                    cpu_mask = None if masks is None else mask[0]
                    expected = node.restore_image(image, processed, crop, radius, cpu_mask, 'CPU')[0]
                    actual = node.restore_image(image, processed, crop, radius, masks, 'GPU')[0]
                    self.assertEqual(actual.shape, (10, 64, 96, 3))
                    self.assertEqual(actual.device.type, 'cpu')
                    self.assertLessEqual((actual - expected).abs().max().item(), 3 / 255 + 1e-6)

class ATRFallbackTests(unittest.TestCase):
    def test_cuda_unavailable_and_out_of_memory_fall_back_to_cpu(self):
        node = ATR()
        image = torch.rand((1, 16, 24, 3))
        info = dict(original_coords=(0, 0, 24, 16), padded_size=(24, 16),
                    original_image_size=(24, 16), pad_info=(0, 0, 0, 0))
        expected = node.restore_image(image, image, info, 3, compute_device="CPU")[0]
        with patch.object(torch.cuda, "is_available", return_value=False):
            actual = node.restore_image(image, image, info, 3)[0]
            self.assertTrue(torch.equal(actual, expected))
        with patch.object(torch.cuda, "is_available", return_value=True), \
             patch.object(node, "_restore_gpu", side_effect=torch.cuda.OutOfMemoryError("test")), \
             self.assertLogs(level="WARNING"):
            actual = node.restore_image(image, image, info, 3)[0]
            self.assertTrue(torch.equal(actual, expected))

if __name__ == '__main__':
    unittest.main()
