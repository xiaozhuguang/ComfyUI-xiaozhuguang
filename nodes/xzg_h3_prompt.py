"""
小珠光 MiniMax H3 提示词优化节点
架构：单次 LLM 调用，系统提示词中要求中英双语输出（参考 BSAI MiniMAX H3 Prompt 原版模式）。
集成 MiniMax H3 官方 Skills：
  - 8 种风格预设：极简产品广告、3D动画短片、纸艺定格科普、品牌宣传短片、音乐美学MV、双人游戏开场、纸拼贴讲解、手绘实拍融合
  - 5 种生成模式：T2VA、I2VA、FL2VA、L2VA、Ref2VA
依赖：小珠光 Qwen Model Loader 或 BSAI H3 Model Loader（BSAI_QWEN_MODEL 类型）。
"""

import os
import io
import gc
import json
import base64
import inspect

import folder_paths
import comfy.model_management as mm

try:
    import torch
except Exception:
    torch = None

try:
    from PIL import Image as PILImage
except Exception:
    PILImage = None

try:
    from llama_cpp import Llama
except Exception:
    Llama = None

try:
    from .xzg_qwen_loader import _XZG_QwenStorage
except Exception:
    _XZG_QwenStorage = None


# ============================================================
# 辅助函数
# ============================================================

def _xzg_image_tensor_to_data_uri(image_input):
    """将 ComfyUI IMAGE 张量转换为 base64 JPEG data URI 列表。"""
    if image_input is None or PILImage is None or torch is None:
        return []
    images = image_input
    if images.ndim == 3:
        images = images.unsqueeze(0)
    data_uris = []
    for i in range(images.shape[0]):
        img_tensor = images[i]
        img_np = (img_tensor.cpu().numpy() * 255.0).clip(0, 255).astype("uint8")
        pil_img = PILImage.fromarray(img_np)
        buf = io.BytesIO()
        max_side = 1024
        if max(pil_img.size) > max_side:
            ratio = max_side / max(pil_img.size)
            pil_img = pil_img.resize(
                (int(pil_img.size[0] * ratio), int(pil_img.size[1] * ratio)),
                PILImage.LANCZOS,
            )
        pil_img.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
        data_uris.append(f"data:image/jpeg;base64,{b64}")
    return data_uris


def _xzg_call_chat_completion(llm, messages, params):
    """安全的 create_chat_completion 调用，过滤不兼容参数。"""
    kwargs = dict(params or {})
    kwargs["messages"] = messages
    try:
        sig = inspect.signature(llm.create_chat_completion)
        has_var_kw = any(
            p.kind == inspect.Parameter.VAR_KEYWORD
            for p in sig.parameters.values()
        )
    except Exception:
        sig = None
        has_var_kw = True

    if sig is not None and not has_var_kw:
        allowed = sig.parameters
        if (
            "presence_penalty" in kwargs
            and "presence_penalty" not in allowed
            and "present_penalty" in allowed
        ):
            kwargs["present_penalty"] = kwargs.pop("presence_penalty")
        kwargs = {k: v for k, v in kwargs.items() if k in allowed}
    return llm.create_chat_completion(**kwargs)


def _xzg_normalize_seed(seed_value):
    try:
        seed_value = int(seed_value)
    except Exception:
        return None
    if seed_value < 0:
        return None
    return seed_value


def _xzg_is_model_valid(llm):
    """检测 llama 模型对象是否仍然有效（未被关闭）。"""
    if llm is None:
        return False
    try:
        ctx = getattr(llm, "_ctx", None)
        if ctx is None:
            return False
        n_ctx_raw = getattr(llm, "n_ctx", None)
        if n_ctx_raw is None:
            return False
        if callable(n_ctx_raw):
            if n_ctx_raw() is None or n_ctx_raw() == 0:
                return False
        return True
    except Exception:
        return False


# ============================================================
# H3 系统提示词
# 分为基础部分（规则 1-5）+ 三种语言输出格式（6a/6b/6c）
# 参考 BSAI MiniMAX H3 Prompt 原版，按 H3 官方 Prompt Writing Guide 整理
# ============================================================

