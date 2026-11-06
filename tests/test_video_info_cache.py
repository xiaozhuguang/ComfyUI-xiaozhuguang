"""Exercise the installed ComfyUI cache signatures without loading models."""
import ast
import asyncio
import copy
import importlib.util
import itertools
from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence
from pathlib import Path
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("video_info", ROOT / "nodes/xzg_video_info_reader.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Reader = module.XiaozhuguangVideoInfoReader
spec = importlib.util.spec_from_file_location("bypass_check", ROOT / "nodes/xzg_bypass_check.py")
bypass_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bypass_module)
BypassCheck = bypass_module.XiaozhuguangBypassCheck


class VideoInfoCacheTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = ROOT.parents[1] / "comfy_execution/caching.py"
        names = {"CacheKeySet", "Unhashable", "to_hashable", "CacheKeySetInputSignature"}
        tree = ast.parse(source.read_text(encoding="utf-8"))
        tree.body = [node for node in tree.body if getattr(node, "name", None) in names]
        cls.scope = dict(ABC=ABC, abstractmethod=abstractmethod, Mapping=Mapping,
                         Sequence=Sequence, itertools=itertools,
                         is_link=lambda value: isinstance(value, list) and len(value) == 2,
                         include_unique_id_in_input=lambda name: name == "Reader",
                         nodes=SimpleNamespace(NODE_CLASS_MAPPINGS={
                             "Reader": Reader, "Loader": object, "BypassCheck": BypassCheck,
                             "BoolNot": object, "ATBC": object, "Prompt": object}))
        exec(compile(tree, str(source), "exec"), cls.scope)

    def setUp(self):
        self.prompt = {
            "loader": {"class_type": "Loader", "inputs": {
                "视频": "same.mp4", "跳过帧数": 0, "帧数上限": 73, "xzg_video_index": "0"}},
            "reader": {"class_type": "Reader", "inputs": {"video_info": ["loader", 2]}},
        }

    def signature(self, prompt, file_version="unchanged", node_id="reader"):
        classes = self.scope["nodes"].NODE_CLASS_MAPPINGS

        class Changes:
            async def get(self, node_id):
                if node_id == "loader":
                    return file_version
                method = getattr(classes[prompt[node_id]["class_type"]], "IS_CHANGED", None)
                return method() if method else False

        graph = SimpleNamespace(has_node=lambda key: key in prompt,
                                get_node=lambda key: prompt[key])
        cache = self.scope["CacheKeySetInputSignature"](graph, [], Changes())
        return asyncio.run(cache.get_node_signature(graph, node_id))

    def test_unchanged_inputs_reuse_signature(self):
        self.assertEqual(self.signature(self.prompt), self.signature(copy.deepcopy(self.prompt)))

    def test_loading_parameters_and_queue_index_invalidate(self):
        original = self.signature(self.prompt)
        for key, value in (("跳过帧数", 10), ("帧数上限", 53),
                           ("xzg_video_index", "1"), ("视频", "other.mp4")):
            with self.subTest(key=key):
                changed = copy.deepcopy(self.prompt)
                changed["loader"]["inputs"][key] = value
                self.assertNotEqual(original, self.signature(changed))

    def test_file_change_invalidates(self):
        self.assertNotEqual(self.signature(self.prompt), self.signature(self.prompt, "modified"))

    def test_output_metadata_and_repeated_video_index(self):
        info = dict(loaded_fps=24, loaded_frame_count=73, loaded_width=640,
                    loaded_height=360, padded_frame_count=20, skip_frames=10,
                    filename="same.mp4", xzg_video_index="0")
        reader = Reader()
        self.assertEqual(reader.get_video_info(info), (24, 53, 640, 360, "same", 10, 0))
        prompt = {"reader": self.prompt["reader"], "loader": {
            "class_type": "XiaozhuguangVideoLoaderDaVinci",
            "inputs": {"视频": "same.mp4", "xzg_video_index": "1"}}}
        self.assertEqual(reader.get_video_info(info, "reader", prompt)[-1], 1)

    def test_bypass_atbc_prompt_chain(self):
        prompt = copy.deepcopy(self.prompt)
        prompt.update({
            "bypass": {"class_type": "BypassCheck", "inputs": {
                "输入": ["loader", 0], "bypass_status": True}},
            "not": {"class_type": "BoolNot", "inputs": {"boolean": ["bypass", 0]}},
            "atbc": {"class_type": "ATBC", "inputs": {
                "image": ["loader", 0], "enable_crop": ["not", 0], "kilopixels": 600}},
            "prompt": {"class_type": "Prompt", "inputs": {
                "video_frames": ["atbc", 0], "video_fps": ["reader", 0], "seed": 123}},
        })
        original = self.signature(prompt, node_id="prompt")
        self.assertEqual(original, self.signature(copy.deepcopy(prompt), node_id="prompt"))
        for node, key, value in (("bypass", "bypass_status", False),
                                  ("atbc", "kilopixels", 1000),
                                  ("loader", "跳过帧数", 10),
                                  ("loader", "帧数上限", 53)):
            with self.subTest(node=node, key=key):
                changed = copy.deepcopy(prompt)
                changed[node]["inputs"][key] = value
                self.assertNotEqual(original, self.signature(changed, node_id="prompt"))
        check = BypassCheck()
        self.assertEqual(check.check_lazy_status(), [])
        self.assertEqual(check.execute(bypass_status=True), (True,))
        self.assertEqual(check.execute(bypass_status=False), (False,))


if __name__ == "__main__":
    unittest.main()
