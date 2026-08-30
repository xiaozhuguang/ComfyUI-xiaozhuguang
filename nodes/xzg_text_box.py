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
       中文口语时间 6点15分 → 六点十五分（完整读数，非按位）
  4) 书名号《》→ 句号。；省略号…… → 句号。
  5) 其他场景（纯数字、代码、分辨率如 1280x720、串号等）：
       6 位以内整数 → 完整读数（62→六十二，720→七百二十，1280→一千二百八十）
       数字 + 分辨率 → 数字按位读（720分辨率→七二零分辨率）
       7 位及以上 / 含小数点 → 按位逐字符转换（13812345678→一三八…，1.72→一点七二）
  6) 映射：0→零, 1→一, 2→二, 3→三, 4→四, 5→五, 6→六, 7→七, 8→八, 9→九
  7) 仅识别替换 0-9、小数点；其他字符（中文/英文/标点/负号等）保持原样
  8) 米 的口语读法（身高/长度习惯）：1.72米 → 一米七二（仅"米"单位 + 小数，整数按完整读、小数按位读）
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
#    - 为避免与中文名词混淆（例如 "720分辨率" 的 "分" 会把 "720分" 当成单位）
#      这类有强歧义的单字不收录：分、关、档、级、星
#      如需要表达相关量词，写双字词形式即可（分钟/秒钟/章节/条款/关卡/档次/级别…）
#    - 纯中文但较无歧义的计数/度量/时间/序号量词 仍收录，包括：
#      节、条、款、项、页、课（"98条→九十八条"，"第12条"已由序数正则优先占用，不冲突）
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
    "节", "条", "款", "项", "页", "课",
    "號", "樓", "層", "單元", "屆", "冊", "部",
    # 11) 时间
    "分钟", "秒钟", "小时", "钟头", "点钟", "点半",
    "星期", "礼拜", "天",
    # 年份时间后缀（2位数字+这些后缀 → 纪年简写按位读：24年底→二四年底）
    "年底", "年初", "年末", "年前", "年后", "年中", "年终", "年尾",
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
#   数字部分：-?\d+(?:\.\d+)?   （支持可选前导负号，如 -12℃）
#   量词部分：白名单
_QUANTIFIER_RE = re.compile(
    r"(-?\d+(?:\.\d+)?)"
    r"(" + "|".join(re.escape(u) for u in _QUANTIFIER_UNITS) + r")"
)
# 保留旧拼写作为别名（防止有外部引用）
_QUNATIFIER_RE = _QUANTIFIER_RE

# ────────────────────────────────────────────────────────────
#  分数 正则（带分数 + 普通分数）
#    1 1/2  →  一又二分之一  （带分数：整数 + 空格 + 分子/分母）
#    1/2    →  二分之一       （普通分数：分子/分母）
#    3/4    →  四分之三
#    负分数：-1/2 → 负二分之一，-2 1/3 → 负二又三分之一
#  前后加断言，避免日期（1/2/2024）或 IP 段（192/168/0/1）被误匹配：
#    - 左边界：前字符不能是 数字 / 斜杠 / 小数点
#    - 右边界：后字符不能是 数字 / 斜杠
# ────────────────────────────────────────────────────────────
_MIXED_FRACTION_RE = re.compile(
    r"(?<![\d/.])"            # 左边界
    r"(-?\d+)"                # 整数部分（可选负号）
    r"\s+"                    # 空格（带分数的整数与分数之间必须有空格）
    r"(\d+)/(\d+)"            # 分子/分母
    r"(?![\d/])"              # 右边界
)
_FRACTION_RE = re.compile(
    r"(?<![\d/.])"
    r"(-?\d+)/(\d+)"
    r"(?![\d/])"
)

# 2 位数 + 年份时间后缀 集合（纪年简写式：24年底 → 二四年底，不走"二十四年"）
_YEAR_SUFFIX_ABBREV = {"年底", "年初", "年末", "年前", "年后", "年中", "年终", "年尾"}

