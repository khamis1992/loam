# ft3 — Frontier V3 deepen: transcript-based video editing (report)

Worktree `mf/ft3` (base: manus-parity). The V3 base (commit c9aa7fb) already provided injected-STT
transcription and delete-only EDL assembly in `src/creative/transcript.ts`; this session completed the
transcript-as-editor loop and wired it into the live pipeline. **Rearrangement** now exists alongside
deletion: moving words (`moveWords`) or sentences (`moveSegments`) to a new target position resolves the
transcript into an ordered `EdlAssembly` (clips of source in/out ranges in play order, coalesced when
source-contiguous; out-of-order survivors never merge; moved-onto-own-selection is identity; silent gaps
between speech pieces are trimmed by design). A unified `applyTranscriptEdit` dispatcher accepts all six
edit kinds (`words`, `segments`, `range`, `fillers`, `move-words`, `move-segments`) and returns one uniform
result (count, removed seconds measured as source duration minus output duration, clips, text in output
order, plus the underlying delete EDL for delete-only edits). **TimelineService wiring** is the new
projection layer: `assemblyTimeline()` emits the render-ready `TimelineEdl` (`{version:1, clips:[{id,in,out}], overlays:[], sourceDuration}`) that the workspace video editor/render endpoint already
normalizes (`normalizeEdl` in `src/server/workspace/videoRender.ts` takes it unmodified), so a transcript
cut hydrates straight into the live timeline and ffmpeg render path; clips under the render model's 0.05 s
minimum are dropped and reported (`droppedClips`, `MIN_TIMELINE_CLIP_SECONDS`).

Server wiring: `POST /api/creative/transcript-edit` (`src/server/routes/transcript.ts`, extended
additively) now accepts `move-words`/`move-segments`, returns `clips` + `timeline` + `droppedClips` for
every kind, and with `save: true` + a valid `path` persists the timeline atomically as the
`<path>.edl.json` sidecar next to the task media asset — the exact sidecar the workspace video editor
hydrates, after which the panel renders the transcript cut with no web-panel changes. The routes were
also registered in `src/server/http.ts` (two additive lines) next to the other route handlers so the
endpoints are actually served; they were dead code before this session. No protected files were touched
and the web panel was not modified.

Verification: `npx tsc --noEmit` (root) and `npx tsc --noEmit -p packages/web/tsconfig.json` are both
error-free; 66 tests pass across the four relevant suites — `src/creative/__tests__/transcript.test.ts`
(23 tests: +10 for rearrangement, move validation, assembly projection, timeline wiring and short-clip
dropping), the new `src/server/__tests__/transcriptRoutes.test.ts` (6 tests: route scoping, non-media task
rejection, rearrange/delete responses, sidecar save, and input validation), plus regression runs of
`auto.test.ts` and `videoEditAgent.test.ts`. Semantic notes for future work: the transcription entry point
still requires the local STT server (`LOAM_STT_URL`, default `http://127.0.0.1:3947`); when no UI wants
per-word caret anchoring it can use `transcriptWords` flat indices for word-level ops (punctuation is
preserved in tokens); delete responses still include legacy `cuts`/`keeps` fields for compatibility while
`clips` is the new authoritative output.

Commits on `mf/ft3`: `2910330` (reference docs), `b149928` (rearrangement + assembly + timeline
projection in transcript.ts), `fde261d` (unit tests), `fbf6fa9` (route extensions), `c6fdfb8` (http.ts
registration), `9da5abf` (route tests).
