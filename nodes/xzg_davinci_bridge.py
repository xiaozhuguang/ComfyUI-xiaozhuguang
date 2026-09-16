"""
达芬奇（DaVinci Resolve）外部脚本桥接层（Windows Studio 版）

通过 DaVinciResolveScript 连接本机已运行的 Resolve Studio，读取当前时间线上
播放头所在片段，并触发渲染导出该片段。作为独立进程由 ComfyUI 后端路由以
subprocess 方式调用（环境变量隔离，避免污染 ComfyUI 主进程 Python 环境）。

用法：
    python xzg_davinci_bridge.py '{"action":"status"}'
    python xzg_davinci_bridge.py '{"action":"export","out_dir":"...","name":"...","mode":"video"}'
结果以 JSON 输出到 stdout。

action=status :  返回达芬奇连接状态与当前片段信息（不触发任何改动）
action=export :  触发达芬奇渲染导出当前播放头所在片段为 H.264/MP4 视频

注意：
- 需要 Resolve Studio 已启动（Studio 版才支持外部脚本接口）
- Preferences > 系统配置 > 外部脚本使用 需设为「本地(Local)」
"""

import json
import os
import sys
import time


# ═══════════════════════════════════════════════════════════════════════════
# 达芬奇安装探测
# ═══════════════════════════════════════════════════════════════════════════


def _drive_letters():
    import string
    for c in string.ascii_uppercase:
        if os.path.isdir(c + ":\\"):
            yield c + ":\\"


def detect_resolve_paths():
    """探测达芬奇安装根目录、脚本 API 目录、fusionscript 库路径。返回 dict。

    达芬奇不保证装在 C 盘（如 D:\\Program Files\\Blackmagic Design\\DaVinci Resolve），
    因此扫描所有固定盘的常见安装位置，并用 fusionscript.dll 的存在来确认真实安装。
    """
    root = None
    root_candidates = []
    for drv in _drive_letters():
        for base in (
            "Blackmagic Design\\DaVinci Resolve",
            "Program Files\\Blackmagic Design\\DaVinci Resolve",
            "Program Files (x86)\\Blackmagic Design\\DaVinci Resolve",
            "Programs\\Blackmagic Design\\DaVinci Resolve",
        ):
            root_candidates.append(os.path.join(drv, base))
    for cand in root_candidates:
        if os.path.isfile(os.path.join(cand, "fusionscript.dll")) or \
           os.path.isfile(os.path.join(cand, "Resolve.exe")):
            root = cand
            break

    # 兜底：跨盘递归扫一次 fusionscript.dll（限定 Blackmagic Design 相关路径，避免全盘扫）
    if root is None:
        import glob
        found = set()
        for drv in _drive_letters():
            for pat in (
                drv + "**\\fusionscript.dll",
                drv + "*\\Blackmagic Design\\**\\fusionscript.dll",
            ):
                try:
                    for h in glob.glob(pat, recursive=True):
                        if h.lower().replace("/", "\\").endswith("fusionscript.dll"):
                            found.add(h)
                except Exception:
                    continue
        if found:
            # 优先选「Program Files...\DaVinci Resolve\fusionscript.dll」这种根形态，否则选路径最短
            ranked = sorted(found, key=lambda x: (0 if "\\DaVinci Resolve\\" in x else 1, len(x)))
            root = os.path.dirname(ranked[0])

    api_dir = None
    api_candidates = [os.path.expandvars(
        r"%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting")]
    for drv in _drive_letters():
        api_candidates.append(os.path.join(
            drv, "ProgramData", "Blackmagic Design", "DaVinci Resolve",
            "Support", "Developer", "Scripting"))
    for c in api_candidates:
        if os.path.isdir(os.path.join(c, "Modules")):
            api_dir = c
            break

    fslib = None
    if root:
        for rel in ("fusionscript.dll", r"Fusion\fusionscript.dll"):
            p = os.path.join(root, rel)
            if os.path.isfile(p) and fslib is None:
                fslib = p
    return {"root": root, "api_dir": api_dir, "fslib": fslib}


