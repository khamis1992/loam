# Unified Scanner Services (ALL_SERVICES §5-§9)

Status: integrated (Revision 43). Implements the deterministic-scanner wave of
`ALL_SERVICES_BUILD_SPEC.md` as one surface: seven read-only tools in the Loam
Security mode, all funneling through the Revision-42 normalize contract.

## Tools (`src/tools/securityScanTools.ts`, registered in `src/setup/runtime.ts`)

| Tool | Capability | Base / graft |
|---|---|---|
| `secrets_scan` | §5 secrets + git history (existing `scanGitHistory`) | loam-secrets engine + new AI-platform rules (groq `gsk_`, openrouter `sk-or-`, huggingface `hf_`, discord webhook) and the prompt/skill/config-scoped `ai-config-bearer` rule (Prompt-Recon graft). Secret values never printed; live verification stays OFF by default (§23-2). |
| `sca_scan` | §6 dependency risk | loam-sca + OSV + KEV/EPSS composite risk (Revision 41). trivy/osv-scanner adapters remain in the audit pipeline. |
| `sbom_generate` | §6 SBOM | first-party CycloneDX 1.5 writer (`native/sca/sbom.ts`) over the shared inventory; round-trips with our own reader; order-independent digest. syft external adapter deferred (pin-only when needed). |
| `sast_scan` | §7 static analysis | first-party interprocedural taint pass wrapping the existing `source-flow` engine (`security/sast/scan.ts`: `taint-to-sql/html/command` with dataflow hops) + opengrep rule pack via the pinned adapter (non-deterministic → hints, not findings). Advisory-only `llmTriage` hook present, off by default. |
| `sast_diff` | §7 PR scoping (ccsr graft) | git `diff --name-only <range>` scopes taint + rule findings to changed files. |
| `config_scan` | §8 IaC + container | first-party Dockerfile roast (`security/config/dockerfile.ts`, 8 posture rules incl. pin-latest, secret-ENV, curl-pipe, root/healthcheck absence) + checkov adapter (added to `audit/scanners.ts` ADAPTERS, SARIF out, guarded on IaC file presence). kics cross-check stays behind a flag (§23-5). |
| `supplychain_scan` | §9 package trust | loam-pkg heuristics + capability-diff (`native/pkgintel/capdiff.ts`: new deps, changed ranges, install hooks, bin shims, native builds, repo moves). Dynamic sandbox analysis deferred (§23-1: no Docker assumed); scorecard adapter deferred with egress rationale. |

## Integration

- Mode: all seven tools added to the `security` (افحص) mode list in `src/modes/catalog.ts`; `check:modes` green.
- Funnel: every tool returns a bounded summary (counts + top-20) or the merged SARIF via
  `format: "sarif"`; coverage recorded per scan in the shared ledger; engine degradation
  (opengrep/checkov missing) surfaces as notes, never blocks.
- Untrusted-content: scanner output is data only; `summarizeFindings` never includes secret
  values (check-scanners asserts this).

## Verification

`npm run test:scanners` (11 tests: AI rules incl. path-filter negative, SBOM round-trip +
digest, taint fixture, dockerfile clean/dirty, capdiff, checkov guard) •
`npm run check:scanners` (6 end-to-end PASSes over a fixture project) •
regression: `test:audit` 133/133, `check:modes`, `check:audit` green.

## Deferred (documented)

Live secret verification (opt-in, egress-logged), dynamic package sandbox, scorecard
(network egress), kics cross-check flag, SARIF physical locations from funnel targets.
