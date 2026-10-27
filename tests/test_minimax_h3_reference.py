import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


class MiniMaxReferenceTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "nodes/xzg_minimax_h3_reference.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        klass = next(item for item in tree.body if isinstance(item, ast.ClassDef))
        self.execute = Mock(return_value=SimpleNamespace(result=("conditioning", "latent")))
        scope = {"nodes": SimpleNamespace(MAX_RESOLUTION=16384),
                 "MiniMaxH3ReferenceToVideo": SimpleNamespace(execute=self.execute)}
        exec(compile(ast.Module(body=[klass], type_ignores=[]), str(source), "exec"), scope)
        self.node = scope[klass.name]()

    def test_fixed_sockets_remain_available_without_references(self):
        before = self.node.INPUT_TYPES()
        result = self.node.encode("clip", "prompt", 1344, 768, 124)
        self.assertEqual(result, ("conditioning", "latent"))
        self.assertEqual(before, self.node.INPUT_TYPES())
        optional = before["optional"]
        self.assertEqual(len(optional), 20)  # two VAEs plus 18 fixed reference sockets
        self.assertEqual(optional["ref_image_8"], ("IMAGE",))
        self.assertEqual(optional["ref_video_2"], ("IMAGE",))
        self.assertEqual(optional["ref_video_audio_2"], ("AUDIO",))
        self.assertEqual(optional["ref_audio_2"], ("AUDIO",))
        for group, _, _, _ in self.node.REFERENCE_INPUTS:
            self.assertEqual(self.execute.call_args.kwargs[group], {})

    def test_sparse_references_keep_numeric_order_and_soundtrack_pairing(self):
        image0, image8, video2, soundtrack2, audio1 = (object() for _ in range(5))
        self.node.encode("clip", "<Picture 1> <Video 1>", 640, 480, 141,
                         ref_image_size="max", vae="video vae", audio_vae="audio vae",
                         ref_image_8=image8, ref_image_0=image0, ref_image_1=None,
                         ref_video_2=video2, ref_video_audio_2=soundtrack2, ref_audio_1=audio1)
        args = self.execute.call_args.kwargs
        self.assertEqual(list(args["ref_images"]), ["ref_image_0", "ref_image_8"])
        self.assertIs(args["ref_images"]["ref_image_8"], image8)
        self.assertEqual(args["ref_videos"], {"ref_video_2": video2})
        self.assertEqual(args["ref_video_audios"], {"ref_video_audio_2": soundtrack2})
        self.assertEqual(args["ref_audios"], {"ref_audio_1": audio1})
        self.assertEqual((args["width"], args["height"], args["length"]), (640, 480, 141))
        self.assertEqual((args["ref_image_size"], args["vae"], args["audio_vae"]),
                         ("max", "video vae", "audio vae"))


if __name__ == "__main__":
    unittest.main()
