# Loam MCP Bridge

The optional local adapter exposes installed Ruflo and AgentDB backends through
standard MCP Streamable HTTP. It uses SDK initialization, tool listing and calls;
a successful HTTP GET alone is not considered a working MCP connection.

Run `node addons/loam-bridge/server.mjs`. Defaults:

- Listen: `127.0.0.1:3002`, endpoint `/mcp`, diagnostic endpoint `/health`.
- `LOAM_MCP_BRIDGE_PORT` overrides the port. Occupied ports fail without killing
  another service. Port 3001 on the development machine was another listener:
  POST initialize at `/mcp` returned 404.
- `LOAM_RUFLO_ROOT` selects an existing installation; otherwise the adapter checks
  `<home>/ruflo-opencode`. No backend packages are downloaded automatically.
- `LOAM_DATA_DIR/mcp-bridge` owns backend working data. Without this variable,
  `./data/mcp-bridge` is used. AgentDB gets its own database there; existing
  external databases are not migrated, reset or exposed automatically.

Required backend entries relative to the installation:

```
v3/@claude-flow/cli/bin/mcp-server.js
node_modules/agentdb/dist/src/mcp/agentdb-mcp-server.js
```

Ruflo also needs its built `v3/@claude-flow/cli/dist/src/mcp-client.js` and imported
modules. The development installation was missing these outputs and was repaired
by compiling its existing TypeScript source with the installed compiler. The
installer does not ship Ruflo or repair other installations automatically.

The AgentDB distribution omitted schema SQL assets and silently skipped its
schema initialization. Loam invokes its idempotent `agentdb_init` with
`reset: false` against Loam's dedicated database before advertising that backend.

HTTP configuration in Loam:

```json
{"loam-bridge":{"transport":"http","url":"http://127.0.0.1:3002/mcp"}}
```

Existing stdio configurations remain supported. HTTP configurations may specify
`headers` for a separately authenticated endpoint. Do not commit credentials.
Tool names include the real owner (`ruflo__...`, `agentdb__...`) for unambiguous
routing. Loam registry names add `mcp__loam-bridge__`. These administrative tools
are not granted to task modes by establishing a connection.

`/health` returns `application: "Loam MCP Bridge"`, `backendCount`, `backends`,
`tools`, and `unavailable`. Inspect `unavailable` even when another backend works.
Missing installations remain explicitly unavailable. Cross-origin requests and
unexpected Host headers are rejected. The listener is loopback-only.

The desktop process owns its launched bridge. IPC `{ "type": "shutdown" }`,
parent IPC disconnect, SIGINT and SIGTERM close clients and their child processes.

Verification: `npx tsx src/scripts/check-mcp.ts` starts an owned temporary-port
bridge and isolated data directory, checks initialize/list/ping and real read-only
backend calls, validates error handling and cross-origin denial, checks Ask-mode
tool isolation, then shuts down its own bridge. Missing optional backends print
UNVERIFIED and are never reported as tested.

Observed locally: 278 tools (246 Ruflo and 32 AgentDB); both `system_status` and
`db_stats` succeeded. This proves the bridge and sampled calls, not the behavior
of all 278 tools or external services those tools may depend on.
