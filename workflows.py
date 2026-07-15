from server import PromptServer
from aiohttp import web
import os
import json
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

    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(workflow, f, ensure_ascii=False, indent=2)
        return web.json_response({"success": True, "path": name}, status=201)
    except Exception as e:
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
        os.remove(file_path)
        return web.json_response({"success": True})
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
        import shutil
        shutil.rmtree(folder_path)
        return web.json_response({"success": True})
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
