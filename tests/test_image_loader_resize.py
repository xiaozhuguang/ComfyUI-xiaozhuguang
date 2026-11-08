import ast
import json
import os
from pathlib import Path
import secrets
import shutil
from contextlib import contextmanager
import types
import unittest

from PIL import Image, ImageOps


@contextmanager
def image_directory():
    directory = Path(__file__).resolve().parent / ("resize-fixture-" + secrets.token_hex(8))
    directory.mkdir()
    try:
        yield str(directory)
    finally:
        shutil.rmtree(directory)


class ResizeCropTests(unittest.TestCase):
    def test_resize_uses_crop_pixels_aspect_and_padding(self):
        source = Path(__file__).resolve().parents[1] / "nodes/xzg_image_loader.py"
        tree = ast.parse(source.read_text(encoding="utf-8-sig"))
        functions = [item for item in tree.body if isinstance(item, ast.FunctionDef)
                     and item.name in ("_resize_image_to_input", "_parse_crop_padding_color")]
        with image_directory() as directory:
            paths = types.SimpleNamespace(**{name: lambda: directory for name in
                ("get_input_directory", "get_output_directory", "get_temp_directory")})
            scope = dict(Image=Image, ImageOps=ImageOps, os=os, json=json,
                         secrets=secrets, folder_paths=paths,
                         _normalize_annotated_filename=lambda name: name)
            exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), scope)
            resize = scope["_resize_image_to_input"]
            image = Image.new("RGB", (100, 80), "red")
            image.paste("blue", (50, 0, 100, 80))
            image.save(Path(directory) / "source.png")
            result = resize("source.png", "width", 100, crop=[50, 0, 50, 20])
            with Image.open(Path(directory) / result["name"]) as output:
                self.assertEqual(output.size, (100, 40))
                self.assertEqual(output.getpixel((50, 20)), (0, 0, 255))
            result = resize("source.png", "height", 40, crop=[-10, 0, 20, 20], padding_color="#123456")
            with Image.open(Path(directory) / result["name"]) as output:
                self.assertEqual(output.size, (40, 40))
                self.assertEqual(output.getpixel((0, 20)), (18, 52, 86))
            result = resize("source.png", "width", 200)
            self.assertEqual((result["width"], result["height"]), (200, 160))
            Image.new("RGB", (7680, 100), "blue").save(Path(directory) / "large.png")
            result = resize("large.png", "width", 80, 8, [0, 0, 40, 20])
            self.assertEqual((result["width"], result["height"]), (80, 40))


if __name__ == "__main__":
    unittest.main()
