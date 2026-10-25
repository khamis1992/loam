# Sandbox Runtime (ASRT / srt) → Loam focused integration spec

> **PROPOSAL AWAITING KHAMIS'S APPROVAL. NOTHING HERE IS CODED INTO LOAM OR QUEUED.**
> Study and writing only. No edits to `C:\Users\khamis\Desktop\manus-local`, no commits to `github.com/khamis1992/loam`, nothing in any scheduler.
>
> Prepared 2026-10-25, Asia/Riyadh (UTC+3 / بتوقيت قطر), on the analysis box under `/workspace/re/sandbox-runtime/`.
>
> **Loam baseline (OBSERVED):**
> - Box clone `/workspace/loam` at package `loam@0.5.3`, engines `node: >=22.13.0`.
> - Newer reference clone `/workspace/re/rea/loam-ref` (parent cites installed `0.5.31` on the PC at `5227df4`) — re-anchor line numbers on the working branch before coding. Paths cited below exist in at least one of these clones; prefer the PC working tree at implement time.
>
> **sandbox-runtime baseline (OBSERVED):**
> - Source clone `/workspace/re/sandbox-runtime-src` at commit `c66fb77b28fdbea8b9788aca72377238ae67ca20` (2026-10-23).
> - Published npm pin target: `@anthropic-ai/sandbox-runtime@0.0.81` (Apache-2.0, engines `node: >=22.12.0`).
> - npm tarball sha256: `0e0b8249062047f7b592c7995f8ec2f251f3bbebdc0402db1ee23af09983953f`
> - Vendored `srt-win.exe` x64 sha256: `a8e22bc098ac1146ec9b9151d5f1770c05b897cd1ac588161e1287a248cc9176` (4,020,736 bytes)
> - Vendored `srt-win.exe` arm64 sha256: `c7b204c8fab94059dbf7a6a805b844abad3deb82614e07e4b8d4b5bb5c4374f7` (3,598,336 bytes)
> - Reference bridge typechecked on the box under Node `v22.23.4`: `/workspace/re/sandbox-runtime/reference/loamSrtBridge.ts` (`tsc --noEmit` exit 0).
>
> **Companion docs (do not duplicate):**
> - `/workspace/re/rea/REA_INTO_LOAM_INTEGRATION.md` — house style (allowlist, effects, untrusted, phases, OD-#).
> - `/workspace/re/cua/INTEGRATION_SPEC.md` — heavy GUI / optional VM isolation. **Complementary** to this file (see §3.3).
> - `/workspace/re/TRIAGE_5REPOS.md` — ranked this repo HIGH; this document is the full enterprise follow-up.
> - `/workspace/re/browsentic/INTEGRATION_SPEC.md` / `/workspace/re/api-anything/INTEGRATION_SPEC.md` — browser/API stacks; srt wraps their *stdio MCP child processes*, it does not replace them.
> - `/workspace/re/loam-security-system/BUILD_SPEC.md` — evidence/scope doctrine; keep `assertLocalhost` / `evaluateEvidenceGate`.
>
> **Claim tags:** **OBSERVED** (file:line / checksum / command on the box), **INFERRED**, **UNKNOWN** (always paired with a Design decision or an Open decision for Khamis).
>
> **Brand / UI:** Arabic-first UI strings; brand «نتريو»; never use a Sparkles icon; use Loam's `<loam-icon>` set.

---

## Contents

0. Instructions for implementing agents + Definition of Done
1. Executive summary + selection decision table
2. What sandbox-runtime is (OBSERVED from source)
3. Capability map / overlap (Loam direct exec · swarm Docker · cua)
4. Windows-only reality check + validation checklist W1..W14
5. Integration approach (options + recommendation)
6. Security & trust integration
7. Exact wiring points in Loam
8. Data model / TypeScript interfaces (full)
9. Phased build plan + acceptance criteria
10. Open decisions OD-1..OD-N
11. Evidence log, UNKNOWNs, licence posture

---

## 0. Instructions for implementing agents + Definition of Done

### 0.1 Standing rules

1. **Approval first.** Do not open a feature branch, edit Loam, or queue an agent until Khamis approves this document (or an explicit subset of phases). The copy-ready prompts in §9 are for *after* approval.
2. **Git hygiene.** One branch per phase (`feat/srt-loam-<phase-id>`). Small commits. Never `git reset --hard`, never force-push, never touch `watchdog.ps1` or QA baselines owned by other agents.
3. **Loam conventions (OBSERVED `package.json`, `src/`):** ESM with `.js` import suffixes; 2-space indent; `node:` builtins; Node `>=22.13`; smoke checks as `src/scripts/check-*.ts` registered in `package.json`; unit tests beside code under `__tests__/`.
4. **UI language.** Arabic-first for every new user-visible string; English only where Loam already shows it. Brand «نتريو». No Sparkles icon. Prefer icons already in permission modes: `hand` / `shield-check` / `shield-alert` (OBSERVED `src/policy/permissionModes.ts`).
5. **Security defaults.** Sandbox is a *containment* upgrade, not a licence to widen blast radius. Keep `assertLocalhost` for pentest targets. Never log secrets (`src/log.ts` redacts). Every sandboxed exec writes an audit event (§6.4). Do **not** enable `network.allowLocalBinding` / `--allow-loopback` unless OD-5 says so.
6. **No floating dependency ranges.** Pin `@anthropic-ai/sandbox-runtime@0.0.81` exact + npm integrity + the two `srt-win.exe` sha256 values above. See §6.7 and the LiteLLM 1.107.0 lesson from REA.
7. **When this spec and Loam code disagree,** trust the code. Record the delta in the PR under "Spec deltas". Stop if a security property would change.
8. **Do not reimplement bubblewrap / Seatbelt / WFP.** Consume the library + bundled `srt-win.exe`. If a phase prompt asks for a clean-room Windows sandbox, refuse and cite §1.2 Skip list.
9. **Windows alpha honesty.** Ship the feature **disabled by default** (`mode: "off"`) until W1–W14 pass on Khamis's PC. Surface alpha caveats in the UI (Arabic).

### 0.2 Definition of Done (whole programme)

- Every phase in §9 is merged with its acceptance criteria green:
  - `npm run typecheck`
  - `npm run verify` (or the repo's equivalent verify script at merge time)
  - each new `npm run check:srt-*`
  - `npm run check:loam-ui` if UI strings/panels changed
- Optional **Command Sandbox** path is first-class and **opt-in**: settings key `sandbox.mode` ∈ `{off, untrusted_only, all_shell}`; default `off` until W-checklist green, then recommended `untrusted_only` (OD-1).
- Loam's existing `shell_*` tools keep their API; when sandbox is on, `shell_run` (and optionally MCP stdio children) execute inside ASRT. Persistent `shell_start` sessions stay **unsandboxed** in v1 (OD-6) or are refused when sandbox is on.
- One-time elevated `windows-install` is user-initiated from Loam UI (or documented PowerShell); Loam never silently elevates.
- No second copy of ASRT under a writable workspace `node_modules` (ASRT README warning: sandboxed process could rewrite it).
- Nothing in this programme writes to Khamis's Desktop checkout as part of automation.

### 0.3 Non-goals

- Replacing Loam's permission modes / `checkCommand` deny patterns (they stay as a first line of defence).
- Replacing cua-driver (GUI) or browsentic (logged-in browser) or api-anything (HTTP ops).
- Replacing swarm Docker isolation (`src/swarm/isolation.ts`) — complementary, heavier, optional.
- Shipping a Linux/macOS Loam build (Loam is Windows-only).
- Enabling Schannel-based tools *inside* the sandbox (impossible under write-restricted token — OBSERVED README Windows section).
- Closing the documented Windows residual escapes (anonymous-token / deny-only SID / system-service traffic) — document and treat as residual risk, do not claim "perfect isolation".
- Clean-room rewrite of `srt-win` Rust helper.

---

## 1. Executive summary + selection rationale

### 1.1 One-paragraph intent

**sandbox-runtime is useful — high leverage for Loam's agent safety on Windows.** Today Loam runs `shell_run` / persistent shells / stdio MCP servers **directly on the host** as the logged-in user (OBSERVED `src/tools/shell.ts` `spawn(command, { shell: true, env: { ...process.env } })`; OBSERVED `src/tools/mcp.ts` `StdioClientTransport`). Pattern denylists (`checkCommand`) and permission modes reduce risk but do not enforce OS isolation. Anthropic's ASRT (`srt`) wraps an arbitrary process tree with **filesystem + network OS isolation** without requiring Docker: on Windows (alpha) via a dedicated `srt-sandbox` local user, WFP egress fence, write-restricted token, and NTFS ACEs. The net-new value for Loam is: **agent-generated commands and untrusted MCP servers stop reading Khamis's SSH/cloud credentials and stop reaching the open internet unless Loam's policy allowlists them.** This complements — does not replace — cua (GUI automation) and swarm Docker (optional full containers).

### 1.2 Decision table — take vs skip

| ID | Capability | Value | Effort | Risk | Loam already has? | Decision |
|---|---|---|---|---|---|---|
| A | Pin `@anthropic-ai/sandbox-runtime@0.0.81` + wrap `shell_run` via `SandboxManager` | High | M | Med (Windows alpha; UAC install; supply-chain) | Direct host spawn only | **ADOPT** |
| B | Wrap **stdio MCP server** process launches with `srt` CLI (README MCP example) | High | M | Med (MCP needs network/fs holes per server) | `registerMcpTools` spawns unsandboxed | **ADOPT** for servers marked `sandbox: true` |
| C | Hybrid mode `untrusted_only` (default after validation) | High | S | Low | Permission modes exist; no OS sandbox | **ADOPT** (OD-1) |
| D | Adopt ASRT policy model natively without the runtime | Low–Med | L | High (reimplement WFP/ACLs) | Partial: `checkCommand`, path policy | **SKIP** as primary; keep Loam policies as L1 |
| E | Sandbox persistent `shell_start` / PTY sessions | Med | M–L | Med (long-lived token/ACEs; interactive) | `shell_start` + `pty` unsandboxed | **DEFER v1** (OD-6) |
| F | Sandbox Playwright / `computer_*` / Electron main | — | — | High (breaks product) | Core product surface | **SKIP** |
| G | Bundle `srt-win.exe` inside signed Loam installer | Med | M | Med (Admin install still required once) | electron-builder present | **ADOPT** pin under `%LOAM_DATA%\bin\srt\0.0.81\` (OD-3) |
| H | Machine-wide profile-read grant at install | Med UX / High privacy | S | High on shared PCs | — | **OD-4** — recommend `--skip-profile-grant` for Loam default |
| I | `network.allowLocalBinding` / `--allow-loopback` | Med for local servers | S | High (any localhost service reachable) | Dev servers common | **OD-5** — default **off** |
| J | TLS terminate + credential masking | Med | L | Med (MITM CA; Schannel gap) | — | **DEFER** after basic wrap works |
| K | Rewrite ASRT / fork `srt-win` | — | XL | High | — | **SKIP** |

### 1.3 Recommended defaults (preview of §10)

| OD | Question | Recommended default |
|---|---|---|
| OD-1 | Sandbox everything vs only untrusted? | **`untrusted_only`** after W-checklist; ship as `off` until then |
| OD-2 | Admin / UAC install posture | **User-initiated** from Settings → «عزل الأوامر»; never silent |
| OD-3 | Bundle vs external npm global | **Loam-managed pin** under data dir + `VENDORED_SRT_WIN_EXE` from that pin |
| OD-4 | Profile read grant | **`--skip-profile-grant`** for Loam install path; document grant as advanced |
| OD-5 | Loopback open? | **Off** (`allowLocalBinding: false`) |
| OD-6 | Persistent shells | **Refuse `shell_start` when sandbox mode ≠ off**, or keep unsandboxed with banner |
| OD-7 | Network ask callback vs strict allowlist | **`strictAllowlist: true`** + empty `allowedDomains` by default; grow via UI / per-task |
| OD-8 | Relation to swarm Docker | Keep both; srt = default host isolation; Docker = optional swarm verify |
| OD-9 | Relation to cua | Orthogonal: srt for process FS/net; cua for GUI. Never claim srt sandboxes mouse/keyboard |
| OD-10 | node-forge / zod audit findings on 0.0.81 | **Document residual**; re-pin when upstream fixes; do not ship silently |

---

## 2. What sandbox-runtime is (OBSERVED from source)

### 2.1 Identity

| Field | Value (OBSERVED) |
|---|---|
| Package | `@anthropic-ai/sandbox-runtime` |
| Version | `0.0.81` (`package.json`) |
| CLI bin | `srt` → `dist/cli.js` |
| Licence | **Apache-2.0** (`LICENSE`, `package.json` `"license": "Apache-2.0"`) |
| Author | Anthropic PBC |
| Engines | `node: >=22.12.0` |
| Maturity | README banner: **Beta Research Preview**; Windows section titled **Windows (alpha)** |
| Stack | TypeScript library + platform helpers; Windows helper is Rust (`vendor/srt-win-src`, `rust-toolchain.toml` channel `1.98.1`) |
| Dependencies (runtime) | `@pondwader/socks5-server`, `commander`, `node-forge`, `zod` |

### 2.2 Surfaces

1. **CLI (`srt`)** — wrap any command: `srt [--settings path] [--control-fd N] [--debug] -- <command…>`. Also: `srt windows-install`, `srt windows-uninstall`, and (documented) `srt proxy` for standalone proxy + external decider (`docs/srt-proxy.md`).
2. **Library** — primary embedder API:
   - `SandboxManager.initialize(config, askCallback?, enableLogMonitor?, options?)`
   - `SandboxManager.wrapWithSandbox(command, binShell?, customConfig?, abortSignal?, options?) → Promise<string>`
   - `SandboxManager.wrapWithSandboxArgv(...) → Promise<{ argv, env }>`
   - `SandboxManager.registerCommandNetworkLists` / `unregisterCommandNetworkLists`
   - `SandboxManager.annotateStderrWithSandboxFailures` / `getSandboxViolationStore`
   - `SandboxManager.reset()` / `updateConfig` / `cleanupAfterCommand`
   - Windows: `installWindowsSandbox(Async)`, `checkWindowsSandboxStatus(Async)`, `checkWindowsDependencies(Async)`, `verifyWindowsWfpEgress`, profile grant helpers, `VENDORED_SRT_WIN_EXE`, `DEFAULT_WINDOWS_PROXY_PORT_RANGE = [60080, 60089]`
3. **Not an MCP server itself.** It *wraps* MCP servers (README "Sandboxing MCP Servers" example changes `.mcp.json` `command` to `srt`).

### 2.3 Isolation mechanism per OS (OBSERVED README "How It Works")

| OS | Primitives | Network fence | Filesystem fence |
|---|---|---|---|
| **macOS** | `sandbox-exec` + generated Seatbelt profiles | Seatbelt allows only localhost proxy ports; HTTP + SOCKS5 proxies on host | Seatbelt read/write rules; globs supported |
| **Linux** | `bubblewrap` namespaces + seccomp (`apply-seccomp` for AF_UNIX block) | Network namespace removed; traffic via Unix-socket-bridged proxies (`socat`) | Bind mounts / tmpfs denies; globs expanded at wrap time |
| **Windows (alpha)** | Dedicated local user `srt-sandbox` (default); `srt-win.exe` two-hop `CreateProcessWithLogonW` → restricted token inside a **job object** | Machine-wide **WFP** `ALE_AUTH_CONNECT_V4/V6` filters keyed on sandbox SID; PERMIT loopback proxy range `60080–60089`; BLOCK other connects as that user | **NTFS DACL** additive inheriting ACEs for allow/deny; **write-restricted token** so `Users`-group write rights do not apply |

**Dual isolation model (OBSERVED):** both filesystem and network isolation are required. Defaults:

- **Network:** allow-only — empty `allowedDomains` ⇒ no network.
- **Write:** allow-only — empty `allowWrite` ⇒ no writes (plus a small built-in convenience set from `getDefaultWritePaths()`: sandbox stdio/`/tmp/claude` style paths and optionally `~/.npm/_logs`, `~/.claude/debug` when not read-denied).
- **Read:** deny-then-allow — by default all reads allowed unless `denyRead` (and Windows profile exclusions / credential denies).

### 2.4 Policy model — exact keys (OBSERVED `SandboxRuntimeConfigSchema`)

Top-level object (required: `network`, `filesystem`):

```json
{
  "network": {
    "allowedDomains": ["github.com", "*.npmjs.org", "api.example.com:443"],
    "deniedDomains": ["malicious.com", "*:22"],
    "deniedDomainReasons": { "github.com:22": "SSH pushes blocked; use https" },
    "strictAllowlist": true,
    "deniedResolvedAddresses": ["10.0.0.0/8"],
    "allowLocalBinding": false,
    "allowUnixSockets": [],
    "allowAllUnixSockets": false,
    "tlsTerminate": { "excludeDomains": [], "maxTunnels": 256, "handshakeTimeoutMs": 10000 }
  },
  "filesystem": {
    "disabled": false,
    "denyRead": ["~/.ssh"],
    "allowRead": ["."],
    "allowWrite": ["."],
    "denyWrite": [".env"],
    "allowGitConfig": false
  },
  "credentials": { "envVars": [], "files": [] },
  "ignoreViolations": {},
  "windows": {
    "proxyPortRange": [60080, 60089],
    "sandboxUser": "srt-sandbox",
    "srtWin": { "path": "<absolute path to srt-win.exe>" }
  },
  "git": { "safeDirectories": [] },
  "mandatoryDenySearchDepth": 3
}
```

Path entries may be a string or `{ "path": "...", "literal": true }`.

**Mandatory write denies (auto, OBSERVED README):** `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`, `.gitconfig`, `.gitmodules`, `.ripgreprc`, `.mcp.json`, directories `.vscode/`, `.idea/`, `.claude/commands/`, `.claude/agents/`, `.git/hooks/`, `.git/config`.

**Settings file location (CLI):** `~/.srt-settings.json` or `--settings <path>`. Empty/invalid file ⇒ CLI **refuses** to fall back to defaults (would drop rules).

### 2.5 Windows install (OBSERVED README § Windows alpha + `cli.ts`)

```powershell
npx @anthropic-ai/sandbox-runtime@0.0.81 windows-install
# useful flags:
#   --skip-profile-grant
#   --allow-loopback          # machine-wide; must match network.allowLocalBinding
#   --proxy-port-range 60080-60089
#   --sandbox-user srt-sandbox
#   --force
#   --profile-exclude <path>  # repeatable
```

Effects (OBSERVED):

1. Elevates once (UAC): creates `srt-sandbox` local user (random password, DPAPI-encrypted in `HKLM\SOFTWARE\sandbox-runtime`), group `sandbox-runtime-users`, machine-wide WFP filter set.
2. Optionally (default) grants **read+execute** on the installing user's profile to the sandbox group, excluding a large built-in credential store list (`.ssh`, browsers, Vault, `.aws`, …). Grant is **not per-session and not per-user of the sandbox account** — any local Windows user who can run sandboxed commands can read a granted profile (minus exclusions). Shared machines: use `--skip-profile-grant`.
3. Idempotent; upgrades may require re-run when setup version changes (README: 2 → 3 for kept write grants).
4. Uninstall: `npx @anthropic-ai/sandbox-runtime@0.0.81 windows-uninstall` (UAC).

Programmatic: `installWindowsSandboxAsync({ srtWin, skipProfileGrant, allowLoopback, ... })`.

### 2.6 Library wrap pattern (OBSERVED README)

```typescript
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { spawn } from 'node:child_process'

const config: SandboxRuntimeConfig = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: ['~/.ssh'], allowWrite: ['.'], denyWrite: ['.env'] },
}
await SandboxManager.initialize(config)
const sandboxedCommand = await SandboxManager.wrapWithSandbox('curl https://example.com')
const child = spawn(sandboxedCommand, { shell: true, stdio: 'inherit' })
child.on('exit', async () => { await SandboxManager.reset() })
```

Violation attribution: pass `{ commandId, commandText }` in `WrapWithSandboxOptions`; `commandId` must be ≥22 chars of unguessable randomness (128-bit). Under `strictAllowlist`, ask-callback and per-command domain lists are ignored for allow decisions.

### 2.7 Known Windows limitations (OBSERVED — copy into UI copy)

1. **Schannel clients fail inside sandbox** (write-restricted token): `System32\curl.exe`, PowerShell `Invoke-WebRequest`, .NET `HttpClient` / `dotnet restore`, `winget`, git with `http.sslBackend=schannel`, cargo's Schannel libcurl. **Work:** Node/Python/Go/OpenSSL curl/Git-for-Windows OpenSSL backend.
2. **Residuals not fenced:** anonymous-token impersonation before `socket`; deny-only SID restricted token; traffic carried by system services (SMB redirector, possibly WSL); DNS via `Dnscache` as NETWORK SERVICE.
3. **`proxyAuthToken` visible** on runner argv to same-session principals.
4. **Per-exec `allowRead`/`allowWrite` overrides unsupported** — session-level only.
5. **Kept write grants** persist across sessions; other users' sandboxed sessions can **read** (not write) kept roots.
6. **Alpha** — APIs/config may evolve; treat pin upgrades as deliberate OD work.

### 2.8 Supply-chain note (OBSERVED on box 2026-10-25)

Installing `@anthropic-ai/sandbox-runtime@0.0.81` under Node 22 reports **3 high** npm audit findings with **no fix available** in this pin:

- `node-forge` — GHSA-86w9-cpqp-85rv (RSA PKCS#1 v1.5 verification)
- `zod` `<4.6.6` — GHSA-mrhx-c7xc-m3w5 (memory exhaustion on oversized collections); ASRT depends on `zod ^3.25.0` and imports `zod/v3`

**Design decision:** ship with an explicit Settings disclosure; track upstream; do not pretend clean audit. See OD-10.

---

## 3. Capability map / overlap

### 3.1 What Loam already has (OBSERVED)

| Area | Location | Behaviour |
|---|---|---|
| One-shot shell | `src/tools/shell.ts` `shell_run` | `spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env } })` as current user; `checkCommand` deny/allow patterns; timeout; `taskkill /T /F` kill tree |
| Persistent shell | `shell_start` / `shell_write` / `shell_read` | `cmd.exe` or `powershell.exe` long-lived, unsandboxed |
| PTY | `src/tools/pty.ts` | Interactive terminal, unsandboxed |
| MCP client | `src/tools/mcp.ts` | Stdio/HTTP MCP; tools registered as `mcp__<server>__<tool>`; child inherits full `process.env` |
| Command policy | `src/policy/commands.ts` | Substring deny/allow — **not** OS isolation |
| Permission modes | `src/policy/permissionModes.ts` | `ask_for_approval` / `approve_for_me` / `full_access` |
| Risk / untrusted labels | `loam-ref` `src/policy/riskTier.ts` `UNTRUSTED_TOOL_NAMES` | Name-based untrusted **result** labelling for web/browser/email — does **not** sandbox execution |
| Security orchestrator | `src/security/orchestrator.ts` | `assertLocalhost`, `evaluateEvidenceGate`, `EV####` evidence — product security testing, not host sandbox |
| Swarm isolation | `src/swarm/isolation.ts` | Optional Docker/Podman wrap when `LOAM_SWARM_SANDBOX=auto`; else local fallback. Default **off** |
| Computer-use | `src/tools/computerUse.ts` | Host GUI control |
| cua integration (proposed) | `/workspace/re/cua/INTEGRATION_SPEC.md` | Background GUI driver MCP; optional deferred Docker GUI VM |

