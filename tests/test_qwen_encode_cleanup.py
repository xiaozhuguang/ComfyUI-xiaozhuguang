import ast
import math
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

import numpy as np


class Tensor:
    def __init__(self, array):
        self.array = array

    @property
    def shape(self):
        return self.array.shape

    def __getitem__(self, key):
        return Tensor(self.array[key])

    def movedim(self, source, target):
        return Tensor(np.moveaxis(self.array, source, target))


class CleanupTests(unittest.TestCase):
    def setup_node(self):
        source = Path(__file__).resolve().parents[1] / 'nodes/xzg_qwen_image21_encode.py'
        tree = ast.parse(source.read_text(encoding='utf-8'))
        klass = next(n for n in tree.body if isinstance(n, ast.ClassDef))
        management = SimpleNamespace(unload_model_and_clones=Mock(), soft_empty_cache=Mock(),
                                     intermediate_device=lambda: 'cpu')
        scope = dict(math=math, comfy=SimpleNamespace(model_management=management),
                     torch=SimpleNamespace(zeros=lambda shape, **kwargs: tuple(shape)),
                     node_helpers=SimpleNamespace(conditioning_set_values=lambda value, refs, **kwargs: (value, refs)))
        exec(compile(ast.Module(body=[klass], type_ignores=[]), str(source), 'exec'), scope)
        clip = SimpleNamespace(patcher='clip', tokenize=Mock(side_effect=lambda text, **kwargs: text),
                               encode_from_tokens_scheduled=Mock(side_effect=lambda text: text))
        return scope[klass.name](), clip, management

    def test_success_without_images_only_unloads_clip(self):
        node, clip, management = self.setup_node()
        vae = SimpleNamespace(patcher='vae')
        positive, negative, latent = node.encode(clip, 'positive', 'negative', vae=vae)
        self.assertEqual((positive, negative), ('positive', 'negative'))
        self.assertEqual(latent['samples'], (1, 64, 64, 64))
        management.unload_model_and_clones.assert_called_once_with('clip', all_devices=True)
        management.soft_empty_cache.assert_called_once_with(force=True)

    def test_success_with_reference_releases_clip_and_vae(self):
        node, clip, management = self.setup_node()
        vae = SimpleNamespace(patcher='vae', encode=Mock(return_value='reference'))
        image = Tensor(np.zeros((1, 32, 32, 3)))
        positive, negative, latent = node.encode(clip, 'p', 'n', resolution=0, vae=vae, image_1=image)
        self.assertEqual(positive[1]['reference_latents'], ['reference'])
        self.assertEqual(latent['samples'], (1, 64, 2, 2))
        self.assertEqual([call.args[0] for call in management.unload_model_and_clones.call_args_list], ['clip', 'vae'])
        management.soft_empty_cache.assert_called_once_with(force=True)

    def test_encode_error_still_releases_models_and_preserves_error(self):
        node, clip, management = self.setup_node()
        clip.encode_from_tokens_scheduled.side_effect = RuntimeError('encoder failed')
        with self.assertRaisesRegex(RuntimeError, 'encoder failed'):
            node.encode(clip, 'p', 'n')
        management.unload_model_and_clones.assert_called_once_with('clip', all_devices=True)
        management.soft_empty_cache.assert_called_once_with(force=True)


if __name__ == '__main__':
    unittest.main()
