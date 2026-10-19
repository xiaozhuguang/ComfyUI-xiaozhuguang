import ast
import os
import secrets
import tempfile
import types
import unittest
from pathlib import Path

from PIL import Image, ImageOps


class ImageLoaderResizeTests(unittest.TestCase):
    def test_resize_creates_input_copy_and_preserves_source(self):
        source = (Path(__file__).resolve().parents[1] / "nodes/xzg_image_loader.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_resize_image_to_input")
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            paths = types.SimpleNamespace(get_input_directory=lambda: directory,
                                          get_output_directory=lambda: directory,
                                          get_temp_directory=lambda: directory)
            scope = dict(os=os, secrets=secrets, Image=Image, ImageOps=ImageOps,
                         folder_paths=paths, _normalize_annotated_filename=lambda name: name)
            exec(compile(ast.Module(body=[function], type_ignores=[]), "resize", "exec"), scope)
            resize = scope["_resize_image_to_input"]
            original = Path(directory) / "source.png"
            Image.new("RGBA", (40, 20), (100, 50, 20, 128)).save(original)
            before = original.read_bytes()
            for axis, value, expected in [("width", 80, (80, 40)), ("height", 60, (120, 60)),
                                           ("width", 10, (10, 5)), ("height", 7, (14, 7))]:
                with self.subTest(axis=axis, value=value):
                    result = resize("source.png", axis, value)
                    with Image.open(Path(directory) / result["name"]) as image:
                        self.assertEqual(image.size, expected)
                        self.assertEqual(image.mode, "RGBA")
                        self.assertEqual(image.getpixel((0, 0))[3], 128)
                    self.assertEqual(original.read_bytes(), before)
            for multiple in (8, 16, 32):
                for axis in ("width", "height"):
                    result = resize("source.png", axis, 83, multiple)
                    self.assertEqual(result["width"] % multiple, 0)
                    self.assertEqual(result["height"] % multiple, 0)
                    with Image.open(Path(directory) / result["name"]) as image:
                        self.assertEqual(image.size, (result["width"], result["height"]))
            with self.assertRaises(ValueError):
                resize("source.png", "width", 80, 7)
            a = resize("source.png", "width", 80)
            b = resize("source.png", "width", 80)
            self.assertNotEqual(a["name"], b["name"])
            for axis, value in [("width", 0), ("height", 3.5), ("width", True), ("other", 10)]:
                with self.assertRaises(ValueError):
                    resize("source.png", axis, value)
            with self.assertRaises(ValueError):
                resize("../outside.png", "width", 80)


if __name__ == "__main__":
    unittest.main()
