# Review: agentic video editing modules (`mf/frvideo`)

Scope: `src/tools/videoEditAgent.ts`, `src/creative/transcript.ts`,
`src/creative/auto.ts`. Reviewed as a frontier-quality pass over an existing
implementation; fixes are small and additive, no rewrite. All findings are
reproduced by the new unit tests.

## Summary

| Area | Findings | Status |
|---|---|---|
| `videoEditAgent.ts` | 4 correctness/robustness bugs | fixed |
| `transcript.ts` | 3 correctness bugs + 2 hardening gaps | fixed |
| `auto.ts` | 2 robustness bugs + 1 missing degradation path | fixed |
| Integration | EDL shape mismatch with the workspace video panel | documented (P1, owned elsewhere) |

## `src/tools/videoEditAgent.ts`

### F1 (bug) — a saved EDL's known duration was discarded when the probe failed
`compileEdl` read only `input.durationSec`. When ffmpeg was absent or the probe
failed, `durationSec` was `undefined`, so `reorder`, `first N`, `last N`, and
open-ended ranges were skipped with warnings **even though the previously saved
EDL knew the source duration**. Successive instructions after a probe failure
silently degraded.
**Fix:** fall back to `previous.source.durationSec` when the probe returns none.
Test: `reuses a saved EDL's duration when the probe returns none`.

### F2 (bug) — a partial reorder was accepted as a silent no-op
The bare-permutation path filtered indices to `1..segments.length` *before*
validating, so `reorder 1 2` on a single-segment source produced a valid no-op
`order:[1]` instead of a warning. A malformed instruction therefore "succeeded".
**Fix:** validate the parsed list as an exact permutation of every surviving
segment; out-of-range or short lists now warn.
Test: `rejects a reorder that does not name every surviving segment`.

### F3 (bug) — an overlay at/past the end emitted a zero-length op
`add text "Hi" at 60s for 4s` on a 60 s source produced
`{atSec:60,durationSec:0}`. The render model rejects clips/overlays below its
minimum, so the edit was stored but could not render.
**Fix:** after clamping, skip the op with a warning when `atSec >= durationSec`.
Test: `skips an overlay at or beyond the video end`.

### F4 (hardening) — corrupt saved EDL ops were carried into new edits
`looksLikeEdl` only checked `version`/`ops[]`/`source.path`; a sidecar with an
unknown op or non-numeric fields was loaded and passed through to the UI/agent.
**Fix:** `isValidEdlOp` validates every v1 op shape; `loadLatestEdl` now discards
a corrupt sidecar and starts fresh.
Tests: `discards a corrupt EDL ...`, `ignores a malformed JSON sidecar ...`.

### F5 (polish) — duplicated "needs a known video duration" warning
Open-ended clauses ("from X to the end") emitted both the specific skip warning
and a generic duration warning. The guard regex now recognises the open-ended
wording so the generic warning is suppressed.

## `src/creative/transcript.ts`

### F6 (bug) — surviving text ignored authoritative STT word timings
`deleteWords`/`detectFillerWords` cut by `transcriptWords`, which uses real STT
word stamps when present, but `segmentsAfterCuts` recomputed token times by
proportional interpolation. Deleting an STT-timed word removed the correct video
range yet left the word in `textAfter` (and could remove a different token).
**Fix:** new `segmentTokens` helper shares the exact timing rule with
`transcriptWords`; `segmentsAfterCuts` uses it.
Test: `uses STT word timings for surviving text, matching the cut range`.

### F7 (bug) — `removed` overcounted cuts past the media end
`buildEdl` summed raw merged cuts without clamping to `transcript.duration`, so
`buildEdl(t50, [{40,999}])` reported `removed: 959`.
**Fix:** clamp merged cuts to `[0,total]` and derive `removed`/`keeps` from the
clamped cuts.
Test: `clamps cuts beyond the media duration when building the EDL`.

