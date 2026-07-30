from server import PromptServer

# ---------- 小珠光路由安全装饰器 ----------
import asyncio as _xzg_asyncio
import functools as _xzg_ft
import traceback as _xzg_tb
try:
    from aiohttp import web as _xzg_web
except Exception:
    import types as _xzg_t
    _xzg_web = _xzg_t.ModuleType('aiohttp.web')
    class _R:
        def __init__(self, *a, **kw): pass
    _xzg_web.Response = _R
    _xzg_web.json_response = lambda *a, **kw: {'_json': (a, kw)}
    class _HTTPE(Exception): pass
    _xzg_web.HTTPException = _HTTPE

try:
    from .. import xzg_safe_handler as _xsh, _safe_dir as _xsd
    xzg_safe_handler = _xsh
    _safe_dir = _xsd
except Exception:
    def xzg_safe_handler(fn):
        def _fmt_resp(exc, status=500):
            tb_s = ''.join(_xzg_tb.format_exception(type(exc), exc, exc.__traceback__))
            try:
                return _xzg_web.json_response(
                    {'error': '%s: %s' % (type(exc).__name__, exc), 'traceback': tb_s},
                    status=status,
                )
            except Exception:
                return _xzg_web.Response(status=500, text='%s: %s\n\n%s' % (type(exc).__name__, exc, tb_s))
        if _xzg_asyncio.iscoroutinefunction(fn):
            @_xzg_ft.wraps(fn)
            async def _aw(*a, **kw):
                try:
                    return await fn(*a, **kw)
                except _xzg_web.HTTPException:
                    raise
                except BaseException as e:
                    print('[小珠光路由异常] %s: %s: %s' % (fn.__name__, type(e).__name__, e))
                    _xzg_tb.print_exc()
                    return _fmt_resp(e)
            return _aw
        else:
            @_xzg_ft.wraps(fn)
            def _sw(*a, **kw):
                try:
                    return fn(*a, **kw)
                except _xzg_web.HTTPException:
                    raise
                except BaseException as e:
                    print('[小珠光路由异常] %s: %s: %s' % (fn.__name__, type(e).__name__, e))
                    _xzg_tb.print_exc()
                    return _fmt_resp(e)
            return _sw

    def _safe_dir(fn_name, fallback_subdir):
        import folder_paths as _fp
        d = getattr(_fp, fn_name)()
        if d:
            os.makedirs(d, exist_ok=True)
            return d
        fallback = os.path.join(getattr(_fp, 'models_dir', os.getcwd()), fallback_subdir)
        os.makedirs(fallback, exist_ok=True)
        print('[小珠光] folder_paths.%s() 返回 None，兜底使用: %s' % (fn_name, fallback))
        return fallback
# ---------------- END ----------------
from aiohttp import web
import os
import json
import shutil
import time
import folder_paths


def _xzg_routes():
    """防御性取 PromptServer 路由表（实例未初始化时返回临时兜底，仅装饰器语法不炸）。"""
    inst = getattr(PromptServer, 'instance', None)
    if inst is not None:
        return inst.routes
    class _Fallback:
        def _noop(self, path):
            def deco(fn): return fn
            return deco
        post = put = delete = patch = get = _noop
    return _Fallback()


_xzg_routes_var = _xzg_routes()


def get_workflows_directory():
    user_dir = _safe_dir('get_user_directory',   'user')
    if not user_dir:
        user_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "user")
    default_dir = os.path.join(user_dir, "default")
    workflows_dir = os.path.join(default_dir, "workflows")
    os.makedirs(workflows_dir, exist_ok=True)
    return workflows_dir


def is_safe_path(base_dir, target_path):
    base_dir = os.path.abspath(base_dir)
    target_path = os.path.abspath(target_path)
    return os.path.commonpath([target_path, base_dir]) == base_dir


