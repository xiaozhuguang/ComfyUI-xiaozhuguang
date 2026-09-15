import torch

# ============ 小珠光颜色匹配高速版 ============
# 参考 comfyui_essentials 的 ImageColorMatch（Reinhard 统计量迁移），
# 仅保留 LAB / MKL 两种模式，并针对速度重写：
#   1) 纯 torch 实现 sRGB<->LAB，不依赖 kornia（省掉 kornia 的封装/检查开销）
#   2) 无 batch 分块循环：整段视频一次性向量化计算（essentials 按 batch_size split 逐段处理）
#   3) 统计/变换全部在输入张量所在设备上完成，无 CPU<->GPU 往返拷贝
#   4) MKL（Monge-Kantorovich 线性化）：RGB 空间全协方差匹配，
#      批量 3x3 特征分解（eigh），每帧一个 3x3 传输矩阵，像素变换用单个 einsum 完成
#   5) 参考图统计只算一次；参考为单帧时结果广播到整段视频

_EPS = 1e-6

# sRGB(D65) <-> XYZ <-> LAB 标准矩阵
_RGB2XYZ = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
]
_XYZ2RGB = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.9692660, 1.8760108, 0.0415560],
    [0.0556434, -0.2040259, 1.0572252],
]
_WHITE = [0.95047, 1.0, 1.08883]


def _srgb_to_linear(x):
    return torch.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055).pow(2.4))


def _linear_to_srgb(x):
    return torch.where(x <= 0.0031308, x * 12.92, x.pow(1.0 / 2.4) * 1.055 - 0.055)


def _rgb_to_lab(x):
    """x: (B,3,H,W) sRGB[0,1] -> LAB (B,3,H,W)，L∈[0,100]，a/b 无符号偏移"""
    M = x.new_tensor(_RGB2XYZ)
    lin = _srgb_to_linear(x)
    xyz = torch.einsum('oi,bihw->bohw', M, lin)
    wp = x.new_tensor(_WHITE).view(1, 3, 1, 1)
    xyz = xyz / wp
    f = torch.where(xyz > 0.008856, xyz.pow(1.0 / 3.0), 7.787 * xyz + 16.0 / 116.0)
    fx, fy, fz = f[:, 0:1], f[:, 1:2], f[:, 2:3]
    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)
    return torch.cat([L, a, b], dim=1)


def _lab_to_rgb(lab):
    """lab: (B,3,H,W) -> sRGB[0,1] (B,3,H,W)"""
    M = lab.new_tensor(_XYZ2RGB)
    L, a, b = lab[:, 0:1], lab[:, 1:2], lab[:, 2:3]
    fy = (L + 16.0) / 116.0
    fx = fy + a / 500.0
    fz = fy - b / 200.0

    def _finv(f):
        f3 = f.pow(3)
        return torch.where(f3 > 0.008856, f3, (f - 16.0 / 116.0) / 7.787)

    xyz = torch.cat([_finv(fx) * 0.95047, _finv(fy), _finv(fz) * 1.08883], dim=1)
    lin = torch.einsum('oi,bihw->bohw', M, xyz)
    return _linear_to_srgb(lin).clamp(0.0, 1.0)


def _mean_cov(x):
    """x: (B,3,N) 像素 -> 均值 (B,3)，协方差 (B,3,3)"""
    n = x.shape[2]
    mu = x.mean(dim=2)
    d = x - mu.unsqueeze(2)
    cov = torch.einsum('bin,bjn->bij', d, d) / max(1, n)
    return mu, cov


def _sqrtm_psd(mat):
    """批量对称半正定 3x3 矩阵的平方根"""
    evals, evecs = torch.linalg.eigh(mat)
    evals = evals.clamp_min(0.0)
    return torch.matmul(evecs, torch.matmul(torch.diag_embed(evals.sqrt()), evecs.transpose(-2, -1)))


def _inv_sqrtm_psd(mat):
    """批量对称半正定 3x3 矩阵的逆平方根"""
    evals, evecs = torch.linalg.eigh(mat)
    evals = evals.clamp_min(_EPS)
    return torch.matmul(evecs, torch.matmul(torch.diag_embed(evals.rsqrt()), evecs.transpose(-2, -1)))