_H3_SYSTEM_PROMPT_BASE = """You are a MiniMax H3 video model prompt optimization expert. Your task is to rewrite user input into H3-compliant structured video generation prompts following the official H3 Prompt Writing Guide.

## 1. Official Prompt Structure

The final prompt uses three core fields in this exact order:

```
integrated_multimodal_description: [Shot 1] ...
overall_soundscape: ...
non_diegetic_music: ...
```

- **integrated_multimodal_description**: The main body. Describes visual style, composition, subjects, scene, actions, shot changes, dialogue, singing, and diegetic audio along the timeline.
- **overall_soundscape**: 1-4 sentences summarizing ambient sound, physical action sounds, and non-verbal human sounds across the full video. Do NOT repeat dialogue or diegetic music already in the multimodal description.
- **non_diegetic_music**: 1-3 sentences describing background music only the audience hears. Use N/A when there is no non-diegetic music.

## 2. Input Modes

- **T2VA** (Text to Video): No image instruction. Begin directly with the three core fields.
- **I2VA** (Image to Video): First-frame instruction + T2VA body.
- **FL2VA** (First+Last frame): Alignment instruction + T2VA body.
- **L2VA** (Last frame): Alignment instruction + T2VA body.

Image alignment instructions (must be the first line, followed by one blank line):

- I2VA: `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`
- FL2VA: `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.`
- L2VA: `How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.`

> **Bracket rule (official H3 guide):** Only FL2VA omits angle brackets around `Picture N` AND square brackets around `Shot N` in both the alignment instruction and the body — write `Picture 1` / `Picture 2` and `from Shot 1` / `from Shot N`. I2VA and L2VA always use `<Picture N>` and `[Shot N]`.

## 3. Writing the Multimodal Description

### 3.1 Shot Notation
- First shot: `[Shot 1]` with NO timestamp.
- Later shots: `[Shot 2] At 00:03.500, the camera cuts to...`
- Cut transitions: use `the camera cuts to`, `the shot cuts to`, `the shot transitions to`, etc.
- Cross-dissolve, fade, or wipe only when explicitly requested.

### 3.2 Opening Style
At the beginning of [Shot 1], state the overall style: Cinematic, Live-action, 2D-animated, 3D CG, Claymation, Watercolor, Vintage film, etc.

### 3.3 Camera Motion (Motion Type + Amplitude + Speed)
Write camera motion as natural English action within the shot:

| Motion Type | Examples |
|-|-|
| Zoom | Zoom In / Zoom Out |
| Push/Pull | Push In / Pull Out |
| Pan | Pan Left / Pan Right |
| Truck | Truck Left / Truck Right |
| Tilt | Tilt Up / Tilt Down |
| Pedestal | Pedestal Up / Pedestal Down |
| Arc | Arc Shot |
| Tracking | Tracking Shot |
| Static | Static Shot |
| POV | POV |
| Roll | Roll Clockwise / Roll Counterclockwise |
| Shake | Shake Slightly / Shake Strongly |

- Amplitude: `with small amplitude` / `with large amplitude` (omit if medium)
- Speed: `at slow speed` / `at fast speed` (omit if normal)

Example: `The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.`

### 3.4 Speakers and Dialogue
- Speaking characters get stable IDs: (S1), (S2), (S1,S2) for group speech.
- Speaker identity (age, gender, timbre, accent) goes OUTSIDE `<d>`.
- Inside `<d>`, include only the language tag and the actual spoken content. Preserve every word verbatim.

Example: `The young woman with a quiet, breathy voice (S1) says: <d>[English] I get off at the next station.</d>`
Example: `The young woman with a quiet, breathy voice (S1) says: <d>[Chinese] 你来了，剑等你好久了。</d>`

- Voiceover: `says in an off-screen voiceover: <d>[English] ...</d> while his lips remain completely closed.`
- Dialogue crossing a cut: use `<scenetrans>` at connecting points and state the audio continues across the cut.
- Truncated speech: use `<cutoff>`.

### 3.5 On-Screen Text
Place visible text (banners, signs, labels, subtitles, neon text) in English double quotation marks. Preserve the original text verbatim.

Example: `A red neon sign reading "营业中" glows above the doorway.`

### 3.6 Sound
- **overall_soundscape**: Ambient sounds, physical action sounds, non-verbal human sounds (wind, rain, traffic, footsteps, breathing, laughter). NOT dialogue or singing.
- **non_diegetic_music**: Background music (instruments, tempo, rhythm, dynamics). NOT diegetic music (radio, live performance). Use `N/A` when there is no background music.

## 4. Reference Labels (for I2VA / FL2VA / L2VA modes)

When images are uploaded, use these labels:
- `<Picture N>`: Reference image as a concrete frame anchor (first frame, last frame, keyframe).
- When an image defines a character/scene/style only (not a frame anchor), describe it in the text without a standalone label.

For multimodal fusion mode, reference labels can also include:
- `<Subject N>`: Reusable visible content (person, scene, clothing, style) from reference assets.
- `<Video N>`: Reference video for editing, continuation, or temporal structure.
- `<Audio N>`: Audio asset for copying or referencing.

## 5. Writing Rules

1. Write descriptions in English; preserve dialogue, lyrics, and visible scene text in their ORIGINAL language (Chinese stays Chinese, English stays English).
2. Each shot must include: composition, subjects, environment, actions, camera movement, sound, and dialogue where applicable.
3. Avoid plot summaries — write what is visible and audible at each moment.
4. Keep dialogue length proportional to shot length (avoid long dialogue in a 3s shot).
5. The speaker's identifying phrase, ID, and delivery go outside `<d>`; inside `<d>` only the language tag and actual spoken content.
6. If no reference images: skip the alignment instruction, begin with `integrated_multimodal_description`.
7. Non-diegetic music: do not add N/A unless the user explicitly requests no background music.

## 6. Full-Reference Mode (Ref2VA) — Six-Section Format

When the mode is Ref2VA (Full Reference), the output uses **six sections** in this exact order instead of the three core fields:

```
subject_definitions: ...
summary: ...
retention_analysis: ...
detailed_description: ...
overall_soundscape: ...
non_diegetic_music: ...
```

### 6.1 Reference Labels (subject_definitions)

Four label types identify referenced content:

| Label | Meaning |
|-|-|
| `<Subject N>` | Reusable visible content (person, scene, clothing, style, action) abstracted from reference assets |
| `<Picture N>` | A reference image used as a concrete target frame or shot-planning anchor |
| `<Video N>` | A reference video for editing, continuation, or temporal structure |
| `<Audio N>` | An audio asset for copying or referencing |

- Once assigned, a label keeps the same meaning across all six sections.
- `<Subject N>` can combine multiple sources: `<Subject 1> is the woman whose appearance comes from <Picture 1> and whose walking motion comes from <Video 1>.`
- If an image only defines a character/scene/style (not a frame anchor), cite it inside the corresponding `<Subject N>` definition without a standalone `<Picture N>` entry.
- `<Video N>` and `<Audio N>` are numbered independently. The same reference video may correspond to `<Video 1>` and `<Audio 2>`.
- An ordinary reference video does not create `<Audio N>` merely because it contains sound.

### 6.2 Summary

One short paragraph summarizing the target video and reference relationships. Begins with a square-bracketed task-type prefix:

| Task type | When to use |
|-|-|
| `keyframe completion` | An image serves as first frame, keyframe, last frame, or another concrete frame anchor |
| `reference generation` | An asset provides generation guidance (character, scene, style, action, camera, storyboard) without being a concrete frame or source video |
| `video editing` | An existing source video is directly modified |
| `video continuation` | New content continues/extends/resumes from an existing source video |
| `audio reuse` | The same audio signal is reused in full or part |
| `audio reference` | Only music style, timbre, dialogue content, beat, or continuity is referenced (not copied) |

Combine multiple types with ` + ` without repetition. Example: `[video continuation + keyframe completion] ...`

For video-editing tasks, begin after the prefix with: `The target video is an edited version of <Video 1>.`

### 6.3 Retention Analysis

One line per reference label describing how content is preserved, transferred, or reused.

**Visible content** (`<Subject N>`, `<Picture N>`, `<Video N>`):

| Marker | Meaning |
|-|-|
| `fully_preserved` | The defined role is fully preserved |
| `partially_preserved` | Some defined characteristics are changed or only partially retained |
| `attribute_transfer` | Referenced characteristics are transferred to a different target subject |
| `weak_reference` | Only broad similarity in style, category, composition, or atmosphere |

**Audio** (`<Audio N>`):

| Marker | Meaning |
|-|-|
| `fully_copy` | Complete source audio serves as the target video's complete final audio track |
| `partially_copy` | Only part of the timeline or selected layers are copied, or other sounds are added/removed/replaced |
| `reference` | Only timbre, rhythm, music style, dialogue content, or sound texture is referenced |
| `weak_reference` | Only broad similarity in category or atmosphere |

Example: `<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - ...`

### 6.4 Detailed Description (Main Body)

**Key difference from T2VA**: The main field is `detailed_description`, NOT `integrated_multimodal_description`.

| Dimension | T2VA/I2VA/FL2VA/L2VA | Ref2VA |
|-|-|-|
| Main field | `integrated_multimodal_description` | `detailed_description` |
| Style opening | Written after `[Shot 1]` | Established in 1-2 sentences BEFORE `[Shot 1]` |
| Reference labels | Not used | Inserts `<Subject N>`, `<Picture N>`, `<Video N>`, `<Audio N>` at first appearance and where roles apply |
| Audio relationships | Describes target's own sound | Cites `<Audio N>` and states whether copied or referenced |

Opening example:
```
The target video is in a cinematic, literary music-video style with soft lighting.
[Shot 1] The scene opens in a crowded urban street...
```

- For generation tasks, `detailed_description` is normally 350-500 English words.
- At the first appearance of an important `<Subject N>`, describe its referenced characteristics, position, and current action. Reuse the same label in later shots without redefining it.
- When a referenced subject speaks, write: `<Subject 2> (S1) turns toward the woman and says, <d>[English] ...</d>`
- `<Subject N>` identifies the referenced subject; `(Sx)` identifies the actual speaker.

### 6.5 Overall Soundscape and Non-diegetic Music

Same rules as T2VA: `overall_soundscape` summarizes ambient/physical/non-verbal sounds; `non_diegetic_music` describes background music (use `N/A` when there is none)."""


