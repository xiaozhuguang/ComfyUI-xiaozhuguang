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


def _capture_playhead_timecode(timeline):
    try:
        return timeline.GetCurrentTimecode() or ""
    except Exception:
        return ""


def _restore_playhead_timecode(timeline, timecode):
    if not timecode:
        return False
    normalized = str(timecode).replace(";", ":")
    for _ in range(2):
        try:
            timeline.SetCurrentTimecode(timecode)
            current = timeline.GetCurrentTimecode() or ""
            if str(current).replace(";", ":") == normalized:
                return True
        except Exception:
            continue
    return False


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
    # 视频：优先 H.264/MP4。Resolve 不同版本的 codec 字典键/值格式并不完全一致，
    # 找不到 H.264 时使用 MP4 下第一个有效视频编码，避免传入硬编码的无效 codec id。
    for fmt, ext in formats.items():
        if str(ext).lower().lstrip(".") == "mp4":
            try:
                codecs = project.GetRenderCodecs(fmt) or {}
            except Exception:
                codecs = {}
            for disp, codec in codecs.items():
                name = f"{disp} {codec}".lower()
                if "h264" in name.replace(".", "").replace(" ", "") or "h.264" in name:
                    return fmt, codec
            if codecs:
                return fmt, next(iter(codecs.values()))
    raise RuntimeError(f"达芬奇没有可用的 MP4 视频格式/编码：{formats or '无法读取格式列表'}")


def _render_export(project, timeline, item, out_dir, name, resolve=None):
    """导出带画面的视频片段（并包含原片音频），返回文件名和扩展名。"""
    os.makedirs(out_dir, exist_ok=True)
    # Activate Deliver before loading the preset. Loading it from Edit only
    # changes the queued-job metadata in Resolve 21.1; the visible Export Video
    # toggle remains off and the resulting MP4 can contain audio only.
    if resolve is not None:
        try:
            page_opened = resolve.OpenPage("deliver")
        except Exception as e:
            raise RuntimeError(f"无法先激活达芬奇交付页：{e}")
        if page_opened is False:
            raise RuntimeError("达芬奇未能先激活交付页，未提交视频渲染任务")
        time.sleep(1.0)
    # H.264 Master also enables video, but it selects QuickTime/MOV on this
    # installation. Start from the MP4-capable YouTube preset, then set the
    # requested MP4/H.264 options explicitly below.
    try:
        presets = project.GetRenderPresetList() or []
        video_preset = next(
            (preset for preset in presets
             if str(preset).strip().lower() == "youtube - 1080p"),
            None,
        )
        if video_preset is None:
            raise RuntimeError("未找到达芬奇内置的 YouTube - 1080p 视频预设")
        preset_loaded = project.LoadRenderPreset(video_preset)
    except Exception as e:
        raise RuntimeError(f"无法加载视频导出预设以启用交付面板的“导出视频”：{e}")
    if preset_loaded is False:
        raise RuntimeError("达芬奇拒绝加载 YouTube - 1080p 视频预设，未提交渲染任务")

    fmt, codec = _pick_render_codec(project)
    try:
        selected = project.SetCurrentRenderFormatAndCodec(fmt, codec)
    except Exception as e:
        raise RuntimeError(f"达芬奇无法激活 MP4/H.264：{e}")
    if selected is False:
        raise RuntimeError("达芬奇拒绝 MP4/H.264 设置，未提交渲染任务")

    # 0 = Individual Clips, 1 = Single Clip. The importer exports one range
    # from the active timeline, so do not inherit a previous Deliver mode.
    try:
        mode_selected = project.SetCurrentRenderMode(1)
    except Exception as e:
        raise RuntimeError(f"达芬奇无法设置单个片段渲染模式：{e}")
    if mode_selected is False:
        raise RuntimeError("达芬奇拒绝单个片段渲染模式，未提交渲染任务")

    try:
        audio_codecs = project.GetAudioRenderCodecs("mp4") or {}
    except Exception as e:
        raise RuntimeError(f"无法读取 MP4 音频编码列表：{e}")
    aac_codec = next(
        (value for label, value in audio_codecs.items()
         if "aac" in f"{label} {value}".lower()),
        None,
    )
    if not aac_codec:
        raise RuntimeError(f"达芬奇未提供 MP4/AAC 组合：{audio_codecs or '音频编码列表为空'}")

    try:
        width = int(timeline.GetSetting("timelineResolutionWidth"))
        height = int(timeline.GetSetting("timelineResolutionHeight"))
        frame_rate = float(timeline.GetSetting("timelineFrameRate"))
        supported_resolutions = project.GetRenderResolutions(fmt, codec) or []
    except Exception as e:
        raise RuntimeError(f"无法读取时间线分辨率或 MP4/H.264 输出能力：{e}")
    if width <= 0 or height <= 0 or frame_rate <= 0:
        raise RuntimeError(f"时间线分辨率/帧率无效：{width}×{height} @ {frame_rate}")
    if not any(int(r.get("Width", 0)) == width and int(r.get("Height", 0)) == height
               for r in supported_resolutions if isinstance(r, dict)):
        raise RuntimeError(
            f"MP4/H.264 不支持当前时间线分辨率 {width}×{height}；"
            f"达芬奇返回的可用分辨率：{supported_resolutions}。未提交渲染任务。"
        )

    start = int(item.GetStart())
    end = int(item.GetEnd())
    # 至少导出一帧，防止 0 长度
    if end <= start:
        end = start + 1
    safe_name = "".join(c for c in (name or ("xzg_dv_" + str(int(time.time()))))
                        if c not in '<>:"/\\|?*').strip() or "xzg_dv_export"

    settings_ok = project.SetRenderSettings({
        "TargetDir": out_dir,
        "CustomName": safe_name,
        "ExportVideo": True,
        "ExportAudio": True,
        "AudioCodec": aac_codec,
        "EncodingProfile": "High",
        "NetworkOptimization": False,
        "FormatWidth": width,
        "FormatHeight": height,
        "FrameRate": frame_rate,
        "MarkIn": start,
        "MarkOut": end,
        "SelectAllFrames": False,
    })
    if settings_ok is False:
        raise RuntimeError("达芬奇拒绝 MP4/H.264 High + AAC 设置（视频与音频均开启），未提交渲染任务")

    found = _start_and_wait_render(project, out_dir, safe_name)
    ext = os.path.splitext(found)[1].lstrip(".").lower()
    if ext != "mp4":
        raise RuntimeError(f"达芬奇未按指定的 MP4/H.264 格式生成文件（实际：.{ext or '未知'}），已阻止加载")
    return found, ext


