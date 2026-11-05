import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

import torch


class H3VideoSamplingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = Path(__file__).resolve().parents[1] / 'nodes' / 'xzg_h3_prompt.py'
        tree = ast.parse(source.read_text(encoding='utf-8-sig'))
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                        and n.name == '_xzg_collect_video_frames')
        scope = {'torch': torch,
                 'mm': SimpleNamespace(throw_exception_if_processing_interrupted=lambda: None),
                 '_xzg_image_tensor_to_data_uri': lambda frames: ['encoded']}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), scope)
        cls.collect = staticmethod(scope['_xzg_collect_video_frames'])

    def test_short_static_clip_uses_five(self):
        description, images, count = self.collect(torch.zeros(56, 32, 32, 3), 24)
        self.assertEqual(count, 5)
        self.assertIn('frame 0,', images[0][0])
        self.assertIn('frame 55,', images[-1][0])
        self.assertIn('Unsampled actions', description)

    def test_long_static_clip_uses_nine(self):
        self.assertEqual(self.collect(torch.zeros(96, 32, 32, 3), 24)[2], 9)

    def test_short_clip_with_brief_change_uses_nine(self):
        frames = torch.zeros(56, 32, 32, 3)
        frames[27:29] = 1
        _, images, count = self.collect(frames, 24)
        self.assertEqual(count, 9)
        self.assertEqual(len(images), 9)

    def test_tiny_batch_has_no_duplicates(self):
        self.assertEqual(self.collect(torch.zeros(2, 32, 32, 3), 24)[2], 2)

    def test_padding_excluded_but_full_timeline_retained(self):
        # Padding makes the full clip longer than 3s; original content is only 2s.
        frames = torch.zeros(120, 32, 32, 3)
        frames[:5] = 1
        frames[53:] = 1
        description, images, count = self.collect(frames, 24, 5, 67)
        self.assertEqual(count, 5)
        self.assertIn('frame 5, time 0.208s', images[0][0])
        self.assertIn('frame 52, time 2.167s', images[-1][0])
        self.assertIn('duration 5.000s', description)
        self.assertIn('Original content: 48 frames, duration 2.000s', description)
        self.assertIn('Leading padding: 5 frames', description)
        self.assertIn('Trailing padding: 67 frames', description)

    def test_motion_inside_padded_clip_still_uses_nine(self):
        frames = torch.zeros(100, 32, 32, 3)
        frames[25:27] = 1
        _, images, count = self.collect(frames, 24, 5, 47)
        self.assertEqual(count, 9)
        self.assertIn('frame 5,', images[0][0])
        self.assertIn('frame 52,', images[-1][0])

    def test_single_original_frame(self):
        _, images, count = self.collect(torch.zeros(10, 32, 32, 3), 24, 4, 5)
        self.assertEqual(count, 1)
        self.assertIn('frame 4,', images[0][0])

    def test_invalid_padding(self):
        for front, back in [(-1, 0), (0, -1), (5, 5), (11, 0)]:
            with self.subTest(front=front, back=back), self.assertRaises(ValueError):
                self.collect(torch.zeros(10, 32, 32, 3), 24, front, back)

    def test_duration_boundaries(self):
        for frames, expected in [(24, 3), (25, 5), (72, 5), (73, 9),
                                 (144, 9), (145, 13), (288, 13), (289, 17)]:
            with self.subTest(frames=frames):
                self.assertEqual(self.collect(torch.zeros(frames, 8, 8, 3), 24)[2], expected)

    def test_brief_event_between_uniform_anchors_is_selected(self):
        frames = torch.zeros(72, 8, 8, 3)
        frames[11] = 1
        _, images, count = self.collect(frames, 24)
        indices = [int(label.split('frame ')[1].split(',')[0]) for label, _ in images]
        self.assertIn(11, indices)
        self.assertTrue({0, 18, 36, 53, 71}.issubset(indices))
        self.assertEqual(indices, sorted(set(indices)))
        self.assertEqual(count, 9)

    def test_long_motion_clip_reserves_keyframe_slots_at_cap(self):
        frames = torch.zeros(400, 8, 8, 3)
        frames[9] = 1  # On the probe grid, between uniform anchors.
        _, images, count = self.collect(frames, 24)
        indices = [int(label.split('frame ')[1].split(',')[0]) for label, _ in images]
        self.assertEqual(count, 17)
        self.assertIn(9, indices)
        self.assertEqual(indices[0], 0)
        self.assertEqual(indices[-1], 399)

    def test_invalid_inputs(self):
        for frames, fps in [(torch.zeros(0, 32, 32, 3), 24),
                            (torch.zeros(3, 32, 32, 3), 0)]:
            with self.assertRaises(ValueError):
                self.collect(frames, fps)


if __name__ == '__main__':
    unittest.main()