### 3.2 Overlap table — best-of-breed

| Capability | Loam today | swarm Docker | cua | **srt (this)** | Winner for Loam v1 |
|---|---|---|---|---|---|
| Block agent reading `~/.ssh` | Pattern hope | Container FS | N/A (GUI) | OS deny / no rights | **srt** |
| Block agent open-internet egress | None | Container net | N/A | WFP + proxy allowlist | **srt** |
| No Docker Desktop required | Yes | Needs runtime | Optional | **Yes** (after UAC install) | **srt** for default path |
| Full Linux userspace isolate | No | Yes | Guest VM (deferred) | No (same Windows host, different user) | Docker/cua when available |
| GUI click/type | `computer_*` | No | **cua-driver** | No | **cua** / Loam computer |
| Logged-in browser | Playwright / browsentic | No | No | No | browsentic / Loam |
| Policy denylist UX | `checkCommand` | — | — | Complements | Keep both |
| Pentest localhost tools | orchestrator | — | — | Must **not** break loopback probes | Keep orchestrator outside srt or allowlist carefully |

### 3.3 Complementarity with cua (required distinction)

| | **cua** (Driver / deferred Spaces) | **sandbox-runtime (srt)** |
|---|---|---|
| Problem | Drive GUI precisely / optionally in a VM | Contain **process** FS + network |
| Unit of isolation | Window / OS desktop / (deferred) VM | Process tree under `srt-sandbox` SID |
| Typical wrap | MCP tools `click`, `type`, `verify_state` | `shell_run`, `npx …mcp`, bash |
| Admin install | Driver binary pin | **UAC** `windows-install` + WFP |
| Replaces the other? | **No** | **No** |

