"""Exercise real metadata/files/archive behavior without loading GPU libraries."""
import importlib.util
import ast
import asyncio
import contextlib
import io
import json
from pathlib import Path
import sys
import shutil
import uuid
import types
import unittest
from unittest.mock import patch
import zipfile

from PIL import Image


class Routes:
    def get(self, path):
        return lambda fn: fn

    post = get


class LoraManagerTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(__file__).resolve().parent / ("lora-test-" + uuid.uuid4().hex)
        self.base.mkdir()
        self.addCleanup(shutil.rmtree, self.base)
        self.models = self.base / "loras"
        self.models.mkdir()
        fp = types.ModuleType("folder_paths")
        fp.get_public_user_directory = lambda user: str(self.base / "user" / user) if not user.startswith("__") else None
        fp.get_folder_paths = lambda kind: [str(self.models)]
        fp.folder_names_and_paths = {"loras": ([str(self.models)], {".safetensors"})}
        comfy = types.ModuleType("comfy")
        comfy.sd = types.ModuleType("comfy.sd")
        comfy.utils = types.ModuleType("comfy.utils")
        self.loaded = []
        comfy.utils.load_torch_file = lambda path, **kwargs: self.loaded.append(path) or {}
        comfy.sd.load_lora_for_models = lambda model, clip, weights, sm, sc: (model + sm, clip)
        server = types.ModuleType("server")
        server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=Routes()))
        modules = {"folder_paths": fp, "comfy": comfy, "comfy.sd": comfy.sd, "comfy.utils": comfy.utils, "server": server}
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location("lora_manager_test", Path(__file__).resolve().parents[1] / "nodes/xzg_lora_manager.py")
            self.m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.m)
        (self.models / "测试长名称.safetensors").write_bytes(b"test")
        self.item = self.m.scan("default")["items"][0]

    def test_missing_file_removes_metadata_and_thumbnail(self):
        data = self.m.read_library("default")
        data["items"][self.item["id"]].update(notes="自己的备注", tags="人物,写实", thumbnail=True)
        self.m.write_library("default", data)
        image_dir = self.m.library_dir("default") / "thumbnails"
        image_dir.mkdir()
        thumbnail = image_dir / (self.item["id"] + ".png")
        thumbnail.write_bytes(b"preview")
        self.assertEqual(self.m.scan("default")["items"][0]["notes"], "自己的备注")
        self.assertTrue(thumbnail.exists())
        (self.models / self.item["path"]).unlink()
        self.assertEqual(self.m.scan("default")["items"], [])
        self.assertEqual(self.m.read_library("default")["items"], {})
        self.assertFalse(thumbnail.exists())

    def test_move_folder_keeps_id_and_loader_resolves_new_path(self):
        (self.models / "人物").mkdir()
        self.m.file_operation("default", {"action": "move", "root": str(self.models), "path": self.item["path"], "target": "人物/测试长名称.safetensors"})
        self.m.file_operation("default", {"action": "move", "root": str(self.models), "path": "人物", "target": "角色"})
        items = self.m.scan("default")["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], self.item["id"])
        result = self.m.XiaozhuguangLoraManager().load(0, json.dumps([{"id": self.item["id"], "strength_model": .7}]))
        self.assertEqual(result, (.7,))
        self.assertIn("角色", self.loaded[0])

    def test_loader_applies_model_only(self):
        with patch.object(self.m.comfy.sd, "load_lora_for_models", return_value=("model-out", "clip-out")) as load:
            result = self.m.XiaozhuguangLoraManager().load("model", json.dumps([
                {"id": self.item["id"], "strength_model": .6, "strength_clip": .2}
            ]))
            self.assertEqual(result, ("model-out",))
            self.assertIsNone(load.call_args.args[1])
            self.assertEqual(load.call_args.args[-2:], (.6, 0))
            self.assertEqual(self.m.XiaozhuguangLoraManager.RETURN_TYPES, ("MODEL",))

    def test_conflict_and_escape_leave_files_untouched(self):
        (self.models / "other.safetensors").write_bytes(b"other")
        for target in ("../escape.safetensors", "other.safetensors"):
            with self.assertRaises(ValueError):
                self.m.file_operation("default", {"action": "move", "root": str(self.models), "path": self.item["path"], "target": target})
        self.assertTrue((self.models / self.item["path"]).exists())
        self.assertEqual((self.models / "other.safetensors").read_bytes(), b"other")

    def test_archive_roundtrip_with_thumbnail(self):
        output = io.BytesIO()
        Image.new("RGB", (32, 20), "red").save(output, "PNG")
        root = self.m.library_dir("default")
        (root / "thumbnails").mkdir()
        (root / "thumbnails" / (self.item["id"] + ".png")).write_bytes(output.getvalue())
        data = self.m.read_library("default")
        data["items"][self.item["id"]].update(notes="保留我", thumbnail=True)
        self.m.write_library("default", data)
        archive = self.m.export_library("default")
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            self.assertEqual(len(z.namelist()), 2)
            self.assertFalse(any(x.endswith("safetensors") for x in z.namelist()))
        self.m.import_library("default", archive, replace=True)
        self.assertIn(self.item["id"], self.m.read_library("default")["items"])
        self.m.import_library("other-user", archive)
        imported = self.m.scan("other-user")["items"][0]
        self.assertEqual(imported["notes"], "保留我")
        self.assertTrue((self.m.library_dir("other-user") / "thumbnails" / (imported["id"] + ".png")).exists())

    def test_bad_import_does_not_replace_library(self):
        original = self.m.read_library("default")
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("library.json", json.dumps({"version": 1, "items": {"abc": {"root": str(self.models), "path": "../escape", "notes": "bad"}}}))
        with self.assertRaises(ValueError):
            self.m.import_library("default", output.getvalue(), replace=True)
        self.assertEqual(self.m.read_library("default"), original)

    def test_external_rename_cleans_old_record(self):
        old = self.models / self.item["path"]
        old.rename(self.models / "renamed.safetensors")
        items = self.m.scan("default")["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["path"], "renamed.safetensors")
        self.assertNotEqual(items[0]["id"], self.item["id"])

    def test_open_directory_uses_registered_model_parent(self):
        with patch.object(self.m.os, "startfile", create=True) as launch:
            self.m.open_directory("default", self.item["id"])
            launch.assert_called_once_with(str(self.models))
            launch.reset_mock()
            data = self.m.read_library("default")
            data["items"][self.item["id"]]["path"] = "../outside.safetensors"
            self.m.write_library("default", data)
            with self.assertRaises(ValueError):
                self.m.open_directory("default", self.item["id"])
            launch.assert_not_called()

    def test_clear_maintenance_preserves_models_and_record_ids(self):
        data = self.m.read_library("default")
        data["items"][self.item["id"]].update(notes="备注", tags="美女", triggers="trigger", favorite=True, thumbnail=True, strength_model=.5)
        self.m.write_library("default", data)
        directory = self.m.library_dir("default") / "thumbnails"
        directory.mkdir()
        (directory / (self.item["id"] + ".png")).write_bytes(b"preview")
        self.assertEqual(self.m.clear_maintenance("default"), 1)
        record = self.m.read_library("default")["items"][self.item["id"]]
        self.assertEqual(record, {"root": str(self.models), "path": self.item["path"]})
        self.assertEqual(list(directory.iterdir()), [])
        self.assertEqual((self.models / self.item["path"]).read_bytes(), b"test")
        self.assertEqual(self.m.scan("default")["items"][0]["id"], self.item["id"])

    def test_triggers_and_clear_http_handlers(self):
        async def run():
            self.m.PromptServer.instance.user_manager = types.SimpleNamespace(get_request_user_id=lambda request: "default")
            data = self.m.read_library("default")
            data["items"][self.item["id"]]["triggers"] = "美女, FLUX"
            self.m.write_library("default", data)
            response = await self.m.get_triggers(types.SimpleNamespace(match_info={"id": self.item["id"]}))
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.text)["triggers"], "美女, FLUX")
            async def cancel():
                return {"confirm": False}
            response = await self.m.clear_all_maintenance(types.SimpleNamespace(json=cancel))
            self.assertEqual(response.status, 400)
            self.assertEqual(self.m.read_library("default")["items"][self.item["id"]]["triggers"], "美女, FLUX")
            async def confirm():
                return {"confirm": True}
            response = await self.m.clear_all_maintenance(types.SimpleNamespace(json=confirm))
            self.assertEqual(response.status, 200)
            self.assertNotIn("triggers", self.m.read_library("default")["items"][self.item["id"]])
        asyncio.run(run())

    def archive_functions(self):
        source = Path(__file__).resolve().parents[1] / "nodes/xzg_image_loader.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        names = {"_media_build_archive", "_media_archive_config", "_media_read_archive"}
        tree.body = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        namespace = {"__package__": "nodes", "zipfile": zipfile, "json": json, "os": __import__("os"),
                     "MEDIA_ARCHIVE_LIBRARIES": (), "MEDIA_ARCHIVE_MAX_BYTES": 20 * 1024**3,
                     "MEDIA_CONFIG_MAX_BYTES": 100 * 1024**2,
                     "_media_library_dir": lambda: str(self.base / "media"),
                     "tempfile": types.SimpleNamespace(TemporaryDirectory=self.staging_directory)}
        exec(compile(tree, str(source), "exec"), namespace)
        return namespace

    @contextlib.contextmanager
    def staging_directory(self, **kwargs):
        path = self.base / ("stage-" + uuid.uuid4().hex)
        path.mkdir()
        try:
            yield str(path)
        finally:
            shutil.rmtree(path)

    def test_unified_archive_selected_roundtrip_and_unchecked(self):
        f = self.archive_functions()
        config = {"format": "xiaozhuguang-config", "version": 11, "loraLibrary": {}}
        path = self.base / "unified.zip"
        data = self.m.read_library("default")
        data["items"][self.item["id"]]["notes"] = "统一备份"
        self.m.write_library("default", data)
        with patch.dict(sys.modules, {"nodes.xzg_lora_manager": self.m}):
            f["_media_build_archive"](str(path), config, "default")
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(set(archive.namelist()), {"config.json", "lora_library.zip"})
            checked = f["_media_read_archive"](str(path), False, "other-user")
            self.assertEqual(checked["loraLibrary"]["count"], 1)
            self.assertFalse(self.m.library_dir("other-user").exists())
            with self.assertRaises(ValueError):
                f["_media_read_archive"](str(path), {"loraLibrary": False}, "other-user")
            self.assertFalse(self.m.library_dir("other-user").exists())
            result = f["_media_read_archive"](str(path), {"loraLibrary": True}, "other-user")
            self.assertEqual(result["restoredLoras"], 1)
            self.assertEqual(self.m.read_library("other-user")["items"][self.item["id"]]["notes"], "统一备份")
            f["_media_build_archive"](str(path), {"format": "xiaozhuguang-config", "version": 11}, "default")
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(archive.namelist(), ["config.json"])


if __name__ == "__main__":
    unittest.main()
