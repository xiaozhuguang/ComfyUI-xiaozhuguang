import ast
import json
import runpy
import unittest
from pathlib import Path

import torch
import numpy as np
import cv2
from PIL import Image
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(filename, name):
    return runpy.run_path(str(ROOT / 'nodes' / filename))[name]()

class SingleImageCropRestoreTests(unittest.TestCase):
    def setUp(self):
        self.crop = load('xzg_image_crop.py', 'XiaozhuguangImageCrop')
        self.restore = load('xzg_image_restore.py', 'XiaozhuguangImageRestore')
        self.atbc = load('xzg_atbc.py', 'XiaozhuguangATBC')
        self.atr = load('xzg_atr.py', 'XiaozhuguangATR')
        self.image = torch.rand((1, 48, 64, 3), generator=torch.Generator().manual_seed(9))
        self.mask = torch.zeros((1, 48, 64))
        self.mask[:, 2:22, 3:28] = 1

    def test_single_image_matches_original_nodes(self):
        for mode in self.crop.INPUT_TYPES()['required']['resize_mode'][0]:
            for mask in (None, self.mask[0], self.mask, self.mask.unsqueeze(-1)):
                for ratio in ('auto', '1:1', '16:9'):
                    with self.subTest(mode=mode, mask_shape=None if mask is None else mask.shape, ratio=ratio):
                        kwargs = dict(mask=mask, ratio=ratio, Box_grow_factor=1.5,
                                      Box_grow_pixels=20, kilopixels=8, divisible_by=8, fill_color='#369')
                        actual = self.crop.crop_and_resize(self.image, mode, **kwargs)
                        expected = self.atbc.crop_and_resize(self.image, mode, **kwargs)
                        self.assertTrue(torch.equal(actual[0], expected[0]))
                        self.assertTrue(torch.equal(actual[2], expected[2]))
                        self.assertEqual(actual[1], expected[1]['crop_infos'][0])
                        for blur in (0, 3):
                            for restore_mask in (None, actual[2]):
                                result = self.restore.restore_image(self.image, actual[0], actual[1], blur, mask=restore_mask)
                                resize = cv2.resize
                                def antialiased_reference(array, size, interpolation):
                                    if size[0] < array.shape[1] or size[1] < array.shape[0]:
                                        return np.asarray(Image.fromarray(array).resize(size, Image.Resampling.LANCZOS))
                                    return resize(array, size, interpolation=interpolation)
                                # Compare blending with the same antialiased reference resampler.
                                with patch.object(cv2, 'resize', side_effect=antialiased_reference):
                                    original = self.atr.restore_image(self.image, expected[0], expected[1], blur, mask=restore_mask, compute_device="CPU")
                                self.assertTrue(torch.equal(result[0], original[0]))

    def test_batches_use_first_image_mask_and_crop_box(self):
        image_batch = torch.cat((self.image, torch.ones_like(self.image)))
        mask_batch = torch.cat((self.mask, torch.ones_like(self.mask)))
        kwargs = dict(kilopixels=8, ratio="1:1")
        for masks in (None, mask_batch, mask_batch.unsqueeze(-1)):
            first_mask = None if masks is None else masks[:1]
            actual = self.crop.crop_and_resize(image_batch, "lanczos", masks, **kwargs)
            expected = self.crop.crop_and_resize(self.image, "lanczos", first_mask, **kwargs)
            self.assertTrue(torch.equal(actual[0], expected[0]))
            self.assertEqual(actual[1], expected[1])
            self.assertTrue(torch.equal(actual[2], expected[2]))
            self.assertEqual(actual[0].shape[0], 1)
        cropped, box, mask = self.crop.crop_and_resize(self.image, "lanczos", self.mask, **kwargs)
        processed_batch = torch.cat((cropped, torch.ones_like(cropped)))
        restore_mask_batch = torch.cat((mask, torch.ones_like(mask)))
        box_batch = {"batch_size": 2, "crop_infos": [box, {}]}
        for masks in (None, restore_mask_batch, restore_mask_batch.unsqueeze(-1)):
            first_mask = None if masks is None else masks[:1]
            actual = self.restore.restore_image(image_batch, processed_batch, box_batch, 3, mask=masks)
            expected = self.restore.restore_image(self.image, cropped, box, 3, mask=first_mask)
            self.assertTrue(torch.equal(actual[0], expected[0]))
            self.assertEqual(actual[0].shape[0], 1)

    def test_seam_preview_tracks_mask_without_color_reach(self):
        image = torch.full((1, 128, 128, 3), 100 / 255)
        processed = torch.full((1, 96, 96, 3), 120 / 255)
        box = dict(original_coords=(16, 16, 112, 112), padded_size=(128, 128),
                   original_image_size=(128, 128), pad_info=(0, 0, 0, 0))
        for mask in (None, torch.ones((1, 96, 96))):
            base, preview = self.restore.restore_image(image, processed, box, 0, mask=mask)
            self.assertEqual(preview.shape, base.shape)
            self.assertTrue(torch.equal(preview[:, :16], base[:, :16]))
            self.assertTrue(torch.equal(preview[:, 64, 64], base[:, 64, 64]))
            self.assertEqual(preview[0, 16, 64, 2].item(), 1.0)
            matched, colored = self.restore.restore_image(
                image, processed, box, 3, mask=mask, edge_color_match=True,
                color_band_width=4, color_correction_range=16)
            self.assertTrue(torch.equal(colored[:, 24, 64], matched[:, 24, 64]))
            uncorrected, seam_only = self.restore.restore_image(image, processed, box, 3, mask=mask)
            self.assertTrue(torch.equal(
                (colored != matched).any(dim=-1), (seam_only != uncorrected).any(dim=-1)))
            self.assertEqual(colored[0, 16, 64, 2].item(), 1.0)
            self.assertTrue(torch.equal(colored[:, 64, 64], matched[:, 64, 64]))
        empty = torch.zeros((1, 96, 96))
        base, preview = self.restore.restore_image(image, processed, box, 3, mask=empty)
        self.assertTrue(torch.equal(base, preview))
        full_box = dict(box, original_coords=(0, 0, 128, 128))
        base, preview = self.restore.restore_image(image, image, full_box, 0)
        self.assertTrue(torch.equal(base, preview))
        padded_box = dict(original_coords=(0, 0, 96, 96), padded_size=(160, 160),
                          original_image_size=(128, 128), pad_info=(16, 16, 16, 16))
        base, preview = self.restore.restore_image(image, processed, padded_box, 3)
        self.assertEqual(preview.shape, image.shape)
        self.assertTrue(torch.equal(preview[:, 80:], base[:, 80:]))

    def test_zero_expansion_reference_stays_fixed(self):
        image = torch.full((1, 128, 128, 3), 0.4)
        processed = torch.full((1, 96, 96, 3), 0.6)
        box = dict(original_coords=(16, 16, 112, 112), padded_size=(128, 128),
                   original_image_size=(128, 128), pad_info=(0, 0, 0, 0))
        mask = torch.zeros((1, 96, 96))
        mask[:, 16:80, 16:80] = 1
        for input_mask in (None, mask):
            for blur in (0, 3):
                reference = None
                for expand in (-8, 0, 8):
                    base, preview = self.restore.restore_image(
                        image, processed, box, blur, mask_expand=expand, mask=input_mask)
                    blue = (preview[0] == torch.tensor([32 / 255, 128 / 255, 1.0])).all(dim=-1)
                    self.assertTrue(blue.any())
                    if reference is None:
                        reference = blue
                    else:
                        self.assertTrue(torch.equal(blue, reference))
                    if expand == -8:
                        # The current inner seam remains red, separate from the blue reference.
                        row = 24 if input_mask is None else 40
                        self.assertGreater(preview[0, row, 64, 0], base[0, row, 64, 0])
                    self.assertTrue(torch.equal(preview[:, :16], base[:, :16]))

    def test_atr_batch_seam_preview_matches_single_image(self):
        image = torch.full((2, 128, 128, 3), 100 / 255)
        processed = torch.full((2, 96, 96, 3), 120 / 255)
        boxes = [dict(original_coords=(16, 16, 112, 112), padded_size=(128, 128),
                      original_image_size=(128, 128), pad_info=(0, 0, 0, 0)),
                 dict(original_coords=(0, 0, 96, 96), padded_size=(160, 160),
                      original_image_size=(128, 128), pad_info=(16, 16, 16, 16))]
        masks = torch.zeros((2, 96, 96))
        masks[0, 16:80, 16:80] = 1
        masks[1, 24:72, 24:72] = 1
        for mask in (None, masks):
            for expand in (-8, 0, 8):
                for blur in (0, 3):
                    outputs = self.atr.restore_image(
                        image, processed, {"batch_size": 2, "crop_infos": boxes}, blur,
                        mask_expand=expand, mask=mask, compute_device="CPU", edge_color_match=True,
                        color_band_width=4, color_correction_range=16, color_temporal_smooth=0)
                    self.assertEqual(len(outputs), 2)
                    for i, box in enumerate(boxes):
                        expected = self.restore.restore_image(
                            image[i:i+1], processed[i:i+1], box, blur, mask_expand=expand,
                            mask=None if mask is None else mask[i:i+1], edge_color_match=True,
                            color_band_width=4, color_correction_range=16, color_temporal_smooth=0)
                        for actual, single in zip(outputs, expected):
                            self.assertTrue(torch.equal(actual[i:i+1], single))
                    if torch.cuda.is_available():
                        gpu = self.atr.restore_image(
                            image, processed, {"batch_size": 2, "crop_infos": boxes}, blur,
                            mask_expand=expand, mask=mask, compute_device="GPU")
                        self.assertEqual(gpu[1].shape, image.shape)
                        for i in range(2):
                            blue = torch.tensor([32 / 255, 128 / 255, 1.0])
                            self.assertTrue(torch.equal((gpu[1][i] == blue).all(-1),
                                                        (outputs[1][i] == blue).all(-1)))

    def test_strong_downscale_suppresses_aliasing(self):
        # High-frequency stripes should average to gray instead of forming false bands.
        stripe = ((np.arange(997) % 2) * 255).astype(np.uint8)
        source = np.tile(stripe[None, :, None], (113, 1, 3))
        reduced = self.restore._resize_for_restore(source, 63, 31)
        legacy = cv2.resize(source, (63, 31), interpolation=cv2.INTER_LANCZOS4)
        self.assertLess(reduced[2:-2, 2:-2].std(), legacy[2:-2, 2:-2].std() * 0.1)
        self.assertLess(abs(float(reduced.mean()) - 127.5), 2)
        image = torch.zeros((1, 31, 63, 3))
        box = dict(original_coords=(0, 0, 63, 31), padded_size=(63, 31),
                   original_image_size=(63, 31), pad_info=(0, 0, 0, 0))
        result, _ = self.restore.restore_image(image, torch.from_numpy(source.copy()).float()[None] / 255, box, 0)
        self.assertTrue(np.array_equal((result[0].numpy() * 255).round().astype(np.uint8), reduced))
        enlarged = self.restore._resize_for_restore(source, 1100, 150)
        self.assertTrue(np.array_equal(enlarged, cv2.resize(source, (1100, 150), interpolation=cv2.INTER_LANCZOS4)))

    def test_restore_resize_modes(self):
        modes = self.restore.INPUT_TYPES()['optional']['resize_mode'][0]
        self.assertEqual(modes, ['Pillow Lanczos', 'Pillow Lanczos (fast)', 'Pillow Bicubic', 'Pillow Bilinear'])
        source = np.random.default_rng(9).integers(0, 256, (120, 160, 3), dtype=np.uint8)
        image = torch.zeros((1, 12, 16, 3))
        processed = torch.from_numpy(source).float()[None] / 255
        box = dict(original_coords=(0, 0, 16, 12), padded_size=(16, 12),
                   original_image_size=(16, 12), pad_info=(0, 0, 0, 0))
        for mode, resample in zip(modes, [Image.Resampling.LANCZOS, Image.Resampling.LANCZOS,
                                         Image.Resampling.BICUBIC, Image.Resampling.BILINEAR]):
            with self.subTest(mode=mode):
                expected = np.asarray(Image.fromarray(source).resize(
                    (16, 12), resample=resample, reducing_gap=3.0 if mode.endswith('(fast)') else None))
                result, _ = self.restore.restore_image(image, processed, box, 0, resize_mode=mode)
                self.assertTrue(np.array_equal((result[0].numpy() * 255).round().astype(np.uint8), expected))

    def test_registration_and_locales(self):
        tree = ast.parse((ROOT / '__init__.py').read_text(encoding='utf-8'))
        mappings = {n.targets[0].id: ast.literal_eval(n.value) for n in tree.body
                    if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)
                    and n.targets[0].id == 'NODE_DISPLAY_NAME_MAPPINGS'}
        for node, title in [('XiaozhuguangImageCrop', '小珠光图像裁剪'),
                            ('XiaozhuguangImageRestore', '小珠光 图像回贴')]:
            self.assertEqual(mappings['NODE_DISPLAY_NAME_MAPPINGS'][node], title)
            for lang in ('zh', 'en'):
                data = json.loads((ROOT / 'locales' / lang / 'nodeDefs.json').read_text(encoding='utf-8'))
                self.assertIn(node, data)
        inputs = self.crop.INPUT_TYPES()['optional']
        self.assertNotIn('mask_smooth', inputs)
        self.assertNotIn('sum_mask', inputs)

if __name__ == '__main__':
    unittest.main()
