# -*- coding: utf-8 -*-
"""
小珠光 · 系统监控悬浮窗 / System Monitor
=========================================
- 提供 /xzg/system_monitor_stats 接口，返回 GPU / CPU / 内存实时状态
- 前端（web/xzg_monitor.js）自动加载一个可拖拽的悬浮窗，每秒轮询展示

数据来源：
  - GPU：优先 pynvml（ComfyUI 环境已内置），失败时回退 nvidia-smi
  - CPU 使用率：Windows 下读取 PDH 性能计数器 \Processor Information(_Total)\% Processor Utility
    （任务管理器「性能」页同款计数器，考虑睿频、可能超过 100%），由系统性能计数器引擎
    实时计算，稳定可靠；非 Windows 或 PDH 不可用时回退 psutil.cpu_percent(interval=1)。
  - CPU 温度：Windows 下通过 WMI（MSAcpi_ThermalZoneTemperature）获取，
    多数主板不暴露该数据，取不到时返回 None，前端整行隐藏
  - 内存：psutil
"""

import asyncio
import ctypes
import json
import os
import subprocess
import threading
import time
import warnings

from ctypes import wintypes

import psutil
from aiohttp import web

from server import PromptServer

try:
    from .. import xzg_safe_handler as _xsh
    xzg_safe_handler = _xsh
