"""
达芬奇（DaVinci Resolve）外部脚本桥接层（Windows Studio 版）

通过 DaVinciResolveScript 连接本机已运行的 Resolve Studio，读取当前时间线上
播放头所在片段，并触发渲染导出该片段。作为独立进程由 ComfyUI 后端路由以
subprocess 方式调用（环境变量隔离，避免污染 ComfyUI 主进程 Python 环境）。

用法：
    python xzg_davinci_bridge.py '{"action":"status"}'
    python xzg_davinci_bridge.py '{"action":"export","out_dir":"...","name":"...","mode":"video"}'
    python xzg_davinci_bridge.py '{"action":"import","file_path":".../x.mp4"}'
    python xzg_davinci_bridge.py '{"action":"import_audio","file_path":".../x.mp3"}'
结果以 JSON 输出到 stdout。

action=status :  返回达芬奇连接状态与当前片段信息（不触发任何改动）
action=export :  触发达芬奇渲染导出当前播放头所在片段为 H.264/MP4 视频
action=import :  把本地视频导入当前项目：ImportMedia 进媒体池，AddTrack 新建视频轨道，
                 再把片段落到新轨道并对齐当前播放头所在最上层片段的前端（不推移/不分割）

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


def longest_audio_at_playhead(timeline):
    """返回播放头所在位置「所有音频轨道中时长最长」的音频片段。

    供音频导出使用：与 longest_video_at_playhead 同逻辑，扫描 audio 轨道。
    返回 (item, "LongestAudioAtPlayhead")；无音频片段返回 (None, "NoAudioClip")。
    """
    try:
        fps = float(timeline.GetSetting("timelineFrameRate") or 0)
        if fps > 0:
            tc = timeline.GetCurrentTimecode() or ""
            playhead = _tc_to_frames(tc, fps)
            if playhead is not None:
                playhead -= _timeline_start_frames(timeline, fps)
                n = timeline.GetTrackCount("audio")
                best = None
                best_span = -1
                for idx in range(1, n + 1):
                    for it in (timeline.GetItemListInTrack("audio", idx) or []):
                        s = int(it.GetStart())
                        e = int(it.GetEnd())
                        if s <= playhead < e:
                            span = e - s
                            if span > best_span:
                                best_span = span
                                best = it
                if best is not None:
                    return best, "LongestAudioAtPlayhead"
    except Exception:
        pass
    return None, "NoAudioClip"


def longest_video_at_playhead(timeline):
    """返回播放头所在位置「所有轨道中时长最长」的视频片段。

    供剪辑页导出使用：当播放头处叠加了多个轨道的片段时，取跨轨道中
    时长最长的那个（按入点/出点跨度计算），保证导出覆盖完整素材。
    返回 (item, "LongestAtPlayhead")；无片段返回 (None, "NoClip")。
    """
    try:
        fps = float(timeline.GetSetting("timelineFrameRate") or 0)
        if fps > 0:
            tc = timeline.GetCurrentTimecode() or ""
            playhead = _tc_to_frames(tc, fps)
            if playhead is not None:
                playhead -= _timeline_start_frames(timeline, fps)
                n = timeline.GetTrackCount("video")
                best = None
                best_span = -1
                for idx in range(1, n + 1):
                    for it in timeline.GetItemListInTrack("video", idx):
                        s = int(it.GetStart())
                        e = int(it.GetEnd())
                        if s <= playhead < e:
                            span = e - s
                            if span > best_span:
                                best_span = span
                                best = it
                if best is not None:
                    return best, "LongestAtPlayhead"
    except Exception:
        pass
    # 兜底：退化为播放头所在最上层片段
    item, idx = topmost_video_at_playhead(timeline)
    if item is not None:
        return item, "LongestAtPlayhead(topmost fallback)"
    return None, "NoClip"


def topmost_video_at_playhead(timeline):
    """返回播放头所在位置「最上面」的视频片段。

    叠加的多个视频片段会被拆到不同轨道，最上层（trackIndex 最大）即用户肉眼可见的顶层。
    返回 (item, trackIndex) 或 (None, None)：trackIndex 为轨道序号（1 起），
    item.GetStart() 为其前端起始帧（相对帧）。播放头帧换算与 current_video_item 一致。
    """
    try:
        fps = float(timeline.GetSetting("timelineFrameRate") or 0)
        if fps > 0:
            tc = timeline.GetCurrentTimecode() or ""
            playhead = _tc_to_frames(tc, fps)
            if playhead is not None:
                playhead -= _timeline_start_frames(timeline, fps)
                n = timeline.GetTrackCount("video")
                # 从最上层往下找，取第一个覆盖播放头的片段
                for idx in range(n, 0, -1):
                    for it in timeline.GetItemListInTrack("video", idx):
                        s = int(it.GetStart())
                        e = int(it.GetEnd())
                        if s <= playhead < e:
                            return it, idx
    except Exception:
        pass
    return None, None


def topmost_audio_at_playhead(timeline):
    """返回播放头所在位置「最上面」的音频片段。

    与 topmost_video_at_playhead 同语义，扫描 audio 轨道：从最上层往下找，
    返回第一个覆盖播放头的音频片段。返回 (item, trackIndex) 或 (None, None)。
    供音频导入判断「播放头处是否已有音频」及其前端对齐帧。
    """
    try:
        fps = float(timeline.GetSetting("timelineFrameRate") or 0)
        if fps > 0:
            tc = timeline.GetCurrentTimecode() or ""
            playhead = _tc_to_frames(tc, fps)
            if playhead is not None:
                playhead -= _timeline_start_frames(timeline, fps)
                n = timeline.GetTrackCount("audio")
                for idx in range(n, 0, -1):
                    for it in (timeline.GetItemListInTrack("audio", idx) or []):
                        s = int(it.GetStart())
                        e = int(it.GetEnd())
                        if s <= playhead < e:
                            return it, idx
    except Exception:
        pass
    return None, None

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

    found = _start_and_wait_render(project, out_dir, safe_name)
    return found, os.path.splitext(found)[1].lstrip(".")


def _find_render_file(out_dir, safe_name):
    """按 CustomName 前缀 + 最新 mtime 找刚生成的渲染产物；没有返回 None。"""
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
            return cands[0][1]
    except Exception:
        pass
    return None


def _try_audio_render(project, out_dir, safe_name, start, end, codec, wait_s=30):
    """尝试一次纯音频渲染（对齐达芬奇交付页手动流程：关掉导出视频 → 音频标签选格式）。

    codec: AudioCodec 值（None 表示不指定，沿用容器默认）。
    单次等待 wait_s 秒：产出文件 → 等大小稳定后返回文件名；
    作业 Error/Failed 或超时无产出 → 取消作业并返回 None
    （设置无效时达芬奇会立即报「请选择一个有效的渲染路径」且不产出文件）。
    """
    try:
        settings = {
            "TargetDir": out_dir,
            "CustomName": safe_name,
            "ExportVideo": False,
            "ExportAudio": True,
            "MarkIn": start,
            "MarkOut": end,
            "SelectAllFrames": False,
        }
        if codec:
            settings["AudioCodec"] = codec
        project.SetRenderSettings(settings)
        job_id = project.AddRenderJob()
        if job_id is None:
            return None
        started = project.StartRendering(job_id)
        if started is False:
            res = project.StartRendering()
            if res is False:
                return None
        deadline = time.time() + wait_s
        while time.time() < deadline:
            try:
                st = (project.GetRenderJobStatus(job_id) or {}).get("CompleteStatus", "")
            except Exception:
                st = ""
            if st in ("Error", "Failed"):
                return None
            found = _find_render_file(out_dir, safe_name)
            if found:
                # 等大小稳定（~1.2s），避免读到半截文件
                sz0 = -1
                for _ in range(3):
                    try:
                        sz = os.path.getsize(os.path.join(out_dir, found))
                    except Exception:
                        sz = -1
                    if sz == sz0 and sz > 0:
                        break
                    sz0 = sz
                    time.sleep(0.4)
                return found
            time.sleep(0.4)
        # 超时无产出：取消作业，避免占用渲染队列
        try:
            project.StopRendering()
            project.DeleteRenderJob(job_id)
        except Exception:
            pass
        return None
    except Exception:
        return None


def _start_and_wait_render(project, out_dir, safe_name):
    """添加渲染作业、启动并同步等待完成，返回产物文件名。

    以「渲染状态=完成」或「目标文件已落盘且大小稳定约 2 秒」任一为准，避免死等。
    供视频/音频两种导出复用。超时（30 分钟）或渲染失败抛异常。
    """
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
    found = _find_render_file(out_dir, safe_name)
    if not found:
        raise RuntimeError(f"未找到渲染产物（{safe_name}*）。作业状态：{last_status}")
    return found


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

    # 判断当前界面：剪辑页走「播放头 + 多轨道取最长片段」逻辑，否则走调色页当前片段
    current_page = ""
    try:
        current_page = str(resolve.GetCurrentPage() or "").lower()
    except Exception:
        current_page = ""
    is_edit = "edit" in current_page or current_page == ""

    item, how = None, ""
    if is_edit:
        item, how = longest_video_at_playhead(tl)
    else:
        item, how = current_video_item(tl)
    if item is None:
        return {"ok": False, "error": "当前播放头下无视频片段，请先把播放头置于要导出的片段上"}
    try:
        filename, ext = _render_export(project, tl, item, out_dir, name)
    except Exception as e:
        return {"ok": False, "error": f"导出失败：{e}"}

    # 导出会切换到 Deliver/交付页；按需求停留在导出前的当前界面。
    # 记录导出前页面，完成后切回（剪辑页就停留回剪辑页）。
    switch_back = pargs.get("switch_back", True)
    if switch_back and current_page:
        try:
            resolve.OpenPage(current_page)
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
            "clip": clip_info, "frame_method": how, "page": current_page or "unknown"}


def action_export_audio(pargs):
    """导出当前播放头所在片段的音频。

    片段选择：优先音频轨道播放头片段；音频轨道没有则用视频片段（导出其音轨）。
    渲染策略：对齐达芬奇交付页手动流程「关掉导出视频 → 音频标签选格式」，
    依次尝试纯音频渲染（AudioCodec：flac → wav → wave → 不指定，
    不同达芬奇版本的枚举拼写不同），全部失败再回退整段渲染（含音频），
    由调用方（ComfyUI 后端路由）用 ffmpeg 抽取音频。
    返回 { ok, mode:"audio", filename, ext, is_audio_only, audio_codec, source, clip }
    """
    out_dir = pargs.get("out_dir") or ""
    name = pargs.get("name") or ("xzg_dv_a_" + str(int(time.time() * 1000)))
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

    current_page = ""
    try:
        current_page = str(resolve.GetCurrentPage() or "").lower()
    except Exception:
        current_page = ""
    is_edit = "edit" in current_page or current_page == ""

    # 片段选择：优先音频轨道播放头片段；音频轨道没有则用视频片段（导出其音轨）
    item, how = longest_audio_at_playhead(tl)
    source = "audio_track"
    if item is None:
        if is_edit:
            item, how = longest_video_at_playhead(tl)
        else:
            item, how = current_video_item(tl)
        source = "video_clip_audio"
    if item is None:
        return {"ok": False, "error": "当前播放头下无音频/视频片段，请先把播放头置于要导出的片段上"}

    os.makedirs(out_dir, exist_ok=True)
    start = int(item.GetStart())
    end = int(item.GetEnd())
    if end <= start:
        end = start + 1
    safe_name = "".join(c for c in (name or ("xzg_dv_a_" + str(int(time.time()))))
                        if c not in '<>:"/\\|?*').strip() or "xzg_dv_a_export"

    # 渲染导出：对齐达芬奇交付页手动流程「关掉导出视频 → 音频标签选格式（如 FLAC）」，
    # 依次尝试纯音频渲染（AudioCodec 候选：flac / wav / wave / 不指定——
    # 不同达芬奇版本的枚举拼写不同），单个候选 30 秒内未产出文件即判失败
    # （设置无效时达芬奇会立即报「请选择一个有效的渲染路径」且不产出文件）；
    # 全部失败再回退整段视频渲染（含音频），由调用方（后端路由）用 ffmpeg 抽取音频。
    produced = None
    used_codec = None
    for codec in ("flac", "wav", "wave", None):
        produced = _try_audio_render(project, out_dir, safe_name, start, end, codec)
        if produced:
            used_codec = codec or "auto"
            break
    if produced:
        is_audio_only = True
    else:
        try:
            produced, _ext = _render_export(project, tl, item, out_dir, name)
            is_audio_only = False
        except Exception as e:
            return {"ok": False, "error": f"导出失败：{e}"}

    # 导出会切换到 Deliver/交付页；完成后切回导出前界面
    if pargs.get("switch_back", True) and current_page:
        try:
            resolve.OpenPage(current_page)
        except Exception:
            pass

    clip_info = None
    try:
        clip_info = {
            "name": item.GetName() or "",
            "start": int(item.GetStart()),
            "end": int(item.GetEnd()),
        }
    except Exception:
        pass
    return {"ok": True, "mode": "audio",
            "filename": produced,
            "ext": os.path.splitext(produced)[1].lstrip(".").lower(),
            "is_audio_only": is_audio_only,
            "audio_codec": used_codec,
            "source": source, "frame_method": how,
            "clip": clip_info, "page": current_page or "unknown"}


def find_blank_video_track(timeline, after_track=0, track_type="video"):
    """返回一个「整条时间线无任何片段」的空白轨道序号，优先复用不新建。

    - track_type：轨道类型（"video" / "audio"），音频导入复用同一逻辑
    - after_track>0 时，仅返回序号大于该轨道的空白轨道（即播放头最上层片段之上的空隙层）
    - 没有则返回 None
    """
    try:
        n = timeline.GetTrackCount(track_type)
    except Exception:
        return None
    for idx in range(after_track + 1, n + 1):
        try:
            items = timeline.GetItemListInTrack(track_type, idx) or []
            if len(items) == 0:
                return idx
        except Exception:
            continue
    return None


def action_import(pargs):
    """把 ComfyUI 生成的视频导入达芬奇当前项目的时间线。

    行为（严格对齐需求）：
    - ImportMedia 进当前媒体池（不建子夹）
    - 播放头处有片段：优先复用「播放头最上层片段之上、且整条时间线无片段的空白视频轨道」，
      完全没有空白轨道时才 AddTrack 新建（不刻意新建轨道）
    - 播放头处无片段：自动以当前播放头帧为起点，直接放入 V1 轨道（不新建/不找空白轨道）
    - AppendToTimeline 落到目标轨道；不插入缝隙、不推移、不分割其他轨道
    返回 { ok, clip, track, record_frame, project, timeline }
    """
    file_path = pargs.get("file_path") or ""
    if not file_path:
        return {"ok": False, "error": "缺少 file_path"}
    if not os.path.isfile(file_path):
        return {"ok": False, "error": f"文件不存在：{file_path}"}

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
        project_name = project.GetName() or ""
        media_pool = project.GetMediaPool()
    except Exception as e:
        return {"ok": False, "error": f"获取媒体池失败：{e}"}
    if media_pool is None:
        return {"ok": False, "error": "无法获取媒体池"}

    # 1) 导入媒体池。ImportMedia 返回 MediaPoolItem 列表；单个文件传列表最稳。
    try:
        imported = media_pool.ImportMedia([file_path])
    except Exception as e:
        return {"ok": False, "error": f"ImportMedia 失败：{e}"}
    if not imported:
        return {"ok": False, "error": "ImportMedia 无返回，可能文件格式不被支持，或媒体池刷新延迟后再试"}
    item = imported[0] if isinstance(imported, (list, tuple)) else imported

    # 2) 获取当前时间线
    try:
        tl = project.GetCurrentTimeline()
    except Exception:
        tl = None
    if tl is None:
        return {"ok": False, "error": "未打开时间线，请在剪辑页打开一条时间线再导入"}
    try:
        timeline_name = tl.GetName() or ""
    except Exception:
        timeline_name = ""
    # 记录导入前播放头时码，导入完成后再恢复，避免播放头跳到新片段末尾
    try:
        orig_playhead_tc = tl.GetCurrentTimecode() or ""
    except Exception:
        orig_playhead_tc = ""

    # 3) 定位：优先取播放头所在最上层片段的前端；播放头处无片段时以播放头帧为起点
    src_item, src_track = topmost_video_at_playhead(tl)
    how_placed = "blank_track"
    if src_item is not None:
        try:
            record_frame = int(src_item.GetStart())
        except Exception as e:
            return {"ok": False, "error": f"读取片段起始帧失败：{e}"}
    else:
        # 播放头处无片段：以当前播放头帧为起点
        try:
            fps = float(tl.GetSetting("timelineFrameRate") or 0)
            if fps <= 0:
                return {"ok": False, "error": "无法读取时间线帧率"}
            tc = tl.GetCurrentTimecode() or ""
            playhead = _tc_to_frames(tc, fps)
            if playhead is None:
                return {"ok": False, "error": "无法解析当前播放头时码"}
            record_frame = playhead - _timeline_start_frames(tl, fps)
            src_track = 0
            how_placed = "playhead_start"
        except Exception as e:
            return {"ok": False, "error": f"读取播放头位置失败：{e}"}

    # 4) 目标轨道：
    #    - 播放头处有片段：复用播放头最上层片段之上的空白轨道；没有则新建
    #    - 播放头处无片段：直接放入 V1（不新建、不找空白轨道，避免无谓新增轨道）
    if src_track > 0:
        target_track = find_blank_video_track(tl, after_track=src_track)
        if target_track is None:
            how_placed = "new_track"
            try:
                n_before = tl.GetTrackCount("video")
                added = tl.AddTrack("video")
                target_track = int(added) if added and not isinstance(added, bool) else (n_before + 1)
            except Exception as e:
                return {"ok": False, "error": f"AddTrack 新增视频轨道失败：{e}"}
    else:
        target_track = 1
        how_placed = "track_v1"

    # 5) AppendToTimeline 落到目标轨道，recordFrame 对齐 src_item 前端
    try:
        clip = item.GetClipProperty("Frames")
        end_frame = int(float(clip)) - 1 if clip else None
    except Exception:
        end_frame = None
    desc = {
        "mediaPoolItem": item,
        "startFrame": 0,
        "mediaType": 1,
        "trackIndex": target_track,
        "recordFrame": record_frame,
    }
    if end_frame is not None:
        desc["endFrame"] = end_frame
    try:
        ok_append = media_pool.AppendToTimeline([desc])
    except Exception as e:
        return {"ok": False, "error": f"AppendToTimeline 失败：{e}"}
    if not ok_append:
        return {"ok": False, "error": "AppendToTimeline 返回失败，请检查轨道/落点"}

    # 恢复导入前播放头位置（AppendToTimeline 会把播放头移到新片段末尾）
    if orig_playhead_tc:
        try:
            tl.SetCurrentTimecode(orig_playhead_tc)
        except Exception:
            pass

    return {
        "ok": True,
        "action": "import",
        "project": project_name,
        "timeline": timeline_name,
        "clip": os.path.basename(file_path),
        "track": target_track,
        "record_frame": record_frame,
        "src_track": src_track,
        "placed": how_placed,
    }


def action_import_audio(pargs):
    """把 ComfyUI 生成的音频导入达芬奇当前项目的时间线（音频轨道）。

    行为（不覆盖现有音频）：
    - ImportMedia 进当前媒体池（不建子夹）
    - 对齐点以「音频轨道」为准：播放头处已有音频片段时，对齐该音频片段前端；
      播放头处无音频片段时以当前播放头帧为起点
    - 目标轨道（不覆盖现有音频）：无论播放头处是否已有音频，都优先复用
      「整条时间线无任何片段」的空白音频轨道；有现成空白轨道就直接利用
      （不重复新建），确实没有才 AddTrack 新建
    - AppendToTimeline 落轨（mediaType=2 音频）；不插入缝隙、不推移、不分割
    - 完成后恢复导入前播放头位置
    返回 { ok, clip, track, record_frame, project, timeline, placed }
    """
    file_path = pargs.get("file_path") or ""
    if not file_path:
        return {"ok": False, "error": "缺少 file_path"}
    if not os.path.isfile(file_path):
        return {"ok": False, "error": f"文件不存在：{file_path}"}

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
        project_name = project.GetName() or ""
        media_pool = project.GetMediaPool()
    except Exception as e:
        return {"ok": False, "error": f"获取媒体池失败：{e}"}
    if media_pool is None:
        return {"ok": False, "error": "无法获取媒体池"}

    # 1) 导入媒体池。ImportMedia 返回 MediaPoolItem 列表；单个文件传列表最稳。
    try:
        imported = media_pool.ImportMedia([file_path])
    except Exception as e:
        return {"ok": False, "error": f"ImportMedia 失败：{e}"}
    if not imported:
        return {"ok": False, "error": "ImportMedia 无返回，可能文件格式不被支持，或媒体池刷新延迟后再试"}
    item = imported[0] if isinstance(imported, (list, tuple)) else imported

    # 2) 获取当前时间线
    try:
        tl = project.GetCurrentTimeline()
    except Exception:
        tl = None
    if tl is None:
        return {"ok": False, "error": "未打开时间线，请在剪辑页打开一条时间线再导入"}
    try:
        timeline_name = tl.GetName() or ""
    except Exception:
        timeline_name = ""
    # 记录导入前播放头时码，导入完成后再恢复，避免播放头跳到新片段末尾
    try:
        orig_playhead_tc = tl.GetCurrentTimecode() or ""
    except Exception:
        orig_playhead_tc = ""

    # 3) 对齐点：以「音频轨道」为准——取播放头所在最上层音频片段的前端；
    #    播放头处无音频片段时以当前播放头帧为起点。
    #    （用户要求：播放头处有音频就对齐该音频片段前端，而非视频片段）
    src_item, src_track = topmost_audio_at_playhead(tl)
    how_placed = "blank_track"
    if src_item is not None:
        try:
            record_frame = int(src_item.GetStart())
        except Exception as e:
            return {"ok": False, "error": f"读取音频片段起始帧失败：{e}"}
    else:
        try:
            fps = float(tl.GetSetting("timelineFrameRate") or 0)
            if fps <= 0:
                return {"ok": False, "error": "无法读取时间线帧率"}
            tc = tl.GetCurrentTimecode() or ""
            playhead = _tc_to_frames(tc, fps)
            if playhead is None:
                return {"ok": False, "error": "无法解析当前播放头时码"}
            record_frame = playhead - _timeline_start_frames(tl, fps)
            src_track = 0
            how_placed = "playhead_start"
        except Exception as e:
            return {"ok": False, "error": f"读取播放头位置失败：{e}"}

    # 4) 目标音频轨道（不覆盖现有音频）：
    #    无论播放头处是否已有音频，都先复用整条时间线无任何片段的空白音频轨道；
    #    有现成空白轨道就直接利用（不重复新建），确实没有空白轨道时才 AddTrack 新建。
    #    （对齐点已在第 3 步按「有音频→片段前端 / 无音频→播放头帧」处理好）
    target_track = find_blank_video_track(tl, track_type="audio")
    if target_track is None:
        how_placed = "new_track"
        try:
            n_before = tl.GetTrackCount("audio")
            added = tl.AddTrack("audio")
            target_track = int(added) if added and not isinstance(added, bool) else (n_before + 1)
        except Exception as e:
            return {"ok": False, "error": f"AddTrack 新增音频轨道失败：{e}"}
    else:
        how_placed = "blank_track"

    # 5) AppendToTimeline 落到目标音频轨道，recordFrame 对齐片段前端
    #    （mediaType：1=视频 2=音频；音频无需 endFrame，默认到片段末尾）
    try:
        desc = {
            "mediaPoolItem": item,
            "startFrame": 0,
            "mediaType": 2,
            "trackIndex": target_track,
            "recordFrame": record_frame,
        }
        ok_append = media_pool.AppendToTimeline([desc])
    except Exception as e:
        return {"ok": False, "error": f"AppendToTimeline 失败：{e}"}
    if not ok_append:
        return {"ok": False, "error": "AppendToTimeline 返回失败，请检查音频轨道/落点"}

    # 恢复导入前播放头位置（AppendToTimeline 会把播放头移到新片段末尾）
    if orig_playhead_tc:
        try:
            tl.SetCurrentTimecode(orig_playhead_tc)
        except Exception:
            pass

    return {
        "ok": True,
        "action": "import_audio",
        "project": project_name,
        "timeline": timeline_name,
        "clip": os.path.basename(file_path),
        "track": target_track,
        "record_frame": record_frame,
        "src_track": src_track,
        "placed": how_placed,
    }


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
        elif action == "export_audio":
            result = action_export_audio(payload)
        elif action == "import":
            result = action_import(payload)
        elif action == "import_audio":
            result = action_import_audio(payload)
        else:
            result = {"ok": False, "error": f"未知 action：{action}"}
    except Exception as e:
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        result["traceback"] = traceback.format_exc()
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])