# V2 Handoff: Agentic Text-Driven Video Edit Engine

Branch: `mf/v2` (worktree `v2`). Commits: `c4a3cfc` (compiler+tool), `f89e3bf` (registry+always-on), `04ef28d` (tests), `fa3a95f` (multi-range extraction rewrite), `3bdde72` (fix: shared strict time-token regex + open-ended gate).

## What was built

- **`src/tools/videoEditAgent.ts`** — clean-room TypeScript (NOTICE at top credits the EDL-driven timeline-editing design referenced from Rakazo, Apache-2.0, via the ArtCraft gap analysis; no ArtCraft code/assets/branding used). No HTTP route needed.
  - **EDL shape** (`VideoEdl`, v1): `{ version: 1, source: { path, durationSec? }, ops: EdlOp[], warnings: string[], summary?: { outputDurationSec, segmentCount }, createdAt }`.
  - **Ops** with source-relative timestamps in seconds: `trim {fromSec,toSec}` (intersection projection), `split {atSec}`, `delete {fromSec,toSec}` (range subtraction), `reorder {order}` (1-based permutation over post-trim/delete/split segments), `overlay-text {text, atSec, durationSec?, position?: top|center|bottom}` (never alters segments). Timestamps never shift when earlier ops remove material.
  - **`computeSegments(ops, durationSec)`**: pure segment projection; consumers (UI video panel + render endpoint) must mirror it exactly. Returns null when duration unknown.
  - **`compileEdl({instruction, sourcePath, durationSec?, previous?})`**: deterministic instruction→EDL compiler (no LLM). Parses clock (`1:02:03`), seconds/minutes/hours tokens, ranges ("from X to Y", "X-Y", "first/last N", open-ended "from X onwards"), verb inheritance for comma-joined lists, `move segment N to position M` reorder, overlay text (quoted or plain) + position + duration, and reset semantics ("reset", "start over", different-source detection). Unparseable clauses become `warnings`, never hard failures. Multi-range clauses produce one op per range.
  - **`TimelineService` interface** (defined here, consumed by this tool): `inspectSource`, `loadLatestEdl`, `saveEdl`. Default impl `createWorkspaceTimelineService()` persists latest EDL to `<workspace>/uploads/loam-video-edl-latest.json` (plus timestamped copies) and probes duration via `ffmpeg-static -i` (gracefully undefined when absent).
  - **Tool `video_edit`** `{taskId?, path, instruction}` → `{ ok, content }` where content is JSON `{savedTo, edl, note}`. Never renders (that's the separate workspace video render endpoint's job; the UI video editor frees the same `VideoEdl` shape).
- **`src/server/__tests__/videoEditAgent.test.ts`** — 19 tests: timestamp parsing; multi-op compile; segment projection; duration clamping/warnings; first/last N; verb inheritance across multi-ranges; unknown-duration skips; unparseable clause warnings; mock-TimelineService tool runs; cleanup/reset/other-source chaining; gateway+ALWAYS_ON exposure across all Loam modes and work modes; per-agent `disabledTools` override. Mock `TimelineService` — no fs/network/ffmpeg.

## Registration (already done)

- `src/index.ts`: `import { createVideoEditTools }` + `rt.registry.registerAll(createVideoEditTools())`.
- `src/server/runTools.ts`: `"video_edit"` added to `ALWAYS_ON_TOOLS` (gateway allowlist recipe from MF1, commit 6f34b9d — verified by test).

## No new HTTP routes

Rendering belongs to the workspace video render endpoint (own task); this tool writes/saves the EDL via the TimelineService. If a supervisor wants a dedicated HTTP surface, `agent` API already reaches the tool through the gateway.

## Verify

```bash
npx tsc --noEmit                     # 0 errors
node --test --test-reporter=dot --import tsx src/server/__tests__/videoEditAgent.test.ts   # 19/19 pass
npx tsc --noEmit -p packages/web/tsconfig.json   # 0 errors
```

Live: run an agent task with a video in the workspace and instruct "trim from 10s to 50s, delete 20-25, split at 0:35, move segment 2 to position 1, add text \"Loam\" at 3s for 4s at the bottom" — the run transcript shows the tool call and the returned EDL JSON; the newest EDL lands in `<task workspace>/uploads/loam-video-edl-latest.json`.

## What's left (other tasks own these)

- Workspace video panel consuming `VideoEdl` (edit UI mirroring `computeSegments`).
- Workspace video render endpoint turning `VideoEdl` into a rendered file (e.g. ffmpeg filtergraph from segments + overlay cue list).
- `UNIMPLEMENTED_OPTIONS.md` cross-link if the option lands in the UI.
