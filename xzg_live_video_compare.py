import base64
import logging
import queue
import threading
from io import BytesIO
from math import ceil, isfinite, prod, sqrt
from time import perf_counter
from uuid import uuid4

import torch
import torch.nn.functional as F
from PIL import Image
import folder_paths
import comfy.utils
from comfy import model_management
from comfy.patcher_extension import WrappersMP
from comfy.sd import VAE
from comfy.taesd.taesd import Block, Clamp, conv
from latent_preview import VIDEO_TAES, LatentPreviewer
from server import PromptServer

from .xzg_video_compare import prepare_reference

MAX_PREVIEW_FRAMES = 60
MAX_DECODED_FRAMES = 40
PREVIEW_SAMPLES_PER_SECOND = 8
PREVIEW_MAX_SIDE = 640
PREVIEW_QUALITY = 82


def output_frame(latent_index, latent_format):
    if type(latent_format).__name__.startswith("MiniMaxH3"):
        groups, remainder = divmod(latent_index, 5)
        return groups * 17 + (4 * remainder - 3 if remainder else 0)
    stride = getattr(latent_format, "temporal_downscale_ratio", None)
    if not stride:
        raise ValueError("The model does not describe its temporal scale")
    return latent_index * stride


def load_flat_preview_decoder(weights):
    layers = [Clamp(), conv(*weights["1.weight"].shape[:2][::-1]), torch.nn.ReLU()]
    last_index = max(int(key.split(".", 1)[0]) for key in weights)
    for index in range(3, last_index + 1):
        block = weights.get(f"{index}.conv.0.weight")
        kernel = weights.get(f"{index}.weight")
        if block is not None:
            layers.append(Block(block.shape[1], block.shape[0], f"{index}.pool.0.weight" in weights))
        elif kernel is not None:
            layers.append(conv(kernel.shape[1], kernel.shape[0], bias=f"{index}.bias" in weights))
        else:
            layers.append(torch.nn.Upsample(scale_factor=2))
    model = torch.nn.Sequential(*layers).eval()
    model.load_state_dict(weights)
    device = model_management.vae_device()
    dtype = model_management.vae_dtype(device, [torch.float16, torch.bfloat16])
    model.to(device=device, dtype=dtype)
    def decode(latents):
        if latents.shape[1] != model[1].in_channels:
            raise ValueError("Tiny VAE channel count does not match the video latent")
        return model(latents.to(device=device, dtype=dtype)).movedim(1, -1)

    return decode


def load_preview_decoder(latent_format, selection="auto"):
    if selection == "none":
        return None
    if selection == "auto":
        name = getattr(latent_format, "taesd_decoder_name", None)
        if name not in VIDEO_TAES:
            return None
        selection = next((file for file in folder_paths.get_filename_list("vae_approx")
                          if file.startswith(name)), None)
        if selection is None:
            return None
    path = folder_paths.get_full_path("vae_approx", selection)
    if path is None:
        raise ValueError(f"Preview decoder not found: {selection}")
    weights = comfy.utils.load_torch_file(path)
    for prefix in ("", "taesd_decoder.", "decoder."):
        if prefix + "1.weight" in weights and prefix + "3.conv.0.weight" in weights:
            flat = {key[len(prefix):]: value for key, value in weights.items()
                    if key.startswith(prefix) and key[len(prefix):].split(".", 1)[0].isdigit()}
            return load_flat_preview_decoder(flat)
    vae = VAE(weights)
    vae.throw_exception_if_invalid()
    if vae.latent_dim != 3:
        raise ValueError(f"Incompatible video preview decoder: {selection}")
    vae.first_stage_model.show_progress_bar = False

    def decode(latents):
        if latents.shape[1] != vae.latent_channels:
            raise ValueError("Tiny VAE channel count does not match the video latent")
        return vae.decode(latents.unsqueeze(2))[:, 0]

    return decode


def video_latent(x0, latent_shapes):
    if getattr(x0, "is_nested", False):
        x0 = x0.unbind()[0]
    if x0.ndim == 3 and latent_shapes and len(latent_shapes[0]) == 5:
        shape = latent_shapes[0]
        x0 = x0[:, :, :prod(shape[1:])].reshape(shape)
    if x0.ndim != 5:
        raise ValueError("Expected video latents in B×C×T×H×W format")
    return x0[:1]


