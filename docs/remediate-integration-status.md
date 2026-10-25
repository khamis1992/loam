# Loam Remediate — programme status

Branch label: **`remediate-capability`**. Spec of record:
`docs/senior-staff-engineer/specs/REMEDIATE_INTO_LOAM_INTEGRATION.md` (+ appendix E1–E11).
Approved 2026-10-25.

## Landed (7 commits)

| Commit | Phase | What |
|---|---|---|
| `0eaeafe` | MP-1 | Spec anchored + deltas appendix (E1 reuses REA's live-proven canonicalJson/EV####; E2 audit-seed targets our real audit service behind a flag; E10 no-Docker primary confirmed live). |
| `c6e7e60` | MPA (A) | Full §7 type contract; 4 hash-gated advisory packs (node+electron enabled, php/gitlab disabled — OD-3); inventory detectors (node/php/gitlab/electron) + product-aware classify; 7 §8.0 fixtures as real git repos; **D-1 exact tables with ZERO writes**; electron = vendor_update_required with NO target (D-7 rule); anti-hallucination re-read drop (E8). check:remediate + 8 tests. |
| `9aee8df` | MPB (B) | No-guess target resolver: pack membership AND vendor-index evidence → verified / unverified(reason) / not_found; registry v2 manifest (digest); nodejs.org/php.net/packages.gitlab.com indices; EOL → not_found with the upgrade path; 6/6 stubbed tests. |
| `d19755a` | MPC (C) | Three hash-bound gates (scope planHash / commit diffHash+prBodyHash / PR owner+draft); edit engine preserves tag variants and refuses changed lines; run-store worktrees — the user tree provably stays clean; 5/5 tests. |
| `45576d3` | MPD+E+F | evaluateFixGate (ordered rules; no-Docker → patched_unverified with the recorded blocker); deterministic compareTestRuns; the §7.4 PR template (no model prose; `[unverified]` prefix); re-scan → fixed_pending_deploy / still_vulnerable; closure ONLY with matching deploy evidence (409 on mismatch); 11/11 tests. |
| `5c85441` | MPG (G) | 5 playbooks (umbrella Arabic-first + 4 ecosystems, MIT footer); **D-7 dogfood LIVE on Loam itself**: electron 44.7.2 → vendor_update_required, no bump proposed; THIRD_PARTY Cognition entry; skills test. |

**Suite: 36/36** (packs 5, inventory 3, resolve 6, gates 5, fixGate 5, pr 3, rescan 3, skills 2, orchestrator 3, rollup 1). `npm run typecheck` clean on all remediate files. Gates: `check:remediate`, `test:remediate*`.

## Linking increment (MPH-1..4, 2026-10-25 — Revision 53)

The four gaps below are now landed; the capability is wired end-to-end into the app:

| Commit | Phase | What |
|---|---|---|
| `6bcecf0` | MPH-1 | Orchestrator (`src/security/remediate/index.ts`): one persisted run inventory → GATE 1 (zero branches before it, D-2) → run-store worktree cut from the scanned repo (`repoDirs`, never cwd) → honest no-Docker fix gate → hash-bound GATE 2 with acceptUnverified → `[unverified]` commit on the remediate branch → owner-scoped GATE 3 → recordPr re-scan closure `fixed_pending_deploy` → discard/cancel. Windows-safe `slug()`; run dataDir threaded through every gate write. 3 lifecycle E2E tests over real fixture git repos. |
| `e3b31a4` | MPH-2 | `remediation_start/status/report/cancel` model tools (start/read only — no tool can approve a gate; local model refused); Security mode card + `skill_list/skill_view` + Arabic starter «أصلح ثغرة Node»; risk tiers (status/report read, start/cancel exec); missed gitlab playbook. |
| `71d1cc7` | MPH-3 | `/api/security/remediations*` under the assessments same-origin guard: list/get/approve-scope (work runs synchronously; nothing commits before GATE 2)/approve-commit/approve-pr (owner allowlist)/record-pr/discard/cancel/close/report. GET serves the exact review materials the hashes bind (`expectedPlanHash`; diff + PR body + hashes). `CreatePrInput/PrInfo.draft` (verified additive; both providers). Live-proven over HTTP on a fixture repo. |
| `435a572` | MPH-4 | Security-panel tab «الإصلاح المُتحقَّق» (E3): the three gates as review-then-tick forms («راجعت وأوافق» pattern) with hashes shown, explicit unverified-accept tick, owner-checked remote, PR recording that triggers the re-scan closure, and deploy-evidence close inputs. Deterministic markdown rollup (`report/rollup.ts` + `/report` + tests). electron-builder ships `security/advisories` read-only (E9). |

Live verification this round: `test:remediate` 36/36 · `check:remediate` PASS (D-1/D-7/anti-hallucination) · `check:modes` PASS · `check:encoding` PASS · full HTTP gate loop against a booted server (409 stale hash → approve → patched_unverified with the bump inside the run-store worktree, user tree clean → cancel) · scoped `typecheck` clean.

## Verification

```bash
npm run check:remediate
npm run test:remediate          # all 36
npm run typecheck
```

## Remaining external condition

- The Docker build/test runner path (fully designed in fixGate; runs behind `REMEDIATE_DOCKER=1` when Docker exists on this machine — E10). Until then the primary path is the honest `patched_unverified` verdict + `[unverified]` PR prefix + explicit accept tick.

## Dogfood finding (D-7, live)

Loam's own `electron ^44.7.2` resolves to **44.7.2**, which bundles Node **24.21.0** — below the fixed **24.22.1** (CVE-2026-111497). The correct output — produced live — is `vendor_update_required` with **no** version bump, because no Electron 44.x release bundles a fixed Node yet. Bumping to 44.9.3 (Node 24.22.0) would be a guessed fix and is refused.