def _find_render_file(out_dir, safe_name, since=None):
    """按 CustomName 前缀 + 最新 mtime 找刚生成的渲染产物；没有返回 None。"""
    try:
        cands = []
        for f in os.listdir(out_dir):
            fp = os.path.join(out_dir, f)
            if not os.path.isfile(fp):
                continue
            if since is not None and os.path.getmtime(fp) < since:
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


def _try_audio_render(project, out_dir, safe_name, start, end, audio_format,
                      audio_codec=None, wait_s=1800):
    """通过 Resolve 音频渲染 API 显式选择格式，只提交一个纯音频任务。"""
    settings = {
        "TargetDir": out_dir,
        "CustomName": safe_name,
        "ExportVideo": False,
        "ExportAudio": True,
        "AudioFormat": audio_format,
        "MarkIn": start,
        "MarkOut": end,
        "SelectAllFrames": False,
    }
    if audio_codec:
        settings["AudioCodec"] = audio_codec
    try:
        accepted = project.SetRenderSettings(settings)
    except Exception as e:
        raise RuntimeError(f"达芬奇无法设置纯音频导出选项：{e}")
    if accepted is False:
        raise RuntimeError("达芬奇未接受“关闭视频、开启音频”的导出设置，未提交渲染任务")

    # 只建一个 job，失败时不再用无参数 StartRendering() 启动队列中的其他任务。
    try:
        job_id = project.AddRenderJob()
    except Exception as e:
        raise RuntimeError(f"添加单个音频渲染任务失败：{e}")
    if job_id is None:
        raise RuntimeError("达芬奇没有创建音频渲染任务")
    try:
        started = project.StartRendering(job_id)
    except Exception as e:
        started = False
        start_error = str(e)
    else:
        start_error = ""
    if started is False:
        try:
            project.DeleteRenderJob(job_id)
        except Exception:
            pass
        raise RuntimeError(f"达芬奇未能启动音频渲染任务：{start_error or 'StartRendering 返回失败'}")

    render_started_at = time.time()
    deadline = render_started_at + wait_s
    while time.time() < deadline:
        try:
            status = project.GetRenderJobStatus(job_id) or {}
        except Exception:
            status = {}
        # Resolve 21.1 returns JobStatus (Running / Complete / Failed). Some
        # API builds expose the older CompleteStatus key, so accept both.
        complete = status.get("CompleteStatus") or status.get("JobStatus", "")
        if complete in ("Error", "Failed", "Cancelled", "Stopped"):
            try:
                project.DeleteRenderJob(job_id)
            except Exception:
                pass
            raise RuntimeError(f"达芬奇音频渲染失败：{status}")
        if complete == "Complete":
            # 文件名前缀包含本次请求的唯一时间戳；不用文件 mtime 作门槛，
            # 避免 Windows 文件时间精度导致刚生成的 FLAC 被误判为旧文件。
            found = _find_render_file(out_dir, safe_name)
            if not found:
                raise RuntimeError("达芬奇报告音频渲染完成，但没有找到输出文件")
            # 确认文件大小稳定，避免向后续流程交付尚未写完的文件。
            previous_size = -1
            stable = 0
            for _ in range(10):
                try:
                    current_size = os.path.getsize(os.path.join(out_dir, found))
                except OSError:
                    current_size = -1
                if current_size > 0 and current_size == previous_size:
                    stable += 1
                    if stable >= 2:
                        return found
                else:
                    stable = 0
                previous_size = current_size
                time.sleep(0.4)
            if previous_size > 0:
                return found
            raise RuntimeError("达芬奇生成的音频文件为空")
        time.sleep(0.4)

    try:
        project.StopRendering()
    except Exception:
        pass
    try:
        project.DeleteRenderJob(job_id)
    except Exception:
        pass
    raise TimeoutError(f"达芬奇音频渲染超时（{wait_s} 秒）；任务已停止，不会自动重试")


