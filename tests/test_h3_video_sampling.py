import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


class Frames:
    ndim = 4

    def __init__(self, count):
        self.shape = (count, 2, 2, 3)

    def __getitem__(self, key):
        return key.start


class VideoSamplingTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "nodes/xzg_h3_prompt.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                        and n.name == "_xzg_collect_video_frames")
        scope = {"mm": SimpleNamespace(throw_exception_if_processing_interrupted=lambda: None),
                 "_xzg_image_tensor_to_data_uri": lambda frame: [str(frame)]}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), scope)
        self.sample = scope[function.name]

    def test_sample_bounds_timing_and_metadata_fps(self):
        text, images, count = self.sample(Frames(101), {"loaded_fps": 10}, 24, 3)
        self.assertEqual(count, 3)
        self.assertEqual([uris[0] for _, uris in images], ["0", "50", "100"])
        self.assertIn("time 5.000s", images[1][0])
        self.assertIn("duration 10.100s", text)
        self.assertIn("No audio", text)

    def test_short_clip_has_no_duplicate_samples(self):
        _, images, count = self.sample(Frames(2), fps=2, sample_count=8)
        self.assertEqual(count, 2)
        self.assertEqual([uris[0] for _, uris in images], ["0", "1"])

    def test_single_frame_and_empty_batch(self):
        self.assertEqual(self.sample(Frames(1))[2], 1)
        with self.assertRaises(ValueError):
            self.sample(Frames(0))


if __name__ == "__main__":
    unittest.main()
