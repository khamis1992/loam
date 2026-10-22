# Loam — Frontier Gap Plan & Parallel Task Breakdown

Date: 2026-10-21 (Asia/Riyadh). Repo: manus-local ("Loam"), branch manus-parity. Read-only review of C:\Users\khamis\Desktop\manus-local on machine eff27a36. Legend: **[O]** observed in repo/web, **[I]** inferred, **[U]** unknown.
Companion: /workspace/re/artcraft/ARTCRAFT_ANALYSIS.md. Sources cited inline.

## 0. Current Loam shape [O]
- Electron + React/TS shell, Node backend (HTTP on 127.0.0.1:3939/:3100-ish), modes catalog in `src/modes/catalog.ts`: ask (Explore), research, build, write, data, media (Studio), security, automate (Flow).
- Studio (office): `src/studio/*` — word/sheet/slide via `docx`, `exceljs`, `pptxgenjs`, OOXML roundtrip, office-preview bundle (ui/office-preview.bundle.js). Editing + preview + OOXML import/export already exist.
- Creative (video): `src/creative/timeline.ts` (35k), offline-render.ts, store.ts; ui/creative-timeline*.js; uses ffmpeg + playwright/chromium for render; a `TimelineService` with render/proxy job queue, media mode only.
- Security (pentest): `src/security/*` — large clean-room scanner suite (xss, sql/nosql, ssrf, xxe, injection, path-traversal, deserialization, template-injection, business-logic 60k, assessments 54k, browser 81k, source-flow taint 23k, discovery, planning, repairs). Mature.
- Tools: browser.ts (playwright), pentest.ts, web.ts, officeTools.ts, creativeStudio.ts, mobile.ts, computerUse.ts, frontierBridge.ts, serviceGapTools.ts.
- Mobile builder: Kotlin + Expo (no iOS/Swift, no store submit) [O from docs/competitive-gaps].
- Existing internal audits: docs/frontier-audit-2026-10-19.md (overall self-score 48/100), docs/competitive-gaps-2026-10-18.md. [O]

## 1. Frontier benchmark per service (2026, with sources)
- **AI video editing / montage.** Frontier = Descript Underlord (agentic co-editor: prompt → multi-step edits, text-based editing where deleting transcript text deletes video, filler-word removal, Studio Sound, scenes/layouts, auto-clip generation, AI actions, avatar/explainer, script writing) + CapCut (multi-track timeline, auto-reframe, auto-captions, templates, keyframes, beat-sync, mobile+web+desktop) + Runway/Sora/Veo for generative clips. Sources: descript.com/underlord, descript.com/blog best-ai-video-editor 2026, contextrankings Descript-vs-CapCut 2026-07. [O]
- **Word/Excel/PowerPoint generation & editing.** Frontier = Microsoft Copilot Agent Mode in Word/Excel/PowerPoint (GA Apr 2026, takes actions not just suggestions, understands pivot tables / animations, Anthropic models) + Claude for Office (build in your template, pinpoint slide edits without regenerating, native charts/diagrams, tracked changes, respond to comment threads, preserve template compliance) + Gamma (design-quality web decks) + Genspark AI Slides (research+generate in one pass, 100+ skills). Sources: learn.microsoft.com wordexcelppt-agents, computerworld 2026-04-24, claude.com office-agents, palpa.co.jp slide-tool compare. [O]
- **Design.** Frontier = Canva Magic / MS Designer / Figma AI — brand-consistent layouts, image gen, templates. [O web]
- **Pentest / vulnerability scanning.** Frontier (XBOW-104 benchmark, now considered saturated): RedPick 104/104 black-box, BoxPwnr 101/104, Shannon 100/104 (white-box, source-to-sink taint, 3-tier Claude, ~$50/scan), KinoSec 96/104 (50-turn cap, pure HTTP), XBOW own 85%, MAPTA 76.9% ($21), AWE 51.9% but 53s/challenge & injection-specialist. Takeaway: frontier = multi-agent, memory-augmented, evidence-gated, browser-backed verification, source-to-sink taint when source available. Sources: redpick.ai/blog 104-xbow, docs.pwnkit.com competitive-landscape, arxiv 2603.00960 (AWE), 2603.27127 (Red-MIRROR). [O]
- **Website / app building.** Frontier = Lovable (full-stack React/TS/Tailwind + native Supabase schema/auth/migrations/RLS, 80+ integrations, Stripe, GitHub sync, custom domains, one-click deploy, multiplayer) + Manus 1.6 (design-exploration phase, hero-image gen, ZIP/GitHub export, Manus-hosted deploy). Sources: hostadvice lovable-vs-manus 2026. [O]
- **Research agents.** Frontier = Manus Wide Research (tens/hundreds of items across parallel agents + synthesis) + OpenAI Deep Research (cited reports) + Genspark Super Agent (research routed into docs/sheets/slides/sites). Sources: aiidelist genspark-vs-manus 2026, zyentorpicks comparison. [O]
- **Browser agents.** Frontier (OSWorld / GUI): Claude-4-Sonnet ~43.9%, Qwen3-VL-235B-Thinking 38.1% [O arxiv/iclr]; product-wise Manus Browser Operator (uses existing local browser sessions) + Genspark Chrome ext/Claw + Comet. [O]

