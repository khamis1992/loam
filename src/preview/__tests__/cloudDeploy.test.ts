import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectStaticBundle, deployStatic, callsSameOriginApi, safeProjectName, redactToken } from "../cloudDeploy.js";

const TOKEN = "tok_TEST_never_real_123";
function site(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-cloud-"));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  return dir;
}
type Call = { url: string; init: RequestInit | undefined };
function fakeFetch(responses: Array<{ status?: number; body: unknown }>, calls: Call[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const noSleep = async () => {};

test("the bundle skips secrets, engine folders and requires index.html", () => {
  const dir = site({ "index.html": "<h1>hi</h1>", "app.js": "1", ".env": "SECRET=1", ".env.local": "x", ".loam/swarm/x.md": "r", "node_modules/a/i.js": "x", ".git/config": "x" });
  const bundle = collectStaticBundle(dir);
  assert.deepEqual(bundle.files.map(f => f.name).sort(), ["app.js", "index.html"]);
  assert.throws(() => collectStaticBundle(site({ "a.html": "x" })), /index\.html/);
});

test("Vercel: inline files, polling to READY, bearer token only in headers", async () => {
  const calls: Call[] = [];
  const out = await deployStatic({ target: "vercel", dir: site({ "index.html": "<p>ok</p>" }), projectName: "Loam Demo!", token: TOKEN, production: false, sleep: noSleep,
    fetchImpl: fakeFetch([{ body: { id: "dpl_1", readyState: "BUILDING", url: "loam-demo.vercel.app" } }, { body: { readyState: "READY", url: "loam-demo.vercel.app" } }], calls) });
  assert.equal(out.ok, true);
  assert.equal(out.url, "https://loam-demo.vercel.app");
  assert.match(calls[0]!.url, /^https:\/\/api\.vercel\.com\/v13\/deployments\?skipAutoDetectionConfirmation=1/);
  const body = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(body.name, "loam-demo");
  assert.equal(body.files[0].encoding, "base64");
  assert.equal(body.target, undefined, "preview unless production was requested");
  assert.ok(!calls.some(c => c.url.includes(TOKEN)));
});

test("Netlify: creates a site, uploads a zip, polls to ready", async () => {
  const calls: Call[] = [];
  const out = await deployStatic({ target: "netlify", dir: site({ "index.html": "<p>ok</p>" }), projectName: "demo", token: TOKEN, production: false, sleep: noSleep,
    fetchImpl: fakeFetch([{ body: { id: "site_1" } }, { body: { id: "dep_1", state: "uploaded" } }, { body: { state: "ready", ssl_url: "https://demo.netlify.app" } }], calls) });
  assert.equal(out.ok, true);
  assert.equal(out.siteId, "site_1");
  assert.equal(out.url, "https://demo.netlify.app");
  assert.equal((calls[1]!.init!.headers as Record<string, string>)["content-type"], "application/zip");
  assert.match(calls[1]!.url, /\/sites\/site_1\/deploys$/);
});

test("provider errors are reported with the token redacted", async () => {
  const out = await deployStatic({ target: "vercel", dir: site({ "index.html": "x" }), projectName: "d", token: TOKEN, production: true, sleep: noSleep,
    fetchImpl: fakeFetch([{ status: 403, body: { error: { message: `bad token ${TOKEN}` } } }], []) });
  assert.equal(out.ok, false);
  assert.ok(!out.message.includes(TOKEN));
  const thrown = await deployStatic({ target: "netlify", dir: site({ "index.html": "x" }), projectName: "d", token: TOKEN, production: false, siteId: "s", sleep: noSleep,
    fetchImpl: (async () => { throw new Error(`network down for ${TOKEN}`); }) as typeof fetch });
  assert.equal(thrown.ok, false);
  assert.match(thrown.message, /\[redacted\]/);
});

test("helpers", () => {
  assert.equal(callsSameOriginApi("<script>fetch('/tasks')</script>"), true);
  assert.equal(callsSameOriginApi("<script>fetch('api/x')</script>"), true);
  assert.equal(callsSameOriginApi("<script>fetch('https://example.com/x')</script>"), false);
  assert.equal(safeProjectName("***"), "loam-app");
  assert.equal(redactToken("a tok b tok", "tok"), "a [redacted] b [redacted]");
});
