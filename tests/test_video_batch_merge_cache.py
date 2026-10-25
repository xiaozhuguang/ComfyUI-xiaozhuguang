import ast
import unittest
from pathlib import Path
from unittest.mock import Mock


source = Path(__file__).resolve().parents[1] / "nodes/xzg_video_batch_loader.py"
tree = ast.parse(source.read_text(encoding="utf-8"))
merge_class = next(node for node in tree.body
                   if isinstance(node, ast.ClassDef) and node.name == "XiaozhuguangVideoBatchMerge")
namespace = {}
exec(compile(ast.Module(body=[merge_class], type_ignores=[]), str(source), "exec"), namespace)
Merge = namespace[merge_class.name]


class MergeCacheTests(unittest.TestCase):
    def cached_queue(self, node, cache, **inputs):
        # ComfyUI 把 IS_CHANGED 结果和常量输入一起用于输出缓存键。
        changed = node.IS_CHANGED(**inputs) if hasattr(node, "IS_CHANGED") else False
        key = (changed, tuple(inputs.items()))
        if key not in cache:
            cache[key] = node.merge_videos(**inputs)
        return cache[key]

    def test_new_batch_replaces_previous_short_merge(self):
        node = Merge()
        node._finalize = Mock(side_effect=[(182, None), (1091, None)])
        cache = {}
        inputs = {"执行合并": True, "末尾裁帧": 0, "unique_id": "6"}
        self.assertEqual(self.cached_queue(node, cache, **inputs), (182, None))
        self.assertEqual(self.cached_queue(node, cache, **inputs), (1091, None))
        self.assertEqual(node._finalize.call_count, 2)

    def test_identical_frames_are_buffered_again_for_new_run(self):
        node = Merge()
        node._buffer_segment = Mock(side_effect=[{"index": 1}, {"index": 1}])
        cache = {}
        image = object()
        inputs = {"图像": image, "帧率": 30, "unique_id": "6"}
        self.cached_queue(node, cache, **inputs)
        self.cached_queue(node, cache, **inputs)
        self.assertEqual(node._buffer_segment.call_count, 2)


if __name__ == "__main__":
    unittest.main()
