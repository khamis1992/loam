# Implementation Plan — Loam Unified Red-Team Capability

> **STATUS: COMPLETE + WORLD-CLASS PLAN EXECUTED (2026-10-24).** All phases RP0–RP7 + integration are built (commits 75ebd8d..e540a8f on `red-team-capability`). The follow-up world-class plan is also executed: (1) engines installed end-to-end via `npm run red:engines` (nuclei v3.11.1, ffuf v2.3.0, ysoserial v0.0.6, sqlmap 1.10 — SHA256-pinned under ~/.loam/tools, discovered by bridges, ysoserial unblocked with JPMS --add-opens); (2) model-driven planner (`red/orchestrator/planner.ts`, `plan:"auto"`) with proposals still evidence-gated; (3) coverage: live CISA KEV escalation, CMS fingerprints (joomla/spring/…), authenticated campaigns (bearer/cookie through the red transport); (4) engagement records: two real gated engagements against Loam's own server (http://127.0.0.1:3939) committed under `docs/red-team-engagements/` — first proven finding (ffuf: 60 discoverable paths = weak SPA 404 handling), nuclei/sqlmap ran to honest refutations, retest diff verified ("0 new, 1 persistent"). Evidence: `npm run test:red` 87/87; `check:red` PASS; `check:modes`/`check:bridges` PASS; `tsc --noEmit` clean. Juice Shop was the intended range but Docker Hub/npm access denied it; the engagement ran against our own production server instead — squarely inside the authorized-own-systems doctrine.

- **Source spec:** `docs/senior-staff-engineer/specs/RED_TEAM_BUILD_SPEC.md` (the contract; §refs below point into it).
- **Repo state verified against:** branch `red-team-capability` (base `667834f`, includes the audit/native security work past `5227df4`).
- **Authorized-use frame (binding):** every target-touching action passes the §0.4 gate; default posture is localhost-only; all tests run offline against self-hosted lab fixtures; destructive actions require human approval. No third-party hosts, no internet egress in CI.
- **Reuse-first:** the existing `src/security/{orchestrator,scope,findings}.ts`, `src/bridges/*`, `src/subagent/*`, `src/modes/catalog.ts`, `src/tools/pentest.ts` are the substrate. Nothing existing is rewritten; all changes are additive or narrowly extended.

---

## 0. Verified reuse map (what exists, what we build)

| Existing (verified by reading the files) | Used by |
|---|---|
| `assertLocalhost`/`isLocalhostTarget`/`LocalhostScopeError`, `Evidence`, `nextEvidenceId`, `redactEvidenceHeaders`, `evaluateEvidenceGate`, `orchestrate`, `reconAgent`, `hypothesisAgent`, `validateAgent` (`src/security/orchestrator.ts`) | RP0 default posture, RP2 campaign loop, RP3 evidence |
| `CampaignScope`, `inScope`, `BudgetError`, `ScopeError`, `RequestEvidence` (`src/security/scope.ts`) | RP0 gate + RP2 red transport (extends; POST support added only in the red layer — blue `scopedTransport` stays GET-only) |
| `SecurityFinding`, `enrichFinding`, `compareFindings`, `sarif`, `coverageKey` (`src/security/findings.ts`) | RP2/RP5 findings + retest + SARIF |
| `runBridge(ctx, bridgeId, commandId, args)` → `BridgeEnvelope`, `parseManifest`, `loadManifests`, `discover`, `BUILTIN_MANIFESTS` (`src/bridges/*`) | RP1 red manifests; RP3 capability drivers |
| `LOAM_MODES` + `check-modes` validation (`src/modes/catalog.ts`, `src/scripts/check-modes.ts`) | RP2 `redteam` mode entry |
| tool registration surface (`pentestTools()` pattern, `src/setup/runtime.ts:100`) | final integration `redTools()` |
| `src/security/native/intel/kev.ts` (CISA KEV data) | RP3 `mapKnownVulns` |

**New tree (all of it):** `src/security/red/**` + `src/bridges/red.ts` + `src/tools/red.ts`.

---

## Phase RP0 — Gate / Audit / Kill-switch (foundation, everything depends on it)

