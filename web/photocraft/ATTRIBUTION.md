# Attribution

Every non-code asset in this repository, with its author, source and license. PhotoCraft's own
code and original assets are MIT OR Apache-2.0 (see [`LICENSE-MIT`](LICENSE-MIT),
[`LICENSE-APACHE`](LICENSE-APACHE) and [`NOTICE`](NOTICE)). When you add an asset, add a row here
in the same change; third-party assets must be permissively licensed and keep their license file
next to them.

## Bundled in the app

| Path | Title | Author | Source | License |
|---|---|---|---|---|
| `crates/codecs/src/codecs/xpm/x11_colors.rs` | X11 `rgb.txt` color-name lookup table (normalized X.Org RGB values) | X.Org Foundation and X11 contributors | <https://cgit.freedesktop.org/xorg/app/rgb/tree/rgb.txt> | MIT (X.Org app/rgb) |
| Embedded at build time from storytold/craft-i18n `locales/<code>/common.tsv` and `locales/<code>/photocraft.tsv` (revision in [`craft-i18n.rev`](craft-i18n.rev)) | UI translations (all languages) | craft-i18n and PhotoCraft contributors; per-language credits and provenance in [craft-i18n's ATTRIBUTION.md](https://github.com/storytold/craft-i18n/blob/main/ATTRIBUTION.md) | <https://github.com/storytold/craft-i18n> | MIT OR Apache-2.0; Copyright (c) 2026 ArtCraft Team and the craft-i18n contributors; notice in [NOTICE](NOTICE) |
| `epaint_default_fonts::EGUI_ICONS` (build input; deflated into `OUT_DIR/egui_fonts/egui-icons.ttf.deflate`, registered by `crates/ui-egui/src/text/egui_fonts.rs`) | egui-icons, five-glyph subset of emoji-icon-font | John Slegers | [egui fork at 6d518fc](https://github.com/storytold/egui/tree/6d518fc799681571963842f95b55a6b68431b15a/crates/epaint_default_fonts/fonts), [original](https://github.com/jslegers/emoji-icon-font); egui subset, unmodified here | MIT; Copyright (c) 2014 John Slegers; full upstream notice in [NOTICE](NOTICE) |
| `assets/fonts/Inter-Regular.ttf`, `Inter-Medium.ttf`, `Inter-SemiBold.ttf` | Inter 4.001 (UI font) | The Inter Project Authors (Rasmus Andersson) | <https://github.com/rsms/inter> | SIL OFL 1.1, [`assets/fonts/OFL-Inter.txt`](assets/fonts/OFL-Inter.txt) |
| `assets/fonts/JetBrainsMono-Regular.ttf` | JetBrains Mono 2.305 (numeric font) | The JetBrains Mono Project Authors | <https://github.com/JetBrains/JetBrainsMono> | SIL OFL 1.1, [`assets/fonts/OFL-JetBrainsMono.txt`](assets/fonts/OFL-JetBrainsMono.txt) |
| `assets/icons/*.svg` except `vector-shape.svg`, `slice-knife.svg`, `slice-select.svg`, `font-similar.svg`, `font-variable.svg`, `sampler.svg`, `artboard.svg`, `perspective-crop.svg`, `frame-placeholder.svg`, `ellipse-dashed.svg`, `gradient.svg`, `type-mask.svg`, `type-mask-vertical.svg`, `text-warp.svg`, `clip-below.svg`, `clip-release.svg`, `layer-mask.svg`, `adjustment-layer.svg`, `brush-replace.svg`, `history-brush.svg`, `quick-selection.svg`, `eraser-background.svg`, `eraser-magic.svg`, `lasso-magnetic.svg`, `direct-select.svg`, `convert-point.svg`, `pen-add-anchor.svg`, `pen-delete-anchor.svg`, `pen-freeform.svg`, `pen-curvature.svg`, `bandage-sparkle.svg`, `painting-symmetry.svg`, `symmetry-*.svg`, `path-op-*.svg` and `marquee-{row,column}.svg`, `align-edge-*.svg` and `distribute-*.svg`, `crop-overlay-*.svg`, `vertical-align-*.svg`, `spirit-level.svg` (117 files; `star-filled.svg` is `star.svg` with a solid fill) | Lucide icons | Lucide Icons and Contributors | <https://github.com/lucide-icons/lucide> (`icons/<name>.svg`; `align-*` are now named `text-align-*` upstream) | ISC, [`assets/icons/LICENSE-lucide.txt`](assets/icons/LICENSE-lucide.txt) |
| `assets/icons/{check,chevron-down,chevron-left,chevron-right,chevron-up,chevrons-left,chevrons-right,circle,clock,compass,info,link,link-2,lock,minus,monitor,moon,move,navigation,plus,search,square,trash,triangle,type,x,zoom-in,zoom-out}.svg` | Lucide icons derived from Feather (subset of the row above) | Cole Bemis (Feather), Lucide Contributors | <https://github.com/feathericons/feather> via Lucide | MIT (Feather) and ISC (Lucide), [`assets/icons/LICENSE-lucide.txt`](assets/icons/LICENSE-lucide.txt) |
| `assets/icons/vector-shape.svg` | Vector path shape-layer glyph with four anchor points | @superplay2021 | Original work for PhotoCraft | MIT OR Apache-2.0 |
| `assets/icons/slice-knife.svg` | Slice tool glyph | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/slice-select.svg` | Slice Select tool glyph | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/crop-overlay-*.svg` | Crop overlay glyphs: Rule of Thirds, Grid, Diagonal, Triangle, Golden Ratio and Golden Spiral inside the crop-mark frame | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/spirit-level.svg` | Straighten tool glyph: a spirit level with its vial and bubble under a dotted arc | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/sampler.svg` | Color Sampler tool glyph: a target reticle marking a sampled pixel | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/font-similar.svg`, `assets/icons/font-variable.svg` | Font menu filter glyphs: two waves (Show Similar Fonts) and a T over a slider (Show Variable Fonts), drawn on the 24 px icon grid | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/convert-point.svg` | Convert Point tool glyph: an angle with a square anchor on its apex, drawn on Lucide's 24 px grid and stroke | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/artboard.svg` | Artboard tool glyph: a board with a tick at each end of its edges | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/perspective-crop.svg` | Perspective Crop tool glyph: a crop frame in perspective with its grid and crop-mark ticks | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/type-mask.svg`, `assets/icons/type-mask-vertical.svg` | Horizontal and Vertical Type Mask tool glyphs: a T drawn as marching ants (the vertical one beside a downward arrow), on Lucide's 24 px grid and stroke | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/path-op-{new-layer,combine,subtract,intersect,exclude,merge}.svg` | Path Operations glyphs (Pen options bar): a single square for New Layer, and two overlapping squares showing the area each operation keeps (union, back minus front, overlap, everything but the overlap, the merged outline), drawn on Lucide's 24 px grid and stroke | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/text-warp.svg` | Create Warped Text glyph (Type tool options bar): a T above a bowed arc, drawn on Lucide's 24 px grid and stroke | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/marquee-row.svg`, `assets/icons/marquee-column.svg` | Single Row and Single Column Marquee tool glyphs: a dashed row (column) between two edge bars, drawn on Lucide's 24 px grid and stroke | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/clip-below.svg`, `assets/icons/clip-release.svg` | Clipping-mask cursors (⌥ over the line between two layers): a hooked arrow onto the layer below; the same with a small "no" badge to release | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/layer-mask.svg`, `assets/icons/adjustment-layer.svg` | Layers panel footer glyphs: Add a mask (a frame around a solid disc) and New Fill or Adjustment Layer (a circle, one half solid), drawn on Lucide's 24 px grid and stroke | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/vertical-align-{top,middle,bottom}.svg` | Type options-bar alignment glyphs for vertical text: three columns hanging from a top line, centred on a middle line, or standing on a bottom line, drawn on Lucide's 24 px grid and stroke | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/align-edge-*.svg`, `assets/icons/distribute-*.svg` | Move tool options-bar glyphs: Align (six edges/centres) and Distribute (edges, centres, spacing), a guide line or edge lines with bars, drawn on Lucide's 24 px grid and stroke | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/ellipse-dashed.svg` | Elliptical Marquee tool glyph: a dashed horizontal ellipse, drawn on Lucide's 24 px grid and stroke | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/frame-placeholder.svg` | Frame tool glyph: an empty placeholder frame, crossed corner to corner | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/gradient.svg` | Gradient tool glyph: a rounded rectangle filled with a left-to-right linear ramp, drawn on Lucide's 24 px grid and stroke | PhotoCraft contributors | Original work | MIT OR Apache-2.0 |
| `assets/icons/eraser-background.svg`, `assets/icons/eraser-magic.svg` | Background Eraser and Magic Eraser tool glyphs: Lucide `eraser` plus added marks | Lucide Icons and Contributors; marks by PhotoCraft contributors | Derived from <https://github.com/lucide-icons/lucide> `icons/eraser.svg` | ISC, [`assets/icons/LICENSE-lucide.txt`](assets/icons/LICENSE-lucide.txt) |
| `assets/icons/brush-replace.svg` | Color Replacement tool glyph: Lucide `brush` plus two swap arrows | Lucide Icons and Contributors; arrows by PhotoCraft contributors | Derived from <https://github.com/lucide-icons/lucide> `icons/brush.svg` | ISC, [`assets/icons/LICENSE-lucide.txt`](assets/icons/LICENSE-lucide.txt) |
| `assets/icons/history-brush.svg` | History Brush tool glyph: Lucide `brush` plus counter-clockwise history rewind arrow | Lucide Icons and Contributors; arrow by PhotoCraft contributors | Derived from <https://github.com/lucide-icons/lucide> `icons/brush.svg` | ISC, [`assets/icons/LICENSE-lucide.txt`](assets/icons/LICENSE-lucide.txt) |
| `assets/icons/quick-selection.svg` | Quick Selection tool glyph: Lucide `brush`, scaled to 70%, inside a dashed upright rounded "C" selection | Lucide Icons and Contributors; selection by PhotoCraft contributors | Derived from <https://github.com/lucide-icons/lucide> `icons/brush.svg` | ISC, [`assets/icons/LICENSE-lucide.txt`](assets/icons/LICENSE-lucide.txt) |
| `assets/icons/bandage-sparkle.svg` | Remove tool glyph: Lucide `bandage` moved down, plus a sparkle mark | Lucide Icons and Contributors; mark by PhotoCraft contributors | Derived from <https://github.com/lucide-icons/lucide> `icons/bandage.svg` | ISC, [`assets/icons/LICENSE-lucide.txt`](assets/icons/LICENSE-lucide.txt) |
| `assets/icons/direct-select.svg` | Direct Selection tool glyph: Lucide `mouse-pointer-2` plus an anchor square | Lucide Icons and Contributors; square by PhotoCraft contributors | Derived from <https://github.com/lucide-icons/lucide> `icons/mouse-pointer-2.svg` | ISC, [`assets/icons/LICENSE-lucide.txt`](assets/icons/LICENSE-lucide.txt) |
| `assets/icons/pen-freeform.svg`, `assets/icons/pen-curvature.svg` | Freeform Pen and Curvature Pen tool glyphs: Lucide `pen-tool` scaled down, plus a freehand squiggle or a curve through two points | Lucide Icons and Contributors; marks by PhotoCraft contributors | Derived from <https://github.com/lucide-icons/lucide> `icons/pen-tool.svg` | ISC, [`assets/icons/LICENSE-lucide.txt`](assets/icons/LICENSE-lucide.txt) |
| `assets/icons/pen-add-anchor.svg`, `assets/icons/pen-delete-anchor.svg` | Add Anchor Point and Delete Anchor Point tool glyphs: Lucide `pen-tool` plus a + or − mark | Lucide Icons and Contributors; marks by PhotoCraft contributors | Derived from <https://github.com/lucide-icons/lucide> `icons/pen-tool.svg` | ISC, [`assets/icons/LICENSE-lucide.txt`](assets/icons/LICENSE-lucide.txt) |
| `assets/icons/painting-symmetry.svg` | Painting symmetry glyph: Lucide `heart` with a central axis | Lucide Icons and Contributors; adapted by @shorbank | Derived from <https://github.com/lucide-icons/lucide> `icons/heart.svg` | ISC, [`assets/icons/LICENSE-lucide.txt`](assets/icons/LICENSE-lucide.txt) |
| `assets/icons/symmetry-{vertical,horizontal,dual,diagonal}.svg` | Painting symmetry axis glyphs | @shorbank | Original work; supplied SVG line geometry centred on a common square canvas, stroke adjusted to match the painting-symmetry glyph | MIT OR Apache-2.0, [`assets/icons/LICENSE-symmetry-axes.txt`](assets/icons/LICENSE-symmetry-axes.txt) |
| `assets/icons/lasso-magnetic.svg` | Magnetic Lasso tool glyph, adapted from "Magnetic Lasso Tool" (redrawn on the 24 px toolbar grid) | Lil' Seal (Noun Project); adapted by PhotoCraft contributors | <https://thenounproject.com/icon/magnetic-lasso-tool-177513/> | CC BY 3.0, [`assets/icons/LICENSE-noun-magnetic-lasso.txt`](assets/icons/LICENSE-noun-magnetic-lasso.txt) |
| `assets/dict/en_US-scowl-50.txt.gz` | English word list for Check Spelling (SCOWL 2020.12.07, size 50, en_US; 72,403 words) | Kevin Atkinson and the SCOWL contributors | <http://wordlist.aspell.net/> | SCOWL license (permissive, keep the notice), [`assets/dict/LICENSE-SCOWL.txt`](assets/dict/LICENSE-SCOWL.txt), which also has the build recipe |
| `crates/cms/profiles/photocraft-coated-cmyk.icc` | PhotoCraft Coated CMYK (synthetic) ICC profile | PhotoCraft contributors (generated by `photocraft-cms`, `src/synth.rs`) | Original work, see [`crates/cms/README.md`](crates/cms/README.md) | CC0-1.0 |
| `assets/app-icon/` (all files) | PhotoCraft app icon (nine-tailed kitsune) | The project owner (drawn in ArtCraft, vectorised) | Original work, see [`assets/app-icon/README.md`](assets/app-icon/README.md) | MIT OR Apache-2.0, [`assets/app-icon/LICENSE.txt`](assets/app-icon/LICENSE.txt) |
| `packaging/macos/dmg/` (all files) | PhotoCraft DMG window background and layout | @XusBadia, from the PhotoCraft app icon | Original work, see [`packaging/macos/dmg/README.md`](packaging/macos/dmg/README.md) | MIT OR Apache-2.0, like the code |
| `crates/ui-egui/src/theme.rs` (Solarized Dark palette) | Solarized colour scheme used by the Solarized Dark theme | Ethan Schoonover | <https://ethanschoonover.com/solarized/> | MIT, [`LICENSE-solarized.txt`](crates/ui-egui/src/LICENSE-solarized.txt) |
| `crates/ui-egui/src/theme.rs` (Breeze Light and Breeze Dark themes) | The Breeze Light and Breeze Dark themes are original colour values on PhotoCraft's Studio layout, chosen to look close to KDE Plasma's Breeze (cool blue-greys, blue accent, 5 px frame radius) so the app blends into a Plasma desktop. None of Breeze's colour values, files or code are copied; the values are a few levels away from its schemes and tuned for text contrast | PhotoCraft contributors | Inspired by the look of KDE Breeze, <https://invent.kde.org/plasma/breeze> (its colour schemes are LGPL-2.0-or-later) | Original work |
| `crates/ui-egui/src/theme.rs` (Soft Dark and Soft Light themes) | Original colour values and radii for two low-contrast themes on PhotoCraft's Studio layout; no third-party palette, file or code is used | PhotoCraft contributors | Original | Original work |
| `crates/algo/data/libfacedetection.bin` (face detection weights, read by `crates/algo/src/faces.rs`, whose network code is a port of the library's) | libfacedetection CNN (YuNet design) weights and inference code, weights converted to half precision | Shiqi Yu | [ShiqiYu/libfacedetection](https://github.com/ShiqiYu/libfacedetection) (`src/facedetectcnn-data.cpp`, `facedetectcnn.cpp`, `facedetectcnn-model.cpp`) | BSD-3-Clause, [`LICENSE-libfacedetection.txt`](crates/algo/data/LICENSE-libfacedetection.txt) |

### Optional build input: craft-fonts (not files in this repo)

Builds made with `CRAFT_FONTS_DIR` (all official releases) embed fonts from
[storytold/craft-fonts](https://github.com/storytold/craft-fonts) at a pinned commit; no font file
from it is committed here. Per-file authors, sources and licences:
[craft-fonts `ATTRIBUTION.md`](https://github.com/storytold/craft-fonts/blob/main/ATTRIBUTION.md).

| Font (embedded at build time) | Use | License |
|---|---|---|
| BIZ UDPGothic Regular, Bold (Morisawa) | Japanese UI and sans Type fallback (desktop) | SIL OFL 1.1, shipped as `OFL-biz-ud-pgothic.txt` |
| Shippori Mincho Regular (FONTDASU) | Japanese serif Type fallback (desktop) | SIL OFL 1.1, shipped as `OFL-shippori-mincho.txt` |
| BIZ UDMincho Regular (Morisawa) | Japanese serif Type fallback (desktop) | SIL OFL 1.1, shipped as `OFL-biz-ud-mincho.txt` |

The other built-in ICC profiles and the generated LUT looks are produced by code at runtime
(`crates/cms/src/builtin.rs`, `crates/cms/src/lutfile.rs`) and dedicated to the public domain
(CC0-1.0); they are not separate files.

## Documentation and README

| Path | Title | Author | Source | License |
|---|---|---|---|---|
| `docs/brand/` (all files) | ArtCraft name, wordmark and mark | ArtCraft Team | getartcraft.com | Not open source; trademarks of the ArtCraft Team, [`docs/brand/LICENSE-brand.txt`](docs/brand/LICENSE-brand.txt) |
| `docs/images/photocraft-*.jpg` | PhotoCraft screenshots | PhotoCraft contributors (UI) | Rendered offscreen with the `snapshot` example | MIT OR Apache-2.0 (UI); the artwork in each is public domain, listed below |
| `docs/images/embedded-vector-editor-en.png` | Embedded AI/PDF/EPS conversion warning and editor chooser (no artwork) | Don Omondi | Offscreen `smart_svg_ui::tests::capture_embedded_vector_conversion_prompt` with authored bytes and mock services | MIT OR Apache-2.0 |
| `docs/images/embedded-vector-tabs-linux.png` | Shared VectorCraft window after a portal editor save and ordinary document launch | Don Omondi | Local Linux GUI acceptance with authored orange rectangle/blue circle SVGs; no private artwork | MIT OR Apache-2.0 |
| `docs/images/preset-invalid-choice-before.png` | Gradient preset import before validation, with the collision dialog closed | @yoriswind | Offscreen PhotoCraft capture with the synthetic `Fire.grd` gradient fixture | MIT OR Apache-2.0 |
| `docs/images/preset-invalid-choice-after.png` | Gradient preset import after validation, with the collision dialog still open | @yoriswind | Offscreen PhotoCraft capture with the synthetic `Fire.grd` gradient fixture | MIT OR Apache-2.0 |
| `docs/images/cpu-pixel-alignment/*.png` | CPU canvas pixel alignment, before and after #8321 | PhotoCraft contributors | Original synthetic noise rendered with the offscreen `snapshot` example; see the adjacent README | MIT OR Apache-2.0, adjacent `LICENSE-MIT` and `LICENSE-APACHE` |
| `docs/images/multi-channel-editing/{curves,curves-choices,levels,drawing,mask-view-before,mask-view-after}.png` | Selected colour channel editing (synthetic gradient) | @hidoba | Original synthetic gradient rendered with the offscreen `snapshot` example; adjacent JSON scripts | MIT OR Apache-2.0, adjacent `LICENSE-MIT` and `LICENSE-APACHE` |
| `docs/images/multi-channel-editing/great-wave.jpg`, `rgb.png`, `cmyk.png`, `lab.png`, `gallery-channel-preview-{before,after}.png` | *The Great Wave off Kanagawa*, c. 1830–1832, and PhotoCraft channel-selection captures | Katsushika Hokusai (artwork); PhotoCraft contributors (UI) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Tsunami_by_hokusai_19th_century.jpg), Metropolitan Museum reproduction; adjacent JSON capture scripts | Public domain artwork (PD-Art), adjacent `LICENSE-PUBLIC-DOMAIN.txt`; UI/scripts MIT OR Apache-2.0 |

Artwork shown in the screenshots (all public domain, via Wikimedia Commons; details in
[`docs/images/SOURCES.md`](docs/images/SOURCES.md)):

| Screenshot | Artwork | Source |
|---|---|---|
| `photocraft-demo.jpg` | *The Great Wave off Kanagawa*, Katsushika Hokusai, c. 1831 | [Commons](https://commons.wikimedia.org/wiki/File:Tsunami_by_hokusai_19th_century.jpg) |
| `photocraft-layer-styles.jpg` | *Earthrise*, William Anders, Apollo 8, 1968 (NASA) | [Commons](https://commons.wikimedia.org/wiki/File:NASA-Apollo8-Dec24-Earthrise.jpg) |
| `photocraft-masks.jpg` | *Girl with a Pearl Earring*, Johannes Vermeer, c. 1665 | [Commons](https://commons.wikimedia.org/wiki/File:1665_Girl_with_a_Pearl_Earring.jpg) |
| `photocraft-vector.jpg` | *Water Lilies*, Claude Monet, 1906 | [Commons](https://commons.wikimedia.org/wiki/File:Claude_Monet_-_Water_Lilies_-_1906,_Ryerson.jpg) |
| `photocraft-filters.jpg` | *The Starry Night*, Vincent van Gogh, 1889 | [Commons](https://commons.wikimedia.org/wiki/File:Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg) |
| `photocraft-adjustments.jpg` | *Impression, Sunrise*, Claude Monet, 1872 | [Commons](https://commons.wikimedia.org/wiki/File:Monet_-_Impression,_Sunrise.jpg) |
| `photocraft-transform.jpg` | *The Tetons and the Snake River*, Ansel Adams, 1942 (U.S. National Archives) | [Commons](https://commons.wikimedia.org/wiki/File:Adams_The_Tetons_and_the_Snake_River.jpg) |
| `photocraft-type.jpg` | *Among the Sierra Nevada, California*, Albert Bierstadt, 1868 | [Commons](https://commons.wikimedia.org/wiki/File:Albert_Bierstadt_-_Among_the_Sierra_Nevada,_California_-_Google_Art_Project.jpg) |
| `photocraft-export-light.jpg` | *The Kiss*, Gustav Klimt, 1907–1908 | [Commons](https://commons.wikimedia.org/wiki/File:Gustav_Klimt_016.jpg) |

## Test data (not committed, not shipped)

`corpus/` is gitignored and no test fixtures are committed to the repository, except the small
synthetic parser fixtures listed under *Synthetic parser test fixtures* below.
`cargo xtask corpus --all` fetches every corpus at the pinned commits in `xtask/src/corpus_pins.rs`
and verifies each file against the sha256 lists in `xtask/*.sha256`, with the upstream licence
next to the files:

| Path (fetched) | Title | Author | Source | License |
|---|---|---|---|---|
| `corpus/photoshop/` (258 PSDs) | Photoshop oracle corpus: smart filters, layer-style effects, type, adjustments in every mode and depth | PhotoCraft contributors (authored with Adobe Photoshop 2026 by a script) | [https://github.com/storytold/photocraft-corpus](https://github.com/storytold/photocraft-corpus) (`photoshop/`, with its generator and README) | MIT OR Apache-2.0 |
| `corpus/gimp/` (28 files, 251 KB) | GIMP XCF oracles: 40×30 procedural layers written by GIMP 3.2.6 through the corpus generator `tools/gimp-xcf/xcf_fixtures.py`, each with GIMP's merged rendering as a PNG | PhotoCraft contributors (authored with GIMP 3.2.6 by a script) | [https://github.com/storytold/photocraft-corpus](https://github.com/storytold/photocraft-corpus) (`gimp/`, with its generator and README) | MIT OR Apache-2.0 |
| `corpus/psd-tools/` (309 files) | psd-tools test set | Kota Yamaguchi and contributors | [psd-tools `tests/psd_files`](https://github.com/psd-tools/psd-tools/tree/main/tests/psd_files) | MIT, Copyright (c) 2019 Kota Yamaguchi |
| `corpus/psd/` (170 files) | Small selection of the psd-tools and ag-psd test files | Kota Yamaguchi; Agamnentzar | psd-tools (above) and [ag-psd `test/`](https://github.com/Agamnentzar/ag-psd/tree/master/test) | MIT (both) |
| `corpus/heif/` (9 files, 0.1 MB) | HEIC/HEIF test files: `heic-rs/` checkerboards, RGB strips and a grid-tiled photo with EXIF and XMP (synthetic pixels encoded by macOS `sips`, each `.ref.png` Apple's decode); `pillow-heif/` the 10-bit RGBA `RGBA_10__29x100.heif` and its source `RGBA_16__29x100.png` | Thomas Braun (heic-rs); Pillow-Heif contributors | [heic-rs `tests/fixtures`](https://github.com/tbraun96/heic-rs/tree/main/tests/fixtures), [pillow-heif `tests/images`](https://github.com/bigcat88/pillow_heif/tree/master/tests/images) | MIT OR Apache-2.0 (heic-rs); BSD-3-Clause (pillow-heif) |
| `corpus/exr/` (5 files, 2.3 MB) | The deep OpenEXR test images `11`, `42`, `64`, `multivariate` and `objectid.deep.exr` | Contributors to the OpenEXR Project | [openexr `src/test/bin/test_images`](https://github.com/AcademySoftwareFoundation/openexr/tree/main/src/test/bin/test_images) | BSD-3-Clause |
| `corpus/affinity/` (60 files) | Public Affinity documents and PNG references: `vector-art/` (9 documents), `afdesignload/` (9), `jac21/` (2), `asset-store-template/` (1), and `affinity-samples/` (18 CC0 documents plus exported references) | samuel-etver; Nick Beeuwsaert; Jeremy Cantu; DAIKI (eviltwo); satoshoe-dev | [vector-art `simple/`](https://github.com/samuel-etver/vector-art/tree/255f8add3c8f0740196e22bd59502b811b532f0b/simple), [AFDesignLoad `testDesigns/`](https://github.com/NickBeeuwsaert/AFDesignLoad/tree/a18dd50a7079fb861a28835eeefa0d015f03f4a1/testDesigns), [Jac21/Branding `Logos/JC/DesignerFiles/Affinity`](https://github.com/Jac21/Branding/tree/57ae3f45bf4637f6927c0b07de25b922c55f944f/Logos/JC/DesignerFiles/Affinity), [AssetStoreTemplate `AssetStoreTemplate/`](https://github.com/eviltwo/AssetStoreTemplate/tree/f671981ee89d15526285b3cc87b4393d3defe644/AssetStoreTemplate), [affinity-samples](https://github.com/satoshoe-dev/affinity-samples/tree/96aca6bd86bbe7a677f1cf0630bd832d23943be8) | CC0-1.0 (vector-art and affinity-samples); MIT, Copyright (c) 2015 Nick Beeuwsaert; MIT, Copyright (c) 2018 Jeremy Cantu; MIT, Copyright (c) 2024 DAIKI |
| `corpus/atn/` (16 files, 0.9 MB) | Photoshop Actions sets, one folder per repository: `sbaril/` (Frequency Separation, Firefly, Dimension, Harmonize, Photo, Quick Object Extraction, Generative Upscale), `bjango/` (Bjango Actions, Adjustment Actions, Scale Actions), `bkwld/` (Save layers for web), `atntools/` (test.atn), `trimmer/` (Trimmer), `alpha-utility/` (AlphaUtilityAdditions), `gif-creator/` (BannerActions) | Stéphane Baril; Bjango and Marc Edwards; BKWLD; Maurits Rijk; damsmcfly; UCLA Game Lab; overbyte | [sbaril/Photoshop-Scripts](https://github.com/sbaril/Photoshop-Scripts), [bjango/Bjango-Actions](https://github.com/bjango/Bjango-Actions), [BKWLD/photoshop-actions](https://github.com/BKWLD/photoshop-actions), [mrijk/atntools](https://github.com/mrijk/atntools), [damsmcfly/photoshop-cleaner-trimmer](https://github.com/damsmcfly/photoshop-cleaner-trimmer), [uclagamelab/AlphaUtilityAdditions](https://github.com/uclagamelab/AlphaUtilityAdditions), [overbyte/photoshop-gif-creator-script](https://github.com/overbyte/photoshop-gif-creator-script), pinned in [xtask/src/corpus_pins.rs](xtask/src/corpus_pins.rs) | MIT (sbaril, BKWLD, atntools, gif-creator), BSD (bjango, per `Help/License.md`), BSD-2-Clause (alpha-utility), Unlicense (trimmer); each licence file sits next to its files |
| `corpus/pngsuite/` | PngSuite | Willem van Schaik | <http://www.schaik.com/pngsuite/> | Public domain |
| `corpus/pixls/` (11 files) | Real camera raws, one per decode path: Canon PowerShot SX50 HS (CR2 and its DNG conversion), Nikon D3 uncompressed NEF and Z6 paired 12/14-bit lossy and packed NEFs, Sony DSC-RX0 cRAW ARW, Panasonic DC-G9 high-res RW2, Olympus E-1 GRBG ORF, plus the E-5 packed ORF as the documented known-unsupported case. Per file (each CC0, per its database entry): [IMG_4059.CR2](https://raw.pixls.us/data/Canon/PowerShot%20SX50%20HS/IMG_4059.CR2), [CRW_4061.DNG](https://raw.pixls.us/data/Canon/PowerShot%20SX50%20HS/CRW_4061.DNG), [JD1_8203.NEF](https://raw.pixls.us/data/Nikon/D3/JD1_8203.NEF), [DSC00009.ARW](https://raw.pixls.us/data/Sony/DSC-RX0/DSC00009.ARW), [P1000475.RW2](https://raw.pixls.us/data/Panasonic/DC-G9/P1000475.RW2), [E_1__C106743_gredos.ORF](https://raw.pixls.us/data/Olympus/E-1/E_1__C106743_gredos.ORF), [_7061961_copy.ORF](https://raw.pixls.us/data/Olympus/E-5/_7061961_copy.ORF), [DSC_0750.NEF](https://raw.pixls.us/data/Nikon/Z%206/DSC_0750.NEF), [DSC_0751.NEF](https://raw.pixls.us/data/Nikon/Z%206/DSC_0751.NEF), [DSC_0753.NEF](https://raw.pixls.us/data/Nikon/Z%206/DSC_0753.NEF), [DSC_0754.NEF](https://raw.pixls.us/data/Nikon/Z%206/DSC_0754.NEF) | The photographers of the pixls.us raw samples database | [raw.pixls.us](https://raw.pixls.us) `data/`, fetched per [xtask/src/corpus_pins.rs](xtask/src/corpus_pins.rs) | CC0 / public domain, per file as linked |

Files copied into `corpus/` by hand (tiff, exr, raw) must be MIT, BSD or CC0.

## Synthetic parser test fixtures

| Path | Title | Author | Source | License |
|---|---|---|---|---|
| `crates/psd/tests/fixtures/atn/*.atn` | Independently encoded ATN version-16 and version-12 parser fixtures | PhotoCraft contributors (version-12 files: @yoriswind) | Original synthetic test data; wire layout documented in `crates/psd/src/atn.rs`; provenance in the adjacent README | MIT OR Apache-2.0 |

## Embedded-vector editor source

The external SVG watcher, engine/UI handoff and bounded SVG rendering in this change
are adapted from Skyfuller1303’s MIT OR Apache-2.0 implementation in
[PhotoCraft #3409](https://github.com/storytold/photocraft/pull/3409), commit
`897f20072762fdf0eb688adcdb8d8cda7b38ce66`. Don Omondi’s embedded AI/PDF/EPS
extension and current-main integration build on that source. Clipboard and unrelated
Shape Tools changes from that branch are not included.

## Assets bundled by the PDF reader dependency (craft-pdf)

PhotoCraft imports PDF pages through `craft-pdf`, pinned to the craft-libs revision
`c5a1cbfb5f9049f9270955caffb5bee5997aebf7`. The renderer vendors Hayro and the assets below;
they ship inside the dependency rather than being copied into this repository. PDFium is no
longer used or shipped.

| Crate / file | Author | Source | Licence | Use |
| --- | --- | --- | --- | --- |
| `hayro-interpret 0.7.0 / assets/Foxit*.pfb` (13 standard-14 font files) | Foxit Software Inc. / PDFium Authors | <https://github.com/storytold/craft-libs/tree/c5a1cbfb5f9049f9270955caffb5bee5997aebf7/vendor/hayro-interpret/assets> | BSD-3-Clause | Renders non-embedded standard-14 PDF fonts |
| `hayro-interpret 0.7.0 / assets/CGATS001Compat-v2-micro.icc` | Clinton Ingram (saucecontrol/Compact-ICC-Profiles) | <https://github.com/storytold/craft-libs/tree/c5a1cbfb5f9049f9270955caffb5bee5997aebf7/vendor/hayro-interpret/assets> | CC0-1.0 | Default CMYK colour conversion |
| `hayro-cmap 0.1.0 / assets/cmaps.brotli` | Adobe | <https://github.com/storytold/craft-libs/tree/c5a1cbfb5f9049f9270955caffb5bee5997aebf7/vendor/hayro-cmap/assets> | BSD-3-Clause | Character-code mapping for CJK PDFs |
