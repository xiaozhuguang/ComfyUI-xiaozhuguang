"""ZIP backup regression tests, isolated from model/torch initialization.
Run with the ComfyUI Python runtime: python -m unittest discover -s tests -v
"""
import ast
import asyncio
import base64
import contextvars
from contextlib import contextmanager
import functools
import hashlib
import subprocess
import time
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile
import wave

from aiohttp import web, FormData
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image


def load_media_code(user_directory):
    source = Path(__file__).resolve().parents[1] / "nodes" / "xzg_image_loader.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    selected = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and (
                node.name.startswith("_media_") or node.name.startswith("xzg_media_library")):
            node.decorator_list = [decorator for decorator in node.decorator_list
                                   if isinstance(decorator, ast.Name) and decorator.id in ("contextmanager", "_media_library_handler")]
            selected.append(node)
        elif isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in {
                "IMAGE_EXTENSIONS", "MEDIA_IMAGE_EXTENSIONS", "MEDIA_MAX_FILE_BYTES",
                "MEDIA_ARCHIVE_MAX_BYTES", "MEDIA_CONFIG_MAX_BYTES", "_media_pending_archives",
                "_media_kind", "MEDIA_MAX_VIDEO_BYTES", "MEDIA_ARCHIVE_LIBRARIES",
                "_media_video_thumbnail_slots", "MEDIA_VIDEO_FORMATS", "MEDIA_AUDIO_FORMATS"}
                for t in node.targets):
            selected.append(node)
    binaries = Path(__file__).resolve().parents[4] / "ffmpeg" / "bin"
    ffmpeg = str(binaries / "ffmpeg.exe") if (binaries / "ffmpeg.exe").is_file() else shutil.which("ffmpeg")
    ffprobe = str(binaries / "ffprobe.exe") if (binaries / "ffprobe.exe").is_file() else shutil.which("ffprobe")
    def cache_directory():
        cache = Path(user_directory) / "thumb-cache"
        cache.mkdir(exist_ok=True)
        return str(cache)
    scope = dict(contextvars=contextvars, contextmanager=contextmanager, _xzg_ft=functools,
                 subprocess=subprocess, hashlib=hashlib, time=time,
                 VIDEO_EXTENSIONS={"webm", "mp4", "mkv", "gif", "mov", "avi", "flv", "wmv", "m4v", "mpg", "mpeg", "ts"},
                 AUDIO_EXTENSIONS={"mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "opus", "amr", "ac3", "aiff", "au", "mka", "mp2", "ra", "voc", "w64"},
                 ffmpeg_path=ffmpeg, _get_ffprobe_path=lambda: ffprobe,
                 _get_media_thumb_cache_dir=cache_directory, _clean_media_thumb_cache=lambda days: None,
                 _safe_dir=lambda name, fallback: str(Path(user_directory) / fallback),
                 os=os, io=io, json=json, base64=base64, shutil=shutil, tempfile=tempfile,
                 zipfile=zipfile, secrets=secrets, Image=Image, web=web, _xzg_asyncio=asyncio,
                 folder_paths=SimpleNamespace(get_user_directory=lambda: user_directory))
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(source), "exec"), scope)
    return scope


class MediaBackupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.temp_directory_patch = patch.object(tempfile, "tempdir", self.temporary.name)
        self.temp_directory_patch.start()
        self.code = load_media_code(self.temporary.name)
        self.root = Path(self.code["_media_library_dir"]())
        self.image = io.BytesIO()
        Image.new("RGB", (8, 8), "red").save(self.image, format="PNG")
        self.raw = self.image.getvalue()
        self.config = {"format": "xiaozhuguang-config", "version": 8,
                       "localStorage": {"example": "value"}, "mediaLibrary": {"geometry": {"width": 900}}}
        app = web.Application()
        for method, route, name in [
                ("POST", "/backup", "xzg_media_library_archive_backup"),
                ("POST", "/archive", "xzg_media_library_archive_upload"),
                ("POST", "/restore", "xzg_media_library_archive_restore"),
                ("DELETE", "/archive", "xzg_media_library_archive_discard"),
                ("POST", "/legacy", "xzg_media_library_restore"),
                ("GET", "/library", "xzg_media_library_list"),
                ("POST", "/library/upload", "xzg_media_library_upload"),
                ("PUT", "/library/order", "xzg_media_library_order"),
                ("GET", "/library/thumb", "xzg_media_library_thumb"),
                ("GET", "/library/file", "xzg_media_library_file"),
                ("POST", "/library/to-input", "xzg_media_library_to_input"),
                ("POST", "/library/add-video", "xzg_media_library_add_video"),
                ("POST", "/library/add-audio", "xzg_media_library_add_audio")]:
            app.router.add_route(method, route, self.code[name])
        for directory in ("input", "output", "temp"):
            (Path(self.temporary.name) / directory).mkdir()
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        for token in list(self.code["_media_pending_archives"]):
            self.code["_media_discard_archive"](token)
        self.temporary.cleanup()
        self.temp_directory_patch.stop()

    def populate(self):
        (self.root / "分类").mkdir()
        (self.root / "空分类").mkdir()
        (self.root / "分类" / "原图.png").write_bytes(self.raw)
        (self.root / "根目录.png").write_bytes(self.raw)
        self.code["_media_write_order"](["分类/原图.png", "根目录.png"])
        self.code["_media_write_folder_order"](["空分类", "分类"])

    async def backup(self):
        response = await self.client.post("/backup", json=self.config)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.content_type, "application/zip")
        return await response.read()

    async def upload(self, raw):
        response = await self.client.post("/archive", data=raw, headers={"Content-Type": "application/zip"})
        self.assertEqual(response.status, 200, await response.text())
        return await response.json()

    async def test_roundtrip_original_bytes_order_empty_folders_and_merge(self):
        self.populate()
        raw = await self.backup()
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            self.assertEqual(archive.read("images/分类/原图.png"), self.raw)
            self.assertEqual(archive.getinfo("images/分类/原图.png").compress_type, zipfile.ZIP_STORED)
            config = json.loads(archive.read("config.json"))
            self.assertNotIn("data", config["mediaLibrary"]["files"][0])
            self.assertEqual(config["mediaLibrary"]["folders"], ["空分类", "分类"])
        shutil.rmtree(self.root)
        self.root.mkdir()
        (self.root / "根目录.png").write_bytes(b"old contents")
        (self.root / "保留.png").write_bytes(self.raw)
        uploaded = await self.upload(raw)
        self.assertEqual(uploaded["config"]["localStorage"], {"example": "value"})
        response = await self.client.post("/restore", json={"token": uploaded["token"]})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())["restored"], 2)
        self.assertEqual((self.root / "根目录.png").read_bytes(), self.raw)
        self.assertTrue((self.root / "空分类").is_dir())
        self.assertTrue((self.root / "保留.png").is_file())
        self.assertEqual(self.code["_media_ordered_names"](str(self.root)), ["分类/原图.png", "根目录.png", "保留.png"])
        self.assertEqual(self.code["_media_folders"](str(self.root)), ["空分类", "分类"])
        self.assertFalse(self.code["_media_pending_archives"])
        response = await self.client.post("/restore", json={"token": uploaded["token"]})
        self.assertEqual(response.status, 400)

    async def test_config_only_and_cancel_cleanup(self):
        self.config["mediaLibrary"] = None
        uploaded = await self.upload(await self.backup())
        pending_path = self.code["_media_pending_archives"][uploaded["token"]][0]
        response = await self.client.delete("/archive", json={"token": uploaded["token"]})
        self.assertEqual(response.status, 200)
        self.assertFalse(os.path.exists(pending_path))
        self.assertFalse(self.code["_media_pending_archives"])

    async def test_legacy_json_restore(self):
        response = await self.client.post("/legacy", json={"version": 2,
            "files": [{"name": "旧备份.png", "data": base64.b64encode(self.raw).decode("ascii")}],
            "order": ["旧备份.png"]})
        self.assertEqual(response.status, 200)
        self.assertEqual((self.root / "旧备份.png").read_bytes(), self.raw)

    def altered_archive(self, raw, change):
        result = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(raw)) as original, zipfile.ZipFile(result, "w") as archive:
            entries = {name: original.read(name) for name in original.namelist()}
            change(entries)
            for name, contents in entries.items():
                archive.writestr(name, contents)
        return result.getvalue()

    async def test_invalid_image_does_not_change_library(self):
        self.populate()
        raw = await self.backup()
        raw = self.altered_archive(raw, lambda entries: entries.update({"images/根目录.png": b"not an image"}))
        (self.root / "分类" / "原图.png").write_bytes(b"existing original")
        uploaded = await self.upload(raw)
        response = await self.client.post("/restore", json={"token": uploaded["token"]})
        self.assertEqual(response.status, 400)
        self.assertEqual((self.root / "分类" / "原图.png").read_bytes(), b"existing original")

    async def test_write_failure_rolls_back_overwrites(self):
        self.populate()
        raw = await self.backup()
        (self.root / "分类" / "原图.png").write_bytes(b"existing original")
        uploaded = await self.upload(raw)
        real_replace = os.replace
        def fail_second_image(source, target):
            if Path(source).name == "1":
                raise OSError("simulated write failure")
            real_replace(source, target)
        with patch.object(os, "replace", side_effect=fail_second_image):
            response = await self.client.post("/restore", json={"token": uploaded["token"]})
        self.assertEqual(response.status, 400)
        self.assertEqual((self.root / "分类" / "原图.png").read_bytes(), b"existing original")
        self.assertEqual((self.root / "根目录.png").read_bytes(), self.raw)

    async def test_reject_path_traversal_missing_images_and_bad_zip(self):
        self.populate()
        raw = await self.backup()
        for change in [lambda entries: entries.update({"images/../outside.png": self.raw}),
                       lambda entries: entries.pop("images/根目录.png")]:
            with self.subTest(change=change):
                response = await self.client.post("/archive", data=self.altered_archive(raw, change))
                self.assertEqual(response.status, 400)
        response = await self.client.post("/archive", data=b"invalid ZIP")
        self.assertEqual(response.status, 400)
        self.assertFalse(self.code["_media_pending_archives"])

    async def test_archive_size_limit(self):
        self.code["MEDIA_ARCHIVE_MAX_BYTES"] = 8
        response = await self.client.post("/archive", data=b"0123456789")
        self.assertEqual(response.status, 413)

    def video_fixture(self):
        if not self.code["ffmpeg_path"] or not self.code["_get_ffprobe_path"]():
            self.skipTest("FFmpeg and FFprobe are required for video regression tests")
        path = Path(self.temporary.name) / "fixture.mp4"
        subprocess.run([self.code["ffmpeg_path"], "-nostdin", "-v", "error", "-f", "lavfi",
            "-i", "color=c=blue:s=32x32:r=5:d=0.4", "-c:v", "libx264", "-threads", "1",
            "-pix_fmt", "yuv420p", "-y", str(path)], check=True, capture_output=True, timeout=30)
        return path.read_bytes()

    def video_root(self):
        with self.code["_media_library_context"]("video"):
            return Path(self.code["_media_library_dir"]())

    async def test_video_upload_thumbnail_load_and_persistent_isolation(self):
        raw = self.video_fixture()
        body = FormData(quote_fields=False)
        body.add_field("file", raw, filename="样片.mp4", content_type="video/mp4")
        body.add_field("folder", "视频分类")
        response = await self.client.post("/library/upload?kind=video", data=body)
        self.assertEqual(response.status, 200, await response.text())
        name = (await response.json())["name"]
        self.assertEqual(name, "视频分类/样片.mp4")
        image_list, video_list = await asyncio.gather(
            self.client.get("/library?folder=__all__"),
            self.client.get("/library?kind=video&folder=__all__"))
        self.assertEqual((await image_list.json())["items"], [])
        self.assertEqual((await video_list.json())["items"][0]["name"], name)
        # A new code instance reads the same disk files and folder metadata.
        reopened = load_media_code(self.temporary.name)
        with reopened["_media_library_context"]("video"):
            self.assertEqual(reopened["_media_ordered_names"](str(self.video_root())), [name])
        response = await self.client.put("/library/order?kind=video", json={"folder": "__all__", "names": [name]})
        self.assertEqual(response.status, 200)
        response = await self.client.get("/library/thumb", params={"kind": "video", "name": name})
        self.assertEqual(response.status, 200, await response.text() if response.status != 200 else "")
        poster = await response.read()
        self.assertTrue(poster.startswith(b"\x89PNG"))
        response = await self.client.get("/library/thumb", params={"kind": "video", "name": name})
        self.assertEqual(await response.read(), poster)
        response = await self.client.post("/library/to-input?kind=video", json={"names": [name]})
        self.assertEqual(response.status, 200)
        selected = (await response.json())["names"][0]
        self.assertNotIn("/", selected)
        self.assertEqual((Path(self.temporary.name) / "input" / selected).read_bytes(), raw)
        response = await self.client.post("/library/add-video", json={"filename": selected, "type": "input"})
        self.assertEqual(response.status, 200, await response.text())
        response = await self.client.get("/library/file", params={"kind": "video", "name": name}, headers={"Range": "bytes=0-7"})
        self.assertEqual(response.status, 206)
        self.assertEqual(await response.read(), raw[:8])

    async def test_video_zip_roundtrip_and_separate_category_restore(self):
        self.populate()
        raw = self.video_fixture()
        video_root = self.video_root()
        (video_root / "空视频分类").mkdir()
        (video_root / "样片.mp4").write_bytes(raw)
        with self.code["_media_library_context"]("video"):
            self.code["_media_write_order"](["样片.mp4"])
            self.code["_media_write_folder_order"](["空视频分类"])
        self.config.update(version=9, videoLibrary={"geometry": {"width": 1000}})
        backup = await self.backup()
        with zipfile.ZipFile(io.BytesIO(backup)) as archive:
            self.assertEqual(archive.read("videos/样片.mp4"), raw)
        (self.root / "根目录.png").write_bytes(b"image unchanged")
        shutil.rmtree(video_root)
        uploaded = await self.upload(backup)
        response = await self.client.post("/restore", json={"token": uploaded["token"],
            "libraries": {"mediaLibrary": False, "videoLibrary": True}})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(await response.json(), {"restored": 0, "restoredVideos": 1, "restoredAudios": 0})
        self.assertEqual((self.root / "根目录.png").read_bytes(), b"image unchanged")
        self.assertEqual((video_root / "样片.mp4").read_bytes(), raw)
        self.assertTrue((video_root / "空视频分类").is_dir())
        (video_root / "样片.mp4").write_bytes(b"video unchanged")
        uploaded = await self.upload(backup)
        response = await self.client.post("/restore", json={"token": uploaded["token"],
            "libraries": {"mediaLibrary": True, "videoLibrary": False}})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((video_root / "样片.mp4").read_bytes(), b"video unchanged")
        self.assertEqual((self.root / "根目录.png").read_bytes(), self.raw)

    async def test_bad_video_prevents_combined_restore(self):
        self.populate()
        (self.video_root() / "损坏.mp4").write_bytes(b"not a video")
        self.config.update(version=9, videoLibrary={})
        backup = await self.backup()
        (self.root / "分类" / "原图.png").write_bytes(b"existing image")
        uploaded = await self.upload(backup)
        response = await self.client.post("/restore", json={"token": uploaded["token"]})
        self.assertEqual(response.status, 400)
        self.assertEqual((self.root / "分类" / "原图.png").read_bytes(), b"existing image")

    async def test_audio_upload_waveform_load_and_zip_roundtrip(self):
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b"\x00\x10\x00\xf0" * 2000)
        raw = buffer.getvalue()
        form = FormData(quote_fields=False)
        form.add_field("file", raw, filename="样音.wav", content_type="audio/wav")
        form.add_field("folder", "音乐")
        response = await self.client.post("/library/upload?kind=audio", data=form)
        self.assertEqual(response.status, 200, await response.text())
        name = (await response.json())["name"]
        self.assertEqual(name, "音乐/样音.wav")
        response = await self.client.get("/library/thumb", params={"kind": "audio", "name": name})
        self.assertEqual(response.status, 200, await response.text() if response.status != 200 else "")
        self.assertTrue((await response.read()).startswith(b"\x89PNG"))
        response = await self.client.post("/library/to-input?kind=audio", json={"names": [name]})
        self.assertEqual(response.status, 200)
        selected = (await response.json())["names"][0]
        self.assertNotIn("/", selected)
        self.assertEqual((Path(self.temporary.name) / "input" / selected).read_bytes(), raw)
        response = await self.client.post("/library/add-audio", json={"filename": selected, "type": "input"})
        self.assertEqual(response.status, 200, await response.text())
        self.config.update(version=10, audioLibrary={})
        backup = await self.backup()
        with zipfile.ZipFile(io.BytesIO(backup)) as archive:
            self.assertEqual(archive.read("audio/音乐/样音.wav"), raw)
        with self.code["_media_library_context"]("audio"):
            directory = Path(self.code["_media_library_dir"]())
        shutil.rmtree(directory)
        uploaded = await self.upload(backup)
        response = await self.client.post("/restore", json={"token": uploaded["token"],
            "libraries": {"mediaLibrary": False, "videoLibrary": False, "audioLibrary": True}})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())["restoredAudios"], 2)
        self.assertEqual((directory / "音乐" / "样音.wav").read_bytes(), raw)
        response = await self.client.get("/library?folder=__all__")
        self.assertEqual((await response.json())["items"], [])


if __name__ == "__main__":
    unittest.main()
