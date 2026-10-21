import runpy
import unittest
from pathlib import Path

import cv2
import numpy as np
import torch


ATR = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'nodes/xzg_atr.py'))['XiaozhuguangATR']
ATBC = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'nodes/xzg_atbc.py'))['XiaozhuguangATBC']


class ATRResizeModeTests(unittest.TestCase):
    @unittest.skipUnless(torch.cuda.is_available(), 'CUDA required')
    def test_prepared_downscale_matches_existing_gpu_path(self):
        source = torch.rand((3, 113, 157, 3), generator=torch.Generator().manual_seed(21))
        for channels in (1, 3):
            for mode in ATR.INPUT_TYPES()['optional']['resize_mode'][0]:
                with self.subTest(mode=mode, channels=channels):
                    image = source[..., :channels]
                    old_input = (image.cuda().movedim(-1, 1) * 255).clamp_(0, 255).floor_()
                    expected = ATR._gpu_resize(old_input, 31, 27, mode)
                    actual = ATR._prepare_gpu_input(image, 31, 27, mode, 'cuda')
                    self.assertTrue(torch.equal(actual, expected))
                    self.assertTrue(torch.equal(ATR._gpu_resize(actual, 31, 27, mode), expected))

    def test_atbc_modes_match_atr_for_images_and_masks(self):
        rng = np.random.default_rng(8)
        node = ATBC()
        image = rng.integers(0, 256, (128, 160, 3), dtype=np.uint8)
        mask = rng.integers(0, 256, (128, 160), dtype=np.uint8)
        for mode in ATR.INPUT_TYPES()['optional']['resize_mode'][0]:
            for pixels in (2, 40):
                with self.subTest(mode=mode, pixels=pixels):
                    result, result_mask, box = node._process_single_image(
                        image, mask, mode, pixels, 1, 160, 128, (0, 0, 160, 128))
                    height, width = result.shape[:2]
                    np.testing.assert_array_equal(result, ATR._resize_numpy(image, width, height, mode))
                    np.testing.assert_array_equal(result_mask, ATR._resize_numpy(mask, width, height, mode))
                    self.assertEqual(box['original_coords'], (0, 0, 160, 128))
        self.assertEqual(ATBC.INPUT_TYPES()['required']['resize_mode'][1]['default'], 'Pillow Lanczos')

    def test_antialiased_modes_suppress_false_bands(self):
        stripes = np.tile(((np.arange(997) % 2) * 255).astype(np.uint8)[None, :, None], (113, 1, 3))
        legacy = ATR._resize_numpy(stripes, 63, 31, 'Lanczos4 (legacy)')
        for mode in ATR.INPUT_TYPES()['optional']['resize_mode'][0]:
            with self.subTest(mode=mode):
                result = ATR._resize_numpy(stripes, 63, 31, mode)
                self.assertLess(result[2:-2, 2:-2].std(), legacy[2:-2, 2:-2].std() * 0.1)

    def test_tensor_dispatch_matches_numpy_for_image_and_mask(self):
        rng = np.random.default_rng(5)
        for channels in (1, 3):
            image = rng.integers(0, 256, (113, 157, channels), dtype=np.uint8)
            tensor = torch.from_numpy(image).movedim(-1, 0)[None].float().repeat(2, 1, 1, 1)
            for mode in ATR.INPUT_TYPES()['optional']['resize_mode'][0]:
                with self.subTest(mode=mode, channels=channels):
                    expected = ATR._resize_numpy(image[..., 0] if channels == 1 else image, 31, 27, mode)
                    if channels == 1:
                        expected = expected[..., None]
                    result = ATR._gpu_resize(tensor, 31, 27, mode).movedim(1, -1).numpy()
                    np.testing.assert_array_equal(result[0], expected)
                    np.testing.assert_array_equal(result[1], expected)

    def test_modes_reach_restore_image_and_preserve_upscaling(self):
        rng = np.random.default_rng(6)
        source = rng.integers(0, 256, (127, 157, 3), dtype=np.uint8)
        node = ATR()
        box = dict(original_coords=(0, 0, 31, 27), padded_size=(31, 27),
                   original_image_size=(31, 27), pad_info=(0, 0, 0, 0))
        for mode in ATR.INPUT_TYPES()['optional']['resize_mode'][0]:
            with self.subTest(mode=mode):
                result, preview = node.restore_image(
                    torch.zeros((1, 27, 31, 3)), torch.from_numpy(source).float()[None] / 255,
                    box, 0, compute_device='CPU', resize_mode=mode)
                expected = ATR._resize_numpy(source, 31, 27, mode)
                np.testing.assert_array_equal((result[0].numpy() * 255).round().astype(np.uint8), expected)
                self.assertTrue(torch.equal(result, preview))
                enlarged = ATR._resize_numpy(source, 200, 180, mode)
                np.testing.assert_array_equal(enlarged, cv2.resize(source, (200, 180), interpolation=cv2.INTER_LANCZOS4))


if __name__ == '__main__':
    unittest.main()
