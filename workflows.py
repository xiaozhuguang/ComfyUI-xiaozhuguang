from server import PromptServer
from aiohttp import web
import os
import json
import shutil
import time
import folder_paths


def get_workflows_directory():
    user_dir = folder_paths.get_user_directory()
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


@PromptServer.instance.routes.get("/xzg/workflows")
async def get_workflows(request):
    workflows_dir = get_workflows_directory()
    tree = build_tree(workflows_dir)
    return web.json_response(tree)


@PromptServer.instance.routes.get("/xzg/wf-manage/list")
async def list_workflows(request):
    workflows_dir = get_workflows_directory()
    tree = build_tree(workflows_dir)
    return web.json_response(tree)


@PromptServer.instance.routes.post("/xzg/workflows")
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


@PromptServer.instance.routes.post("/xzg/workflows/rename")
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


@PromptServer.instance.routes.get("/xzg/workflows/{name:.+}")
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


@PromptServer.instance.routes.delete("/xzg/workflows/{name:.+}")
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


@PromptServer.instance.routes.post("/xzg/wf-manage/folder")
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


@PromptServer.instance.routes.delete("/xzg/wf-manage/folder/{name:.+}")
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


@PromptServer.instance.routes.post("/xzg/wf-manage/rename-folder")
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


@PromptServer.instance.routes.post("/xzg/wf-manage/move")
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


@PromptServer.instance.routes.get("/xzg/wf-manage/trash")
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


@PromptServer.instance.routes.post("/xzg/wf-manage/restore")
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


@PromptServer.instance.routes.post("/xzg/wf-manage/trash-clear")
async def clear_trash(request):
    # 回收站不允许手动清空：超过保留期（默认 90 天）的项目会在打开回收站时自动清理。
    return web.json_response(
        {"error": "回收站不允许手动清空，超过保留期（默认3个月）的项目会自动清理"},
        status=403,
    )



