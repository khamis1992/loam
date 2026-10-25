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

**Suite: 32/32** (packs 5, inventory 3, resolve 6, gates 5, fixGate 5, pr 3, rescan 3, skills 2). `npm run typecheck` clean on all remediate files. Gates: `check:remediate`, `test:remediate*`.

## Verification

```bash
npm run check:remediate
npm run test:remediate          # all 32
npm run typecheck
```

## Not yet wired (deliberate, per plan scope)

- HTTP `/api/security/remediations*` endpoints + the Security-panel «الإصلاح المُتحقَّق» tab (spec §6.6) — the gates exist as callable functions with hash-bound tests; the HTTP/UI layer is the next increment.
- `remediation_*` tools in the Security mode card (§6.2) + the raw-upstream-skill guard (§6.7).
- The Docker build/test runner path (fully designed in fixGate; runs behind REMEDIATE_DOCKER=1 when Docker exists on this machine — E10).
- electron-builder packaging of `security/advisories/**` (E9).
- The orchestrator (`orchestrator.ts` §6.1) that strings inventory → gate → resolve → edit → fix-gate → PR → rescan into one run document via the store.

## Dogfood finding (D-7, live)

Loam's own `electron ^44.7.2` resolves to **44.7.2**, which bundles Node **24.21.0** — below the fixed **24.22.1** (CVE-2026-111497). The correct output — produced live — is `vendor_update_required` with **no** version bump, because no Electron 44.x release bundles a fixed Node yet. Bumping to 44.9.3 (Node 24.22.0) would be a guessed fix and is refused.
