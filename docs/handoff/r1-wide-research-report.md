# R1 report — Wide/parallel research dispatcher + synthesis

Branch `mf/r1` (worktree `mf-wt/r1`, base `manus-parity` @ `cea1d0c`). Clean-room TypeScript implementation from the behavioural spec only — no Rust/wasm dependency, no ArtCraft brand names or assets, no third-party design copying (the only reference was the *behavioural idea* of a Manus-style wide research fan-out named in `FRONTIER_GAP_PLAN.md`; notice: any residual design inspiration is credited to that handoff document).

## Commits (pre-existing at base, verified in this session)

- `1156023` feat(tools): add wide_research parallel research dispatcher with merged, deduplicated report
- `681b7c8` feat(server): register wide_research and expose it as an always-on agent tool
- (this session) report commit only — no code changes were needed; see "What stays open".

## Files

- `src/tools/wideResearch.ts` — the tool. Core (planning, fan-out, citation extraction/dedup, merging) is model-free; the dispatcher (research child) and synthesizer (merge) are injected so it runs offline in tests.
- `src/tools/__tests__/wideResearch.test.ts` — 28 offline unit tests with a mock dispatcher/synthesizer (no model, no network).
- `src/index.ts` — one-line registration: `rt.registry.register(createWideResearchTool({ ollama: rt.ollama, parentRegistry: rt.registry }))`.
- `src/server/runTools.ts` — `wide_research` added to `ALWAYS_ON_TOOLS` (gateway allowlist merge keeps it visible to runs across all modes).
- `src/server/__tests__/runTools.test.ts` — exposure test asserting `wide_research` appears in the effective run tool list + model tool list for every mode, and that `agent.disabledTools` denial wins.

## Tool shape

`wide_research` — parameters (JSON schema):

- `query: string` (required) — the research question.
- `sources?: string[]` (optional, max 20) — seed URLs; each becomes its own sub-task.
- `breadth?: integer 1..20` (default 4) — number of parallel sub-tasks.

Result: `{ ok, content }` where `content` is the JSON report:

- `{ query, breadth, completed, failed, summary, findings[], sources[], tasks[], ok }`
- `findings[i]` = `{ taskId, index, angle, question, source?, summary, citations[] }` (successful children only, plan order)
- `sources` = deduplicated citations (tracking params/`www.`/fragment normalized away, case-insensitive, first-seen spelling kept, order preserved)
- `tasks[i]` = every planned sub-task with `ok` + `error?` — child failures stay visible, never collapse the report.

Behaviour notes: planning assigns one task per seed source, then fills the remaining budget with distinct research angles (overview, recent, evidence, alternatives, critique, practice, history, ecosystem; cycles with pass suffixes). Children run with bounded concurrency (≤20 workers), each child gets a fresh context and an intersected read-only allowlist (`requested ∩ registered ∩ run-allowed`) so `wide_research` can never widen the calling run's policy. The merge prefers a model-backed synthesizer (child of the parent agent loop, silent) and falls back to a deterministic model-free summary when unavailable/failing, which always carries the deduplicated source list.

## Verification (this session, worktree r1)

- `npx tsc --noEmit` (root/server): **0 errors**
- `npx tsc --noEmit -p packages/web/tsconfig.json`: **0 errors**
- `npx tsx --test src/tools/__tests__/wideResearch.test.ts`: **28/28 pass**
- `npx tsx --test src/server/__tests__/runTools.test.ts`: **14/14 pass**
- Full suites: `src/tools/__tests__/*` **49/49 pass**, `src/server/__tests__/*` **137/137 pass**
- `npm run build` in `packages/web`: fails with the **known** Turbopack "node_modules junction / workspace root" error (worktree junction `node_modules -> manus-local/node_modules`); per task instructions web `tsc --noEmit` is the accepted fallback and passes clean.

Note: the worktree directories are empty by default; this session created the `mf/r1` worktree from `manus-parity` and junctioned `node_modules` (root + `packages/web`) to the main clone for tooling.

## How to test live

1. Unit: `npx tsx --test src/tools/__tests__/wideResearch.test.ts src/server/__tests__/runTools.test.ts` (offline, deterministic).
2. Live run: start the server (`npm run dev`), open the Loam agents UI, give any agent a prompt like `wide_research: research "state of the art local vector databases" with breadth 5` — the model sees `wide_research` in its tool list on every mode; each sub-task start/finish is emitted as `wideResearchSubSessionStatus` tool events; the final `tool_result` carries the merged JSON report.
3. Denial check per agent: set `disabledTools: ["wide_research"]` on an agent — the tool disappears from that run (covered by the exposure test).

## What stays open (out of R1 scope, per the gap plan)

- Routing the wide-research report into Studio artifacts (deck/sheet/doc) — belongs to the Studio-routing task, not R1's file scope.
- Optional UI pane listing sub-session progress beyond the existing generic tool events (no shared-file edits were needed for R1; `AgentInfoPane.tsx` etc. untouched by design to ease parallel merges).
- HTTP routes: none needed — `wide_research` is an agent tool reached via the registry/gateway, so `src/server/http.ts` required no changes.