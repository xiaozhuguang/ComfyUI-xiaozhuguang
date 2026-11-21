"""小珠光节点: 显存内存清理。

复刻自 comfyui_memory_cleanup 的 VRAMCleanup / RAMCleanup，并合并为一个节点：
- 显存组：卸载模型、清空显存缓存
- 内存组：清理文件缓存、清理进程内存、清理未使用 DLL、重试次数
支持任意类型输入透传（输出 output），可串联进工作流，每次执行都会运行。
"""
import ctypes
import gc
import platform
import time
from ctypes import wintypes

import psutil

try:
    from server import PromptServer
except Exception:  # 脱离 ComfyUI 服务运行时（如单测）降级
    PromptServer = None

import comfy.model_management


class AnyType(str):
    """任意类型：类型比较时恒相等，便于透传上游数据。"""

    def __eq__(self, _) -> bool:
        return True

    def __ne__(self, _) -> bool:
        return False

    def __hash__(self) -> int:
        return hash("*")


any_type = AnyType("*")


class XiaozhuguangMemoryCleanup:
    """小珠光显存内存清理（显存 + 内存合并版）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # —— 显存 ——
                "卸载模型": ("BOOLEAN", {"default": True}),
                "清空显存缓存": ("BOOLEAN", {"default": True}),
                # —— 内存 ——
                "清理文件缓存": ("BOOLEAN", {"default": True}),
                "清理进程内存": ("BOOLEAN", {"default": True}),
                "清理未使用DLL": ("BOOLEAN", {"default": True}),
                "重试次数": ("INT", {"default": 3, "min": 1, "max": 10, "step": 1}),
            },
            "optional": {
                "任意": (any_type, {}),
            },
        }

    RETURN_TYPES = (any_type,)
    RETURN_NAMES = ("output",)
    OUTPUT_NODE = True
    FUNCTION = "clean"
    CATEGORY = "小珠光/其他"
    DESCRIPTION = (
        "清理显存与系统内存。显存组：卸载模型、清空显存缓存；"
        "内存组：清理文件缓存、清理进程内存、清理未使用 DLL（Windows 生效）、重试次数。"
        "「任意」输入会原样透传到 output，可串联进工作流。"
    )

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 每次执行都清理，避免被缓存跳过
        return float(time.time())

    @staticmethod
    def _ram_usage():
        memory = psutil.virtual_memory()
        return memory.percent, memory.available / (1024 * 1024)

    def _clean_vram(self, unload_model, empty_cache):
        if not (unload_model or empty_cache):
            return
        try:
            if unload_model:
                comfy.model_management.unload_all_models()

            if empty_cache:
                gc.collect()
                comfy.model_management.soft_empty_cache()
                if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
                    try:
                        PromptServer.instance.prompt_queue.set_flag("free_memory", True)
                    except Exception:
                        pass

            print(f"[小珠光] 显存清理完成 [卸载模型: {unload_model}, 清空缓存: {empty_cache}]")
        except Exception as e:
            print(f"[小珠光] 显存清理失败: {e}")

    def _clean_ram(self, clean_file_cache, clean_processes, clean_dlls, retry_times):
        if not (clean_file_cache or clean_processes or clean_dlls):
            return
        system = platform.system()
        try:
            for _ in range(retry_times):
                if clean_file_cache:
                    try:
                        if system == "Windows":
                            ctypes.windll.kernel32.SetSystemFileCacheSize(-1, -1, 0)
                        elif system == "Linux":
                            ctypes.CDLL("libc.so.6").malloc_trim(0)
                    except Exception:
                        pass

                if clean_processes and system == "Windows":
                    for process in psutil.process_iter(["pid"]):
                        try:
                            handle = ctypes.windll.kernel32.OpenProcess(
                                wintypes.DWORD(0x001F0FFF),
                                wintypes.BOOL(False),
                                wintypes.DWORD(process.info["pid"]),
                            )
                            ctypes.windll.psapi.EmptyWorkingSet(handle)
                            ctypes.windll.kernel32.CloseHandle(handle)
                        except Exception:
                            continue

                if clean_dlls:
                    try:
                        if system == "Windows":
                            ctypes.windll.kernel32.SetProcessWorkingSetSize(-1, -1, -1)
                    except Exception:
                        pass

                # 给系统留出回收时间（与原插件一致）
                time.sleep(1)
        except Exception as e:
            print(f"[小珠光] 内存清理失败: {e}")

    def clean(
        self,
        卸载模型=True,
        清空显存缓存=True,
        清理文件缓存=True,
        清理进程内存=True,
        清理未使用DLL=True,
        重试次数=3,
        任意=None,
    ):
        before_usage, before_available = self._ram_usage()

        try:
            retry_times = min(max(int(重试次数), 1), 10)
        except (TypeError, ValueError):
            retry_times = 3

        self._clean_vram(bool(卸载模型), bool(清空显存缓存))
        self._clean_ram(bool(清理文件缓存), bool(清理进程内存), bool(清理未使用DLL), retry_times)

        after_usage, after_available = self._ram_usage()
        freed_mb = after_available - before_available
        print(
            f"[小珠光] 显存内存清理完成 "
            f"[内存 {before_usage:.1f}% → {after_usage:.1f}%, 释放: {freed_mb:.0f}MB]"
        )
        return (任意,)