def ensure_script_importable(paths):
    """把达芬奇脚本 Modules 目录加入 sys.path，并设置 fusionscript 库环境变量。"""
    if not paths.get("api_dir"):
        return False
    modules = os.path.join(paths["api_dir"], "Modules")
    if modules not in sys.path:
        sys.path.insert(0, modules)
    if paths.get("fslib"):
        os.environ["RESOLVE_SCRIPT_LIB"] = paths["fslib"]
    return os.path.isdir(modules)


# ═══════════════════════════════════════════════════════════════════════════
# 连接与查询
# ═══════════════════════════════════════════════════════════════════════════


def _connect():
    """连接已运行的 Resolve。失败返回 (None, 错误信息)。"""
    paths = detect_resolve_paths()
    if not paths.get("root"):
        return None, "未找到 DaVinci Resolve 安装目录"
    if not ensure_script_importable(paths):
        return None, "未找到 DaVinci Resolve 脚本 API 目录（Developer/Scripting/Modules）"
    try:
        import DaVinciResolveScript as dvr_script
    except ImportError as e:
        return None, f"无法导入 DaVinciResolveScript：{e}"
    try:
        resolve = dvr_script.scriptapp("Resolve")
    except Exception as e:
        return None, f"连接 Resolve 失败：{e}"
    if resolve is None:
        return None, "Resolve 未运行 或 外部脚本权限未开启（需 Studio 版并设为 Local）"
    return resolve, None


def _tc_to_frames(tc, fps):
    """把 00:00:00:00（或 ; 分隔）时码换算为帧数。解析失败返回 None。"""
    try:
        parts = str(tc).replace(";", ":").split(":")
        if len(parts) != 4:
            return None
        h, m, s, f = (int(x) for x in parts)
        return int((h * 3600 + m * 60 + s) * fps + f)
    except Exception:
        return None


def _timeline_start_frames(timeline, fps):
    """时间线起点时码对应的帧数（项目时码不从 00:00:00:00 开始时用）。默认 0。"""
    for key in ("timelineStartTimecode", "timelinePlaybackStartTimecode"):
        try:
            v = timeline.GetSetting(key)
            if v:
                fr = _tc_to_frames(v, fps)
                if fr is not None:
                    return fr
        except Exception:
            continue
    return 0


def current_video_item(timeline):
    """返回播放头所在视频片段（TimelineItem）。优先按播放头帧定位。

    注意 GetCurrentVideoItem() 返回的是「当前选中片段」而非播放头下的片段，
    因此以播放头帧扫描为准，扫描失败才回退到选中片段。
    播放头相对帧 = 当前时码帧 - 时间线起点时码帧（GetStart/GetEnd 是相对帧）。
    """
    try:
        fps = float(timeline.GetSetting("timelineFrameRate") or 0)
        if fps > 0:
            tc = timeline.GetCurrentTimecode() or ""
            playhead = _tc_to_frames(tc, fps)
            if playhead is not None:
                playhead -= _timeline_start_frames(timeline, fps)
                n = timeline.GetTrackCount("video")
                # 上层轨道优先（遮挡关系），同一轨道内取覆盖播放头的片段
                for idx in range(n, 0, -1):
                    for it in timeline.GetItemListInTrack("video", idx):
                        s = int(it.GetStart())
                        e = int(it.GetEnd())
                        if s <= playhead < e:
                            return it, "FrameScan"
    except Exception:
        pass

    # 兜底：GetCurrentVideoItem（选中片段）
    try:
        item = timeline.GetCurrentVideoItem()
        if item is not None:
            return item, "GetCurrentVideoItem"
    except Exception:
        pass
    return None, "NoClip"