def build_tree(base_dir, current_dir=""):
    tree = []
    full_dir = os.path.join(base_dir, current_dir) if current_dir else base_dir

    if not os.path.exists(full_dir):
        return tree

    entries = sorted(os.listdir(full_dir), key=lambda x: (not os.path.isdir(os.path.join(full_dir, x)), x))

    for entry in entries:
        # 跳过回收站系统目录（__trash）
        if entry.startswith("__"):
            continue
        entry_path = os.path.join(current_dir, entry) if current_dir else entry
        full_entry_path = os.path.join(full_dir, entry)

        if os.path.isdir(full_entry_path):
            children = build_tree(base_dir, entry_path)
            tree.append({
                "name": entry,
                "path": entry_path.replace("\\", "/"),
                "type": "folder",
                "children": children
            })
        elif entry.endswith(".json"):
            name_without_ext = os.path.splitext(entry)[0]
            file_path = os.path.join(current_dir, name_without_ext) if current_dir else name_without_ext
            tree.append({
                "name": name_without_ext,
                "path": file_path.replace("\\", "/"),
                "type": "workflow"
            })

    return tree


def get_trash_directory():
    """回收站目录，删除的分类/工作流先移入此处，可恢复"""
    d = os.path.join(get_workflows_directory(), "__trash")
    os.makedirs(d, exist_ok=True)
    return d


# 回收站保留时长（天）。超过该时长的项目会在打开回收站时自动清理，不允许手动清空。
TRASH_RETENTION_DAYS = 90


def cleanup_expired_trash():
    """删除回收站中超过保留期（默认 90 天）的项目，避免无限增长。"""
    try:
        trash_dir = get_trash_directory()
        now = time.time()
        for entry in os.listdir(trash_dir):
            item_dir = os.path.join(trash_dir, entry)
            if not os.path.isdir(item_dir):
                continue
            deleted_at = None
            meta_path = os.path.join(item_dir, ".xzg_trash_meta.json")
            if os.path.exists(meta_path):
                try:
                    with open(meta_path, encoding="utf-8") as mf:
                        deleted_at = json.load(mf).get("deleted_at")
                except Exception:
                    pass
            expire_ts = None
            if deleted_at:
                try:
                    expire_ts = time.mktime(time.strptime(deleted_at, "%Y%m%d_%H%M%S"))
                except Exception:
                    expire_ts = None
            if expire_ts is None:
                # 无元数据时以目录修改时间兜底
                try:
                    expire_ts = os.path.getmtime(item_dir)
                except Exception:
                    expire_ts = now
            if now - expire_ts > TRASH_RETENTION_DAYS * 86400:
                shutil.rmtree(item_dir, ignore_errors=True)
    except Exception:
        pass


@_xzg_routes_var.get("/xzg/workflows")
@xzg_safe_handler
async def get_workflows(request):
    workflows_dir = get_workflows_directory()
    tree = build_tree(workflows_dir)
    return web.json_response(tree)


@_xzg_routes_var.get("/xzg/wf-manage/list")
@xzg_safe_handler
async def list_workflows(request):
    workflows_dir = get_workflows_directory()
    tree = build_tree(workflows_dir)
    return web.json_response(tree)


@_xzg_routes_var.post("/xzg/workflows")
@xzg_safe_handler
async def save_workflow(request):
    workflows_dir = get_workflows_directory()

    try:
        json_data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    name = json_data.get("name", "")
    workflow = json_data.get("workflow", {})
    overwrite = json_data.get("overwrite", False)

    if not name:
        return web.json_response({"error": "Name is required"}, status=400)

    file_path = os.path.abspath(os.path.join(workflows_dir, name + ".json"))

    if not is_safe_path(workflows_dir, file_path):
        return web.json_response({"error": "Access denied"}, status=403)

    if os.path.exists(file_path) and not overwrite:
        return web.json_response({"error": "Workflow already exists"}, status=409)

    sub_path = os.path.dirname(file_path)
    if not os.path.exists(sub_path):
        os.makedirs(sub_path, exist_ok=True)

    tmp_path = file_path + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(workflow, f, ensure_ascii=False, indent=2)
        # 原子替换：先写临时文件再 rename，避免写入中途崩溃导致原文件损坏
        os.replace(tmp_path, file_path)
        return web.json_response({"success": True, "path": name}, status=201)
    except Exception as e:
        # 清理可能残留的临时文件，避免下次误读半截内容
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        return web.json_response({"error": str(e)}, status=500)


