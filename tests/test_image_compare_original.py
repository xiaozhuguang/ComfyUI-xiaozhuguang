"""Exercise real preview/cache logic without importing ComfyUI or model runtimes."""
import ast
import io
import os
from pathlib import Path
import secrets
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image


class Tensor:
    def __init__(self, array):
        self.array = array

    @property
    def shape(self):
        return self.array.shape

    def cpu(self):
        return self

    def numpy(self):
        return self.array

    def unsqueeze(self, axis):
        return Tensor(np.expand_dims(self.array, axis))

    def squeeze(self, axis):
        return Tensor(np.squeeze(self.array, axis))

    def permute(self, *axes):
        return Tensor(self.array.transpose(axes))


class OriginalTests(unittest.TestCase):
    def test_copy_cache_preserves_rgb_rgba_before_preview_resize(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'nodes/xzg_image_compare.py').read_text(encoding='utf-8'))
        method = next(n for c in tree.body if isinstance(c, ast.ClassDef)
                      for n in c.body if isinstance(n, ast.FunctionDef) and n.name == '_save_compressed')
        store = {str(i): [] for i in range(100)}
        directory = 'preview-cache'
        encoded = {}
        original_save = Image.Image.save
        def capture_save(image, filename, format=None, **kwargs):
            output = io.BytesIO()
            original_save(image, output, format, **kwargs)
            encoded[filename] = output.getvalue()
        with patch.object(Image.Image, 'save', capture_save):
            def resize(tensor, size, **kwargs):
                return Tensor(tensor.array[:, :, :size[0], :size[1]])
            scope = dict(os=SimpleNamespace(makedirs=lambda *a, **k: None, path=os.path), secrets=secrets, np=np, Image=Image, REAL_STORE=store,
                         folder_paths=SimpleNamespace(get_temp_directory=lambda: directory),
                         torch=SimpleNamespace(nn=SimpleNamespace(functional=SimpleNamespace(interpolate=resize))))
            exec(compile(ast.Module(body=[method], type_ignores=[]), '<compare>', 'exec'), scope)
            for channels in (3, 4):
                with self.subTest(channels=channels):
                    original = np.zeros((8, 6, channels), dtype=np.float32)
                    original[..., :3] = [0.8, 0.4, 0.2]
                    if channels == 4:
                        original[..., 3] = 0.5
                        original[0, 0, 3] = 0
                    entries = scope['_save_compressed'](None, [Tensor(original), Tensor(original)], max_side=2)
                    self.assertEqual(len(store), 100)
                    self.assertEqual(entries[1]['real_index'], 1)
                    self.assertEqual(entries[0]['real_token'], entries[1]['real_token'])
                    cached = store[entries[0]['real_token']][0]
                    np.testing.assert_array_equal(cached, (original * 255).astype(np.uint8))
                    with Image.open(io.BytesIO(encoded[os.path.join(directory, entries[0]['filename'])])) as preview:
                        self.assertEqual(preview.size, (1, 2))
                    if channels == 4:
                        self.assertEqual(cached[0, 0, 3], 0)
                        self.assertEqual(cached[1, 0, 3], 127)


if __name__ == '__main__':
    unittest.main()