## 2. Gap + ranked feature list per service
Priority: P1 = closes biggest frontier gap / Khamis-requested; P2 = strong differentiator; P3 = polish.

### A) AI Video / Montage Studio (Khamis's explicit ask: "new task → side panel shows the edit live, editable by hand or by text, with a montage tool area; same for Word/Excel/PowerPoint")
Loam now: TimelineService render/proxy queue + JS timeline UI, ffmpeg render; no agentic text-driven editing, no transcript editing, no live side-panel-with-tools UX bound to a task, no scene detect/auto-clip. [O]
Frontier gap: no Underlord-style agent loop, no transcript-as-editor, no auto-reframe/captions pipeline, weak timeline NLE vs CapCut.
Ranked features:
1. **[P1] Task-bound Studio side panel** — when a task is created in `media` mode, open a right-side live editor panel showing the in-progress montage with a tool area (trim, split, text, transitions, audio), editable manually AND by chat text. (Khamis core request.)
2. **[P1] Agentic text-driven editing loop** — agent tool `video.edit(instruction)` that plans + applies timeline commands and renders a preview, reviewable/undoable.
3. **[P1] Transcript-based editing** — auto-transcribe (reuse pure-Rust Whisper spec from FilmCraft `speech`), delete/rearrange transcript text → edits the cut; filler-word removal.
4. **[P2] Auto-captions + auto-reframe + scene detect + auto-clip** (long→short).
5. **[P2] Studio-Sound-style audio cleanup, essential sound, remix retime.**
6. **[P3] Generative clip insert** via existing media model connectors (Runway/Sora-class) behind connector keys.

### B) Office Studio (Word/Excel/PowerPoint) — Khamis: same live side-panel + tool-area UX
Loam now: full create/edit/preview + OOXML roundtrip via docx/exceljs/pptxgenjs. [O] Known bug (docs/frontier-audit F06): Excel edit coerces cell types (123→"456", true→FALSE). [O]
Frontier gap: no Copilot/Claude-style agent-in-the-document ("edit selected slide without regenerating", tracked changes, respond to comments, template compliance), native charts/diagrams from bullets, pivot-aware Excel.
Ranked features:
1. **[P1] Task-bound live Office side panel with tool ribbon** (word/sheet/slide), hand-editable + chat-editable. (Khamis core request.)
2. **[P1] Pinpoint edit agent** — `office.edit(target, instruction)` editing a selected slide/range/paragraph without regenerating the whole file; preserve template/styles.
3. **[P1] Fix Excel typed-cell model** (number/string/bool/date/error/formula) — adopt GridCraft's typed-value model as reference. [O F06]
4. **[P2] Bullets→native charts/diagrams** (deck), pivot-aware Excel edits, tracked changes + comment-thread replies in Word.
5. **[P2] Research→deck in one pass** (Genspark/Gamma-style) via research agent handoff.