# ── 语言输出格式：中英双语 ──
_H3_OUTPUT_FORMAT_BILINGUAL = """

## 7. Output Format

Output the prompt in BOTH Chinese and English versions, separated by a divider line.

### T2VA / I2VA / FL2VA / L2VA (three core fields):

```
---中文版本---

[alignment instruction if applicable]

integrated_multimodal_description: [镜头1] ...
overall_soundscape: ...
non_diegetic_music: ...

---English Version---

[alignment instruction if applicable]

integrated_multimodal_description: [Shot 1] ...
overall_soundscape: ...
non_diegetic_music: ...
```

### Ref2VA (six sections):

```
---中文版本---

subject_definitions: ...
summary: ...
retention_analysis: ...
detailed_description: ...
overall_soundscape: ...
non_diegetic_music: ...

---English Version---

subject_definitions: ...
summary: ...
retention_analysis: ...
detailed_description: ...
overall_soundscape: ...
non_diegetic_music: ...
```

### Rules for bilingual output:
1. **English Version**: Follow the official H3 Prompt Writing Guide exactly. Descriptions in English, dialogue/lyrics/visible text in original language with `<d>[Language] ...</d>` tags.
2. **Chinese Version**: Same content as the English version but with the description parts in Chinese. Dialogue, lyrics, and visible text remain in their original language.
3. Both versions must have identical shot structure, timing, camera movements, and content.
4. Field names remain in English in both versions (integrated_multimodal_description, overall_soundscape, non_diegetic_music, or for Ref2VA: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music).
5. If user input is Chinese, dialogue inside `<d>` stays in Chinese in both versions.
6. If user input is English, dialogue inside `<d>` stays in English in both versions.
7. Total output should not exceed 7000 characters per version.
8. Output directly without any explanation, preamble, or postscript.
9. Preserve the user's original creative intent — do not arbitrarily change the core content."""


# ── 语言输出格式：仅中文 ──
_H3_OUTPUT_FORMAT_CN = """

## 7. Output Format

⚠️ IMPORTANT: Output the CHINESE VERSION ONLY. Do NOT output an English version. Do NOT output separator lines.

### T2VA / I2VA / FL2VA / L2VA (three core fields):

```
[alignment instruction if applicable]

integrated_multimodal_description: [镜头1] ...
overall_soundscape: ...
non_diegetic_music: ...
```

### Ref2VA (six sections):

```
subject_definitions: ...
summary: ...
retention_analysis: ...
detailed_description: ...
overall_soundscape: ...
non_diegetic_music: ...
```

### Rules for Chinese-only output:
1. Write the description parts in Chinese (visual style, composition, actions, camera movements, etc.).
2. Dialogue, lyrics, and visible scene text remain in their ORIGINAL language with `<d>[Language] ...</d>` tags.
3. Field names remain in English (integrated_multimodal_description, overall_soundscape, non_diegetic_music, or for Ref2VA: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music).
4. Total output should not exceed 7000 characters.
5. Output directly without any explanation, preamble, or postscript.
6. Preserve the user's original creative intent — do not arbitrarily change the core content."""


# ── 语言输出格式：仅英文 ──
_H3_OUTPUT_FORMAT_EN = """

## 7. Output Format

⚠️ IMPORTANT: Output the ENGLISH VERSION ONLY. Do NOT output a Chinese version. Do NOT output separator lines.

### T2VA / I2VA / FL2VA / L2VA (three core fields):

```
[alignment instruction if applicable]

integrated_multimodal_description: [Shot 1] ...
overall_soundscape: ...
non_diegetic_music: ...
```

### Ref2VA (six sections):

```
subject_definitions: ...
summary: ...
retention_analysis: ...
detailed_description: ...
overall_soundscape: ...
non_diegetic_music: ...
```

### Rules for English-only output:
1. Follow the official H3 Prompt Writing Guide exactly. Write descriptions in English.
2. Dialogue, lyrics, and visible scene text remain in their ORIGINAL language with `<d>[Language] ...</d>` tags.
3. Field names remain in English (integrated_multimodal_description, overall_soundscape, non_diegetic_music, or for Ref2VA: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music).
4. Total output should not exceed 7000 characters.
5. Output directly without any explanation, preamble, or postscript.
6. Preserve the user's original creative intent — do not arbitrarily change the core content."""