### T0.1 `src/security/red/types.ts`
Shared types used by every red module:
```ts
export interface RedTarget { url: string; }                    // http(s) URL
export interface RedAction {
  capability: string;            // "red.sqli", "red.templates", ...
  verb: "read" | "write";        // write == destructive candidates
  destructive?: boolean;         // default false
  params?: Record<string, unknown>;
}
export interface GateDecision { allow: boolean; reason: string; authzId?: string; }
```
No test needed (pure types).

### T0.2 `src/security/red/gate.ts` — the §0.4 authorization gate
```ts
export interface AuthorizationScope {
  allowHosts: string[];        // exact hostnames/IPs/CIDRs (no wildcards)
  allowPorts: number[];
  allowUrlPrefixes: string[];  // exact origin or origin+path prefixes
  denyAlways: string[];        // hosts/CIDRs denied even if otherwise in scope
}
export interface AuthorizationLimits {
  maxReqPerSec: number; maxConcurrent: number; maxTotalRequests: number;
  destructiveAllowed: boolean; // default false
}
export interface AuthorizationRecord {
  id: string;                  // AUTHZ-0001
  owner: "khamis";
  scope: AuthorizationScope;
  authorization: { statement: string; acknowledgedAt: string; expiresAt: string };
  limits: AuthorizationLimits;
}
export interface GateState { killSwitch: boolean; }   // injectable for tests

export class RedGateError extends Error { decision: GateDecision }

// persistence (injectable root; default ~/.loam/security):
export function defaultDataRoot(): string;
export function saveAuthorization(rec: AuthorizationRecord, root?: string): void;   // writes <root>/authz/<id>.json, fails on duplicate id
export function loadAuthorization(id: string, root?: string): AuthorizationRecord | null;
export function listAuthorizations(root?: string): AuthorizationRecord[];

// matching:
export function targetInScope(scope: AuthorizationScope, target: string): boolean; // parses URL; host in allowHosts (exact or CIDR via ip-matching helper); port in allowPorts unless default; url startsWith any allowUrlPrefixes; NOT matching denyAlways (deny wins)
export function authorizationActive(authz: AuthorizationRecord, now?: Date): boolean; // exists && now <= expiresAt

// the gate (§0.4 pseudocode, made total):
export interface GateDeps {
  now?: () => Date;
  state?: GateState;                                  // kill-switch, shared
  limiter?: RateLimiter;                              // token bucket
  approval?: (action: RedAction, authz: AuthorizationRecord) => boolean; // human approval; DEFAULT: () => false
  requestCount?: () => number;                         // budget consumption so far (campaign-level)
}
export function gate(target: string, action: RedAction, authz: AuthorizationRecord | null, deps?: GateDeps): GateDecision;
```
Gate order (test each): (1) kill-switch engaged → deny `"kill-switch engaged"`; (2) `!authz` → **localhost fallback**: allow only when `isLocalhostTarget(target)` and action not destructive (reason `"localhost default posture"`), else deny `"no authorization record"`; (3) not `authorizationActive` → deny `"authorization expired"`; (4) deny-list match → deny `"target on deny-list"`; (5) `!targetInScope` → deny `"target outside authorization scope"`; (6) `action.destructive && !authz.limits.destructiveAllowed` → ask `deps.approval` (default false → deny `"destructive action requires approval"`); (7) rate limiter exceeded → deny `"rate limit exceeded"`; (8) budget `requestCount() >= maxTotalRequests` → deny `"request budget reached"`; else allow with `authzId`.
- Token-bucket `RateLimiter` class: `constructor(maxPerSec, maxConcurrent)`, `tryAcquire(): boolean` + `release()`.
- CIDR matching: small pure helper `cidrMatch(cidr, ip)` supporting IPv4 (IPv6 exact-match only) — no deps.
- Immutability: `saveAuthorization` refuses overwrite; records loaded read-only.

