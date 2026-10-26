# Recon Gate + LLM/MCP Self-Test (ALL_SERVICES §10-§12)

Status: integrated (Revision 44).

## §10 Authorized-scope gate — `src/security/recon/scope.ts`

- `assertAuthorizedScope(url, grants?)` runs BEFORE any request: loopback-only by
  construction (127.0.0.0/8, localhost, ::1, ip6-localhost, IPv6-mapped forms);
  non-loopback requires a live `ScopeGrant` (authorization statement + owner +
  allowHosts + expiry); exotic protocols and credential-bearing URLs are refused.
  `ScopeError` is the single refusal type — no code path may bypass the gate.
- `recon_scan` tool: bounded HTTP fingerprint (status/server/title) behind the gate;
  a non-loopback target returns `REFUSED — <reason>`, never a request.

## §11 LLM self-test — `src/security/llm/probes.ts`

- Offline battery (7 probes: instruction-override ×2, tool-misuse ×2, data-leak ×2,
  persona) with deterministic fail-markers; failures become `llm` findings feeding the
  self-hardening loop. `llm_scan` runs it against the configured model endpoint
  (`deps.ollama`); garak/promptfoo remain optional pinned external adapters.

## §12 MCP/agent-tool surface — `src/security/mcp/scan.ts` (first-party, Loam-aware)

- `scanBridgeManifest`: over-broad declared effects vs argv (`write_workspace`/`exec_script`
  without write-shaped names/argv), under-declared network-looking `read` commands,
  unpinned manifests.
- `scanSkillDocument`: injection sinks in SKILL.md/prompt assets (instruction-override,
  persona, exfil-hint incl. bare `curl|wget URL`, destructive-hint, embedded credentials).
- `scanMcpServerConfig`: shell-metacharacter spawn commands, inline secret env vars
  (key masked in the finding), non-loopback server URLs.
- `mcp_scan` tool scans what Loam actually loads: builtin bridge manifests, workspace +
  app skills directories, and `config.json` mcpServers.

## Integration

All three tools registered (`src/tools/securityScanTools.ts`, deps pass `ollama`) and added
to the security mode (`src/modes/catalog.ts`). Untrusted-content rule: skill/server text is
data; secrets are masked, never echoed.

## Verification

`test:scanners` (9 tests incl. scope refusals + grant expiry, battery pass/fail, manifest/
skill/config scanners) • `check:modes` green • `test:audit` 133/133 regression.

## Deferred

httpx/subfinder pinned adapters (optional externals; the gate wraps them when added),
garak/promptfoo external batteries, pktz host egress monitor (Linux/WSL only).
