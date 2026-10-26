# Telemetry, Skill Distillation and the Self-Hardening Loop (ALL_SERVICES §17-§18, P9)

Status: integrated (Revision 48); closing tranche (Revision 49) wires telemetry/distill into the tool runtime, adds contextPack-fed advisory LLM triage in sast_scan and a battery BenchScore in llm_scan.

## Scanner telemetry — `src/security/telemetry.ts`

`ScanTelemetry` (exported singleton `scanTelemetry`): one bounded ring (500 entries) of
scan invocations — duration, finding counts by severity, engine status/version,
budget hits (§4.5). `snapshot()` is the observability view: totals, 24h count, slowest
scans, budget-hit count, per-engine ok/degraded health. Pure data — rule ids and
counts only, never target content.

## Skill distillation — `src/security/selfharden.ts` (hivemind technique, rebuilt)

`distillSkill(trace)` summarizes a **successful** run (≥3 steps) into a deduped,
bounded candidate `SKILL.md` (frontmatter + numbered procedure). Status is always
`candidate`: activation requires the §9 supply-chain scan and operator review — the
doc itself states the gate. `toSkillDoc()` renders the candidate for persistence.

## The self-hardening loop (documented, bounded — nothing automatic)

```
llm_scan / mcp_scan / fuzz_run findings
  → lesson: distillSkill captures the probe/hunt that found it (candidate skill)
  → fix: aixcc_patch_propose / repairs surface drafts a proposal
  → operator reviews → applies → re-scan (compareFindings/coverage ledger closes the loop)
```

Every arrow that could change the system ends at the operator; the loop as shipped
discovers, records and proposes only.

## Verification

`src/security/__tests__/selfharden1.test.ts` — ring cap + snapshot health, distillation
gate (success-only, dedupe, candidate status, partial/short traces rejected).