**Rule for implementers:** a sandboxed shell still cannot safely drive the user's interactive desktop; cua-driver still runs with the user's GUI power unless OD-2 (cua spec) Docker path is built. Do not market srt as "full computer sandbox".

### 3.4 Honest conclusion on overlap

~15% conceptual overlap with swarm Docker ("run command elsewhere"), ~0% with cua GUI tools, ~0% with REA/api-anything/browsentic *features* — but **100% relevant** as a wrapper *around* shell and those MCP servers' process launches. Net-new: OS enforcement on Windows without Docker.

---

## 4. Windows-only reality check

Loam is **Windows-only**. ASRT's production-hardened paths are macOS/Linux; Windows is explicitly **alpha**. Still viable for Loam because:

- Bundled `srt-win.exe` (x64 + arm64) ships in the npm package — no extra apt/brew deps.
- Loam already requires Node `>=22.13` ≥ ASRT's `>=22.12`.
- Apache-2.0 is compatible with shipping inside a commercial desktop app (see §11.3).

### 4.1 Admin / signed-app implications

| Topic | Implication for Loam |
|---|---|
| UAC install | Must be an explicit user gesture. Signed Loam can *launch* `srt-win` / `installWindowsSandboxAsync`, which self-elevates; Loam itself need not be installed elevated. |
| Machine-wide state | `srt-sandbox` user + WFP affect the machine. Document for multi-user PCs. |
| Code signing | Bundled `srt-win.exe` is third-party; SmartScreen may prompt — pin hashes; prefer Authenticode if Anthropic ships signed binaries (**UNKNOWN** — Design decision: verify signature on first run; fail closed if hash mismatch). |
| Enterprise | Custom `windows.sublayerGuid` / `sandboxUser` supported for managed installs. |
| Auto-update | Bumping ASRT may require re-running `windows-install` when setup version changes — gate behind OD + UI. |

