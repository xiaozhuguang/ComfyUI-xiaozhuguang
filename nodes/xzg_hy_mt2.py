"""Local Hy-MT2 inference through llama-cpp-python."""

from pathlib import Path
import re

import folder_paths


LANGUAGES = (
    "Auto", "Chinese", "English", "French", "Portuguese", "Spanish", "Japanese",
    "Turkish", "Russian", "Arabic", "Korean", "Thai", "Italian", "German",
    "Vietnamese", "Malay", "Indonesian", "Filipino", "Hindi", "Traditional Chinese",
    "Polish", "Czech", "Dutch", "Khmer", "Burmese", "Persian", "Gujarati", "Urdu",
    "Telugu", "Marathi", "Hebrew", "Bengali", "Tamil", "Ukrainian", "Tibetan",
    "Kazakh", "Mongolian", "Uyghur",
)
STYLES = (
    "Default", "AI Prompt / Visual Tags", "Daily Conversational", "Formal Business",
    "Literary & Novel", "Anime & ACG", "Cinematic & Visual Arts", "Scholarly & Academic",
    "Popular Science", "Marketing Copy", "News & Media", "Video Subtitles",
    "Legal & Contract", "Ancient / Poetic",
)
PRESETS = {
    f"Hy-MT2-{size}-{quant}.gguf ({disk_size} GB)": (
        f"tencent/Hy-MT2-{size}-GGUF",
        f"{'HY' if size == '7B' and quant != 'Q4_K_M' else 'Hy'}-MT2-{size}-{quant}.gguf",
    )
    for size, quant, disk_size in (
        ("1.8B", "Q4_K_M", "1.1"), ("7B", "Q4_K_M", "4.5"),
        ("1.8B", "Q6_K", "1.5"), ("7B", "Q6_K", "5.9"),
        ("1.8B", "Q8_0", "1.9"), ("7B", "Q8_0", "7.5"),
    )
}


def local_models():
    root = Path(folder_paths.models_dir)
    models = {}
    for directory in (root / "LLM" / "GGUF", root / "LLM", root / "hy-mt2", root / "gguf"):
        for path in sorted(directory.rglob("*.gguf")):
            name = path.name.lower()
            relative = str(path.relative_to(root)).lower()
            is_hy_mt = ("hy" in name and "mt" in name) or "hy-mt" in relative or "hymt" in relative
            if path.is_file() and "mmproj" not in name and is_hy_mt:
                models.setdefault(path.name, path)
    return models


def gguf_inputs():
    official_files = {filename.lower() for _, filename in PRESETS.values()}
    models = list(PRESETS) + [name for name in local_models() if name.lower() not in official_files]
    return {
        "gguf_model": (models, {"default": models[0]}),
        "gguf_style": (list(STYLES), {"default": "Default"}),
        "gguf_target": (list(LANGUAGES), {"default": "Auto"}),
        "gguf_unload": ("BOOLEAN", {"default": False}),
    }


def model_path(model):
    models = local_models()
    if model not in PRESETS:
        return models[model]
    repo, filename = PRESETS[model]
    for name, path in models.items():
        if name.lower() == filename.lower():
            return path
    from huggingface_hub import hf_hub_download

    return hf_hub_download(repo_id=repo, filename=filename,
                           local_dir=str(Path(folder_paths.models_dir) / "LLM" / "GGUF"))


class HyMT2Translator:
    def __init__(self):
        self.llm = None
        self.model = None

    def translate(self, model, translate_style, translate_to, text, unload_after_run):
        if self.model != model:
            try:
                from llama_cpp import Llama
            except (ImportError, OSError) as exc:
                raise RuntimeError("Hy-MT2 GGUF 需要可用的 llama-cpp-python，请在 ComfyUI 使用的 Python 环境中安装兼容版本。") from exc
            self.close()
            self.llm = Llama(model_path=str(model_path(model)), n_gpu_layers=-1, n_ctx=8192, verbose=False)
            self.model = model

        target = translate_to
        if target == "Auto":
            target = "English" if re.search(r"[\u3400-\u9fff]", text) else "Chinese"
        instruction = f"Translate the following text into {target}. Return only the translation."
        if translate_style != "Default":
            instruction += f" Use this translation style: {translate_style}."
        try:
            chunks = [text[index:index + 2000] for index in range(0, len(text), 2000)]
            results = []
            for chunk in chunks:
                response = self.llm.create_chat_completion(
                    messages=[{"role": "user", "content": f"{instruction}\n\n{chunk}"}],
                    max_tokens=4096, temperature=0.7, top_p=0.6, top_k=20,
                )
                results.append((response["choices"][0]["message"]["content"] or "").strip())
            return ("\n\n".join(results),)
        finally:
            if unload_after_run:
                self.close()

    def close(self):
        if self.llm is not None:
            self.llm.close()
            self.llm = None
            self.model = None