### C) Design — [P2] brand-kit + templated layout + image-gen design tool (Canva-class). Loam lacks a dedicated design surface; reuse DesignCraft (InDesign-class, Apache) or VectorCraft as embedded tool.

### D) Pentest / Vuln scanning
Loam now: mature clean-room scanner suite + browser-frontier. [O]
Frontier gap vs XBOW leaders: not a multi-agent evidence-gated loop; no source-to-sink white-box taint orchestration tied to an agent planner; no turn-capped black-box exploit agent; no published benchmark run.
Ranked features:
1. **[P1] Multi-agent orchestrated exploit loop** (planner + specialist + verifier) with evidence gating and browser-backed verification (AWE/MAPTA pattern).
2. **[P2] Source-to-sink taint mode** when target source is available (Shannon pattern) — Loam already has source-flow.ts taint; wire it to the agent planner.
3. **[P2] Run the XBOW-104 (or successor) suite** for a measured score; add CI harness.

### E) Website/app building
Loam now: build mode + mobile (Kotlin/Expo), preview/serve.ts; no external DB/Supabase, no one-click deploy, no Stripe, no GitHub push flow, no design-exploration phase. [O + docs/competitive-gaps items 8,13-20]
Ranked: 1.**[P1]** one-click deploy (Manus-hosted-style local serve + export). 2.**[P2]** Supabase/DB native + Stripe. 3.**[P2]** design-exploration phase + hero-image gen. 4.**[P2]** iOS/Swift + store submit (currently missing). 5.**[P3]** GitHub sync.

### F) Research agents — [P1] Wide/parallel research (dispatch N sub-agents over a list + synthesize) + cited Deep-Research report; route results into Studio (deck/sheet/doc). Loam has swarm/mapReduce primitives to build on. [O]

### G) Browser agents — [P2] Browser Operator over existing local session (Manus-style) + robust OSWorld-style action loop; Loam has browser.ts (playwright) + computerUse.ts to extend. [O]

## 3. Which ArtCraft code/libs to reuse (licence-safe) vs clean-room
Reuse directly (MIT/Apache, strip ArtCraft brand assets, keep NOTICE):
- **FilmCraft** engine/edit/speech/export → video Studio backend + transcript editing (Whisper) + command model. [O]
- **GridCraft** core/engine/formula/functions/numfmt/xlsx typed-cell model → fixes Excel bug + frontier sheet edits. [O]
- **DeckCraft** engine/pptx/model → native charts/diagrams, pinpoint slide edits. [O]
- **WordCraft** doc/docx/engine/proof/track-changes → tracked changes + comment threads + template-preserving edits. [O]
- **DesignCraft / VectorCraft / PhotoCraft** → Design + image surfaces. [O]
- **craft-libs** (pdf/cms/media/settings/i18n) + **craft-ai-integrations** → shared utils + provider layer. [O]
- The **command + enabled()-reason contract**, **MCP server**, **JSON control channel**, and **window.<app> wasm API** → the agent-driving pattern for every embedded Studio tool. [O]
NOT reusable (no/unclear licence) → clean-room from behavioral spec (see ARTCRAFT_ANALYSIS §7): artcraft-services, artcraftx, placeholder-artcraft, craft-launcher UI/brand.
Integration note: ArtCraft apps are Rust/wasm; Loam is Electron+React+TS+Node. Two integration paths: (a) embed the `*-web` wasm build in a Loam side panel and call `window.<app>.*`; (b) spawn `*-cli`/MCP from the Node backend for headless generation. Prefer (a) for the live editable panels Khamis asked for, (b) for server-side batch. [I]

