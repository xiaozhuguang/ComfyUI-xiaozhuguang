import os
import io
import hashlib
import torch
import numpy as np
from PIL import Image, ImageOps
import folder_paths
import node_helpers
from aiohttp import web
from server import PromptServer

routes = PromptServer.instance.routes

_thumb_cache_dir = None
DEFAULT_THUMB_SIZE = 256


def _get_thumb_cache_dir():
    global _thumb_cache_dir
    if _thumb_cache_dir is None:
        _thumb_cache_dir = os.path.join(folder_paths.get_temp_directory(), "xzg_thumbs")
        os.makedirs(_thumb_cache_dir, exist_ok=True)
    return _thumb_cache_dir


def _get_thumb_cache_key(filename, size):
    try:
        filename = _normalize_annotated_filename(filename)
        fpath = folder_paths.get_annotated_filepath(filename)
        if not fpath or not os.path.isfile(fpath):
            return None
        mtime = str(os.path.getmtime(fpath))
        fsize = str(os.path.getsize(fpath))
        raw = f"{filename}_{size}_{mtime}_{fsize}"
        return hashlib.md5(raw.encode('utf-8')).hexdigest() + ".jpg"
    except Exception:
        return None


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".svg"}


def _normalize_annotated_filename(name: str) -> str:
    if not name:
        return name
    for suffix in ("[output]", "[input]", "[temp]"):
        spaced = " " + suffix
        if name.endswith(suffix) and not name.endswith(spaced):
            return name[: -len(suffix)] + spaced
    return name


@routes.get("/xzg_input_files")
async def xzg_input_files(request):
    input_dir = folder_paths.get_input_directory()
    if not os.path.isdir(input_dir):
        return web.json_response([])

    files = []
    try:
        for f in os.listdir(input_dir):
            full_path = os.path.join(input_dir, f)
            if os.path.isfile(full_path):
                ext = os.path.splitext(f)[1].lower()
                if ext in IMAGE_EXTENSIONS:
                    stat = os.stat(full_path)
                    files.append({
                        "name": f,
                        "type": "image",
                        "size": stat.st_size,
                        "mtime": stat.st_mtime,
                    })
    except Exception as e:
        return web.Response(status=500, text=str(e))

    files.sort(key=lambda x: x["name"].lower())
    return web.json_response(files)


@routes.get("/xzg_output_files")
async def xzg_output_files(request):
    output_dir = folder_paths.get_output_directory()
    if not os.path.isdir(output_dir):
        return web.json_response([])

    files = []
    try:
        for root, dirs, fnames in os.walk(output_dir):
            for f in fnames:
                ext = os.path.splitext(f)[1].lower()
                if ext in IMAGE_EXTENSIONS:
                    full_path = os.path.join(root, f)
                    rel_path = os.path.relpath(full_path, output_dir)
                    stat = os.stat(full_path)
                    files.append({
                        "name": rel_path.replace("\\", "/"),
                        "type": "image",
                        "size": stat.st_size,
                        "mtime": stat.st_mtime,
                    })
    except Exception as e:
        return web.Response(status=500, text=str(e))

    files.sort(key=lambda x: x["name"].lower())
    return web.json_response(files)


@routes.get("/xzg_image_loader_thumb")
async def xzg_image_loader_thumb(request):
    filename = request.rel_url.query.get("filename", "")
    size = int(request.rel_url.query.get("size", str(DEFAULT_THUMB_SIZE)))

    if not filename:
        return web.Response(status=400, text="filename required")

    filename = _normalize_annotated_filename(filename)
    image_path = folder_paths.get_annotated_filepath(filename)
    if not image_path or not os.path.isfile(image_path):
        return web.Response(status=404, text="image not found")

    cache_dir = _get_thumb_cache_dir()
    cache_key = _get_thumb_cache_key(filename, size)
    cache_path = os.path.join(cache_dir, cache_key) if cache_key else None

    etag = cache_key or None
    if_none_match = request.headers.get("If-None-Match", "")
    if etag and if_none_match == etag:
        return web.Response(status=304)

    if cache_path and os.path.isfile(cache_path):
        try:
            with open(cache_path, "rb") as f:
                data = f.read()
            headers = {"Cache-Control": "no-cache"}
            if etag:
                headers["ETag"] = etag
            return web.Response(
                body=data,
                content_type="image/jpeg",
                headers=headers,
            )
        except Exception:
            pass

    try:
        img = node_helpers.pillow(Image.open, image_path)
        img = ImageOps.exif_transpose(img)
        if img.mode != "RGB":
            img = img.convert("RGB")

        img.thumbnail((size, size), Image.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90, optimize=False)
        buf.seek(0)
        data = buf.getvalue()

        if cache_path:
            try:
                with open(cache_path, "wb") as f:
                    f.write(data)
            except Exception:
                pass

        headers = {"Cache-Control": "no-cache"}
        if etag:
            headers["ETag"] = etag
        return web.Response(
            body=data,
            content_type="image/jpeg",
            headers=headers,
        )
    except Exception as e:
        return web.Response(status=500, text=str(e))


