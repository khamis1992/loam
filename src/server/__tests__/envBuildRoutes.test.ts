import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { describe, it, before, after } from "node:test";

const SECRET_NAME = "API_KEY";
const SECRET_VALUE = "sk-live-env-route-secret-VALUE-99";

let tmpDir = "";

interface Captured {
  status?: number;
  body?: unknown;
  text?: string;
}

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = {};
  const res = {
    writeHead(status: number) { captured.status = status; return res; },
    end(text?: unknown) {
      if (text === undefined) { captured.body = undefined; return; }
      const raw = String(text);
      captured.text = raw;
      try { captured.body = JSON.parse(raw); } catch { captured.body = undefined; }
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

async function call(method: string, p: string): Promise<Captured> {
  const { handleEnvBuildRoutes } = await import("../routes/envBuilds.js");
  const req = { method } as unknown as http.IncomingMessage;
  const { res, captured } = fakeRes();
  const handled = await handleEnvBuildRoutes(req, res, p);
  assert.equal(handled, true, `${method} ${p} must be handled by the module`);
  return captured;
}

function writeProject(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }, null, 1), "utf8");
  fs.writeFileSync(path.join(dir, "index.js"), "console.log('demo');\n", "utf8");
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "demo", lockfileVersion: 3 }), "utf8");
}

describe("env build status routes", () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-envroute-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("GET /api/env-builds/:projectId reports the build, staleness and a redacted log", async () => {
    const dir = path.join(tmpDir, "routeproj");
    writeProject(dir);
    fs.writeFileSync(path.join(dir, "loam.env.yaml"), `setup: [echo ok]\nsecrets: [${SECRET_NAME}]\n`, "utf8");

    const { setSecret } = await import("../secretsVault.js");
    assert.equal(setSecret("agent_env_route_test", SECRET_NAME, SECRET_VALUE), true);

    const env = await import("../../tools/envSnapshot.js");
    const { loadConfig } = await import("../../config.js");
    const result = await env.buildEnvSnapshot("routeproj", dir, env.readBlueprint(dir), loadConfig(), {
      scope: "agent_env_route_test",
      spawn: async (_command, _cwd, childEnv) => ({
        code: 0,
        stdout: `installed with ${childEnv.LOAM_VAULT_API_KEY}\n`,
        stderr: "",
      }),
    });
    assert.equal(result.ok, true);

    const cap = await call("GET", "/api/env-builds/routeproj");
    assert.equal(cap.status, 200);
    const data = cap.body as { build: { projectId: string; status: string; stepsRun: number }; current: boolean; stale: boolean; text: string };
    assert.equal(data.build.projectId, "routeproj");
    assert.equal(data.build.status, "built");
    assert.equal(data.build.stepsRun, 1);
    assert.equal(data.current, true, "an unchanged blueprint must report as current");
    assert.equal(data.stale, false);
    assert.ok(!JSON.stringify(cap.body).includes(SECRET_VALUE), "no route payload may carry a secret value");

    const log = await call("GET", "/api/env-builds/routeproj/log");
    assert.equal(log.status, 200);
    assert.ok(!String(log.text).includes(SECRET_VALUE), "the log endpoint must never return a secret value");
    assert.match(String(log.text), /\[vault:API_KEY\]/);

    // A lockfile change flips the snapshot to stale.
    fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "demo", lockfileVersion: 3, changed: true }), "utf8");
    const stale = await call("GET", "/api/env-builds/routeproj");
    assert.equal((stale.body as { stale: boolean }).stale, true, "a lockfile change must report the snapshot as stale");
  });

  it("GET /api/env-builds lists builds newest first", async () => {
    const cap = await call("GET", "/api/env-builds");
    assert.equal(cap.status, 200);
    const builds = (cap.body as { builds: Array<{ projectId: string }> }).builds;
    assert.ok(builds.some((b) => b.projectId === "routeproj"), "the built project must appear in the list");
    assert.ok(!JSON.stringify(cap.body).includes(SECRET_VALUE));
  });

  it("unknown project ids 404 and traversal ids 400", async () => {
    const missing = await call("GET", "/api/env-builds/never-built");
    assert.equal(missing.status, 404);
    const bad = await call("GET", "/api/env-builds/%2e%2e%2fetc");
    assert.equal(bad.status, 400, "a traversal project id must be rejected, never resolved");
  });
});