### T0.3 `src/security/red/audit.ts` — append-only JSONL
```ts
export interface AuditEntry {
  seq: number; at: string; authzId: string | null; capability: string;
  action: string; target: string; params: Record<string, unknown>;  // pre-redacted
  outcome: "allowed" | "denied" | "started" | "completed" | "failed" | "killswitch_engaged" | "destructive_approved";
  reason?: string; evidenceIds?: string[];
}
export function redactParams(params: Record<string, unknown>): Record<string, unknown>; // keys matching /cookie|authorization|bearer|token|secret|password/i -> "[REDACTED]"
export class RedAuditLog {
  constructor(root?: string);                    // <root>/audit/red-audit.jsonl
  append(entry: Omit<AuditEntry,"seq"|"at">): AuditEntry;  // assigns seq + ISO timestamp; appendFile; never truncates
  read(): AuditEntry[];                          // for tests + reports
  seal(): string;                                // rotation: copy to red-audit-<n>.jsonl then truncate ONLY the live file (spec §5.2 copy-then-seal)
}
```

**Tests (T0.4) `src/security/red/__tests__/gate.test.ts`, `audit.test.ts`** — node:test + assert/strict, temp dirs via `fs.mkdtempSync`:
- gate: each of the 8 deny reasons fires with a minimal setup; allow path works; localhost fallback allows `http://127.0.0.1:3000/x` with no authz and denies `http://192.168.1.5/` and destructive-on-localhost (destructive localhost without authz → denied since no approval source).
- CIDR: `10.0.0.0/24` matches `10.0.0.7`, not `10.0.1.7`.
- expiry: expired record denies; active allows.
- rate limiter: 10 acquires at once pass (maxReqPerSec=10), 11th fails until release.
- audit: entries append with growing seq; `redactParams` masks `cookie`/`Authorization`; file grows and is never rewritten (byte length only increases); seal produces archive + fresh live file.

---

## Phase RP1 — Red bridge manifests (external engines)

### T1.1 `src/bridges/red.ts`
`export const RED_MANIFESTS: unknown[]` with 7 manifests, each validated by `parseManifest` (schema §4.4: id/name/description/probe/commands; params typed; argv with `{placeholder}` + `{when,args}` groups; `timeoutSeconds` 1..900):

| id | probe names | commands (id / effect / key argv) |
|---|---|---|
| `red-ffuf` | `ffuf.exe` | `fuzz` / external / `-u {url} -w {wordlist} -t {threads} -mc 200,301,302,401,403 -of json -o {out}` + `when:rate → -rate {rate}`; params: url(string), wordlist(path read), threads(number default 10), rate(number), out(path **write**) |
| `red-nuclei` | `nuclei.exe` | `scan` / external / `-u {target} -severity {severity} -jsonl` + `when:rate → -rl {rate}`; params: target(string), severity(enum info..critical), rate(number) |
| `red-sqlmap` | `sqlmap.py`, `sqlmap.exe` | `test` / external / `-u {url} --batch --level {level} --technique BEUSTQ --output-dir {workdir}`; `dump` / external / adds `--dump` (destructive — only invoked after §5.6 approval); params: url(string), level(number 1..5), workdir(path write), data(string, when) |
| `red-zap` | `zap.bat`, `zap.sh` | `quickscan` / external / `-cmdline -quickurl {target} -quickout {out} -quickprogress`; params: target(string), out(path write) |
| `red-ysoserial` | `java.exe` | `gen` / exec_script / `-jar {jar} {gadget} {cmd}`; params: jar(path read), gadget(enum: CommonsCollections1, CommonsCollections6, Spring1, URLDNS), cmd(string) |
| `red-caldera` | `caldera.bat`, `caldera.exe` | `start` / external / `--lateral --fresh` (long-running service; optional) |
| `red-freeway` | `freeway.py`, `freeway.exe` | `scan` / external / `--scan {interface}`; `capture` / external / `--capture {bssid} --interface {interface}` (lab RF only) |

All commands `effect: "external"` except ysoserial `gen` (`exec_script`, local transform). Note in file header: red bridges ship **disabled by default** (bridges only run when `cfg.bridges.enabled[id]` — existing semantics, no code change needed).

### T1.2 wire into `src/bridges/registry.ts`
`loadManifests()` iterates `[...BUILTIN_MANIFESTS, ...RED_MANIFESTS]`. One-line change + import.

