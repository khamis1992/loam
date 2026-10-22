# FR research tools — frontier review & hardening

Scope: `src/tools/wideResearch.ts` (wide parallel research fan-out + cited merge)
and `src/tools/deepResearch.ts` (iterative cited report + Studio routing).
Branch: `mf/frresearch`. Read-only review first, then targeted fixes; no
rewrites, no protected files touched.

Verdict: the two modules are structurally sound and already carry real tests.
The review found one genuine correctness bug, one synthesis quality gap, and a
cancellation gap. All are fixed below with focused regression tests.

## Findings & fixes

### wideResearch.ts

1. **[Bug] `normalizeCitation` duplicated the port for every non-default port.**
   The key builder emitted `url.host` (which already contains `host:port`) and
   then appended `url.port` again, so `https://example.com:8443/path` normalized
   to `https://example.com:8443:8443/path`. Two consequences: dedup keys were
   corrupt, and the same resource with/without tracking params could fail to
   merge. The existing suite only used default ports, so it never caught this.
   **Fix:** emit `url.hostname` (never includes the port) plus an explicit port
   only when non-default (`src/tools/wideResearch.ts:222`).

2. **[Quality] The reduce step silently dropped the deduplicated source list.**
   `runSynthesis` passes the full source list in `WideResearchSynthesisInput.sources`,
   but `buildSynthesisPrompt` ignored it. Partial findings are constructed with
   `citations: []`, so the model-backed reduce could lose the source list unless
   the model happened to repeat URLs from the partial prose. The deterministic
   fallback did include sources, so behaviour was inconsistent between paths.
   **Fix:** `buildSynthesisPrompt` now appends a `Cited sources (n):` block from
   the `sources` argument (optional, default `[]`), and `createDefaultSynthesizer`
   passes `input.sources` (`src/tools/wideResearch.ts:658`, `:716`).

### deepResearch.ts

3. **[Cancellation gap] `runDeepResearch` ignored `ctx.signal`.**
   `web_fetch` only applies its own 30 s timeout and does not take the task
   signal, so cancelling a task left the loop running through every remaining
   search/fetch round. **Fix:** abort is checked at the start of every round and
   before every page read; the loop stops promptly. If nothing was read the result
   reports `"Research was cancelled before any source could be read."`; otherwise
   the partial report is still returned (`src/tools/deepResearch.ts:202`).

4. **[Robustness] `depth` was not sanitized inside the exported function.**
   `runDeepResearch(topic, depth, ctx)` trusted the caller; `NaN`/`undefined`
   produced zero iterations and an empty report. The tool already clamped, but the
   exported core did not. **Fix:** clamp to `1..3` with a finite-number guard,
   matching the tool (`src/tools/deepResearch.ts:213`).

5. **[Error clarity] `deliverResearchToStudio` threw a bare `unknown` conflict.**
   After three 409s it re-threw the captured value (possibly `null` in principle)
   with no context. **Fix:** rethrow the captured `StudioError` when present,
   otherwise throw a clear `StudioError` (`src/tools/deepResearch.ts:499`).

## Checked and found solid (no change)

- Bounded fan-out: breadth clamped to `1..20`, worker pool never exceeds the
  concurrency limit; every child failure is surfaced in `tasks` instead of
  collapsing the report.
- Child capability scoping: `resolveChildAllowlist` intersects requested ∩
  registered ∩ `ctx.allowedTools`, so a child can never widen the parent run's
  policy; the child set is read-only research/file tools (no shell).
- Citation extraction/dedup is order-preserving and keeps the first-seen form.
- Two-phase map/reduce synthesis falls back to the deterministic merge on any
  partial or reduce failure, and chunking preserves plan order.
- Studio routing is conflict-safe: create on empty, append onto a matching kind,
  refuse (never clobber) a different kind, retry on 409; writers are additive.
- `deep_research` is always-on and registered in the build-mode allowlist.
- No secrets, no TODO/stub markers, no network dependency in the cores (both are
  injectable), encoding clean for all touched files.

## Tests added

- `src/tools/__tests__/wideResearch.test.ts` — non-default port normalization and
  dedup (regression for finding 1); merge prompt carries/omits the source block
  (finding 2).
- `src/server/__tests__/deepResearch.test.ts` — `isStudioDeliverKind`; an
  already-aborted run returns a cancelled result with zero network calls
  (finding 3); empty-canvas artifacts for all three deliver kinds.

Run:

```
node --import tsx --test src/tools/__tests__/wideResearch.test.ts
node --import tsx --test src/server/__tests__/deepResearch.test.ts src/server/__tests__/deepResearchStudio.test.ts
```