### F8 (hardening) — unknown edit kind returned `undefined`
`applyTranscriptEdit`'s exhaustive switch had no default, so a direct caller with
a bad kind got `undefined` (later crashing on `.count`). The HTTP route validates
the kind, but the exported API should fail closed.
**Fix:** default branch throws `unsupported transcript edit kind`.
Test: `throws on an unknown transcript edit kind`.

### F9 (hardening) — duplicate indices inflated the reported count
`count` used `edit.indices.length`, so `move-words [1,1]` reported `count: 2`
while moving one piece.
**Fix:** report `new Set(indices).size`.
Test: `reports the deduplicated selection count`.

### F10 (hardening) — unbounded PCM buffering during audio extraction
`readAudioBytes` buffered the entire ffmpeg WAV output in memory; a long,
low-bitrate source can expand far beyond its own size once decoded to 16 kHz mono.
**Fix:** `MAX_EXTRACT_BYTES` (512 MiB) cap with `checkExtractionBudget`; the child
is killed and the promise rejected past the cap.
Test: `enforces the audio extraction budget`.

## `src/creative/auto.ts`

### F11 (bug) — malformed diff scores produced a NaN threshold
`adaptiveThreshold` did not validate `score`; a single `undefined`/`NaN` made the
median `NaN`, which then made `detectScenes` throw `threshold must be a number
within 0..1`. A bad probe sample took down the whole plan.
**Fix:** filter to finite `[0,1]` scores and fall back to the 0.35 static default.
Test: `falls back instead of returning NaN for malformed scores`.

### F12 (bug) — `parseSceneLog` could emit NaN scene scores
The score character class `[0-9.eE+-]` matches `1-2`; `Number("1-2")` is `NaN`
and was pushed as a score.
**Fix:** ignore non-finite scores and clamp to `[0,1]`.
Test: `ignores non-finite scene scores instead of producing NaN samples`.

### F13 (hardening) — a failing probe lane rejected the whole plan
`planAutoEdit` only handled *missing* lanes. A lane that throws (e.g. an ffmpeg
timeout) rejected the request entirely instead of degrading.
**Fix:** each optional lane is wrapped in try/catch; a failure adds a warning and
falls back to the missing-lane behaviour.
Test: `degrades with warnings when a probe lane throws`.

## Integration finding (P1, owned by other tasks — not changed here)

`video_edit` saves the **instruction EDL** (`{source, ops, warnings, summary}`)
to `uploads/loam-video-edl-latest.json`, but the workspace video panel hydrates
`<source>.edl.json` via `normalizeEdl`, which requires the **render-ready EDL**
(`{sourceDuration, clips, overlays}`). No code in the repo converts between the
two, so the tool's description ("saved ... for the workspace video panel (editing)
and the video render endpoint") is not yet true end to end. `computeSegments` and
`loam-video-edl` are referenced only by this module and its tests.

The V2 handoff (`docs/handoff/V2-video-edit-agent.md`) explicitly lists the panel
and render-endpoint consumption as "other tasks own these", so this review did
not wire the bridge. Recommended next step: add a pure
`instructionEdlToRenderEdl(videoEdl)` (segments + overlay cues) and have the
workspace video route/hydrate accept it, or have the tool also write the
`<source>.edl.json` sidecar it claims to feed.

## Tests added

- `src/tools/__tests__/videoEditAgent.test.ts` (new): compiler hardening +
  workspace EDL loader (valid round-trip, corrupt/malformed sidecar).
- `src/creative/__tests__/transcript.test.ts`: +6 cases.
- `src/creative/__tests__/auto.test.ts`: +4 cases.

Run:

```bash
node --import tsx --test \
  src/tools/__tests__/videoEditAgent.test.ts \
  src/creative/__tests__/transcript.test.ts \
  src/creative/__tests__/auto.test.ts
```

## Gates

`npx tsc --noEmit` 0 errors; `npm run build:server` exit 0; the three suites
above pass (81 tests); `packages/web` typecheck + touched vitest suites pass.