def _pick_render_codec(project):
    """在达芬奇 GetRenderFormats/GetRenderCodecs 里挑选 H.264/MP4 格式/编码。
    返回 (format, codec) 字符串；找不到用 mp4/H.264 兜底。"""
    formats = {}
    try:
        formats = project.GetRenderFormats() or {}
    except Exception:
        formats = {}
    # 视频：优先 H.264/MP4
    for fmt, ext in formats.items():
        if str(ext).lower() == "mp4":
            codecs = project.GetRenderCodecs(fmt) or {}
            for disp, codec in codecs.items():
                name = f"{disp} {codec}".lower()
                if "h264" in name.replace(".", "").replace(" ", "") or "h.264" in name:
                    return fmt, codec
    return "mp4", "H.264"


def _render_export(project, timeline, item, out_dir, name):
    """触发达芬奇渲染导出当前片段为视频。返回 (文件名, 扩展名) 或抛异常。"""
    os.makedirs(out_dir, exist_ok=True)
    fmt, codec = _pick_render_codec(project)

    start = int(item.GetStart())
    end = int(item.GetEnd())
    # 至少导出一帧，防止 0 长度
    if end <= start:
        end = start + 1
    clip_name = None
    try:
        clip_name = item.GetName()
    except Exception:
        pass
    safe_name = "".join(c for c in (name or ("xzg_dv_" + str(int(time.time()))))
                        if c not in '<>:"/\\|?*').strip() or "xzg_dv_export"

    project.SetCurrentRenderFormatAndCodec(fmt, codec)
    project.SetRenderSettings({
        "TargetDir": out_dir,
        "CustomName": safe_name,
        "ExportVideo": True,
        "ExportAudio": True,
        "MarkIn": start,
        "MarkOut": end,
        "SelectAllFrames": False,
    })

    job_id = None
    try:
        job_id = project.AddRenderJob()
    except Exception as e:
        raise RuntimeError(f"AddRenderJob 失败：{e}")
    if job_id is None:
        # 某些版本 AddRenderJob 默认不使用——需显式触发可用 job
        job_id = project.AddRenderJob()

    started = project.StartRendering(job_id)
    if started is False:
        # 容错：部分 render 队列入口不接受 job id 参数
        res = project.StartRendering()
        if res is False:
            raise RuntimeError("StartRendering 失败，请检查渲染设置")

    # 轮询等待渲染完成（同步阻塞）
    # 达芬奇不同版本对 job 状态的返回值差异较大，
    # 因此以「渲染状态=完成」或「目标文件已落盘且大小稳定约 2 秒」任一为准，避免死等。
    def _matching_size():
        best = -1
        try:
            for f in os.listdir(out_dir):
                fp = os.path.join(out_dir, f)
                if os.path.isfile(fp) and f.startswith(safe_name):
                    try:
                        sz = os.path.getsize(fp)
                        best = max(best, sz)
                    except Exception:
                        pass
        except Exception:
            pass
        return best

    deadline = time.time() + 60 * 30  # 30 分钟超时保护
    last_status = {}
    last_len = -1
    stable_cnt = 0
    while time.time() < deadline:
        try:
            last_status = project.GetRenderJobStatus(job_id) or {}
        except Exception:
            last_status = {}
        status = last_status.get("CompleteStatus", "")
        if status == "Complete":
            break
        if status in ("Error", "Failed"):
            raise RuntimeError(f"渲染失败：{last_status}")

        # 目标文件稳定兜底：连续 ~2 秒（0.4s * 5）大小不变即认为渲染落盘完成
        sz = _matching_size()
        if sz < 0:
            last_len = -1
            stable_cnt = 0
        else:
            if sz == last_len:
                stable_cnt += 1
                if stable_cnt >= 5:
                    break
            else:
                last_len = sz
                stable_cnt = 0
        time.sleep(0.4)
    else:
        raise TimeoutError("达芬奇渲染超时（30 分钟）")

    # 找出刚生成的文件（CustomName 前缀 + 最新 mtime）
    found = None
    try:
        cands = []
        for f in os.listdir(out_dir):
            fp = os.path.join(out_dir, f)
            if not os.path.isfile(fp):
                continue
            base = os.path.splitext(f)[0]
            if base == safe_name or base.startswith(safe_name):
                cands.append((os.path.getmtime(fp), f))
        cands.sort(key=lambda x: x[0], reverse=True)
        if cands:
            found = cands[0][1]
    except Exception:
        found = None

    if not found:
        raise RuntimeError(f"未找到渲染产物（{safe_name}*）。作业状态：{last_status}")
    return found, os.path.splitext(found)[1].lstrip(".")


