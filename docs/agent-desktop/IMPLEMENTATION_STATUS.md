# agent-desktop integration — implementation status

Branch `cursor/agent-desktop-integration` off `origin/main` @ `e7f74d1` (0.5.39 line).
Plan: `الخدمات/IMPLEMENTATION_PROMPT.md` (agent-desktop v1.0.2 as Loam's primary computer-use backend, legacy as guarded fallback, token reduction, benchmark, Cua retirement).
All timestamps Asia/Riyadh (UTC+3). Window titles never appear in this file.

---

## 2026-11-01 — session start

- Discovery (§0.1): `git log --all --grep agent-desktop` empty, no `cursor/agent-desktop-integration` branch, no `IMPLEMENTATION_STATUS.md` anywhere → fresh start at P2. Nothing to resume.
- `origin/main` = `e7f74d1` (0.5.39 release: fictional tiers removed, native-protocol routing, dynamic session budget, adapter studio-pages fix).
- Worktree `C:\Users\khamis\Desktop\manus-agent-desktop` created on branch `cursor/agent-desktop-integration`; autocrlf=input LF rebuild applied (known repo gotcha: CRLF-smudged fresh checkouts break hash-pinned checks); `npm install` started.
- Next: P2 foundation — vendor script, adBinary/adTypes, config keys, packaging, notices, tests, draft PR.

## 2026-11-01 P2 — Foundation and binary packaging ✅

- Vendored binary: `node scripts/vendor-agent-desktop.mjs` downloaded the pinned release; `certutil` confirms exe sha256 `409e58cbdd6aed47e29771ffa60bc122a9843505a227af488cded85215943988` = pin; `agent-desktop.exe version` → `{"version":"2.5","ok":true,...,"version":"1.0.2"}`. LICENSE (generic Apache-2.0 text, no holder-specific line) + VERSION beside it; exe git-ignored, LICENSE/VERSION committed.
- `src/tools/desktop/adTypes.ts` (envelope 2.5 + snapshot types + ref regex + REF_ACTIONS), `adBinary.ts` (pin constants, adExePath via rootAsset/override, sha-verify with cache, resolveStateRoot → %APPDATA%\Loam\agent-desktop).
- Config §2.3: keys added as OPTIONAL in the type (10+ existing partial `computerUse` literals across tests/scripts would otherwise break; loadConfig normalisation always fills them at runtime — same pattern as the repo's other optional config keys); normalisation + clampInt added; defaults per plan.
- Packaging: electron-builder extraResources `resources/agent-desktop → app.asar.unpacked/resources/agent-desktop` (exe/LICENSE/VERSION); `vendor:agent-desktop` script chained into `vendor`; `test:desktop` script; THIRD_PARTY_NOTICES entry; docs/agent-desktop/README.md.
- Tests: `adBinary.test.ts` (missing/mismatch/override/memoise/adExePath/state-root) + `adConfig.test.ts` (defaults pin, explicit merge, invalid→defaults, numeric clamps) — 12/12.
- Gates: `npm run typecheck` green; `npm run test:desktop` 12/12; `npm run verify` EXIT 0. Packaged-path unit assert via adExePath(resourcesDir) test (full installer build deferred — known-slow on this machine, recorded here per plan).
- Next: P3 process client (adClient/backend/render + fake exe + unit tests).

## 2026-11-01 P3 — Process client ✅

- `adClient.ts`: runAd (argv-only spawn, envelope parse, 4MB stdout cap, timeout+abort that kill only our child, --force forbidden) + pure `buildAdArgv` (flag order) + exported SpawnFn seam for tests.
- `backend.ts`: DesktopBackend interface + notDelivered. `agentDesktopBackend.ts`: full implementation with ref validation before any spawn (STALE_REF recovery surfaced as needsFreshSnapshot).
- `render.ts`: B2 renderTree/renderSnapshot (maxLines cut + drill hint), renderError with the retry rule, renderDelta with ref-stripping (new refs kept on + lines).
- Fixture `fake-agent-desktop.mjs` (node child via process.execPath — no .cmd, no shell): ok/partial/no-disposition snapshots, all 16 error codes with correct dispositions, garbage, exit-2, 30s sleep, echo.
- Tests 34/34: envelope per code, retry=safe⇒not_delivered, exit-2 envelope, garbage→null, timeout/abort kill child only, nasty argv (quotes/&/|/%PATH%/newline/Arabic) one element each, buildAdArgv order, --force throws, backend mapping incl. delivered_unverified default + no-spawn on invalid refs, renderer exact shapes, delta unchanged/small/overflow.
- Deviation note: spawn seam is an injectable param (plan allowed exactly this instead of a .cmd shim). typecheck 0; test:desktop 34/34; verify EXIT 0. No change to computerUse.ts yet.
- Next: P4 backend swap + guard + facade.
