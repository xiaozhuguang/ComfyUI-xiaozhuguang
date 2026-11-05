"""Robust paired, global video color calibration. Inputs must be frame-aligned.

Estimate on bounded-size thumbnails; reject residual content differences after
robust global color alignment. No optical flow or semantic correspondence is
inferred. Only statistics are masked: the transform applies to the whole image.
"""
import math
import torch
import torch.nn.functional as F

_LUMA = (0.299, 0.587, 0.114)
_GRID_SIZE = 129


def _luma(rgb):
    return (rgb * rgb.new_tensor(_LUMA)).sum(-1, keepdim=True)


def _thumbnail(rgb, size=128):
    h, w = rgb.shape[1:3]
    ratio = min(1.0, size / max(h, w))
    return F.interpolate(rgb.permute(0, 3, 1, 2),
                         size=(max(1, round(h * ratio)), max(1, round(w * ratio))),
                         mode='area').permute(0, 2, 3, 1)


def _fit(x, y, weights, prior, ridge=0.002):
    # Ridge toward the identity protects constant/low-chroma frames.
    weights = weights / weights.sum().clamp_min(1e-8)
    reg = torch.eye(x.shape[1], device=x.device) * ridge
    return torch.linalg.solve(x.T @ (weights[:, None] * x) + reg,
                              x.T @ (weights[:, None] * y) + reg @ prior)


def _stable_weights(ref, src):
    # Exclude actual near-black/white pixels, not every saturated channel.
    valid = ((ref.amax(-1) > 0.02) & (ref.amin(-1) < 0.98) &
             (src.amax(-1) > 0.02) & (src.amin(-1) < 0.98)).float()
    x = torch.cat((src, torch.ones_like(src[:, :1])), -1)
    prior = torch.cat((torch.eye(3, device=src.device), src.new_zeros(1, 3)))
    identity_residual = (src-ref).square().mean(-1).sqrt()
    identity_support = ((identity_residual < 0.04).float()*valid).sum()/valid.sum().clamp_min(1)
    # When a sizeable unchanged background exists, initialize from it. Starting
    # with every pixel lets a replaced character dominate the first affine fit
    # and incorrectly classify the actual background as an outlier.
    initial = _fit(x, ref, valid, prior)
    initial_error = (((x @ initial-ref).square().mean(-1)*valid).sum()/valid.sum().clamp_min(1)).sqrt()
    # A well-explained global exposure/contrast change needs the full tonal range.
    # Only protect the identity subset when the all-pixel model has large error.
    prior_weights = ((1-(identity_residual/0.08).square()).clamp_min(0).square()
                     if identity_support > 0.2 and initial_error > 0.015 else torch.ones_like(valid))
    weights = valid * prior_weights
    for iteration in range(6):
        matrix = _fit(x, ref, weights, prior)
        if iteration == 0:
            mean = (ref * weights[:, None]).sum(0) / weights.sum().clamp_min(1)
            variance = ((ref - mean).square().mean(-1) * weights).sum()
            error = ((x @ matrix - ref).square().mean(-1) * weights).sum()
            # Unrelated frames can contain chance low-residual pixels. Require
            # evidence of correspondence, rather than fitting their global mean.
            identity_error = (src-ref).square().mean(-1).sqrt()
            unchanged = ((identity_error < 0.025).float() * valid).sum() / valid.sum().clamp_min(1)
            if variance > 1e-4 and error > variance * 0.85 and unchanged < 0.1:
                return torch.zeros_like(valid)
        residual = ((x @ matrix - ref).square().mean(-1) + 1e-10).sqrt()
        usable = residual[valid > 0]
        if usable.numel() < 64:
            return torch.zeros_like(valid)
        median = usable.median()
        mad = (usable - median).abs().median()
        # Allow global nonlinear tone differences, reject large local changes.
        cutoff = (median + 3.0 * 1.4826 * mad).clamp(0.04, 0.16)
        weights = valid * prior_weights * (1 - (residual / cutoff).square()).clamp_min(0).square()
    return weights


def _interp(values, xs, ys):
    idx = torch.searchsorted(xs.contiguous(), values.contiguous(), right=True) - 1
    idx = idx.clamp(0, xs.numel() - 2)
    t = ((values - xs[idx]) / (xs[idx + 1] - xs[idx]).clamp_min(1e-6)).clamp(0, 1)
    return ys[idx] + t * (ys[idx + 1] - ys[idx])