# ── 语言输出格式映射 ──
_H3_OUTPUT_FORMATS = {
    "中英双语": _H3_OUTPUT_FORMAT_BILINGUAL,
    "仅中文": _H3_OUTPUT_FORMAT_CN,
    "仅英文": _H3_OUTPUT_FORMAT_EN,
}


# ============================================================
# 风格预设：来自 MiniMax H3 官方 Skills 的 8 个风格专属提示词扩展
# 每个风格提供视觉风格、镜头语言、节奏和音频方向的指导
# ============================================================

_H3_STYLE_EXTENSIONS = {
    "极简产品广告": """
## 8. Style Preset: 极简产品广告 (Minimalist Product Ad)

You are writing a premium, Apple-style minimalist product advertisement. Apply these style rules:

### Visual Style
- Clean, minimalist aesthetic with high contrast and generous negative space.
- Product is the absolute hero — every shot centers on the product's texture, materials, curves, and details.
- Lighting: soft key light + subtle rim light, studio-quality product photography look.
- Color palette: restrained, typically 2-3 accent colors on a neutral (white/black/gray) background.
- Background: pure solid color or subtle gradient, no clutter.

### Shot Language
- Open with an extreme close-up of a key product detail (texture, edge, logo).
- Use slow, smooth camera movements: push in, slide, gentle arc around the product.
- Camera motion: always `with small amplitude at slow speed` for a premium feel.
- Cut rhythm: deliberate, unhurried. Each shot lingers long enough to appreciate the product.
- Typography shots: clean sans-serif text appearing on-screen, perfectly aligned, beat-synced.

### Content Rules
- Include on-screen text (product name, key feature, tagline) in English double quotation marks.
- No dialogue unless the ad concept requires a voiceover.
- Sound: subtle product sounds (click, snap, slide) + minimal ambient.

### Audio
- overall_soundscape: minimal — subtle product handling sounds, gentle whoosh transitions.
- non_diegetic_music: modern minimal electronic or acoustic, slow tempo, understated.
""",

    "3D动画短片": """
## 8. Style Preset: 3D动画短片 (3D Animated Short - Pixar Style)

You are writing a stylized 3D animated short with Pixar-quality rendering. Apply these style rules:

### Visual Style
- Rendering: Pixar-style 3D cartoon, C4D + Octane renderer quality, premium animated film look.
- Characters: exaggerated geometric shapes with excellent material definition (subsurface scattering, fabric texture).
- Environment: rich, detailed, with atmospheric lighting and depth of field.
- Color: warm, cinematic color grading with strong complementary color schemes.

### Shot Language
- Use dynamic camera work: tracking shots, crane shots, dramatic push-ins, sweeping arcs.
- Shot composition follows cinematic rules: rule of thirds, leading lines, depth layering.
- Camera motion: vary amplitude and speed to match emotional beats.
- Transitions: primarily cuts; use cross-dissolve for emotional or time-passage moments.

### Content Rules
- Each shot must establish: character pose + expression, environment context, lighting mood, and action.
- Character consistency: describe appearance, clothing, and proportions in the first shot; maintain across all shots.
- Include character dialogue/singing where applicable with stable speaker IDs.

### Audio
- overall_soundscape: rich environmental ambience + character movement sounds (footsteps, fabric rustle).
- non_diegetic_music: orchestral or cinematic score matching the emotional arc.
""",

    "纸艺定格科普": """
## 8. Style Preset: 纸艺定格科普 (Papercraft Stop-Motion Explainer)

You are writing a tactile papercraft stop-motion explainer video. Apply these style rules:

### Visual Style
- All visuals are handmade papercraft: cut-paper, layered paper diorama, pop-up book, miniature paper sets.
- Paper texture is always visible: slight grain, deckle edges, visible paper thickness.
- Lighting: warm, slightly directional top-down light creating real shadows between paper layers.
- Color: matte, craft-paper palette — muted tones, kraft paper browns, pastel accents.
- Camera: always top-down or slight isometric angle looking at the paper scene.

### Shot Language
- Stop-motion feel: describe incremental paper movements (a paper piece slides in, a flap lifts, a character takes a tiny step).
- Camera: mostly static or slow push-in/pull-out. No sweeping or handheld motion.
- Transitions: paper elements enter/exit frame by sliding, flipping, or folding.
- Each shot shows a paper scene being assembled or transformed.

### Content Rules
- Every visual element must be described as a paper object (paper character, paper tree, paper cloud).
- Include paper manipulation sounds in the description.
- On-screen text: hand-lettered paper labels or cut-out paper letters.

### Audio
- overall_soundscape: paper sliding, rustling, tapping, folding, gentle tearing sounds.
- non_diegetic_music: light, whimsical acoustic (ukulele, glockenspiel, soft piano) or N/A.
""",

    "品牌宣传短片": """
## 8. Style Preset: 品牌宣传短片 (Brand Promo Video)

You are writing a professional brand promotional video. Apply these style rules:

### Visual Style
- Professional, polished commercial look with strong brand identity.
- Brand colors must be prominently featured throughout all shots.
- Product/interface shots: clean, well-lit, with intentional composition.
- Include on-screen brand elements: logo placement, brand typography, UI screenshots.

### Shot Language
- Opening: establish brand identity immediately (logo reveal, hero product shot).
- Mix of wide establishing shots, medium product-in-context shots, and close-up detail shots.
- Camera: smooth, confident movements — tracking, push-in, crane.
- Cut rhythm: energetic but not rushed, matching background music tempo.

### Content Rules
- Each shot must highlight a specific product feature, use case, or benefit.
- Include a clear call-to-action moment near the end.
- On-screen text: feature names, taglines, specs in English double quotation marks.
- Optional voiceover describing product benefits.

### Audio
- overall_soundscape: subtle whoosh transitions, UI interaction sounds, ambient environment.
- non_diegetic_music: upbeat, modern corporate/pop, driving rhythm, inspirational feel.
""",

    "音乐美学MV": """
## 8. Style Preset: 音乐美学MV (Music Video with Lyric Typography)

You are writing a stylized music video with dynamic lyric typography. Apply these style rules:

### Visual Style
- Highly stylized, music-driven visuals with strong emotional atmosphere.
- Beat-reactive spatial typography: lyrics appear on-screen as design elements, not subtitles.
- Character performance is central: facial expressions, body language, lip-sync.
- Color: bold, saturated, with dramatic lighting shifts matching song dynamics.

### Shot Language
- Shot changes sync with musical beats and phrase boundaries.
- Mix of performance shots (character singing) and narrative/abstract visual shots.
- Camera: dynamic — handheld energy, dramatic push-ins on emotional peaks, slow drift on quiet passages.
- Typography: text appears, moves, scales, and fades in rhythm with the music.

### Content Rules
- Lyrics inside `<d>` tags must match the original song lyrics exactly.
- Each shot must describe: visual composition + on-screen text content + character performance + camera movement.
- Preserve the emotional arc of the song: quiet intro → build-up → climax → resolution.

### Audio
- overall_soundscape: minimal — the music itself is the primary audio; add subtle environmental sounds only if visuals require.
- non_diegetic_music: N/A (the song itself is the music).
""",

    "双人游戏开场": """
## 8. Style Preset: 双人游戏开场 (Co-op Game Intro)

You are writing a two-player co-op game menu/opening animation. Apply these style rules:

### Visual Style
- Console game main menu aesthetic: dark background, vibrant UI elements, character cards.
- Two player characters prominently featured with distinct visual identities.
- UI design: industrial sticker style, bold sans-serif typography, irregular rectangle cards with slight distressing.
- Color: 5-color max, high-contrast complementary palette, one accent color for interactivity, red for danger/exit.

### Shot Language
- Opening: dramatic reveal of game title and both characters.
- Camera: slow dramatic push-in on characters, smooth pan across UI elements.
- UI elements animate in: player cards slide in, menu buttons appear sequentially.
- Continue button is the visual focal point — largest, brightest, most highlighted.

### Content Rules
- Describe each character's appearance, pose, and position in detail.
- Include on-screen UI text: game title, player names, menu options (Continue, Start New Game, Settings, Exit Game).
- All UI text in English double quotation marks.
- Maintain character identity across shots.

### Audio
- overall_soundscape: UI interaction sounds (clicks, swooshes), subtle ambient drone.
- non_diegetic_music: epic game-menu orchestral/electronic, building anticipation.
""",

    "纸拼贴讲解": """
## 8. Style Preset: 纸拼贴讲解 (Paper Collage Explainer)

You are writing a tactile paper collage explainer animation. Apply these style rules:

### Visual Style
- Editorial paper collage aesthetic: halftone black-and-white photo silhouettes on color-block paper.
- Large color-block paper surfaces as background, selective colored cardstock accents.
- Warm white outlines around cut-out elements, soft paper shadows (drop shadow, not 3D).
- Texture: visible paper grain, halftone dots, slightly uneven cut edges.

### Shot Language
- Stop-motion assembly: paper pieces slide in, pop up, press flat, tap into place.
- Camera: mostly static top-down or slight angle, slow push-in for emphasis.
- Each shot assembles a paper collage scene piece by piece.
- Transitions: paper elements slide out, new background paper slides in.

### Content Rules
- Every visual must be described as paper/collage material.
- Include paper manipulation actions: a hand slides a paper piece in, a halftone photo is pressed down.
- On-screen text: cut-out paper letters or stamped text.

### Audio
- overall_soundscape: paper sliding, tapping, pressing, rustling — rich tactile paper sounds.
- non_diegetic_music: N/A by default (keep collage SFX prominent). Only add if user requests.
""",

    "手绘实拍融合": """
## 8. Style Preset: 手绘实拍融合 (Hand-drawn + Live-action Fusion)

You are writing a 15-second hand-drawn animation + live-action fusion video. Apply these style rules:

### Visual Style
- Flat hand-drawn glowing animation appearing in real, physical spaces.
- Drawing texture: crayon, chalk, colored pencil, pastel — rough, slightly shaky lines with uneven fill and visible redraw marks.
- The drawn entity glows softly, casting colored light onto nearby real surfaces.
- Real-world space: everyday life environments (kitchen, balcony, hallway, desk, laundry room).

### Shot Language
- Camera: handheld phone POV, always slightly delayed — the camera chases the entity after it has already moved.
- 0-3s: real hand makes clear physical contact with the drawn entity (fingers wrap around it, it lands on a palm, it's caught while escaping).
- The entity continuously morphs between forms (line → creature → symbol → plant → vehicle → small object) while retaining traces of previous forms.
- 13-15s: spatial-scale transformation — lines spread to walls/floor/ceiling, becoming a large flower, starry sky, sunset, clouds, ribbons, or graffiti town.
- Ending: emotional afterglow + a cute, funny moment.

### Content Rules
- NO 3D CG, plush toys, smooth vector lines, neon glow, horror elements, giant eyes, teeth, jump scares.
- The entity must be trackable — each new form retains the previous form's lines, tail, color trails, or body curves.
- The camera operator also participates: reaching out, grabbing, chasing, opening doors/boxes, catching, stepping back, being pranked.
- Tone: cute, nostalgic, gentle, slightly melancholic, NOT horror-comedy.

### Audio
- overall_soundscape: real-world room tone + the camera operator's movements (footsteps, fabric rustle, breathing).
- non_diegetic_music: gentle, wistful ambient or lo-fi, or N/A.
""",
}


