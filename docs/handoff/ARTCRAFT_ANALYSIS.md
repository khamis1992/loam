# ArtCraft (github.com/storytold) — Reverse-Engineering Analysis for Loam

Date: 2026-10-21 (Asia/Riyadh). Legend: **[O]** observed in source/API, **[I]** inferred, **[U]** unknown/unverified.
Clones at /workspace/re/artcraft/. REA summaries at /workspace/re/artcraft/rea/*.md.

## 1. Identity
- "ArtCraft" = GitHub org **storytold** (brand "ArtCraft Team", getartcraft.com). [O] The GitHub *user* `ArtCraft` (id 1221783) is unrelated/empty; `storytold` is the real home. [O]
- A suite of clean-room, pure-Rust creative apps. Each repo is a Cargo workspace: a headless `engine`, an `ui-egui` desktop app, a `*-cli`, a `*-web` (wasm32) build, and an `mcp`/`automation` crate. [O]

## 2. Repos (stars, licence, clone status)
| Repo | Stars | Licence | Clean-room target | Cloned |
|---|---|---|---|---|
| photocraft | 69.6k | MIT OR Apache-2.0 | Photoshop | yes |
| artcraft | 34.5k | Apache-2.0 | AI crafting engine (umbrella, 1.3 GB) | no |
| pdfcraft | 16.6k | MIT/Apache | PDF reader/editor | no |
| filmcraft | 15.3k | MIT OR Apache-2.0 | Premiere Pro 26.5 | yes |
| wordcraft | 15.1k | MIT OR Apache-2.0 | Word | yes |
| lightcraft / vectorcraft | 14k / 10k | MIT/Apache | Lightroom / Illustrator | no |
| effectcraft | 7.5k | MIT OR Apache-2.0 | After Effects | yes |
| gridcraft | 6.0k | MIT OR Apache-2.0 | Excel | yes |
| designcraft | 4.5k | MIT OR Apache-2.0 | InDesign | yes |
| deckcraft | 4.0k | MIT OR Apache-2.0 | PowerPoint | yes |
| figcraft / soundcraft / cadcraft | 2.9k/3.4k/6.2k | Apache-2.0 | Figma / Pro Tools / AutoCAD | no |
| craft-libs | 319 | MIT OR Apache-2.0 | shared (pdf, cms, media, settings, i18n, print) | yes |
| craft-ai-integrations | 80 | MIT OR Apache-2.0 | AI provider/connection layer | yes |
| **artcraft-services** | 1.2k | **NOASSERTION** | backend + web frontend | no — NOT licence-safe |
| **artcraftx** | 982 | **none** | ArtCraft-X | no — NOT licence-safe |
| placeholder-artcraft | 28 | none | TS web shell | no — NOT licence-safe |

Approx Rust LOC: photocraft 595k, filmcraft 404k, effectcraft 389k, wordcraft 272k, designcraft 242k, deckcraft 206k, gridcraft 136k, craft-libs 125k. [O]

## 3. Licence verdict (reuse in Loam)
- **Reusable (permissive, MIT OR Apache-2.0):** filmcraft, wordcraft, gridcraft, deckcraft, designcraft, effectcraft, photocraft, craft-libs, craft-ai-integrations, and all other `*craft` apps shown Apache-2.0. [O]
  - Obligations: keep LICENSE/NOTICE, preserve copyright/attribution (ATTRIBUTION.md lists bundled fonts/icons — each asset keeps its own open licence), add a NOTICE line crediting the ArtCraft Team. No copyleft, no patent traps for MIT/Apache. [O]
  - **Trademark carve-out:** the "ArtCraft" name and logos are trademarks under docs/brand/LICENSE-brand.txt — do NOT ship them; Loam uses its own "Loam" brand. [O] Bundled brand fonts/logos are the only non-free assets; strip them. [O]
  - Codecs/containers are clean-room from public specs; README states no GPL/LGPL, no proprietary code. ffmpeg used only as an external test oracle (dev-only), not shipped. [O]
- **NOT reusable (no/declared-unclear licence): artcraft-services, artcraftx, placeholder-artcraft.** Treat as inspiration only; for anything we want from them we write a behavioral spec and clean-room it (see §7). [O]

## 4. Shared architecture [O]
- Strict layered crates (from filmcraft docs/architecture.md): L0 time/geom/color/bitstream + pure-Rust codecs (h264, h264enc, hevc, vp9, av1, prores, dnx, apv, dng, aac, ac3, mpa, opus, isobmff, matroska, mxf, cfb, mpegts, ogg) → L1 frame/media/project/audio-dsp/text → L2 edit/codecs/interchange/captions/speech/tts → L3 render/gpu/export → L4 engine → L5 ui-egui/automation/platform → L6 apps (desktop/cli/web).
- **"Everything is a command"**: `Session::execute(id, params_json)`. Each command carries a stable id, label, menu path, shortcut, a parameter doc, an `enabled()` predicate that returns a human-readable reason, and `run()`. The SAME ids/params are used by the egui UI, the CLI, the JSON control channel, the MCP server, and the browser `window.<app>.execute` API. This is the single most important pattern to copy. [O]
- Integer **ticks** + rational frame rates (no f64 seconds in edit math). Project is `Arc<Project>` copy-on-write; undo = snapshot stack; background readers (playback/export) hold a snapshot lock-free. [O]
- CPU compositor is the reference oracle; wgpu GPU path is tested against it (golden tests). [O]

## 5. Per-app editor components & agent surface
### FilmCraft — video editing / montage [O]
- ~421 command ids. Edit: `timeline.razor/roll/slide/slip/select`, `trim.*`, `source.insert/overwrite`, `sequence.open/close/extract/lift`, `clip.group/link/nest/rename`, `edit.cut/copy/paste/duplicate/label.*`, `effects.apply/remove/reset`, `playhead.*`.
- Text-based editing (Descript-style): `transcript.generate/search/select/lift/extract/set/delete`, `captions.add/split/merge/import/export/move/trim`.
- AI/audio: `speech` crate = pure-Rust Whisper (mel, tokenizer, align), VAD, diarization; `tts.create/edit/preview/render/voices`; narration/voiceover; essential-sound; remix (music auto-retime); scene detect; multicam.cut/grid.
- Render/export: `render` crate (plan → track → effects/blend/transitions/mask/color) + `export` pipeline with a job queue (`export.queue.add/start/stop/retry`, `export.presets.*`), deterministic/HDR/surround tests.
- **Agent APIs (3):** (1) MCP server (official rmcp, stdio): headless drives in-process `Session`, renders frames to PNG; bridge mode forwards to a live desktop app over JSON-lines TCP (`filmcraft --control <port>`) exposing `ui.inspect/click/drag/scroll/key/menu.invoke/playback`. (2) `filmcraft-cli`. (3) Browser `window.filmcraft`: `.execute(cmd,params)`, `.request(method,params)`, `.inspect()`, `.screenshot()`, `.importFiles()`, `.readFile()`, `.info()`, plus `window.filmcraftLoad` timings. Web host services: Blob media reads, OPFS autosave/recovery, WebAudio out, WebCodecs decode. [O]

### WordCraft — Word [O]
Crates: doc, docbin, docx, engine, fonts, formats, layout, metafile, pdf, proof, render, ui-egui, zotero, mcp, control-key. Reads/writes .docx. MCP tools: new/open/save_document, type_text, select_text, get_text, render_page, screenshot, execute/command, list_commands, inspect_document, ui.parity. Ribbon, styles, tables, track changes, references, mail merge, Zotero citations, proofing. [O]

### GridCraft — Excel [O]
Crates: calc, chart, core, engine, formula, functions, model, numfmt, pdf, xlsx, ui-egui, mcp (+ headless.rs). Reads/writes .xlsx. MCP/agent tools: new/open/save_workbook, get_cell/set_cell, read_range/write_range, evaluate_formula, list_functions, format_range, sort_range, filter, create_table, insert_chart, inspect_workbook, undo/redo, execute_command. Typed cell values (number/string/boolean/date/error/formula) + number formats + charts. [O]

### DeckCraft — PowerPoint [O]
Crates: anim, engine, fonts, format, model, pptx, pdf, render, text, media + codecs (av1/h264/hevc/vp9 ported from filmcraft), mcp (+ headless.rs). Reads/writes .pptx. Tools: new/open/save_presentation, add_slide, add_text_box, add_shape, insert_picture/table/chart, set_text, go_to_slide, render_slide, select_tool (pen/highlighter/eraser/pointer/arrow/shape/textbox), export, run_command, ui.* (pointer/key/text/inspect), batch. Themes, layouts, transitions, animations, full-screen present. [O]

### DesignCraft — InDesign [O]
Crates: compose, doc, engine, epub, fonts, format, geom, idml, images, pdf, pptx, render, textimport, tools, mcp. Reads IDML, exports PDF/EPUB/PNG. Tools: new/open/save/export document, place_image, set_story_text, get_story, select_tool, render_page, batch, dialog_* , full key/pointer control. [O]

### EffectCraft — After Effects [O]
Crates: automation, effects (306 effects), engine, expr, export, gpu, host, interchange, keyframe, lottie, media, model, path, plugin, project, psd, raster, render, script, segment, svg, text, time, track + encoders. 129 command ids. **Scripting engine** (`script` crate): JS runtime (prelude.js, scriptui.js), panels, tasks, services, callables — an ExtendScript-like automation surface. Compositions, layers, keyframes, layer styles, expressions, 3D cameras/lights, render queue, Lottie/SVG/PSD import. [O]

### PhotoCraft — Photoshop [O]
Crates: affinity, algo, automation, cms, codecs, color, compose, doc, engine, format, gpu, heif, io, ipp, ops, paint, plugins, psd, raster, raw, tablet, text, vector. Layers, masks, adjustment layers, layer styles, type, vectors, brushes, real PSD read/write, RAW, HEIF, colour management. [O]

### craft-libs / craft-ai-integrations [O]
- craft-libs: shared crates pdf (krilla writer + hayro reader, vendored), cms, media, print, settings, i18n, atomic, docpath, quit. Directly reusable utility layer.
- craft-ai-integrations: ai-core + ai-http — provider/connection/key management, egui widgets. A ready AI-provider abstraction (MIT/Apache). [O]

## 6. How an AI agent drives them (reuse pattern for Loam)
Every app already ships the exact thing Loam needs: a **headless, command-addressable engine** with a **JSON control channel**, an **MCP server**, and a **browser `window.<app>` promise API** that mirrors the MCP ids. For Loam's Electron+React+TS shell this means: embed the app's `*-web` wasm build in a side panel iframe/canvas, call `window.<app>.execute(id,params)` / `.request(...)` / `.screenshot()` from the Loam agent, and/or spawn the `*-cli`/MCP server from the Node backend for headless server-side generation. The "everything is a command + enabled() reason" contract gives the agent a self-describing tool list (`list_commands`) and safe failure messages. [O/I]

## 7. Clean-room behavioral specs for NON-reusable parts (artcraft-services, artcraftx, placeholder-artcraft)
Khamis's directive: where a licence does not allow reuse, rebuild the capability ourselves (new code, no verbatim copy of their code or protected assets). These are rebuild specs in our own words, inferred from repo descriptions/metadata since the code is not licence-safe to read for copying. Mark **[I]** — behavior inferred from names/READMEs, not copied.

- **S-SERVICES (clean-room "artcraft-services"):** a backend + web frontend that (a) lists the craft apps, (b) brokers launches, (c) holds shared account/licence/telemetry, (d) serves the web (wasm) builds. Loam rebuild: a small Node service in `src/tools/loamStudioHost.ts` that registers each embedded craft-web build, serves its wasm/assets from Loam's own static dir, exposes a `/api/studio/<app>/command` proxy to the headless engine, and a React "Studio" launcher. Do not copy their routes/schema; derive from our own needs. [I]
- **S-LAUNCHER (clean-room craft-launcher):** a desktop launcher that downloads/updates app bundles. Loam rebuild: a Loam "Creative Studio" tab listing in-app tools (video/doc/sheet/slide/design/photo/effects) with one-click open into a side panel. New code. [I]
- **S-AIX (clean-room artcraftx / craft-ai-integrations alternative):** if we prefer not to depend on craft-ai-integrations, write our own provider layer in TS mirroring Loam's existing model routing (Ollama → OpenCode Go → freellmapi → ornith-1.5:9b). New code; craft-ai-integrations itself IS permissively licensed so it may be used directly as a Rust reference instead. [O/I]