# 温度/温感单位集合（决定 "-12℃" 读"零下"还是"负"）
_TEMP_UNITS = {"摄氏度", "华氏度", "℃", "℉", "度"}
# 负号 量词回调里识别的单位集合快速查（温度→零下，其它→负）
_TEMP_UNIT_EXACT = _TEMP_UNITS | {"°C", "°F"}

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

# ────────────────────────────────────────────────────────────
#  比率 正则（A:B / A比B）
#   9:16   →  九比十六
#   16:9   →  十六比九
#   9比16  →  九比十六
#   4:3    →  四比三
# 两段数字均按完整读数（非按位读），中间分隔符统一为"比"。
# 仅匹配恰好为 ":" 或 "比" 的分隔符，不误伤"比较/比如"等词。
# ────────────────────────────────────────────────────────────
_RATIO_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*[:比]\s*(\d+(?:\.\d+)?)"
)

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

# ────────────────────────────────────────────────────────────
#  日期 / 时间 整体识别（优先于所有量词/序数/比率等规则）
#    2023.4.16 21:08  →  二零二三年四月十六日九点零八分
#    2023-04-16 09:08  →  二零二三年四月十六日九点零八分
#    2023/4/16         →  二零二三年四月十六日
#    21:08             →  九点零八分
#    21:00             →  九点整
#  关键读法规：
#    · 年份 → 按位读（2023→二零二三）；整千年例外用完整读数（2000→两千年）
#    · 月/日 → 完整读数（4→四，16→十六，10→十，20→二十）
#    · 小时 → 24 制转 12 制，完整读数（21→九，12→十二，0→十二）
#    · 分钟 → 完整读数；< 10 前置"零"（08→零八，5→零五）；00→"整"
#  分隔符：日期分隔符 . / - 任意混合；时间分隔符 冒号
# ────────────────────────────────────────────────────────────
_DATETIME_SEP = r"[./\-]"
# 日期 + 时间（完整）：YYYY.M.D HH:MM
_DATETIME_RE = re.compile(
    r"(?<!\d)"
    r"(\d{4})" + _DATETIME_SEP + r"(\d{1,2})" + _DATETIME_SEP + r"(\d{1,2})"
    r"[ T]"
    r"(\d{1,2}):(\d{1,2})"
    r"(?!\d)"
)
# 仅日期：YYYY.M.D
_DATE_ONLY_RE = re.compile(
    r"(?<!\d)"
    r"(\d{4})" + _DATETIME_SEP + r"(\d{1,2})" + _DATETIME_SEP + r"(\d{1,2})"
    r"(?!\d)"
)
# 仅时间：HH:MM（严格 2 位分钟 00-59，避免误伤 16:9 这种 A比B 比率格式）
#   合法时间示例：09:08 / 21:08 / 9:05（小时可1~2位）；分钟强制 2 位 → 不匹配 "16:9"
_TIME_ONLY_RE = re.compile(
    r"(?<![\d:])"
    r"(\d{1,2}):(\d{2})"
    r"(?![\d:])"
)


# 仅中文口语时间：X点Y分（如 6点15分 → 六点十五分）
# 冒号时间（21:08）走 _TIME_ONLY_RE；这里是中文写法。
# 注意"分"有强歧义（720分辨率），因此必须有完整"数字+点+数字+分"结构才匹配，
# 且小时/分钟做范围校验，超范围视为普通文本不处理。
_ZH_TIME_RE = re.compile(
    r"(?<!\d)"
    r"(\d{1,2})点(\d{1,2})分"
    r"(?!\d)"
)