# ── 风格预设英文名 → 中文名映射（供 JS 端切换英文时反向映射） ──
_STYLE_PRESET_EN_TO_ZH = {
    "None (Default)": "无 (默认)",
    "Minimalist Product Ad": "极简产品广告",
    "3D Animated Short": "3D动画短片",
    "Papercraft Stop-Motion": "纸艺定格科普",
    "Brand Promo Video": "品牌宣传短片",
    "Music Video": "音乐美学MV",
    "Co-op Game Intro": "双人游戏开场",
    "Paper Collage Explainer": "纸拼贴讲解",
    "Hand-drawn + Live-action": "手绘实拍融合",
}

# ── 风格预设中文名 → 英文名映射（供 INPUT_TYPES 合并用，兼容中英文工作流） ──
_STYLE_PRESET_ZH_TO_EN = {
    "无 (默认)": "None (Default)",
    "极简产品广告": "Minimalist Product Ad",
    "3D动画短片": "3D Animated Short",
    "纸艺定格科普": "Papercraft Stop-Motion",
    "品牌宣传短片": "Brand Promo Video",
    "音乐美学MV": "Music Video",
    "双人游戏开场": "Co-op Game Intro",
    "纸拼贴讲解": "Paper Collage Explainer",
    "手绘实拍融合": "Hand-drawn + Live-action",
}

