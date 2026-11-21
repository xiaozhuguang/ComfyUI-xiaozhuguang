"""进程内存中的视频分段缓存，供批处理合并节点和状态 API 共用。"""

from threading import RLock


_LOCK = RLock()
_SEGMENTS = {}


def _safe_node_id(node_id):
    return "".join(c if c not in '\\/:*?\"<>|' else "_" for c in str(node_id))


def reset_segments():
    with _LOCK:
        _SEGMENTS.clear()


def append_segment(node_id, image, audio, fps, info, directory=None):
    key = str(node_id or "")
    with _LOCK:
        items = _SEGMENTS.setdefault(key, [])
        entry = dict(info)
        entry["index"] = len(items) + 1
        entry["filename"] = f"memory_{entry['index']:05d}"
        items.append({"image": image, "audio": audio, "fps": float(fps), "info": entry,
                      "directory": directory})
        return dict(entry)


def get_segments(node_id):
    with _LOCK:
        return list(_SEGMENTS.get(str(node_id or ""), ()))


def active_segment_directories():
    with _LOCK:
        return {item["directory"] for items in _SEGMENTS.values() for item in items
                if item["directory"] is not None}


def clear_node_segments(node_id):
    with _LOCK:
        _SEGMENTS.pop(str(node_id or ""), None)


def list_segments():
    with _LOCK:
        by_node = {}
        for node_id, items in _SEGMENTS.items():
            safe_node_id = _safe_node_id(node_id)
            infos = [dict(item["info"]) for item in items]
            by_node[safe_node_id] = {
                "count": len(infos),
                "files": [info["filename"] for info in infos],
                "segments": infos,
            }
        files = [f"{node_id}/{filename}" for node_id, info in by_node.items()
                 for filename in info["files"]]
        return {"count": len(files), "files": files, "byNode": by_node, "storage": "memory"}