### 4.2 Validation checklist (Khamis runs on his PC)

Run after installing pin `0.0.81`. Record pass/fail with timestamp بتوقيت قطر.

| ID | Step | Expected |
|---|---|---|
| W1 | `node -v` inside Loam's runtime | `>=22.13` |
| W2 | From elevated-capable session: `npx @anthropic-ai/sandbox-runtime@0.0.81 windows-install --skip-profile-grant` | UAC → Installed; user provisioned; WFP filters > 0 |
| W3 | `npx @anthropic-ai/sandbox-runtime@0.0.81 windows-install` already done → re-run | Idempotent / upgrade message; no logout required |
| W4 | `srt --settings loam-srt-settings.json -- echo hi` with empty network + `allowWrite:["."]` | Prints `hi`, exit 0 |
| W5 | `srt … -- curl https://example.com` with empty `allowedDomains` | Blocked (connection denied / proxy 403) |
| W6 | Same with `allowedDomains:["example.com"]` | HTML body returns (Node/OpenSSL curl — not `System32\curl.exe`) |
| W7 | `srt … -- type %USERPROFILE%\.ssh\id_rsa` with `denyRead` or without profile grant | Access denied / not found |
| W8 | Write test: `echo x > .\sandbox-write-test.txt` under `allowWrite:["."]` | Succeeds; file owned/writable as expected |
| W9 | Write test: `echo x > %USERPROFILE%\.bashrc` (or `.git\hooks\pre-commit` inside a repo with `allowWrite:["."]`) | Denied (mandatory deny) |
| W10 | `srt … -- powershell -Command Invoke-WebRequest https://example.com` | **Fails** (Schannel) — confirm documented |
| W11 | Start Loam; Settings shows sandbox status (user/WFP) | Matches `checkWindowsSandboxStatus` |
| W12 | Loam `shell_run` `echo sandboxed` with mode `untrusted_only` | Exit 0; audit event `srt_exec` with `sandboxed:true` |
| W13 | Loam `shell_run` `curl https://example.com` with empty allowlist | Failure + annotated stderr / violation |
| W14 | Uninstall path dry-run reading: `windows-uninstall` docs understood; only run if Khamis wants cleanup | — |