def _mkl_matrix(s_cov, t_cov):
    """MKL 传输矩阵：A = S^-1/2 (S^1/2 T S^1/2)^1/2 S^-1/2，批量 (B,3,3)"""
    s_half = _sqrtm_psd(s_cov)
    inner = torch.matmul(torch.matmul(s_half, t_cov), s_half)
    sqrt_inner = _sqrtm_psd(inner)
    s_inv_half = _inv_sqrtm_psd(s_cov)
    return torch.matmul(torch.matmul(s_inv_half, sqrt_inner), s_inv_half)


class XiaozhuguangColorMatchFast:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "reference": ("IMAGE",),
                "模式": (["LAB", "MKL"], {"default": "LAB"}),
                "强度": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"
    DESCRIPTION = (
        "颜色匹配高速版：把参考图的颜色统计迁移到目标图像。\n"
        "LAB：逐通道均值/方差匹配（Reinhard），色彩还原自然，适合大多数场景；\n"
        "MKL：RGB 空间全协方差匹配（Monge-Kantorovich），能对齐通道间相关性，色彩迁移更彻底。\n"
        "强度 0~1 控制迁移比例。整段视频一次向量化计算，无分块循环与设备拷贝。"
    )

    def execute(self, image, reference, 模式="LAB", 强度=1.0):
        factor = float(强度)
        orig_dtype = image.dtype
        img = image.to(torch.float32)
        ref = reference.to(torch.float32).to(img.device)

        B, H, W, _ = img.shape

        if 模式 == "MKL":
            # ---- MKL：RGB 空间全协方差匹配，逐帧 3x3 传输矩阵 ----
            img_px = img.permute(0, 3, 1, 2).reshape(B, 3, -1)
            s_mu, s_cov = _mean_cov(img_px)
            if ref.shape[0] == B:
                ref_px = ref.permute(0, 3, 1, 2).reshape(B, 3, -1)
                t_mu, t_cov = _mean_cov(ref_px)
            else:
                # 参考帧数与目标不一致（常见：单帧参考图）：全帧合并统计后广播
                ref_px = ref.permute(0, 3, 1, 2).reshape(3, -1).unsqueeze(0)
                t_mu0, t_cov0 = _mean_cov(ref_px)
                t_mu = t_mu0.expand(B, 3)
                t_cov = t_cov0.expand(B, 3, 3)
            A = _mkl_matrix(s_cov, t_cov)                       # (B,3,3)
            d = img_px - s_mu.unsqueeze(2)                      # (B,3,N)
            matched = torch.einsum('bij,bjn->bin', A, d) + t_mu.unsqueeze(2)
            out = matched.reshape(B, 3, H, W)
            if factor < 1.0:
                out = factor * out + (1.0 - factor) * img.permute(0, 3, 1, 2)
            out = out.permute(0, 2, 3, 1).clamp(0.0, 1.0)
        else:
            # ---- LAB：逐帧均值/方差匹配（Reinhard），LAB 空间内混合 ----
            lab_img = _rgb_to_lab(img.permute(0, 3, 1, 2))      # (B,3,H,W)
            lab_ref = _rgb_to_lab(ref.permute(0, 3, 1, 2))
            if lab_ref.shape[0] == B:
                r_mu = lab_ref.mean(dim=(2, 3))                  # (B,3)
                r_std = lab_ref.std(dim=(2, 3))                  # (B,3)
            else:
                flat = lab_ref.permute(1, 0, 2, 3).reshape(3, -1)
                r_mu = flat.mean(dim=1).unsqueeze(0)             # (1,3)
                r_std = flat.std(dim=1, unbiased=True).unsqueeze(0)
            i_mu = lab_img.mean(dim=(2, 3))                      # (B,3)
            i_std = lab_img.std(dim=(2, 3))                      # (B,3)
            i_std = torch.nan_to_num(i_std, nan=0.0)
            r_std = torch.nan_to_num(r_std, nan=0.0)
            normed = torch.nan_to_num(
                (lab_img - i_mu.unsqueeze(-1).unsqueeze(-1)) / i_std.unsqueeze(-1).unsqueeze(-1)
            )
            matched = normed * r_std.unsqueeze(-1).unsqueeze(-1) + r_mu.unsqueeze(-1).unsqueeze(-1)
            if factor < 1.0:
                matched = factor * matched + (1.0 - factor) * lab_img
            out = _lab_to_rgb(matched).permute(0, 2, 3, 1).clamp(0.0, 1.0)

        return (out.to(orig_dtype),)
