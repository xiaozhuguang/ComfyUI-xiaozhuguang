"""Pose library storage, previews and repository synchronization."""
import os
import json
import base64
import io
import shutil
import time
import hashlib
import tempfile
import threading
import zipfile
import stat
from urllib.parse import unquote, urlparse
from PIL import Image

from ..shared.paths import _EXTENSION_ROOT, _vnccs_user_data_root
from ..shared.user_config import get_vnccs_user_config, write_private_json
from ..shared.repository_progress import repository_progress_start, repository_progress_update, repository_progress_finish, repository_progress_fail

DEFAULT_REPO_ID = "MIUProject/VNCCS_PoseLibrary_Main"

SECONDARY_DEFAULT_REPO_ID = "Totemistyk/General_Poses_PoseStudio"

LOCAL_USER_REPOSITORY = "local_user_poses"

REMOTE_POSE_REPOSITORIES_ENABLED = False

DEFAULT_CATEGORY = "Uncategorized"

POSE_ASSET_TYPE = "pose"

LEGACY_GENERIC_REPOSITORY_TITLES = {"VNCCS Pose Library"}

RESERVED_LIBRARY_JSON = {"repositories.user.json", "pose_library.json"}

MAX_PREVIEW_BYTES = 16 * 1024 * 1024

MAX_PREVIEW_PIXELS = 4096 * 4096

MAX_LIBRARY_SAVE_REQUEST_BYTES = 64 * 1024 * 1024

MAX_LIBRARY_IMPORT_BYTES = 256 * 1024 * 1024

MAX_LIBRARY_IMPORT_FILES = 5000

MAX_LIBRARY_IMPORT_UNCOMPRESSED_BYTES = 512 * 1024 * 1024

MAX_POSE_REPOSITORY_FILE_BYTES = 32 * 1024 * 1024

MAX_POSE_REPOSITORY_SYNC_BYTES = 256 * 1024 * 1024

POSE_REPOSITORY_LEGACY_GIT_CACHE_DIR = ".repository_git_cache"

_BACKGROUND_REFRESH_STATE = {
    "running": False,
    "task_id": "",
    "last_started": 0,
    "last_finished": 0,
}

_BACKGROUND_REFRESH_LOCK = threading.Lock()
_REPOSITORY_SETTINGS_LOCK = threading.RLock()

# Worker saves must keep the collision check and file commit in one transaction.
_LIBRARY_SAVE_LOCK = threading.Lock()


def get_library_path():
    """Return durable shared user storage for the local Pose Library."""
    lib_path = os.path.join(_vnccs_user_data_root(), "pose_library")
    os.makedirs(lib_path, exist_ok=True)
    return lib_path


def walk_pose_library(lib_path):
    """Walk user-visible pose data without exposing the internal Git cache."""
    for root, dirs, files in os.walk(lib_path):
        if os.path.abspath(root) == os.path.abspath(lib_path):
            dirs[:] = [directory for directory in dirs if directory != POSE_REPOSITORY_LEGACY_GIT_CACHE_DIR]
        yield root, dirs, files


def get_default_repositories_path():
    base_dir = _EXTENSION_ROOT
    return os.path.join(base_dir, "config", "default_pose_repositories.json")


def get_user_repositories_path():
    return os.path.join(get_library_path(), "repositories.user.json")


def normalize_repo_id(repo_id):
    repo_id = str(repo_id or "").strip()
    if repo_id.lower().startswith(("https://", "http://")):
        try:
            parsed = urlparse(repo_id)
            if parsed.hostname not in {"huggingface.co", "www.huggingface.co"}:
                return ""
            parts = [unquote(part) for part in parsed.path.split("/") if part]
            if len(parts) < 2 or parts[0] in {"datasets", "spaces"}:
                return ""
            repo_id = "/".join(parts[:2])
        except Exception:
            return ""
    repo_id = repo_id.strip("/")
    if not repo_id or " " in repo_id or repo_id.count("/") != 1:
        return ""
    return repo_id


def repository_manifest_title(repo_id, title=""):
    """Return a stable, repository-specific title for generated manifests."""
    title = str(title or "").strip()
    if not title or title in LEGACY_GENERIC_REPOSITORY_TITLES:
        return repo_id
    return title


def load_default_repositories():
    path = get_default_repositories_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        repos = data.get("repositories") or []
    except Exception:
        repos = []
    out = []
    for repo in repos:
        repo_id = normalize_repo_id(repo.get("repo_id"))
        if not repo_id:
            continue
        out.append({
            "repo_id": repo_id,
            "title": repo.get("title") or repo_id,
            "description": repo.get("description") or "",
            "manifest_path": repo.get("manifest_path") or "pose_library.json",
            "enabled": bool(repo.get("enabled", True)),
            "builtin": True,
        })
    return out


def load_user_repositories():
    path = get_user_repositories_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        repos = data.get("repositories", []) if isinstance(data, dict) else None
        if not isinstance(repos, list) or any(not isinstance(repo, dict) for repo in repos):
            raise ValueError("repository settings must contain a list of objects")
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        raise ValueError(f"Cannot read pose repository settings; original file preserved: {exc}") from exc
    out = []
    for repo in repos:
        repo_id = normalize_repo_id(repo.get("repo_id"))
        if not repo_id:
            continue
        out.append({
            **repo,
            "repo_id": repo_id,
            "title": repo.get("title") or repo_id,
            "description": repo.get("description") or "",
            "manifest_path": repo.get("manifest_path") or "pose_library.json",
            "enabled": bool(repo.get("enabled", True)),
            "builtin": False,
        })
    return out


def save_user_repositories(repositories):
    with _REPOSITORY_SETTINGS_LOCK:
        load_user_repositories()  # Never replace settings that could not be read.
        path = get_user_repositories_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        user_repos = [
            {k: v for k, v in repo.items() if k != "builtin"}
            for repo in repositories
            if not repo.get("builtin")
        ]
        write_private_json(path, {"schema_version": 1, "repositories": user_repos})


def load_pose_repositories():
    # Pose Studio now uses only its local user library. Keep repository
    # settings files and cache data intact, but do not load or refresh remotes.
    return []