**Gate:** feature stays `mode:"off"` until W2, W4, W5, W7, W12, W13 pass.

---

## 5. Integration approach — options + recommendation

### 5.1 Option (a) — Wrap Loam shell + untrusted MCP as execution backend

Use `SandboxManager` in Electron/server process for `shell_run`; spawn MCP stdio servers as `srt --settings … -- <cmd> …`.

- **Pros:** Real OS isolation; matches ASRT design; Apache-2.0; library already exported for embedders; MCP README pattern exists.
- **Cons:** Windows alpha; UAC; Schannel gaps; residuals; session lifecycle (`initialize`/`reset`) must be owned carefully; MCP servers need tailored allowlists.

### 5.2 Option (b) — Adopt only the policy model natively

Reimplement allowlists in Loam without ASRT.

- **Pros:** No UAC; full control.
- **Cons:** Rebuilding WFP + restricted tokens + ACE management is an XL security project; almost certainly weaker; violates Skip list.

### 5.3 Option (c) — Hybrid (recommended)

| Path | Sandboxed? |
|---|---|
| `shell_run` when `sandbox.mode` is `untrusted_only` or `all_shell` | **Yes** |
| stdio MCP servers with `sandbox: true` (default for third-party) | **Yes** (CLI wrap) |
| Built-in Loam tools (files, Playwright, computer-use, security orchestrator HTTP to localhost, trusted MCP) | **No** (host) |
| `shell_start` / PTY | **No in v1** — refuse or warn (OD-6) |
| Swarm verify when Docker available | Docker path unchanged; may nest later (not v1) |

- **Pros:** Best risk/UX; keeps product features working; matches OD-1.
- **Cons:** Two execution paths to test; users must understand "sandbox off for GUI".

### 5.4 Recommendation

**Option (c) Hybrid**, implemented as Option (a)'s mechanism under a mode flag:

1. Pin ASRT `0.0.81` under Loam data dir (OD-3).
2. User runs install from Settings (OD-2), prefer `--skip-profile-grant` (OD-4).
3. Default `sandbox.mode = "off"` until checklist; then recommend `"untrusted_only"`.
4. `strictAllowlist: true`, `allowedDomains: []`, `allowLocalBinding: false` (OD-5, OD-7).
5. Do not sandbox cua / computer / browser (OD-9).

---

## 6. Security & trust integration

### 6.1 Layering

```
L0 User intent + permission mode (ask / approve_for_me / full_access)
L1 checkCommand + path policy (existing)
L2 riskTiers / UNTRUSTED_TOOL_NAMES (result labelling)
L3 ASRT OS sandbox (this spec) — FS + network for selected exec
L4 assertLocalhost / evidence gate (pentest product — unchanged)
```

L3 never replaces L0–L2. A command that passes L1 can still be FS/net-clipped by L3.

### 6.2 Mapping onto Loam security core

| Loam concept | srt mapping |
|---|---|
| `assertLocalhost` | Pentest engines stay on host; if a sandboxed tool must hit `127.0.0.1`, that requires OD-5 loopback (discouraged) or host path |
| `evaluateEvidenceGate` / `EV####` | Unchanged; optional audit field `sandbox: { commandId, violations[] }` |
| `UNTRUSTED_TOOL_NAMES` | Still label *results*; additionally, tools that *execute* untrusted code (`shell_run`, `mcp__*`) enter L3 when mode on |
| Approval tiers | Network ask callback only if `strictAllowlist` false; recommended strict ⇒ approvals happen in Loam UI *before* growing `allowedDomains` |
| Bridges / `BridgeEffect` | Treat `srt_exec` as effect `spawn` + `network` annotations for audit |

### 6.3 Default-deny posture (Loam recommended config)

```json
{
  "network": {
    "allowedDomains": [],
    "deniedDomains": [],
    "strictAllowlist": true,
    "allowLocalBinding": false
  },
  "filesystem": {
    "denyRead": [
      "~/.ssh",
      "~/.gnupg",
      "~/.aws",
      "~/.azure",
      "~/.kube",
      "~/.docker",
      "~/.config/gh",
      "~/.config/gcloud"
    ],
    "allowRead": ["."],
    "allowWrite": ["."],
    "denyWrite": [".env", ".env.*", "**/.env", "**/.env.*"]
  },
  "windows": {
    "proxyPortRange": [60080, 60089]
  }
}
```

Workspace root is always added to `allowRead`/`allowWrite` by the bridge (`buildSandboxRuntimeConfig`).

### 6.4 Audit events

Emit (via existing Loam log/audit pipeline — exact sink OBSERVED per branch; do not invent a new telemetry channel):

| Event | Fields |
|---|---|
| `srt_install_started` / `srt_install_finished` | `skipProfileGrant`, `allowLoopback`, `success`, `errorCode?` |
| `srt_session_open` / `srt_session_close` | `mode`, `allowedDomainsCount`, `workspace` |
| `srt_exec` | `commandId`, `toolName`, `cwd`, `exitCode`, `timedOut`, `sandboxed`, `durationMs`, `violationCount` |
| `srt_violation` | `commandId`, `summary` (from annotate/store; **no secrets**) |
| `srt_blocked_tool` | when `shell_start` refused under sandbox mode |

Never log proxy auth tokens, DPAPI blobs, or raw `.npmrc` contents.

### 6.5 What isolation does **not** cover

- GUI / accessibility / screenshot tools (cua / computer-use).
- Electron main process, renderer, preload.
- Host Playwright browsers already launched.
- Attacks using documented Windows residuals (§2.7).
- Data exfiltration via an **allowed** domain (e.g. allow `github.com` ⇒ push anywhere) — mitigate with tight allowlists + future `filterRequest` (defer).
- Malicious rewrite of ASRT if installed inside a writable project `node_modules` — Loam pin path must sit **outside** workspace allowWrite.

