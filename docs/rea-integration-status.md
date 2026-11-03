# REA → Loam integration — programme status

Branch label: **`rea-capability`** (points at the last rea commit). Spec of record:
`docs/senior-staff-engineer/specs/REA_INTO_LOAM_INTEGRATION.md` (+ appendix A1–A13).
Approved plan 2026-10-24. **All phases P0–P5 landed** (completed 2026-10-25).

## Landed (commits on `red-team-capability`, labelled by `rea-capability`)

| Commit | Phase | What |
|---|---|---|
| `d9d8baa` | P0 | `src/tools/reaAllowlist.ts` — 13 verified engine-free tools (live `tools/list` against installed `rea-agents@6.7.0`, 207-tool catalogue), static 10-flag effects table, tier/annotation derivation, 200 KiB catalogue budget. `scripts/install-rea-agents.mjs` — registry-SRI-verified, `--ignore-scripts` install into `<DATA_DIR>/bin/rea-agents/6.7.0/` (+pin.json). `docs/rea-pin.md`. Spec copy + appendix. `check:rea-allowlist` + tests. |
| `a9ae963` | P3 | `src/security/reaEvidence.ts` — hybrid identity (EV#### + `ev_`+sha256 contentDigest over the semantic projection), import verification, bundle paths. **Verified live**: both records of a real `export_evidence_bundle` recompute to their declared ids (embedded golden fixture `src/security/__tests__/fixtures/rea-goldens.json`). `src/tools/reaAudit.ts` append-only JSONL audit (torn-line healing). `check:rea-evidence` + tests. |
| `87eac1c` + `ef2734f` | P4 | `check:security-asar` release gate: extracts the real 377 MB `app.asar` via `@electron/asar`, analyzes the first-party subtrees (`electron/`, `dist/`, `ui/`) on the pinned server, merges surfaces (deterministic digest), diffs vs committed `qa/asar-baseline.json`; warn by default, `LOAM_ASAR_AUDIT=fail` blocks. **Proven on the packaged 0.5.31 app** (desktop-ipc-api, loom-updates, 6 contextBridge keys, preload.cjs, 309 endpoints) and on planted-channel fixtures (WARN → fail-mode exit 1 → allowlist coverage PASS → restore PASS). |
| `2a0e01a` | P2 prep | `src/tools/reaBudget.ts` — §9 summary-first budget (soft 256 KiB, paging tools to 2 MiB, preview+next swap). Pure module; `mcp.ts` wires it in P2. |
| `e286533` | P1 prep | `skills/reverse-engineer/SKILL.md` — Arabic evidence-first rules (untrusted data, Observation/Inference/Unknown, no target execution, authorized use). |
| `adc497d` | P5 prep | `THIRD_PARTY_NOTICES` rea-agents MIT section (invoked, never vendored) + this status doc. |
| `d366a0d` | P1 prep2 | `src/modes/reverseEngineer.ts` — the complete mode object (Arabic-first, hue2, glyphs, 13 first-class `mcp__rea__` names derived from the allowlist, three starters) + shape tests. The future `catalog.ts` edit reduces to import + spread + alias removal. |
| `687d9b6` | **P1** | The mode is **live**: catalog imports `reverseEngineerMode` (10th mode), the `"reverse-engineer": "build"` alias is removed, `normalizeModeId` resolves the real mode. `check:modes` + `check:loam-ui` green (the 6-card home grid is curated and unaffected; `#homeModes` buttons include the new mode). |
| `59d8586` | **P2** | The wiring is **live**: `McpServerConfig.allowlist` filters `tools/list` inside Loam; the rea server is clamped to the 13 allowlisted tools and non-allowlisted `callTool`s are rejected client-side; every `mcp__rea__*` result carries `untrusted` + sha256 `contentDigest` (agent loop wraps it as UNTRUSTED EXTERNAL CONTENT); `applyReaBudget` replaces the generic 16k cut; risk tiers derive from the static effects table; `${DATA}` expansion + `rea` server entry in `config.example.json`; `check:rea-mcp` + integration test against a hostile 20-tool fixture. **Proven on the live pinned server: 13/207 tools register (194 dropped), rejection + untrusted + digest green.** |

Verification commands: `npm run check:rea-allowlist`, `npm run check:rea-evidence`,
`npm run check:security-asar`, `node --import tsx --test src/tools/__tests__/rea*.test.ts src/security/__tests__/rea*.test.ts`.

## Pending — shared-file work (P1 + P2), blocked by the concurrent session

**Resolved 2026-10-25:** the concurrent session's commits absorbed their pending
`catalog.ts`/`package.json` hunks, the shared files went clean, and P1 (`687d9b6`)
and P2 (`59d8586`) landed as direct edits — the surgical-blob protocol was used
only for `package.json` and the gates doc while they were hot. No further pending
integration work; remaining follow-ups are deliberate (below).

## Deliberate follow-ups (not blockers)

1. **Lazy connect (U3 fallback stands):** the `rea` server connects eagerly with
   `config.json` present; flip `LOAM_ASAR_AUDIT`-style laziness on mode activation
   only if the cold start ever matters.
2. **Expose `re_*` first-party tools inside the reverse-engineer mode** once the
   `src/re` workstream settles (appendix A12) — offline layer under the MCP layer.
3. **`verify:security` family wiring** must be restored by its owner (see findings);
   `check:security-asar` joins automatically the moment the `check:security*` npm
   lines return.
4. **Widen the allowlist** (e.g. native decompile tools) only by an explicit Khamis
   decision (D11).

## Findings surfaced to Khamis

- **`check:security*` npm lines are absent from package.json** (and there is no
  `verify:security` script line), while ~58 `src/scripts/check-security-*.ts` gates
  exist committed and `docs/security-release-gates.md` documents a 36-gate run on
  2026-10-19. `src/scripts/verify-security.ts` currently throws
  "No check:security* gates found in package.json". The family wiring must be
  restored (my `check:security-asar` joins it automatically the moment it is).
- **Coexistence (appendix A12):** the concurrent session's first-party
  `src/re` core (`re_analyze`/`re_decompile`/`re_rebuild_verify` in the build mode,
  `ev_`+32-hex evidence) is complementary: offline always-available layer under this
  programme's deep-analysis MCP layer. Namespaces stay distinct by construction
  (`src/security/reaEvidence.ts` rejects 32-hex ids). A follow-up may expose `re_*`
  tools inside the reverse-engineer mode.
