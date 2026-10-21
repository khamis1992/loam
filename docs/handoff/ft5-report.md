# ft5 — Frontier R1 deepen: wide/parallel research dispatcher + synthesis

Worktree: `mf/ft5` (manus-parity base). Scope honored: `src/tools/wideResearch.ts` + focused tests only. No protected files touched; `wide_research` was already registered additively in `src/index.ts` and `src/server/runTools.ts` (ALWAYS_ON) from the prior R1 commit (`1156023`) — no registry change was needed this session.

## What this session added (commit `3fbd05b`)

1. **List dispatch (one sub-agent per item).** The tool now accepts an explicit `items` array (caller-decomposed research list — the Manus wide-research behavior "dispatch N agents over a list"). Each item becomes its own independent sub-agent, prioritized after the optional seed `sources`, and remaining budget still fills with automatic research angles. `planResearchTasks()` gained an additive optional `items` parameter; the tool's breadth now defaults to `max(4, sources+items)` (never above the hard ceiling of 20), so an explicit list runs at full width without the caller computing a breadth.
2. **Two-phase map/reduce-style synthesis.** For finding sets larger than `WIDE_RESEARCH_SYNTHESIS_CHUNK` (8), `runWideResearch()` now synthesizes in the same pattern as the `map_reduce` primitive: it splits findings into contiguous order-preserving chunks (`chunkFindings`), maps a partial report per chunk through the synthesizer in parallel (each with its own `taskId`-derived context), then reduces the partial reports into one merged report. Failure semantics are explicit: a chunk whose synthesis fails still contributes a deterministic partial (`deterministicSynthesis`), and a failed reduce falls back to the deterministic merge of all findings and deduped sources. Small sets (≤ chunk) keep the previous single-call merge, so existing behavior is unchanged.

Both additions are core-model-free (dispatcher/synthesizer injected), so they are fully offline-testable.

## Verification

- `npx tsx --test src/tools/__tests__/wideResearch.test.ts` → 35/35 pass (28 pre-existing + 7 new focused tests: item planning, dedup/cap, breadth-budget clipping, chunk splitting, parallel map + reduce, chunk-failure fallback, reduce-failure fallback, single-call threshold).
- `npx tsc --noEmit` (root) → 0 errors; `npx tsc --noEmit -p packages/web/tsconfig.json` → 0 errors.
- `npx tsx --test src/server/__tests__/runTools.test.ts` → 14/14 pass (confirms the registry still exposes `wide_research` in every mode).

## Notes for the next session

- `items` uses the same trim/dedup/cap rules as `sources` (`normalizeSources`), but the two lists are deduped independently — an item may legitimately equal a seed source URL.
- `/graphify` graph (`graphify-out/`) not present in this worktree; core was understood by direct reading of `src/tools/mapReduce.ts` (the per-item fan-out primitive this deepening mirrors) and the existing `wideResearch.ts` header contract.
- Possible follow-ups outside this file scope: routing the wide-research report into Studio (deck/sheet/doc) is R2/deepResearch territory (`src/tools/deepResearch.ts`).