### 6.6 Escape / residual handling

On session open, call `checkWindowsDependenciesAsync` and surface `errors` / `warnings` / `loopbackMismatch` / `reinstallRequired` in Arabic UI. Optionally run `verifyWindowsWfpEgress` and show residuals (`anonymous-loopback`, `deny-only-user-sid`) as **warnings**, not hard failures (matches library behaviour).

### 6.7 Pinning & integrity

```
package: @anthropic-ai/sandbox-runtime@0.0.81
tarball sha256: 0e0b8249062047f7b592c7995f8ec2f251f3bbebdc0402db1ee23af09983953f
srt-win.exe x64 sha256: a8e22bc098ac1146ec9b9151d5f1770c05b897cd1ac588161e1287a248cc9176
srt-win.exe arm64 sha256: c7b204c8fab94059dbf7a6a805b844abad3deb82614e07e4b8d4b5bb5c4374f7
```

At Loam startup (when mode ≠ off): verify `srt-win.exe` hash for `process.arch`; mismatch ⇒ disable sandbox + Arabic error «تعذّر التحقق من ملف العزل».

---

## 7. Exact wiring points in Loam

> Written spec only — **do not commit** until approval. Paths relative to Loam repo root.

### 7.1 New files

| Path | Purpose |
|---|---|
| `src/sandbox/srt/types.ts` | Types from §8 |
| `src/sandbox/srt/policy.ts` | `DEFAULT_LOAM_SRT_POLICY`, merge with user settings |
| `src/sandbox/srt/session.ts` | `openSrtSession` / `closeSrtSession` / status probe |
| `src/sandbox/srt/exec.ts` | `execInSandbox` |
| `src/sandbox/srt/mcpWrap.ts` | Rewrite MCP stdio command to `srt --settings … -- …` |
| `src/sandbox/srt/install.ts` | Thin wrapper over `installWindowsSandboxAsync` / uninstall |
| `src/sandbox/srt/audit.ts` | Event helpers |
| `src/scripts/check-srt-policy.ts` | Schema + default policy tests |
| `src/scripts/check-srt-bridge.ts` | Unit tests with mocked SandboxManager |
| `src/sandbox/srt/__tests__/*.ts` | Table tests |
| Settings UI panel (existing settings surface) | Arabic strings §7.4 |

Reference implementation already typechecked: `/workspace/re/sandbox-runtime/reference/loamSrtBridge.ts` (copy ideas, adapt to Loam imports / log / config).

### 7.2 Modify

| File | Change |
|---|---|
| `package.json` | Dependency `"@anthropic-ai/sandbox-runtime": "0.0.81"` exact; scripts `check:srt-policy`, `check:srt-bridge`; ensure packaging copies `vendor/srt-win/**` **or** documents data-dir pin install |
| `src/tools/shell.ts` | In `shell_run.run`, after `checkCommand` OK: if `shouldSandboxTool` ⇒ `execInSandbox`; else existing `runOnce`. Annotate content with sandbox footer when used |
| `src/tools/mcp.ts` | When server config `sandbox !== false` and mode on: spawn via `mcpWrap` (`command: srtPath`, args: `["--settings", settingsPath, "--", realCommand, ...args]`). HTTP MCP unchanged |
| `src/config` / settings schema | Add `sandbox: LoamSrtSettings` |
| Desktop IPC (existing settings IPC) | Expose `srt:status`, `srt:install`, `srt:setMode` |
| `src/swarm/isolation.ts` | Comment-only cross-link in v1; no behaviour change (OD-8) |

### 7.3 Do not modify

- `src/security/orchestrator.ts` behaviour (no sandbox wrapping of its localhost HTTP).
- `watchdog.ps1`, QA baselines, ZCode/Codex files.
- cua / browsentic / api-anything specs' code paths.

### 7.4 UI copy (Arabic-first)

| Key | AR | EN |
|---|---|---|
| Panel title | عزل الأوامر (تجريبي) | Command sandbox (preview) |
| Mode off | متوقف | Off |
| Mode untrusted | للأوامر غير الموثوقة | Untrusted only |
| Mode all shell | لكل أوامر الطرفية | All shell |
| Install CTA | تثبيت عزل النظام (صلاحية مدير) | Install OS sandbox (admin) |
| Skip profile | دون قراءة ملف التعريف | Without profile read grant |
| Status ok | العزل جاهز | Sandbox ready |
| Status missing | يلزم التثبيت مرة واحدة | One-time install required |
| Alpha warning | دعم ويندوز ما زال تجريبيًا لدى المزوّد — راجع القيود | Upstream Windows support is alpha — see limits |
| Audit tip | الأوامر المعزولة لا تصل للإنترنت إلا بالنطاقات المسموحة | Sandboxed commands cannot reach the network except allowlisted domains |

Icons: `shield-check` / `shield-alert` / `hand` only — **no Sparkles**.

### 7.5 Settings file on disk

Loam writes a per-app settings JSON (not `~/.srt-settings.json` by default — avoid clashing with Claude Code):

`%LOAM_DATA%\srt\loam-srt-settings.json`

Pass to CLI wraps via `--settings`. Library path uses in-memory `SandboxRuntimeConfig` from the same object.

### 7.6 Lifecycle

1. App start → if mode ≠ off → `probeSrtSession`; if not installed → UI banner; do not call `initialize`.
2. First sandboxed tool call → `openSrtSession` once per process (or per task — OD design: **per process** recommended).
3. App quit / mode→off → `closeSrtSession` (`reset()`).
4. Config change to filesystem rules → `reset()` then `initialize(newConfig)` (network lists can use `updateConfig` / control-fd semantics; FS rules need re-init on Windows).

---

## 8. Data model / TypeScript interfaces (full)

```typescript
/** Mirror of reference/loamSrtBridge.ts — keep in sync when copying into Loam. */

export type SrtExecMode = "off" | "untrusted_only" | "all_shell";

export interface LoamSrtPolicy {
  mode: SrtExecMode;
  strictAllowlist: boolean;
  allowedDomains: string[];
  denyRead: string[];
  allowRead: string[];
  allowWrite: string[];
  denyWrite: string[];
  allowLocalBinding: boolean;
  timeoutMs: number;
}

export interface LoamSrtSettings {
  policy: LoamSrtPolicy;
  /** Absolute dir containing package 0.0.81 + vendor/srt-win */
  pinRoot: string;
  settingsFile: string;
  skipProfileGrant: boolean;
  /** Disclose audit CVEs acknowledged by user */
  supplyChainAckVersion?: "0.0.81";
}

export interface SrtSessionStatus {
  enabled: boolean;
  platformSupported: boolean;
  windowsInstalled: boolean | "n/a";
  windowsMessage?: string;
  proxyPortRange: readonly [number, number];
  pinVersion: "0.0.81";
}

export interface SrtExecRequest {
  command: string;
  cwd: string;
  commandId?: string;
  perCommandAllowedDomains?: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SrtExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  sandboxed: boolean;
  commandId: string;
  annotatedStderr: string;
}

export const DEFAULT_LOAM_SRT_POLICY: LoamSrtPolicy = {
  mode: "off", // flip to untrusted_only after W-checklist (OD-1)
  strictAllowlist: true,
  allowedDomains: [],
  denyRead: [
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    "~/.azure",
    "~/.kube",
    "~/.docker",
  ],
  allowRead: ["."],
  allowWrite: ["."],
  denyWrite: [".env", ".env.local", "**/.env", "**/.env.*"],
  allowLocalBinding: false,
  timeoutMs: 120_000,
};
```

