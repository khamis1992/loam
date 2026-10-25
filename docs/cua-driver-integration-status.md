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

## Manual P4 checklist — EXECUTED 2026-10-25 (automated, live on this PC)

The Calculator scenario ran for real through the Loam wiring (pinned 0.38.0, standard
mode), staged with a foreground-probe watching `GetForegroundWindow()` after every
call:

| # | Item | Result |
|---|---|---|
| 1 | Driver path enabled (`config.json` mcpServers) while `computer_*`/Playwright untouched | **PASS** (all gates green; wiring live) |
| 2 | 6×7 computed in Calculator **via background element-token clicks** while the foreground stayed on the user's window the whole time | **PASS** — clicks `6 × 7 =` all `ok=true`, display reads **"Display is 42"**, foreground window id never changed across every click and a background `type_text` |
| 3 | Escalation discipline | **PASS by design** — background succeeded everywhere; one deliberate probe proved the driver *refuses* minimized windows (`refused (window_minimized)`) instead of silently escalating; foreground escalation stays behind the user-ask rule (OD-9) |
| 4 | `clipboard_read` attempt | **PASS** — rejected client-side by the Loam allowlist; audit shows `cua.driver.allowlist.reject` (79 entries total, 6 completed background clicks logged) |
| + | Structured verification | **BONUS PASS** — `verify_state` `[{"element":{"selector":{"role":"text","label_contains":"Display is 42"}}}]` → *satisfied after 2 sample(s) in 347 ms* |

Operator notes learned live (baked into the skill): element tokens are
`snapshot_id:row_index` from the markdown rows; the target window must be visible
(minimized = refused); `verify_state` element selectors accept `role`/`label_contains`
(+ `exists`/`value_equals`) — `id`/`name_contains` are rejected; background
`type_text` to an unfocused window can return ok without the text landing in the
edit control — always verify after typing. Test apps (Calculator/Notepad) were
closed after the run.

To re-run the scenario yourself: enable the server (block in `docs/cua-driver-pin.md`),
open Calculator plus any app you keep typing in, and ask: «شغّل الآلة الحاسبة في
الخلفية واحسب 6×7 دون سرقة تركيزي».

## Deliberate follow-ups

- GUI sandbox (Docker/QEMU guest) deferred until Docker Desktop is confirmed (OD-2).
- `bounded` permission mode + capability manifest for unattended runs (OD-4 later).
- Native grafts (token-like ids / verify helpers for `computer_*`) only after the
  driver proves itself in daily use (spec Phase P5).
