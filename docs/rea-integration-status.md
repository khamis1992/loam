# REA → Loam integration — programme status

Branch label: **`rea-capability`** (points at the last rea commit). Spec of record:
`docs/senior-staff-engineer/specs/REA_INTO_LOAM_INTEGRATION.md` (+ appendix A1–A13).
Approved plan 2026-10-24. This file tracks landed vs pending work.

## Landed (commits on `red-team-capability`, labelled by `rea-capability`)

| Commit | Phase | What |
|---|---|---|
| `d9d8baa` | P0 | `src/tools/reaAllowlist.ts` — 13 verified engine-free tools (live `tools/list` against installed `rea-agents@6.7.0`, 207-tool catalogue), static 10-flag effects table, tier/annotation derivation, 200 KiB catalogue budget. `scripts/install-rea-agents.mjs` — registry-SRI-verified, `--ignore-scripts` install into `<DATA_DIR>/bin/rea-agents/6.7.0/` (+pin.json). `docs/rea-pin.md`. Spec copy + appendix. `check:rea-allowlist` + tests. |
| `a9ae963` | P3 | `src/security/reaEvidence.ts` — hybrid identity (EV#### + `ev_`+sha256 contentDigest over the semantic projection), import verification, bundle paths. **Verified live**: both records of a real `export_evidence_bundle` recompute to their declared ids (embedded golden fixture `src/security/__tests__/fixtures/rea-goldens.json`). `src/tools/reaAudit.ts` append-only JSONL audit (torn-line healing). `check:rea-evidence` + tests. |
| `87eac1c` + `ef2734f` | P4 | `check:security-asar` release gate: extracts the real 377 MB `app.asar` via `@electron/asar`, analyzes the first-party subtrees (`electron/`, `dist/`, `ui/`) on the pinned server, merges surfaces (deterministic digest), diffs vs committed `qa/asar-baseline.json`; warn by default, `LOAM_ASAR_AUDIT=fail` blocks. **Proven on the packaged 0.5.31 app** (desktop-ipc-api, loom-updates, 6 contextBridge keys, preload.cjs, 309 endpoints) and on planted-channel fixtures (WARN → fail-mode exit 1 → allowlist coverage PASS → restore PASS). |
| `2a0e01a` | P2 prep | `src/tools/reaBudget.ts` — §9 summary-first budget (soft 256 KiB, paging tools to 2 MiB, preview+next swap). Pure module; `mcp.ts` wires it in P2. |
| `e286533` | P1 prep | `skills/reverse-engineer/SKILL.md` — Arabic evidence-first rules (untrusted data, Observation/Inference/Unknown, no target execution, authorized use). |

Verification commands: `npm run check:rea-allowlist`, `npm run check:rea-evidence`,
`npm run check:security-asar`, `node --import tsx --test src/tools/__tests__/rea*.test.ts src/security/__tests__/rea*.test.ts`.

## Pending — shared-file work (P1 + P2), blocked by the concurrent session

A parallel ALL_SERVICES session (scanners + first-party `src/re` core + selfharden)
was actively editing the shared files while this programme ran. Everything above
landed as surgical commits that never touched their in-flight hunks. The remaining
work edits shared files and must resume once that session settles:

1. **P1 — the mode** (`src/modes/catalog.ts`): add the `reverse-engineer` mode
   («هندسة عكسية», per spec §5.1 with `hue2` + existing glyph; tools = READ + skill
   + artifact_publish + the 13 `mcp__rea__*` names + CONTROL; fields target/question;
   the three starters), remove the `"reverse-engineer": "build"` alias. Update pinned
   counts (`.mode-card` == 6 in `check-loam-ui.mjs` and `check-packaged-loam.mjs`) and
   regenerate affected visual baselines in the same commit.
2. **P2 — the wiring** (`src/tools/mcp.ts`, `src/tools/registry.ts`,
   `src/policy/riskTier.ts`, `src/agent/loop.ts`, `src/config.ts`,
   `config.example.json`): per-server `allowlist` field; filter `tools/list` +
   reject non-allowlisted `callTool`; `ToolResult.untrusted/contentDigest`;
   `applyReaBudget` replacing the 16k cut for `mcp__rea__*`; effects-derived tiers
   (11 read / 2 write-workspace); audit events on connect/call/disconnect; `rea`
   server entry in config example (lazy until mode active — fallback eager+filter,
   U3); `/api/modes` then exposes the mode and `check:modes`/`check:mcp` stay green.
3. **P5 sign-off**: revision paragraph in `docs/security-development-gates.md`,
   spec-deltas refresh, full DoD run (`npm run typecheck`, `npm run verify`,
   all `check:rea-*`, `check:loam-ui` + baselines, `verify:security` family).

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