@torch.no_grad()
def preview_pixels(x0, latent_shapes, latent_format, fps, decoder=None, first_frame_only=False):
    x0 = video_latent(x0, latent_shapes)
    # A full tiny-VAE clip decode is far more expensive than a Latent2RGB pass, so it gets a
    # lower frame budget; both paths stay well inside what the sampler can absorb per step.
    limit = MAX_DECODED_FRAMES if decoder is not None else MAX_PREVIEW_FRAMES
    if decoder is None:
        factors = getattr(latent_format, "latent_rgb_factors", None)
        if factors is None:
            raise ValueError("The model does not supply Latent2RGB coefficients")
        reshape = getattr(latent_format, "latent_rgb_factors_reshape", None)
        if reshape is not None:
            x0 = reshape(x0)
    length = x0.shape[2]
    if length < 1:
        raise ValueError("No video latent frames available")
    video_frames = output_frame(length - 1, latent_format) + 1
    count = 1 if first_frame_only else min(
        length, limit, max(16, ceil(video_frames / fps * PREVIEW_SAMPLES_PER_SECOND)))
    indices = [round(i * (length - 1) / max(count - 1, 1)) for i in range(count)]
    latents = x0[0].index_select(1, torch.tensor(indices, device=x0.device)).permute(1, 0, 2, 3)
    timestamps = [output_frame(index, latent_format) / fps for index in indices]
    if decoder is not None:
        preview = []
        for start in range(0, count, 8):
            rgb = decoder(latents[start:start + 8])[..., :3]
            height, width = rgb.shape[1:3]
            scale = min(1, PREVIEW_MAX_SIDE / max(height, width))
            if scale < 1:
                rgb = F.interpolate(
                    rgb.movedim(-1, 1).float(),
                    size=(max(1, round(height * scale)), max(1, round(width * scale))),
                    mode="bilinear", align_corners=False, antialias=True,
                ).movedim(1, -1)
            pixels = rgb.clamp(0, 1).mul(255).to(torch.uint8).cpu().numpy()
            preview.extend(zip(timestamps[start:start + len(pixels)], pixels))
        return preview

    latents = latents.float()
    height, width = latents.shape[-2:]
    scale = min(1, PREVIEW_MAX_SIDE / max(height, width))
    if scale < 1:
        latents = F.interpolate(latents, size=(max(1, round(height * scale)),
                                               max(1, round(width * scale))),
                                mode="bilinear", align_corners=False)
    weight = latents.new_tensor(factors).T
    bias_values = getattr(latent_format, "latent_rgb_factors_bias", None)
    bias = latents.new_tensor(bias_values) if bias_values is not None else None
    rgb = F.linear(latents.movedim(1, -1), weight, bias)
    pixels = rgb.add_(1).mul_(127.5).clamp_(0, 255).to(torch.uint8).cpu().numpy()

    return list(zip(timestamps, pixels))


def encode_frames(preview):
    frames = []
    for timestamp, pixels_at_index in preview:
        buffer = BytesIO()
        Image.fromarray(pixels_at_index).save(buffer, "JPEG", quality=PREVIEW_QUALITY)
        frames.append({
            "time": timestamp,
            "image": base64.b64encode(buffer.getvalue()).decode("ascii"),
        })
    return frames


class _AsyncPreviewEncoder:
    """Bounded, drop-on-full encoder thread so sampling never waits on JPEG encoding."""

    _STOP = object()

    def __init__(self, max_in_flight=2):
        self._queue = queue.Queue(maxsize=max_in_flight)
        self._active = False
        self._thread = threading.Thread(target=self._run, name="xzg-preview-encoder", daemon=True)
        self._thread.start()

    def submit(self, task):
        try:
            self._queue.put_nowait(task)
            return True
        except queue.Full:
            return False

    def busy(self):
        return self._active or not self._queue.empty()

    def _run(self):
        while True:
            task = self._queue.get()
            if task is _AsyncPreviewEncoder._STOP:
                return
            self._active = True
            try:
                task()
            except Exception:
                logging.warning("XZG preview encoding task failed", exc_info=True)
            finally:
                self._active = False

    def shutdown(self, timeout=5.0):
        try:
            self._queue.put(_AsyncPreviewEncoder._STOP, timeout=timeout)
        except queue.Full:
            pass
        self._thread.join(timeout=timeout)