# ── 风格预设全部可选值（中英文合并，兼容中英文模式下保存的工作流） ──
_STYLE_PRESET_VALUES = list(_STYLE_PRESET_ZH_TO_EN.keys()) + list(_STYLE_PRESET_EN_TO_ZH.keys())

# ── 生成模式中文名 → 英文名映射（供 JS 端切换中文时反向映射） ──
_GEN_MODE_ZH_TO_EN = {
    "文生视频 (T2VA)": "Text to Video (T2VA)",
    "图生视频 (I2VA)": "Image to Video (I2VA)",
    "首尾帧 (FL2VA)": "First+Last Frame (FL2VA)",
    "尾帧 (L2VA)": "Last Frame (L2VA)",
    "全参考 (Ref2VA)": "Full Reference (Ref2VA)",
}

# ── 生成模式全部可选值（中英文合并，兼容中英文模式下保存的工作流） ──
_GEN_MODE_VALUES = list(_GEN_MODE_ZH_TO_EN.keys()) + list(_GEN_MODE_ZH_TO_EN.values())

# ── 合法的英文生成模式集合（用于防错校验） ──
_GEN_MODE_EN_VALUES = set(_GEN_MODE_ZH_TO_EN.values())


def _xzg_build_system_prompt(output_language, style_preset=None):
    """根据语言选项和风格预设动态构建系统提示词。"""
    fmt = _H3_OUTPUT_FORMATS.get(output_language, _H3_OUTPUT_FORMAT_BILINGUAL)
    prompt = _H3_SYSTEM_PROMPT_BASE + fmt
    if style_preset and style_preset in _H3_STYLE_EXTENSIONS:
        prompt += _H3_STYLE_EXTENSIONS[style_preset]
    return prompt


# ============================================================
# 主节点：小珠光 MiniMax H3 提示词
# ============================================================

