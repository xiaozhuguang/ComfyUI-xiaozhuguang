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

    def test_feather_uses_full_available_margin(self):
        atr = node('xzg_atr', 'XiaozhuguangATR')
        for margin in (30, 60):
            size = 40 + 2 * margin
            info = dict(original_coords=(10,10,10+size,10+size),
                        original_image_size=(size+20,size+20), pad_info=(0,0,0,0),
                        subject_box=(10+margin,10+margin,50+margin,50+margin))
            mask = np.zeros((size,size), np.uint8)
            mask[margin:margin+40,margin:margin+40] = 255
            for source in (None, mask):
                w = atr._auto_seam_weights(info,source,size,size)
                row = w[size//2]
                self.assertTrue((row[1:margin] > 0).all())
                self.assertTrue((row[1:margin] < 1).all())
                self.assertEqual(row[0],0)
                self.assertEqual(row[margin],1)
                self.assertAlmostEqual(float(row[margin//2]), .5, places=5)

    def test_requested_margin_reserves_outer_tenth(self):
        atr = node('xzg_atr', 'XiaozhuguangATR')
        for margin in (30,60):
            size = 40 + 2*margin
            info = dict(original_coords=(10,10,10+size,10+size),
                        original_image_size=(size+20,size+20),pad_info=(0,0,0,0),
                        subject_box=(10+margin,10+margin,50+margin,50+margin),min_margin=margin)
            mask = np.zeros((size,size),np.uint8)
            mask[margin:margin+40,margin:margin+40] = 255
            for source in (None,mask):
                row = atr._auto_seam_weights(info,source,size,size)[size//2]
                reserve = margin//10
                self.assertTrue((row[:reserve+1] == 0).all())
                self.assertGreater(row[reserve+1],0)
                self.assertEqual(row[margin],1)

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
