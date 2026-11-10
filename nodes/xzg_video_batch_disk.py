"""Encode bounded video segments and join them without materializing full-frame tensors."""

import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from uuid import uuid4

import folder_paths
import torch
from comfy.model_management import throw_exception_if_processing_interrupted

from .xzg_video_combine import ffmpeg_path


def _run(args):
    if not ffmpeg_path:
        raise RuntimeError("低内存合并需要 FFmpeg")
    subprocess.run([ffmpeg_path, "-v", "error", "-nostdin", *args], check=True)


def _video_codec(width, height):
    pixel_format = "yuv420p" if width % 2 == height % 2 == 0 else "yuv444p"
    return ["-c:v", "libx264", "-preset", "fast", "-crf", "16", "-pix_fmt", pixel_format]


def encode_segment(image, audio, fps):
    frames, height, width, channels = image.shape
    if not frames or channels not in (3, 4):
        raise ValueError("低内存合并需要非空的 RGB 或 RGBA 图像")
    directory = TemporaryDirectory(prefix="xzg-segment-", dir=folder_paths.get_temp_directory())
    path = Path(directory.name)
    try:
        waveform = audio.get("waveform") if isinstance(audio, dict) else None
        has_audio = waveform is not None and waveform.numel() > 0
        audio_input = ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
        if has_audio:
            waveform = waveform.detach().reshape(-1, waveform.shape[-1])
            sample_rate = int(audio.get("sample_rate") or 44100)
            audio_path = path / "audio.f32"
            waveform[..., :round(frames / fps * sample_rate)].T.contiguous().cpu().float().numpy().tofile(audio_path)
            audio_input = ["-f", "f32le", "-ar", str(sample_rate), "-ac", str(waveform.shape[0]),
                           "-i", str(audio_path)]
        args = ["-f", "rawvideo", "-pix_fmt", "rgb24" if channels == 3 else "rgba",
                "-s", f"{width}x{height}", "-r", str(fps), "-i", "pipe:0", *audio_input,
                *_video_codec(width, height), "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
                "-af", f"apad,atrim=duration={frames / fps:.12f}", str(path / "segment.mkv")]
        if not ffmpeg_path:
            raise RuntimeError("低内存合并需要 FFmpeg")
        with subprocess.Popen([ffmpeg_path, "-v", "error", "-nostdin", *args],
                              stdin=subprocess.PIPE) as process:
            try:
                for frame in image:
                    throw_exception_if_processing_interrupted()
                    pixels = frame.detach().cpu().mul(255).round_().clamp_(0, 255).to(torch.uint8)
                    process.stdin.write(pixels.contiguous().numpy().tobytes())
                process.stdin.close()
                if process.wait():
                    raise RuntimeError("FFmpeg 分段编码失败，请查看 ComfyUI 控制台")
            except BaseException:
                process.kill()
                raise
        if has_audio:
            audio_path.unlink()
        return directory, has_audio
    except BaseException:
        directory.cleanup()
        raise


def finalize_segments(segments, tail_trim):
    fps = segments[0]["fps"]
    if tail_trim >= sum(item["info"]["frames"] for item in segments):
        tail_trim = 0
    while tail_trim >= segments[-1]["info"]["frames"]:
        tail_trim -= segments[-1]["info"]["frames"]
        segments = segments[:-1]
    with TemporaryDirectory(prefix="xzg-concat-", dir=folder_paths.get_temp_directory()) as work:
        work = Path(work)
        paths = [Path(item["directory"].name) / "segment.mkv" for item in segments]
        last = segments[-1]["info"]
        if tail_trim > 0:
            kept = last["frames"] - tail_trim
            trimmed = work / "trimmed.mkv"
            width, height = last["size"]
            _run(["-i", str(paths[-1]), "-vf", f"trim=end_frame={kept}",
                  "-af", f"atrim=duration={kept / fps:.12f}",
                  *_video_codec(width, height), "-c:a", "pcm_s16le", str(trimmed)])
            paths[-1] = trimmed

        manifest = work / "segments.ffconcat"
        lines = []
        for index, (item, path) in enumerate(zip(segments, paths)):
            escaped = path.as_posix().replace("'", "'\\''")
            lines.append(f"file '{escaped}'\n")
            if index < len(paths) - 1:
                lines.append(f"duration {item['info']['frames'] / fps:.12f}\n")
        manifest.write_text("".join(lines), encoding="utf-8")

        output_dir = Path(folder_paths.get_output_directory())
        filename = f"xzg_batch_{uuid4().hex}.mp4"
        temporary_output = output_dir / f".{filename}.part"
        audio_args = ["-c:a", "aac", "-b:a", "192k"] if any(
            item["info"]["with_audio"] for item in segments) else ["-an"]
        try:
            _run(["-f", "concat", "-safe", "0", "-i", str(manifest), "-c:v", "copy",
                  *audio_args, "-movflags", "+faststart", "-f", "mp4", str(temporary_output)])
            os.replace(temporary_output, output_dir / filename)
        finally:
            temporary_output.unlink(missing_ok=True)
        return {"filename": filename, "subfolder": "", "type": "output"}