**Tests (T1.3) `src/bridges/__tests__/redBridges.test.ts`:** every RED manifest passes `parseManifest`; every command's `effect` is legal; `timeoutSeconds` within 1..900; sqlmap `test` argv contains no `--dump`/`--os-shell` (destructive only in the `dump` command); ids don't collide with builtins; `loadManifests()` length grows by 7 and `manifestLoadErrors()` stays empty.

---

## Phase RP2 — Red orchestrator, PTT, red transport, mode

### T2.1 `src/security/red/transport.ts` — gated, budgeted HTTP with body support
Blue `scopedTransport` is GET-only by design; red needs POST (payload delivery) without weakening blue:
```ts
export interface RedTransport { request(input, opts?: {method?, headers?, body?}): Promise<HttpResult & {bodySent?: string}>; }
export function redTransport(authz: AuthorizationRecord | null, deps: {
  signal?: AbortSignal; limiter?: RateLimiter; gateDeps?: GateDeps;
  evidence?: RedRequestEvidence[]; maxBodyBytes?: number; timeoutMs?: number;
}): RedTransport
```
Behavior: every request (a) runs `gate(input, {capability: action tag, verb: method==="GET"?"read":"write"}, authz)` — denied → throws `RedGateError`; (b) rate-limits + counts toward `maxTotalRequests`; (c) `fetch` with `redirect:"manual"`, records `RedRequestEvidence` (extends shape of `RequestEvidence` with `requestBody` redacted via secret redactor); (d) body capped (default 32 KiB, same as `safeGet`).

### T2.2 `src/security/red/orchestrator/ptt.ts` — Pentest Task Tree (PentestGPT graft)
```ts
export type PttStatus = "todo" | "doing" | "proven" | "unverified" | "blocked";
export interface PttNode { id: string; goal: string; status: PttStatus; children: PttNode[]; evidenceIds: string[]; note?: string; }
export function createPtt(goal: string, tasks: {goal: string}[]): PttNode;  // root + children
export function updateNode(root: PttNode, id: string, patch: Partial<Pick<PttNode,"status"|"evidenceIds"|"note">>): PttNode; // pure: returns new tree
export function flatten(root: PttNode): PttNode[];
```

### T2.3 `src/security/red/orchestrator/redOrchestrator.ts` — runCampaign (§4.2)
```ts
export interface RedCampaignInput { goal: string; authzId: string | null; targets: string[]; profile: "quick" | "campaign"; }
export interface RedCampaignResult {
  campaignId: string; authzId: string | null; findings: SecurityFinding[];
  unverified: UnverifiedClaim[]; evidence: Evidence[]; audit: AuditEntry[];
  ptt: PttNode; coverage: string[];  // coverageKey list (retest support)
}
export interface RedCapability {   // router contract (§6.x implement this)
  id: string;                              // "red.sqli" | "red.templates" | ...
  applicable(target: string, recon: RedReconAsset): boolean;
  hunt(task: RedTask, ctx: RedCapabilityContext): Promise<RedHypothesis[]>;
  validate(hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation>;
}
export interface RedCapabilityContext { authz: AuthorizationRecord | null; transport: RedTransport; bridge: BridgeCaller; audit: RedAuditLog; signal?: AbortSignal; }
export type BridgeCaller = (bridgeId: string, commandId: string, args: Record<string, unknown>) => Promise<BridgeEnvelope>;
```
`runCampaign(input, deps?)`:
1. load authz (null allowed → localhost posture);
2. build PTT from targets;
3. **recon** per target (T3.8 module — injectable for tests);
4. route to registered capabilities (`registerCapabilities([...])`, default set = RP3 modules);
5. each `hunt`/`validate` result goes through `evaluateEvidenceGate` (imported) — only gate-passing claims become `enrichFinding`-based findings with `check: "red_<capability>"`;
6. destructive sub-actions (e.g., sqlmap `dump`) call gate with `destructive:true` (approval default false);
7. every step appends audit; kill-switch aborts mid-loop (throws `RedGateError` after audit entry);
8. **localhost targets with no capabilities applicable** fall back to existing `orchestrate()` (blue loop) and map its findings/unverified into the red result — strix's "reuse, don't rebuild".