def _start_and_wait_render(project, out_dir, safe_name):
    """只创建并启动一个渲染任务；失败不启动队列里的其他任务。"""
    try:
        job_id = project.AddRenderJob()
    except Exception as e:
        raise RuntimeError(f"AddRenderJob 失败：{e}")
    if job_id is None:
        raise RuntimeError("达芬奇没有创建视频渲染任务")

    # Verify the queued job itself (the panel may retain prior audio-only state).
    try:
        jobs = project.GetRenderJobs() or []
        queued = next(
            (job for job in jobs.values() if job.get("JobId") == job_id),
            None,
        ) if isinstance(jobs, dict) else next(
            (job for job in jobs if job.get("JobId") == job_id),
            None,
        )
    except Exception as e:
        try:
            project.DeleteRenderJob(job_id)
        except Exception:
            pass
        raise RuntimeError(f"无法核实达芬奇视频渲染任务的导出选项：{e}")
    if queued is None or not queued.get("IsExportVideo"):
        try:
            project.DeleteRenderJob(job_id)
        except Exception:
            pass
        raise RuntimeError(
            f"达芬奇渲染任务未确认开启视频导出，已取消任务：{queued or '无法读取任务设置'}"
        )

    try:
        started = project.StartRendering(job_id)
    except Exception as e:
        started = False
        start_error = str(e)
    else:
        start_error = ""
    if started is False:
        try:
            project.DeleteRenderJob(job_id)
        except Exception:
            pass
        raise RuntimeError(f"达芬奇未启动视频渲染任务：{start_error or 'StartRendering 返回失败'}")

    deadline = time.time() + 60 * 30
    while time.time() < deadline:
        try:
            status = project.GetRenderJobStatus(job_id) or {}
        except Exception:
            status = {}
        # Resolve 21.1 returns JobStatus (Running / Complete / Failed). Some
        # API builds expose the older CompleteStatus key, so accept both.
        complete = status.get("CompleteStatus") or status.get("JobStatus", "")
        if complete in ("Error", "Failed", "Cancelled", "Stopped"):
            try:
                project.DeleteRenderJob(job_id)
            except Exception:
                pass
            raise RuntimeError(f"视频渲染失败：{status}")
        if complete == "Complete":
            found = _find_render_file(out_dir, safe_name)
            if not found:
                raise RuntimeError(f"达芬奇报告渲染完成，但没有找到视频文件（{safe_name}*）")
            previous_size = -1
            stable_count = 0
            for _ in range(10):
                try:
                    size = os.path.getsize(os.path.join(out_dir, found))
                except OSError:
                    size = -1
                if size > 0 and size == previous_size:
                    stable_count += 1
                    if stable_count >= 2:
                        return found
                else:
                    stable_count = 0
                previous_size = size
                time.sleep(0.4)
            if previous_size > 0:
                return found
            raise RuntimeError("达芬奇生成的视频文件为空")
        time.sleep(0.4)

    try:
        project.StopRendering()
    except Exception:
        pass
    try:
        project.DeleteRenderJob(job_id)
    except Exception:
        pass
    raise TimeoutError("达芬奇视频渲染超时（30 分钟）；任务已停止，不会自动重试")


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
    original_playhead_tc = _capture_playhead_timecode(tl)

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
    switch_back = pargs.get("switch_back", True)
    render_error = None
    filename = ext = None
    try:
        filename, ext = _render_export(project, tl, item, out_dir, name, resolve=resolve)
    except Exception as e:
        render_error = e
    finally:
        # Export/render can move the timeline playhead even when the page is
        # restored, so restore the exact source timecode after restoring page.
        if switch_back and current_page:
            try:
                resolve.OpenPage(current_page)
            except Exception:
                pass
        _restore_playhead_timecode(tl, original_playhead_tc)
    if render_error is not None:
        return {"ok": False, "error": f"导出失败：{render_error}"}

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
    """仅导出达芬奇播放头所在的音频轨道片段。

    不读取或修改时间线入出点；播放头下没有音频片段时直接报错。
    渲染策略：对齐达芬奇交付页手动流程「关掉导出视频 → 音频标签选格式」，
    按 FLAC/WAV 纯音频格式渲染。
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
    original_playhead_tc = _capture_playhead_timecode(tl)
    item, how = longest_audio_at_playhead(tl)
    if item is None:
        return {"ok": False, "error": "达芬奇播放头下没有音频轨道片段，请将播放头移到要导入的音频片段上"}
    source = "audio_track"
    start = int(item.GetStart())
    end = int(item.GetEnd())

    os.makedirs(out_dir, exist_ok=True)
    if end <= start:
        end = start + 1
    safe_name = "".join(c for c in (name or ("xzg_dv_a_" + str(int(time.time()))))
                        if c not in '<>:"/\\|?*').strip() or "xzg_dv_a_export"

    # 固定通过 Resolve 21.1+ 音频渲染接口使用 FLAC；不切换视频格式/编码，
    # FLAC 不可用或设置失败时直接返回错误，不回退格式，也不重复渲染。
    audio_formats = {}
    try:
        audio_formats = project.GetAudioRenderFormats() or {}
    except Exception as e:
        return {"ok": False, "error": f"当前达芬奇未提供音频格式查询 API：{e}；未提交渲染任务。"}
    flac_format = next(
        ((fmt, ext) for fmt, ext in audio_formats.items()
         if str(ext).lower().lstrip(".") == "flac"),
        None,
    )
    if flac_format is None:
        return {"ok": False, "error": "达芬奇当前没有提供 FLAC 音频格式，未提交渲染任务。"}
    fmt, expected_ext = flac_format
    try:
        codecs = project.GetAudioRenderCodecs(expected_ext) or {}
    except Exception as e:
        return {"ok": False, "error": f"无法读取达芬奇 FLAC 编码选项：{e}；未提交渲染任务。"}
    # 有些音频格式（包括当前版本的 FLAC）不再暴露独立 codec，AudioFormat 已足够。
    used_codec = next(iter(codecs.values()), None)
    render_error = None
    produced = None
    try:
        produced = _try_audio_render(project, out_dir, safe_name, start, end,
                                     expected_ext, audio_codec=used_codec)
    except Exception as e:
        render_error = e
    finally:
        # Rendering can move the timeline playhead. Restore the original page
        # and timecode before returning, including when rendering fails.
        if pargs.get("switch_back", True) and current_page:
            try:
                resolve.OpenPage(current_page)
            except Exception:
                pass
        _restore_playhead_timecode(tl, original_playhead_tc)
    if render_error is not None:
        return {"ok": False, "error": str(render_error)}
    actual_ext = os.path.splitext(produced)[1].lstrip(".").lower()
    if actual_ext != str(expected_ext).lstrip(".").lower():
        return {"ok": False, "error": f"达芬奇设置为 {expected_ext}，实际产物为 {actual_ext or '未知格式'}；已停止，不会重复渲染"}
    is_audio_only = True

    clip_info = None
    if item is not None:
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
            "ext": actual_ext,
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

    # 在媒体池导入和落轨前按真实源路径查重，避免重复点击产生重复媒体或时间线片段。
    try:
        tl = project.GetCurrentTimeline()
    except Exception:
        tl = None
    if tl is None:
        return {"ok": False, "error": "未打开时间线，请在剪辑页打开一条时间线再导入"}
    orig_playhead_tc = _capture_playhead_timecode(tl)
    duplicate_track, duplicate_item = _timeline_source_match(tl, file_path, "video")
    if duplicate_item is None:
        duplicate_track, duplicate_item = _timeline_source_match(tl, file_path, "audio")
    if duplicate_item is not None:
        try:
            duplicate_clip = duplicate_item.GetName() or os.path.basename(file_path)
            duplicate_frame = int(duplicate_item.GetStart())
        except Exception:
            duplicate_clip = os.path.basename(file_path)
            duplicate_frame = None
        return {"ok": True, "action": "import", "duplicate": True,
                "message": "该视频已导出到当前时间线，未重复导入。",
                "clip": duplicate_clip, "track": duplicate_track,
                "record_frame": duplicate_frame}

    # 1) 导入媒体池。ImportMedia 返回 MediaPoolItem 列表；单个文件传列表最稳。
    try:
        imported = media_pool.ImportMedia([file_path])
    except Exception as e:
        return {"ok": False, "error": f"ImportMedia 失败：{e}"}
    if not imported:
        return {"ok": False, "error": "ImportMedia 无返回，可能文件格式不被支持，或媒体池刷新延迟后再试"}
    item = imported[0] if isinstance(imported, (list, tuple)) else imported
    _restore_playhead_timecode(tl, orig_playhead_tc)

    # 2) 使用查重阶段获取的当前时间线
    try:
        timeline_name = tl.GetName() or ""
    except Exception:
        timeline_name = ""
    # 记录导入前播放头时码，导入完成后再恢复，避免播放头跳到新片段末尾
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
        _restore_playhead_timecode(tl, orig_playhead_tc)
        return {"ok": False, "error": f"AppendToTimeline 失败：{e}"}
    if not ok_append:
        _restore_playhead_timecode(tl, orig_playhead_tc)
        return {"ok": False, "error": "AppendToTimeline 返回失败，请检查轨道/落点"}

    # 音视频一起（默认）：视频落轨后，把该视频自带的音频也追加到音频轨道，对齐同一 recordFrame。
    # 始终将视频文件中的音轨一并导入，与视频片段保持同步（不覆盖现有音频）：
    #   播放头处已有音频片段 → 在其上方找整条空白音频轨、没有才新建；
    #   播放头处无音频 → 直接落 A1。视频本身无音轨时追加失败，静默忽略。
    try:
        _a_src_item, _a_src_track = topmost_audio_at_playhead(tl)
        if _a_src_track and _a_src_track > 0:
            a_target = find_blank_video_track(tl, after_track=_a_src_track, track_type="audio")
            if a_target is None:
                try:
                    _n_before = tl.GetTrackCount("audio")
                    _added = tl.AddTrack("audio")
                    a_target = int(_added) if _added and not isinstance(_added, bool) else (_n_before + 1)
                except Exception:
                    a_target = None
            if not a_target:
                a_target = 1
        else:
            try:
                if tl.GetTrackCount("audio") < 1:
                    tl.AddTrack("audio")
            except Exception:
                pass
            a_target = 1
        audio_desc = {
            "mediaPoolItem": item,
            "startFrame": 0,
            "mediaType": 2,
            "trackIndex": a_target,
            "recordFrame": record_frame,
        }
        media_pool.AppendToTimeline([audio_desc])
    except Exception as _e:
        print(f"[小珠光达芬奇] 附加音频到音频轨道失败（可能该视频无音轨）：{_e}")

    # 恢复导入前播放头位置（AppendToTimeline 会把播放头移到新片段末尾）
    _restore_playhead_timecode(tl, orig_playhead_tc)

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


def _timeline_source_match(timeline, file_path, track_type):
    """Return (track, item) when this exact media path is already on a timeline track."""
    wanted = os.path.normcase(os.path.abspath(file_path))
    try:
        track_count = int(timeline.GetTrackCount(track_type) or 0)
    except Exception:
        return None, None
    for track_idx in range(1, track_count + 1):
        try:
            items = timeline.GetItemListInTrack(track_type, track_idx) or []
        except Exception:
            continue
        for timeline_item in items:
            try:
                media_item = timeline_item.GetMediaPoolItem()
            except Exception:
                media_item = None
            if media_item is None:
                continue
            properties = {}
            try:
                properties = media_item.GetClipProperty() or {}
            except Exception:
                pass
            source_path = ""
            if isinstance(properties, dict):
                for key in ("File Path", "File path", "FilePath"):
                    if properties.get(key):
                        source_path = str(properties[key])
                        break
            if not source_path:
                try:
                    source_path = str(media_item.GetClipProperty("File Path") or "")
                except Exception:
                    pass
            if source_path and os.path.normcase(os.path.abspath(source_path)) == wanted:
                return track_idx, timeline_item
    return None, None


def _timeline_audio_source_match(timeline, file_path):
    return _timeline_source_match(timeline, file_path, "audio")


def action_import_audio(pargs):
    """把 ComfyUI 生成的音频导入达芬奇当前项目的时间线（音频轨道）。

    行为（不覆盖现有音频）：
    - ImportMedia 进当前媒体池（不建子夹）
    - 对齐点以「音频轨道」为准：播放头处已有音频片段时，对齐该音频片段前端；
      播放头处无音频片段时以当前播放头帧为起点
    - 目标轨道（不覆盖现有音频）：播放头处已有音频片段时，在其上方复用整条空白的
      音频轨道、没有才 AddTrack 新建；播放头处没有任何片段（含空时间线/播放头下无视频）
      时直接放入 A1（轨道 1），不找空白轨道、不新建轨道
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

    # 不重复导入同一导出文件：保留现有时间线片段，也避免媒体池再次添加。
    try:
        tl = project.GetCurrentTimeline()
    except Exception:
        tl = None
    if tl is None:
        return {"ok": False, "error": "未打开时间线，请在剪辑页打开一条时间线再导入"}
    orig_playhead_tc = _capture_playhead_timecode(tl)
    duplicate_track, duplicate_item = _timeline_audio_source_match(tl, file_path)
    if duplicate_item is not None:
        try:
            duplicate_clip = duplicate_item.GetName() or os.path.basename(file_path)
            duplicate_frame = int(duplicate_item.GetStart())
        except Exception:
            duplicate_clip = os.path.basename(file_path)
            duplicate_frame = None
        return {"ok": True, "action": "import_audio", "duplicate": True,
                "message": "该音频已经导出到当前时间线，未重复导入。",
                "clip": duplicate_clip, "track": duplicate_track,
                "record_frame": duplicate_frame}

    # 1) 导入媒体池。ImportMedia 返回 MediaPoolItem 列表；单个文件传列表最稳。
    try:
        imported = media_pool.ImportMedia([file_path])
    except Exception as e:
        return {"ok": False, "error": f"ImportMedia 失败：{e}"}
    if not imported:
        return {"ok": False, "error": "ImportMedia 无返回，可能文件格式不被支持，或媒体池刷新延迟后再试"}
    item = imported[0] if isinstance(imported, (list, tuple)) else imported

    _restore_playhead_timecode(tl, orig_playhead_tc)

    # 2) 当前时间线已在导入前获取并完成去重检查
    try:
        timeline_name = tl.GetName() or ""
    except Exception:
        timeline_name = ""
    # 记录导入前播放头时码，导入完成后再恢复，避免播放头跳到新片段末尾
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

    # 4) 目标音频轨道（与视频导入 action_import 同一套规则，避免空时间线上无谓新建轨道）：
    #    - 播放头处已有音频片段（src_track>0）：在其上方找整条空白的音频轨道，没有才新建，不覆盖现有音频
    #    - 播放头处没有任何片段（含空时间线/播放头下无视频无音频）：直接放入 A1（轨道 1），
    #      不找空白轨道、不新建轨道
    if src_track > 0:
        target_track = find_blank_video_track(tl, after_track=src_track, track_type="audio")
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
    else:
        # 兜底：极端情况下用户删掉了全部音频轨道，则补建一条再作为 A1 使用
        try:
            if tl.GetTrackCount("audio") < 1:
                tl.AddTrack("audio")
        except Exception:
            pass
        target_track = 1
        how_placed = "track_a1"

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
        _restore_playhead_timecode(tl, orig_playhead_tc)
        return {"ok": False, "error": f"AppendToTimeline 失败：{e}"}
    if not ok_append:
        _restore_playhead_timecode(tl, orig_playhead_tc)
        return {"ok": False, "error": "AppendToTimeline 返回失败，请检查音频轨道/落点"}

    # 恢复导入前播放头位置（AppendToTimeline 会把播放头移到新片段末尾）
    _restore_playhead_timecode(tl, orig_playhead_tc)

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