## 4. Parallel-session task breakdown for OpenCode workers (non-overlapping file scopes)
Each task = one worktree/session, isolated file scope, same safety constraints (OpenCode only, no push to main, verify types, redact secrets). Where reuse is blocked, the task is a clean-room rebuild from the spec in ARTCRAFT_ANALYSIS §7.

| ID | Task | Primary file scope (non-overlapping) | Source model |
|---|---|---|---|
| V1 | Task-bound video Studio side panel (UI) | packages/web/src video panel + ui/creative-studio-panel.js (new) | new UI |
| V2 | Agentic text-driven video edit tool | src/tools/videoEditAgent.ts (new) | new, drives TimelineService |
| V3 | Transcript-based editing + Whisper transcribe + filler removal | src/creative/transcript.ts (new) | clean-room from FilmCraft speech/transcript spec |
| V4 | Auto-captions / auto-reframe / scene-detect / auto-clip | src/creative/auto.ts (new) | FilmCraft edit/scene_detect spec |
| O1 | Task-bound Office Studio side panel + tool ribbon | packages/web/src office panel + ui/studio-panel.js (new) | new UI |
| O2 | Pinpoint office.edit agent (no full regen, template-preserving) | src/tools/officeEditAgent.ts (new) | Claude-for-Office behavior |
| O3 | Fix Excel typed-cell model | src/studio/sheet-format.ts, sheet-roundtrip-format.ts | GridCraft typed-value model |
| O4 | Bullets→native charts/diagrams + tracked changes + comment replies | src/studio/slide-chart-data.ts, word-* (scoped) | DeckCraft/WordCraft |
| D1 | Design Studio surface (brand kit + templates + image gen) | src/tools/designStudio.ts + ui/design-panel.js (new) | DesignCraft/Canva |
| P1 | Multi-agent evidence-gated exploit loop | src/security/orchestrator.ts (new) | AWE/MAPTA pattern |
| P2 | Wire source-to-sink taint to agent planner | src/security/planning.ts (scoped add) | Shannon pattern |
| P3 | XBOW-104 benchmark harness + CI | src/scripts/check-pentest-bench.ts (new) | benchmark |
| W1 | One-click deploy + export | src/preview/deploy.ts (new) | Manus/Lovable |
| W2 | Supabase/DB + Stripe scaffolding | src/tools/backendScaffold.ts (new) | Lovable |
| W3 | Design-exploration phase + hero-image gen in build mode | src/modes + build flow (scoped) | Manus |
| R1 | Wide/parallel research dispatcher + synthesis | src/tools/wideResearch.ts (new) on swarm/mapReduce | Manus Wide Research |
| R2 | Cited Deep-Research report + route to Studio | src/tools/deepResearch.ts (new) | OpenAI DR / Genspark |
| B1 | Browser Operator over local session + OSWorld-style loop | src/tools/browserOperator.ts (new) extends browser.ts | Manus |
| CR1 | Clean-room Studio host service (replaces artcraft-services) | src/tools/loamStudioHost.ts (new) | §7 S-SERVICES spec |
| CR2 | Clean-room Creative Studio launcher tab | ui/studio-launcher.js (new) | §7 S-LAUNCHER spec |

Dependencies: O1/V1 (panels) should land before O2/V2/V3 (agents fill them); O3 before O4; P2 before P1 benefits; CR1 before CR2. All others independent → safe to run concurrently.

## 5. Observed/inferred/unknown summary
- [O] ArtCraft repos, licences, architecture, command surfaces, MCP/CLI/web APIs (read from cloned source + REA summaries).
- [O] Loam current services/files (read-only on Khamis PC), existing audits, frontier benchmarks (cited web sources).
- [I] Best integration path (wasm embed vs cli/MCP), clean-room specs for unlicensed repos, exact task file scopes (proposed, may need small adjustment once a worker opens the dir).
- [U] Whether ArtCraft wasm builds drop cleanly into Loam's Electron CSP; whether Loam's Node can run the Rust CLIs on Khamis's Windows without extra toolchain — needs a build spike (task V/O1 should verify early).
