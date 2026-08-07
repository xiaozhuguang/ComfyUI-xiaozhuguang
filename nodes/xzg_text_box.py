"""
小珠光文本框 (Xiaozhuguang Text Box)
输出文本提示词，支持将文本中的阿拉伯数字转换为中文数字。

转换策略（策略A：量词/单位 白名单匹配）：
  1) 当「数字（整数或小数）」**紧邻**一个常见单位/量词/货币词时，按中文完整读数读出：
       12岁     → 十二岁          12个     → 十二个
       1280米   → 一千二百八十米   3.14kg   → 三点一四kg
       12.5元   → 十二点五元       12%      → 百分之十二  （见特殊规则%）
       第12章   → 第十二章        （"第"前缀另做处理，见下文）
     支持的数字 + 单位形式：
        整数：  12 / 1280 / 100001
        小数：  3.14 / 12.5 / 0.618
     % 的特殊规则：匹配「数字 + %」时输出为「百分之 + 完整读数」。
  2) 「第/其」前缀 + 数字 + 可选「号/章/节/条/届/次/版/卷/期/…」：完整读数（第一、其二…）
  3) 4位及以上数字 + "年"：按位读（年份式读法），整千年例外用完整读数
       1926年   → 一九二六年      2024年   → 二零二四年
       2000年   → 两千年（整千年）   5000年   → 五千年（整千年）
       3年      → 三年（<4位仍用完整读数）
  4) 书名号《》→ 句号。；省略号…… → 句号。
  5) 其他场景（纯数字、代码、分辨率如 1280x720、串号等）按位逐字符转换：
       12    → 一二
       1280  → 一二八零
  6) 映射：0→零, 1→一, 2→二, 3→三, 4→四, 5→五, 6→六, 7→七, 8→八, 9→九
  7) 仅识别替换 0-9、小数点；其他字符（中文/英文/标点/负号等）保持原样
"""

import re

_ZH_DIGIT_MAP = {
    "0": "零", "1": "一", "2": "二", "3": "三", "4": "四",
    "5": "五", "6": "六", "7": "七", "8": "八", "9": "九",
}

