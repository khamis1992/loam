# Security release gate — revision 62

The second section-24 increment: a release gate that prevents quality regressions across the entire security platform.

## The gate

```
npm run verify:security
```

`src/scripts/verify-security.ts` enumerates every `check:security*` script **from package.json itself** and runs them sequentially via `npm run --silent`. Properties that make it a release gate rather than a convenience script:

- **Manifest-driven completeness** — gates join the chain automatically when added; a gate cannot silently drop out of the quality bar because someone forgot to append it to a hardcoded list. At the time of writing the chain is the **36 gates**: `check:security` through `check:security-benchmark` (all business-logic engines, all twelve dynamic vulnerability engines, source-flow/link/guards, the benchmark, plus the shared HTTP/campaign/browser/diagnostics/repairs/OSV/OpenAPI gates).
- **Runs everything, then fails** — a failing gate does not short-circuit the chain; every gate still executes so the summary names **all** regressions in one run, with each failed gate's stderr tail printed inline.
- **Exit code 1 on any regression** — suitable as a CI/release step: `RELEASE GATE PASSED: all N security gates green` or `RELEASE GATE FAILED: k/N gate(s) regressed` with the list.

## Evidence

The full chain was executed end-to-end on 2026-10-19 via `npm run verify:security`: **`RELEASE GATE PASSED: all 36 security gates green`** in a single sequential run (~6 minutes; the log shows per-gate PASS lines with timings, `[01/36] check:security` through `[36/36] check:security-xxe`). Re-run the command to reproduce.

## Honest limits

- The gate is strict: no retries or flake-quarantine. The known shared-worktree hazard (a concurrent session editing `ui/app.js`/`ui/security.html` can make the UI-launching `check:security-http` fail transiently while its edits are mid-save) can flake the chain **in this shared worktree only**; in a clean checkout or CI this does not occur. If it flakes, re-run that single gate in isolation to distinguish a UI race from a real regression before touching engine code.
- The chain covers the security platform's gates; it does not include the project-wide `typecheck` (whose pre-existing errors live in unrelated untracked worktree files) or the non-security studio gates — those remain under `npm run verify`.
- Runtime is the sum of all gates (tens of minutes, dominated by the six browser gates); intended for release/CI cadence, not per-commit.

Worktree-only; not yet in an installed release.
