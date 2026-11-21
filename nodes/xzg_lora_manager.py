"""Local LoRA library, portable metadata archive, and native ComfyUI loader."""
import asyncio
import io
import ipaddress
import json
import math
import os
import shutil
from pathlib import Path
import tempfile
import threading
import uuid
import zipfile
from urllib.parse import urlsplit

from aiohttp import web
from PIL import Image
import comfy.sd
import comfy.utils
import folder_paths
from server import PromptServer


LOCK = threading.RLock()
FIELDS = ("notes", "tags", "triggers", "favorite", "strength_model")


def library_dir(user):
    if not isinstance(user, str) or not user or any(c in user for c in "/\\:") or user in (".", ".."):
        raise ValueError("无效用户")
    root = folder_paths.get_public_user_directory(user)
    if root is None:
        raise ValueError("无效用户")
    target = Path(folder_paths.get_user_directory()) / "xiaozhuguang" / "lora_manager"
    legacy = Path(root) / "xiaozhuguang" / "lora_manager"
    with LOCK:
        if not (target / "library.json").exists() and (legacy / "library.json").is_file():
            target.mkdir(parents=True, exist_ok=True)
            if (legacy / "thumbnails").is_dir():
                shutil.copytree(legacy / "thumbnails", target / "thumbnails", dirs_exist_ok=True)
            shutil.copy2(legacy / "library.json", target / "library.json")
    return target


