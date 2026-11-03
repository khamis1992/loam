# Remote MCP presets (blueprint gap 5)

One-line BYOK entries for the blueprint's reference external servers — the
transport itself (Streamable HTTP) was already in `src/tools/mcp.ts`; what was
missing is the curated glue so a user never hand-writes headers.

## Usage

config.json:

```json
"mcpServers": {
  "supabase": { "preset": "supabase" },
  "vercel":   { "preset": "vercel" },
  "drive":    { "preset": "google-drive" }
}
```

Then set the key on the Loam server (BYOK — keys live in the environment, not
in config.json):

| Preset | Env var | Endpoint |
|--------|---------|----------|
| `supabase` | `LOAM_SUPABASE_PAT` | https://mcp.supabase.com/mcp |
| `vercel` | `VERCEL_MCP_TOKEN` | https://mcp.vercel.com |
| `google-drive` | `LOAM_GOOGLE_MCP_TOKEN` | https://mcp.google.com/drive/mcp |
| `google-mail` | `LOAM_GOOGLE_MCP_TOKEN` | https://mcp.google.com/gmail/mcp |

## Semantics

- **User fields always win**: `{"preset":"vercel","url":"https://internal/mcp"}`
  keeps your URL and only borrows the auth header/lazy defaults.
- **Header tokens**: values may embed `${ENV:NAME}`; they resolve at connect
  time (`expandEnvHeaders`). A missing key fails that one server with a message
  naming the variable — values are never echoed, and boot never crashes.
- **Lazy by default**: these catalogues stay out of the prompt; the `mcp_*`
  bridge tools reach them (matches the lazy-MCP surface).
- Unknown preset ids are dropped with a warning listing the known ones.

## Gates

`node --import tsx --test src/tools/__tests__/mcpPresets.test.ts` (5 tests),
plus `check:mcp` which re-proves initialize/list/ping/routing/origin guards.
