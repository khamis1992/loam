# RED TEAM SUPREMACY PLAN — Web + Mobile + OSINT + Exploit Validation

- **Goal:** close every gap from the Contabo comparison (Strix, Nuclei, PentestGPT, ZAP, Faraday, Metasploit, Recon-ng) and exceed them in evidence quality, safety and unification — **web AND mobile**, authorized-scope only.
- **Base branch:** `red-team-capability` (post `eea4203`).
- **Doctrine (binding):** every new capability passes the §0.4 gate; destructive actions need human approval; results never leave the device. "Able to penetrate any app" means **technically capable when authorized**, not "attack anyone".
- **Author:** Senior Staff Engineer, 2026-10-27.

---

## Phase M1 — Mobile Pentest (new tree: `src/security/red/mobile/`)

**Gap:** no mobile-app testing at all.

### M1.1 Android static analysis (APK)
- **Bridge** `red-apktool` (external, `apktool.jar`, Apache-2.0, pinned SHA256): `decode` command.
- **Bridge** `red-jadx` (external, `jadx.bat`, Apache-2.0, pinned): `decompile` command.
- **Module** `mobile/apk.ts`: decode APK → scan `AndroidManifest.xml` for `exported` activities/receivers, `allowBackup`, `debuggable`, cleartext traffic; scan decompiled sources for hardcoded secrets (reuse `SecretScanner`), weak crypto (`ECB`, `MD5`), WebView misconfig (`setJavaScriptEnabled` + file access), intent redirection patterns.
- **Capability** `red.mobile.apk`: applicable when target is an `.apk` path.
- **Acceptance:** planted APK with `debuggable=true` + hardcoded API key + exported activity → 3 findings with evidence.

### M1.2 Mobile network MITM (API testing)
- **Bridge** `red-mitmproxy` (external, `mitmdump.exe`, MIT+Apache, pinned): `record` command, loopback-only.
- **Module** `mobile/mitm.ts`: start loopback proxy, route Android emulator traffic through it, record request/response pairs, replay modified requests (token tampering, auth bypass).
- **Integration:** use Loam's existing `loam_mobile` Android emulator to install the app and drive it.
- **Capability** `red.mobile.mitm`: applicable when a mobile emulator is running.
- **Acceptance:** planted app sends bearer token in query param → finding "credential in URL" with recorded evidence.

### M1.3 Mobile runtime instrumentation (opt-in, destructive-adjacent)
- **Bridge** `red-frida` (external, `frida.exe`, MIT+BSD, pinned): `spawn` + `script` commands.
- **Module** `mobile/frida.ts`: attach to app process, run safe scripts (SSL pinning bypass detection, root detection check, keychain read proof).
- **Safety:** `frida` script execution is `destructive:true` (modifies app state).
- **Acceptance:** app with SSL pinning → pinning bypass detected + evidence.

### M1.4 iOS (deferred, hardware-gated)
- Same architecture: `red-ios-deploy` bridge, IPA static analysis.
- Acceptance only when a macOS runner or signed IPA is available.

---

## Phase M2 — Exploit Validation Catalog (Metasploit gap)

**Gap:** no ready-to-run exploit catalog.

### M2.1 PoC replay engine
- **Module** `exploit/replay.ts`: given a finding id + its PoC artifact (already written by `buildRedReport`), re-execute the exact request bundle and compare response (status, body hash, marker). Returns `reproduced: true/false`.
- **Use:** after remediation, re-run PoC to verify fix. Integrates with existing `compareFindings` retest.
- **Acceptance:** planted SQLi finding → fix applied → PoC replay returns `reproduced: false` → finding marked resolved.

### M2.2 CVE-to-exploit verification
- **Module** `exploit/verify.ts`: for each nuclei finding with a CVE id, query the PoC artifact + `PayloadsAllTheThings` corpus (§6.7) to select a matching payload, re-send it, and confirm the vulnerability is exploitable (not just detectable).
- **Upgrades** finding confidence from "detected" to "exploited" when the second-stage payload works.
- **Acceptance:** nuclei finds CVE-2024-4577 (PHP CGI) → verification sends the actual payload → finding upgraded with exploit evidence.