Full executable reference (typechecked):  
`/workspace/re/sandbox-runtime/reference/loamSrtBridge.ts`

---

## 9. Phased build plan + acceptance criteria

### Phase P0 — Pin + status probe (no behaviour change)

**Branch:** `feat/srt-loam-p0-pin`  
**Work:** Add exact dependency (or data-dir installer script); `src/sandbox/srt/session.ts` probe; Settings read-only status; `check:srt-policy`.  
**Accept:**

```bash
npm run typecheck
npm run check:srt-policy
```

Status IPC returns `pinVersion: "0.0.81"` and hash verification result. Mode remains `off`.

### Phase P1 — Windows install UX

**Branch:** `feat/srt-loam-p1-install`  
**Work:** Settings CTA → `installWindowsSandboxAsync({ skipProfileGrant: true, srtWin: resolveSrtWin({ path: VENDORED_SRT_WIN_EXE }) })`; show UAC; persist result; Arabic errors for cancel (exit 2).  
**Accept:** Manual W2 on Khamis PC; unit test maps cancel → non-destructive.

### Phase P2 — `shell_run` wrap

**Branch:** `feat/srt-loam-p2-shell`  
**Work:** Hybrid exec path; audit events; annotated stderr in tool result.  
**Accept:**

```bash
npm run check:srt-bridge
npm run typecheck
```

Integration on PC: W12, W13.

### Phase P3 — MCP stdio wrap

**Branch:** `feat/srt-loam-p3-mcp`  
**Work:** `mcpWrap.ts`; per-server `sandbox` flag; default true for non-builtin servers. Builtin filesystem/memory MCP: decide per OD (recommend sandbox **on** with `allowWrite` = workspace only).  
**Accept:** `npm run check:mcp` still green; third-party server without network allowlist cannot egress.

### Phase P4 — Allowlist UI + strict mode

**Branch:** `feat/srt-loam-p4-allowlist`  
**Work:** UI to edit `allowedDomains`; optional per-task overrides **only if** OD-7 relaxes `strictAllowlist`.  
**Accept:** Changing domains requires session re-init or `updateConfig` as appropriate; audit `srt_session_open`.

### Phase P5 — Hardening

**Branch:** `feat/srt-loam-p5-hardening`  
**Work:** Hash verify; refuse sandbox if pin inside workspace; document Schannel; residual warnings; OD-6 shell_start behaviour; supply-chain ack checkbox (OD-10).  
**Accept:** `npm run verify` + `check:loam-ui`; W1–W13 green checklist attached to PR.

### Copy-ready agent prompt (after approval)

```
Implement Loam←srt Phase P0 from /workspace/re/sandbox-runtime/INTEGRATION_SPEC.md
on a new branch feat/srt-loam-p0-pin. Study & code in the Loam working tree only after
Khamis approved. Do not force-push, do not reset --hard, do not touch watchdog.ps1.
Pin @anthropic-ai/sandbox-runtime@0.0.81 exact. Add check:srt-policy. Keep mode off.
```

---

## 10. Open decisions for Khamis

| ID | Question | Recommended default | Why |
|---|---|---|---|
| **OD-1** | Sandbox mode default after validation? | `untrusted_only` (ship `off` until W-checklist) | Balances safety vs breaking trusted tools |
| **OD-2** | How is UAC install triggered? | Explicit Settings button only | No silent elevation in signed app |
| **OD-3** | Bundle pin in installer vs download on demand? | Loam-managed pin under `%LOAM_DATA%\bin\srt\0.0.81\` | Integrity + offline; still Apache-2.0 attribution |
| **OD-4** | Profile read grant? | `--skip-profile-grant` | Avoid cross-user profile readability; tools use workspace |
| **OD-5** | Open localhost loopback? | **No** | Any local service would become reachable |
| **OD-6** | Persistent `shell_start` under sandbox? | Refuse with Arabic message when mode ≠ off | Long-lived interactive sandbox is harder; v2 |
| **OD-7** | strict allowlist vs ask-on-unknown host? | `strictAllowlist: true` | Agent should not socially-engineer network opens mid-command |
| **OD-8** | Keep swarm Docker path? | Yes, unchanged | Different weight class; optional |
| **OD-9** | Does srt replace cua? | **No** | Orthogonal |
| **OD-10** | Accept node-forge/zod audit on 0.0.81? | Acknowledge in UI; re-pin when fixed | Honesty > fake clean bill |
| **OD-11** | Sandbox builtin MCP (`server-filesystem`)? | Yes, with workspace-only writes | Reduces MCP blast radius |
| **OD-12** | Grow default `allowedDomains` (npm/github)? | Empty by default; user adds | Secure-by-default |

---

## 11. Evidence log, UNKNOWNs, licence posture

### 11.1 Evidence log (OBSERVED)

| Fact | Evidence |
|---|---|
| Package name/version/licence/engines | `/workspace/re/sandbox-runtime-src/package.json` |
| Source commit | `c66fb77b28fdbea8b9788aca72377238ae67ca20` |
| Windows isolation design | README.md § "Windows (alpha)" lines ~740–1012 |
| Dual isolation + per-OS primitives | README.md § "How It Works" |
| Library exports | `src/index.ts`; `package/dist/index.d.ts` |
| Config schema | `src/sandbox/sandbox-config.ts` `SandboxRuntimeConfigSchema` |
| Default proxy port range | `DEFAULT_WINDOWS_PROXY_PORT_RANGE = [60080, 60089]` |
| CLI windows-install flags | `src/cli.ts` ~185–280 |
| Loam shell host spawn | `/workspace/loam/src/tools/shell.ts` lines 39–41, 129–159 |
| Loam MCP stdio spawn | `/workspace/loam/src/tools/mcp.ts` lines 80–84, 99–114 |
| Loam swarm Docker optional | `/workspace/loam/src/swarm/isolation.ts` |
| UNTRUSTED_TOOL_NAMES | `/workspace/re/rea/loam-ref/src/policy/riskTier.ts:291` |
| npm tarball + srt-win hashes | sha256 commands on box 2026-10-25 |
| Import + typecheck | Node v22.23.4; `reference/` `tsc --noEmit` exit 0 |
| npm audit on pin | node-forge + zod high, no fix available |

### 11.2 UNKNOWNs (each with Design decision + test)

| UNKNOWN | Design decision | Test |
|---|---|---|
| Is published `srt-win.exe` Authenticode-signed? | Verify signature if present; always enforce sha256 pin | W-extra: `Get-AuthenticodeSignature` on PC |
| Exact Loam `%LOAM_DATA%` path on 0.5.31 PC build | Resolve from existing config helper at implement time; do not hardcode in this doc beyond pattern | Unit test reads same helper as updates |
| Whether Khamis's PC is single-user | Assume single-user; still default `--skip-profile-grant` | Ask OD-4 |
| Interaction of ASRT job object with Loam `taskkill /T` | Keep killTree; add srt session reset on task cancel | Cancel mid-`shell_run` test |
| electron-builder packaging of `vendor/srt-win` asar unpack | `asarUnpack` for `**/srt-win/**/*.exe` or external data-dir pin (prefer data-dir — OD-3) | `check:packaged` extension |
| Future ASRT setup version bumps | Gate upgrades behind changelog + re-install CTA | Integration test mock `reinstallRequired` |

### 11.3 Licence posture (shipping in signed Windows app)

| Component | Licence | Ship in Loam? |
|---|---|---|
| `@anthropic-ai/sandbox-runtime` | Apache-2.0 | **Yes** — retain NOTICE/LICENSE; Apache terms apply |
| Bundled `srt-win.exe` | Same distribution via Apache-2.0 package | **Yes** with attribution |
| node-forge / zod (transitive) | Their licences via npm | Ship as transitive; track CVEs (OD-10) |

Apache-2.0 is permissive and **compatible** with a closed-source Electron app, provided attribution and license copies are preserved. No AGPL/FSL issue (unlike parts of cua).

### 11.4 Definition of "useful" verdict

**Useful: YES — adopt Hybrid (option c) with library wrap + MCP CLI wrap, Windows alpha caveats, disabled until W-checklist.** Highest-leverage safety upgrade among the five triage repos for host command isolation; complementary to cua.

---

## Appendix A — MCP wrap example (OBSERVED pattern adapted)

Loam config today (conceptual):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${WORKSPACE}"]
    }
  }
}
```