# ────────────────────────────────────────────────────────────
#  量词/单位/后缀 白名单（数字 紧跟这些词 → 完整读数）
#  注意：
#    - 正则匹配时按长度降序排序，长字符串优先匹配（"千克" 优先于 "克"）
#    - 为避免与中文名词混淆（例如 "720分辨率" 的 "分"、"第12条" 的"条"
#      作量词但"条款"的"条"作名词），这里不收录有明显歧义的单字：
#        分、节、条、款、项、页、课、关、档、级、星
#      如需要表达这些量词，写双字词形式即可（分钟/秒钟/章节/条款/…）
#      注："秒" 单字已收录（15秒→十五秒），"秒钟" 优先于 "秒" 匹配。
#    - 纯中文但较无歧义的计数/度量/时间/序号量词 仍收录
# ────────────────────────────────────────────────────────────
_QUANTIFIER_UNITS = [
    # 1) 年龄
    "岁", "周岁", "虚岁", "岁半", "岁多", "来岁", "几岁",
    "歲", "周歲", "虛歲",
    # 2) 中文常用量词（计数、无歧义）
    "个", "只", "本", "张", "件", "双", "对", "套", "副",
    "位", "名", "群", "批", "堆", "组", "排", "列", "行",
    "颗", "粒", "棵", "株", "根", "段", "截", "片", "面",
    "把", "扇", "盏", "台", "辆", "架", "艘", "匹",
    "头", "口", "尾", "羽", "支", "枝", "杆", "栋", "间",
    "所", "座", "家", "户", "封", "则", "首", "篇",
    "幅", "出", "场", "顿", "盘", "碗", "碟", "杯",
    "瓶", "罐", "桶", "箱", "盒", "包", "袋",
    # 3) 重量（含中文+英文缩写，双字缩写优先排到前面已由 sorted(len) 保证）
    "千克", "毫克", "公斤",
    "克", "吨", "斤", "两", "钱",
    "kg", "Kg", "KG", "lbs", "lb", "mg", "Mg",
    "g", "G", "t", "T",
    # 4) 长度 / 距离（中文长词优先）
    "平方米", "平方千米", "立方米", "立方厘米",
    "千米", "公里", "厘米", "毫米", "微米", "纳米", "公分",
    "英寸", "英尺", "mile", "Mile",
    "米", "寸", "尺", "丈", "里", "码",
    "km", "cm", "mm", "um", "nm",
    "m",
    # 5) 面积 / 体积 / 容量
    "公顷", "公升", "毫升",
    "亩", "平方",
    "升",
    "mL", "ml",
    "L", "l",
    # 6) 货币（长词优先）
    "美元", "欧元", "日元", "港币", "台币", "英镑", "法郎", "马克",
    "元", "角", "块", "毛",
    "¥", "￥", "$", "€", "£", "¢",
    # 7) 温度 / 电学 / 能量 / 压力
    "摄氏度", "华氏度",
    "千伏", "毫伏", "毫安", "微安", "千瓦", "兆瓦", "千焦", "千卡",
    "千欧", "兆欧",
    "度", "℃", "℉",
    "伏", "V", "kV", "mv", "mV",
    "安", "A", "mA", "uA", "μA",
    "瓦", "W", "kW", "MW",
    "焦", "千", "卡", "J", "kJ", "kcal", "cal",
    "欧", "Ω", "Ωm",
    "Pa", "kPa", "MPa", "bar", "Bar",
    # 8) 数据量 / 频率 / 显示 / 速率（长词优先）
    "kHz", "MHz", "GHz", "kbps", "Mbps", "Gbps",
    "Hz", "hz", "bps", "Bps",
    "dpi", "DPI", "ppi", "PPI",
    "km/h", "km/H", "KM/H", "m/s", "M/S", "mph", "MPH",
    "KB", "MB", "GB", "TB", "PB",
    "B", "K", "k", "M", "G", "T",
    # 9) 角度 / 比率
    "%", "‰",
    # 10) 序号编号单位（常用、歧义较小）
    "单元", "号楼", "号楼层",
    "号", "栋", "楼", "层", "室", "房",
    "届", "次", "版", "卷", "期", "章", "册", "集", "话", "季", "部",
    "號", "樓", "層", "單元", "屆", "冊", "部",
    # 11) 时间
    "分钟", "秒钟", "小时", "钟头", "点钟", "点半",
    "星期", "礼拜",
    "余年", "年", "月", "日", "时", "点", "周", "秒",
    # 12) 繁体/台港澳 常用量词（长词优先，且单字无歧义的收录）
    "歲", "樓", "號", "層", "節", "項", "冊", "個",
    "隻", "條", "張", "公里", "公斤", "公升",
]

# 去重 + 长度降序（长字符串优先匹配，避免 "克" 吃掉 "千克" 前缀等误匹配）
_QUANTIFIER_UNITS = sorted(set(_QUANTIFIER_UNITS), key=len, reverse=True)

# ────────────────────────────────────────────────────────────
#  英文缩写单位 → 中文单位名
#  仅把"公制度量衡/电学/温度"这类较无歧义的缩写转成中文；
#  保留数据量 (GB/MB/K/M/T)、速率 (Mbps/km/h)、显示 (dpi/PPI) 等英文缩写原样。
#  注意区分大小写敏感：
#    m=米，M=兆（存储，不译）；g=克，G=吉（存储，不译）；t=吨，T=太（存储，不译）
#    V/W/A/J/Pa/℃/℉/Ω 电学及物理缩写：大小写对应含义明确，逐一枚举。
# ────────────────────────────────────────────────────────────
_UNIT_TO_ZH = {
    # 长度
    "km": "千米", "KM": "千米", "Km": "千米",
    "cm": "厘米", "CM": "厘米", "Cm": "厘米",
    "mm": "毫米", "MM": "毫米", "Mm": "毫米",
    "um": "微米", "μm": "微米", "UM": "微米",
    "nm": "纳米", "NM": "纳米", "Nm": "纳米",
    "m":  "米",
    # 重量
    "kg": "千克", "Kg": "千克", "KG": "千克",
    "mg": "毫克", "Mg": "毫克", "MG": "毫克",
    "g":  "克",
    "t":  "吨",
    "lbs": "磅", "lb": "磅",
    # 体积/容量
    "L":  "升", "l": "升",
    "mL": "毫升", "ml": "毫升", "ML": "毫升", "Ml": "毫升",
    # 温度
    "℃":  "摄氏度",
    "℉":  "华氏度",
    # 电压
    "kV": "千伏", "KV": "千伏",
    "V":  "伏",
    "mv": "毫伏", "mV": "毫伏", "MV": "毫伏",
    # 电流
    "A":  "安",
    "mA": "毫安", "ma": "毫安", "MA": "毫安",
    "uA": "微安", "μA": "微安", "UA": "微安",
    # 功率 / 能量
    "kW": "千瓦", "KW": "千瓦",
    "MW": "兆瓦",
    "W":  "瓦",
    "kJ": "千焦", "KJ": "千焦",
    "J":  "焦",
    "kcal": "千卡", "Kcal": "千卡", "KCAL": "千卡",
    "cal": "卡", "Cal": "卡", "CAL": "卡",
    # 电阻 / 压力
    "Ω":  "欧", "Ωm": "欧米",
    "Pa": "帕", "PA": "帕",
    "kPa": "千帕", "KPa": "千帕", "KPA": "千帕",
    "MPa": "兆帕", "Mpa": "兆帕", "MPA": "兆帕",
    "bar": "巴", "Bar": "巴", "BAR": "巴",
    # 货币符号 → 中文货币词（保留位置感直接加在后面即可）
    "¥":  "人民币", "￥": "人民币",
    "$":  "美元",
    "€":  "欧元",
    "£":  "英镑",
    "¢":  "分",
}