### T2.4 `src/modes/catalog.ts` — `redteam` mode (codex-redteam-mode absorb)
New entry appended to `LOAM_MODES`: `id: "redteam"`, `label: "Loam Red Team"`, `readOnly: false`, tools = security mode tools + `"red_campaign"`, `"red_report"`, panels `["files"]`, fields (target/authzId/profile) + starters in the existing bilingual style. check-modes validates against a registered registry — `red_campaign`/`red_report` must exist by then (final integration registers them; to keep RP2 green standalone, add the mode in the same task as the tools or list only existing tool names + the two new ones and land both before running check:modes — ordering handled in integration task T8).

**Tests (T2.5)** `src/security/red/__tests__/{transport,ptt,redOrchestrator}.test.ts`:
- transport: in-scope GET allowed + evidence recorded; POST allowed and gated `verb:"write"`; out-of-scope URL throws `RedGateError`; kill-switch aborts pending request; budget exhausted → BudgetError-equivalent gate deny; response body > cap truncates.
- ptt: create/update/flatten pure semantics.
- redOrchestrator: fake capability + fake bridge caller + local http server (node:http on 127.0.0.1, ephemeral port) planted with a missing-header finding → campaign produces ≥1 proven finding with EV-#### evidence and audit trail; unproven claim lands in `unverified` with gate reason; kill-switch mid-campaign aborts with audit entry; out-of-scope target in `targets` is denied + audited (negative test §9a).

---

## Phase RP3 — Web capabilities (the hands)

### T3.1 `src/security/red/recon/recon.ts`
```ts
export interface RedReconAsset { target: string; status?: number; title?: string; server?: string; poweredBy?: string; techFingerprint: string[]; webPaths: string[]; }
export interface CveLead { cveId: string; source: "kev" | "fingerprint"; reason: string; }
export async function reconTarget(target: string, ctx: RedCapabilityContext): Promise<RedReconAsset>;       // GET via red transport + fingerprint from headers/body
export function mapKnownVulns(asset: RedReconAsset): CveLead[];                                          // fingerprint -> static table + KEV lookup (import src/security/native/intel/kev.js if side-effect-free; else static table only)
```
Sn1per graft = staged ordering (`reconTarget` → capability routing), not its shell.

### T3.2 `src/security/red/web/sqli.ts`
`testSqli(target, ctx)`: gate → `bridge("red-sqlmap","test",{url, level:1, workdir})` → `parseSqlmap(text)` (`/is vulnerable/i`, injectable parameter names, back-end DBMS line) → on injectable, one `Evidence` (kind `"poc"`, `poc: "sqlmap -u <url> --level 1"`, `observed: parsed proof`) + `SecurityFinding` via `enrichFinding` with `check:"red_sqli"`, severity high, remediation text. `dumpSqli` variant passes `destructive:true` to gate. Fallback when bridge missing/envelope error: return `[]` with audit `failed` (never a finding without proof).

### T3.3 `src/security/red/web/dast.ts`
`runDast(target, ctx)`: gate → `bridge("red-zap","quickscan",{target, out})` → parse ZAP quickout XML/JSON alerts → map to findings `check:"red_zap_dast"`; dedupe by (alert name, target).

### T3.4 `src/security/red/web/fuzz.ts`
`fuzzContent(target, ctx, kind)`: gate → `bridge("red-ffuf","fuzz",{url: target+"/FUZZ"...})` with wordlist from payload corpus (T3.6 wordlist file) → parse ffuf JSON (`results[].input.FUZZ/status/length`) → `ReconAsset.webPaths` enrichment + low/info findings for exposed paths (`check:"red_fuzz_discovery"`).

### T3.5 `src/security/red/templates.ts`
`runTemplates(target, ctx, leads?)`: gate → `bridge("red-nuclei","scan",{target, severity:"medium"})` → parse `-jsonl` lines (`template-id`, `matched-at`, `severity`, `info`?) → findings `check:"red_nuclei_template"` each with PoC evidence (matched-at URL + template id). Template selection from `leads` is v2; v1 runs default template set.

