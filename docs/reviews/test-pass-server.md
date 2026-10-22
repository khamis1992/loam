# Server-side test pass — branch `manus-parity`

- Worktree branch: `mf/testserver`
- Date: 2026-10-22
- Platform: Windows, Node v25.2.1, npm 11.6.2
- Scope: every root `package.json` script that is a test/check and runs offline,
  plus two new server unit-test files.

## Summary

| # | Command | Result | Notes |
|---|---------|--------|-------|
| 1 | `npm run test:electron` | PASS | 4/4 — in-app browser visibility state machine |
| 2 | `npm run test:pentest-bench` | PASS | 19/19 — fixture, mock layer, grading, offline e2e |
| 3 | `npm run check:encoding` | PASS (fixed) | was 5 issues; see Fix 1 |
| 4 | `npm run check:eval` | PASS | 18 checks + eval harness smoke |
| 5 | `npm run check:orchestrator` | PASS | 114/114 |
| 6 | `npm run check:recovery` | PASS | migration/backup/rollback/restart/crash + FIFO |
| 7 | `npm run check:modes` | PASS | seven fail-closed modes |
| 8 | `npm run check:loam-agents` | PASS | seven modes; unknown create/update rejected |
| 9 | `npm run check:studio` | PASS (fixed) | was `EADDRINUSE` + readiness probe; see Fix 3 |
| 10 | `npm run check:studio-export` | PASS | DOCX/PPTX/XLSX native export |
| 11 | `npm run check:mcp` | PASS | 278 tools; init/pagination/ping/routing/origin guard |
| 12 | `npm run check:selfimprove` | PASS (fixed) | was 4 failing checks; see Fix 2 |

No enumerated script needed live network or API keys. `check:mcp` starts the
bundled local MCP bridge over stdio/http on loopback only; no external sockets
are opened. Nothing was skipped.

New tests added (both run with `node --import tsx --test`):

- `src/server/__tests__/agentsPins.test.ts` — 9 tests for
  `POST /api/agents/:id/pin`, `POST /api/agents/reorder`,
  `POST /api/agents/:id/hide` over the real loopback server.
- `src/server/__tests__/settingsAutoApprove.test.ts` — 4 tests for the
  `autoApprove` round-trip and the resulting skill-write gate (audit F05).

## Failures found and fixes

### Fix 1 — `check:encoding` (5 issues)

Error excerpt:

```
encoding check: 5 issue(s)
  [bom] src/server/approvalRules.ts — UTF-8 BOM present
  [mojibake] src/server/http.ts — 4118 cp1252-mojibake sequence(s), arabic chars=0
  [bom] src/server/routes/workspaceSlides.ts — UTF-8 BOM present
  [bom] src/server/__tests__/workspaceSheet.test.ts — UTF-8 BOM present
  [bom] src/server/__tests__/workspaceSlides.test.ts — UTF-8 BOM present
```

Root cause: four files carried a UTF-8 BOM, and `src/server/http.ts` had its
Arabic strings double-encoded (UTF-8 read as cp1252, twice), leaving 0 real
Arabic characters.

Fix:

- Stripped the BOM from the four files.
- Reversed the cp1252 mojibake in `src/server/http.ts` back to real Arabic
  (`الوكيل غير موجود` etc.). The reversal is run-based and idempotent, and a
  verification script confirmed it changed only 110 lines, all containing
  non-ASCII, with no ASCII/code line touched and no line-count change.

Result: `encoding check: OK (no BOM, no mojibake, all JSON valid)`.

### Fix 2 — `check:selfimprove` (4 failing checks)

Error excerpt:

```
  FAIL  staged create reports staging
  FAIL  pending item recorded
  FAIL  not applied before approval
  FAIL  approve applies the write
self-improve loop: FAIL
```

Root cause (matches frontier audit **F05**): `updateSettings()` persisted
`autoApprove`, but `loadSettings()` never restored it, and `gateActive()`
returned `autoApprove === false`. A missing value therefore behaved as
auto-approve, so the write-approval gate never engaged.

Fix in `src/server/settings.ts`:

- `loadSettings()` now restores `autoApprove` when present.
- `gateActive()` now returns `autoApprove !== true`, i.e. the conservative
  default is "approval required" and only an explicit `true` applies directly.

Result: `self-improve loop: PASS` (11/11).

### Fix 3 — `check:studio` (environment/harness)

Error excerpt:

```
AssertionError [ERR_ASSERTION]: [WARN encoding check found 5 issue(s) ...]
[ERR  fatal: Error: listen EADDRINUSE: address already in use 127.0.0.1:8787]
    at <anonymous> (src/scripts/check-studio.ts:23:172)
```

Two harness defects (pre-existing; documented in `docs/handoff/o3-report.md` and
`docs/handoff/uo21-report.md`):

1. The child server requires the loopback install token; the script never sent
   one, so every `/api/*` probe returned 401.
2. The script let the protocol adapter default to port 8787, which collided with
   an unrelated running instance.

Fix in `src/scripts/check-studio.ts` (env only, no assertion weakened): the
spawned server now gets `LOAM_AUTH_DISABLED: 'true'` and a probed free
`AS_PROTOCOL_PORT`.

Result: `PASS studio HTTP isolation, mode guards, atomic CAS conflicts, ...`.

## Gates

Run from the worktree root:

- `npx tsc --noEmit` → 0 errors.
- `npm run build:server` → exit 0 (`dist/server.cjs` 18.3mb, pdf worker copied).
- `cd packages/web && npx tsc --noEmit` → 0 errors.
- `node --import tsx --test src/server/__tests__/agentsPins.test.ts` → 9/9 pass.
- `node --import tsx --test src/server/__tests__/settingsAutoApprove.test.ts` → 4/4 pass.
- Related server suites (`agentsPinning`, `skills`, `dataControls`, plus the two
  new files) → 26/26 pass.

No web (`packages/web`) source or test files were touched, so no `vitest` run was
required. The full Next.js web build was intentionally not run (supervisor runs
it at merge time).

## Environment notes

- A stale `node src/index.ts` process from the original checkout
  (`C:\Users\khamis\Desktop\manus-local`, PID 37388) was listening on 8787 during
  this pass. It is external to this worktree and was left untouched; Fix 3 makes
  `check:studio` independent of it.
- Protected files were not modified.
