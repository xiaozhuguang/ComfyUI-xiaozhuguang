"""ComfyUI-Manager install hook for 小珠光 (ComfyUI-xiaozhuguang).

Manager executes this file when the node is installed. It does **not** reliably
re-run ``requirements.txt`` for existing installs, which is how Pose Studio's
``roma`` dependency goes missing after an update (``No module named 'roma'``).

Only the pose-specific allowlist from ``_xzg_pose/vnccs_pose_studio/deps.py`` is
installed here, so a failure elsewhere in the root ``requirements.txt``
(``cupy-cuda12x`` build, the llama-cpp GitHub wheel, a ``transformers``
resolver conflict) cannot prevent these small packages from being installed.

The module is loaded straight from its file so importing the plugin package
(and its heavy torch/ComfyUI imports) is not required.
"""

import importlib.util
import os
import sys

_DEPS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "_xzg_pose",
    "vnccs_pose_studio",
    "deps.py",
)


def _load_deps_module():
    spec = importlib.util.spec_from_file_location("xzg_pose_deps_install", _DEPS_FILE)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载 {_DEPS_FILE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    # Always exit 0: a failed pip run must not abort the node installation.
    # The pose endpoints retry the install on first use and print the exact
    # command the user needs if the network keeps failing.
    if not os.path.isfile(_DEPS_FILE):
        print("[小珠光] 未找到 _xzg_pose/vnccs_pose_studio/deps.py，跳过姿势识别依赖安装")
        return 0

    try:
        deps = _load_deps_module()
    except Exception as exc:
        print(f"[小珠光] 加载依赖清单失败，跳过自动安装：{exc}")
        return 0

    missing = deps.missing_packages()
    if not missing:
        print("[小珠光] 姿势识别依赖已齐全，无需安装")
        return 0

    print(f"[小珠光] 正在安装姿势识别依赖：{', '.join(missing)}")
    ok, output = deps.install_packages(missing)
    if output:
        print(output)

    still_missing = deps.missing_packages()
    if ok and not still_missing:
        print("[小珠光] 姿势识别依赖安装完成")
        return 0

    print(
        "[小珠光] 姿势识别依赖自动安装未完全成功（不影响插件安装），"
        "首次使用“通过图片获取姿势”时会再尝试一次；也可手动执行：\n"
        f"  {sys.executable} -m pip install {' '.join(still_missing or missing)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