### T3.6 `src/security/red/payloads/payloads.ts` + `data.ts`
```ts
export type VulnClass = "xss"|"sqli"|"ssrf"|"xxe"|"ssti"|"cmdi"|"lfi"|"redirect"|"deser"|"upload";
export interface Payload { id: string; class: VulnClass; template: string; tags: string[]; needsEncoding?: string[]; }
export function getPayloads(cls: VulnClass, ctx?: {tags?: string[]}): Payload[];
export function transformPayload(p: Payload, t: "url"|"html"|"base64"|"double"|"unicode"): string;
export function wordlist(name: "dirs" | "params" | "vhosts"): string[];   // for ffuf
```
`data.ts`: structured JSON-ish const — clean-rebuilt curated corpus (~10–15 payloads/class, attribution comment: inspired-by PayloadsAllTheThings, MIT). Transforms pure + tested. Small `dirs` wordlist (~60 common paths) for fuzz.

### T3.7 `src/security/red/ssrf.ts` + `src/security/red/deser.ts` (extend existing engines additively)
- ssrf: `ssrfModulePayloads(kind: "metadata"|"gopher"|"fileRead"|"dict"|"internalPortscan")` building values for a vulnerable param (cloud metadata 169.254.169.254 URLs, `file:///etc/hostname`, `gopher://` probes, `dict://`, internal port list). Delivery + proof via `ctx.transport` and response differential; findings `check:"red_ssrf_module"`. Existing `ssrf.ts` untouched.
- deser: `proveDeser(target, gadget, ctx)`: ysoserial bridge `gen` (URLDNS gadget default — benign DNS OOB; `cmd` execution only with `destructive:true`) → deliver serialized bytes via red transport POST (Content-Type per case) → proof via OOB callback to lab listener (RP6) or error/response differential. Findings `check:"red_deserialization"`.

**Tests (T3.8)** one test file per module under `src/security/red/__tests__/`: bridge caller is a stub returning fixture envelopes (sqlmap vulnerable output, zap XML, ffuf json, nuclei jsonl, ysoserial text); transport stubbed or local http server; every test asserts: gate called before bridge (spy), findings carry EV evidence + PoC, bridge failure → no finding (audit `failed`), destructive path denied without approval.

---

## Phase RP4 — `src/security/red/advsim/caldera.ts`
```ts
export interface AdversaryProfile { id: string; name: string; abilities: { attackId: string; name: string }[]; }
export interface AttckCoverage { operationId: string; executed: { attackId: string; name: string; result: string }[]; }
export async function listAdversaries(base: string, ctx: RedCapabilityContext): Promise<AdversaryProfile[]>;  // GET /api/adversaries (caldera REST, plugin)
export async function runOperation(base: string, profile: AdversaryProfile, labHosts: string[], ctx): Promise<AttckCoverage>; // POST /api/operations + poll /api/operations/<id> until finished
```
Gate: `base` must be localhost (caldera runs in lab). Tests mock fetch through a stubbed transport.

## Phase RP5 — `src/security/red/report.ts`
```ts
export interface RedReport { campaignId: string; authzId: string | null; findings: SecurityFinding[]; unverified: UnverifiedClaim[];
  poc: { findingId: string; artifactPath: string }[]; attckCoverage?: AttckCoverage; sarifPath: string; markdownPath: string; }
export function buildRedReport(result: RedCampaignResult, outDir: string): Promise<RedReport>;
```
Writes: `sarif.json` (reuse `sarif()`), `report.md` (per-finding title/severity/target/evidence chain/PoC steps/remediation + unverified section + campaign metadata), `poc/<findingId>.json` (exact request bundle: method/url/headers/body + response). Retest: `retestRed(baseline, current, covered)` = thin wrapper on `compareFindings`. Self-hardening hook (O-5): `openHardeningTasks?: boolean` param, default false — when true emits `hardening-tasks.json` (blue hand-off artifact).

