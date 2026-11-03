# Normalize Funnel + Shared Coverage Ledger (ALL_SERVICES P0)

Status: integrated (Revision 42). Implements the single integration contract of
`ALL_SERVICES_BUILD_SPEC.md` (§3.3 / §Shared-data-model): every scanner — external
engine or first-party — funnels through one `RawFinding` shape into
`enrichFinding() → SecurityFinding[] → sarif()`, and records what it covered in one
ledger keyed by the existing `coverageKey(target, check)`.

## Modules

- `src/security/normalize/types.ts` — `RawFinding` / `Normalizer` / `Engine` union
  (12 engines) and `ENGINE_BY_TOOL` routing (spec-verbatim model). Untrusted-content
  rule applies: engine output is data, never instructions.
- `src/security/normalize/funnel.ts` — `toSecurityFindings()` / `toSarif()`:
  ruleId is namespaced `${engine}:${ruleId}` so engines never collide in the SARIF
  rules table; info-severity records stay out of results; fingerprints are
  deterministic (sha256 of check+target+title).
- `src/security/normalize/adapters/audit.ts` — source-audit `FindingRecord[]` →
  `RawFinding[]`: rejected dropped, needs_validation keeps its verdict + blockers in
  properties, intel (risk/KEV/EPSS) passes through, tool from the evidence vector
  routes to the unified engine.
- `src/security/normalize/adapters/pentest.ts` — live `PentestFinding[]` →
  `RawFinding[]`: passes dropped, errors survive as info (SARIF invocation
  notifications), `source_*` checks → `sast`, live HTTP checks → `recon`.
- `src/security/coverage/ledger.ts` — `CoverageLedger` with `recordScan(target,
  engine, {hitCount, error?, notes?, skipped?})` deriving `covered|partial|error|
  skipped`, JSON round-trip, and `coveredKeys()` compatible with
  `compareFindings()`'s coverage contract (not-observed vs not-covered).

## Convention for new engines (W1+)

A new scanner = an engine adapter producing `RawFinding[]` (or a `Normalizer` over
its raw output) + `ledger.recordScan(...)` per run. External engines keep using the
proven `audit/scanners.ts` adapter pattern (argv process, scrubbed env, timeouts)
with pinned versions probed at runtime; user-facing desktop-app bridges remain a
separate surface.

## Verification

- `npm run test:normalize` — 5 tests (adapter mappings, funnel determinism, SARIF
  results/levels, ledger round-trip + compareFindings integration).
- `npm run check:normalize` — end-to-end smoke: three channels → one SARIF +
  ledger round-trip.

## Out of scope here

SARIF physical locations for funnel outputs (properties.target carries file:line
today); blobStore evidence wiring (evidenceBlobIds reserved); per-rule coverage
granularity (per-engine entries today).