def _weighted_quantile(values, weights, levels):
    values, order = values.sort()
    cumulative = weights[order].cumsum(0)
    cumulative = (cumulative - 0.5 * weights[order]) / weights.sum().clamp_min(1e-8)
    return _interp(levels, cumulative, values)


def _tone_curve(ref, src, weights, grid):
    y0, y1 = _luma(ref), _luma(src)
    if y1[weights > 0.1].std(unbiased=False) < 0.002:
        x = torch.cat((y1, torch.ones_like(y1)), -1)
        coeff = _fit(x, y0, weights, src.new_tensor([[1.0], [0.0]]))[:, 0]
        scale = coeff[0].clamp(0.5, 2.0)
        shift = ((y0[:, 0] - scale * y1[:, 0]) * weights).sum() / weights.sum()
        return grid * scale + shift.clamp(-0.25, 0.25)
    # Conditional paired statistics: independent target/source CDFs can pair a
    # bright lamp with a changed face and collapse the tone curve as objects move.
    # Quantiles now select source neighborhoods; each target anchor is estimated
    # from the SAME spatial correspondences inside that neighborhood.
    levels = torch.linspace(0.01, 0.99, 33, device=src.device)
    chosen = weights > 0.01
    source, target, w = y1[chosen, 0], y0[chosen, 0], weights[chosen]
    bounds = _weighted_quantile(source, w, torch.cat(((levels-0.035).clamp_min(0),
                                                     (levels+0.035).clamp_max(1))))
    xs, ys = [], []
    for k in range(33):
        local = (source >= bounds[k]) & (source <= bounds[k+33])
        wl = w[local]
        if wl.numel() == 0:
            continue
        # Robust paired delta rejects foreground correspondences that survived
        # the initial RGB fit, without sorting target pixels into different pairs.
        delta = target[local] - source[local]
        middle = _weighted_quantile(delta, wl, source.new_tensor([0.5]))[0]
        robust = wl * (1 - ((delta-middle)/0.08).square()).clamp_min(0).square()
        denom = robust.sum().clamp_min(1e-8)
        x = (source[local] * robust).sum()/denom
        change = (delta * robust).sum()/denom
        xs.append(x)
        ys.append(x + change.clamp(-0.25, 0.25))
    xs, ys = torch.stack(xs), torch.stack(ys)
    # Merge repeated neighborhoods instead of inventing almost-equal x anchors.
    unique, inverse = torch.unique_consecutive(xs, return_inverse=True)
    totals = torch.zeros_like(unique).scatter_add_(0, inverse, ys)
    counts = torch.zeros_like(unique).scatter_add_(0, inverse, torch.ones_like(ys))
    xs, ys = unique, totals/counts
    if xs.numel() < 2:
        return grid + (ys[0]-xs[0])
    # Limit each side outward from the median; do not accumulate errors from a
    # single shadow endpoint across the whole curve.
    center = xs.numel()//2
    for k in range(center+1, xs.numel()):
        dx = xs[k]-xs[k-1]
        ys[k] = ys[k].clamp(ys[k-1]+0.25*dx, ys[k-1]+4*dx)
    for k in range(center-1, -1, -1):
        dx = xs[k+1]-xs[k]
        ys[k] = ys[k].clamp(ys[k+1]-4*dx, ys[k+1]-0.25*dx)
    # Outside observed support preserve the endpoint correction instead of
    # extending a noisy edge slope across unobserved skin/highlight levels.
    curve = _interp(grid, xs, ys)
    curve = torch.where(grid < xs[0], grid + ys[0]-xs[0], curve)
    return torch.where(grid > xs[-1], grid + ys[-1]-xs[-1], curve)


def _chroma(rgb):
    y = _luma(rgb)
    return torch.cat((rgb[..., :1] - y, rgb[..., 2:3] - y), -1)


def _fit_chroma(ref, src, weights):
    c = _chroma(src)
    x = torch.cat((c, torch.ones_like(c[:, :1])), -1)
    prior = src.new_tensor([[1., 0.], [0., 1.], [0., 0.]])
    coeff = _fit(x, _chroma(ref), weights, prior)
    u, scale, vh = torch.linalg.svd(coeff[:2])
    # Bound chroma amplification, while permitting hue rotation and tint shifts.
    matrix = (u * scale.clamp(0.5, 2.0)) @ vh
    # A reflection reverses the chroma plane and can invert selected colors.
    # It is not a plausible global grading correction for these paired clips.
    if torch.linalg.det(matrix) <= 0:
        matrix = torch.eye(2, device=src.device)
    # Re-anchor the fitted mean after gain limiting, otherwise the old intercept
    # no longer belongs to the constrained matrix (visible on warm/dim footage).
    offset = ((_chroma(ref) - c @ matrix) * weights[:, None]).sum(0) / weights.sum()
    return matrix, offset.clamp(-0.12, 0.12)