# 主正则：数字（整数或小数）+ 量词/单位
#   数字部分：\d+(?:\.\d+)?
#   量词部分：白名单
_QUANTIFIER_RE = re.compile(
    r"(\d+(?:\.\d+)?)"
    r"(" + "|".join(re.escape(u) for u in _QUANTIFIER_UNITS) + r")"
)
# 保留旧拼写作为别名（防止有外部引用）
_QUNATIFIER_RE = _QUANTIFIER_RE

# ────────────────────────────────────────────────────────────
#  乘积 / 分辨率 正则（连乘链，2 段及以上）
#   1280x720   →  一千二百八十乘以七百二十
#   1x2x3      →  一乘以二乘以三
#   3 × 4      →  三乘以四  (运算符前后可带空格)
#   1920×1080  →  一千九百二十乘以一千零八十
# 先匹配一整条连乘链（≥2 个数），再在回调里按乘号拆开逐个转写。
# ────────────────────────────────────────────────────────────
_MULTIPLY_CHAIN_RE = re.compile(
    r"\d+(?:\.\d+)?(?:\s*[xX×\*]\s*\d+(?:\.\d+)?){1,}"
)
_MULTIPLY_SPLIT_RE = re.compile(r"\s*[xX×\*]\s*")

# 「第 / 其」 序数前缀匹配：(第|其) + 整数（1-4位足以覆盖常用序数，放宽到无上限）+ 可选序号后缀
_ORDINAL_SUFFIXES = [
    "号", "栋", "楼", "层", "室", "房", "单元",
    "届", "次", "版", "卷", "期", "章", "节", "条", "款", "项",
    "课", "册", "集", "话", "季", "部", "名", "位",
    "號", "樓", "層", "單元", "屆", "冊", "節", "項", "部",
]
_ORDINAL_SUFFIXES = sorted(set(_ORDINAL_SUFFIXES), key=len, reverse=True)
_ORDINAL_RE = re.compile(
    r"(第|其)(\d+)("
    + ("|".join(re.escape(u) for u in _ORDINAL_SUFFIXES))
    + r")?"
)

# 千/百/十/个 小单位
_SMALL_UNITS = ["", "十", "百", "千"]


