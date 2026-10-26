"""Exercise the real save method without importing ComfyUI or encoding video."""
import ast
import hashlib
import os
from pathlib import Path
import re
import types
import unittest
import uuid

SOURCE = Path(__file__).resolve().parents[1] / 'nodes' / 'xzg_video_combine.py'

class Frames:
    def size(self, axis):
        return 2

class VideoPreviewCacheTests(unittest.TestCase):
    def test_workflows_do_not_delete_each_others_preview_and_versions_change(self):
        method = next(n for n in ast.walk(ast.parse(SOURCE.read_text(encoding='utf-8')))
                      if isinstance(n, ast.FunctionDef) and n.name == 'combine_video')
        root = 'output'
        files = {}
        fake_os = types.SimpleNamespace(
            path=os.path, makedirs=lambda *a, **kw: None,
            listdir=lambda folder: [os.path.basename(p) for p in files if os.path.dirname(p) == folder],
            remove=lambda path: files.pop(path),
        )
        def save_path(prefix, output):
            folder = os.path.join(output, os.path.dirname(prefix))
            return folder, os.path.basename(prefix), 1, os.path.dirname(prefix), prefix

        scope = dict(os=fake_os, re=re, hashlib=hashlib, uuid=uuid,
                     torch=types.SimpleNamespace(Tensor=Frames),
                     folder_paths=types.SimpleNamespace(get_save_image_path=save_path),
                     _safe_dir=lambda *args: root,
                     VIDEO_FORMATS={'mp4': {'extension': 'mp4'}},
                     export_to_video=lambda **kw: files.update({kw['output_file']: b'video'}))
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(SOURCE), 'exec'), scope)
        def run(owner):
            return scope['combine_video'](None, Frames(), 24, 'test', 'mp4', 18, '预览',
                extra_pnginfo={'workflow': {'id': owner}}, unique_id='7')['ui']['video'][0]

        a1, b1, a2 = run('a'), run('b'), run('a')
        self.assertNotEqual(a1['subfolder'], b1['subfolder'])
        self.assertIn(b1['abs_path'], files)
        self.assertIn(a2['abs_path'], files)
        self.assertNotIn(a1['abs_path'], files)
        self.assertNotEqual(a1['preview_id'], a2['preview_id'])
        # Clearing the directory can reuse a filename; its content version must still change.
        files.pop(a2['abs_path'])
        a3 = run('a')
        self.assertEqual(a1['filename'], a3['filename'])
        self.assertNotEqual(a1['preview_id'], a3['preview_id'])

if __name__ == '__main__':
    unittest.main()