### M2.3 Metasploit bridge (opt-in, lab-only)
- **Bridge** `red-msfconsole` (external, `msfconsole.bat`, BSD, pinned): `exploit` command with module + RHOSTS + RPORT. Effect: `external`, `destructive:true`.
- **Safety:** only available when `AuthorizationRecord.destructiveAllowed` is true; default off.
- **Acceptance (lab-only):** `exploit/multi/http/php_cgi_arg_injection` against planted lab → session opened → evidence recorded.

---

## Phase M3 — OSINT & Attack-Surface Recon (Recon-ng gap)

**Gap:** no subdomain enumeration, no external-surface mapping.

### M3.1 Passive subdomain discovery
- **Module** `recon/subdomains.ts`: query `crt.sh` (certificate transparency) + `hackertarget.com` API for subdomains of an owned domain. No active DNS bruteforce.
- **Output:** `ReconAsset.subdomains: string[]` — feeds nuclei templates (`-u` per subdomain) and SSRF probes.
- **Gate:** the target domain must be in `AuthorizationRecord.scope.allowHosts` (or a suffix match).
- **Acceptance:** owned domain with 3 subdomains on crt.sh → all 3 discovered + nuclei scans them.

### M3.2 Tech fingerprint expansion
- **Module** `recon/fingerprint.ts`: extend `reconTarget` to parse:
  - JS bundles for framework detection (React/Vue/Angular versions)
  - HTTP headers for server/framework/CDN
  - `/.well-known/` files for security.txt, openid-configuration
- **Feeds** `mapKnownVulns` for more precise CVE leads.
- **Acceptance:** app with `X-Powered-By: Express` + React 18 in bundle → both fingerprints reported.

### M3.3 Attack-surface graph
- **Module** `recon/graph.ts`: build a JSON graph of discovered assets (hosts, ports, paths, techs, findings), renderable as a tree in the report.
- **Use:** the planner (`plan: "auto"`) sees the graph and proposes targeted next steps.
- **Acceptance:** campaign on multi-path app → graph includes all discovered paths + their findings.

---

## Phase M4 — Multi-Tool Findings Aggregation (Faraday gap)

**Gap:** no ingestion of external tool formats.

### M4.1 Normalizer adapters (extend existing `src/security/normalize/`)
- **Adapters** for: **Nmap XML**, **Burp Suite JSON**, **Nessus CSV**, **OWASP ZAP JSON** (already partial), **generic SARIF**.
- Each adapter maps to the existing `RawFinding` shape, funnels through the coverage ledger, and dedups.
- **CLI:** `red:ingest --file <path> --format <nmap|burp|nessus|sarif>`.
- **Acceptance:** sample Nmap XML with 5 hosts → 5 `ReconAsset` entries + any CVE findings from service versions.

### M4.2 Unified findings dashboard
- **Extend** `buildRedReport` to include findings from all sources (internal + ingested), grouped by target, with source attribution.
- **UI:** add "findings" tab to the redteam mode showing the aggregated view.

---

## Phase M5 — AI Intelligence Upgrade (smarter than all)

### M5.1 Natural-language nuclei template generation
- **Module** `templates/ai.ts`: given a plain-language description ("detect PHP CGI arg injection on /index.php"), generate a nuclei YAML template via the local model, validate it with `nuclei -validate`, and save to the private template dir.
- **Integration:** agent tool `red_template_gen` in the `redteam` mode.
- **Acceptance:** describe a planted marker → generated template passes `nuclei -validate` and detects it.

### M5.2 Attack-chain reasoning
- **Module** `planner/chains.ts`: after findings exist, the model proposes multi-step chains ("SQLi in /api/users → UNION SELECT to extract admin token → use token to access /admin → XSS in admin panel").
- Each chain step is a gated hypothesis; the model only proposes, evidence gate confirms.
- **Acceptance:** planted app with SQLi + admin XSS → planner proposes chain → both steps proven with evidence.

