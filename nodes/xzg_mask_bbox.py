import torch


class XiaozhuguangMaskToBbox:
    """
    小珠光遮罩方框化
    找出遮罩边缘，转成矩形包围盒
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "遮罩": ("MASK",),
                "扩展像素": ("INT", {"default": 0, "min": 0, "max": 500}),
                "模式": (["单框全包", "多框分开"], {"default": "单框全包"}),
                "阈值": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
        }

    RETURN_TYPES = ("MASK", "BBOX", "INT", "INT")
    RETURN_NAMES = ("遮罩", "包围盒", "宽度", "高度")
    FUNCTION = "execute"
    CATEGORY = "小珠光"

    def execute(self, 遮罩, 扩展像素, 模式, 阈值):
        mask = 遮罩
        if mask.dim() == 2:
            mask = mask.unsqueeze(0)

        B, H, W = mask.shape
        result_masks = []
        result_bboxes = []
        result_w = 0
        result_h = 0

        for b in range(B):
            m = mask[b]
            binary = m >= 阈值

            if not binary.any():
                result_masks.append(torch.zeros_like(m))
                result_bboxes.append([0, 0, 0, 0])
                continue

            rows = torch.any(binary, dim=1)
            cols = torch.any(binary, dim=0)

            y_indices = torch.where(rows)[0]
            x_indices = torch.where(cols)[0]

            if 模式 == "单框全包":
                y_min = y_indices[0].item()
                y_max = y_indices[-1].item()
                x_min = x_indices[0].item()
                x_max = x_indices[-1].item()

                x_min = max(0, x_min - 扩展像素)
                y_min = max(0, y_min - 扩展像素)
                x_max = min(W - 1, x_max + 扩展像素)
                y_max = min(H - 1, y_max + 扩展像素)

                out = torch.zeros_like(m)
                out[y_min:y_max + 1, x_min:x_max + 1] = 1.0
                result_masks.append(out)
                result_bboxes.append([x_min, y_min, x_max - x_min + 1, y_max - y_min + 1])
                result_w = max(result_w, x_max - x_min + 1)
                result_h = max(result_h, y_max - y_min + 1)
            else:
                labeled = self._connected_components(binary)
                num_labels = labeled.max().item()
                out = torch.zeros_like(m)
                frame_bboxes = []

                for label_id in range(1, int(num_labels) + 1):
                    region = labeled == label_id
                    if not region.any():
                        continue

                    region_rows = torch.any(region, dim=1)
                    region_cols = torch.any(region, dim=0)

                    ry = torch.where(region_rows)[0]
                    rx = torch.where(region_cols)[0]

                    ry_min = ry[0].item()
                    ry_max = ry[-1].item()
                    rx_min = rx[0].item()
                    rx_max = rx[-1].item()

                    rx_min = max(0, rx_min - 扩展像素)
                    ry_min = max(0, ry_min - 扩展像素)
                    rx_max = min(W - 1, rx_max + 扩展像素)
                    ry_max = min(H - 1, ry_max + 扩展像素)

                    out[ry_min:ry_max + 1, rx_min:rx_max + 1] = 1.0
                    frame_bboxes.append([rx_min, ry_min, rx_max - rx_min + 1, ry_max - ry_min + 1])
                    result_w = max(result_w, rx_max - rx_min + 1)
                    result_h = max(result_h, ry_max - ry_min + 1)

                result_masks.append(out)
                result_bboxes.append(frame_bboxes if frame_bboxes else [0, 0, 0, 0])

        result = torch.stack(result_masks, dim=0)
        return (result, result_bboxes, result_w, result_h)

    def _connected_components(self, binary):
        H, W = binary.shape
        labels = torch.zeros(H, W, dtype=torch.int32, device=binary.device)
        current_label = 0
        equiv = {}

        for i in range(H):
            for j in range(W):
                if binary[i, j]:
                    neighbors = []
                    if i > 0 and labels[i - 1, j] > 0:
                        neighbors.append(labels[i - 1, j].item())
                    if j > 0 and labels[i, j - 1] > 0:
                        neighbors.append(labels[i, j - 1].item())

                    if not neighbors:
                        current_label += 1
                        labels[i, j] = current_label
                    else:
                        min_label = min(neighbors)
                        labels[i, j] = min_label
                        for nl in neighbors:
                            if nl != min_label:
                                if nl in equiv:
                                    equiv[nl].add(min_label)
                                else:
                                    equiv[nl] = {min_label}
                                if min_label in equiv:
                                    equiv[min_label].add(nl)
                                else:
                                    equiv[min_label] = {nl}

        parent = {}

        def find(x):
            while parent.get(x, x) != x:
                parent[x] = parent.get(parent[x], parent[x])
                x = parent[x]
            return x

        for a in equiv:
            for b in equiv[a]:
                pa = find(a)
                pb = find(b)
                if pa != pb:
                    parent[pa] = pb

        final_labels = torch.zeros(H, W, dtype=torch.int32, device=binary.device)
        label_map = {}
        new_label = 0

        for i in range(H):
            for j in range(W):
                if labels[i, j] > 0:
                    old = labels[i, j].item()
                    root = find(old)
                    if root not in label_map:
                        new_label += 1
                        label_map[root] = new_label
                    final_labels[i, j] = label_map[root]

        return final_labels
