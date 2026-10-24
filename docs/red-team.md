# Loam Red Team — Unified red-team capability

Built from `docs/senior-staff-engineer/specs/RED_TEAM_BUILD_SPEC.md` (the spec is the contract; §refs below point into it). Authorized-use doctrine: **these capabilities exist to test systems Khamis owns or is explicitly authorized to test, with code and results that never leave the device.** Unauthorized use is hard by construction, not merely discouraged.

## What it is

One integrated red capability — not 28 bolted-on tools — living under `src/security/red/`:

| Area | Files | Spec |
|---|---|---|
| Authorization gate (default-deny allow-list, expiry, deny-list, rate limits, kill-switch, destructive approval, localhost fallback) | `red/gate.ts` | §0.4 |
| Append-only audit log (redaction, copy-then-seal rotation) | `red/audit.ts` | §5.2 |
| Gated, budgeted red HTTP transport (POST-capable; blue stays GET-only) | `red/transport.ts` | §4.2 |
| Campaign orchestrator: PTT state, capability router, roles, blue fallback | `red/orchestrator/*` | §6.1 |
| Recon + fingerprint→CVE leads | `red/recon/recon.ts` | §6.2 |
| Web capabilities: SQLi (sqlmap), DAST (ZAP), fuzz (ffuf), templates (nuclei) | `red/web/*`, `red/templates.ts` | §6.3/§6.5/§6.6 |
| Payload corpus + transforms (clean-rebuilt, MIT attribution) | `red/payloads/payloads.ts` | §6.7 |
| SSRF modules, deserialization (ysoserial) | `red/ssrf.ts`, `red/deser.ts` | §6.4/§6.8 |
| Adversary simulation (caldera REST client) | `red/advsim/caldera.ts` | §6.9 |
| Lab callback listener (detection-only C2 stand-in) | `red/c2/labListener.ts` | §6.10 |
| WiFi audit with BSSID allow-list | `red/wifi/freeway.ts` | §6.11 |
| Tradecraft registry: concept + detection signatures | `red/techniques/index.ts` | §6.12 |
| Report bundle: SARIF + Markdown + per-finding PoC artifacts, retest, opt-in hardening tasks | `red/report.ts` | §6.13 |
| Model-driven planner (proposals stay evidence-gated) | `red/orchestrator/planner.ts` | §6.1 |
| Engine installer + installed-engine registry (SHA256-pinned downloads) | `src/scripts/red-install-engines.ts`, `red/engines.ts` | §5.8/O-3 |
| Engagement records with retest diffs | `src/scripts/red-engage.ts`, `docs/red-team-engagements/` | §6.13/§9 |
| Engine bridges (disabled by default) | `src/bridges/red.ts` | §4.4 |
| Agent tools + mode | `src/tools/red.ts`, `redteam` in `src/modes/catalog.ts` | §4.5 |

## How to use

- **Agent tools**: `red_campaign` (target URL, optional `authzId`, `plan: "auto"` for model-driven planning) runs one gated campaign and writes `red/<campaignId>/{report.md, sarif.json, poc/*.json}` into the workspace. `red_report` re-opens a stored report. The `redteam` mode exposes them in the UI.
- **Default posture (O-1)**: without a signed authorization record only `http://127.0.0.1` targets are reachable, and destructive actions are denied. The zero-config lab is safe by construction.
- **Wider campaigns**: create an `AuthorizationRecord` (`createAuthorizationRecord` + `saveAuthorization` — persisted under `~/.loam/security/authz/`), then pass its id as `authzId`. Scope is allow-list only (exact hosts/CIDRs/ports/URL prefixes); the deny-list always wins.
- **Engines (O-3, download-on-first-use)**: `npm run red:engines` installs nuclei, ffuf, ysoserial and sqlmap from their official releases into `~/.loam/tools/` with SHA256 recorded in `~/.loam/tools/engines.json`; bridges discover them there. ZAP stays optional (install separately and enable the `red-zap` bridge). GPL engines (sqlmap) stay external processes; no upstream code is copied anywhere (§5.9).
- **Engagements (documented record)**: `npm run red:engage -- --target http://127.0.0.1:3939 [--nuclei-tags cve] [--plan auto]` runs a real gated campaign with the installed engines, writes `docs/red-team-engagements/ENG-<stamp>/` (report + SARIF + PoC + `engagement.json`) and diffs against the previous engagement (`latest.json`, retest semantics). The first two runs against Loam's own server are committed as the opening record.
- **Model-driven planning**: `--plan auto` / `red_campaign {plan:"auto"}` — the local model proposes test claims (§6.1 PentestGPT graft); every proposal still passes capability validation and the evidence gate, so hallucinations land in `unverified`, never in findings.
- **Kill-switch**: `engageKillSwitch()` (plus the audit entry `killswitch_engaged`) blocks every new action and aborts in-flight requests and campaigns.

## Verify

```powershell
npm run red:engines    # install/update nuclei, ffuf, ysoserial, sqlmap (SHA256-pinned)
npm run test:red       # unit + integration suite (offline, local servers only)
npm run check:red      # self-contained lab acceptance: planted SSRF found, PoC + SARIF written, negative safety tests
npm run red:engage     # real gated engagement against an authorized own-systems target
npm run typecheck
```

The lab acceptance script starts its own vulnerable localhost app — no third-party host is ever a target.
