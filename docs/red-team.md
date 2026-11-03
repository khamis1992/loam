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

- **Agent tools**: `red_campaign` (target URL, optional `authzId`, `plan: "auto"` for model-driven planning) runs one gated campaign and writes `red/<campaignId>/{report.md, sarif.json, poc/*.json}` into the workspace. `red_report` re-opens a stored report. External bridge effects require a signed, scope-bound, one-time approval token keyed by `bridgeId:commandId`; boolean self-approval is not accepted.
- **Default posture (O-1)**: without a signed authorization record only `http://127.0.0.1` targets are reachable, and destructive actions require independent approval. Unsigned authorization files are rejected, including legacy files.
- **Wider campaigns**: create an `AuthorizationRecord` (`createAuthorizationRecord` + `saveAuthorization` — persisted under `~/.loam/security/authz/`), then pass its id as `authzId`. Scope is allow-list only (exact hosts/CIDRs/ports/URL prefixes); the deny-list always wins. Campaign credentials are bound to one exact origin.
- **Engines (O-3, download-on-first-use)**: `npm run red:engines` installs nuclei, ffuf, ysoserial, sqlmap and ZAP from their official releases into `~/.loam/tools/` with SHA256 **verified against trusted pins** in `~/.loam/tools/engines.json`; bridges discover them there.
- **Engagements (documented record)**: `npm run red:engage -- --target http://127.0.0.1:3939 [--nuclei-tags cve] [--plan auto]` runs a real gated campaign, writes `docs/red-team-engagements/ENG-<stamp>/`, and diffs against the previous engagement.
- **Model-driven planning**: `--plan auto` / `red_campaign {plan:"auto"}` — model proposals still require capability validation and the evidence gate.
- **ZAP (DAST)**: the supported headless path is ZAP daemon + REST API. Empty alerts never silently become findings.
- **Kill-switch**: the persistent shared state blocks every new action and aborts in-flight requests and campaigns. Enterprise reads/writes are tenant- and role-controlled.
- **Evidence integrity**: recursive redaction, streaming response caps, signed authorization records, HMAC-chained audit entries, and signed seal manifests. Coverage distinguishes covered, partial, error and skipped.

## Mobile and enterprise operations

- `mobile_engagement` and `/api/security/enterprise` manage hashed APK/IPA/AAB inventories, real MobSF upload/scan/report calls, reviewed MASVS coverage, independent QA, reports and critical/high retests. AAB requires a dedicated adapter; it is not silently treated as APK.
- MobSF uses `LOAM_MOBSF_URL` and `LOAM_MOBSF_API_KEY`; HTTPS is required outside a loopback lab. Missing or malformed reports are errors, never clean scans.
- Android execution is opt-in through the ADB worker with device serial, package allowlist and approval. iOS requires a trusted macOS provider and otherwise reports unavailable.
- Enterprise mode supports OIDC RS256 discovery/JWKS (`LOAM_OIDC_ISSUER`, `LOAM_OIDC_AUDIENCE`) or a signed SAML gateway identity (`LOAM_SAML_GATEWAY_KEY`). Local mode retains only the `local` tenant.
- Evidence encryption supports per-tenant KMS data keys (`LOAM_KMS_URL`, `LOAM_KMS_API_KEY`); enabled KMS encrypts mobile Markdown/SARIF at rest and decrypts only for authorized report reads. SIEM export (`LOAM_SIEM_ENDPOINT`, base64 `LOAM_SIEM_SIGNING_KEY`) reports delivered/outbox/failed and uses an encrypted outage outbox when KMS is enabled. The persistent queue supports leases/dead letters. Production activation requires real providers and live acceptance.
- `/api/security/mobile-scale` adds signed-digest device registration, isolated device leases and cleanup proof, encrypted evidence timelines, investigation, evidence-backed Attack Path, GET-only authorized replay, Jira/GitHub/Slack delivery and honest SLO reporting. Queue wait remains explicitly unmeasured until worker timestamps exist.
- The expanded MASVS catalog has 24 controls and 20 scenario definitions. Dynamic authorization requires an owner positive control and a private marker; 401/403 is not treated as a finding, while missing markers or controls stay inconclusive.
- `deploy/k8s/` provides non-root, read-only, resource-bounded, default-deny deployment templates. Image digests and provider DNS names are placeholders for the signed release and actual environment; these files are not a production deployment attestation. DR backups support signed manifests and AES-256-GCM content with hash-verified restore.
- `/api/security/advanced` adds unified web/mobile/API coverage, budgeted hypothesis ranking, GraphQL field authorization with owner controls, WebSocket handshake review, SPA/JavaScript review, signed scenario plugins, root-cause grouping and allowlisted mobile instrumentation. Static SPA indicators remain review items, not confirmed vulnerabilities.
- Instrumentation uses `LOAM_INSTRUMENTATION_URL` and `LOAM_INSTRUMENTATION_API_KEY`; only four registered Appium/Frida actions are accepted, with no shell or dynamic-code channel. Signed plugin registration requires base64 `LOAM_PLUGIN_SIGNING_KEY`; plugins are typed manifests and never execute through eval or dynamic import.
- `/api/security/catalog` persists a broad SQLite vulnerability knowledge base covering web, Android, iOS and reverse-engineering classes with CWE/OWASP references, prerequisites, validation keys and evidence requirements. It is not a claim to contain every CVE or to guarantee exploitation. `/plan` filters applicable classes by technology and signed scope and returns plan-only dynamic, static, reverse-engineering and retest stages; disabled/destructive actions stay blocked.
- `/api/security/next` adds versioned atomic tests, a hybrid CRS with independent validation/critic/repair verification, Agentic AI controls for prompt/tool/memory/RAG/approval/cost/audit, VEX and reachability-aware exposure scoring, SLSA-style signed reproducible provenance, CycloneDX 1.7 CBOM/PQC readiness, and REST/GraphQL/WebSocket/gRPC/HTTP2/HTTP3/WebTransport control comparison. `LOAM_PROVENANCE_KEY` is required for local signing; external Cosign verification is optional through `LOAM_COSIGN_VERIFY_URL`. PQC readiness and production Sigstore require actual provider validation.
- `/api/security/engines` exposes sanitized engine manifests and typed workers for JADX, AFL++ and Jazzer. Process execution requires signed scope, workspace confinement, pinned SHA256, license review and bounded execution. `LOAM_JADX_PATH`/`LOAM_JADX_SHA256`, `LOAM_AFL_PATH`/`LOAM_AFL_SHA256`, and `LOAM_JAZZER_PATH`/`LOAM_JAZZER_SHA256` are required for their respective adapters. Missing pins or binaries are `unavailable`, never clean scans. MobSF, ZAP, Nuclei and sqlmap continue through their existing bridges; there is no automatic download.

## Verify

```powershell
npm run red:engines    # install/update nuclei, ffuf, ysoserial, sqlmap, ZAP (SHA256-pinned)
npm run test:red       # unit + integration suite (offline, local servers only)
npm run check:red      # self-contained lab acceptance: planted SSRF found, PoC + SARIF written, negative safety tests
npm run check:red:capabilities  # six capabilities proven on a planted live lab with real engines
npm run check:red:kill-switch   # real HTTP engage/read/reset + cross-site denial
npm run red:engage     # real gated engagement against an authorized own-systems target
npm run typecheck
```

The lab acceptance script starts its own vulnerable localhost app — no third-party host is ever a target.
