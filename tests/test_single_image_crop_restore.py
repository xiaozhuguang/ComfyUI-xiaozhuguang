import ast
import json
import runpy
import unittest
from pathlib import Path

import torch

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
        for mode in ('lanczos', 'nearest-exact', 'bilinear', 'bicubic'):
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
                                result = self.restore.restore_image(self.image, actual[0], actual[1], blur, restore_mask)
                                original = self.atr.restore_image(self.image, expected[0], expected[1], blur, restore_mask, compute_device="CPU")
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
            actual = self.restore.restore_image(image_batch, processed_batch, box_batch, 3, masks)
            expected = self.restore.restore_image(self.image, cropped, box, 3, first_mask)
            self.assertTrue(torch.equal(actual[0], expected[0]))
            self.assertEqual(actual[0].shape[0], 1)

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
