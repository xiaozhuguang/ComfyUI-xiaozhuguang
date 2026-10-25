import importlib.util
import sys
import types
import unittest
from pathlib import Path

import torch


def _stub(name, **attrs):
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[name] = mod
    return mod


def _load_module():
    # 单文件加载没有包上下文：把相对导入用到的依赖打成桩模块
    package = _stub("xzg_sched_pkg")
    loader = _stub(
        "xzg_sched_pkg.xzg_video_loader",
        AUDIO_SAMPLE_RATE=44100,
        VIDEO_EXTENSIONS={"mp4"},
        _resolve_video_widget=lambda raw: (raw, ""),
        extract_audio=lambda *a, **k: (None, 44100),
        ffmpeg_frame_generator=lambda **k: iter(()),
    )
    package.xzg_video_loader = loader
    _stub("folder_paths", get_input_directory=lambda: "", get_annotated_filepath=lambda p: p)

    spec = importlib.util.spec_from_file_location(
        "xzg_sched_pkg.xzg_video_scheduler",
        Path(__file__).resolve().parents[1] / "nodes/xzg_video_scheduler.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


module = _load_module()


class SchedulerSegmentTests(unittest.TestCase):
    def setUp(self):
        self.node = module.XiaozhuguangVideoScheduler()
        module._SCHEDULER_SNAPSHOT.clear()

    def tearDown(self):
        module._SCHEDULER_SNAPSHOT.clear()

    def test_table_fits_video(self):
        fits = module.XiaozhuguangVideoScheduler._table_fits_video
        # 段表从上游窗口起点开始：不算匹配（本节点没有「跳过帧数」概念）
        self.assertFalse(fits([(50, 183)], 233))
        # 段表覆盖远超真实片长：按别的视频算的旧值
        self.assertFalse(fits([(0, 124), (124, 183)], 50))
        # 场景段表连续覆盖输入的全部图像，不补帧。
        self.assertTrue(fits([(0, 124), (124, 200)], 200))
        # 整片一段
        self.assertTrue(fits([(0, 50)], 50))

    def test_mismatched_table_requires_scene_detection(self):
        with self.assertRaisesRegex(ValueError, "场景切点"):
            self.node._build_segments("50:183", 50)

    def test_scene_boundaries_are_kept_without_overlap(self):
        self.assertEqual(self.node._build_segments("0:37,37:108,108:200", 200),
                         [(0, 37, 0), (37, 108, 0), (108, 200, 0)])

    def test_empty_table_requires_scene_detection(self):
        with self.assertRaisesRegex(ValueError, "场景切点"):
            self.node._build_segments("", 200)

    def test_gaps_and_incomplete_tables_are_rejected(self):
        for table in ("0:37,40:200", "0:37,37:108"):
            with self.assertRaises(ValueError):
                self.node._build_segments(table, 200)

    def test_table_past_end_requires_scene_detection(self):
        with self.assertRaises(ValueError):
            self.node._build_segments("0:37,37:209", 200)

    def _schedule(self, index=0, mask=None, **kwargs):
        images = torch.arange(7, dtype=torch.float32).view(7, 1, 1, 1).expand(7, 2, 3, 3)
        return self.node.schedule(
            段表="0:2,2:5,5:7", 当前段=index, 帧率=10,
            图像=images, 遮罩=mask, **kwargs,
        )

    def test_masks_follow_scene_boundaries_and_image_counts(self):
        masks = torch.arange(7, dtype=torch.float32).view(7, 1, 1).expand(7, 2, 3) / 10
        outputs = [self._schedule(index, masks) for index in range(3)]
        torch.testing.assert_close(torch.cat([out[4] for out in outputs]), masks)
        for out, (start, end) in zip(outputs, [(0, 2), (2, 5), (5, 7)]):
            torch.testing.assert_close(out[4], masks[start:end])
            self.assertEqual(out[0].shape[0], out[4].shape[0])
            self.assertEqual(out[3], end - start)
            self.assertEqual(out[2], 10.0)

    def test_missing_and_empty_masks_return_matching_black_batch(self):
        for mask in (None, torch.empty(0, 2, 3)):
            out = self._schedule(1, mask)
            self.assertEqual(out[4].shape, out[0].shape[:3])
            self.assertEqual(torch.count_nonzero(out[4]).item(), 0)

    def test_single_mask_is_reused_for_later_scenes(self):
        mask = torch.tensor([[0.0, 0.2, 0.4], [0.6, 0.8, 1.0]])
        for batch in (mask, mask.unsqueeze(0)):
            out = self._schedule(2, batch)
            torch.testing.assert_close(out[4], mask.unsqueeze(0).expand(2, -1, -1))

    def test_short_masks_hold_last_frame_and_extra_masks_are_ignored(self):
        masks = torch.arange(9, dtype=torch.float32).view(9, 1, 1).expand(9, 2, 3) / 10
        out = self._schedule(1, masks[:3])
        torch.testing.assert_close(out[4], masks[2:3].expand(3, -1, -1))
        out = self._schedule(2, masks[:3])
        torch.testing.assert_close(out[4], masks[2:3].expand(2, -1, -1))
        out = self._schedule(2, masks)
        torch.testing.assert_close(out[4], masks[5:7])

    def test_mask_snapshot_stays_with_image_snapshot(self):
        masks = torch.arange(7, dtype=torch.float32).view(7, 1, 1).expand(7, 2, 3) / 10
        self._schedule(0, masks, unique_id="mask-test")
        out = self._schedule(1, torch.ones_like(masks), unique_id="mask-test")
        torch.testing.assert_close(out[4], masks[2:5])
        self._schedule(2, torch.ones_like(masks), unique_id="mask-test")
        self.assertNotIn("mask-test", module._SCHEDULER_SNAPSHOT)

    def test_invalid_mask_releases_snapshot(self):
        with self.assertRaisesRegex(ValueError, "批次遮罩"):
            self._schedule(0, torch.zeros(1, 1, 2, 3), unique_id="mask-test")
        self.assertNotIn("mask-test", module._SCHEDULER_SNAPSHOT)


if __name__ == "__main__":
    unittest.main()
