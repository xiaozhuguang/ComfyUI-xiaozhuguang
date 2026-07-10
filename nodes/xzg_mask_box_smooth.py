import torch


class XiaozhuguangMaskBoxSmooth:
    """
    小珠光遮罩方框化平滑
    先方框化，再多帧合并，减少跳动
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "遮罩": ("MASK",),
                "窗口大小": ("INT", {"default": 5, "min": 1, "max": 31, "step": 2}),
                "扩展像素": ("INT", {"default": 0, "min": 0, "max": 500}),
                "阈值": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
        }

    RETURN_TYPES = ("MASK", "BBOX")
    RETURN_NAMES = ("遮罩", "包围盒")
    FUNCTION = "execute"
    CATEGORY = "小珠光"

    def execute(self, 遮罩, 窗口大小, 扩展像素, 阈值):
        mask = 遮罩
        if mask.dim() == 2:
            mask = mask.unsqueeze(0)

        B, H, W = mask.shape
        radius = 窗口大小 // 2

        bboxes = []
        for b in range(B):
            m = mask[b]
            binary = m >= 阈值

            if not binary.any():
                bboxes.append(None)
                continue

            rows = torch.any(binary, dim=1)
            cols = torch.any(binary, dim=0)

            y_indices = torch.where(rows)[0]
            x_indices = torch.where(cols)[0]

            y_min = y_indices[0].item()
            y_max = y_indices[-1].item()
            x_min = x_indices[0].item()
            x_max = x_indices[-1].item()

            x_min = max(0, x_min - 扩展像素)
            y_min = max(0, y_min - 扩展像素)
            x_max = min(W - 1, x_max + 扩展像素)
            y_max = min(H - 1, y_max + 扩展像素)

            bboxes.append((x_min, y_min, x_max, y_max))

        result_masks = []
        result_bboxes = []

        for i in range(B):
            start = max(0, i - radius)
            end = min(B, i + radius + 1)

            valid_bboxes = []
            for j in range(start, end):
                if bboxes[j] is not None:
                    valid_bboxes.append(bboxes[j])

            if not valid_bboxes:
                result_masks.append(torch.zeros(H, W, dtype=mask.dtype, device=mask.device))
                result_bboxes.append([0, 0, 0, 0])
                continue

            x_min = min(b[0] for b in valid_bboxes)
            y_min = min(b[1] for b in valid_bboxes)
            x_max = max(b[2] for b in valid_bboxes)
            y_max = max(b[3] for b in valid_bboxes)

            out = torch.zeros(H, W, dtype=mask.dtype, device=mask.device)
            out[y_min:y_max + 1, x_min:x_max + 1] = 1.0
            result_masks.append(out)
            result_bboxes.append([x_min, y_min, x_max - x_min + 1, y_max - y_min + 1])

        result = torch.stack(result_masks, dim=0)
        return (result, result_bboxes)
