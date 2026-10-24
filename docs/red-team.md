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
| Engine bridges (disabled by default) | `src/bridges/red.ts` | §4.4 |
| Agent tools + mode | `src/tools/red.ts`, `redteam` in `src/modes/catalog.ts` | §4.5 |

## How to use

- **Agent tools**: `red_campaign` (target URL, optional `authzId`, profile) runs one gated campaign and writes `red/<campaignId>/{report.md, sarif.json, poc/*.json}` into the workspace. `red_report` re-opens a stored report. The `redteam` mode exposes them in the UI.
- **Default posture (O-1)**: without a signed authorization record only `http://127.0.0.1` targets are reachable, and destructive actions are denied. The zero-config lab is safe by construction.
- **Wider campaigns**: create an `AuthorizationRecord` (`createAuthorizationRecord` + `saveAuthorization` — persisted under `~/.loam/security/authz/`), then pass its id as `authzId`. Scope is allow-list only (exact hosts/CIDRs/ports/URL prefixes); the deny-list always wins.
- **Engines**: sqlmap/ZAP/ffuf/nuclei/ysoserial/caldera/freeway run through bridge manifests (`red-*`) — discovered on the machine, never bundled (O-3), enabled per-bridge in Settings › App bridges, and gated before every run. GPL engines (sqlmap) stay external processes; no upstream code is copied anywhere (§5.9).
- **Kill-switch**: `engageKillSwitch()` (plus the audit entry `killswitch_engaged`) blocks every new action and aborts campaigns.

## Verify

```powershell
npm run test:red     # unit + integration suite (offline, local servers only)
npm run check:red    # self-contained lab acceptance: planted SSRF found, PoC + SARIF written, negative safety tests
npm run typecheck
```

The lab acceptance script starts its own vulnerable localhost app — no third-party host is ever a target.