def refresh_pose_repository(repo, task_id=None):
    repo_id = repo["repo_id"]
    manifest_path = repo.get("manifest_path") or "pose_library.json"
    repository_progress_start(task_id, f"Checking {repo_id}...")
    result = {
        **repo,
        "status": "unknown",
        "pose_count": int(repo.get("pose_count") or 0),
        "asset_count": int(repo.get("asset_count") or repo.get("pose_count") or 0),
        "last_checked": time.time(),
        "last_error": "",
        "transport": "",
    }
    try:
        from huggingface_hub import HfApi
        token = False
        api = HfApi()
        repository_progress_update(task_id, message=f"Reading repository info for {repo_id}...", progress=2)
        info = api.repo_info(repo_id=repo_id, repo_type="model", token=token)
        result["sha"] = getattr(info, "sha", "") or ""
        repository_progress_update(task_id, message=f"Downloading manifest for {repo_id}...", progress=5, transport="http")
        manifest_file = None
        try:
            manifest_file = download_hf_file_with_progress(
                repo_id=repo_id, path_in_repo=manifest_path, token=token,
                task_id=task_id, file_index=0, total_files=1,
            )
            with open(manifest_file, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        finally:
            if manifest_file:
                os.remove(manifest_file)
        sync_result = sync_pose_repository_files(repo, manifest, token, task_id=task_id)
        transport = "http"
        poses = manifest.get("poses") or []
        result["pose_count"] = len(poses)
        result["asset_count"] = len(poses)
        result["downloaded_count"] = sync_result["downloaded_count"]
        result["skipped_count"] = sync_result["skipped_count"]
        result["removed_count"] = sync_result["removed_count"]
        result["transport"] = transport
        result["errors"] = sync_result["errors"]
        if sync_result["errors"]:
            raise ValueError("; ".join(sync_result["errors"]))
        manifest_title = manifest.get("title")
        result["title"] = (
            (result.get("title") or repo_id)
            if result.get("builtin")
            else repository_manifest_title(repo_id, manifest_title)
        )
        result["description"] = manifest.get("description") or result.get("description") or ""
        result["updated_at"] = manifest.get("updated_at") or ""
        result["status"] = "ok"
        repository_progress_finish(
            task_id,
            f"Repository sync complete via {transport}: {sync_result['downloaded_count']} downloaded, "
            f"{sync_result['skipped_count']} unchanged, {sync_result['removed_count']} removed.",
        )
        repository_progress_update(task_id, transport=transport)
    except Exception as exc:
        result["status"] = "error"
        result["last_error"] = str(exc)
        repository_progress_fail(task_id, exc)
    return result


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def human_bytes(value):
    value = float(value or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024


def verify_expected_sha(path, expected_sha):
    expected_sha = str(expected_sha or "").strip().lower()
    if not expected_sha:
        return
    actual_sha = sha256_file(path).lower()
    if actual_sha != expected_sha:
        raise ValueError(f"SHA256 mismatch for downloaded file: expected {expected_sha}, got {actual_sha}")


def _pose_download_temp_path(path_in_repo):
    directory = os.path.join(get_library_path(), ".downloads")
    os.makedirs(directory, exist_ok=True)
    fd, path = tempfile.mkstemp(
        prefix="vnccs_pose_repo_",
        suffix=os.path.splitext(path_in_repo)[1] or ".tmp",
        dir=directory,
    )
    os.close(fd)
    return path


def download_hf_file_with_progress(repo_id, path_in_repo, token=None, task_id=None, file_index=0, total_files=1):
    from huggingface_hub import hf_hub_download

    tmp_path = _pose_download_temp_path(path_in_repo)
    try:
        repository_progress_update(
            task_id,
            message=f"Downloading {path_in_repo}...",
            current_file=path_in_repo,
            file_index=file_index + 1,
            total_files=total_files,
            progress=(file_index / max(total_files, 1)) * 100,
        )
        cached_path = hf_hub_download(
            repo_id=repo_id,
            filename=path_in_repo,
            repo_type="model",
            token=False,
        )
        total_bytes = os.path.getsize(cached_path)
        if total_bytes > MAX_POSE_REPOSITORY_FILE_BYTES:
            raise ValueError(f"{path_in_repo} is too large ({human_bytes(total_bytes)} > {human_bytes(MAX_POSE_REPOSITORY_FILE_BYTES)})")
        shutil.copyfile(cached_path, tmp_path)
        repository_progress_update(
            task_id,
            message=f"Downloaded {path_in_repo} ({human_bytes(total_bytes)})",
            current_file=path_in_repo,
            file_index=file_index + 1,
            total_files=total_files,
            bytes_done=total_bytes,
            bytes_total=total_bytes,
            progress=((file_index + 1) / max(total_files, 1)) * 100,
        )
        return tmp_path
    except Exception:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise


def download_hf_file(repo_id, path_in_repo, token=None):
    from huggingface_hub import hf_hub_download

    tmp_path = _pose_download_temp_path(path_in_repo)
    try:
        cached_path = hf_hub_download(
            repo_id=repo_id,
            filename=path_in_repo,
            repo_type="model",
            token=False,
        )
        total_bytes = os.path.getsize(cached_path)
        if total_bytes > MAX_POSE_REPOSITORY_FILE_BYTES:
            raise ValueError(f"{path_in_repo} is too large ({human_bytes(total_bytes)} > {human_bytes(MAX_POSE_REPOSITORY_FILE_BYTES)})")
        shutil.copyfile(cached_path, tmp_path)
        return tmp_path
    except Exception:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise


def collect_local_pose_files():
    lib_path = get_library_path()
    local_root = os.path.join(lib_path, LOCAL_USER_REPOSITORY)
    if not os.path.exists(local_root):
        return []

    poses = []
    for root, _dirs, files in os.walk(local_root):
        for filename in files:
            if not filename.endswith(".json") or (filename in RESERVED_LIBRARY_JSON and root == local_root):
                continue
            name = sanitize_pose_name(filename[:-5])
            if not name:
                continue
            path = os.path.join(root, filename)
            try:
                pose_data = read_pose_json(path)
            except Exception:
                continue
            meta = get_pose_meta(pose_data)
            _repository, category = pose_file_location(path, pose_data, {LOCAL_USER_REPOSITORY: LOCAL_USER_REPOSITORY})
            preview_path, preview_type = find_preview(root, name)
            preview_ext = os.path.splitext(preview_path)[1].lower() if preview_path else ""
            category_dir = category_to_dir(category)
            safe_name = sanitize_pose_name(name)
            poses.append({
                "name": name,
                "category": category,
                "tags": meta.get("tags") or [],
                "json_path": path,
                "preview_path": preview_path,
                "preview_type": preview_type,
                "hub_json_path": f"poses/{category_dir}/{safe_name}.json",
                "hub_preview_path": f"previews/{category_dir}/{safe_name}{preview_ext}" if preview_path else "",
            })
    return sorted(poses, key=lambda item: (item["category"], item["name"]))


def get_local_repository_info():
    config = get_vnccs_user_config()
    poses = collect_local_pose_files()
    return {
        "repo_id": LOCAL_USER_REPOSITORY,
        "title": "Local Pose Library",
        "description": "Poses saved locally from Pose Studio.",
        "asset_count": len(poses),
        "pose_count": len(poses),
        "publish_repo_id": config.get("pose_library_publish_repo_id") or "",
        "publishing_enabled": False,
        "last_publish": config.get("pose_library_last_publish") or None,
        "last_publish_result": config.get("pose_library_last_publish_result") or None,
    }


def infer_category_from_hub_path(path_in_repo):
    parts = [part for part in str(path_in_repo or "").replace("\\", "/").split("/") if part]
    if len(parts) >= 3 and parts[0] in {"poses", "previews"}:
        return parts[1]
    if len(parts) >= 2:
        return parts[-2]
    return DEFAULT_CATEGORY


def copy_if_changed(src_path, dst_path, expected_sha=""):
    verify_expected_sha(src_path, expected_sha)
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    if os.path.exists(dst_path):
        try:
            current_sha = sha256_file(dst_path)
            source_sha = expected_sha or sha256_file(src_path)
            if current_sha == source_sha:
                return False
        except Exception:
            pass
    fd, staged_path = tempfile.mkstemp(prefix=".vnccs_sync_", dir=os.path.dirname(dst_path))
    os.close(fd)
    try:
        shutil.copy2(src_path, staged_path)
        os.replace(staged_path, dst_path)
    finally:
        if os.path.exists(staged_path):
            os.remove(staged_path)
    return True


def local_file_matches(path, expected_sha):
    if not expected_sha or not os.path.exists(path):
        return False
    try:
        return sha256_file(path) == expected_sha
    except Exception:
        return False


def normalize_local_path(path):
    """Absolute path compared case-insensitively on case-insensitive filesystems (Windows)."""
    return os.path.normcase(os.path.abspath(path))


def cleanup_local_repository_cache(repo_id, expected_json_paths, expected_preview_paths, task_id=None):
    validate_repository_directory(repo_id)
    repo_root = os.path.join(get_library_path(), repository_to_dir(repo_id))
    if not os.path.exists(repo_root):
        return []

    expected_json_paths = {normalize_local_path(path) for path in expected_json_paths}
    expected_preview_paths = {normalize_local_path(path) for path in expected_preview_paths if path}
    removed = []
    preview_exts = {".webp", ".jpg", ".jpeg", ".png"}

    for root, _dirs, files in os.walk(repo_root):
        for filename in files:
            path = os.path.join(root, filename)
            abs_path = normalize_local_path(path)
            ext = os.path.splitext(filename)[1].lower()
            should_remove = False
            if ext == ".json" and filename not in RESERVED_LIBRARY_JSON:
                should_remove = abs_path not in expected_json_paths
            elif ext in preview_exts:
                should_remove = abs_path not in expected_preview_paths
            if not should_remove:
                continue
            try:
                os.remove(path)
                removed.append(os.path.relpath(path, repo_root))
            except Exception:
                pass

    for root, _dirs, _files in os.walk(repo_root, topdown=False):
        if root == repo_root:
            continue
        try:
            is_empty = not os.listdir(root)
        except Exception:
            is_empty = False
        if is_empty:
            try:
                os.rmdir(root)
            except Exception:
                pass

    if removed:
        repository_progress_update(
            task_id,
            message=f"Removed {len(removed)} stale local pose files.",
            progress=98,
        )
    return removed


def remove_local_repository_cache(repo_id):
    if repo_id == LOCAL_USER_REPOSITORY:
        return 0
    validate_repository_directory(repo_id)
    lib_root = os.path.abspath(get_library_path())
    repo_root = os.path.abspath(os.path.join(lib_root, repository_to_dir(repo_id)))
    if repo_root == lib_root or not repo_root.startswith(lib_root + os.sep):
        return 0

    removed_count = 0
    if os.path.exists(repo_root):
        for _root, _dirs, files in os.walk(repo_root):
            removed_count += len(files)
        shutil.rmtree(repo_root, ignore_errors=True)
    return removed_count


def sync_pose_repository_files(repo, manifest, token, task_id=None):
    """Validate the complete manifest before importing public Hugging Face assets."""
    repo_id = repo["repo_id"]
    validate_repository_directory(repo_id)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("poses"), list):
        raise ValueError("Repository manifest must contain a poses array")
    poses = manifest["poses"]
    destinations = {}
    pose_states = {}
    download_jobs = []
    expected_json_paths = set()
    expected_preview_paths = set()
    errors = []

    for index, pose in enumerate(poses):
        if not isinstance(pose, dict):
            raise ValueError(f"Invalid manifest entry {index}: expected an object")
        hub_json_path = pose.get("json_path") or pose.get("path")
        if not isinstance(hub_json_path, str) or not hub_json_path.lower().endswith(".json"):
            raise ValueError(f"Invalid manifest entry {index}: JSON path required")
        for field in ("json_path", "path", "preview_path", "name", "category", "json_sha256", "preview_sha256"):
            if field in pose and not isinstance(pose[field], str):
                raise ValueError(f"Invalid manifest entry {index}: {field} must be a string")
        for hub_path in (hub_json_path, pose.get("preview_path") or ""):
            if hub_path and (hub_path.startswith(("/", "\\")) or any(part in {"", ".", ".."} for part in hub_path.replace("\\", "/").split("/"))):
                raise ValueError(f"Unsafe repository path: {hub_path}")
        for field in ("json_sha256", "preview_sha256"):
            sha = pose.get(field) or ""
            if sha and (len(sha) != 64 or any(c not in "0123456789abcdefABCDEF" for c in sha)):
                raise ValueError(f"Invalid manifest entry {index}: {field}")
        name = sanitize_pose_name(pose.get("name") or os.path.splitext(os.path.basename(hub_json_path))[0])
        if not name:
            raise ValueError(f"Invalid manifest entry {index}: name required")
        category = str(pose.get("category") or infer_category_from_hub_path(hub_json_path) or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY
        pose_dir = get_pose_dir(repo_id, category)
        target_json = os.path.join(pose_dir, f"{name}.json")
        preview_path = pose.get("preview_path") or ""
        targets = [(target_json, hub_json_path)]
        if preview_path:
            ext = os.path.splitext(preview_path)[1].lower()
            if ext not in {".webp", ".jpg", ".jpeg", ".png"}:
                raise ValueError(f"Unsupported preview path: {preview_path}")
            targets.append((os.path.join(pose_dir, f"{name}{ext}"), preview_path))
        for target, source in targets:
            key = normalize_local_path(target).casefold()
            if key in destinations:
                raise ValueError(f"Conflicting manifest entries: {destinations[key]} and {source} target {os.path.relpath(target, get_library_path())}")
            destinations[key] = source
        if hub_json_path in pose_states:
            raise ValueError(f"Duplicate manifest JSON path: {hub_json_path}")
        pose_states[hub_json_path] = {"changed": False, "error": False}

        # Planned targets are always kept by cleanup so a failed download never
        # deletes a local file that is already present.
        expected_json_paths.add(target_json)
        try:
            if not local_file_matches(target_json, pose.get("json_sha256") or ""):
                download_jobs.append({
                    "pose_key": hub_json_path,
                    "hub_path": hub_json_path,
                    "target_path": target_json,
                    "expected_sha": pose.get("json_sha256") or "",
                    "expected_kind": "json",
                })

            hub_preview_path = pose.get("preview_path") or ""
            if hub_preview_path:
                try:
                    ext = os.path.splitext(hub_preview_path)[1].lower() or ".webp"
                    target_preview = os.path.join(pose_dir, f"{name}{ext}")
                    expected_preview_paths.add(target_preview)
                    if not local_file_matches(target_preview, pose.get("preview_sha256") or ""):
                        download_jobs.append({
                            "pose_key": hub_json_path,
                            "hub_path": hub_preview_path,
                            "target_path": target_preview,
                            "expected_sha": pose.get("preview_sha256") or "",
                            "expected_kind": "preview",
                        })
                except Exception as exc:
                    errors.append(f"{hub_preview_path}: {exc}")
                    pose_states[hub_json_path]["error"] = True
        except Exception as exc:
            errors.append(f"{hub_json_path}: {exc}")
            pose_states[hub_json_path]["error"] = True

    if download_jobs:
        downloaded_bytes = 0
        progress_start = 2
        progress_span = 94
        repository_progress_update(
            task_id,
            message=f"Downloading {len(download_jobs)} changed files...",
            current_file="",
            file_index=0,
            total_files=len(download_jobs),
            progress=progress_start,
        )
        for completed, job in enumerate(download_jobs, start=1):
            tmp_path = None
            try:
                tmp_path = download_hf_file(repo_id, job["hub_path"], token=token)
                if job["expected_kind"] == "json" and not isinstance(read_pose_json(tmp_path), dict):
                    raise ValueError("Library asset JSON must be an object")
                file_bytes = os.path.getsize(tmp_path)
                if downloaded_bytes + file_bytes > MAX_POSE_REPOSITORY_SYNC_BYTES:
                    raise ValueError(f"Repository sync exceeded the total download limit ({human_bytes(MAX_POSE_REPOSITORY_SYNC_BYTES)})")
                changed = copy_if_changed(tmp_path, job["target_path"], job.get("expected_sha") or "")
                downloaded_bytes += file_bytes
                if changed:
                    pose_states[job["pose_key"]]["changed"] = True
                if job.get("expected_kind") == "preview":
                    expected_preview_paths.add(job["target_path"])
                else:
                    expected_json_paths.add(job["target_path"])
            except Exception as exc:
                errors.append(f"{job['hub_path']}: {exc}")
                pose_states[job["pose_key"]]["error"] = True
            finally:
                if tmp_path:
                    try:
                        os.remove(tmp_path)
                    except Exception:
                        pass
            repository_progress_update(
                task_id,
                message=f"Downloaded {completed}/{len(download_jobs)} changed files...",
                current_file=job["hub_path"],
                file_index=completed,
                total_files=len(download_jobs),
                progress=progress_start + (completed / max(len(download_jobs), 1)) * progress_span,
            )
    else:
        repository_progress_update(task_id, message="All repository files are already up to date.", progress=96)

    downloaded = [
        pose_key
        for pose_key, state in pose_states.items()
        if state.get("changed") and not state.get("error")
    ]
    skipped = [
        pose_key
        for pose_key, state in pose_states.items()
        if not state.get("changed") and not state.get("error")
    ]

    removed = [] if errors else cleanup_local_repository_cache(repo_id, expected_json_paths, expected_preview_paths, task_id=task_id)

    return {
        "downloaded_count": len(downloaded),
        "skipped_count": len(skipped),
        "removed_count": len(removed),
        "downloaded": downloaded,
        "skipped": skipped,
        "removed": removed,
        "errors": errors,
    }


def publish_local_repository_to_hf(repo_id, token=None, create=False, private=False, task_id=None):
    repository_progress_fail(task_id, "Remote publishing is disabled by the VNCCS security policy")
    raise PermissionError("Remote publishing is disabled by the VNCCS security policy")


def persist_refreshed_repositories(refreshed):
    with _REPOSITORY_SETTINGS_LOCK:
        user_repos = load_user_repositories()
        by_id = {repo["repo_id"]: repo for repo in user_repos}
        for repo in refreshed:
            if repo.get("builtin"):
                current = by_id.setdefault(repo["repo_id"], {**repo, "builtin": False})
            else:
                current = by_id.get(repo["repo_id"])
            if current is not None:
                current.update({key: repo[key] for key in (
                    "asset_count", "pose_count", "last_checked",
                    "last_error", "status", "sha", "updated_at", "downloaded_count",
                    "skipped_count", "removed_count", "transport",
                ) if key in repo})
        save_user_repositories(list(by_id.values()))


def run_background_enabled_repository_refresh(task_id):
    try:
        repos = [repo for repo in load_pose_repositories() if repo.get("enabled", True)]
        if not repos:
            repository_progress_finish(task_id, "No enabled pose repositories to refresh.")
            return
        refreshed = []
        for index, repo in enumerate(repos):
            repository_progress_update(
                task_id,
                status="running",
                message=f"Refreshing {repo['repo_id']} ({index + 1}/{len(repos)})...",
                progress=(index / max(len(repos), 1)) * 100,
            )
            refreshed.append(refresh_pose_repository(repo, task_id=task_id))
        persist_refreshed_repositories(refreshed)
        failures = [f"{repo['repo_id']}: {repo['last_error']}" for repo in refreshed if repo.get("status") == "error"]
        if failures:
            repository_progress_fail(task_id, "; ".join(failures))
        else:
            repository_progress_finish(task_id, "Enabled pose repositories are up to date.")
    except Exception as exc:
        repository_progress_fail(task_id, exc)
    finally:
        with _BACKGROUND_REFRESH_LOCK:
            _BACKGROUND_REFRESH_STATE["running"] = False
            _BACKGROUND_REFRESH_STATE["last_finished"] = time.time()


def sanitize_pose_name(name):
    # Chinese-localized pose names use full-width punctuation (for example,
    # "站立（侧面）"). Keep safe filename punctuation so the scanned pose name
    # continues to match its JSON and preview filenames. Path separators and
    # Windows-reserved ASCII punctuation remain excluded.
    name = "".join(c for c in str(name or "") if c.isalnum() or c in "-_ （），、：；·").strip()
    return name


def sanitize_path_segment(value, fallback):
    value = str(value or "").strip() or fallback
    value = value.replace("\\", "_").replace("/", "_")
    value = "".join(c for c in value if c.isalnum() or c in "-_ .").strip(" .")
    return value or fallback


def repository_to_dir(repository):
    repository = str(repository or LOCAL_USER_REPOSITORY).strip() or LOCAL_USER_REPOSITORY
    if repository == LOCAL_USER_REPOSITORY:
        return LOCAL_USER_REPOSITORY
    return sanitize_path_segment(repository.replace("/", "__"), LOCAL_USER_REPOSITORY)


def validate_repository_directory(repo_id, repositories=None):
    repositories = load_pose_repositories() if repositories is None else repositories
    directory = repository_to_dir(repo_id).casefold()
    for other in [LOCAL_USER_REPOSITORY, *(repo["repo_id"] for repo in repositories)]:
        if other != repo_id and repository_to_dir(other).casefold() == directory:
            raise ValueError(f"Repository directory collision: {repo_id} and {other}")


def category_to_dir(category):
    return sanitize_path_segment(category or DEFAULT_CATEGORY, DEFAULT_CATEGORY)


def repository_dir_map():
    mapping = {LOCAL_USER_REPOSITORY: LOCAL_USER_REPOSITORY}
    for repo in load_pose_repositories():
        mapping[repository_to_dir(repo.get("repo_id"))] = repo.get("repo_id")
    return mapping


def get_pose_dir(repository, category):
    lib_path = get_library_path()
    repo_dir = repository_to_dir(repository)
    category_dir = category_to_dir(category)
    return os.path.join(lib_path, repo_dir, "poses", category_dir)


def get_pose_path(repository, category, name):
    return os.path.join(get_pose_dir(repository, category), f"{name}.json")


def read_pose_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_raw_library_meta(pose_data):
    if not isinstance(pose_data, dict):
        return {}
    return pose_data.get("_library") if isinstance(pose_data.get("_library"), dict) else {}


def normalize_library_tags(tags):
    if isinstance(tags, str):
        tags = [tag.strip() for tag in tags.split(",")]
    elif not isinstance(tags, list):
        tags = []
    normalized = []
    seen = set()
    for raw_tag in tags or []:
        tag = str(raw_tag).strip()
        if not tag:
            continue
        key = tag.casefold()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(tag)
    return normalized


def get_pose_meta(pose_data):
    if not isinstance(pose_data, dict):
        return {
            "repository": LOCAL_USER_REPOSITORY,
            "category": DEFAULT_CATEGORY,
            "tags": [],
        }
    meta = get_raw_library_meta(pose_data)
    repository = str(meta.get("repository") or LOCAL_USER_REPOSITORY).strip() or LOCAL_USER_REPOSITORY
    category = str(meta.get("category") or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY
    tags = normalize_library_tags(meta.get("tags") or [])
    return {
        "repository": repository,
        "category": category,
        "tags": tags,
    }


def set_pose_meta(pose_data, repository=None, category=None, tags=None):
    if not isinstance(pose_data, dict):
        return pose_data
    meta = pose_data.get("_library") if isinstance(pose_data.get("_library"), dict) else {}
    if repository is not None:
        meta["repository"] = str(repository or LOCAL_USER_REPOSITORY).strip() or LOCAL_USER_REPOSITORY
    if category is not None:
        meta["category"] = str(category or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY
    if tags is not None:
        meta["tags"] = normalize_library_tags(tags)
    else:
        meta["tags"] = normalize_library_tags(meta.get("tags") or [])
    pose_data["_library"] = meta
    return pose_data


def preview_candidates(folder_path, name):
    return [
        (os.path.join(folder_path, f"{name}.webp"), "image/webp"),
        (os.path.join(folder_path, f"{name}.jpg"), "image/jpeg"),
        (os.path.join(folder_path, f"{name}.jpeg"), "image/jpeg"),
        (os.path.join(folder_path, f"{name}.png"), "image/png"),
    ]


def find_preview(folder_path, name):
    for path, content_type in preview_candidates(folder_path, name):
        if os.path.exists(path):
            return path, content_type
    return None, None


def remove_previews(folder_path, name):
    for path, _ in preview_candidates(folder_path, name):
        if os.path.exists(path):
            os.remove(path)


def decode_preview_payload(preview_b64):
    if not preview_b64:
        return b"", ""
    mime_type = ""
    encoded = preview_b64
    if "," in preview_b64:
        header, encoded = preview_b64.split(",", 1)
        if header.startswith("data:"):
            mime_type = header[5:].split(";", 1)[0].strip().lower()
    try:
        return base64.b64decode(encoded, validate=True), mime_type
    except Exception as exc:
        raise ValueError("Preview payload is not valid base64") from exc


def prepare_image_preview_file(folder_path, raw):
    if len(raw) > MAX_PREVIEW_BYTES:
        raise ValueError("Preview image is too large")
    os.makedirs(folder_path, exist_ok=True)
    output_path = None
    try:
        with Image.open(io.BytesIO(raw)) as source:
            if source.width * source.height > MAX_PREVIEW_PIXELS:
                raise ValueError("Preview image dimensions are too large")
            image = source.convert("RGB")
        resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
        image.thumbnail((768, 768), resample)
        fd, output_path = tempfile.mkstemp(prefix="vnccs_preview_", suffix=".webp", dir=folder_path)
        os.close(fd)
        image.save(output_path, "WEBP", quality=76, method=6)
        return output_path, ".webp"
    except Exception as exc:
        if output_path and os.path.exists(output_path):
            os.remove(output_path)
        raise ValueError(f"Preview image could not be decoded: {exc}") from exc


def prepare_preview_file(folder_path, preview_b64):
    if not preview_b64:
        return None
    raw, mime_type = decode_preview_payload(preview_b64)
    return prepare_image_preview_file(folder_path, raw)


def normalize_request_repository(value):
    return str(value or LOCAL_USER_REPOSITORY).strip() or LOCAL_USER_REPOSITORY


def normalize_request_category(value):
    return str(value or DEFAULT_CATEGORY).strip() or DEFAULT_CATEGORY


def pose_file_location(path, pose_data, repo_map):
    parts = os.path.relpath(os.path.dirname(path), get_library_path()).split(os.sep)
    if parts == ["."]:
        parts = []
    meta = get_raw_library_meta(pose_data)
    typed = len(parts) >= 3 and parts[1] == "poses"
    repository = repo_map.get(parts[0], parts[0]) if parts else meta.get("repository") or LOCAL_USER_REPOSITORY
    category = meta.get("category") or (parts[2] if typed else parts[1] if len(parts) > 1 else DEFAULT_CATEGORY)
    return repository, category


def build_pose_record(name, path, pose_data, full_details=False, repository=None, category=None):
    meta = get_pose_meta(pose_data)
    repository = repository or meta.get("repository") or LOCAL_USER_REPOSITORY
    category = category or meta.get("category") or DEFAULT_CATEGORY
    preview_path, preview_type = find_preview(os.path.dirname(path), name)
    return {
        "id": f"{repository_to_dir(repository)}/poses/{category_to_dir(category)}/{name}",
        "name": name,
        "repository": repository,
        "repository_path": repository_to_dir(repository),
        "category": category,
        "category_path": category_to_dir(category),
        "tags": normalize_library_tags(meta["tags"]),
        "has_preview": preview_path is not None,
        "preview_type": preview_type,
        "preview_mtime": os.path.getmtime(preview_path) if preview_path else 0,
        "data": pose_data if full_details else None,
    }


def find_pose_file(name, repository=None, category=None):
    name = sanitize_pose_name(name)
    if not name:
        return None, None, None
    repo_map = repository_dir_map()
    if repository and category:
        target = get_pose_path(repository, category, name)
        try:
            found_repo, found_category = pose_file_location(target, read_pose_json(target), repo_map)
            if (found_repo, found_category) == (repository, category):
                return target, found_repo, found_category
        except Exception:
            pass
    matches = []
    for root, _dirs, files in walk_pose_library(get_library_path()):
        if f"{name}.json" not in files:
            continue
        path = os.path.join(root, f"{name}.json")
        try:
            data = read_pose_json(path)
        except Exception:
            continue
        found_repo, found_category = pose_file_location(path, data, repo_map)
        if repository and found_repo != repository or category and found_category != category:
            continue
        matches.append((path, found_repo, found_category))
    # New files take precedence over the same entity in the legacy layout.
    if repository and category:
        target = get_pose_path(repository, category, name)
        for match in matches:
            if match[0] == target:
                return match
    if len(matches) > 1:
        raise ValueError("Ambiguous pose; specify repository and category")
    return matches[0] if matches else (None, None, None)


def scan_poses(full_details=False):
    poses = {}
    lib_path = get_library_path()
    repo_map = repository_dir_map()
    states = {repo["repo_id"]: bool(repo.get("enabled", True)) for repo in load_pose_repositories()}
    states[LOCAL_USER_REPOSITORY] = True
    for root, _dirs, files in walk_pose_library(lib_path):
        for filename in files:
            if not filename.endswith(".json") or (filename in RESERVED_LIBRARY_JSON and (root == lib_path or os.path.dirname(root) == lib_path)):
                continue
            name = sanitize_pose_name(filename[:-5])
            if not name:
                continue
            path = os.path.join(root, filename)
            try:
                data = read_pose_json(path)
            except Exception:
                continue
            repository, category = pose_file_location(path, data, repo_map)
            if not states.get(repository, False):
                continue
            record = build_pose_record(name, path, data, full_details, repository, category)
            canonical = get_pose_path(repository, category, name)
            if record["id"] not in poses or path == canonical:
                poses[record["id"]] = record
    return sorted(poses.values(), key=lambda x: (x["repository"], x["category"], x["name"]))


def export_local_pose_library():
    """Build a portable ZIP containing local poses and their optional previews."""
    lib_path = get_library_path()
    local_root = os.path.join(lib_path, LOCAL_USER_REPOSITORY, "poses")
    items = []
    files = []
    if os.path.isdir(local_root):
        for root, _dirs, filenames in os.walk(local_root):
            for filename in sorted(filenames):
                if not filename.lower().endswith(".json"):
                    continue
                pose_path = os.path.join(root, filename)
                name = sanitize_pose_name(filename[:-5])
                if not name:
                    continue
                try:
                    data = read_pose_json(pose_path)
                except Exception:
                    continue
                _repository, category = pose_file_location(pose_path, data, {LOCAL_USER_REPOSITORY: LOCAL_USER_REPOSITORY})
                category_dir = category_to_dir(category)
                pose_member = f"poses/{category_dir}/{name}.json"
                item = {
                    "name": name,
                    "category": category,
                    "tags": get_pose_meta(data)["tags"],
                    "pose": pose_member,
                    "thumbnail": None,
                }
                files.append((pose_path, pose_member))
                preview_path, _preview_type = find_preview(root, name)
                if preview_path:
                    ext = os.path.splitext(preview_path)[1].lower()
                    thumbnail_member = f"poses/{category_dir}/{name}{ext}"
                    item["thumbnail"] = thumbnail_member
                    files.append((preview_path, thumbnail_member))
                items.append(item)

    manifest = {
        "format": "vnccs_pose_library",
        "schema_version": 1,
        "items": items,
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        for source, member in files:
            archive.write(source, member)
    return output.getvalue(), len(items)


def import_local_pose_library(raw_zip, dry_run=False):
    """Import a validated library archive, skipping existing local pose names."""
    if not isinstance(raw_zip, (bytes, bytearray)) or len(raw_zip) > MAX_LIBRARY_IMPORT_BYTES:
        raise ValueError("导入文件过大")
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw_zip), "r")
    except (zipfile.BadZipFile, OSError) as exc:
        raise ValueError("文件不是有效的姿势库 ZIP") from exc

    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_LIBRARY_IMPORT_FILES:
            raise ValueError("ZIP 文件包含过多条目")
        total_size = 0
        members = {}
        for info in infos:
            name = info.filename
            if info.is_dir():
                continue
            normalized = name.replace("\\", "/")
            parts = normalized.split("/")
            if normalized.startswith("/") or any(part in {"", ".", ".."} for part in parts):
                raise ValueError("ZIP 中包含不安全的文件路径")
            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                raise ValueError("ZIP 中不允许符号链接")
            if info.flag_bits & 0x1:
                raise ValueError("ZIP 中不允许加密文件")
            if normalized in members:
                raise ValueError("ZIP 中包含重复文件")
            total_size += int(info.file_size or 0)
            if total_size > MAX_LIBRARY_IMPORT_UNCOMPRESSED_BYTES:
                raise ValueError("ZIP 解压后体积过大")
            members[normalized] = info

        manifest_info = members.get("manifest.json")
        if not manifest_info or manifest_info.file_size > 8 * 1024 * 1024:
            raise ValueError("姿势库 ZIP 缺少有效清单")
        try:
            manifest = json.loads(archive.read(manifest_info).decode("utf-8"))
        except Exception as exc:
            raise ValueError("姿势库清单格式无效") from exc
        if not isinstance(manifest, dict) or manifest.get("format") != "vnccs_pose_library" or manifest.get("schema_version") != 1:
            raise ValueError("不支持此姿势库文件格式")
        items = manifest.get("items")
        if not isinstance(items, list) or len(items) > MAX_LIBRARY_IMPORT_FILES:
            raise ValueError("姿势库清单无效")

        expected_members = {"manifest.json"}
        prepared = []
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("姿势库清单包含无效项目")
            name = sanitize_pose_name(item.get("name"))
            category = str(item.get("category") or DEFAULT_CATEGORY).strip()
            category_dir = category_to_dir(category)
            if not name or name != str(item.get("name") or "").strip() or len(category) > 256:
                raise ValueError("姿势名称或分类无效")
            pose_member = f"poses/{category_dir}/{name}.json"
            if item.get("pose") != pose_member or pose_member not in members:
                raise ValueError(f"姿势文件缺失或路径无效：{name}")
            expected_members.add(pose_member)
            pose_info = members[pose_member]
            if pose_info.file_size > MAX_POSE_REPOSITORY_FILE_BYTES:
                raise ValueError(f"姿势文件过大：{name}")
            try:
                pose_data = json.loads(archive.read(pose_info).decode("utf-8"))
            except Exception as exc:
                raise ValueError(f"姿势数据无效：{name}") from exc
            if not isinstance(pose_data, dict) or not pose_data:
                raise ValueError(f"姿势数据无效：{name}")
            tags = normalize_library_tags(item.get("tags"))
            set_pose_meta(pose_data, repository=LOCAL_USER_REPOSITORY, category=category, tags=tags)

            thumbnail_member = item.get("thumbnail")
            thumbnail = None
            if thumbnail_member:
                if not isinstance(thumbnail_member, str):
                    raise ValueError(f"缩略图路径无效：{name}")
                ext = os.path.splitext(thumbnail_member)[1].lower()
                if ext not in {".webp", ".jpg", ".jpeg", ".png"} or thumbnail_member != f"poses/{category_dir}/{name}{ext}":
                    raise ValueError(f"缩略图路径无效：{name}")
                thumb_info = members.get(thumbnail_member)
                if not thumb_info or thumb_info.file_size > MAX_PREVIEW_BYTES:
                    raise ValueError(f"缩略图缺失或过大：{name}")
                thumbnail_bytes = archive.read(thumb_info)
                try:
                    with Image.open(io.BytesIO(thumbnail_bytes)) as image:
                        if image.width * image.height > MAX_PREVIEW_PIXELS:
                            raise ValueError("缩略图尺寸过大")
                        image.verify()
                except Exception as exc:
                    raise ValueError(f"缩略图无效：{name}") from exc
                thumbnail = (ext, thumbnail_bytes)
                expected_members.add(thumbnail_member)
            prepared.append((name, category, pose_data, thumbnail))

        if set(members) != expected_members:
            raise ValueError("ZIP 中包含清单以外的文件")

    if dry_run:
        return {"imported": 0, "skipped": 0, "total": len(prepared)}

    imported = 0
    skipped = 0
    created = []
    with _LIBRARY_SAVE_LOCK:
        try:
            for name, category, pose_data, thumbnail in prepared:
                pose_path = get_pose_path(LOCAL_USER_REPOSITORY, category, name)
                if os.path.exists(pose_path):
                    skipped += 1
                    continue
                pose_dir = os.path.dirname(pose_path)
                os.makedirs(pose_dir, exist_ok=True)
                preview_path = os.path.join(pose_dir, f"{name}{thumbnail[0]}") if thumbnail else None
                if preview_path and os.path.exists(preview_path):
                    skipped += 1
                    continue
                fd, staged_pose = tempfile.mkstemp(prefix="vnccs_import_pose_", suffix=".tmp", dir=pose_dir)
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(pose_data, handle, ensure_ascii=False, indent=2)
                staged_preview = None
                try:
                    if thumbnail:
                        fd, staged_preview = tempfile.mkstemp(prefix="vnccs_import_preview_", suffix=thumbnail[0], dir=pose_dir)
                        with os.fdopen(fd, "wb") as handle:
                            handle.write(thumbnail[1])
                    os.replace(staged_pose, pose_path)
                    created.append(pose_path)
                    if staged_preview:
                        os.replace(staged_preview, preview_path)
                        created.append(preview_path)
                    imported += 1
                finally:
                    for staged in (staged_pose, staged_preview):
                        if staged and os.path.exists(staged):
                            os.remove(staged)
        except Exception:
            for path in reversed(created):
                try:
                    os.remove(path)
                except OSError:
                    pass
            raise
    return {"imported": imported, "skipped": skipped, "total": len(prepared)}


def delete_pose(name, query):
    """DELETE /vnccs/pose_library/delete/{name} - Deletes a pose."""
    name = sanitize_pose_name(name)
    if not name:
        return ({"error": "Name required"}, 400)

    with _LIBRARY_SAVE_LOCK:
        try:
            pose_path, _repository, _category = find_pose_file(
                name, query.get("repository"), query.get("category"),
            )
        except ValueError as exc:
            return ({"error": str(exc)}, 400)
        if not pose_path or not os.path.exists(pose_path):
            return ({"error": "Pose not found"}, 404)

        os.remove(pose_path)
        remove_previews(os.path.dirname(pose_path), name)

    return ({"success": True}, 200)


def save_pose(data):
    """POST /vnccs/pose_library/save - Saves a pose with optional preview."""
    if not isinstance(data, dict):
        return ({"error": "Request must be an object"}, 400)
    name = data.get("name")
    old_name = sanitize_pose_name(data.get("old_name") or "")
    pose = data.get("pose")
    preview_b64 = data.get("preview")  # Optional base64 PNG
    repository = normalize_request_repository(data.get("repository") or LOCAL_USER_REPOSITORY)
    old_repository = data.get("old_repository") or repository
    category = normalize_request_category(data.get("category"))
    old_category = data.get("old_category") or category
    tags = data.get("tags")

    if tags is not None and not isinstance(tags, (str, list)):
        return ({"error": "tags must be a list or comma-separated string"}, 400)

    if repository != LOCAL_USER_REPOSITORY:
        return ({"error": "Downloaded library items are read-only. Save a copy in Local User Poses."}, 403)
    
    if not name or not isinstance(pose, dict) or not pose:
        return ({"error": "Name and pose required"}, 400)
    
    # Sanitize name
    name = sanitize_pose_name(name)
    if not name:
        return ({"error": "Invalid name"}, 400)
    
    pose_dir = get_pose_dir(repository, category)
    os.makedirs(pose_dir, exist_ok=True)
    pose_path = os.path.join(pose_dir, f"{name}.json")
    old_pose_path = None
    old_pose_dir = None
    try:
        if old_name:
            old_pose_path, _found_repo, _found_category = find_pose_file(old_name, old_repository, old_category)
    except ValueError as exc:
        return ({"error": str(exc)}, 400)
    old_pose_dir = os.path.dirname(old_pose_path) if old_pose_path else None

    pose = set_pose_meta(
        pose,
        repository=repository,
        category=category,
        tags=tags,
    )
    old_preview_path = None
    prepared_preview = None
    pose_tmp_path = None
    preview_target = None
    preview_backup_path = None
    preview_installed = False

    try:
        if preview_b64:
            prepared_preview = prepare_preview_file(
                pose_dir,
                preview_b64,
            )

        with _LIBRARY_SAVE_LOCK:
            # Check after preview preparation: another save may finish while it awaits.
            if old_name and old_repository == LOCAL_USER_REPOSITORY and (not old_pose_path or not os.path.exists(old_pose_path)):
                return ({"error": "The source library item was removed while saving"}, 409)
            if os.path.exists(pose_path) and (not old_pose_path or os.path.abspath(old_pose_path) != os.path.abspath(pose_path)):
                return ({"error": "A library item with this name already exists"}, 409)

            fd, pose_tmp_path = tempfile.mkstemp(prefix="vnccs_pose_", suffix=".tmp", dir=pose_dir)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(pose, f, indent=2)

            if old_pose_path and os.path.abspath(old_pose_path) != os.path.abspath(pose_path):
                old_preview_path, _ = find_preview(old_pose_dir, old_name)

            if not prepared_preview and old_preview_path:
                ext = os.path.splitext(old_preview_path)[1].lower() or ".webp"
                fd, staged = tempfile.mkstemp(prefix="vnccs_preview_", suffix=ext, dir=pose_dir)
                os.close(fd)
                prepared_preview = (staged, ext)
                shutil.copy2(old_preview_path, staged)

            if prepared_preview:
                preview_target = os.path.join(pose_dir, f"{name}{prepared_preview[1]}")
                if os.path.exists(preview_target):
                    fd, preview_backup_path = tempfile.mkstemp(prefix="vnccs_preview_backup_", dir=pose_dir)
                    os.close(fd)
                    shutil.copy2(preview_target, preview_backup_path)
                os.replace(prepared_preview[0], preview_target)
                preview_installed = True
                prepared_preview = None

            # shortcut: write errors roll back; use a manifest-based item format if crash recovery is required.
            try:
                os.replace(pose_tmp_path, pose_path)
            except Exception:
                if preview_installed:
                    if preview_backup_path:
                        backup = preview_backup_path
                        preview_backup_path = None  # Keep the backup if restoring it also fails.
                        os.replace(backup, preview_target)
                    else:
                        os.remove(preview_target)
                raise
            pose_tmp_path = None

            obsolete = []
            if preview_installed:
                obsolete.extend(path for path, _ in preview_candidates(pose_dir, name) if path != preview_target)
            if old_pose_path and old_repository == LOCAL_USER_REPOSITORY and os.path.abspath(old_pose_path) != os.path.abspath(pose_path):
                obsolete.append(old_pose_path)
                obsolete.extend(path for path, _ in preview_candidates(old_pose_dir, old_name))
            for path in obsolete:
                try:
                    if os.path.exists(path):
                        os.remove(path)
                except OSError:
                    pass  # The new item is committed; keep an obsolete file rather than fail the save.
    except ValueError as exc:
        message = str(exc)
        status = 413 if "too large" in message.lower() or "exceeds" in message.lower() else 400
        return ({"error": message}, status)
    except Exception as exc:
        return ({"error": f"Failed to save pose: {exc}"}, 400)
    finally:
        leftovers = [pose_tmp_path, preview_backup_path]
        if prepared_preview:
            leftovers.append(prepared_preview[0])
        for leftover in leftovers:
            if leftover:
                try:
                    os.remove(leftover)
                except Exception:
                    pass

    return ({
        "success": True,
        "name": name,
        "repository": repository,
        "category": category,
        "id": f"{repository_to_dir(repository)}/poses/{category_to_dir(category)}/{name}",
        "path": os.path.relpath(pose_path, get_library_path()),
    }, 200)


def get_pose(name, query):
    """GET /vnccs/pose_library/get/{name} - Returns pose data and preview."""
    name = sanitize_pose_name(name)
    if not name:
        return ({"error": "Name required"}, 400)

    repository = query.get("repository")
    category = query.get("category")
    try:
        pose_path, found_repository, found_category = find_pose_file(name, repository, category)
    except ValueError as exc:
        return ({"error": str(exc)}, 400)
    if not pose_path or not os.path.exists(pose_path):
        return ({"error": "Pose not found"}, 404)

    pose_data = read_pose_json(pose_path)
    preview_path, preview_type = find_preview(os.path.dirname(pose_path), name)

    preview_b64 = None
    if preview_path and os.path.exists(preview_path):
        with open(preview_path, "rb") as f:
            preview_b64 = base64.b64encode(f.read()).decode("utf-8")

    meta = get_pose_meta(pose_data)
    return ({
        "name": name,
        "repository": found_repository or meta.get("repository") or LOCAL_USER_REPOSITORY,
        "category": found_category or meta.get("category") or DEFAULT_CATEGORY,
        "pose": pose_data,
        "preview": preview_b64,
        "preview_type": preview_type,
        "tags": meta["tags"],
    }, 200)


def get_preview(name, query):
    name = sanitize_pose_name(name)
    if not name:
        return None, None, 400
    try:
        pose_path, _repository, _category = find_pose_file(
            name, query.get("repository"), query.get("category"),
        )
    except ValueError as exc:
        return {"error": str(exc)}, None, 400
    if not pose_path:
        return None, None, 404
    preview_path, content_type = find_preview(os.path.dirname(pose_path), name)
    if not preview_path or not os.path.exists(preview_path):
        return None, None, 404
    with open(preview_path, "rb") as handle:
        return handle.read(), content_type, 200
