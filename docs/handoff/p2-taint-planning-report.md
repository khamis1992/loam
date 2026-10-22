# P2 — Source-to-sink taint wired to the planner

## Commit
- `b31e600` feat(security): source-to-sink taint planning hints

## Files
- `src/security/planning.ts` — extended (not replaced). The file already held the
  section-17 self-planning `buildPlan`; I kept it intact and added a clean-room
  taint model plus its wiring into the plan.
- `src/security/__tests__/planning-taint.test.ts` — new `node:test` unit test
  (4 cases).

## What was added
A pure TypeScript source-to-sink taint model over **caller-supplied structured
input** (no AST, no execution, no I/O):

- `makeGraph(spec)` — builds a normalized `TaintGraph` from `TaintGraphSpec`
  (`sources`, `sinks`, optional intermediate `nodes`, `edges`). Edges carry
  optional `sanitized` / `guarded` flags and a `label`.
- `analyzeTaint(graph)` — BFS from every source; propagates taint across edges;
  edges flagged `sanitized` or `guarded` stop propagation. Returns one
  `TaintFlow` per reached sink with the full hop chain (`path`, `hops`), plus
  counts (`sources`, `sinks`, `sinksReached`, `sanitizedEdges`, `guardedEdges`,
  `coverage`).
- `planTaintHints(graph, { maxHints? })` — emits **ranked** `PlannerHint[]`,
  one per tainted source→sink flow. Deterministic score = sink severity +
  source trust + shorter-path bonus; ties break on hops then target. Each hint
  carries `id`, `rank`, `score`, `engine`, `surface: "source"`, `sourceKind`,
  `sinkKind`, `source`, `target`, `path[]`, `hops`, `severity`, `confidence`,
  `rationale`, `operatorInput`, `execution: "none"`.
- `taintPlanSuggestions(hints)` — maps hints to the existing `PlanSuggestion`
  shape.
- `buildPlan` wiring: `PlanEvidence.taintHints?: PlannerHint[]` folds ranked
  hints into `CampaignPlan.suggestions` (prepended) and exposes them on the new
  `CampaignPlan.hints` field. Existing `buildPlan` behavior is unchanged when
  no hints are supplied.

Source kinds: `user_input | query | body | param | header | cookie | path | env | file`.
Sink kinds: `exec | query | fs | html | template | redirect | deserialize`.
Engine mapping: exec→`command`, query→`injection`, fs→`pathTraversal`,
html→`xssReflected`, template→`templateInjection`, redirect→`redirect`,
deserialize→`deserialization`.

NOTICE: the source→propagation→sink framing is a long-established public
technique (Shannon-style information-flow taint); the implementation here is
original and self-contained — no third-party engine, brand, or asset is used.

## New routes / tools
None. Per the task's "stay strictly in your file scope" rule, no HTTP routes or
agent tools were added; the hints are consumed in-process by the pentest
planner via `buildPlan`.

## How to test live
```powershell
npx tsc --noEmit
npx tsc --noEmit -p packages/web/tsconfig.json
npx tsx --test --test-force-exit src/security/__tests__/planning-taint.test.ts
npx tsx src/scripts/check-security-planning.ts
```
The unit test covers: a known `user_input → lookupUser → db.query` path is
flagged with the correct hop chain; sanitized and guarded branches are cut; an
`exec` sink outranks a `query` sink; all-sanitized/all-guarded graphs produce no
sink; multiple sources to one sink keep the shortest/highest-trust path; and
hints flow through `buildPlan`.

## Verification results
- `npx tsc --noEmit` → 0 errors
- `npx tsc --noEmit -p packages/web/tsconfig.json` → 0 errors
- `npx tsx --test --test-force-exit src/security/__tests__/planning-taint.test.ts`
  → 4/4 pass
- `npx tsx src/scripts/check-security-planning.ts` → PASS
- `npx tsx src/scripts/check-security-flows.ts` / `-flow-guards.ts` /
  `-flow-link.ts` → PASS
- `npm run build` in `packages/web` → fails with the known Turbopack
  `Could not find the Next.js package (next/package.json)` junction error
  (documented as expected in this worktree; web tsc is the relied-on gate).

## What's left
- No producer of `TaintGraphSpec` from the workspace scan exists yet; the model
  is deliberately pure over structured input. A future task can build the graph
  from `scanWorkspaceRoutesAndRisks` / `traceSourceFlows` and pass the hints into
  `buildPlan` (e.g. from `assessments.ts`), which is out of this file's scope.
- Hints are advisory (`execution: "none"`); the orchestrator must still declare
  the engine case before any dynamic check runs.
