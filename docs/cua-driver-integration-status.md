# Cua Driver → Loam integration — programme status

Branch label: **`cua-capability`** (points at the last cua commit). Spec of record:
`docs/senior-staff-engineer/specs/CUA_INTO_LOAM_INTEGRATION.md` (+ appendix B1–B11).
Approved plan 2026-10-25. **All phases CP-1–CP3 landed.**

## Landed

| Commit | Phase | What |
|---|---|---|
| `acd0415` | CP-1 | Spec anchored into the repo with the deltas appendix (B1–B11; U1 resolved: asset sha256 recorded live from the GitHub API). |
| `11bb958` | CP0 | `src/tools/cuaDriverAllowlist.ts` — 14 contract tools, effects table verbatim from §7.4, tiers 7 read / 7 destructive, 200 KiB catalogue budget, 120 s state-tool timeouts. `src/tools/cuaDriverTypes.ts` (clean-room contract mirrors + element-token validator). `scripts/install-cua-driver.mjs` — detect official install → download pinned asset → **sha256 verified twice** (pin + release SHA256SUMS) → flatten → Unblock-File → Authenticode (Valid) → `--version` probe → pin.json. `docs/cua-driver-pin.md`. `check:cua-allowlist` + tests. **Live**: existing 0.17.0 detected; pin 0.38.0 installed; live `tools/list` = **63 tools**, all 14 present. |
| `18c2494` | CP1 | The wiring: mcp.ts cua guard (63→14 clamp, rejection, untrusted+digest, timeouts), riskTier 7/7 branch, agent-loop untrusted wrap, `config.example.json` entry (standard mode), `cuaAudit.ts` ids-only JSONL (typed text proven never to land), hostile-fixture test + `check:cua-mcp`. **Live proven**: 14/63 registered (49 dropped incl. kill_app/run_script/browser_*), clipboard_read rejected, real reads (1920×1080, 10 windows incl. Chrome/ZCode/ChatGPT, 352 B app list), 583 KB window snapshot with `s00000001:1` tokens, **verify_state satisfied in 2 samples** (`[{window:{exists:true}}]` array shape learned live). |
| `90c7097` | CP2 | `skills/desktop-driver/SKILL.md` (7 rules: tool priority, fresh-token loop, user-asked foreground escalation, verify_state array shape, untrusted GUI text, forbidden surfaces, authorized use) + the 14 first-class tools inside `automate` with the Arabic starter «شغّل في الخلفية». No new mode → curated UI pins untouched; `desktop-automation` alias resolves to the richer mode. |
| (this commit) | CP3 | THIRD_PARTY_NOTICES (Cua Driver MIT, invoked-not-bundled; FSL/AGPL exclusions), gates doc Revision 51, this status doc, full DoD, memory. |

Verification: `npm run check:cua-allowlist`, `npm run check:cua-mcp`,
`node --import tsx --test src/tools/__tests__/cua*.test.ts`, `npm run typecheck`,
`npm run check:modes`, `npm run check:mcp`, `npm run check:loam-ui`.

## Relationship to the rest of Loam (OD-1 dual path)

- `computer_*` / `screen_*` / Playwright `browser_*` remain the default path, untouched.
- cua-driver is opt-in: it activates only when the `mcpServers["cua-driver"]` entry
  exists in `config.json` (template in `config.example.json`; installer prints the
  ready-made block). All results untrusted; input tools never auto-approved.
- The first-party skill picks the right layer per task (web → Playwright; simple
  foreground RPA → `computer_*`; background/precision → driver).

## Manual P4 checklist for Khamis (interactive, on this PC)

1. Add the `cua-driver` block from `docs/cua-driver-pin.md` to `config.json` and launch Loam.
2. Ask: «شغّل الآلة الحاسبة في الخلفية واحسب 6×7 دون سرقة تركيزي» while typing in an editor — the driver should drive Calculator without raising it.
3. Verify a `background_unavailable` response surfaces as a user question before any foreground escalation (OD-9).
4. Ask the agent to read the clipboard — `clipboard_read` must be rejected and appear in `<DATA_DIR>/cua/audit.jsonl` as `cua.driver.allowlist.reject`.

## Deliberate follow-ups

- GUI sandbox (Docker/QEMU guest) deferred until Docker Desktop is confirmed (OD-2).
- `bounded` permission mode + capability manifest for unattended runs (OD-4 later).
- Native grafts (token-like ids / verify helpers for `computer_*`) only after the
  driver proves itself in daily use (spec Phase P5).
