"""Auto-install the small Python dependencies Pose Studio needs at runtime.

ComfyUI installs this plugin in ways that often skip ``pip``:

* the folder is copied/extracted by hand (plugin packs,网盘, cloud images),
* ComfyUI-Manager installs the node but the pip step fails on an unrelated
  entry of the root ``requirements.txt`` (pip aborts the whole resolution),
* an existing install is updated through ``git pull`` or Manager, which does
  not re-run ``pip install -r requirements.txt``.

The pose recognition path imports a handful of wheels lazily, so a missing
package used to surface as a bare ``No module named 'roma'`` in the middle of a
request. This module checks a strict allowlist (only small, pose-specific
packages; never torch/torchvision/numpy/transformers/opencv, which must stay
untouched) and installs what is missing with the interpreter that is actually
running ComfyUI.

Everything here is best-effort: failures are logged and never raised, so a
broken network cannot prevent ComfyUI from starting.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import subprocess
import sys
import threading

# import name -> pip requirement. Keep this list limited to packages that are
# only needed by Pose Studio and are cheap/safe to add to an existing env.
POSE_PACKAGES = {
    "roma": "roma",
    "yacs": "yacs",
    "omegaconf": "omegaconf",
    "einops": "einops",
    "timm": "timm",
    "pytorch_lightning": "pytorch-lightning",
}

_LOG_PREFIX = "[小珠光PoseStudio]"
_DEFAULT_TIMEOUT = 300
_OUTPUT_TAIL = 800

_SYNC_LOCK = threading.Lock()
_LAST_RESULT = None


def auto_install_enabled():
    """``XZG_POSE_AUTO_INSTALL=0`` disables pip runs from within ComfyUI."""
    value = str(os.environ.get("XZG_POSE_AUTO_INSTALL", "1")).strip().lower()
    return value not in {"0", "false", "no", "off"}


def _pip_name(module_name):
    return POSE_PACKAGES.get(module_name, module_name)


def _is_installed(module_name):
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def missing_packages():
    """Missing pip requirement names, in allowlist order."""
    return [
        requirement
        for module_name, requirement in POSE_PACKAGES.items()
        if not _is_installed(module_name)
    ]


def _pip_command(requirements):
    return [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--no-input",
        "--disable-pip-version-check",
        "--upgrade-strategy",
        "only-if-needed",
        "--timeout",
        "20",
        "--retries",
        "1",
        *requirements,
    ]


def install_packages(requirements, timeout=_DEFAULT_TIMEOUT):
    """Run pip for the given requirements. Returns ``(ok, log_tail)``."""
    if not requirements:
        return True, ""
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            _pip_command(requirements),
            capture_output=True,
            text=True,
            timeout=timeout,
            **kwargs,
        )
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
    output = f"{completed.stdout or ''}\n{completed.stderr or ''}".strip()
    return completed.returncode == 0, output[-_OUTPUT_TAIL:]


def ensure_pose_dependencies(timeout=_DEFAULT_TIMEOUT):
    """Install missing allowlisted packages. Safe to call from any thread."""
    global _LAST_RESULT
    missing = missing_packages()
    if not missing:
        return {"ok": True, "installed": [], "missing": [], "log": ""}

    if not auto_install_enabled():
        result = {
            "ok": False,
            "installed": [],
            "missing": missing,
            "log": "auto install disabled (XZG_POSE_AUTO_INSTALL=0)",
        }
        _LAST_RESULT = result
        return result

    with _SYNC_LOCK:
        missing = missing_packages()
        if not missing:
            return {"ok": True, "installed": [], "missing": [], "log": ""}
        print(
            f"{_LOG_PREFIX} 缺少 Python 依赖 {', '.join(missing)}，"
            f"正在用 {sys.executable} 自动安装…"
        )
        ok, output = install_packages(missing, timeout=timeout)
        # Newly installed packages live in an already scanned site-packages
        # directory, so refresh the import caches before re-checking.
        importlib.invalidate_caches()
        still_missing = missing_packages()
        result = {
            "ok": ok and not still_missing,
            "installed": [item for item in missing if item not in still_missing],
            "missing": still_missing,
            "log": output,
        }
        _LAST_RESULT = result
        if result["ok"]:
            print(f"{_LOG_PREFIX} 依赖安装完成：{', '.join(result['installed'])}")
        else:
            print(
                f"{_LOG_PREFIX} 依赖自动安装未完成（{', '.join(still_missing) or 'pip 返回错误'}）。"
                f"请手动执行：{sys.executable} -m pip install {' '.join(still_missing or missing)}"
            )
            if output:
                print(f"{_LOG_PREFIX} pip 输出：\n{output}")
        return result


def dependency_error_message(module_name="", exc=None):
    """User-facing text for a missing import raised during pose recognition."""
    module = (module_name or getattr(exc, "name", "") or "").strip()
    requirements = [_pip_name(module)] if module else missing_packages()
    target = " ".join(item for item in requirements if item) or "<包名>"
    listed = "、".join(requirements) if requirements else "未知依赖"
    return (
        f"缺少姿势识别所需的 Python 依赖：{listed}。\n"
        "插件已尝试自动安装但未成功，常见原因是网络无法访问 PyPI、权限不足或 pip 版本过旧。\n"
        "请用 ComfyUI 自己的 Python 手动安装后重启：\n"
        f"  {sys.executable} -m pip install {target}"
    )


def pose_dependency_state():
    """Diagnostic snapshot, handy for support requests."""
    return {
        "missing": missing_packages(),
        "interpreter": sys.executable,
        "last_install": _LAST_RESULT,
    }