def action_status():
    resolve, err = _connect()
    if resolve is None:
        return {"ok": False, "error": err}
    try:
        pm = resolve.GetProjectManager()
        project = pm.GetCurrentProject() if pm else None
    except Exception:
        project = None
    result = {"ok": True, "running": True}
    if project is None:
        result["error"] = "已连接达芬奇，但未打开项目"
        result["project"] = None
        return result
    result["project"] = project.GetName() or ""
    try:
        tl = project.GetCurrentTimeline()
    except Exception:
        tl = None
    if tl is None:
        result["timeline"] = None
        return result
    result["timeline"] = tl.GetName() or ""
    item, how = current_video_item(tl)
    if item is None:
        result["clip"] = None
        result["clip_note"] = "当前播放头下无视频片段"
    else:
        result["clip"] = item.GetName() or ""
        result["clip_start"] = int(item.GetStart())
        result["clip_end"] = int(item.GetEnd())
        result["frame_method"] = how
        try:
            result["fps"] = float(tl.GetSetting("timelineFrameRate") or 0)
        except Exception:
            result["fps"] = 0
    return result


def action_export(pargs):
    out_dir = pargs.get("out_dir") or ""
    name = pargs.get("name") or ("xzg_dv_" + str(int(time.time() * 1000)))
    if not out_dir:
        return {"ok": False, "error": "缺少 out_dir"}

    resolve, err = _connect()
    if resolve is None:
        return {"ok": False, "error": err}
    try:
        pm = resolve.GetProjectManager()
        project = pm.GetCurrentProject() if pm else None
    except Exception:
        project = None
    if project is None:
        return {"ok": False, "error": "未打开达芬奇项目"}
    try:
        tl = project.GetCurrentTimeline()
    except Exception:
        tl = None
    if tl is None:
        return {"ok": False, "error": "未打开时间线"}
    item, how = current_video_item(tl)
    if item is None:
        return {"ok": False, "error": "当前播放头下无视频片段，请先把播放头置于要导出的片段上"}
    try:
        filename, ext = _render_export(project, tl, item, out_dir, name)
    except Exception as e:
        return {"ok": False, "error": f"导出失败：{e}"}

    # 导出完成后切回调色页（导出会切换到 Deliver/交付页，回调色页方便继续调色）
    switch_back = pargs.get("switch_back", True)
    if switch_back:
        try:
            resolve.OpenPage("color")
        except Exception:
            pass

    # 返回包含 clip 信息，方便插件显示"从哪段导入"
    clip_info = None
    try:
        clip_info = {
            "name": item.GetName() or "",
            "start": int(item.GetStart()),
            "end": int(item.GetEnd()),
        }
    except Exception:
        pass
    return {"ok": True, "mode": "video", "filename": filename, "ext": ext,
            "clip": clip_info, "frame_method": how}


def main(argv):
    # 参数来源：stdin（推荐，避免 shell 引号转义）> argv[0] JSON > 纯 action 字符串
    payload = None
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    except Exception:
        raw = ""
    if raw and raw.strip():
        try:
            payload = json.loads(raw.strip())
        except Exception:
            payload = {"action": raw.strip()}
    if payload is None and argv:
        try:
            payload = json.loads(argv[0])
        except Exception:
            payload = {"action": str(argv[0])}
    if not payload:
        payload = {"action": "status"}
    return _dispatch(payload)


def _dispatch(payload):
    action = payload.get("action") or "status"
    import traceback
    try:
        if action == "status":
            result = action_status()
        elif action == "export":
            result = action_export(payload)
        else:
            result = {"ok": False, "error": f"未知 action：{action}"}
    except Exception as e:
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        result["traceback"] = traceback.format_exc()
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])