# 剩余未匹配数字：整数（可带小数），用于 stage4 兜底
_REMAIN_NUM_RE = re.compile(r"[0-9]+(?:\.[0-9]+)?")  # 仅 ASCII 数字，避免匹配占位符中的全角数字
# 分辨率后缀例外：数字 + 分辨率 → 数字按位读（720分辨率→七二零分辨率）
_RESOLUTION_RE = re.compile(r"([0-9]+)分辨率")


def _zh_clock_hour(h24: int) -> str:
    """24 制小时 → 12 制中文读数：
       0/12 → 十二；1/13 → 一；9/21 → 九；11/23 → 十一
    """
    if not 0 <= h24 <= 24:  # 容忍 24
        return _int_to_zh_full(h24)
    m = h24 % 12
    if m == 0:
        return "十二"
    return _int_to_zh_full(m)


def _zh_clock_minute(mm: int) -> str:
    """分钟 → 中文：00 → 整；1-9 → 零X分；10-59 → 完整读数+分"""
    if mm == 0:
        return "整"
    s = _int_to_zh_full(mm)
    if mm < 10:
        return "零" + s + "分"
    return s + "分"


def _format_date_zh(y: int, m: int, d: int) -> str:
    """年月日 → XXXX年XX月XX日"""
    # 年份：4位按位读；整千年完整读数（2000→两千年）
    y_str = str(y)
    if y % 1000 == 0:
        y_zh = _int_to_zh_full(y)
        if y_zh.startswith("二千"):
            y_zh = "两" + y_zh[1:]
    else:
        y_zh = _digits_to_zh_by_char(y_str)
    m_zh = _int_to_zh_full(m)
    d_zh = _int_to_zh_full(d)
    return f"{y_zh}年{m_zh}月{d_zh}日"


def _format_time_zh(hh: int, mm: int) -> str:
    return f"{_zh_clock_hour(hh)}点{_zh_clock_minute(mm)}"