def _apply(rgb, grid, curve, matrix, offset):
    y = _interp(_luma(rgb).squeeze(-1), grid, curve).unsqueeze(-1)
    chroma = _chroma(rgb) @ matrix + offset
    r, b = chroma[..., :1], chroma[..., 1:2]
    g = -(0.299 * r + 0.114 * b) / 0.587
    return y + torch.cat((r, g, b), -1)


def _parameter_distance(left, right):
    # Tone endpoints are extrapolated and should not decide temporal reliability.
    tone = (left[0][8:-8] - right[0][8:-8]).abs().mean().item()
    chroma = (left[1] - right[1]).abs().max().item() * 0.15
    tint = (left[2] - right[2]).abs().max().item()
    return max(tone, chroma, tint)


def _temporal_parameters(estimates, cuts, smooth, neutral, fit_errors):
    """Repair brief estimation failures within scenes, then smooth all parameters.

    Uses batch lookahead, never transfers fitted parameters across detected cuts.
    With smooth=0, parameters remain fully independent as documented.
    """
    if smooth == 0:
        return estimates
    repaired = list(estimates)
    start = 0
    boundaries = [i for i in range(1, len(cuts)) if cuts[i]] + [len(cuts)]
    for end in boundaries:
        # Compare raw neighbors so rejecting one frame cannot cascade.
        for i in range(start + 1, end - 1):
            left, center, right = estimates[i-1:i+2]
            if left is not None and center is not None and right is not None:
                if (fit_errors[i] > 0.025 and
                        _parameter_distance(left, right) < 0.025 and
                        _parameter_distance(center, left) > 0.045 and
                        _parameter_distance(center, right) > 0.045):
                    repaired[i] = tuple((a + b) * 0.5 for a, b in zip(left, right))
        i = start
        while i < end:
            if repaired[i] is not None:
                i += 1
                continue
            gap_start = i
            while i < end and repaired[i] is None:
                i += 1
            # Only bridge short gaps bounded by reliable frames in this scene.
            if i - gap_start <= 6 and gap_start > start and i < end:
                left, right = repaired[gap_start - 1], repaired[i]
                if _parameter_distance(left, right) < 0.06:
                    for j in range(gap_start, i):
                        fraction = (j - gap_start + 1) / (i - gap_start + 1)
                        repaired[j] = tuple(torch.lerp(a, b, fraction) for a, b in zip(left, right))
        start = end

    result = []
    previous = None
    missing = 0
    for i, current in enumerate(repaired):
        if cuts[i]:
            previous = None
            missing = 0
        if current is None:
            missing += 1
            if previous is None:
                result.append(None)
                continue
            # Brief loss holds the last correction; prolonged loss fades toward
            # identity rather than abruptly switching back to the edited colors.
            current = previous if missing <= 6 else tuple(
                torch.lerp(a, b, 0.25) for a, b in zip(previous, neutral))
        else:
            missing = 0
            if previous is not None:
                current = tuple(smooth * old + (1-smooth) * new
                                for old, new in zip(previous, current))
        previous = current
        result.append(current)
    return result


