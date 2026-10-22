# ft1 — Source-to-sink taint wired to the agent planner (evidence-gated)

## Commit
- `a00f851` feat(security): evidence-gated FlowScan -> planner taint hints adapter

## Files
- `src/security/planning.ts` — scoped additive only. The pre-existing taint model
  (`makeGraph`, `analyzeTaint`, `planTaintHints`, `PlannerHint`, `TaintGraphSpec`)
  from the earlier P2 commit was kept intact; nothing was rewritten.
- `src/security/__tests__/planning-taint.test.ts` — new case added (5 total).

## The gap P2 left
`buildPlan` accepted an explicit `PlanEvidence.taintHints` array, but nothing
ever derived hints from a run's own evidence: `assessments.ts` calls
`buildPlan(run)` with no hints, so `run.flowScan` (the `traceSourceFlows`
cross-file taint scan) never reached the planner. The P2 handoff doc named this
producer as the remaining item.

## What this increment adds

1. `taintHintsSourceSpec(flowScan, maxFlows?)` — a thin adapter converting the
   scanner's reported `SourceFlow[]` into the compact `TaintGraphSpec` the taint
   model consumes: one source node (trust kind inferred from the origin
   description: cookie/header/body/query/param → else `user_input`), one sink
   node (`sql_like → query`, `command_like → exec`, `html_like → html`), plus
   optional intermediary hop nodes and connecting edges. Bounded to the first
   `FLOW_TAINT_MAX_FLOWS = 20` flows; duplicate source→sink pairs are skipped.
   It does NOT rerun or alter the scanner.
2. `flowScanTaintHints(flowScan, maxHints?, maxFlows?)` — evidence-gated
   wrapper: returns `[]` when the scan reported no flows or produced no edges;
   otherwise feeds the graph through the unchanged `planTaintHints` for
   deterministic ranking.
3. `buildPlan` wiring — one line changed: hints now come from
   `run.taintHints ?? (run.flowScan?.flows?.length ? flowScanTaintHints(run.flowScan) : [])`.
   Explicit caller-supplied hints keep precedence; a run with no flow evidence
   simply gets no taint suggestions, exactly as before.
4. Test coverage — the new case asserts: a `command_like` flow outranks an
   `sql_like` one, source trust inference (`req.body* → body`), full rationale
   carrying the origin `file:line`, `execution: "none"` preserved, both
   `maxHints` and `maxFlows` bounds honored, `buildPlan({ flowScan })`
   derives hints and marks the `source` surface present, and empty/absent
   `flowScan` yields zero hints (no taint surface at all).

## Verification results
- `npx tsc --noEmit` → 0 errors
- `npx tsc --noEmit -p packages/web/tsconfig.json` → 0 errors
- `npx tsx --test --test-force-exit src/security/__tests__/planning-taint.test.ts` → 5/5 pass
- `npx tsx src/scripts/check-security-planning.ts` → PASS (no auto-execution, no case created)

## Notes
- No changes to `source-flow.ts` (scanner untouched), no route/tool changes, no
  protected files modified. `assessments.ts` needed no edit: its existing
  `buildPlan(run)` call now automatically picks up `run.flowScan`.
- Hints remain advisory review candidates (`execution: "none"`) with bounded
  syntactic confidence; absence of flows proves nothing.