def _int_to_zh_full(n: int) -> str:
    """把一个非负整数按中文完整读法写出（万级+个级，覆盖 0~9999_9999）。

    规则关键点（含"二/两"上下文策略）：
      - 10～19 的"十"位最高省略"一"：12 → 十二，10 → 十
      - 每段中间连续的 0 合并为一个"零"：105 → 一百零五，1001 → 一千零一
      - 万级与个级之间（若个级 < 1000 且非 0），"万"后补"零"
      - 二/两策略（段首位）：
          · 段首位的 "2" 后面接 "百/千" → 用"两"：两百、两千
          · "十"位的 "2" → 永远"二"（二十、十二，不可"两十"）
          · 个位 "2" → 保持"二"，由量词回调按需转"两"
      - 二/两策略（万级）：
          · 万级是 2 → "两万"（不是"二万"，由外层替换修正）
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
                digit_zh = _ZH_DIGIT_MAP[str(digit)]
                # 段首位的 2 + 单位是 百/千 → 两；十/个位 保持二
                if digit == 2 and start == i and unit not in ("", "十"):
                    digit_zh = "两"
                out.append(digit_zh + unit)
        return "".join(out)

    wan = n // 10000
    ge = n % 10000
    if wan == 0:
        return _read_four(ge) or "零"

    wan_str = _read_four(wan)
    # 2万 → 两万（"二万"不自然）；万级是 2 时 _read_four 返回 "二"（个位 2），替换之
    if wan_str == "二":
        wan_str = "两"
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


def _is_cjk_char(ch: str) -> bool:
    """判断字符是否为 CJK 汉字（常用区 + 扩展A + 兼容表意 + 扩展B-G）。"""
    if not ch:
        return False
    cp = ord(ch)
    return (
        (0x4E00 <= cp <= 0x9FFF) or    # CJK 统一表意文字
        (0x3400 <= cp <= 0x4DBF) or    # 扩展 A
        (0xF900 <= cp <= 0xFAFF) or    # 兼容表意文字
        (0x20000 <= cp <= 0x2FA1F)     # 扩展 B-G
    )


def _strip_non_numeric_spaces(text: str) -> str:
    """仅删除中文文字（汉字）之间的多余空格；
    数字之间、英文字母之间以及中/英/数字混合处的空格均保留。

    例：'你好 世界'      → '你好世界'
        'Hello World'   → 'Hello World'
        '11 22'         → '11 22'
        '3 × 4'         → '3 × 4'
        '12 个'         → '12 个'
        '中文 abc'      → '中文 abc'
    """
    if not text:
        return text
    out = []
    for i, ch in enumerate(text):
        if ch == " ":
            prev = text[i - 1] if i > 0 else ""
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if _is_cjk_char(prev) and _is_cjk_char(nxt):
                continue  # 中文文字之间的多余空格删除
            out.append(ch)  # 其余空格保留
        else:
            out.append(ch)
    return "".join(out)


def _digits_to_zh(text: str) -> str:
    """把字符串中 0-9 转为中文数字：
      - 乘积/分辨率（1280x720, 3×4, 1x2x3）→ A乘以B 完整读数
      - 比率（9:16, 9比16, 16:9）→ A比B 完整读数
      - 数字 + 量词/单位白名单（含英文缩写转中文 cm→厘米…）→ 完整读数
      - 第/其 + 数字（+可选序号后缀） → 完整读数
      - 4位及以上数字 + "年" → 按位读（1926年→一九二六年）
      - 分数（1/2, 3/4, 1 1/2, -2 3/8）→ 分母+分之+分子
      - 负数 + 量词（-12℃, -5个）→ 零下/负 + 量词读数
      - 二/两上下文：200→两百、2000→两千、2万→两万；"2个/只/米…"→"两个…"
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
    # 用户指定：淼 → 邈（仅转中文输出，text 原文不受影响）
    text = text.replace("淼", "邈")
    # 用户指定：去掉所有间隔号 ・（达・芬奇→达芬奇、张・芬奇→张芬奇 等，仅转中文输出，text 原文不受影响）
    text = text.replace("・", "")
    # 用户指定：保留数字之间的空格，其余空格删除（仅转中文输出，text 原文不受影响）
    text = _strip_non_numeric_spaces(text)

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

    # ── 0) 日期 / 时间 整体识别（优先级最高，避免被量词/比率/序号拆散） ──
    #    0a) 日期 + 时间：2023.4.16 21:08 → 二零二三年四月十六日九点零八分
    def _datetime_sub(m: re.Match) -> str:
        try:
            y, mo, d, hh, mm = (int(x) for x in m.groups())
            return _hold(_format_date_zh(y, mo, d) + _format_time_zh(hh, mm))
        except ValueError:
            return m.group(0)

    stage0a = _DATETIME_RE.sub(_datetime_sub, text)

    #    0b) 仅日期：2023.4.16 → 二零二三年四月十六日
    def _date_sub(m: re.Match) -> str:
        try:
            y, mo, d = (int(x) for x in m.groups())
            return _hold(_format_date_zh(y, mo, d))
        except ValueError:
            return m.group(0)

    stage0b = _DATE_ONLY_RE.sub(_date_sub, stage0a)

    #    0c) 仅时间：21:08 → 九点零八分（排除 16:9 等比率场景：前后无数字/冒号已由断言保证）
    def _time_sub(m: re.Match) -> str:
        try:
            hh, mm = (int(x) for x in m.groups())
            # 小时范围若超过 23 视为比率不处理（例如 123:456 不可能是时间，本正则已限 1-2 位数字，但 30:00 等仍可能）
            if hh > 24 or mm > 59:
                return m.group(0)
            return _hold(_format_time_zh(hh, mm))
        except ValueError:
            return m.group(0)

    stage0c = _TIME_ONLY_RE.sub(_time_sub, stage0b)

    #    0d) 仅中文时间：6点15分 → 六点十五分（口语时间写法，须完整"X点Y分"结构）
    def _zh_time_sub(m: re.Match) -> str:
        try:
            hh, mm = (int(x) for x in m.groups())
            if hh > 24 or mm > 59:
                return m.group(0)
            return _hold(_format_time_zh(hh, mm))
        except ValueError:
            return m.group(0)

    stage0d = _ZH_TIME_RE.sub(_zh_time_sub, stage0c)

    stage1 = _ORDINAL_RE.sub(_ordinal_sub, stage0d)

    # ── 1.5) 分数：带分数 优先（长匹配），再处理普通分数
    #           优先级高于连乘链（1/2x3 先匹配 1/2，再留 x3 给连乘处理）
    def _mixed_fraction_sub(m: re.Match) -> str:
        """2 1/2 → 二又二分之一；-1 3/4 → 负一又四分之三"""
        int_part = m.group(1)
        num = m.group(2)
        den = m.group(3)
        sign = ""
        if int_part.startswith("-"):
            sign = "负"
            int_part = int_part[1:]
        int_zh = _int_to_zh_full(int(int_part))
        num_zh = _int_to_zh_full(int(num))
        den_zh = _int_to_zh_full(int(den))
        return _hold(f"{sign}{int_zh}又{den_zh}分之{num_zh}")

    stage1b = _MIXED_FRACTION_RE.sub(_mixed_fraction_sub, stage1)

    def _fraction_sub(m: re.Match) -> str:
        """1/2 → 二分之一；-3/4 → 负四分之三"""
        num = m.group(1)
        den = m.group(2)
        sign = ""
        if num.startswith("-"):
            sign = "负"
            num = num[1:]
        num_zh = _int_to_zh_full(int(num))
        den_zh = _int_to_zh_full(int(den))
        return _hold(f"{sign}{den_zh}分之{num_zh}")

    stage1c = _FRACTION_RE.sub(_fraction_sub, stage1b)

    # ── 2) 再处理 乘积 / 分辨率 链（1280x720 / 1x2x3 / 3×4） ──
    #    乘积场景按位读（分辨率/尺寸/型号感）：1280x720 → 一二八零乘以七二零
    def _multiply_sub(m: re.Match) -> str:
        chain = m.group(0)
        parts = _MULTIPLY_SPLIT_RE.split(chain)
        zh_parts = [_digits_to_zh_by_char(p) for p in parts]
        return _hold("乘以".join(zh_parts))

    stage2 = _MULTIPLY_CHAIN_RE.sub(_multiply_sub, stage1c)

    # ── 2.5) 比率（9:16 / 9比16）→ 完整读数比完整读数 ──
    def _ratio_sub(m: re.Match) -> str:
        left = _num_to_zh_full(m.group(1))
        right = _num_to_zh_full(m.group(2))
        return _hold(left + "比" + right)

    stage2b = _RATIO_RE.sub(_ratio_sub, stage2)

    # ── 3) 再处理 数字 + 量词/单位（含 % 百分号、英文缩写 → 中文单位、负数零下/负、2→两修正） ──
    def _quant_sub(m: re.Match) -> str:
        raw_num = m.group(1)  # 可能带前导 "-"
        unit = m.group(2)

        # 处理负号：先拆 sign 与 绝对值 num_str
        if raw_num.startswith("-"):
            sign = "-"
            num_str = raw_num[1:]
        else:
            sign = ""
            num_str = raw_num

        try:
            # 年份读法分支：unit == "年" 或 2位纪年简写后缀（年底/年初…）
            is_year_suffix = unit == "年"
            is_year_abbrev = (unit in _YEAR_SUFFIX_ABBREV) and ("." not in num_str) and (len(num_str) == 2)
            if (is_year_suffix or is_year_abbrev) and "." not in num_str:
                num_int = int(num_str)
                # 2 位数 + 年底/年初/年末/… → 纪年简写按位读：24年底→二四年底
                if is_year_abbrev:
                    base = _digits_to_zh_by_char(num_str)
                # 整千年（2000/3000/5000…）→ 完整读数，2000 读"两千"而非"二千"
                elif num_int >= 1000 and num_int % 1000 == 0:
                    base = _int_to_zh_full(num_int)
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

        # ── 二/两修正：单个整数 2（非小数、非多位）在量词前 → "两个/两只/两米/两岁"
        if "." not in num_str and num_str == "2":
            # _num_to_zh_full 返回 "二"，替换为 "两"
            if base == "二":
                base = "两"
            elif base.startswith("二") and len(base) == 1:
                base = "两"

        # ── 负号前缀：温度单位用"零下"，其它用"负"
        if sign == "-":
            zh_unit_check = _UNIT_TO_ZH.get(unit, unit)
            # 原单位名 或 其中文译名 命中温度集合 → "零下"
            if unit in _TEMP_UNIT_EXACT or zh_unit_check in _TEMP_UNIT_EXACT:
                base = "零下" + base
            else:
                base = "负" + base

        # 英文缩写 → 中文单位名（cm→厘米、kg→千克…），未命中则保留原单位
        zh_unit = _UNIT_TO_ZH.get(unit, unit)
        # ── 米 的口语读法（身高/长度习惯）：1.72米 → 一米七二
        #    仅当 单位=米、数字为小数、整数部分>0（0.5米 仍读"零点五米"）；带负号时走通用读法
        if unit == "米" and not sign and "." in num_str:
            _int_part, _frac_part = num_str.split(".", 1)
            if _int_part and int(_int_part) > 0 and _frac_part:
                _int_zh = _int_to_zh_full(int(_int_part))
                if _int_part == "2":
                    _int_zh = "两"  # 2.05米 → 两米零五
                _frac_zh = _digits_to_zh_by_char(_frac_part)
                return _hold(_int_zh + zh_unit + _frac_zh)
        if unit == "%":
            return _hold("百分之" + base)
        if unit == "‰":
            return _hold("千分之" + base)
        return _hold(base + zh_unit)

    stage3 = _QUANTIFIER_RE.sub(_quant_sub, stage2b)

    # ── 3.5) 用户指定：删除非乘法位置的 *（乘法链的 * 已在 stage2 转成"乘以"并被占位保护） ──
    stage3 = stage3.replace("*", "")

    # ── 3.6) 分辨率后缀例外：数字 + 分辨率 → 数字按位读（720分辨率→七二零分辨率） ──
    def _resolution_sub(m: re.Match) -> str:
        num = m.group(1)
        return _hold(_digits_to_zh_by_char(num) + "分辨率")

    stage3b = _RESOLUTION_RE.sub(_resolution_sub, stage3)

    # ── 4) 剩余数字：6 位以内整数 → 完整读数（62→六十二，720→七百二十，1280→一千二百八十）；
    #        7 位及以上 / 含小数点 → 按位读（13812345678→按位，1.72→一点七二） ──
    def _remain_sub(m: re.Match) -> str:
        ds = m.group(0)
        if "." not in ds and len(ds) <= 6:
            return _int_to_zh_full(int(ds))
        return _digits_to_zh_by_char(ds)

    stage4 = _REMAIN_NUM_RE.sub(_remain_sub, stage3b)

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
                        "规则：日期时间→整体转写；中文时间(6点15分)→完整读数；数字+量词→完整读数；第N→第N；4位+年→按位读；6位以内数字→完整读数(720→七百二十)；其余→按位读\n"
                        "例：2023.4.16 21:08→二零二三年四月十六日九点零八分\n"
                        "12个→十二个  1280x720→一二八零乘以七二零  1926年→一九二六年\n"
                        "6点15分→六点十五分  21:08→九点零八分\n"
                        "1.72米→一米七二  3.14kg→三点一四千克\n"
                        "720→七百二十  720分辨率→七二零分辨率\n"
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
