import ast
import hashlib
import json
import os
from pathlib import Path
import uuid
import unittest


class VideoOutputFileCacheTest(unittest.TestCase):
    def test_deleted_file_invalidates_once_and_regeneration_stays_cached(self):
        source = Path(__file__).resolve().parents[1] / 'nodes/xzg_video_combine.py'
        tree = ast.parse(source.read_text(encoding='utf-8'))
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'XiaozhuguangVideoCombine')
        cls.body = [n for n in cls.body if
                    isinstance(n, ast.FunctionDef) and n.name in ('_output_cache_key', 'IS_CHANGED') or
                    isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '_output_files' for t in n.targets)]
        scope = dict(hashlib=hashlib, json=json, os=os)
        exec(compile(ast.Module(body=[cls], type_ignores=[]), str(source), 'exec'), scope)
        node = scope['XiaozhuguangVideoCombine']
        prompt = {'7': {'inputs': {'模式': '预览'}}}
        key = node._output_cache_key(prompt, '7')
        self.assertEqual(node.IS_CHANGED(prompt=prompt, unique_id='7'), 0)
        path = Path(__file__).parent / (uuid.uuid4().hex + '.mp4')
        try:
            path.write_bytes(b'video')
            node._output_files[key] = [str(path), 0]
            self.assertEqual(node.IS_CHANGED(prompt=prompt, unique_id='7'), 0)
            path.unlink()
            self.assertEqual(node.IS_CHANGED(prompt=prompt, unique_id='7'), 1)
            self.assertEqual(node.IS_CHANGED(prompt=prompt, unique_id='7'), 1)
            path.write_bytes(b'regenerated')
            node._output_files[key][0] = str(path)
            self.assertEqual(node.IS_CHANGED(prompt=prompt, unique_id='7'), 1)
            self.assertEqual(node.IS_CHANGED(prompt=prompt, unique_id='other'), 0)
            path.unlink()
            self.assertEqual(node.IS_CHANGED(prompt=prompt, unique_id='7'), 2)
        finally:
            path.unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
