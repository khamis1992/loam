# ft8 report — FRONTIER B1 deepen: Browser Operator loop

**Branch:** `mf/ft8` (worktree) · Commits: `12f972b` (implementation), `d963f89` (focused tests) · tsc root 0 errors, `packages/web` tsc 0 errors.

## What was done

`src/tools/browserOperator.ts` already had the basic observe→plan→act→verify loop over browser.ts; this task deepened it additively (same file + its test). The loop now:

1. **`select` action support** — new `OperatorAction`/`OperatorIntent` kind (`SELECT` op in browser.ts for native `<select>` elements). `parseIntent` recognizes "select/choose/pick X [in/from/on the Y]" goals (order-stable ahead of the click regex), the planner targets only elements that reported `SELECT` capability and fall back to click ranking when no native select exists, `goalSatisfied` verifies by element **value** (not name — a button sharing the option label can no longer pre-satisfy a select goal), and `BrowserToolSurface.act` maps it to `browser_act op:SELECT` with snapshot-id freshness.
2. **Ops-aware planning** — `parseObservationTable` now captures the per-element `ops:` list (`OperatorElement.ops?`, optional for back-compat). Type actions require `TYPE_TEXT` capability (both ranked match and fallback), select actions require `SELECT`; unknown/empty ops stays permissive so fakes and older stories keep working.
3. **Settle wait before verification** — new `settleMs` loop control (tool default 400 ms, loop default 0). After a successful click/type/select, the surface performs one bounded wait act (not recorded as a step) so the verification observation reads settled DOM instead of a mid-navigation frame.
4. **Blank-page wait emit** — when an observation has zero elements and no body text, the planner emits a single `wait` (800 ms, history-guarded) before the scroll/blocked tail, so late-loading pages no longer terminate as "blocked" or trigger actions on stale state.
5. **New loop controls passed through the tool** — `maxScrolls` (scroll budget while hunting for elements, default 4), `settleMs`, and `expectText` (a literal string that must appear on the final page before any goal-reached is claimed; enforced on the already-at path, planner-done path, and post-act verification — otherwise the run finishes step-cap/blocked instead of a false success).

## Tests

`src/tools/__tests__/browserOperator.test.ts` grew from 13 to 24 tests, all passing, including a `ScriptedSurface` fake whose waits do not advance the page by default (models real settle behavior). Tests cover: ops capture from the table format, select intent parsing with field qualifier, the native-select happy path with value verification, ops-gated select/type skipping, click fallback for select goals, the name-vs-value pre-satisfaction regression guard, settle wait ordering, late-loading wait-then-continue, scroll budget exhaustion, and expectText blocking a premature success. One pre-existing expectation was updated honestly: an empty page now waits once before "blocked".

## Not touched (verified)

Protected files untouched (`src/setup/runtime.ts`, `src/server/companionGateway.ts`, companion/service tools, `scripts/stt_server.py`, protected docs). No edits to browser.ts or src/index.ts (registry wiring pre-existed). No `git reset --hard`; no pushes; nothing outside this worktree.
