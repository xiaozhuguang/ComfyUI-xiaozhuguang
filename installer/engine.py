"""Standalone dependency installer. No plugin imports and no global pip changes."""
import argparse
import concurrent.futures
from contextlib import contextmanager
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    'official': 'https://pypi.org/simple',
    'tsinghua': 'https://pypi.tuna.tsinghua.edu.cn/simple',
    'aliyun': 'https://mirrors.aliyun.com/pypi/simple',
}
PROTECTED = {'torch', 'torchvision', 'torchaudio', 'numpy'}
BASE = {'numpy', 'scipy', 'pillow', 'opencv-python', 'psutil', 'transformers',
        'imageio-ffmpeg', 'safetensors', 'librosa', 'cryptography', 'pycryptodome',
        'wmi', 'pywin32', 'aiohttp'}


def log(message):
    print(message, flush=True)


def version(name):
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


@contextmanager
def temporary_workspace():
    # Avoid Python 3.12's restrictive mkdir(0700) ACL on managed Windows accounts.
    base = Path(tempfile.gettempdir()).resolve()
    path = base / ('xzg-install-' + uuid.uuid4().hex)
    path.mkdir(mode=0o777)
    try:
        yield str(path)
    finally:
        if path.parent == base and path.name.startswith('xzg-install-') and not path.is_symlink():
            shutil.rmtree(path)


