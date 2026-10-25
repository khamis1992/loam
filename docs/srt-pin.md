# srt pin — @anthropic-ai/sandbox-runtime (OD-3, OD-10, appendix C1/C8)

Status: pinned and installed into the data dir; the feature ships **off** (OD-1)
until the W-checklist passes. The one-time OS install (UAC) is a user gesture.

## Pin

| Field | Value |
|---|---|
| Package | `@anthropic-ai/sandbox-runtime` — **Apache-2.0**, Anthropic PBC. Invoked from the data-dir pin; **never a production dependency** (C1) |
| Version | **0.0.81** — exact only; Beta Research Preview, Windows alpha |
| npm tarball sha256 | `0e0b8249062047f7b592c7995f8ec2f251f3bbebdc0402db1ee23af09983953f` |
| `vendor/srt-win/x64/srt-win.exe` | 4,020,736 bytes — sha256 `a8e22bc098ac1146ec9b9151d5f1770c05b897cd1ac588161e1287a248cc9176` |
| `vendor/srt-win/arm64/srt-win.exe` | 3,598,336 bytes — sha256 `c7b204c8fab94059dbf7a6a805b844abad3deb82614e07e4b8d4b5bb5c4374f7` |
| Install slot | `<DATA_DIR>/bin/srt/0.0.81/` (outside every workspace allowWrite root) |
| Loam settings file | `<DATA_DIR>/srt/loam-srt-settings.json` (never `~/.srt-settings.json`) |
| Audit | `<DATA_DIR>/srt/audit.jsonl` (ids/outcomes only, never proxy tokens/secrets) |

Constants live in `src/sandbox/srt/policy.ts` and `scripts/install-srt.mjs` — change
them together. `check:srt-policy` asserts the posture; `verifySrtPin()` re-checks the
vendored helper hash on every session open and **disables the sandbox** on mismatch.

## Install / verify

```bash
node scripts/install-srt.mjs
```

Enforced order: registry integrity of the exact version → `npm pack` → tarball
sha256 vs the recorded pin → install with `--ignore-scripts --omit=dev` into the
versioned slot → BOTH `srt-win.exe` sizes+hashes verified → CLI probe → `pin.json`.

## Dependency posture (C1 + OD-10)

- `devDependencies` holds the exact pin **for types/typecheck only** — dev deps
  never ship in the electron-builder production tree.
- Reason: the pin carries **3 high npm-audit findings with no fix** (node-forge
  GHSA-86w9-cpqp-85rv, zod GHSA-mrhx-c7xc-m3w5). Runtime loads the library by
  dynamic `import()` from the data-dir pin instead; the disclosure + acknowledgement
  checkbox live in the Settings panel. Re-pin when upstream fixes land (OD-10).

## One-time OS install (user gesture, UAC — OD-2/OD-4)

From Loam Settings → «عزل الأوامر» (SP1), or manually:

```powershell
& "<node.exe path>" "<DATA_DIR>/bin/srt/0.0.81/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js" windows-install --skip-profile-grant
```

Creates local user `srt-sandbox`, group `sandbox-runtime-users`, and machine-wide WFP
egress filters (permit loopback proxy range 60080–60089 for that user, block the
rest). `--skip-profile-grant` keeps other profiles unreadable (OD-4). Uninstall:
same CLI with `windows-uninstall`.

## Known Windows-alpha caveats (§2.7 — surfaced in the panel)

Schannel-based clients fail inside the sandbox (System32 curl, PowerShell
Invoke-WebRequest, dotnet, winget) — use Node/OpenSSL-based tooling; residual
escapes documented upstream (anonymous-token, deny-only SID, system-service
traffic); per-exec FS overrides unsupported; alpha APIs may change on re-pin.
