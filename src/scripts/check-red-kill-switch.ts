/**
 * End-to-end kill-switch API check: starts Loam's real HTTP server, then drives
 * GET/POST /api/security/red/kill-switch exactly as the security-page button does.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../config.js";
import { startServer } from "../server/http.js";

process.env.LOAM_AUTH_DISABLED = "true";
const cfg = loadConfig();
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-red-kill-api-"));
cfg.workspace = workspace;
cfg.server = { ...cfg.server, host: "127.0.0.1", port: 0 };
if (cfg.runGraph) cfg.runGraph.enabled = false;

const server = await startServer({
  cfg,
  ollama: {} as never,
  runTask: async () => ({ taskId: "kill-switch-check", text: "" }),
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;

try {
  const initial = await (await fetch(`${base}/api/security/red/kill-switch`)).json() as { engaged: boolean };
  assert.equal(initial.engaged, false);

  const engaged = await (await fetch(`${base}/api/security/red/kill-switch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engage: true }),
  })).json() as { engaged: boolean };
  assert.equal(engaged.engaged, true);

  const after = await (await fetch(`${base}/api/security/red/kill-switch`)).json() as { engaged: boolean };
  assert.equal(after.engaged, true);

  const reset = await (await fetch(`${base}/api/security/red/kill-switch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engage: false }),
  })).json() as { engaged: boolean };
  assert.equal(reset.engaged, false);

  const crossSite = await fetch(`${base}/api/security/red/kill-switch`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ engage: true }),
  });
  assert.equal(crossSite.status, 403, "cross-site state changes are refused");

  console.log("check:red:kill-switch PASS — real HTTP engage/read/reset + cross-site denial");
} finally {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
}
