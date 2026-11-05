"""Exercise container metadata without importing the ComfyUI server."""
import ast
import json
import os
import re
import uuid
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class VideoWorkflowMetadataTest(unittest.TestCase):
    def test_container_round_trip(self):
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            try:
                from imageio_ffmpeg import get_ffmpeg_exe
                ffmpeg = get_ffmpeg_exe()
            except ImportError:
                self.skipTest("ffmpeg unavailable")
        source = Path(__file__).resolve().parents[1] / "nodes/xzg_video_combine.py"
        function = next(n for n in ast.parse(source.read_text(encoding="utf-8")).body
                        if isinstance(n, ast.FunctionDef) and n.name == "_embed_video_workflow")
        namespace = dict(os=os, json=json, subprocess=subprocess, tempfile=tempfile, ffmpeg_path=ffmpeg)
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
        workflow = {"nodes": [{"id": 1}], "extra": {"text": '中文 = ; # \\ "\n' * 5000}}
        directory = str(Path(__file__).parent / ("video_metadata_" + uuid.uuid4().hex))
        os.mkdir(directory)
        try:
            for extension, codec in (("mp4", "libx264"), ("webm", "libvpx-vp9")):
                with self.subTest(extension=extension):
                    path = os.path.join(directory, "video." + extension)
                    subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i",
                                    "color=c=red:s=32x32:r=2", "-t", "1", "-c:v", codec, path], check=True)
                    namespace["_embed_video_workflow"](path, extension, {"test": True}, {"workflow": workflow})
                    result = subprocess.run([ffmpeg, "-v", "error", "-i", path, "-f", "ffmetadata", "-"],
                                            check=True, capture_output=True)
                    tags = dict((line.split("=", 1)[0].lower(), line.split("=", 1)[1]) for line in result.stdout.decode("utf-8").splitlines()
                                if "=" in line and not line.startswith(";"))
                    decoded = re.sub(r"\\(.)", r"\1", tags["workflow"])
                    self.assertEqual(json.loads(decoded), workflow)
                    self.assertEqual(json.loads(re.sub(r"\\(.)", r"\1", tags["prompt"])), {"test": True})
        finally:
            shutil.rmtree(directory)


if __name__ == "__main__":
    unittest.main()

