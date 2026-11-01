import ast
from pathlib import Path
import unittest

import torch

# Load the node without starting ComfyUI or importing its video decoder/server.
source = ast.parse((Path(__file__).resolve().parents[1] / "nodes/xzg_video_scheduler.py").read_text(encoding="utf-8"))
namespace = {"torch": torch, "AUDIO_SAMPLE_RATE": 30, "_SCHEDULER_SNAPSHOT": {}, "throw_exception_if_processing_interrupted": lambda: None}
exec(compile(ast.Module(body=[n for n in source.body if isinstance(n, ast.ClassDef)], type_ignores=[]), "scheduler", "exec"), namespace)
Scheduler = namespace["XiaozhuguangVideoScheduler"]
cache = namespace["_SCHEDULER_SNAPSHOT"]


class SchedulerTest(unittest.TestCase):
    def setUp(self):
        cache.clear()
        self.node = Scheduler()
        self.frames = torch.cat([torch.zeros(50, 8, 8, 3), torch.ones(94, 8, 8, 3)])
        self.mask = torch.arange(144).view(144, 1, 1).float()
        self.wave = torch.arange(144).view(1, 1, 144).float()

    def prepare(self, batch="test"):
        return self.node.schedule(段表="0:51,51:71", 当前段=1000000,
            图像=self.frames, 音频={"waveform": self.wave, "sample_rate": 30},
            帧率=30, 遮罩=self.mask, unique_id="158", 缓存批次=batch)

    def test_actual_input_replaces_stale_table_and_cached_slices_cover_every_frame(self):
        info = self.prepare()["ui"]
        self.assertEqual(info["scene_table"], ["0:50,50:144"])
        self.assertEqual(info["scene_frames"], [144])
        self.assertIs(cache["158:test"]["frames"], self.frames)
        first = self.node.schedule(当前段=0, unique_id="158", 缓存批次="test")
        second = self.node.schedule(当前段=1, unique_id="158", 缓存批次="test")
        torch.testing.assert_close(torch.cat([first[0], second[0]]), self.frames)
        torch.testing.assert_close(torch.cat([first[1]["waveform"], second[1]["waveform"]], dim=-1), self.wave)
        torch.testing.assert_close(torch.cat([first[4], second[4]]), self.mask)
        self.assertEqual([first[3], second[3]], [50, 94])
        self.assertFalse(cache)

    def test_same_frame_count_new_material_rebuilds_table(self):
        self.prepare()
        result = self.node.schedule(当前段=1000000, 图像=torch.zeros_like(self.frames),
            帧率=30, unique_id="158", 缓存批次="test")
        self.assertEqual(result["ui"]["scene_table"], ["0:144"])

    def test_missing_cache_fails_instead_of_using_another_batch(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError, "缓存已释放"):
            self.node.schedule(unique_id="158", 缓存批次="other")
        self.assertIn("158:test", cache)

    def test_invalid_segment_releases_cache(self):
        self.prepare()
        with self.assertRaises(ValueError):
            self.node.schedule(当前段=5, unique_id="158", 缓存批次="test")
        self.assertFalse(cache)

    def test_cut_across_analysis_chunks(self):
        frames = torch.cat([torch.zeros(32, 2, 2, 3), torch.ones(1, 2, 2, 3)])
        self.assertEqual(self.node._detect_segments(frames, .35), [(0, 32, 0), (32, 33, 0)])

    def test_moderate_cut_uses_scene_threshold_scale(self):
        # A 20% image change scores .51, rather than .20 on the old scale.
        frames = torch.cat([torch.full((12, 8, 8, 3), .3), torch.full((12, 8, 8, 3), .5)])
        self.assertEqual(self.node._detect_segments(frames, .35), [(0, 12, 0), (12, 24, 0)])
        self.assertEqual(self.node._detect_segments(frames, .6), [(0, 24, 0)])

    def test_gradual_brightness_change_does_not_create_cuts(self):
        frames = torch.linspace(.1, .9, 40).view(40, 1, 1, 1).expand(-1, 8, 8, 3)
        self.assertEqual(self.node._detect_segments(frames, .35), [(0, 40, 0)])

    def test_color_change_without_large_brightness_jump(self):
        frames = torch.full((24, 8, 8, 3), .2)
        frames[12:, :, :, 0] = .7
        self.assertEqual(self.node._detect_segments(frames, .35), [(0, 12, 0), (12, 24, 0)])

    def test_short_audio_pads_only_missing_samples(self):
        audio = self.node._slice_audio(self.wave[:, :, :100], 30, 50 / 30, 144 / 30)
        self.assertEqual(audio.shape[-1], 94)
        torch.testing.assert_close(audio[..., :50], self.wave[..., 50:100])
        self.assertEqual(int(torch.count_nonzero(audio[..., 50:])), 0)
        beyond = self.node._slice_audio(self.wave, 30, 200 / 30, 250 / 30)
        self.assertEqual(beyond.shape[-1], 50)
        self.assertEqual(int(torch.count_nonzero(beyond)), 0)

    def test_analysis_interruption_clears_existing_batch(self):
        self.prepare()
        def interrupted():
            raise RuntimeError("interrupted")
        namespace["throw_exception_if_processing_interrupted"] = interrupted
        try:
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                self.prepare()
            self.assertFalse(cache)
        finally:
            namespace["throw_exception_if_processing_interrupted"] = lambda: None


if __name__ == "__main__":
    unittest.main()