With srt (Loam-managed):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "${LOAM_SRT_BIN}",
      "args": [
        "--settings", "${LOAM_SRT_SETTINGS}",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "${WORKSPACE}"
      ],
      "sandbox": true
    }
  }
}
```

(`mcpWrap.ts` can rewrite at registration time so user config stays unprefixed.)

## Appendix B — Reference verification commands (box)

```bash
# Already run 2026-10-25 Asia/Riyadh:
unset NPM_CONFIG_PREFIX && . ~/.nvm/nvm.sh && nvm use 22
cd /workspace/re/sandbox-runtime/reference && npx tsc --noEmit   # exit 0
node --input-type=module -e "import { DEFAULT_WINDOWS_PROXY_PORT_RANGE } from '@anthropic-ai/sandbox-runtime'; console.log(DEFAULT_WINDOWS_PROXY_PORT_RANGE)"
# → 60080,60089
```

## Appendix C — Arabic relay summary (for parent → Khamis)

انظر الملخص العربي في رسالة الوكيل الأب؛ المواصفة الإنجليزية أعلاه هي مصدر التنفيذ الوحيد.

---

## 12. Repo deltas — anchoring to `manus-local` (2026-10-25, Khamis-approved plan)

> Follows the REA (§16/A-series) and Cua (§12/B-series) precedents: how §§0–11 were
> anchored to the working checkout. Where this appendix and the body disagree on
> **repo mechanics**, this appendix wins; the capability scope of the body is unchanged.

| # | Delta vs spec body | Resolution |
|---|---|---|
| C1 | Spec §7.2 adds a production `"dependencies"` entry; the pin carries **3 high npm-audit findings with no fix** (node-forge GHSA-86w9-cpqp-85rv, zod GHSA-mrhx-c7xc-m3w5 — §2.8/OD-10) | **No production dependency.** Runtime resolves the library by dynamic `import()` from the data-dir pin (`<DATA_DIR>/bin/srt/0.0.81/`); `devDependencies` holds the exact pin for types/typecheck only (dev deps never ship in the electron-builder production tree). The OD-10 disclosure + acknowledgement checkbox still applies |
| C2 | Spec says "settings key `sandbox.mode`" without fixing the home | Flat keys in the **existing** `src/server/settings.ts` (`sandboxMode`, `sandboxAllowedDomains`, `sandboxSkipProfileGrant`, `sandboxSupplyChainAck`) persisted via the existing `GET/POST /api/settings` — no config.json, no new store |
| C3 | Spec §6.4 "exact sink OBSERVED per branch" | This branch's established pattern: per-capability append-only JSONL — `<DATA_DIR>/srt/audit.jsonl` (seq + torn-line healing, same as reaAudit/cuaAudit); events `srt_install_*`, `srt_session_open/close`, `srt_exec`, `srt_violation`, `srt_blocked_tool`; never proxy tokens / DPAPI blobs / secrets |
| C4 | Spec B/P3 leans "default `sandbox: true` for third-party MCP servers" | **Opt-in per server**: `mcpServers.<name>.sandbox === true` only. Reason: Loam's own example servers include loopback-dependent ones (memory-skills → Ollama on 127.0.0.1; loam-bridge HTTP) which OD-5 (`allowLocalBinding:false`) would break; the pinned rea/cua-driver servers are Loam-managed and trusted. config.example documents the flag |
| C5 | Spec §0.1 one-branch-per-phase | Repo convention: single branch, phase commits `srt SPn:`, label `srt-capability`; surgical blob staging (`git hash-object`/`update-index`) whenever a shared file is hot |
| C6 | Meaning of `untrusted_only` underspecified for Loam | v1 honest semantics: `untrusted_only` sandboxes `shell_run` **unless the run's permission mode is `full_access`** (explicit user trust); `all_shell` sandboxes unconditionally. Surfaced in the panel copy |
| C7 | W-checklist "Khamis runs on his PC" | The implementing agent can drive W1–W13 itself after the one-time UAC install; the UAC dialog click is the single user gesture (OD-2). Mode stays `off` until W2/W4/W5/W7/W12/W13 pass, then the `untrusted_only` flip is Khamis's explicit call |
| C8 | npm pin verified live 2026-10-25: `@anthropic-ai/sandbox-runtime@0.0.81` exists (Apache-2.0, engines ≥22.12, registry integrity `sha512-bjHDu87g…`); tarball + both `srt-win.exe` sha256 values are enforced by `scripts/install-srt.mjs` before anything is used | Recorded in `docs/srt-pin.md` and `src/sandbox/srt/policy.ts` constants |
| C9 | Settings UI rides the **existing** settings page + `ui/app.js` `post('/api/settings', …)` partial-update pattern; new panel section «عزل الأوامر (تجريبي)» with shield-check/shield-alert/hand icons (no Sparkles) | No new desktop-IPC namespace needed: the HTTP server process calls the library and triggers UAC naturally |
| C10 | `checkCommand` / `checkCommandRisk` / permission modes / `assertLocalhost` / `evaluateEvidenceGate` / swarm isolation stay untouched (L0–L2 + L4 per §6.1); PTY tool untouched in v1 | As designed |

*End of sandbox-runtime → Loam integration spec. Approved 2026-10-25; implementation as commits `srt SPn:` with branch label `srt-capability`.*
