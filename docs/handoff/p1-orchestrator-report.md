# P1 — Evidence-gated pentest orchestrator

Branch: `mf/p1` · Commit: `b819aa6`

## What was built

`src/security/orchestrator.ts` — a clean-room TypeScript multi-agent loop for the
existing pentest tooling. It orchestrates three pure phases over an injected
runner and applies a structural evidence gate before anything is reported:

1. **recon** (`reconAgent`) — drives the existing `runPentestCheck` calls through
   the injected runner and captures the request/response evidence those checks
   already produce.
2. **hypothesis** (`hypothesisAgent`) — derives falsifiable hypotheses from recon
   observations, each carrying a concrete proof-of-concept probe (method, URL,
   headers, and what success would demonstrate).
3. **validate** (`validateAgent`) — attempts each PoC and records either a
   confirmed observation or a refuted/inconclusive result with its evidence.

`evaluateEvidenceGate` is the single gate. A claim is reported only when it is
non-empty, `status === "confirmed"`, has at least one structurally valid evidence
item, and at least one item actually demonstrates the claim (a captured response
body or an explicit PoC observation). Everything else is returned in `unverified`
with the gate reason — never as an exploit.

## Files

- `src/security/orchestrator.ts` (new)
- `src/security/__tests__/orchestrator.test.ts` (new, 13 tests)

No shared files, routes, tools, package files or do-not-touch files were modified.

## Public API

```ts
orchestrate(opts: {
  target: string;          // loopback HTTP(S) only
  checks?: string[];       // defaults to all PENTEST_CHECKS
  runner?: PentestRunner;  // defaults to RecordingRunner
  maxHypotheses?: number;  // default 50
  signal?: AbortSignal;
}): Promise<OrchestratorResult>

interface OrchestratorResult {
  target: string;
  phases: { recon: number; hypothesis: number; validate: number };
  observations: ReconObservation[];
  hypotheses: Hypothesis[];
  validations: ValidationOutcome[];
  findings: OrchestratedFinding[];   // gate-passing; the only reportable claims
  unverified: UnverifiedClaim[];     // gate-blocked, with reason
  evidence: Evidence[];
}
```

Key helpers: `assertLocalhost`, `isLocalhostTarget`, `evaluateEvidenceGate`,
`isValidEvidence`, `demonstratesClaim`, `RecordingRunner`, `reconAgent`,
`hypothesisAgent`, `validateAgent`.

`PentestRunner` is the injection seam:

```ts
interface PentestRunner {
  check(target: string, check: string, signal?: AbortSignal): Promise<PentestFinding[]>;
  probe(request: ProbeRequest, signal?: AbortSignal): Promise<HttpResult>;
  readonly evidence?: Evidence[];
}
```

`RecordingRunner` (default) is a thin recording wrapper around the shipped
`runPentestCheck` / `safeGet`; it adds no new network behaviour. Probes are
read-only GET/OPTIONS because that is what the existing bounded pentest
transport supports.

## Scope

Localhost only: `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`/`[::1]`,
`ip6-localhost`, over HTTP(S). Anything else throws `LocalhostScopeError` before
any phase runs.

## How to test

```bash
npx tsx --test src/security/__tests__/orchestrator.test.ts
npx tsc --noEmit
npx tsc --noEmit -p packages/web/tsconfig.json
```

The test uses a `MockRunner` (fixed recon findings + fixed probe responses), so
it needs no network. It covers the loopback boundary, all gate branches, and the
end-to-end loop including the critical "PoC does not reproduce → claim withheld"
case.

## Live use

There is no HTTP route or agent tool for this module (task scope is the module +
test only). To exercise it live, call `orchestrate({ target: "http://127.0.0.1:<port>" })`
from a script or a future route; the default `RecordingRunner` will drive the
real checks against the loopback target.

## Notes / left

- The referenced `docs/handoff/FRONTIER_GAP_PLAN.md` and
  `docs/handoff/ARTCRAFT_ANALYSIS.md` do not exist in this worktree; the module
  was implemented from the task's behavioral specification only.
- `tls_info` recon findings cannot be re-validated through the bounded
  request/response runner, so they are not promoted to confirmed findings; they
  remain visible as recon observations.
- No Rust/wasm toolchain is used or required.