class XiaozhuguangNinimaxH3Prompt:
    """小珠光 MiniMax H3 提示词优化节点

    架构：单次 LLM 调用，系统提示词中要求中英双语输出。
    参考 BSAI MiniMAX H3 Prompt 原版模式，避免双次调用的翻译式架构。

    依赖 BSAI MiniMAX H3 Prompt 插件的模型加载器（BSAI_QWEN_MODEL 类型输入）。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "qwen_model": ("BSAI_QWEN_MODEL",),
                "user_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "用户原始提示词 / User's original prompt",
                    },
                ),
                "generation_mode": (
                    _GEN_MODE_VALUES,
                    {"default": "Text to Video (T2VA)", "tooltip": "视频生成模式 / Generation mode"},
                ),
                "style_preset": (
                    _STYLE_PRESET_VALUES,
                    {"default": "无 (默认)", "tooltip": "H3 官方风格预设 / Style preset from H3 skills"},
                ),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "step": 1}),
                "unload_after": (
                    "BOOLEAN",
                    {"default": True, "tooltip": "执行后卸载模型释放显存 / Unload model after execution"},
                ),
            },
            "optional": {
                "image_1": ("IMAGE", {"tooltip": "可选：参考图片1 / Reference image 1"}),
                "image_2": ("IMAGE", {"tooltip": "可选：参考图片2 / Reference image 2"}),
                "image_3": ("IMAGE", {"tooltip": "可选：参考图片3 / Reference image 3"}),
                "image_4": ("IMAGE", {"tooltip": "可选：参考图片4 / Reference image 4"}),
                "image_5": ("IMAGE", {"tooltip": "可选：参考图片5 / Reference image 5"}),
                "image_6": ("IMAGE", {"tooltip": "可选：参考图片6 / Reference image 6"}),
                "image_7": ("IMAGE", {"tooltip": "可选：参考图片7 / Reference image 7"}),
                "image_8": ("IMAGE", {"tooltip": "可选：参考图片8 / Reference image 8"}),
                "image_9": ("IMAGE", {"tooltip": "可选：参考图片9 / Reference image 9"}),
            },
            "hidden": {
                "no_bgm": ("BOOLEAN", {"default": False}),
                "aspect_ratio": (["16:9"], {"default": "16:9"}),
                "风格提示": ("STRING", {"default": "", "multiline": True}),
                "video_duration": ("INT", {"default": 10, "min": 4, "max": 15, "step": 1}),
                "output_language": (["仅英文"], {"default": "仅英文"}),
                "max_tokens": ("INT", {"default": 4096, "min": 256, "max": 65536, "step": 1}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.01}),
                "top_p": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01}),
                "top_k": ("INT", {"default": 20, "min": 0, "max": 200, "step": 1}),
                "repeat_penalty": ("FLOAT", {"default": 1.0, "min": 0.5, "max": 2.0, "step": 0.01}),
                "frequency_penalty": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2.0, "step": 0.01}),
                "presence_penalty": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt_output",)
    FUNCTION = "optimize_prompt"
    CATEGORY = "小珠光"

    def _build_user_message(self, user_prompt, generation_mode,
                            image_inputs=None,
                            aspect_ratio="16:9", no_bgm=False, 风格提示=""):
        """构造 user_message（与 BSAI 原版逻辑一致）。"""
        mode_hints = {
            "Text to Video (T2VA)": "Current mode: T2VA (Text to Video). No reference materials. Build the complete audiovisual timeline from text. Begin directly with the three core fields — no alignment instruction. Ensure the prompt contains detailed subject appearance, scene details, action descriptions, and style.",
            "Image to Video (I2VA)": "Current mode: I2VA (Image to Video). First-frame instruction + T2VA body. The user will upload images. Use the first-frame alignment instruction: 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.' Develop forward from the first frame. If two images are provided, treat as first frame + last frame (FL2VA) — switch to the FL2VA alignment instruction and drop the angle brackets around Picture and square brackets around Shot (see FL2VA mode hint).",
            "First+Last Frame (FL2VA)": "Current mode: FL2VA (First+Last Frame). T2VA body + first-and-last-frame instruction. Picture 1 is the opening, Picture 2 is the ending. Describe the continuous path connecting them. Use alignment instruction: 'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.' IMPORTANT: In FL2VA only, write Picture 1/Picture 2 WITHOUT angle brackets and Shot 1/Shot N WITHOUT square brackets — both in the alignment instruction and in the body. Focus on how the subject moves, poses change, composition evolves. Generally favor a single shot so the model can interpolate continuously.",
            "Last Frame (L2VA)": "Current mode: L2VA (Last Frame). T2VA body + last-frame instruction. Picture 1 is the final frame, belonging to the last [Shot N]. Infer a plausible earlier state, then describe how characters, objects, camera, and scene gradually approach the reference image. Use alignment instruction: 'How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.' Recommended structure: plausible preceding state → explicit action/transition → gradual convergence in final shot → last-frame landing.",
            "Full Reference (Ref2VA)": "Current mode: Ref2VA (Full Reference). The user may upload character images, action videos, scene images, music, etc. Use the full-reference six-section format (see Section 6 of the system prompt): subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Key rules: (1) Define reference labels <Subject N>, <Picture N>, <Video N>, <Audio N> in subject_definitions — each label keeps the same meaning across all sections. (2) summary begins with a task-type prefix: keyframe completion, reference generation, video editing, video continuation, audio reuse, audio reference — combine with ' + ' when multiple apply. (3) retention_analysis uses markers: visible content → fully_preserved / partially_preserved / attribute_transfer / weak_reference; audio → fully_copy / partially_copy / reference / weak_reference. (4) The main field is detailed_description (NOT integrated_multimodal_description), 350-500 English words for generation tasks. Establish style in 1-2 sentences BEFORE [Shot 1]. Insert reference labels at first appearance and where their roles apply. (5) When a referenced subject speaks, write <Subject N> (Sx). No alignment instruction needed.",
        }

        user_message_parts = [
            f"[Generation Mode] {generation_mode}",
        ]

        if 风格提示 and 风格提示.strip():
            user_message_parts.append(f"[Extra Requirements] {风格提示.strip()}")

        user_message_parts.append(f"[Mode Hint] {mode_hints.get(generation_mode, '')}")
        user_message_parts.append(f"[User Original Prompt]\n{user_prompt.strip()}")

        # 收集图片
        image_inputs = image_inputs or []
        collected_images = []
        total_image_count = 0
        for idx, img in enumerate(image_inputs):
            if img is None:
                continue
            label = f"<Picture {idx + 1}>"
            data_uris = _xzg_image_tensor_to_data_uri(img)
            if data_uris:
                collected_images.append((label, data_uris))
                total_image_count += len(data_uris)

        if total_image_count > 0:
            image_summary = ", ".join(
                f"{label} ({len(uris)} img)" for label, uris in collected_images
            )
            user_message_parts.append(
                f"[Reference Images] {total_image_count} image(s) uploaded: {image_summary}.\n"
                "Please write clear labels and usage for each image. "
                "Analyze subject appearance, scene style, composition, etc. from the images and incorporate into the prompt optimization."
            )
            if generation_mode == "Text to Video (T2VA)":
                user_message_parts.append(
                    "[Note] Images detected. Please optimize using 'Image to Video' or 'Multimodal Fusion' mode."
                )

        # 背景音乐控制
        if no_bgm:
            user_message_parts.append(
                "[Music] No background music is desired. Set non_diegetic_music to N/A."
            )
        else:
            user_message_parts.append(
                "[Music] Please suggest appropriate background music (non_diegetic_music) that matches the mood, style, and pacing of the video. Do NOT use N/A for non_diegetic_music unless absolutely no music fits the scene."
            )

        user_message_parts.append(
            "\nBased on the above information, optimize the prompt according to H3 specification. "
            "Output the optimized prompt directly without any explanation."
        )

        return "\n".join(user_message_parts), collected_images, total_image_count

    def _build_messages(self, system_prompt, user_message, collected_images, total_image_count):
        """构造 LLM messages（支持多模态图片）。"""
        if total_image_count > 0:
            user_content = [{"type": "text", "text": user_message}]
            for label, uris in collected_images:
                for uri in uris:
                    user_content.append({"type": "image_url", "image_url": {"url": uri}})
                    user_content.append({"type": "text", "text": f"(Above is {label})"})
            return [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ]
        else:
            return [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ]

    def optimize_prompt(
        self,
        qwen_model,
        user_prompt,
        generation_mode,
        no_bgm=False,
        style_preset="无 (默认)",
        aspect_ratio="16:9",
        video_duration=10,
        风格提示="",
        output_language="仅英文",
        max_tokens=4096,
        temperature=0.7,
        top_p=0.9,
        top_k=20,
        repeat_penalty=1.0,
        frequency_penalty=0.0,
        presence_penalty=0.0,
        seed=0,
        unload_after=False,
        **kwargs,
    ):
        # 收集所有 image_* 输入
        image_inputs = [kwargs.get(f"image_{i}") for i in range(1, 10)]
        llm = qwen_model

        # 校验模型有效性；若已卸载且有缓存的配置，自动重新加载
        # _XZG_QwenStorage.unloaded 标志位用于捕获 _xzg_is_model_valid 漏检的情况
        # （llama_cpp 某些版本 close() 后 _ctx 仍存在，导致误判为有效）
        storage_unloaded = (
            _XZG_QwenStorage is not None and _XZG_QwenStorage.unloaded
        )
        if not _xzg_is_model_valid(llm) or storage_unloaded:
            reloaded = False
            reload_error = None
            if _XZG_QwenStorage is not None and _XZG_QwenStorage.settings is not None:
                print("[小珠光 H3] 模型已卸载，自动重新加载...")
                try:
                    llm = _XZG_QwenStorage.load(_XZG_QwenStorage.settings)
                    reloaded = True
                except Exception as e:
                    reload_error = e
                    print(f"[小珠光 H3] 自动重新加载失败: {type(e).__name__}: {e}")
            if not reloaded:
                if reload_error is not None:
                    raise RuntimeError(
                        "Model is invalid (closed/unloaded) and auto-reload failed. "
                        "Please re-run the Qwen Model Loader to reload the model.\n"
                        f"自动重载失败原因：{type(reload_error).__name__}: {reload_error}\n"
                        "提示：若使用 BSAI H3 Model Loader，请关闭本节点的 'unload_after' 选项，"
                        "或将 Qwen Model Loader 节点重新执行后再运行本节点。"
                    ) from reload_error
                raise RuntimeError(
                    "Model is invalid (closed/unloaded). "
                    "Please re-run the Qwen Model Loader to reload the model.\n"
                    "提示：若使用 BSAI H3 Model Loader，请关闭本节点的 'unload_after' 选项，"
                    "或将 Qwen Model Loader 节点重新执行后再运行本节点。"
                )

        if not hasattr(llm, "create_chat_completion"):
            raise TypeError(
                f"Invalid model input: expected Llama model object, got {type(llm).__name__}."
                "Check workflow connections: 'qwen_model' should connect to BSAI H3 Model Loader output."
            )

        prompt_text_input = (user_prompt or "").strip()
        if not prompt_text_input:
            raise ValueError("user_prompt cannot be empty. Please enter a prompt to optimize.")

        # 根据语言选项和风格预设动态构建系统提示词
        # 支持英文名反向映射（JS 端切换英文时传回英文名）
        style_preset = _STYLE_PRESET_EN_TO_ZH.get(style_preset, style_preset)
        # 防错校验：generation_mode 必须原样为合法英文值（不接受中文名映射）
        if generation_mode not in _GEN_MODE_EN_VALUES:
            raise ValueError(
                f"Invalid generation_mode: {generation_mode!r}. "
                f"Must be one of: {sorted(_GEN_MODE_EN_VALUES)}.\n"
                f"生成模式无效：{generation_mode!r}，请使用以下合法值之一："
                f"{sorted(_GEN_MODE_EN_VALUES)}"
            )
        preset = None if style_preset in ("无 (默认)", "None (Default)") else style_preset
        system_prompt = _xzg_build_system_prompt(output_language, preset)
        if preset:
            print(f"[小珠光 H3] 风格预设：{preset}")

        # 构造 user_message
        user_message, collected_images, total_image_count = self._build_user_message(
            user_prompt, generation_mode, image_inputs=image_inputs,
            aspect_ratio=aspect_ratio, no_bgm=no_bgm, 风格提示=风格提示,
        )

        # 构造 messages
        messages = self._build_messages(system_prompt, user_message, collected_images, total_image_count)

        if total_image_count > 0:
            print(f"[小珠光 H3] 多模态推理：{total_image_count} 张图片")

        try:
            max_tokens_val = int(max_tokens)
        except (TypeError, ValueError):
            raise TypeError(f"max_tokens must be an integer, got {type(max_tokens).__name__}.")

        normalized_seed = _xzg_normalize_seed(seed)

        # max_tokens 安全限制
        try:
            n_ctx_raw = getattr(llm, "n_ctx", 4096)
            n_ctx = int(n_ctx_raw()) if callable(n_ctx_raw) else int(n_ctx_raw)
        except Exception:
            n_ctx = 4096
        prompt_text = system_prompt + user_message
        est_prompt_tokens = int(len(prompt_text) * 1.2)
        safe_max_tokens = min(max_tokens_val, n_ctx - est_prompt_tokens - 256)
        if safe_max_tokens < 512:
            safe_max_tokens = min(max_tokens_val, max(256, n_ctx // 4))
            print(
                f"[小珠光 H3] Warning: prompt is long (~{est_prompt_tokens} tokens), "
                f"context length is only {n_ctx}, max_tokens limited to {safe_max_tokens}."
            )
        elif safe_max_tokens < max_tokens_val:
            print(
                f"[小珠光 H3] max_tokens reduced from {max_tokens_val} to {safe_max_tokens}"
            )

        params = {
            "max_tokens": safe_max_tokens,
            "temperature": float(temperature),
            "top_p": float(top_p),
            "stream": False,
        }
        if normalized_seed is not None:
            params["seed"] = normalized_seed

        # ── 单次 LLM 调用 ──
        print(f"[小珠光 H3] 单次调用：{output_language}")
        try:
            out = _xzg_call_chat_completion(llm, messages=messages, params=params)
        except (RuntimeError, KeyError, ValueError, Exception) as e:
            if _xzg_is_model_valid(llm) and "Context Shift is explicitly disabled" not in str(e):
                if "Context Shift" in str(e):
                    current_n_ctx = getattr(llm, "n_ctx", "unknown")
                    raise RuntimeError(
                        "Context Shift is disabled by the C++ backend "
                        "(M-RoPE models do not support context sliding window).\n"
                        f"Current n_ctx = {current_n_ctx}, cannot fit the full conversation.\n"
                        "Please increase 'context_length' in BSAI H3 Model Loader to 32768 or higher.\n"
                        f"Original error: {e}"
                    ) from e
                raise
            raise RuntimeError(
                f"LLM inference failed: {type(e).__name__}: {e}"
            ) from e

        try:
            text = out["choices"][0]["message"]["content"]
        except Exception:
            text = str(out)

        # 卸载模型释放显存（仅在 settings 已缓存、可自动重新加载时才卸载）
        if unload_after and _XZG_QwenStorage is not None:
            if _XZG_QwenStorage.settings is not None:
                print("[小珠光 H3] 卸载模型释放显存...")
                _XZG_QwenStorage.unload()
            else:
                print(
                    "[小珠光 H3] 跳过卸载：_XZG_QwenStorage.settings 未设置"
                    "（可能使用了 BSAI loader），卸载后将无法自动重新加载。"
                )

        return (text.lstrip().removeprefix(": ").strip(),)