def validate_source(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('自定义下载源必须是无账号密码的 HTTPS 地址。')
    if parsed.query or parsed.fragment or any(c.isspace() for c in url):
        raise ValueError('下载源地址不能包含空格、查询参数或片段。')
    return url.rstrip('/')


def choose_source(source, custom=''):
    if source == 'custom':
        return validate_source(custom)
    if source != 'auto':
        return SOURCES[source]

    def probe(item):
        name, url = item
        started = time.monotonic()
        try:
            request = urllib.request.Request(url + '/pip/', method='HEAD', headers={'User-Agent': 'XZG-Installer/1'})
            with urllib.request.urlopen(request, timeout=5) as response:
                return (time.monotonic() - started, name, url) if response.status == 200 else None
        except Exception:
            return None
    log('检测可用下载源…')
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = [value for value in pool.map(probe, SOURCES.items()) if value]
    if not results:
        raise RuntimeError('所有下载源均不可达，请选择自定义地址或检查网络。')
    _, name, url = min(results)
    log('自动选择：' + name)
    return url


def requirements(profile):
    # pip's vendored parser correctly handles markers, direct URLs and versions.
    from pip._vendor.packaging.requirements import Requirement
    selected, skipped = [], []
    cuda = None
    for raw in (ROOT / 'requirements.txt').read_text(encoding='utf-8').splitlines():
        line = raw.split(' #', 1)[0].strip()
        if not line or line.startswith('#'):
            continue
        requirement = Requirement(line)
        name = requirement.name.lower().replace('_', '-')
        if profile == 'base' and name not in BASE:
            continue
        if requirement.marker and not requirement.marker.evaluate():
            if name == 'llama-cpp-python':
                skipped.append('Qwen GGUF：仓库轮子仅适配 Windows / Python 3.12 / CUDA 13，当前环境不匹配。')
            continue
        if name in {'llama-cpp-python', 'cupy-cuda12x'}:
            if cuda is None:
                try:
                    import torch
                    cuda = torch.version.cuda or ''
                except Exception:
                    cuda = ''
            if name == 'llama-cpp-python' and not cuda.startswith('13.'):
                if not version(name):
                    skipped.append('Qwen GGUF：当前环境不匹配仓库 CUDA 13 专用轮子，未自动安装。')
                continue
            if name == 'cupy-cuda12x' and not cuda.startswith('12.'):
                if cuda.startswith('13.'):
                    line = 'cupy-cuda13x'  # Availability / Python compatibility checked by pip preflight.
                    requirement = Requirement(line)
                else:
                    skipped.append('插帧 CuPy：未检测到受支持的 CUDA 12/13 PyTorch 环境，未自动安装。')
                    continue
            if name == 'cupy-cuda12x':
                desired = requirement.name
                conflicts = [package for package in ('cupy', 'cupy-cuda11x', 'cupy-cuda12x', 'cupy-cuda13x')
                             if package != desired and version(package)]
                if conflicts:
                    skipped.append('插帧 CuPy：已有其他CuPy发行包 ' + ', '.join(conflicts) + '，避免混装，未自动更换。')
                    continue
        if name in PROTECTED:
            continue
        # Already-installed special wheels are never replaced just to match a URL.
        if requirement.url and version(requirement.name):
            log('保留现有专用轮子：' + requirement.name)
            continue
        selected.append(str(requirement))
    return selected, skipped


def command(args):
    # Isolate pip from inherited pip config/env. Use verified TLS; never trusted-host.
    env = {key: value for key, value in os.environ.items() if not key.startswith('PIP_')}
    env['PIP_CONFIG_FILE'] = os.devnull
    env['PYTHONIOENCODING'] = 'utf-8'
    process = subprocess.Popen([sys.executable, '-m', 'pip', *args], env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, encoding='utf-8', errors='replace',
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    for line in process.stdout:
        log(line.rstrip())
    code = process.wait()
    if code:
        raise RuntimeError(f'pip执行失败（{code}）。可切换下载源后重试；未绕过版本冲突。')


def run(action, source, custom, profile):
    log('Python：' + sys.executable)
    log('版本：' + sys.version.split()[0])
    if not version('pip'):
        raise RuntimeError('此环境缺少 pip，请先使用 ComfyUI 发行版的环境修复功能。')
    if not version('torch') or not version('torchvision'):
        raise RuntimeError('请选择已安装 PyTorch 和 torchvision 的 ComfyUI Python；安装器不自动替换核心 GPU 环境。')
    log('PyTorch：' + version('torch') + '；torchvision：' + version('torchvision'))
    specs, skipped = requirements(profile)
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.utils import canonicalize_name
    missing = []
    for spec in specs:
        req = Requirement(spec)
        installed = version(req.name)
        if installed is None or (req.specifier and not req.specifier.contains(installed, prereleases=True)):
            missing.append(spec)
            log('需要安装/调整：' + spec)
    for notice in skipped:
        log('未适配：' + notice)
    if not missing:
        log('所选范围的兼容依赖已齐全。' + ('仍有上述未适配功能。' if skipped else ''))
        return 2 if skipped else 0
    index = choose_source(source, custom)
    log('下载源：' + index)
    with temporary_workspace() as temp:
        folder = Path(temp)
        reqfile, constraints, report = folder / 'requirements.txt', folder / 'constraints.txt', folder / 'report.json'
        reqfile.write_text('\n'.join(missing), encoding='utf-8')
        pins = {name: version(name) for name in PROTECTED if version(name)}
        constraints.write_text('\n'.join(f'{name}=={value}' for name, value in pins.items()), encoding='utf-8')
        shared = ['--disable-pip-version-check', '--no-input', '--index-url', index,
                  '--timeout', '25', '--retries', '1', '--only-binary=:all:',
                  '--upgrade-strategy', 'only-if-needed', '-r', str(reqfile), '-c', str(constraints)]
        log('安装前预检（只解析和下载元数据，不安装）…')
        command(['install', '--dry-run', '--report', str(report), *shared])
        plan = json.loads(report.read_text(encoding='utf-8'))
        changes = plan.get('install', [])
        for package in changes:
            item = package['metadata']
            name = canonicalize_name(item['name'])
            if name in pins:
                raise RuntimeError('安装计划涉及受保护的核心包 ' + name + '，已停止。')
            log('计划：' + item['name'] + ' ' + item['version'])
        if action == 'check':
            log('预检完成，未安装任何包。' + ('有未适配功能，见上方。' if skipped else ''))
            return 2 if skipped else 0
        log('开始安装；仅在此 Python 环境中生效…')
        # Install the exact versions approved by preflight; keep special wheel URLs.
        exact = []
        for package in changes:
            item = package['metadata']
            if package.get('is_direct'):
                exact.append(item['name'] + ' @ ' + package['download_info']['url'])
            else:
                exact.append(item['name'] + '==' + item['version'])
        reqfile.write_text('\n'.join(exact), encoding='utf-8')
        if exact:
            command(['install', *shared])
        for name, old in pins.items():
            if version(name) != old:
                raise RuntimeError('核心包版本变化，请查看日志：' + name)
        for spec in missing:
            req = Requirement(spec)
            installed = version(req.name)
            if not installed or (req.specifier and not req.specifier.contains(installed, prereleases=True)):
                raise RuntimeError('安装后验证失败：' + req.name)
    log('安装完成。请重启 ComfyUI；模型权重需另行准备。')
    return 2 if skipped else 0


def main():
    parser = argparse.ArgumentParser(description='小珠光独立依赖安装器')
    parser.add_argument('--action', choices=['check', 'install'], default='check')
    parser.add_argument('--source', choices=['auto', *SOURCES, 'custom'], default='auto')
    parser.add_argument('--custom', default='')
    parser.add_argument('--profile', choices=['base', 'full'], default='base')
    args = parser.parse_args()
    try:
        return run(args.action, args.source, args.custom, args.profile)
    except Exception as exc:
        log('未完成：' + str(exc))
        return 1


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
