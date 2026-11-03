# Cua Driver pin — external MCP server (OD-3, OD-7c)

Status: pinned, install scripted; the `config.json` `mcpServers["cua-driver"]` entry
lands with the wiring phase (CUA_INTO_LOAM_INTEGRATION §7.2).

## Pin

| Field | Value |
|---|---|
| Package | Cua Driver (Rust) — MIT, invoked as an external process, never bundled |
| Version | **0.38.0** — exact only; ranges / `@latest` forbidden |
| GitHub release | `trycua/cua` tag `cua-driver-rs-v0.38.0` (published 2026-10-21) |
| Asset | `cua-driver-rs-0.38.0-windows-x86_64.zip` (35,894,668 bytes) |
| sha256 | `997f20114ad3db227a854e1e5a886234f76405b155f4af70605d4b7ca4a436a1` (recorded live from the GitHub API 2026-10-25 — spec U1 resolved; cross-checked against the release's own `SHA256SUMS` at install time) |
| Binary | `cua-driver.exe` (+ optional `cua-driver-uia.exe`, `cua-cursor-theme.exe` in the zip) — Authenticode "Cua AI, Inc." |
| Install slot | `<DATA_DIR>/bin/cua-driver/0.38.0/` (`DATA_DIR` = `MANUS_LOCAL_DATA_DIR`/`LOAM_DATA_DIR`, else `<repo>/data`; packaged app: `userData/data`) |

The same constants live in `src/tools/cuaDriverAllowlist.ts` (asserted by
`check:cua-allowlist`). Change them together.

## Install / verify

```bash
node scripts/install-cua-driver.mjs
```

What the script enforces (§6.7; appendix B8/B9):

1. **Detect first (OD-7c):** an existing official install (`where cua-driver` or
   `~/.cua-driver/packages/current`) is reported; the Loam pin is still preferred.
2. **Download** the pinned GitHub asset via Node `fetch` — **never** `irm | iex`.
3. **Verify sha256 twice:** against the recorded constant *and* against the
   release's own `SHA256SUMS`; size must match the recorded byte count.
4. **Extract** into the versioned data-dir slot, `Unblock-File` (drops MOTW so the
   signed binary does not trip SmartScreen), warn-only Authenticode check, and a
   `--version` spawn probe; `pin.json` records both asset and exe digests.

## Enabling (after the wiring phase)

```json
"mcpServers": {
  "cua-driver": {
    "command": "<DATA>/bin/cua-driver/0.38.0/cua-driver.exe",
    "args": ["mcp"],
    "env": { "CUA_DRIVER_PERMISSION_MODE": "standard" },
    "allowlist": true
  }
}
```

Notes:

- `CUA_DRIVER_PERMISSION_MODE` is **always** `standard`; `unrestricted` is never
  settable from Loam automation (OD-4 / D7).
- Only the 14 allowlisted contract tools register, clamped inside Loam — a
  compromised catalogue cannot widen the surface without a Loam code change.
- Everything else in the cua monorepo is out of scope: Spaces/spacesd (FSL),
  Lume (macOS-only), cua-perception/som (AGPL — never redistribute), cuabot
  (forbidden), full 96-tool Spaces MCP.
