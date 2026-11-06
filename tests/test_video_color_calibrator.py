"""Numerical regressions for paired color calibration (no ComfyUI import needed)."""
import importlib.util
from pathlib import Path
import unittest
import torch

spec = importlib.util.spec_from_file_location('calibrator', Path(__file__).resolve().parents[1] / 'nodes/xzg_video_color_calibrator.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ColorCalibrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def setUp(self):
        self.node = m.XiaozhuguangVideoColorCalibrator()
        self.ref = torch.rand(1, 64, 64, 3, generator=torch.Generator().manual_seed(7)) * .6 + .2

    def run_node(self, ref, src, mode='linear', smooth=0, strength=1):
        return self.node.run(ref, src, mode, smooth, strength)[0]

    def test_zero_strength_exact_and_alpha(self):
        src = torch.cat((self.ref * .7, self.ref[..., :1]), -1)
        self.assertTrue(torch.equal(self.run_node(self.ref, src, strength=0), src))
        out = self.run_node(self.ref, src)
        self.assertTrue(torch.equal(out[..., 3:], src[..., 3:]))

    def test_identity_both_modes(self):
        for mode in ('linear', 'quantile'):
            out = self.run_node(self.ref, self.ref, mode)
            self.assertLess((out - self.ref).abs().max().item(), 1e-5)

    def test_brightness_and_contrast_independently(self):
        y = torch.linspace(.15, .85, 4096).reshape(1, 64, 64, 1)
        ref = y.expand(-1, -1, -1, 3)
        for shift, contrast in ((.12, 1), (0, .65), (-.1, 1.35)):
            src = (ref - .5) * contrast + .5 + shift
            for mode in ('linear', 'quantile'):
                out = self.run_node(ref, src, mode)
                self.assertLess(abs(m._luma(out).mean().item() - y.mean().item()), .006)
                self.assertLess(abs(m._luma(out).std().item() - y.std().item()), .012)
                for q in (.05, .5, .95):
                    self.assertLess(abs(torch.quantile(m._luma(out), q).item() - torch.quantile(y, q).item()), .025)

    def test_gamma_shadows_and_highlights(self):
        ref = torch.linspace(.12, .88, 4096).reshape(1, 64, 64, 1).expand(-1, -1, -1, 3)
        for gamma in (.65, 1.65):
            src = ref.pow(gamma)
            out = self.run_node(ref, src, 'quantile')
            self.assertLess((out-ref).abs().mean().item(), .015)
            self.assertLess((out-ref).abs().mean().item(), (src-ref).abs().mean().item() * .2)

    def test_content_change_excluded_from_estimation(self):
        src = (self.ref - .08) / 1.12
        src[:, 16:40, 16:40] = torch.tensor([.8, .15, .3])
        weights = m._stable_weights(self.ref.reshape(-1, 3), src.reshape(-1, 3)).reshape(64, 64)
        self.assertLess(weights[16:40, 16:40].mean().item(), .05)
        stable = torch.ones(64, 64, dtype=torch.bool)
        stable[16:40, 16:40] = False
        for mode in ('linear', 'quantile'):
            out = self.run_node(self.ref, src, mode)
            self.assertLess((out-self.ref)[0, stable].abs().mean().item(), .01)
            # A global correction must not replace the newly edited object.
            self.assertGreater((out-self.ref)[0, ~stable].abs().mean().item(), .1)

    def test_saturation_hue_and_tint(self):
        matrix = torch.tensor([[.8, -.2], [.2, .8]])
        src = m._apply(self.ref, torch.linspace(0,1,129), torch.linspace(0,1,129), matrix, torch.tensor([.02, -.02]))
        before = (src-self.ref).abs().mean().item()
        out = self.run_node(self.ref, src)
        self.assertLess((out-self.ref).abs().mean().item(), before * .3)

    def test_no_stable_content_passes_through(self):
        src = torch.rand(self.ref.shape, generator=torch.Generator().manual_seed(21)) * .8 + .1
        self.assertTrue(torch.equal(self.run_node(self.ref, src), src))

    def test_saturated_colors_are_valid(self):
        src = self.ref.clone(); src[..., 0] = 0
        weights = m._stable_weights(src.reshape(-1,3), src.reshape(-1,3))
        self.assertGreater(weights.mean().item(), .95)

    def test_cut_resets_smoothing(self):
        ref = torch.cat((self.ref*.4, .65+self.ref*.3))
        src = torch.cat((self.ref*.4+.04, .65+self.ref*.3-.08))
        out = self.run_node(ref, src, smooth=.95)
        independent = self.run_node(ref[1:], src[1:])
        self.assertTrue(torch.allclose(out[1:], independent, atol=1e-6))

    def test_deterministic_and_strength_blend(self):
        src = self.ref*.75
        full = self.run_node(self.ref, src, 'quantile')
        self.assertTrue(torch.equal(full, self.run_node(self.ref, src, 'quantile')))
        half = self.run_node(self.ref, src, 'quantile', strength=.5)
        self.assertTrue(torch.allclose(half, torch.lerp(src, full, .5), atol=1e-6))

    def test_grayscale_constant_and_resize(self):
        for channels in (1, 3):
            ref = torch.full((1, 32, 32, channels), .6)
            src = torch.full((1, 48, 48, channels), .4)
            for mode in ('linear','quantile'):
                out = self.run_node(ref, src, mode)
                self.assertEqual(out.shape, src.shape)
                self.assertLess(abs(out.mean().item()-.6), .01)
        black = torch.zeros_like(self.ref)
        self.assertTrue(torch.equal(self.run_node(black, black), black))

    def test_temporal_smoothing_reduces_parameter_jump(self):
        ref = self.ref.expand(2, -1, -1, -1).clone()
        src = torch.cat((self.ref - .02, self.ref - .08))
        raw = self.run_node(ref, src, smooth=0)
        smoothed = self.run_node(ref, src, smooth=.9)
        # The current correction should lag after an abrupt exposure change.
        self.assertGreater((smoothed[1] - raw[1]).abs().mean().item(), .02)
        self.assertTrue(torch.allclose(smoothed[0], raw[0], atol=1e-6))

    def test_six_frame_correspondence_loss_keeps_color_transform(self):
        ref = self.ref.expand(10, -1, -1, -1).clone()
        src = (ref - .08) / 1.12
        src[2:8] = torch.rand((6,64,64,3), generator=torch.Generator().manual_seed(21))*.6+.1
        out = self.run_node(ref, src, smooth=.6)
        # A temporary correspondence loss must not zero the established grading.
        correction = (out-src).mean((1,2))
        self.assertGreater(correction[2:8].min().item(), .08)
        self.assertLess((correction[8]-correction[1]).abs().max().item(), .005)
        independent = self.run_node(ref, src, smooth=0)
        self.assertTrue(torch.equal(independent[2:8], src[2:8]))

    def test_long_loss_fades_without_abrupt_reset(self):
        ref = self.ref.expand(18, -1, -1, -1).clone()
        src = (ref - .08) / 1.12
        src[2:] = torch.rand((16,64,64,3), generator=torch.Generator().manual_seed(21))*.6+.1
        out = self.run_node(ref, src, smooth=.6)
        correction = (out-src).mean((1,2))
        self.assertLess((correction[2:]-correction[1:-1]).abs().max().item(), .04)
        self.assertLess(correction[-1].abs().max().item(), .015)

    def test_edited_only_jump_does_not_reset_history(self):
        ref = self.ref.expand(4,-1,-1,-1).clone()
        src = ref*.65
        src[2] = torch.rand((64,64,3), generator=torch.Generator().manual_seed(29))*.1+.8
        out = self.run_node(ref, src, smooth=.6)
        self.assertGreater((out[2]-src[2]).abs().mean().item(), .015)

    def test_temporal_outlier_rejection_respects_fit_quality(self):
        grid = torch.linspace(0,1,129)
        neutral = (grid, torch.eye(2), torch.zeros(2))
        normal = (grid+.04, torch.eye(2), torch.zeros(2))
        bad = (grid+.16, torch.eye(2), torch.tensor([.08,-.08]))
        rejected = m._temporal_parameters([normal,bad,normal], [False]*3, .6, neutral, [.001,.1,.001])
        self.assertTrue(torch.allclose(rejected[1][0], normal[0]))
        # A well-supported actual grading change must not be labeled an outlier.
        supported = m._temporal_parameters([normal,bad,normal], [False]*3, .6, neutral, [.001]*3)
        self.assertGreater((supported[1][0]-normal[0]).mean().item(), .04)

    def test_no_gap_interpolation_across_scene_boundary(self):
        grid = torch.linspace(0,1,129)
        neutral = (grid,torch.eye(2),torch.zeros(2))
        warm = (grid+.1,torch.eye(2),torch.zeros(2))
        result = m._temporal_parameters([warm,None,None,neutral], [False,False,True,False], .6, neutral, [0,float('inf'),float('inf'),0])
        self.assertIsNone(result[2])
        self.assertTrue(torch.equal(result[3][0], grid))

    def test_chroma_fit_never_reflects_color_plane(self):
        grid = torch.linspace(0,1,129)
        src = self.ref*.3+.35
        target = m._apply(src, grid, grid, torch.tensor([[-1.,0.],[0.,1.]]), torch.zeros(2))
        matrix, offset = m._fit_chroma(target.reshape(-1,3), src.reshape(-1,3), torch.ones(4096))
        self.assertGreater(torch.linalg.det(matrix).item(), 0)
        predicted = m._apply(src, grid, grid, matrix, offset)
        self.assertLess((m._chroma(predicted).mean((0,1,2)) - m._chroma(target).mean((0,1,2))).abs().max().item(), 1e-5)

    def test_large_replaced_character_cannot_regrade_unchanged_background(self):
        ref = self.ref.clone()
        src = ref.clone()
        # Most of the frame is a newly generated person, while the remaining
        # background is already correctly exposed and must anchor the estimate.
        ref[:, :, :40] = ref[:, :, :40]*.4 + torch.tensor([.35,.18,.08])
        src[:, :, :40] = self.ref[:, :, :40]*.25 + torch.tensor([.1,.12,.2])
        out = self.run_node(ref, src)
        self.assertLess((out[:, :, 44:] - src[:, :, 44:]).abs().mean().item(), .015)

    def test_unobserved_highlights_do_not_follow_noisy_endpoint_slope(self):
        x = torch.linspace(.1,.35,4096).reshape(-1,1).expand(-1,3)
        target = x+.015
        # Very small noisy supported range should not collapse unseen highlights.
        grid = torch.linspace(0,1,129)
        curve = m._tone_curve(target,x,torch.ones(4096),grid)
        self.assertLess(abs(curve[96].item()-.765), .01)
        self.assertTrue(torch.all(torch.diff(curve)>0))

    def test_slight_spatial_shift_does_not_wash_out_contrast(self):
        base=torch.rand((1,64,64,1),generator=torch.Generator().manual_seed(16))*.16+.12
        ref=(base*torch.tensor([1.5,.8,.35])+torch.randn((1,64,64,3),generator=torch.Generator().manual_seed(19))*.01).clamp(0,1)
        src=torch.roll(ref,1,2)
        out=self.run_node(ref,src)
        self.assertGreater(m._luma(out).std().item()/m._luma(src).std().item(),.98)

    def test_shadow_only_samples_cannot_regrade_whole_frame_contrast(self):
        source=torch.linspace(.02,.9,4096)[:,None].expand(-1,3)
        ref=source.clone()
        weights=((source[:,0]>.06)&(source[:,0]<.16)).float()
        # A locally plausible curve is not justified outside the sampled shadows.
        ref[weights>0]=source[weights>0]*.65+.04
        grid=torch.linspace(0,1,129)
        curve=m._tone_curve(ref,source,weights,grid)
        safe=m._protect_tone_curve(ref,source,weights,grid,curve)
        self.assertTrue(torch.allclose(torch.diff(safe),torch.diff(grid),atol=1e-6))

    def test_supported_real_contrast_reduction_is_preserved(self):
        src=torch.linspace(.12,.88,4096).reshape(1,64,64,1).expand(-1,-1,-1,3)
        ref=(src-.5)*.65+.5
        out=self.run_node(ref,src)
        self.assertLess((out-ref).abs().mean().item(),.015)
        self.assertLess(m._luma(out).std().item()/m._luma(src).std().item(),.7)

    def test_invalid_input(self):
        with self.assertRaises(ValueError):
            self.run_node(self.ref.expand(2,-1,-1,-1), self.ref)
        bad = self.ref.clone(); bad[0,0,0,0] = float('nan')
        with self.assertRaises(ValueError):
            self.run_node(self.ref, bad)


if __name__ == '__main__':
    unittest.main()