## Phase RP6 — lab-only C2 listener + WiFi (feature-flagged, off by default)
### T6.1 `src/security/red/c2/labListener.ts`
```ts
export interface CallbackProof { at: string; remote: string; path: string; }
export async function awaitCallback(port: number, authzId: string | null, timeoutSec: number, signal?: AbortSignal): Promise<CallbackProof>;
```
`http.createServer` on 127.0.0.1, resolves on first request, closes server, audits `completed`. Used by deser OOB proof; no persistence, no implant.
### T6.2 `src/security/red/wifi/freeway.ts`
```ts
export interface WifiScope { authzId: string | null; allowBssids: string[]; }
export async function scanWifi(ctx, scope: WifiScope): Promise<{bssid: string; ssid: string; clients: string[]}[]>;
export async function captureHandshake(ctx, scope: WifiScope, bssid: string): Promise<{ok: boolean; detail: string}>;
```
BSSID allow-list enforced (out-of-list BSSID → gate-style deny + audit). Drives `red-freeway` bridge; hardware-dependent so tests stub the bridge.

## Phase RP7 — `src/security/red/techniques/` (concept + detection only)
`index.ts`: `TECHNIQUES: RedTechnique[]` — 4 records (FunctionStomping, Venom, MrKaplan, HashDump-BypassEDR) per spec §6.12 table: `{ id, name, attackId (ATT&CK), concept, detection: { surface, signature } }` — e.g. MrKaplan → log-integrity: Windows Security event 1102/104 clear + $SI/$FI timestamp anomaly. `listTechniques()`, `getTechnique(id)`. Plus `*.md` docs (architecture-level write-ups, no step-by-step weaponization vs third parties). Tests assert structure + no empty detection signatures.

---

## Final integration (T8)

### T8.1 `src/tools/red.ts` + registration
`redTools(): Tool[]`:
- `red_campaign` — params: `target` (URL), `authzId?`, `profile?` (quick|campaign); runs `runCampaign` with a single target; returns findings count + JSON summary; refuses out-of-scope targets (gate inside).
- `red_report` — params: `campaignDir?`; builds report from the latest campaign result (module-level last-result store passed via context param).
Registered in `src/setup/runtime.ts:100` list (append `...redTools()`).

### T8.2 `src/modes/catalog.ts` — add `redteam` mode (tools: security tools + red_campaign + red_report).

### T8.3 `src/scripts/check-red-lab.ts` + package.json
Self-contained lab acceptance script (pattern of existing check-*.ts): starts a local vulnerable http server (planted: missing security headers + exposed `/.env` + echo endpoint), runs `runCampaign` against it, asserts: ≥1 proven finding with EV evidence + PoC; gate denies out-of-scope host; destructive denied without approval; kill-switch aborts; prints PASS/FAIL. package.json scripts: `"test:red": "node --import tsx --test src/security/red/__tests__/*.test.ts src/security/red/**/__tests__/*.test.ts"` and `"check:red": "tsx src/scripts/check-red-lab.ts"`. (Glob style matches existing scripts; if the nested glob is unsupported, enumerate files.)

### T8.4 docs `docs/red-team.md`
Usage + authorized-use doctrine + how to enable bridges (per-engine, Settings) + lab workflow.

---

## Execution order & gates
RP0 → RP1 → (RP2, RP3 after RP2 core) → RP3 → RP4/RP5 (parallel) → RP6/RP7 → T8 → quality gates.
Each phase: developer subagent (TDD: failing test first), then `npm run typecheck` + `npm run test:red` + relevant `test:bridges`/`check:modes`, then I review the diff before the next phase. Evidence for completion = fresh terminal output of those commands.

## Licence discipline (§5.9, binding)
No GPL/AGPL/NOASSERTION code copied. sqlmap/ZAP/nuclei/ffuf/ysoserial/caldera/freeway are external processes via bridges. strix loop, shannon gate idea, PTT, SSRFmap modules, PayloadsAllTheThings corpus = clean-rebuilt from documented behavior. Payloads data file carries an attribution comment (MIT).

## Out of scope (per spec defaults O-2/O-7)
Realm C2 implant (only labListener ships), WiFi hardware testing (bridge + allow-list only), bundled binaries (O-3: discovery-based, user installs engines), renderer UI panels.
