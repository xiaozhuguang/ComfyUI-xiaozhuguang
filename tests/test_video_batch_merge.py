import ast
from pathlib import Path
import runpy
import unittest

import torch

root = Path(__file__).resolve().parents[1]
memory = runpy.run_path(str(root / "nodes/xzg_video_batch_memory.py"))
source = ast.parse((root / "nodes/xzg_video_batch_loader.py").read_text(encoding="utf-8"))
namespace = {"torch": torch, **memory, "BIGMAX": 1000000}
exec(compile(ast.Module(body=[n for n in source.body if isinstance(n, ast.ClassDef)
                             and n.name == "XiaozhuguangVideoBatchMerge"], type_ignores=[]),
             "merge", "exec"), namespace)
Merge = namespace["XiaozhuguangVideoBatchMerge"]


class MergeTest(unittest.TestCase):
    def test_processed_fps_survives_finalization_without_upstream_inputs(self):
        memory["reset_segments"]()
        node = Merge()
        frames = torch.rand(8, 2, 2, 3)
        first = node.merge_videos(图像=frames[:3], 帧率=60, unique_id="133")
        node.merge_videos(图像=frames[3:], 帧率=60, unique_id="133")
        result = node.merge_videos(执行合并=True, unique_id="133")
        self.assertEqual(first["result"][2], 60)
        self.assertEqual(result[2], 60)
        torch.testing.assert_close(result[0], frames)
        self.assertEqual(memory["get_segments"]("133"), [])


if __name__ == "__main__":
    unittest.main()
