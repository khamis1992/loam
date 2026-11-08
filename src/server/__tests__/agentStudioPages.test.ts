import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let server: http.Server;
let base = "";
let closeDb: () => void;
let tmpDir = "";
const previousProtocolPort = process.env.AS_PROTOCOL_PORT;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-agent-studio-pages-"));
  const workspace = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const configPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    workspace,
    memory: { enabled: false },
    screen: { enabled: false },
    selfImprove: { enabled: false },
    computerUse: { enabled: false },
    mcpServers: {},
  }), "utf8");
  process.env.MANUS_LOCAL_DATA_DIR = path.join(tmpDir, "data");
  process.env.MANUS_LOCAL_SKILLS_DIR = path.join(tmpDir, "skills");
  process.env.MANUS_LOCAL_EVALS_DIR = path.join(tmpDir, "evals");
  process.env.LOAM_CONFIG = configPath;
  process.env.LOAM_LOCAL_TOKEN_DIR = path.join(tmpDir, "token");
  process.env.AS_PROTOCOL_PORT = "18787";

  const [{ loadConfig }, { OllamaClient }, { startServer }, sqlite] = await Promise.all([
    import("../../config.js"),
    import("../../ollama.js"),
    import("../http.js"),
    import("../sqliteStore.js"),
  ]);
  const cfg = loadConfig();
  cfg.server.host = "127.0.0.1";
  cfg.server.port = 0;
  server = await startServer({
    cfg,
    ollama: new OllamaClient("http://127.0.0.1:1"),
    runTask: async () => ({ taskId: "test", text: "" }),
  });
  closeDb = sqlite.closeDb;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const key of ["MANUS_LOCAL_DATA_DIR", "MANUS_LOCAL_SKILLS_DIR", "MANUS_LOCAL_EVALS_DIR", "LOAM_CONFIG", "LOAM_LOCAL_TOKEN_DIR"]) {
    delete process.env[key];
  }
  if (previousProtocolPort === undefined) delete process.env.AS_PROTOCOL_PORT;
  else process.env.AS_PROTOCOL_PORT = previousProtocolPort;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Agent Studio web pages", () => {
  it("serves the desktop Next.js home with the browser runtime", async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<title>Loam<\/title>/);
    assert.doesNotMatch(html, /LOAM COMMAND/);
    assert.match(html, /window\.__AGENT_STUDIO_ENV__/);
    assert.match(html, /"apiBase":"http:\/\/127\.0\.0\.1:18787"/);
    assert.ok(html.includes(`"loamBase":${JSON.stringify(base)}`));
    assert.doesNotMatch(html, /loamToken/);
  });

  for (const route of ["/app", "/login", "/legal", "/app/session-123", "/app/session-123/"]) {
    it(`serves ${route} from the same export`, async () => {
      const res = await fetch(`${base}${route}`);
      const html = await res.text();
      assert.equal(res.status, 200);
      assert.match(html, /window\.__AGENT_STUDIO_ENV__/);
      assert.match(html, /<html lang="en"/);
    });
  }

  it("serves Next static assets without the install token", async () => {
    const home = await (await fetch(`${base}/`)).text();
    const css = home.match(/href="(\/_next\/[^"]+\.css)"/)?.[1];
    assert.ok(css);
    const res = await fetch(`${base}${css}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/);
  });

  it("serves the shared interface's public images", async () => {
    const res = await fetch(`${base}/templates/anime.png`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /image\/png/);
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
  });

  it("keeps the legacy command workspace on its explicit entry point", async () => {
    const res = await fetch(`${base}/index.html`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /LOAM COMMAND/);
    assert.doesNotMatch(html, /window\.__AGENT_STUDIO_ENV__/);
  });

  it("keeps legacy studio documents available without injecting the app runtime", async () => {
    const res = await fetch(`${base}/office-preview.html`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.doesNotMatch(html, /window\.__AGENT_STUDIO_ENV__/);
  });

  it("does not make protected API routes public", async () => {
    const res = await fetch(`${base}/api/config`);
    assert.equal(res.status, 401);
  });
});
