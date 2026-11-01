"""Indexed prompt list for per-item ComfyUI workflows."""


class XiaozhuguangBatchPromptList:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "索引": ("INT", {"forceInput": True}),
                # Serialized backing value for the frontend card editor.
                "提示词列表": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("*",)
    FUNCTION = "select"
    CATEGORY = "小珠光/文本"
    DESCRIPTION = "每条提示词显示为独立卡片并可多行编辑。索引从 0 开始；索引超过条数时按条数循环取值。拖入 TXT 时每个非空行作为一条提示词追加，头部红色“清空”按钮可一键移除全部卡片。"

    @classmethod
    def IS_CHANGED(cls, 索引=0, 提示词列表=""):
        return (int(索引 or 0), str(提示词列表 or ""))

    @staticmethod
    def parse_entries(text):
        import json
        raw = str(text or "").strip()
        try:
            value = json.loads(raw)
            if isinstance(value, list):
                # Empty cards still occupy their video index.
                return [str(item) for item in value]
        except (ValueError, TypeError):
            pass
        normalized = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not normalized:
            return []
        return [entry.strip() for entry in __import__("re").split(r"(?m)^\s*---+\s*$", normalized) if entry.strip()]

    def select(self, 索引=0, 提示词列表=""):
        entries = self.parse_entries(提示词列表)
        index = int(索引 or 0)
        if not entries:
            raise ValueError("提示词列表为空，请先在节点中添加至少一条提示词")
        # 越界时按条数循环，避免批次中途断队列。
        return (entries[index % len(entries)],)