class XiaozhuguangVideoColorCalibrator:
    """稳健全局匹配：亮度曲线、二维色度变换及完整参数时间平滑。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_original": ("IMAGE",),
                "video_edited": ("IMAGE",),
                "smooth": ("FLOAT", {
                    "default": 0.6, "min": 0.0, "max": 0.95, "step": 0.05,
                    "tooltip": "矫正参数的时间平滑系数：0=逐帧独立，越大越平滑（防色闪）",
                }),
                "strength": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "校正强度：0=严格保留编辑图，1=应用估计的完整校正",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    CATEGORY = "小珠光/视频"
    DESCRIPTION = (
        "对齐两段视频的全局颜色：先估计整体偏色，再降低内容差异区域的统计权重。"
        "稳健分位数匹配亮度曲线；色度矩阵校正色相、饱和度和偏色。"
        "所有参数时间平滑，双路大幅画面变化时重置。短暂失配参考邻帧，持续失配逐步减弱校正。"
        "两段视频必须帧数相同、时间与位置对齐；不含光流或语义匹配。"
    )

    @torch.no_grad()
    def run(self, video_original, video_edited, mode='quantile', smooth=0.6, strength=1.0):
        def validate(value, name):
            if not isinstance(value, torch.Tensor) or value.ndim not in (3, 4):
                raise ValueError(f'{name} must be an IMAGE tensor [B,H,W,C]')
            value = value.unsqueeze(0) if value.ndim == 3 else value
            if min(value.shape) < 1 or value.shape[-1] not in (1, 3, 4):
                raise ValueError(f'{name}: expected nonempty grayscale, RGB or RGBA images')
            if not torch.isfinite(value).all():
                raise ValueError(f'{name} contains NaN or infinity')
            return value

        original = validate(video_original, 'video_original')
        edited = validate(video_edited, 'video_edited')
        if original.shape[0] != edited.shape[0]:
            raise ValueError('Original and edited videos must have the same frame count and be frame-aligned')
        # Legacy API mode values are accepted but use the single quantile algorithm.
        if not math.isfinite(float(strength)) or not 0 <= strength <= 1:
            raise ValueError('strength must be between 0 and 1')
        if not math.isfinite(float(smooth)) or not 0 <= smooth <= 0.95:
            raise ValueError('smooth must be between 0 and 0.95')
        if strength == 0:
            return (edited,)

        # Use the input device; do not silently move entire videos onto the GPU.
        device = edited.device
        grid = torch.linspace(0, 1, _GRID_SIZE, device=device)
        identity = torch.eye(2, device=device)
        last_ref = last_src = None
        estimates, cuts, fit_errors = [], [], []
        for bi in range(edited.shape[0]):
            src = edited[bi:bi + 1, ..., :3].float()
            ref = original[bi:bi + 1, ..., :3].to(device=device, dtype=torch.float32)
            if src.shape[-1] == 1:
                src = src.expand(-1, -1, -1, 3)
            if ref.shape[-1] == 1:
                ref = ref.expand(-1, -1, -1, 3)
            if ref.shape[1:3] != src.shape[1:3]:
                ref = F.interpolate(ref.permute(0, 3, 1, 2), size=src.shape[1:3],
                                    mode='bilinear', align_corners=False).permute(0, 2, 3, 1)
            small_ref, small_src = _thumbnail(ref), _thumbnail(src)
            # Require a large change in BOTH streams: an edited-only flash or
            # correspondence failure must not discard temporal history.
            cut = last_ref is not None and min(
                (small_ref - last_ref).abs().mean().item(),
                (small_src - last_src).abs().mean().item()) > 0.18
            last_ref, last_src = small_ref, small_src
            cuts.append(cut)
            a, b = small_ref.reshape(-1, 3), small_src.reshape(-1, 3)
            weights = _stable_weights(a, b)
            count = (weights > 0.1).sum().item()
            if count < 64 or count / weights.numel() < 0.05:
                estimates.append(None)
                fit_errors.append(float('inf'))
            else:
                confidence = min(1.0, count / (weights.numel() * 0.3))
                curve = _tone_curve(a, b, weights, grid)
                matrix, offset = _fit_chroma(a, b, weights)
                current = (grid + (curve - grid) * confidence,
                           identity + (matrix - identity) * confidence,
                           offset * confidence)
                estimates.append(current)
                predicted = _apply(b, grid, *current).clamp(0, 1)
                error = ((predicted - a).abs().mean(-1) * weights).sum() / weights.sum()
                fit_errors.append(error.item())

        neutral = (grid, identity, grid.new_zeros(2))
        parameters = _temporal_parameters(estimates, cuts, smooth, neutral, fit_errors)
        output = []
        for bi, current in enumerate(parameters):
            src = edited[bi:bi + 1, ..., :3].float()
            if src.shape[-1] == 1:
                src = src.expand(-1, -1, -1, 3)
            corrected = src if current is None else _apply(src, grid, *current)
            # Gamut clipping and intensity blending happen only once at the end.
            result = torch.lerp(src, corrected.clamp(0, 1), strength)
            if edited.shape[-1] == 1:
                result = _luma(result)
            if edited.shape[-1] == 4:
                result = torch.cat((result, edited[bi:bi + 1, ..., 3:4]), -1)
            output.append(result.to(dtype=edited.dtype))
        return (torch.cat(output, 0),)


NODE_CLASS_MAPPINGS = {'XiaozhuguangVideoColorCalibrator': XiaozhuguangVideoColorCalibrator}
NODE_DISPLAY_NAME_MAPPINGS = {'XiaozhuguangVideoColorCalibrator': '小珠光视频颜色矫正'}
