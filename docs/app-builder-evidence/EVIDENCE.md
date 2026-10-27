# App Builder integration — evidence summary (2026-10-27)

Raw `.log` files are gitignored on this machine; they live in this folder locally.
Extracted verbatim patches used to apply the spec: `extracted/service.patch`,
`extracted/check-swarm.patch`, `extracted/check-swarm-bench.patch`.

## Before (baseline, branch point 87a481c = red-team-capability)

| Check | Result |
|---|---|
| `npx tsc --noEmit -p .` | exit 0 |
| Unit set (§12.1 cmd 3) | 69 tests / 69 pass / 0 fail |
| `check-swarm` | exit 0, "Swarm checks passed" (process exit before the known post-pass hang) |
| `check-swarm-bench` | PASS, **41 model calls / 52 stages** |
| `check-swarm-{memory,security,isolation}` | PASS × 3 |
| `check-swarm-http` | FAIL (readiness waitFor timeout) — **pre-existing on this machine and on the spec box (U-12)**; server logs "Loam ready"; not part of D1–D10 |

## After (app-builder-capability, 4 commits 32f25b3..18759be)

| Gate | Result | Spec expectation |
|---|---|---|
| D1 tsc | exit 0 | exit 0 ✓ |
| D2 new unit tests | **49/49** (effort 7, taskGraph 8, spec 5, tdd 5, intake 6, visual 4, definitions 4, measure 5, cloudDeploy 5) | 49 ✓ |
| D3 existing set | **118/118, 0 fail** (Playwright browser installed here; spec box had 116/118) | 118 ✓ |
| D4 check-swarm | "Swarm checks passed", exit 0 | ✓ |
| D5 bench | PASS, 41/52 + `auto completed effort=solo model=1 (full pipeline: 10)` | exact ✓ |
| D6 lifecycle | PASS — scenarioA `solo→deploy→merge` 1 model call; scenarioB **16 model calls, 2 repairs, 21 checkpoints**, rollback branch `rollback/1cc908fd-architecture-1`, launch refused (no static output + confirm) | 16 calls ✓ |
| D6 repair-order | PASS — `repairs:1, implRuns:2, deploy@90` after impl@68 and delivery@88 | exact ✓ |
| D7 memory/security/isolation | PASS × 3 | ✓ |
| D8 compare dry-run | `PASS swarm compare (dry-run)` with the 7-task set (S1–S3/M1/M2→solo, M3→lite, L1→full) | ✓ |
| `npm run verify` (full, with the two new gates folded in) | **exit 0** | ✓ |

## Deviations from the spec run (all environmental)

1. Node v25.2.1 (spec box: Node 22.23.4).
2. Fresh worktree checkout under `core.autocrlf=true` CRLF-converted `resources/codegraph/requirements-0.9.95-mcp.txt`, failing its byte-pin in `check:codegraph`; fixed by byte-restoring the file from the main worktree (hash `9580d921…` matches the pin again). CI on Linux is unaffected.
3. `check-swarm-http` still fails on this machine for the pre-existing environmental reason above; HTTP route changes are covered by tsc + the lifecycle check driving the service directly (same position as the spec, §12.2).

## Not yet run (by design)

- **D9** — manual UI check in the app (selectors, four gate cards, no Sparkles icon).
- **D10** — live comparison (S1+M3+L1 × 3 arms × 3 rounds); spends real tokens, needs Khamis's approval (KD-8). Defaults until then: taskGraph/TDD/two-stage review OFF (KD-4), cloud launch OFF (KD-6), local-light OFF (KD-7).
