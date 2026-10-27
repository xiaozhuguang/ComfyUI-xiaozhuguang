import ast
import math
from pathlib import Path
import unittest

import torch
import torch.nn.functional as F


def load_node(filename):
    path = Path(__file__).resolve().parents[1] / "nodes" / filename
    tree = ast.parse(path.read_text(encoding="utf-8"))
    klass = next(n for n in tree.body if isinstance(n, ast.ClassDef))
    scope = {"torch": torch, "math": math, "F": F}
    exec(compile(ast.Module(body=[klass], type_ignores=[]), str(path), "exec"), scope)
    return scope[klass.name]()


class FillPositionTests(unittest.TestCase):
    def setUp(self):
        self.node = load_node("xzg_duplicate_first_frame.py")
        self.image = torch.arange(10, dtype=torch.float32).reshape(10, 1, 1, 1).expand(-1, 1, 1, 3)
        self.mask = torch.arange(10, dtype=torch.float32).reshape(10, 1, 1)
        self.audio = {"sample_rate": 100, "waveform": torch.arange(100, dtype=torch.float32).reshape(1, 1, 100)}

    def test_front_default_and_back_keep_total_and_content(self):
        front = self.node.execute(image=self.image, mask=self.mask)
        back = self.node.execute(image=self.image, mask=self.mask, fill_position="后补帧")
        self.assertEqual(front[1:4], (17, 10, 7))
        self.assertEqual(back[1:4], (17, 10, 0))
        self.assertTrue(torch.equal(front[0][7:], self.image))
        self.assertTrue(torch.equal(back[0][:10], self.image))
        self.assertTrue(torch.equal(back[0][10:], self.image[-1:].expand(7, -1, -1, -1)))
        self.assertTrue(torch.equal(back[4][10:], self.mask[-1:].expand(7, -1, -1)))

    def test_rules_minimum_audio_and_extract_roundtrip(self):
        extract = load_node("xzg_frame_extract.py")
        for rule in ("4N+1", "17N+5"):
            for position in ("前补帧", "后补帧"):
                with self.subTest(rule=rule, position=position):
                    result = self.node.execute(image=self.image, mask=self.mask, audio=self.audio,
                                               fps=10, multi_fill=True, min_frames=73,
                                               frame_rule=rule, fill_position=position)
                    period, offset = (4, 1) if rule == "4N+1" else (17, 5)
                    self.assertGreaterEqual(result[1], 73)
                    self.assertEqual((result[1] - offset) % period, 0)
                    restored = extract.execute(image=result[0], mask=result[4], audio=result[5],
                                               fetch_count=result[2], front_fill=result[3], fps=10)
                    self.assertTrue(torch.equal(restored[0], self.image))
                    self.assertTrue(torch.equal(restored[1], self.mask))
                    self.assertTrue(torch.equal(restored[2]["waveform"], self.audio["waveform"]))

    def test_mask_only_back(self):
        result = self.node.execute(mask=self.mask, fill_position="后补帧")
        self.assertIsNone(result[0])
        self.assertEqual(result[1:4], (17, 10, 0))
        self.assertTrue(torch.equal(result[4][:10], self.mask))

    def test_no_fill_ignores_rules_and_minimum_and_preserves_audio(self):
        for rule in ("4N+1", "17N+5"):
            result = self.node.execute(image=self.image, mask=self.mask, audio=self.audio,
                                       fill_position="不补帧", frame_rule=rule,
                                       multi_fill=True, min_frames=73)
            self.assertEqual(result[1:4], (10, 10, 0))
            self.assertIs(result[0], self.image)
            self.assertIs(result[4], self.mask)
            self.assertIs(result[5], self.audio)
        result = self.node.execute(mask=self.mask, fill_position="不补帧")
        self.assertIsNone(result[0])
        self.assertEqual(result[1:4], (10, 10, 0))
        self.assertIs(result[4], self.mask)


if __name__ == "__main__":
    unittest.main()