@routes.post("/xzg_delete_images")
async def xzg_delete_images(request):
    try:
        data = await request.json()
    except Exception:
        return web.Response(status=400, text="invalid json")

    filenames = data.get("files", [])
    source = data.get("source", "input")

    if source not in ("input", "output"):
        return web.Response(status=400, text="invalid source")

    if source == "input":
        base_dir = folder_paths.get_input_directory()
    else:
        base_dir = folder_paths.get_output_directory()

    deleted = []
    errors = []

    for fn in filenames:
        try:
            if not fn:
                continue
            fn_clean = fn
            for suffix in (" [input]", " [output]", " [temp]"):
                if fn_clean.endswith(suffix):
                    fn_clean = fn_clean[: -len(suffix)]
                    break

            full_path = os.path.normpath(os.path.join(base_dir, fn_clean))
            if not full_path.startswith(os.path.normpath(base_dir)):
                errors.append(f"{fn}: path traversal")
                continue
            if not os.path.isfile(full_path):
                errors.append(f"{fn}: not found")
                continue
            os.remove(full_path)
            deleted.append(fn)
        except Exception as e:
            errors.append(f"{fn}: {e}")

    return web.json_response({"deleted": deleted, "errors": errors})


@routes.post("/xzg_copy_output_to_input")
async def xzg_copy_output_to_input(request):
    try:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"copied": [], "errors": ["invalid json"]}, status=400)

        filenames = data.get("files", [])
        output_dir = folder_paths.get_output_directory()
        input_dir = folder_paths.get_input_directory()

        copied = []
        errors = []

        import shutil

        for fn in filenames:
            try:
                if not fn:
                    continue

                src_path = os.path.normpath(os.path.join(output_dir, fn))
                if not src_path.startswith(os.path.normpath(output_dir)):
                    errors.append(f"{fn}: path traversal")
                    continue
                if not os.path.isfile(src_path):
                    errors.append(f"{fn}: not found")
                    continue

                basename = os.path.basename(fn)
                dst_name = basename
                dst_path = os.path.join(input_dir, dst_name)

                if os.path.exists(dst_path):
                    copied.append({"original": fn, "input_name": dst_name})
                    continue

                shutil.copy2(src_path, dst_path)
                copied.append({"original": fn, "input_name": dst_name})
            except Exception as e:
                errors.append(f"{fn}: {e}")

        return web.json_response({"copied": copied, "errors": errors})
    except Exception as e:
        return web.json_response({"copied": [], "errors": [str(e)]}, status=500)


class XiaozhuguangImageLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_list": ("STRING", {"default": ""}),
                "index": ("INT", {"default": 0, "min": 0, "max": 999999}),
                "batch_mode": ("BOOLEAN", {"default": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "load_images"
    CATEGORY = "xiaozhuguang"

    def load_images(self, image_list, index, batch_mode, unique_id=None):
        if not image_list or not image_list.strip():
            return ([],)

        names = [n.strip() for n in image_list.split("\n") if n.strip()]
        if not names:
            return ([],)

        images = []
        for name in names:
            try:
                name_norm = _normalize_annotated_filename(name)
                image_path = folder_paths.get_annotated_filepath(name_norm)
                if not image_path or not os.path.isfile(image_path):
                    continue

                img = node_helpers.pillow(Image.open, image_path)
                img = ImageOps.exif_transpose(img)
                image = img.convert("RGB")
                image = np.array(image).astype(np.float32) / 255.0
                image = torch.from_numpy(image)[None,]
                images.append(image)
            except Exception:
                continue

        if batch_mode:
            if len(images) == 0:
                return ([],)

            max_h = max(img.shape[1] for img in images)
            max_w = max(img.shape[2] for img in images)

            resized = []
            for img in images:
                _, h, w, _ = img.shape

                if h == max_h and w == max_w:
                    resized.append(img)
                    continue

                scale = max(max_h / h, max_w / w)
                new_h = int(round(h * scale))
                new_w = int(round(w * scale))

                img_pil = Image.fromarray((img[0].numpy() * 255).astype(np.uint8))
                img_pil = img_pil.resize((new_w, new_h), Image.LANCZOS)

                left = (new_w - max_w) // 2
                top = (new_h - max_h) // 2
                img_pil = img_pil.crop((left, top, left + max_w, top + max_h))

                arr = np.array(img_pil).astype(np.float32) / 255.0
                tensor = torch.from_numpy(arr)[None,]
                resized.append(tensor)

            batch = torch.cat(resized, dim=0)
            return ([batch],)
        else:
            return (images,)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangImageLoader": XiaozhuguangImageLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangImageLoader": "小珠光图片加载器",
}