def read_library(user):
    path = library_dir(user) / "library.json"
    if not path.exists():
        return {"version": 1, "items": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def write_library(user, data):
    root = library_dir(user)
    root.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=root, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
        os.replace(temporary, root / "library.json")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def roots():
    paths = folder_paths.get_folder_paths("loras")
    pod_root = Path("/poddata/ComfyUI/models/loras")
    if os.name != "nt" and pod_root.is_dir():
        paths = [*paths, pod_root]
    return list(dict.fromkeys(str(Path(p).resolve()) for p in paths))


def model_path(root, relative):
    if (not isinstance(relative, str) or "\\" in relative or ":" in relative
            or Path(relative).is_absolute() or ".." in Path(relative).parts):
        raise ValueError("请使用模型目录内的相对路径")
    return Path(root) / relative


def inside(root, relative):
    path = model_path(root, relative).resolve()
    if not path.is_relative_to(Path(root).resolve()):
        raise ValueError("路径超出 LoRA 目录")
    return path


def scan(user):
    with LOCK:
        data = read_library(user)
        by_path = {(x["root"], x["path"]): (key, x) for key, x in data["items"].items()}
        present, directories = set(), []
        extensions = folder_paths.folder_names_and_paths["loras"][1]
        changed = False
        def scan_error(error):
            raise error
        for root in roots():
            if not Path(root).is_dir():
                continue
            directories.append({"root": root, "path": ""})
            ancestors_by_dir = {Path(root): set()}
            for current, dirs, files in os.walk(root, followlinks=True, onerror=scan_error):
                directory = Path(current)
                ancestors = ancestors_by_dir.pop(directory) | {directory.resolve()}
                dirs[:] = sorted(d for d in dirs if (directory / d).resolve() not in ancestors)
                for child in dirs:
                    ancestors_by_dir[directory / child] = ancestors
                if directory != Path(root):
                    directories.append({"root": root, "path": directory.relative_to(root).as_posix()})
                for filename in sorted(files):
                    path = directory / filename
                    if path.suffix.lower() not in extensions or not path.is_file():
                        continue
                    relative = path.relative_to(root).as_posix()
                    key, item = by_path.get((root, relative), (None, None))
                    if key is None:
                        key = uuid.uuid4().hex
                        item = {"root": root, "path": relative}
                        data["items"][key] = item
                        changed = True
                    present.add(key)
        removed = set(data["items"]) - present
        for key in removed:
            del data["items"][key]
        image_dir = library_dir(user) / "thumbnails"
        for key, item in data["items"].items():
            if item.get("thumbnail") and not (image_dir / (key + ".png")).is_file():
                del item["thumbnail"]
                changed = True
        if changed or removed:
            write_library(user, data)
        if image_dir.is_dir():
            for image in image_dir.glob("*.png"):
                if image.stem not in data["items"]:
                    image.unlink()
        items = [{**item, "id": key, "exists": key in present} for key, item in data["items"].items()]
        return {"items": items, "directories": directories, "user": user, "storage": str(library_dir(user))}


def clean_metadata(value):
    result = {}
    for field in FIELDS:
        if field not in value:
            continue
        v = value[field]
        if field == "strength_model":
            v = float(v)
            if not math.isfinite(v):
                raise ValueError("强度必须是有限数字")
        elif field == "favorite":
            if not isinstance(v, bool):
                raise ValueError("收藏状态无效")
        elif not isinstance(v, str):
            raise ValueError("资料内容必须为文本")
        result[field] = v
    return result


def thumbnail_bytes(raw):
    if len(raw) > 20 * 1024 * 1024:
        raise ValueError("缩略图不能超过 20 MB")
    with Image.open(io.BytesIO(raw)) as image:
        image.thumbnail((512, 512))
        output = io.BytesIO()
        image.convert("RGBA").save(output, "PNG")
        return output.getvalue()


def export_library(user):
    with LOCK:
        data = read_library(user)
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("library.json", json.dumps(data, ensure_ascii=False))
            for key, item in data["items"].items():
                if item.get("thumbnail"):
                    image = library_dir(user) / "thumbnails" / (key + ".png")
                    if image.exists():
                        archive.write(image, "thumbnails/" + key + ".png")
        return output.getvalue()


def import_library(user, raw, replace=False, dry_run=False):
    with LOCK, zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        if len(entries) > 20000 or sum(x.file_size for x in entries) > 512 * 1024 * 1024:
            raise ValueError("备份包过大")
        incoming = json.loads(archive.read("library.json"))
        if incoming.get("version") != 1 or not isinstance(incoming.get("items"), dict):
            raise ValueError("不支持的备份格式")
        current = read_library(user)
        data = {"version": 1, "items": {}} if replace else json.loads(json.dumps(current))
        by_path = {(x["root"], x["path"]): key for key, x in current["items"].items()}
        images = {}
        for old_key, value in incoming["items"].items():
            root, relative = value["root"], value["path"]
            if not isinstance(root, str) or not isinstance(relative, str):
                raise ValueError("文件关联无效")
            model_path(root, relative)
            valid_key = isinstance(old_key, str) and len(old_key) == 32 and all(c in "0123456789abcdef" for c in old_key)
            key = by_path.get((root, relative)) or (old_key if valid_key and old_key not in data["items"] else uuid.uuid4().hex)
            item = {"root": root, "path": relative, **clean_metadata(value)}
            if value.get("thumbnail"):
                if not isinstance(old_key, str) or not old_key.isalnum():
                    raise ValueError("缩略图标识无效")
                images[key] = thumbnail_bytes(archive.read("thumbnails/" + old_key + ".png"))
                item["thumbnail"] = True
            data["items"][key] = item
        if dry_run:
            return len(incoming["items"])
        # Validate all records and images before modifying the live library.
        image_dir = library_dir(user) / "thumbnails"
        image_dir.mkdir(parents=True, exist_ok=True)
        for key, content in images.items():
            (image_dir / (key + ".png")).write_bytes(content)
        write_library(user, data)
        return len(incoming["items"])


def file_operation(user, body):
    with LOCK:
        root = body["root"]
        if root not in roots():
            raise ValueError("未知 LoRA 根目录")
        action = body["action"]
        source = inside(root, body.get("path", ""))
        target = inside(root, body["target"])
        if target.exists():
            raise ValueError("目标已存在，请换一个名称")
        if action != "move" or source == Path(root).resolve() or not source.exists():
            raise ValueError("无效的移动操作")
        if target.is_relative_to(source):
            raise ValueError("不能将文件夹移动到自身内部")
        if not target.parent.is_dir():
            raise ValueError("目标父文件夹不存在")
        data = read_library(user)
        old, new = source.relative_to(root).as_posix(), target.relative_to(root).as_posix()
        for item in data["items"].values():
            if item["root"] == root and (item["path"] == old or item["path"].startswith(old + "/")):
                item["path"] = new + item["path"][len(old):]
        source.rename(target)
        try:
            write_library(user, data)
        except OSError:
            target.rename(source)
            raise


def request_user(request):
    return PromptServer.instance.user_manager.get_request_user_id(request)


def open_directory(user, key):
    with LOCK:
        item = read_library(user)["items"][key]
        if item["root"] not in roots():
            raise ValueError("LoRA 根目录未配置")
        path = model_path(item["root"], item["path"])
        if not path.is_file():
            raise ValueError("LoRA 文件不存在，请刷新列表")
    if os.name != "nt":
        raise ValueError("打开系统目录目前仅支持 Windows 本机运行")
    os.startfile(str(path.parent))


def clear_maintenance(user):
    with LOCK:
        data = read_library(user)
        data["items"] = {key: {"root": item["root"], "path": item["path"]} for key, item in data["items"].items()}
        write_library(user, data)
        image_dir = library_dir(user) / "thumbnails"
        if image_dir.is_dir():
            for image in image_dir.glob("*.png"):
                image.unlink()
        return len(data["items"])


async def handle(request, callback):
    try:
        return await callback()
    except (ValueError, KeyError, OSError, zipfile.BadZipFile) as error:
        return web.json_response({"error": str(error)}, status=400)


routes = PromptServer.instance.routes


@routes.get("/xzg/lora/library")
async def get_library(request):
    async def run():
        result = await asyncio.to_thread(scan, request_user(request))
        return web.json_response(result)
    return await handle(request, run)


@routes.post("/xzg/lora/metadata")
async def save_metadata(request):
    async def run():
        user, body = request_user(request), await request.json()
        with LOCK:
            data = read_library(user)
            data["items"][body["id"]].update(clean_metadata(body))
            write_library(user, data)
        return web.json_response({"ok": True})
    return await handle(request, run)


@routes.post("/xzg/lora/clear-maintenance")
async def clear_all_maintenance(request):
    async def run():
        body = await request.json()
        if body.get("confirm") is not True:
            raise ValueError("请先确认清理维护资料")
        count = await asyncio.to_thread(clear_maintenance, request_user(request))
        return web.json_response({"ok": True, "count": count})
    return await handle(request, run)


@routes.get("/xzg/lora/triggers/{id}")
async def get_triggers(request):
    async def run():
        with LOCK:
            item = read_library(request_user(request))["items"][request.match_info["id"]]
            return web.json_response({"triggers": item.get("triggers", "")})
    return await handle(request, run)


@routes.post("/xzg/lora/open-directory")
async def open_model_directory(request):
    async def run():
        origin = urlsplit(request.headers.get("Origin", ""))
        if not ipaddress.ip_address(request.remote).is_loopback or origin.scheme not in ("http", "https") or origin.netloc != request.host:
            raise ValueError("请从本机 ComfyUI 页面打开系统目录")
        body = await request.json()
        await asyncio.to_thread(open_directory, request_user(request), body["id"])
        return web.json_response({"ok": True})
    return await handle(request, run)


@routes.post("/xzg/lora/thumbnail/{id}")
async def upload_thumbnail(request):
    async def run():
        user, key = request_user(request), request.match_info["id"]
        reader = await request.multipart()
        part = await reader.next()
        if part is None:
            raise ValueError("请选择图片")
        raw = bytearray()
        while chunk := await part.read_chunk():
            raw.extend(chunk)
            if len(raw) > 20 * 1024 * 1024:
                raise ValueError("缩略图不能超过 20 MB")
        content = thumbnail_bytes(raw)
        with LOCK:
            data = read_library(user)
            item = data["items"][key]
            directory = library_dir(user) / "thumbnails"
            directory.mkdir(parents=True, exist_ok=True)
            (directory / (key + ".png")).write_bytes(content)
            item["thumbnail"] = True
            write_library(user, data)
        return web.json_response({"ok": True})
    return await handle(request, run)


@routes.get("/xzg/lora/thumbnail/{id}")
async def get_thumbnail(request):
    user, key = request_user(request), request.match_info["id"]
    with LOCK:
        data = read_library(user)
        item = data["items"].get(key)
        if item is None:
            raise web.HTTPNotFound()
        path = library_dir(user) / "thumbnails" / (key + ".png")
        if not path.is_file():
            if item.pop("thumbnail", None):
                write_library(user, data)
            raise web.HTTPNotFound()
    return web.FileResponse(path)


@routes.post("/xzg/lora/thumbnail/{id}/delete")
async def delete_thumbnail(request):
    async def run():
        user, key = request_user(request), request.match_info["id"]
        with LOCK:
            data = read_library(user)
            item = data["items"][key]
            path = library_dir(user) / "thumbnails" / (key + ".png")
            path.unlink(missing_ok=True)
            if item.pop("thumbnail", None) is not None:
                write_library(user, data)
        return web.json_response({"ok": True})
    return await handle(request, run)


@routes.post("/xzg/lora/files")
async def manage_files(request):
    async def run():
        body = await request.json()
        await asyncio.to_thread(file_operation, request_user(request), body)
        return web.json_response({"ok": True})
    return await handle(request, run)


class XiaozhuguangLoraManager:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "loras": ("STRING", {"default": "[]", "multiline": True}), "library_user": ("STRING", {"default": "default"})}}

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("MODEL",)
    FUNCTION = "load"
    CATEGORY = "小珠光/模型"
    DESCRIPTION = "打开管理器选择多个 LoRA。资料与缩略图保存在当前用户目录，支持手动导入导出。"

    @classmethod
    def IS_CHANGED(cls, loras="[]", library_user="default", **kwargs):
        # ComfyUI cannot resolve linked widget values when computing this key.
        if loras is None or library_user is None:
            return float("nan")
        fingerprint = []
        for path, strength in cls._active_loras(loras, library_user, **kwargs):
            info = path.stat()
            fingerprint.append((str(path), strength, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino))
        return tuple(fingerprint)

    @staticmethod
    def _active_loras(loras, library_user, **kwargs):
        selections = json.loads(loras)
        if not isinstance(selections, list):
            raise ValueError("LoRA 列表格式无效")
        mode = kwargs.get("xzg_lora_mode", kwargs.get("lora_mode", "serial"))
        if mode not in ("serial", "parallel"):
            mode = "serial"
        if mode == "parallel":
            selections = [selection for selection in selections if selection.get("enabled", True)][:1]
        records = {}
        if any(selection.get("id") and selection.get("enabled", True) for selection in selections):
            with LOCK:
                records = read_library(library_user)["items"]
        configured_roots = roots()
        extensions = folder_paths.folder_names_and_paths["loras"][1]
        for selection in selections:
            if not selection.get("enabled", True):
                continue
            item = records.get(selection.get("id"))
            relative = item["path"] if item is not None else selection.get("path")
            root = item["root"] if item is not None else selection.get("root")
            if root is not None and root not in configured_roots:
                raise ValueError(f"LoRA 所属根目录未配置，请重新选择：{relative}")
            if not relative:
                raise ValueError("LoRA 记录已失效且缺少文件路径，请打开管理器重新选择")
            candidates = (model_path(base, relative) for base in ([root] if root is not None else configured_roots))
            matches = {path.resolve() for path in candidates if path.suffix.lower() in extensions and path.is_file()}
            if not matches:
                raise ValueError(f"LoRA 文件不存在或格式不支持：{relative}")
            if len(matches) > 1:
                raise ValueError(f"多个 LoRA 根目录中存在相同相对路径，请打开管理器重新选择：{relative}")
            path = matches.pop()
            sm = float(selection.get("strength_model", 1))
            if not math.isfinite(sm):
                raise ValueError("LoRA 强度必须是有限数字")
            if sm == 0:
                continue
            yield path, sm

    def load(self, model, loras="[]", library_user="default", **kwargs):
        for path, strength in self._active_loras(loras, library_user, **kwargs):
            weights = comfy.utils.load_torch_file(str(path), safe_load=True)
            model, _ = comfy.sd.load_lora_for_models(model, None, weights, strength, 0)
        return (model,)