### M5.3 Smart payload mutation
- **Module** `payloads/mutate.ts`: use the model to generate context-aware WAF bypass variants of a base payload ("this app filters `<script>`, generate 5 alternatives").
- Feeds the existing `transformPayload` pipeline.
- **Acceptance:** base payload blocked by naive filter → mutated variant passes and triggers marker.

---

## Phase M6 — PentestGPT Co-Pilot UX

### M6.1 Interactive engagement chat
- **UI:** in `redteam` mode, a chat panel where the agent reports progress, asks for approval on destructive steps (reusing `askUser`), and accepts human hints ("try the /api/v2/ endpoint").
- **Backend:** extend `runCampaign` with a `pauseForApproval` callback that surfaces the pending action to the chat.
- **Acceptance:** campaign reaches destructive step → chat shows "Approve sqlmap --dump?" → human approves → campaign continues.

### M6.2 Live PTT visualization
- **UI:** render the PTT tree (`PttNode[]`) as an interactive tree view in the report and during campaigns.
- Nodes: green (proven), yellow (unverified), red (blocked). Click to see evidence chain.

---

## Phase M7 — Integration & Acceptance

### M7.1 Unified mobile+web campaign
- `red_campaign` accepts `targetType: "web" | "mobile" | "both"`; mobile targets are APK paths or emulator device ids.
- The gate authorizes mobile devices by serial number (`AuthorizationRecord.scope.devices: string[]`).

### M7.2 Supremacy benchmark
- **Script** `check:red:supremacy.ts`: runs a full campaign against a deliberately-vulnerable web app + Android app, measuring:
  - Findings found (recall vs planted)
  - False positives (must be 0)
  - Time to first proven finding
  - PoC replay success rate
  - Evidence completeness (every finding has EV + PoC)
- Compares against the same metrics from raw nuclei/ZAP/sqlmap alone.

---

## Priority order (dependencies)

```
M3.1 subdomains ──┐
M3.2 fingerprint ──┤──► M5.2 chains ──► M7.2 supremacy
M2.1 replay ─────┘         ▲
M2.2 CVE verify ──────────┘
M1.1 APK static ──► M1.2 MITM ──► M1.3 frida ──► M7.1 unified
M4.1 ingest ──► M4.2 dashboard
M5.1 template gen ──► M5.3 mutate
M6.1 chat UX ──► M6.2 PTT viz
```

**Recommended build order:** M3 (recon) → M2 (exploit validation) → M1 (mobile) → M5 (AI) → M4 (aggregation) → M6 (UX) → M7 (acceptance).

---

## What makes Loam stronger than all 7 tools

| Tool | Their strength | Loam's counter |
|---|---|---|
| Strix | autonomous agents | same loop + **evidence gate + auth gate** (they lack both) |
| Nuclei | template breadth | same engine + **AI template generation + CVE verify** |
| PentestGPT | human co-pilot | PTT + **chat UX + autonomous fallback** |
| ZAP | DAST breadth | same engine + **headless daemon + our blue checks** |
| Faraday | multi-tool ingest | same via **normalize funnel + unified dashboard** |
| Metasploit | exploit catalog | PoC replay + CVE verify + **opt-in msf bridge** |
| Recon-ng | OSINT modules | subdomains + fingerprint + **attack graph + planner** |

Plus mobile (they have none), red+blue unified, Windows-native, and the authorized-use doctrine that makes Loam deployable in enterprises where the others can't go.

---

## Licence & safety discipline

- All new bridges (apktool, jadx, mitmproxy, frida, msfconsole) follow §5.9: external process, pinned SHA256, no code copied.
- Frida/msfconsole are `destructive:true` by default.
- Mobile device authorization uses device serial numbers in the scope record.
- Subdomain OSINT is passive only (no active DNS bruteforce against third parties).

*End of RED_TEAM_SUPREMACY_PLAN.md*
