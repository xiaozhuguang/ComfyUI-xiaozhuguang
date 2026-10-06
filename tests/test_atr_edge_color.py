import runpy
import unittest
from pathlib import Path
import torch

ATR=runpy.run_path(str(Path(__file__).resolve().parents[1]/'nodes/xzg_atr.py'))['XiaozhuguangATR']

class EdgeColorTests(unittest.TestCase):
    def setUp(self):
        self.node=ATR()
        self.info=dict(original_coords=(16,16,112,112), padded_size=(128,128), original_image_size=(128,128), pad_info=(0,0,0,0))
        self.options=(8,1.0,16,0.8)

    def test_old_widget_order_and_default_are_preserved(self):
        inputs=self.node.INPUT_TYPES()['optional']
        self.assertEqual(list(inputs)[:2], ['mask','compute_device'])
        self.assertFalse(inputs['edge_color_match'][1]['default'])

    def test_corrects_edge_preserves_center_and_outside_mask(self):
        processed=torch.full((1,3,96,96),120.)
        original=torch.full_like(processed,100.)
        result=self.node._match_edge_color(processed,original,None,self.info,self.options,[None])
        self.assertLess(result[0,0,0,48].item(),105)
        self.assertEqual(result[0,0,48,48].item(),120)
        mask=torch.zeros((1,1,96,96));mask[:,:,16:80,16:80]=255
        result=self.node._match_edge_color(processed,original,mask,self.info,self.options,[None])
        self.assertEqual(result[0,0,0,48].item(),120)
        self.assertLess(result[0,0,16,48].item(),105)
        self.assertEqual(result[0,0,48,48].item(),120)

    def test_full_frame_and_black_samples_skip(self):
        info=dict(self.info,original_coords=(0,0,96,96),padded_size=(96,96),original_image_size=(96,96))
        proc=torch.full((1,3,96,96),120.)
        orig=torch.full_like(proc,100.)
        actual=self.node._match_edge_color(proc,orig,None,info,self.options,[None])
        self.assertTrue(torch.equal(actual,proc))
        actual=self.node._match_edge_color(proc,torch.zeros_like(orig),None,self.info,self.options,[None])
        self.assertTrue(torch.equal(actual,proc))

    def test_temporal_smoothing_across_chunks(self):
        proc=torch.full((2,3,96,96),120.)
        orig=torch.empty_like(proc);orig[0]=100;orig[1]=140
        whole=self.node._match_edge_color(proc,orig,None,self.info,self.options,[None])
        state=[None]
        split=torch.cat([self.node._match_edge_color(proc[i:i+1],orig[i:i+1],None,self.info,self.options,state) for i in range(2)])
        self.assertTrue(torch.equal(whole,split))
        self.assertLess(whole[1,0,0,48].item(),120)
        fresh=self.node._match_edge_color(proc[1:],orig[1:],None,self.info,self.options,[None])
        self.assertGreater(fresh[0,0,0,48].item(),135)

    def test_match_follows_eroded_feathered_seam(self):
        info=dict(original_coords=(64,64,448,448), padded_size=(512,512), original_image_size=(512,512), pad_info=(0,0,0,0))
        original=torch.full((1,512,512,3),100/255)
        backends=['CPU'] + (['GPU'] if torch.cuda.is_available() else [])
        for radius in (30,60):
            for masked in (False,True):
                inset=32 if masked else 0
                processed=torch.full((1,384,384,3),120/255)
                old_edge=inset+radius-10
                processed[:,:old_edge]=160/255
                processed[:,-old_edge:]=160/255
                processed[:,:,:old_edge]=160/255
                processed[:,:,-old_edge:]=160/255
                mask=None
                if masked:
                    mask=torch.zeros((1,384,384))
                    mask[:,inset:-inset,inset:-inset]=1
                for backend in backends:
                    with self.subTest(radius=radius,masked=masked,backend=backend):
                        plain=self.node.restore_image(original,processed,info,radius,mask,backend)[0]
                        matched=self.node.restore_image(original,processed,info,radius,mask,backend,
                            edge_color_match=True,color_band_width=8,color_match_strength=1,
                            color_correction_range=16,color_temporal_smooth=0)[0]
                        seam_x=64+inset+radius
                        self.assertGreater(plain[0,256,seam_x,0].item()*255,108)
                        self.assertLess(abs(matched[0,256,seam_x,0].item()*255-100),3)
                        self.assertEqual(matched[0,256,256,0].item(),plain[0,256,256,0].item())
                        # 50% 融合轮廓两侧都修正，避免在轮廓处产生新的跳变。
                        self.assertLess(abs(matched[0,256,seam_x-3,0].item()*255-100),3)

    def test_public_cpu_gpu_and_disabled(self):
        original=torch.full((10,128,128,3),100/255)
        processed=torch.full((10,96,96,3),120/255)
        default=self.node.restore_image(original,processed,self.info,3,compute_device='CPU')[0]
        disabled=self.node.restore_image(original,processed,self.info,3,compute_device='CPU',edge_color_match=False)[0]
        self.assertTrue(torch.equal(default,disabled))
        enabled=self.node.restore_image(original,processed,self.info,3,compute_device='CPU',edge_color_match=True,color_match_strength=1,color_correction_range=16)[0]
        self.assertEqual(enabled[0,64,64,0].item(),default[0,64,64,0].item())
        self.assertLess(enabled[0,20,64,0].item(),default[0,20,64,0].item())
        self.assertTrue(torch.equal(enabled[:, :16],default[:, :16]))
        again=self.node.restore_image(original,processed,self.info,3,compute_device='CPU',edge_color_match=True,color_match_strength=1,color_correction_range=16)[0]
        self.assertTrue(torch.equal(enabled,again))
        if torch.cuda.is_available():
            gpu=self.node.restore_image(original,processed,self.info,3,compute_device='GPU',edge_color_match=True,color_match_strength=1,color_correction_range=16)[0]
            self.assertLessEqual((gpu-enabled).abs().max().item(),2/255+1e-6)

if __name__=='__main__':
    unittest.main()
