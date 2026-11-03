# REA pin — external MCP server (OD-2, OD-5)

Status: pinned, install scripted, not yet wired into `mcpServers` (lands with the
reverse-engineer mode, REA_INTO_LOAM_INTEGRATION §5.2 / phases P1–P2).

## Pin

| Field | Value |
|---|---|
| Package | `rea-agents` (MIT) |
| Version | **6.7.0** — exact only; ranges and `@latest` are forbidden in committed config |
| npm `dist.integrity` | `sha512-yhIx2ioJYYT1C/tONfYeitC6LhnKmCh+ZwRUOgYuhSc733lGhkkt73zhug9WmLgxoMdKuqIYGCoBfD4fXkOhFw==` |
| bin | `rea` / `rea-agents` → `scripts/rea.mjs` |
| Install slot | `<DATA_DIR>/bin/rea-agents/6.7.0/` (`DATA_DIR` = `MANUS_LOCAL_DATA_DIR`/`LOAM_DATA_DIR`, else `<repo>/data`; packaged app: `userData/data`) |

The same version + integrity constants live in `src/tools/reaAllowlist.ts` (asserted by
`check:rea-allowlist`) and `scripts/install-rea-agents.mjs` (verified against the registry
before install). Change them together.

## Install / verify

```bash
node scripts/install-rea-agents.mjs
```

What the script enforces (§4.7, LiteLLM 1.107.0 lesson):

1. `npm view rea-agents@6.7.0 dist.integrity` must equal the recorded SRI **before** any fetch — a tampered registry aborts.
2. `npm install --prefix <slot> --ignore-scripts --no-audit --no-fund --omit=dev` — lifecycle scripts never run.
3. Installed `package.json` version and `scripts/rea.mjs` presence are re-checked; `pin.json` records `entrySha256`.
4. Idempotent: a slot with a matching `pin.json` is never re-fetched.

## Enabling (after P2)

```json
"mcpServers": {
  "rea": {
    "command": "node",
    "args": ["<absolute path to>/bin/rea-agents/6.7.0/node_modules/rea-agents/scripts/rea.mjs", "mcp"],
    "env": { "REA_MCP_INPUT_SCHEMA_PROFILE": "compact" },
    "allowlist": true
  }
}
```

Notes:

- `command: "node"` resolves to the running Electron/Node binary (`process.execPath`) in `src/tools/mcp.ts` — the packaged app never depends on a global npm prefix.
- The `${DATA}` placeholder for the data dir is introduced with the P2 wiring; until then use the absolute printed path.
- A compromised catalogue cannot widen the tool surface: Loam filters `tools/list` to the 13 allowlisted names and rejects non-allowlisted calls — enforcement lives inside Loam (`src/tools/reaAllowlist.ts`), never in the server.
