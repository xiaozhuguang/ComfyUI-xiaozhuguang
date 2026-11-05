import asyncio
import importlib.util
import json
from pathlib import Path
import subprocess
import shutil
import sys
import types
import unittest
import uuid
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load_bridge():
    package = types.ModuleType("_xzg_codex_test")
    package.__path__ = [str(ROOT)]
    package.xzg_safe_handler = lambda handler: handler
    folders = types.ModuleType("folder_paths")
    server = types.ModuleType("server")
    server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
        routes=types.SimpleNamespace(post=lambda path: lambda handler: handler)))
    aiohttp = types.ModuleType("aiohttp")
    aiohttp.web = types.SimpleNamespace(json_response=lambda body, status=200: types.SimpleNamespace(body=body, status=status))
    saved_video = types.ModuleType("_xzg_codex_test.nodes.xzg_video_save_davinci")
    saved_video._lookup_abs_token = lambda token: None
    spec = importlib.util.spec_from_file_location("_xzg_codex_test.xzg_codex_upload", ROOT / "xzg_codex_upload.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {package.__name__: package, "folder_paths": folders, "server": server, "aiohttp": aiohttp, saved_video.__name__: saved_video}):
        spec.loader.exec_module(module)
    return module


bridge = load_bridge()


class MediaFilesTest(unittest.TestCase):
    def setUp(self):
        self.root = ROOT / "tests" / ("codex-" + uuid.uuid4().hex)
        self.root.mkdir()
        assert self.root.resolve().is_relative_to((ROOT / "tests").resolve())
        self.addCleanup(shutil.rmtree, self.root)
        self.input = self.root / "input"
        self.output = self.root / "output"
        self.input.mkdir()
        self.output.mkdir()
        (self.input / "子目录").mkdir()
        (self.input / "子目录" / "测试 原图.png").write_bytes(b"image")
        (self.input / "原视频.mp4").write_bytes(b"video")
        (self.output / "result.png").write_bytes(b"image")

        def annotated(name):
            for suffix, folder in [(" [input]", self.input), (" [output]", self.output)]:
                if name.endswith(suffix):
                    return name[:-len(suffix)], str(folder)
            return name, None

        bridge.folder_paths.annotated_filepath = annotated
        bridge.folder_paths.get_input_directory = lambda: str(self.input)

    def test_powershell_resolves_without_path(self):
        executable = self.root / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"")
        with patch.dict(bridge.os.environ, {"SystemRoot": str(self.root), "PATH": ""}, clear=True):
            self.assertEqual(bridge._powershell_executable(), str(executable))
            result = subprocess.CompletedProcess([], 0, '{"ok":true}', "")
            with patch.object(bridge.subprocess, "run", return_value=result) as run:
                bridge.add_codex_attachments(["原视频.mp4"], "doubao")
            self.assertEqual(run.call_args.args[0][0], str(executable))

    def test_missing_powershell_has_actionable_error(self):
        with patch.dict(bridge.os.environ, {}, clear=True), patch.object(bridge.shutil, "which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "找不到 Windows PowerShell"):
                bridge.add_codex_attachments(["原视频.mp4"], "doubao")

    def test_original_files_and_deduplication(self):
        paths = bridge.resolve_media_files(["子目录/测试 原图.png", "子目录/测试 原图.png [input]"], "image")
        self.assertEqual(paths, [str(self.input / "子目录" / "测试 原图.png")])
        self.assertEqual(bridge.resolve_media_files(["原视频.mp4"], "video"), [str(self.input / "原视频.mp4")])
        self.assertEqual(bridge.resolve_media_files(["result.png [output]"], "image"), [str(self.output / "result.png")])

    def test_reject_escape_missing_and_wrong_kind(self):
        for names, kind in [
            (["../output/result.png"], "image"),
            ([str(self.output / "result.png")], "image"),
            (["missing.png"], "image"),
            (["原视频.mp4"], "image"),
            (["x.exe"], "video"),
            ([None], "image"),
            (["x\0.png"], "image"),
            ([], "image"),
            ("原视频.mp4", "video"),
            (["原视频.mp4"], "unknown"),
            (["原视频.mp4"], []),
        ]:
            with self.subTest(names=names, kind=kind), self.assertRaises(ValueError):
                bridge.resolve_media_files(names, kind)

    def test_unicode_paths_are_data_not_shell_code(self):
        paths = [str(self.input / "子目录" / "测试 原图.png")]
        result = subprocess.CompletedProcess([], 0, '{"ok":true,"copied":true,"pasted":true,"verified":false}', "")
        with patch.object(bridge.subprocess, "run", return_value=result) as run:
            self.assertFalse(bridge.add_codex_attachments(paths)["verified"])
        args, kwargs = run.call_args
        self.assertEqual(json.loads(kwargs["input"]), paths)
        self.assertNotIn("shell", kwargs)
        self.assertNotIn("-ExecutionPolicy", args[0])
        self.assertNotIn(paths[0], args[0])

    def test_all_targets_only_copy_without_window_or_target_arguments(self):
        result = subprocess.CompletedProcess([], 0, '{"ok":true,"copied":true}', "")
        for target in ("codex", "doubao", "clipboard"):
            with self.subTest(target=target), patch.object(bridge.subprocess, "run", return_value=result) as run:
                self.assertTrue(bridge.add_codex_attachments(["原视频.mp4"], target)["copied"])
                args = run.call_args.args[0]
                self.assertNotIn("-Target", args)
                self.assertNotIn("-SourceWindow", args)
                self.assertEqual(Path(args[-1]).name, "xzg_codex_upload.ps1")
        with self.assertRaises(ValueError):
            bridge.add_codex_attachments(["x.png"], "unknown")

    def test_manual_paste_fallback_is_preserved(self):
        result = subprocess.CompletedProcess([], 0, '{"ok":true,"copied":true,"pasted":false,"warning":"Press Ctrl+V"}', "")
        with patch.object(bridge.subprocess, "run", return_value=result):
            copied = bridge.add_codex_attachments(["test.png"])
        self.assertTrue(copied["copied"])
        self.assertFalse(copied["pasted"])
        self.assertEqual(copied["warning"], "Press Ctrl+V")

    def test_helper_failures_are_not_success(self):
        for result in [subprocess.CompletedProcess([], 1, '{"ok":false,"error":"No window"}', ""),
                       subprocess.CompletedProcess([], 1, "", "policy blocked")]:
            with self.subTest(result=result), patch.object(bridge.subprocess, "run", return_value=result), self.assertRaises(RuntimeError):
                bridge.add_codex_attachments(["test.png"])

    def test_helper_failure_preserves_warning_as_error(self):
        result = subprocess.CompletedProcess([], 0, '{"ok":false,"warning":"clipboard busy"}', "")
        with patch.object(bridge.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "clipboard busy"):
                bridge.add_codex_attachments(["test.png"], "doubao")

    def test_doubao_window_failure_after_copy_keeps_manual_fallback(self):
        result = subprocess.CompletedProcess([], 0, '{"ok":true,"copied":true,"pasted":false,"warning":"No unique window"}', "")
        with patch.object(bridge.subprocess, "run", return_value=result):
            response = bridge.add_codex_attachments(["test.png"], "doubao")
        self.assertTrue(response["copied"])
        self.assertFalse(response["pasted"])
        self.assertEqual(response["warning"], "No unique window")


class LocalOnlyTest(unittest.IsolatedAsyncioTestCase):
    async def test_remote_requests_never_open_picker(self):
        request = types.SimpleNamespace(path="/xzg/codex/attachments", remote="192.168.1.20", host="localhost:8188", headers={"Origin": "http://localhost:8188"})
        with patch.object(bridge, "add_codex_attachments") as upload:
            response = await bridge.codex_attachments(request)
        self.assertEqual(response.status, 403)
        upload.assert_not_called()

    async def test_cross_origin_requests_never_open_picker(self):
        request = types.SimpleNamespace(path="/xzg/codex/attachments", remote="127.0.0.1", host="localhost:8188", headers={"Origin": "https://example.com"})
        with patch.object(bridge, "add_codex_attachments") as upload:
            response = await bridge.codex_attachments(request)
        self.assertEqual(response.status, 403)
        upload.assert_not_called()

    async def test_routes_select_target_with_or_without_api_prefix(self):
        for prefix in ("", "/api"):
            for target in ("codex", "doubao", "clipboard"):
                with self.subTest(prefix=prefix, target=target):
                    request = types.SimpleNamespace(path=f"{prefix}/xzg/{target}/" + ("files" if target == "clipboard" else "attachments"),
                        json=unittest.mock.AsyncMock(return_value={"filenames": ["a.mp4"], "kind": "video"}))
                    bridge._upload_lock = asyncio.Lock()
                    handler = {"doubao": bridge.doubao_attachments, "codex": bridge.codex_attachments, "clipboard": bridge.clipboard_files}[target]
                    with patch.object(bridge, "is_local_clipboard_request", return_value=True), \
                            patch.object(bridge, "resolve_media_files", return_value=["a.mp4"]), \
                            patch.object(bridge, "add_codex_attachments", return_value={"ok": True, "pasted": False}) as upload:
                        response = await handler(request)
                    self.assertEqual(response.status, 200)
                    upload.assert_called_once_with(["a.mp4"], target)

    async def test_clipboard_saved_video_token_and_expired_token(self):
        request = types.SimpleNamespace(path="/xzg/clipboard/files",
            json=unittest.mock.AsyncMock(return_value={"filenames": ["clip.mp4"], "kind": "video", "abs_token": "registered"}))
        bridge._upload_lock = asyncio.Lock()
        with patch.object(bridge, "is_local_clipboard_request", return_value=True), \
                patch.object(bridge, "_lookup_abs_token", return_value=None), \
                patch.object(bridge, "add_codex_attachments") as upload:
            response = await bridge.clipboard_files(request)
            self.assertEqual(response.status, 400)
            upload.assert_not_called()
        with patch.object(bridge, "is_local_clipboard_request", return_value=True), \
                patch.object(bridge, "_lookup_abs_token", return_value=str(ROOT / "saved.mp4")), \
                patch.object(Path, "is_file", return_value=True), \
                patch.object(bridge, "add_codex_attachments", return_value={"ok": True}) as upload:
            response = await bridge.clipboard_files(request)
            self.assertEqual(response.status, 200)
            upload.assert_called_once_with([str((ROOT / "saved.mp4").resolve())], "clipboard")

    async def test_busy_request_is_not_queued_for_later_chat(self):
        request = types.SimpleNamespace(path="/xzg/codex/attachments", json=unittest.mock.AsyncMock(return_value={"filenames": ["a.png"], "kind": "image"}))
        bridge._upload_lock = asyncio.Lock()
        async with bridge._upload_lock:
            with patch.object(bridge, "is_local_clipboard_request", return_value=True), \
                    patch.object(bridge, "resolve_media_files", return_value=["a.png"]), \
                    patch.object(bridge, "add_codex_attachments") as upload:
                response = await bridge.codex_attachments(request)
        self.assertEqual(response.status, 409)
        upload.assert_not_called()


if __name__ == "__main__":
    unittest.main()
