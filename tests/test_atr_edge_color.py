"""ATR seam grading regression tests in the 0..255 NCHW processing domain."""
import importlib.util
from pathlib import Path
import unittest
import torch
import numpy as np

spec=importlib.util.spec_from_file_location('atr',Path(__file__).resolve().parents[1]/'nodes/xzg_atr.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ATRColorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def setUp(self):
        self.atr=m.XiaozhuguangATR()
        yy,xx=torch.meshgrid(torch.arange(96),torch.arange(96),indexing='ij')
        self.src=(60+xx*.7+yy*.4).float()[None,None].expand(1,3,-1,-1).clone()
        edge=torch.minimum(torch.minimum(xx,95-xx),torch.minimum(yy,95-yy)).float()
        self.mask=((edge-5)/15).clamp(0,1)[None,None]*255
        self.info=dict(original_coords=(16,16,112,112),pad_info=(0,0,0,0),original_image_size=(128,128))
        self.options=(10,1.,20,.8)

    def match(self,src,ref,state=None,mask=None,options=None):
        return self.atr._match_edge_color(src,ref,self.mask if mask is None else mask,self.info,self.options if options is None else options,[None] if state is None else state)

    def test_six_bad_frames_hold_and_long_loss_fades(self):
        n=20;src=self.src.expand(n,-1,-1,-1).clone();ref=src+12
        ref[2:]=torch.rand((n-2,3,96,96),generator=torch.Generator().manual_seed(13))*240+5
        out=self.match(src,ref,mask=self.mask.expand(n,-1,-1,-1))
        delta=(out-src)[:,:,15,48].mean(1)
        self.assertGreater(delta[1].item(),8)
        self.assertTrue(torch.allclose(delta[2:8],delta[1].expand(6),atol=1))
        self.assertLess((delta[2:]-delta[1:-1]).abs().max().item(),4)
        self.assertLess(delta[-1].abs().item(),2)

    def test_disabled_smoothing_is_independent(self):
        state=[None];self.match(self.src,self.src+12,state)
        bad=torch.rand(self.src.shape,generator=torch.Generator().manual_seed(13))*240+5
        out=self.match(self.src,bad,state,options=(10,1,20,0))
        self.assertTrue(torch.equal(out,self.src.round()))

    def test_interior_and_exterior_untouched(self):
        out=self.match(self.src,self.src+12)
        self.assertTrue(torch.equal(out[:,:,30:65,30:65],self.src[:,:,30:65,30:65].round()))
        self.assertTrue(torch.equal(out[:,:,:5],self.src[:,:,:5].round()))
        self.assertGreater((out-self.src)[:,:,15,48].mean().item(),8)

    def test_chunk_sizes_and_numpy_path_agree(self):
        src=self.src.expand(5,-1,-1,-1).clone();ref=src+12
        ref[2]=torch.rand((3,96,96),generator=torch.Generator().manual_seed(13))*240+5
        batch=self.match(src,ref,mask=self.mask.expand(5,-1,-1,-1))
        state=[None];sequential=[]
        for i in range(5):sequential.append(self.match(src[i:i+1],ref[i:i+1],state))
        self.assertTrue(torch.equal(batch,torch.cat(sequential)))
        state=[None];cpu=[]
        for i in range(5):
            cpu.append(self.atr._match_edge_color_numpy(src[i].movedim(0,-1).numpy(),ref[i].movedim(0,-1).numpy(),self.mask[0,0].numpy(),self.info,self.options,state))
        self.assertTrue(np.array_equal(batch.movedim(1,-1).numpy().astype(np.uint8),np.stack(cpu)))

    def test_lighting_change_does_not_reset_history(self):
        state=[None];self.match(self.src,self.src+12,state)
        source=self.src+60
        self.assertFalse(self.atr._seam_scene_cut(torch.nn.functional.adaptive_avg_pool2d(source,(12,12))[0],torch.nn.functional.adaptive_avg_pool2d(source+12,(12,12))[0],state[0]))

    def test_true_structural_cut_resets_history(self):
        state=[None];self.match(self.src,self.src+12,state)
        source=torch.nn.functional.interpolate(torch.rand((1,3,12,12),generator=torch.Generator().manual_seed(9))*240,size=(96,96),mode='nearest')
        out=self.match(source,source,state)
        self.assertTrue(torch.equal(out,source.round()))

    def test_background_prior_resists_large_content_replacement(self):
        y=torch.linspace(30,210,4096);target=y+4;chroma=torch.zeros(4096,2)
        target[:2600]=220-y[:2600];chroma[:2600]=torch.tensor([40.,-30.])
        result=self.atr._estimate_seam_color(y,target,chroma,torch.ones_like(y))
        self.assertIsNotNone(result)
        predicted=y*result[0]+result[1]
        self.assertLess((predicted[2600:]-target[2600:]).abs().mean().item(),6)
        self.assertLess(result[2:].abs().max().item(),3)

    def test_public_restore_only_changes_automatic_seam(self):
        original=torch.full((2,128,128,3),.65)
        processed=torch.full((2,96,96,3),.6)
        info=dict(self.info,padded_size=(128,128),subject_box=(40,40,88,88))
        off=self.atr.restore_image(original,processed,info,compute_device='CPU',edge_color_match=False)[0]
        on=self.atr.restore_image(original,processed,info,compute_device='CPU',edge_color_match=True,color_match_strength=1.)[0]
        self.assertTrue(torch.equal(on[:,50:78,50:78],off[:,50:78,50:78]))
        self.assertTrue(torch.equal(on[:,:16],off[:,:16]))
        self.assertGreater((on-off).abs().max().item(),1/255)

    def test_global_exposure_and_contrast_still_fit(self):
        y=torch.linspace(30,180,4096)
        result=self.atr._estimate_seam_color(y,y*1.15+8,torch.zeros(4096,2),torch.ones_like(y))
        self.assertIsNotNone(result)
        self.assertLess((y*result[0]+result[1]-(y*1.15+8)).abs().mean().item(),1)

if __name__=='__main__':unittest.main()