except Exception:
    xzg_safe_handler = lambda fn: fn

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _to_float(value, default=0.0):
    """把任意值安全转成 float，失败返回 default。"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# GPU 采集（pynvml 优先，nvidia-smi 兜底）
# ---------------------------------------------------------------------------

def _gpu_stats_nvidia_smi():
    """使用 nvidia-smi 命令行采集所有 GPU 状态（兜底方案）。"""
    gpus = []
    try:
        proc = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True, text=True, timeout=5, creationflags=_CREATE_NO_WINDOW,
        )
        for line in (proc.stdout or "").strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 7:
                continue
            gpus.append({
                "index": parts[0],
                "name": parts[1],
                "util": _to_float(parts[2]),
                "temp": _to_float(parts[3]),
                "vram_used_mb": _to_float(parts[4]),
                "vram_total_mb": _to_float(parts[5]),
                "power_w": _to_float(parts[6]),
            })
    except Exception:
        gpus = []
    return gpus


def _gpu_stats_pynvml():
    """使用 pynvml 采集 GPU 状态。返回 (gpus)。"""
    gpus = []
    try:
        with warnings.catch_warnings():
            # pynvml 已弃用，静默其 FutureWarning，避免刷屏控制台
            warnings.simplefilter("ignore", FutureWarning)
            import pynvml
    except Exception:
        return _gpu_stats_nvidia_smi()

    try:
        pynvml.nvmlInit()
    except Exception:
        return _gpu_stats_nvidia_smi()

    try:
        count = pynvml.nvmlDeviceGetCount()
        for i in range(count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8", "ignore")
            try:
                power_w = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0
            except Exception:
                power_w = None
            gpus.append({
                "index": str(i),
                "name": name,
                "util": _to_float(util.gpu),
                "temp": _to_float(temp),
                # pynvml 返回字节数，统一换算成 MB（与 nvidia-smi 的 MiB 口径一致）
                "vram_used_mb": mem.used / (1024 * 1024),
                "vram_total_mb": mem.total / (1024 * 1024),
                "power_w": power_w,
            })
    except Exception:
        gpus = []
    finally:
        try:
            pynvml.nvmlShutdown()
        except Exception:
            pass
    return gpus


def _gpu_stats():
    try:
        return _gpu_stats_pynvml()
    except Exception:
        return _gpu_stats_nvidia_smi()


# ---------------------------------------------------------------------------
# CPU / 内存采集
# ---------------------------------------------------------------------------

# CPU 利用率后台采样线程。
# 数据源：Windows 上使用 PDH 性能计数器 \Processor Information(_Total)\% Processor Utility，
# 即任务管理器「性能」页同款计数器（考虑睿频、可能超过 100%），由系统性能计数器引擎实时计算。
# 此前用 psutil.cpu_percent()（基于 GetSystemTimes 自算）在高线程数（如 96 线程）、
# 后台任务繁忙的环境下偶发把 CPU 虚高算成 100%（idle 增量偶发归零导致），故改 PDH。
_cpu_util = {"value": 0.0}


# --- PDH（Performance Data Helper）ctypes 声明，仅 Windows ---
_PDH_FMT_DOUBLE = 0x00000200
if os.name == "nt":
    try:
        _PDH = ctypes.WinDLL("pdh.dll")
        _PDH.PdhOpenQueryW.restype = wintypes.LONG
        _PDH.PdhOpenQueryW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        _PDH.PdhAddEnglishCounterW.restype = wintypes.LONG
        _PDH.PdhAddEnglishCounterW.argtypes = [wintypes.HANDLE, wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        _PDH.PdhCollectQueryData.restype = wintypes.LONG
        _PDH.PdhCollectQueryData.argtypes = [wintypes.HANDLE]
        _PDH.PdhGetFormattedCounterValue.restype = wintypes.LONG
        _PDH.PdhGetFormattedCounterValue.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        _PDH.PdhCloseQuery.restype = wintypes.LONG
        _PDH.PdhCloseQuery.argtypes = [wintypes.HANDLE]
        _PDH_OK = True
    except Exception:
        _PDH = None
        _PDH_OK = False
else:
    _PDH = None
    _PDH_OK = False


class _PDH_FMT_COUNTERVALUE(ctypes.Structure):
    """PDH_FMT_COUNTERVALUE：CStatus + double 值。"""
    _fields_ = [
        ("CStatus", wintypes.DWORD),
        ("doubleValue", wintypes.DOUBLE),
    ]


class _PdhCpuSampler:
    """读取 \Processor Information(_Total)\% Processor Utility（任务管理器「性能」页同款计数器）。"""

    def __init__(self):
        self._pdh = _PDH
        self._query = None
        self._counter = None
        self.ok = False
        if not _PDH_OK:
            return
        try:
            q = wintypes.HANDLE()
            if self._pdh.PdhOpenQueryW(None, 0, ctypes.byref(q)) != 0:
                return
            h = wintypes.HANDLE()
            path = r"\Processor Information(_Total)\% Processor Utility"
            if self._pdh.PdhAddEnglishCounterW(q, path, 0, ctypes.byref(h)) != 0:
                self._pdh.PdhCloseQuery(q)
                return
            self._query, self._counter = q, h
            self._pdh.PdhCollectQueryData(q)  # 首次调用只建立基线
            self.ok = True
        except Exception:
            self.ok = False

    def read(self):
        """返回当前 1s 窗口平均 CPU 利用率；睿频时可能超过 100%（与任务管理器一致）。"""
        if not self.ok:
            return None
        try:
            v = _PDH_FMT_COUNTERVALUE()
            t = wintypes.DWORD()
            if self._pdh.PdhCollectQueryData(self._query) != 0:
                return None
            if self._pdh.PdhGetFormattedCounterValue(
                self._counter, _PDH_FMT_DOUBLE, ctypes.byref(t), ctypes.byref(v)
            ) != 0:
                return None
            if v.CStatus != 0:
                return None
            return max(0.0, v.doubleValue)
        except Exception:
            return None

    def close(self):
        try:
            if self._query is not None and self._pdh is not None:
                self._pdh.PdhCloseQuery(self._query)
        except Exception:
            pass
        self._query = self._counter = None
        self.ok = False


def _cpu_sampler_loop():
    pdh_sampler = _PdhCpuSampler() if _PDH_OK else None
    while True:
        time.sleep(1.0)
        try:
            val = pdh_sampler.read() if pdh_sampler else None
            if val is None:
                # PDH 不可用/读取失败：回退 psutil 阻塞式 1s（自带完整测量窗口）
                val = psutil.cpu_percent(interval=1)
            _cpu_util["value"] = val
        except Exception:
            _cpu_util["value"] = 0.0


def _start_cpu_sampler():
    thread = threading.Thread(target=_cpu_sampler_loop, daemon=True, name="xzg-cpu-sampler")
    thread.start()


_start_cpu_sampler()

_cpu_temp_cache = {"ts": 0.0, "val": None}


def _cpu_temperature():
    """Windows 下通过 WMI 获取 CPU 温度，结果缓存 5 秒，取不到返回 None。"""
    now = time.time()
    if now - _cpu_temp_cache["ts"] < 5:
        return _cpu_temp_cache["val"]

    value = None
    try:
        proc = subprocess.run(
            [
                "powershell", "-NoProfile", "-NonInteractive", "-Command",
                "(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature "
                "-ErrorAction SilentlyContinue | "
                "Measure-Object -Property CurrentTemperature -Maximum).Maximum",
            ],
            capture_output=True, text=True, timeout=3, creationflags=_CREATE_NO_WINDOW,
        )
        raw = (proc.stdout or "").strip()
        if raw:
            kelvin_tenths = _to_float(raw, 0.0)
            if kelvin_tenths > 0:
                value = round(kelvin_tenths / 10.0 - 273.15, 1)
    except Exception:
        value = None

    _cpu_temp_cache.update(ts=now, val=value)
    return value


def _cpu_stats():
    freq = psutil.cpu_freq()
    return {
        "util": _cpu_util["value"],
        "temp": _cpu_temperature(),
        "cores": psutil.cpu_count(logical=True) or 0,
        "freq_mhz": round(freq.current, 0) if freq else None,
    }


def _mem_stats():
    vm = psutil.virtual_memory()
    total_mb = vm.total / (1024 * 1024)
    if os.name == "nt":
        # Windows 下用 total - available 更贴近任务管理器显示的“占用”
        used_mb = (vm.total - vm.available) / (1024 * 1024)
    else:
        used_mb = vm.used / (1024 * 1024)
    percent = (used_mb / total_mb * 100.0) if total_mb > 0 else 0.0
    return {
        "used_mb": used_mb,
        "total_mb": total_mb,
        "percent": round(percent, 1),
    }


def _system_stats():
    gpus = _gpu_stats()
    return {
        "time": time.time(),
        "gpu": {
            "available": len(gpus) > 0,
            "gpus": gpus,
        },
        "cpu": _cpu_stats(),
        "mem": _mem_stats(),
    }


# ---------------------------------------------------------------------------
# HTTP 接口
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.get("/xzg/system_monitor_stats")
@xzg_safe_handler
async def get_system_monitor_stats(request):
    """返回 GPU / CPU / 内存实时状态（JSON）。"""
    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(None, _system_stats)
    return web.json_response(data)


# ---------------------------------------------------------------------------
# 节点定义
# ---------------------------------------------------------------------------

class XiaozhuguangSystemMonitor:
    """小珠光 · 系统监控悬浮窗：读取当前 GPU / CPU / 内存状态。

    该节点主要用于工作流内使用：
      - “显示悬浮窗”开关可控制前端悬浮窗的显示/隐藏；
      - “监控数据”输出当前状态 JSON 文本，可接入其它节点。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "show_float": (
                    "BOOLEAN",
                    {"default": True, "label_on": "显示悬浮窗", "label_off": "隐藏悬浮窗"},
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("监控数据",)
    OUTPUT_NODE = True
    FUNCTION = "run"
    CATEGORY = "xiaozhuguang"

    def run(self, show_float=True):
        stats = _system_stats()
        text = json.dumps(stats, ensure_ascii=False, indent=2)
        return (text,)


NODE_CLASS_MAPPINGS = {
    "XiaozhuguangSystemMonitor": XiaozhuguangSystemMonitor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiaozhuguangSystemMonitor": "小珠光系统监控",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