def _int_to_zh_full(n: int) -> str:
    """把一个非负整数按中文完整读法写出（万级+个级，覆盖 0~9999_9999）。

    规则关键点：
      - 10～19 的"十"位最高省略"一"：12 → 十二，10 → 十
      - 每段中间连续的 0 合并为一个"零"：105 → 一百零五，1001 → 一千零一
      - 万级与个级之间（若个级 < 1000 且非 0），"万"后补"零"
    """
    if n < 0:
        n = -n
    if n == 0:
        return "零"

    def _read_four(digits4: int) -> str:
        if digits4 == 0:
            return ""
        d = [digits4 // 1000, (digits4 // 100) % 10, (digits4 // 10) % 10, digits4 % 10]
        start = 0
        while start < 4 and d[start] == 0:
            start += 1
        if start >= 4:
            return ""
        out = []
        pending_zero = False
        for i in range(start, 4):
            digit = d[i]
            unit_idx = 3 - i
            if digit == 0:
                pending_zero = True
                continue
            if pending_zero and out:
                out.append("零")
                pending_zero = False
            unit = _SMALL_UNITS[unit_idx]
            if unit == "十" and digit == 1 and start == i:
                out.append("十")
            else:
                out.append(_ZH_DIGIT_MAP[str(digit)] + unit)
        return "".join(out)

    wan = n // 10000
    ge = n % 10000
    if wan == 0:
        return _read_four(ge) or "零"

    wan_str = _read_four(wan)
    ge_str = _read_four(ge)
    if not ge_str:
        return wan_str + "万"
    if ge < 1000:
        return wan_str + "万零" + ge_str
    return wan_str + "万" + ge_str


def _num_to_zh_full(num_str: str) -> str:
    """把一个 数字字符串（整数或小数，可含一个小数点）转为完整中文读数。

    小数部分按位读（习惯读法）：3.14 → 三点一四；12.05 → 十二点零五。
    """
    if not num_str:
        return ""
    if "." in num_str:
        int_part, frac_part = num_str.split(".", 1)
        # 整数部分若为空（如 ".5"）→ 当作 0
        int_zh = _int_to_zh_full(int(int_part)) if int_part else "零"
        # 小数部分按位读
        frac_zh = "".join(_ZH_DIGIT_MAP.get(ch, ch) for ch in frac_part)
        return int_zh + "点" + frac_zh
    return _int_to_zh_full(int(num_str))


def _digits_to_zh_by_char(text: str) -> str:
    """按位逐字符替换 0-9 为中文数字，其他字符原样保留。

    小数点处理：当 "." 前后均为数字时，作为小数点转为"点"
    （如 3.2 → 三点二）；其余情况（句末标点等）保留原样不转。
    """
    if not text:
        return ""
    out = []
    _ascii_digits = "0123456789"
    for i, ch in enumerate(text):
        if ch in _ZH_DIGIT_MAP:
            out.append(_ZH_DIGIT_MAP[ch])
        elif ch == ".":
            # 仅当 "." 前后均为 ASCII 数字时，作为小数点转为"点"
            prev_is_digit = i > 0 and text[i - 1] in _ascii_digits
            next_is_digit = i + 1 < len(text) and text[i + 1] in _ascii_digits
            if prev_is_digit and next_is_digit:
                out.append("点")
            else:
                out.append(ch)
        else:
            out.append(_ZH_DIGIT_MAP.get(ch, ch))
    return "".join(out)


def _digits_to_zh(text: str) -> str:
    """把字符串中 0-9 转为中文数字：
      - 乘积/分辨率（1280x720, 3×4, 1x2x3）→ A乘以B 完整读数
      - 数字 + 量词/单位白名单（含英文缩写转中文 cm→厘米…）→ 完整读数
      - 第/其 + 数字（+可选序号后缀） → 完整读数
      - 4位及以上数字 + "年" → 按位读（1926年→一九二六年）
      - 其他 → 按位读
    使用 Unicode 私用码位 + 全角数字 作为占位符，
    确保占位符本身不包含 ASCII 0-9，不会被按位转换二次改写。
    """
    if not text:
        return ""

    # 书名号《》→ 句号。；省略号…… → 句号。
    text = text.replace("《", "。").replace("》", "。")
    text = text.replace("……", "。")
    text = text.replace("+", "加")

    MARK_HEAD = "\uE000"  # Unicode Private Use 起始
    MARK_TAIL = "\uE001"

    def _to_fullwidth_num(n: int) -> str:
        return "".join(chr(ord("０") + int(ch)) for ch in str(n))

    def _from_fullwidth_num(s: str) -> int:
        return int("".join(str(ord(ch) - ord("０")) for ch in s))

    held: list[str] = []
    slot_counter = 0

    def _hold(s: str) -> str:
        nonlocal slot_counter
        held.append(s)
        slot = slot_counter
        slot_counter += 1
        return f"{MARK_HEAD}{_to_fullwidth_num(slot)}{MARK_TAIL}"

    # ── 1) 先处理 序数：第/其 + 整数（+ 可选序号后缀） ──
    def _ordinal_sub(m: re.Match) -> str:
        prefix = m.group(1)
        int_str = m.group(2)
        suffix = m.group(3) or ""
        zh = _int_to_zh_full(int(int_str))
        return _hold(prefix + zh + suffix)

    stage1 = _ORDINAL_RE.sub(_ordinal_sub, text)

    # ── 2) 再处理 乘积 / 分辨率 链（1280x720 / 1x2x3 / 3×4） ──
    #    乘积场景按位读（分辨率/尺寸/型号感）：1280x720 → 一二八零乘以七二零
    def _multiply_sub(m: re.Match) -> str:
        chain = m.group(0)
        parts = _MULTIPLY_SPLIT_RE.split(chain)
        zh_parts = [_digits_to_zh_by_char(p) for p in parts]
        return _hold("乘以".join(zh_parts))

    stage2 = _MULTIPLY_CHAIN_RE.sub(_multiply_sub, stage1)

    # ── 3) 再处理 数字 + 量词/单位（含 % 百分号、英文缩写 → 中文单位） ──
    def _quant_sub(m: re.Match) -> str:
        num_str = m.group(1)
        unit = m.group(2)
        try:
            # 年份特殊读法
            if unit == "年" and "." not in num_str:
                num_int = int(num_str)
                # 整千年（2000/3000/5000…）→ 完整读数，2000 读"两千"而非"二千"
                if num_int >= 1000 and num_int % 1000 == 0:
                    base = _int_to_zh_full(num_int)
                    # 二千 → 两千（年份场景更自然）
                    if base.startswith("二千"):
                        base = "两" + base[1:]
                # 4位及以上非整千年 → 按位读（1926年→一九二六年）
                elif len(num_str) >= 4:
                    base = _digits_to_zh_by_char(num_str)
                else:
                    base = _num_to_zh_full(num_str)
            else:
                base = _num_to_zh_full(num_str)
        except ValueError:
            base = _digits_to_zh_by_char(num_str)
        # 英文缩写 → 中文单位名（cm→厘米、kg→千克…），未命中则保留原单位
        zh_unit = _UNIT_TO_ZH.get(unit, unit)
        if unit == "%":
            return _hold("百分之" + base)
        if unit == "‰":
            return _hold("千分之" + base)
        return _hold(base + zh_unit)

    stage3 = _QUANTIFIER_RE.sub(_quant_sub, stage2)

    # ── 4) 剩余数字（纯编号/代码/串号）按位读 ──
    stage4 = _digits_to_zh_by_char(stage3)

    # ── 5) 还原占位符 ──
    slot_pat = re.compile(
        re.escape(MARK_HEAD) + r"([" + "０-９" + r"]+)" + re.escape(MARK_TAIL)
    )

    def _restore(m: re.Match) -> str:
        try:
            return held[_from_fullwidth_num(m.group(1))]
        except (IndexError, ValueError):
            return m.group(0)

    return slot_pat.sub(_restore, stage4)


class XiaozhuguangTextBox:
    """
    小珠光文本框 / Xiaozhuguang Text Box
    提供文本输入和双通道输出：
      - text        : 原始文本（不变，便于其他节点直接复用）
      - text_zh_num : 数字转中文后的文本（默认始终开启）：
          · 乘积/分辨率（1280x720 / 1x2x3 / 3×4）→ A乘以B 完整读数
          · 数字 + 量词/单位（个/只/米/千克/元/度/%/岁/时…白名单内，含英文缩写 cm→厘米…）→ 完整读数
          · 第/其 + 数字（+可选序号后缀）→ 完整读数（第十二章）
          · 4位及以上数字 + 年 → 按位读（1926年→一九二六年），整千年例外用完整读数（2000年→两千年）
          · 书名号《》→ 句号。；省略号…… → 句号。
          · 其他数字 → 按位读（12→一二）
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder":
                        "【小珠光文本框】\n"
                        "输出：text 原文 / text_zh_num 数字转中文\n"
                        "规则：数字+量词→完整读数；第N→第N；4位+年→按位读；其余→按位读\n"
                        "例：12个→十二个  1280x720→一二八零乘以七二零  1926年→一九二六年\n"
                        "《》→。  ……→。",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("text", "text_zh_num")
    FUNCTION = "execute"
    CATEGORY = "xiaozhuguang"

    def execute(self, text):
        raw = text if text is not None else ""
        return (raw, _digits_to_zh(raw))

    @classmethod
    def IS_CHANGED(cls, text):
        raw = text if text is not None else ""
        return _digits_to_zh(raw)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangTextBox": XiaozhuguangTextBox,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangTextBox": "小珠光文本框 / Xiaozhuguang Text Box",
}