def _suppressed_preview_image(self, preview_format, x0):
    return None


def suppress_default_previews():
    """Mute core's per-step preview decode: it doubles GPU work against our own decode."""
    patched = []
    try:
        targets = [LatentPreviewer]
        stack = list(LatentPreviewer.__subclasses__())
        while stack:
            cls = stack.pop()
            targets.append(cls)
            stack.extend(cls.__subclasses__())
        for cls in targets:
            if "decode_latent_to_preview_image" in cls.__dict__:
                patched.append((cls, cls.__dict__["decode_latent_to_preview_image"]))
                cls.decode_latent_to_preview_image = _suppressed_preview_image
    except Exception:
        logging.warning("Unable to suppress the default sampler preview", exc_info=True)
    return patched


def restore_default_previews(patched):
    for cls, original in patched:
        try:
            cls.decode_latent_to_preview_image = original
        except Exception:
            pass


class XZGLiveVideoCompare:
    CATEGORY = "小烛光/视频"
    RETURN_TYPES = ("MODEL",)
    FUNCTION = "attach"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "output_fps": ("FLOAT", {"default": 24, "min": 0.1, "max": 240, "step": 0.01,
                                         "tooltip": "填写参考素材与生成视频共用的帧率。"}),
            },
            "optional": {
                "reference_images": ("IMAGE", {"tooltip": "按批次顺序输入参考帧，也可输入单张图像。"}),
                "tiny_vae": (["auto", "none", *folder_paths.get_filename_list("vae_approx")], {"default": "auto"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"},
        }

    def attach(self, model, output_fps, reference_images=None, unique_id=None, tiny_vae="auto", dynprompt=None):
        # Loop/expansion copies run under generated ids; the widget listens on the display id.
        node_id = str(unique_id)
        try:
            if dynprompt is not None:
                node_id = str(dynprompt.get_display_node_id(unique_id))
        except Exception:
            pass
        info = {"source": node_id}
        if reference_images is not None:
            try:
                prepare_reference(reference_images, output_fps, info)
            except Exception:
                logging.exception("Unable to prepare XZG reference video")
                info["message"] = "参考画面准备失败，详情见 ComfyUI 控制台。"
                info["message_en"] = "Unable to prepare the reference. See the ComfyUI console."

        def sample(executor, noise, latent_image, sampler, sigmas, denoise_mask, callback,
                   disable_pbar, seed, latent_shapes=None):
            server = PromptServer.instance
            try:
                latent_format = executor.class_obj.model_patcher.model.latent_format
            except Exception:
                latent_format = None
            run_id = uuid4().hex
            try:
                sigma_curve = [value if isfinite(value) else None
                               for value in sigmas.detach().float().cpu().tolist()]
            except Exception:
                sigma_curve = []

            state = {
                "previous": None,
                "last_step_at": None,
                "decoder": None,
                "decoder_loaded": False,
                "frames_disabled": False,
                "frames_sent": 0,
                "deltas": {},
                "timings": {},
                "warned": False,
            }

            def send(event):
                # Read the client id at send time: it is a per-prompt global and can change.
                try:
                    server.send_sync("xzg_live_video_compare", event, getattr(server, "client_id", None))
                except Exception:
                    logging.debug("Unable to send XZG preview event", exc_info=True)

            def base_event(step, total):
                return {"node_id": node_id, "reference": info, "step": step, "total": total,
                        "sigmas": sigma_curve, "run_id": run_id,
                        "deltas": list(state["deltas"].items()),
                        "timings": list(state["timings"].items())}

            def encoder_task(event, pixels):
                try:
                    event["frames"] = encode_frames(pixels)
                except Exception:
                    logging.warning("Unable to encode XZG preview frames", exc_info=True)
                    return
                send(event)

            def get_decoder():
                if state["decoder_loaded"]:
                    return state["decoder"]
                state["decoder_loaded"] = True
                try:
                    state["decoder"] = load_preview_decoder(latent_format, tiny_vae)
                except Exception:
                    state["decoder"] = None
                    logging.warning("Unable to load XZG preview VAE; falling back to Latent2RGB",
                                    exc_info=True)
                return state["decoder"]

            def render(latent, first_frame_only):
                try:
                    return preview_pixels(latent, None, latent_format, output_fps, get_decoder(),
                                          first_frame_only=first_frame_only)
                except Exception:
                    if state["decoder"] is None:
                        raise
                    # One bad tiny-VAE decode should degrade to Latent2RGB, not kill previews.
                    state["decoder"] = None
                    logging.warning("XZG preview VAE decode failed; falling back to Latent2RGB",
                                    exc_info=True)
                    return preview_pixels(latent, None, latent_format, output_fps,
                                          first_frame_only=first_frame_only)

            def disable_frames(event, reason):
                if not state["warned"]:
                    state["warned"] = True
                    logging.warning("XZG sampling preview frames unavailable (%s); curves only", reason)
                state["frames_disabled"] = True
                send(event)

            @torch.no_grad()
            def preview_callback(step, x0, x, total):
                if callback is not None:
                    callback(step, x0, x, total)
                now = perf_counter()
                last = state["last_step_at"]
                if last is not None:
                    state["timings"][step + 1] = (now - last) * 1000
                state["last_step_at"] = now
                event = base_event(step + 1, total)
                try:
                    current = video_latent(x0, latent_shapes)
                except Exception:
                    disable_frames(event, "non-video latents")
                    return
                cpu = current.detach().to(device="cpu", dtype=torch.float32)
                previous = state["previous"]
                if previous is not None and previous.shape == cpu.shape and cpu.numel():
                    value = ((cpu - previous).norm() / sqrt(cpu.numel())).item()
                    if isfinite(value):
                        state["deltas"][step + 1] = value
                state["previous"] = cpu
                event["deltas"] = list(state["deltas"].items())

                if state["frames_disabled"]:
                    send(event)
                    return
                # Never decode just to drop the result: if the encoder is still behind and the
                # widget already shows frames, refresh the curves only for this step.
                if state["frames_sent"] and encoder.busy() and step + 1 != total:
                    send(event)
                    return
                try:
                    if step == 0:
                        first = render(current, True)
                        encoder.submit(lambda: encoder_task(dict(event), first))
                    pixels = render(current, False)
                except Exception:
                    # render() already retried Latent2RGB, so nothing usable is left for this model.
                    logging.debug("XZG preview frame rendering failed", exc_info=True)
                    disable_frames(event, "no usable preview decoder for this model")
                    return
                if encoder.submit(lambda: encoder_task(dict(event), pixels)):
                    state["frames_sent"] += 1
                else:
                    send(event)

            encoder = _AsyncPreviewEncoder(max_in_flight=2)
            initial = base_event(0, max(0, len(sigma_curve) - 1))
            try:
                raw = video_latent(noise, latent_shapes)
                seed_latent = raw
                if sigma_curve and sigma_curve[0] is not None:
                    seed_latent = raw * sigma_curve[0]
                    state["previous"] = raw.detach().to(device="cpu", dtype=torch.float32) * sigma_curve[0]
                encoder_task(initial, render(seed_latent, True))
                state["frames_sent"] += 1
            except Exception:
                logging.debug("Unable to render XZG initial preview", exc_info=True)
                send(initial)

            patched = suppress_default_previews()
            try:
                return executor(noise, latent_image, sampler, sigmas, denoise_mask, preview_callback,
                                disable_pbar, seed, latent_shapes=latent_shapes)
            finally:
                encoder.shutdown()
                restore_default_previews(patched)
                state["previous"] = None
                if torch.cuda.is_available():
                    try:
                        torch.cuda.empty_cache()
                    except Exception:
                        pass

        patched = model.clone()
        patched.add_wrapper_with_key(WrappersMP.OUTER_SAMPLE, "xzg_live_video_compare", sample)
        return {"ui": {"xzg_video_compare": [info]}, "result": (patched,)}
