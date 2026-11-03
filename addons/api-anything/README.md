# api-anything (vendored)

Upstream: https://github.com/goodnight000/api-anything (MIT, Copyright (c) 2026 Tianjun Zheng).
Pinned commit and lockfile hash: `UPSTREAM.json`.

`npm run vendor:api-anything` clones the pinned commit, verifies the commit and the
lockfile SHA-256, installs with `npm ci --ignore-scripts`, builds `dist/` with the
project's own TypeScript, prunes dev dependencies and copies the result to `pkg/`.
Loam runs `pkg/dist/cli.js mcp` as a stdio MCP server and `pkg/dist/cli.js <command>`
for the learn tools. Nothing here is fetched at runtime.

To move to a newer upstream commit: change `commit` and `packageLockSha256` in
`UPSTREAM.json` only after Khamis approves the upstream diff (OD-9), then run
`npm run vendor:api-anything -- --force && npm run test:api-anything`.