@_xzg_routes_var.post("/xzg/workflows/rename")
@xzg_safe_handler
async def rename_workflow(request):
    workflows_dir = get_workflows_directory()

    try:
        json_data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    old_name = json_data.get("oldName", "")
    new_name = json_data.get("newName", "")

    if not old_name or not new_name:
        return web.json_response({"error": "oldName and newName are required"}, status=400)

    old_path = os.path.abspath(os.path.join(workflows_dir, old_name + ".json"))
    new_path = os.path.abspath(os.path.join(workflows_dir, new_name + ".json"))

    if not is_safe_path(workflows_dir, old_path) or not is_safe_path(workflows_dir, new_path):
        return web.json_response({"error": "Access denied"}, status=403)

    if not os.path.exists(old_path):
        return web.json_response({"error": "Workflow not found"}, status=404)

    if os.path.exists(new_path):
        return web.json_response({"error": "New name already exists"}, status=409)

    new_dir = os.path.dirname(new_path)
    if not os.path.exists(new_dir):
        os.makedirs(new_dir, exist_ok=True)

    try:
        os.rename(old_path, new_path)
        return web.json_response({"success": True, "oldPath": old_name, "newPath": new_name})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@_xzg_routes_var.get("/xzg/workflows/{name:.+}")
@xzg_safe_handler
async def get_workflow(request):
    workflows_dir = get_workflows_directory()
    name = request.match_info["name"]

    file_path = os.path.abspath(os.path.join(workflows_dir, name + ".json"))

    if not is_safe_path(workflows_dir, file_path):
        return web.json_response({"error": "Access denied"}, status=403)

    if not os.path.exists(file_path):
        return web.json_response({"error": "Workflow not found"}, status=404)

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            workflow_data = json.load(f)
        return web.json_response(workflow_data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@_xzg_routes_var.delete("/xzg/workflows/{name:.+}")
@xzg_safe_handler
async def delete_workflow(request):
    workflows_dir = get_workflows_directory()
    name = request.match_info["name"]

    file_path = os.path.abspath(os.path.join(workflows_dir, name + ".json"))

    if not is_safe_path(workflows_dir, file_path):
        return web.json_response({"error": "Access denied"}, status=403)

    if not os.path.exists(file_path):
        return web.json_response({"error": "Workflow not found"}, status=404)

    try:
        # 删除改回收站：先移入 __trash，可恢复，避免永久丢失
        ts = time.strftime("%Y%m%d_%H%M%S")
        base = os.path.basename(file_path)
        trash_item = os.path.join(get_trash_directory(), f"{ts}__{base}")
        while os.path.exists(trash_item):
            ts += "_"
            trash_item = os.path.join(get_trash_directory(), f"{ts}__{base}")
        os.makedirs(trash_item, exist_ok=True)
        shutil.move(file_path, os.path.join(trash_item, base))
        with open(os.path.join(trash_item, ".xzg_trash_meta.json"), "w", encoding="utf-8") as mf:
            json.dump({"original_path": name + ".json", "deleted_at": ts, "type": "workflow"}, mf, ensure_ascii=False)
        return web.json_response({"success": True, "trashed": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@_xzg_routes_var.post("/xzg/wf-manage/folder")
@xzg_safe_handler
async def create_folder(request):
    workflows_dir = get_workflows_directory()

    try:
        json_data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    folder_name = json_data.get("name", "")
    parent = json_data.get("parent", "")

    if not folder_name:
        return web.json_response({"error": "Folder name is required"}, status=400)

    if parent:
        full_path = parent + "/" + folder_name
    else:
        full_path = folder_name

    folder_path = os.path.abspath(os.path.join(workflows_dir, full_path))

    if not is_safe_path(workflows_dir, folder_path):
        return web.json_response({"error": "Access denied"}, status=403)

    if os.path.exists(folder_path):
        return web.json_response({"error": "Folder already exists"}, status=409)

    try:
        os.makedirs(folder_path, exist_ok=True)
        return web.json_response({"success": True, "path": full_path.replace("\\", "/")}, status=201)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@_xzg_routes_var.delete("/xzg/wf-manage/folder/{name:.+}")
@xzg_safe_handler
async def delete_folder(request):
    workflows_dir = get_workflows_directory()
    name = request.match_info["name"]

    folder_path = os.path.abspath(os.path.join(workflows_dir, name))

    if not is_safe_path(workflows_dir, folder_path):
        return web.json_response({"error": "Access denied"}, status=403)

    if not os.path.exists(folder_path):
        return web.json_response({"error": "Folder not found"}, status=404)

    if not os.path.isdir(folder_path):
        return web.json_response({"error": "Not a folder"}, status=400)

    try:
        # 删除改回收站：整层（含子分类与所有工作流）先移入 __trash，可恢复
        ts = time.strftime("%Y%m%d_%H%M%S")
        base = os.path.basename(folder_path.rstrip(os.sep))
        trash_item = os.path.join(get_trash_directory(), f"{ts}__{base}")
        while os.path.exists(trash_item):
            ts += "_"
            trash_item = os.path.join(get_trash_directory(), f"{ts}__{base}")
        os.makedirs(trash_item, exist_ok=True)
        shutil.move(folder_path, os.path.join(trash_item, base))
        with open(os.path.join(trash_item, ".xzg_trash_meta.json"), "w", encoding="utf-8") as mf:
            json.dump({"original_path": name, "deleted_at": ts, "type": "folder"}, mf, ensure_ascii=False)
        return web.json_response({"success": True, "trashed": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@_xzg_routes_var.post("/xzg/wf-manage/rename-folder")
@xzg_safe_handler
async def rename_folder(request):
    workflows_dir = get_workflows_directory()
    try:
        json_data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    old_path = json_data.get("oldPath", "")
    new_name = json_data.get("newName", "")

    if not old_path or not new_name:
        return web.json_response({"error": "oldPath and newName are required"}, status=400)

    parent = os.path.dirname(old_path)
    if parent:
        new_path = parent + "/" + new_name
    else:
        new_path = new_name

    old_full_path = os.path.abspath(os.path.join(workflows_dir, old_path))
    new_full_path = os.path.abspath(os.path.join(workflows_dir, new_path))

    if not is_safe_path(workflows_dir, old_full_path) or not is_safe_path(workflows_dir, new_full_path):
        return web.json_response({"error": "Access denied"}, status=403)

    if not os.path.exists(old_full_path):
        return web.json_response({"error": "Folder not found"}, status=404)

    if os.path.exists(new_full_path):
        return web.json_response({"error": "Target folder already exists"}, status=409)

    try:
        os.rename(old_full_path, new_full_path)
        return web.json_response({"success": True, "oldPath": old_path, "newPath": new_path.replace("\\", "/")})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@_xzg_routes_var.post("/xzg/wf-manage/cleanup-tmp")
@xzg_safe_handler
async def cleanup_tmp_folders(request):
    """清理编号/重命名过程中残留的临时文件夹（__xzg_tmp_*、*__bak_*），避免重复文件夹堆积。"""
    workflows_dir = get_workflows_directory()
    removed = []
    try:
        for root, dirs, _ in os.walk(workflows_dir):
            # 不在 __trash 内部清理
            if "__trash" in root.split(os.sep):
                continue
            for d in list(dirs):
                if d.startswith("__xzg_tmp_") or d.endswith("__bak_"):
                    full = os.path.join(root, d)
                    if is_safe_path(workflows_dir, full):
                        try:
                            shutil.rmtree(full)
                            removed.append(os.path.relpath(full, workflows_dir).replace("\\", "/"))
                        except Exception:
                            pass
        return web.json_response({"success": True, "removed": removed})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@_xzg_routes_var.post("/xzg/wf-manage/move")
@xzg_safe_handler
async def move_workflow(request):
    workflows_dir = get_workflows_directory()

    try:
        json_data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    old_path = json_data.get("oldPath", "")
    new_folder = json_data.get("newFolder", "")

    if not old_path:
        return web.json_response({"error": "oldPath is required"}, status=400)

    old_file_path = os.path.abspath(os.path.join(workflows_dir, old_path + ".json"))

    if not is_safe_path(workflows_dir, old_file_path):
        return web.json_response({"error": "Access denied"}, status=403)

    if not os.path.exists(old_file_path):
        return web.json_response({"error": "Workflow not found"}, status=404)

    wf_name = os.path.basename(old_path)
    if new_folder and new_folder != "未分类":
        new_path = new_folder + "/" + wf_name
    else:
        new_path = wf_name

    new_file_path = os.path.abspath(os.path.join(workflows_dir, new_path + ".json"))

    if not is_safe_path(workflows_dir, new_file_path):
        return web.json_response({"error": "Access denied"}, status=403)

    if old_file_path == new_file_path:
        return web.json_response({"success": True, "oldPath": old_path, "newPath": new_path})

    if os.path.exists(new_file_path):
        return web.json_response({"error": "Workflow already exists in target folder"}, status=409)

    new_dir = os.path.dirname(new_file_path)
    if not os.path.exists(new_dir):
        os.makedirs(new_dir, exist_ok=True)

    try:
        os.rename(old_file_path, new_file_path)
        return web.json_response({"success": True, "oldPath": old_path, "newPath": new_path})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@_xzg_routes_var.get("/xzg/wf-manage/trash")
@xzg_safe_handler
async def list_trash(request):
    trash_dir = get_trash_directory()
    # 打开回收站时先惰性清理过期（超过保留期）的项目
    cleanup_expired_trash()
    items = []
    try:
        for entry in os.listdir(trash_dir):
            item_dir = os.path.join(trash_dir, entry)
            if not os.path.isdir(item_dir):
                continue
            meta = {}
            meta_path = os.path.join(item_dir, ".xzg_trash_meta.json")
            if os.path.exists(meta_path):
                try:
                    with open(meta_path, encoding="utf-8") as mf:
                        meta = json.load(mf)
                except Exception:
                    pass
            deleted_at = meta.get("deleted_at", "")
            days_left = None
            if deleted_at:
                try:
                    dt = time.mktime(time.strptime(deleted_at, "%Y%m%d_%H%M%S"))
                    days_left = max(0, int((dt + TRASH_RETENTION_DAYS * 86400 - time.time()) // 86400))
                except Exception:
                    days_left = None
            items.append({
                "id": entry,
                "original_path": meta.get("original_path", ""),
                "deleted_at": deleted_at,
                "type": meta.get("type", "unknown"),
                "name": os.path.basename(meta.get("original_path", entry)),
                "days_left": days_left,
            })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    items.sort(key=lambda x: x.get("deleted_at", ""), reverse=True)
    return web.json_response({"items": items})


@_xzg_routes_var.post("/xzg/wf-manage/restore")
@xzg_safe_handler
async def restore_trash(request):
    workflows_dir = get_workflows_directory()
    try:
        json_data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    item_id = json_data.get("id", "")
    if not item_id:
        return web.json_response({"error": "id is required"}, status=400)

    item_dir = os.path.abspath(os.path.join(get_trash_directory(), item_id))
    if not is_safe_path(get_trash_directory(), item_dir) or not os.path.isdir(item_dir):
        return web.json_response({"error": "Trash item not found"}, status=404)

    original_path = ""
    meta_path = os.path.join(item_dir, ".xzg_trash_meta.json")
    if os.path.exists(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as mf:
                original_path = json.load(mf).get("original_path", "")
        except Exception:
            pass
    if not original_path:
        return web.json_response({"error": "Missing original path in trash meta"}, status=400)

    dest = os.path.abspath(os.path.join(workflows_dir, original_path))
    if not is_safe_path(workflows_dir, dest):
        return web.json_response({"error": "Access denied"}, status=403)

    src = os.path.abspath(os.path.join(item_dir, os.path.basename(original_path)))
    if not os.path.exists(src):
        return web.json_response({"error": "Trash content missing"}, status=404)

    if os.path.exists(dest):
        return web.json_response({"error": "目标已存在，无法覆盖恢复", "conflict": True}, status=409)

    try:
        parent = os.path.dirname(dest)
        if parent and not os.path.exists(parent):
            os.makedirs(parent, exist_ok=True)
        shutil.move(src, dest)
        shutil.rmtree(item_dir)
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@_xzg_routes_var.post("/xzg/wf-manage/trash-clear")
@xzg_safe_handler
async def clear_trash(request):
    # 回收站不允许手动清空：超过保留期（默认 90 天）的项目会在打开回收站时自动清理。
    return web.json_response(
        {"error": "回收站不允许手动清空，超过保留期（默认3个月）的项目会自动清理"},
        status=403,
    )

