import ast
import os
from pathlib import Path
from types import SimpleNamespace
import unittest

class VideoSourceDirectoryTest(unittest.TestCase):
    def test_media_type_selects_correct_directory_even_with_same_filename(self):
        source = Path(__file__).resolve().parents[1] / 'nodes' / 'xzg_video_loader.py'
        tree = ast.parse(source.read_text(encoding='utf-8-sig'))
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_xzg_loader_abs')
        scope = {'os': os, '_xzg_secure_subfolder': lambda value: value,
                 'folder_paths': SimpleNamespace(get_input_directory=lambda: 'input',
                    get_output_directory=lambda: 'output', get_temp_directory=lambda: 'temp')}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), scope)
        for kind in ('input', 'output', 'temp'):
            with self.subTest(kind=kind):
                self.assertEqual(scope['_xzg_loader_abs']('Timeline 1_1.mp4', kind, 'nested'),
                                 os.path.join(kind, 'nested', 'Timeline 1_1.mp4'))

if __name__ == '__main__':
    unittest.main()
