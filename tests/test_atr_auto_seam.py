"""Geometry and integration checks for outward-only automatic ATR seams."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np
import torch


def node(name, cls):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / 'nodes' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, cls)()


class AutoSeamTests(unittest.TestCase):
    def test_outward_only_and_empty_mask(self):
        atr = node('xzg_atr', 'XiaozhuguangATR')
        info = dict(original_coords=(20,20,120,120), original_image_size=(160,160),
                    padded_size=(160,160), pad_info=(0,0,0,0), subject_box=(50,50,90,90))
        mask = np.zeros((100,100), np.uint8)
        mask[10:70,1:65] = 255
        for source in (None, mask):
            weights = atr._auto_seam_weights(info, source, 100, 100)
            self.assertTrue(np.isfinite(weights).all())
            self.assertTrue(((weights >= 0) & (weights <= 1)).all())
            self.assertTrue((weights[:,0] == 0).all())
            self.assertTrue(((weights > 0) & (weights < 1)).any())
        self.assertTrue((atr._auto_seam_weights(info, mask,100,100)[mask>0] == 1).all())
        self.assertFalse(atr._auto_seam_weights(info,np.zeros_like(mask),100,100).any())

    def test_atbc_metadata_and_round_trip(self):
        atr = node('xzg_atr', 'XiaozhuguangATR')
        atbc = node('xzg_atbc', 'XiaozhuguangATBC')
        image = torch.zeros((1,160,160,3))
        mask = torch.zeros((1,160,160))
        mask[:,50:90,50:90] = 1
        for mode in ('遮罩平滑','视频稳定跟踪'):
            processed, boxes, cropped_mask = atbc.crop_and_resize(image,mask=mask,kilopixels=100,crop_mode=mode)
            self.assertEqual(boxes['crop_infos'][0]['subject_box'], (50,50,90,90))
            for connected in (None,cropped_mask):
                output, preview = atr.restore_image(image,torch.ones_like(processed),boxes,99,
                    mask_expand=-99,mask=connected,auto_seam=True,seam_preview=True)
                self.assertEqual(output.shape,image.shape)
                self.assertEqual(preview.shape,image.shape)
                self.assertTrue((output[0,50:90,50:90] > .99).all())
                self.assertTrue((output[0,:10] == 0).all())


if __name__ == '__main__':
    unittest.main()
