/**
 * Shared static-deploy core (staticDeploy.ts) + the real cloud DeployTargets
 * (deploy.ts) — the unification of the swarm launch path and the agent
 * deploy tool path onto one provider implementation.
 *
 *  - cloudDeploy.ts must re-export the shared module unchanged (identity).
 *  - deployStaticTo facade: provider dispatch, missing-token disabled path,
 *    inherited caps/secrets rules, and the same-origin-API refusal (G14).
 *  - createVercelDeployTarget/createNetlifyDeployTarget: real REST shapes on
 *    the enabled path (fake fetch), honest not-enabled report when the token
 *    env is absent, and deployBuild actually deploying credentialed targets.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import * as cloud from "../cloudDeploy.js";
import * as shared from "../staticDeploy.js";
import { deployStaticTo, PROVIDER_TOKEN_ENV } from "../staticDeploy.js";
import { createNetlifyDeployTarget, createVercelDeployTarget, deployBuild } from "../deploy.js";

const TOKEN = "tok_TEST_never_real_456";
const created: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-static-deploy-"));
  created.push(dir);
  return dir;
}

function site(files: Record<string, string>): string {
  const dir = tmpRoot();
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function makeBuildRoot(files: Record<string, string> = { "index.html": "<p>ok</p>" }): string {
  const root = tmpRoot();
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dist, name), content, "utf8");
  return root;
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

after(() => {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("cloudDeploy re-exports the shared implementation", () => {
  it("exports the same function/constant identities as staticDeploy", () => {
    assert.equal(cloud.deployStatic, shared.deployStatic);
    assert.equal(cloud.deployToVercel, shared.deployToVercel);
    assert.equal(cloud.deployToNetlify, shared.deployToNetlify);
    assert.equal(cloud.collectStaticBundle, shared.collectStaticBundle);
    assert.equal(cloud.callsSameOriginApi, shared.callsSameOriginApi);
    assert.equal(cloud.safeProjectName, shared.safeProjectName);
    assert.equal(cloud.redactToken, shared.redactToken);
    assert.equal(cloud.CLOUD_TARGETS, shared.CLOUD_TARGETS);
    assert.equal(cloud.MAX_DEPLOY_FILES, shared.MAX_DEPLOY_FILES);
    assert.deepEqual(PROVIDER_TOKEN_ENV, { vercel: "VERCEL_TOKEN", netlify: "NETLIFY_AUTH_TOKEN" });
  });
});

describe("deployStaticTo facade", () => {
  it("dispatches to Vercel with the same REST shape as the launch path", async () => {
    const calls: Call[] = [];
    const out = await deployStaticTo("vercel", site({ "index.html": "<p>ok</p>" }), {
      token: TOKEN, name: "Loam Demo!", production: true, sleep: noSleep,
      fetchImpl: fakeFetch([
        { body: { id: "dpl_9", readyState: "BUILDING", url: "loam-demo.vercel.app" } },
        { body: { readyState: "READY", url: "loam-demo.vercel.app" } },
      ], calls),
    });
    assert.equal(out.ok, true);
    assert.equal(out.url, "https://loam-demo.vercel.app");
    assert.match(calls[0]!.url, /^https:\/\/api\.vercel\.com\/v13\/deployments\?skipAutoDetectionConfirmation=1/);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${TOKEN}`);
    const body = JSON.parse(String(calls[0]!.init!.body));
    assert.equal(body.name, "loam-demo");
    assert.equal(body.files[0].encoding, "base64");
    assert.equal(body.target, "production", "production option is forwarded to Vercel");
    assert.ok(!calls.some((c) => c.url.includes(TOKEN)), "token never appears in URLs");
  });

  it("dispatches to Netlify: site creation, zip upload, poll to ready", async () => {
    const calls: Call[] = [];
    const out = await deployStaticTo("netlify", site({ "index.html": "<p>ok</p>" }), {
      token: TOKEN, sleep: noSleep,
      fetchImpl: fakeFetch([
        { body: { id: "site_9" } },
        { body: { id: "dep_9", state: "uploaded" } },
        { body: { state: "ready", ssl_url: "https://demo-9.netlify.app" } },
      ], calls),
    });
    assert.equal(out.ok, true);
    assert.equal(out.siteId, "site_9");
    assert.equal(out.url, "https://demo-9.netlify.app");
    assert.equal(calls[0]!.url, "https://api.netlify.com/api/v1/sites");
    assert.match(JSON.parse(String(calls[0]!.init!.body)).name, /^loam-static-deploy-/);
    assert.match(calls[1]!.url, /\/sites\/site_9\/deploys$/);
    assert.equal((calls[1]!.init!.headers as Record<string, string>)["content-type"], "application/zip");
  });

  it("derives the provider project name from the directory when none is given", async () => {
    const calls: Call[] = [];
    const dir = path.join(tmpRoot(), "My Site!");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "<p>ok</p>");
    const out = await deployStaticTo("vercel", dir, { token: TOKEN, sleep: noSleep,
      fetchImpl: fakeFetch([{ body: { id: "d1", readyState: "READY", url: "x.vercel.app" } }], calls) });
    assert.equal(out.ok, true);
    assert.equal(JSON.parse(String(calls[0]!.init!.body)).name, "my-site");
  });

  it("a missing token disables the deploy without any network call", async () => {
    for (const provider of ["vercel", "netlify"] as const) {
      const calls: Call[] = [];
      const out = await deployStaticTo(provider, site({ "index.html": "<p>ok</p>" }), {
        token: "", fetchImpl: fakeFetch([], calls),
      });
      assert.equal(out.ok, false);
      assert.equal(out.url, null);
      assert.equal(out.disabled, true);
      assert.match(out.message, new RegExp(PROVIDER_TOKEN_ENV[provider]));
      assert.deepEqual(calls, [], "nothing is attempted when the token is absent");
    }
  });

  it("inherits the shared caps: oversized files and missing index.html are refused pre-flight", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch([], calls);
    const big = Buffer.alloc(shared.MAX_FILE_BYTES + 1, 97);
    const heavyDir = site({ "index.html": "<p>ok</p>" });
    fs.writeFileSync(path.join(heavyDir, "big.bin"), big);
    const oversized = await deployStaticTo("vercel", heavyDir, { token: TOKEN, fetchImpl });
    assert.equal(oversized.ok, false);
    assert.match(oversized.message, /exceeds/);
    const noIndex = await deployStaticTo("netlify", site({ "a.html": "x" }), { token: TOKEN, fetchImpl });
    assert.equal(noIndex.ok, false);
    assert.match(noIndex.message, /index\.html/);
    assert.deepEqual(calls, [], "cap and shape refusals happen before any provider call");
  });

  it("refuses UIs that call their own server API (G14 static-only rule)", async () => {
    for (const html of ["<script>fetch('/tasks')</script>", "<script>fetch('api/x')</script>", "<script>new XMLHttpRequest()</script>"]) {
      const calls: Call[] = [];
      const out = await deployStaticTo("vercel", site({ "index.html": html }), {
        token: TOKEN, fetchImpl: fakeFetch([{ body: { id: "d", readyState: "READY" } }], calls),
      });
      assert.equal(out.ok, false, html);
      assert.equal(out.refused, "same-origin-api");
      assert.equal(out.url, null);
      assert.match(out.message, /static hosting would break it/);
      assert.deepEqual(calls, [], "no provider call survives the same-origin refusal");
    }
  });

  it("the same-origin refusal also covers non-index html pages", async () => {
    const calls: Call[] = [];
    const out = await deployStaticTo("netlify", site({ "index.html": "<a href='about.html'>", "about.html": "<script>fetch('/me')</script>" }), {
      token: TOKEN, fetchImpl: fakeFetch([], calls),
    });
    assert.equal(out.ok, false);
    assert.equal(out.refused, "same-origin-api");
    assert.deepEqual(calls, []);
  });
});

describe("real cloud DeployTargets", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const saveEnv = (...names: string[]): void => {
    for (const name of names) { savedEnv[name] = process.env[name]; delete process.env[name]; }
  };
  const restoreEnv = (): void => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  after(restoreEnv);

  it("Vercel target deploys for real when a token is available (same REST shape)", async () => {
    saveEnv("VERCEL_TOKEN", "VERCEL_TEAM_ID");
    const calls: Call[] = [];
    const build = makeBuildRoot({ "index.html": "<p>ok</p>", "app.js": "1" });
    const target = createVercelDeployTarget({ token: TOKEN, fetchImpl: fakeFetch([
      { body: { id: "dpl_t", readyState: "BUILDING", url: "t.vercel.app" } },
      { body: { readyState: "READY", url: "t.vercel.app" } },
    ], calls), sleep: noSleep });
    assert.ok(!target.describe().includes("غير مفعّل"), "describe() reports the enabled state");
    const result = await target.deploy({ buildDir: path.join(build, "dist"), taskId: "task_v9" });
    assert.equal(result.ok, true);
    assert.equal(result.url, "https://t.vercel.app");
    assert.equal(result.target, "vercel");
    assert.equal(result.files, 2);
    assert.deepEqual(result.missingEnv, []);
    assert.match(calls[0]!.url, /^https:\/\/api\.vercel\.com\/v13\/deployments\?skipAutoDetectionConfirmation=1$/);
    const body = JSON.parse(String(calls[0]!.init!.body));
    assert.equal(body.name, "loam-task-v9");
    assert.equal(body.files.length, 2);
    assert.equal(body.files[0].encoding, "base64");
    assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
    assert.equal(body.target, undefined, "agent deploys default to a preview target, not production");
  });

  it("Netlify target deploys for real when NETLIFY_AUTH_TOKEN is in the environment", async () => {
    saveEnv("NETLIFY_AUTH_TOKEN", "NETLIFY_SITE_ID");
    process.env.NETLIFY_AUTH_TOKEN = TOKEN;
    const calls: Call[] = [];
    const root = makeBuildRoot();
    const target = createNetlifyDeployTarget({ fetchImpl: fakeFetch([
      { body: { id: "site_t" } },
      { body: { id: "dep_t", state: "uploaded" } },
      { body: { state: "ready", ssl_url: "https://loam-task-n1.netlify.app" } },
    ], calls), sleep: noSleep });
    const outcome = await deployBuild(root, "task_n1", target);
    assert.equal(outcome.result.ok, true, "deployBuild runs the real deploy once credentials exist");
    assert.equal(outcome.result.url, "https://loam-task-n1.netlify.app");
    assert.equal(calls[0]!.url, "https://api.netlify.com/api/v1/sites");
    assert.match(JSON.parse(String(calls[0]!.init!.body)).name, /^loam-task-n1-/);
    assert.match(calls[1]!.url, /\/sites\/site_t\/deploys$/);
    assert.equal((calls[1]!.init!.headers as Record<string, string>)["content-type"], "application/zip");
    assert.ok(!calls.some((c) => c.url.includes(TOKEN)), "token stays out of URLs");
  });

  it("deployBuild deploys credentialed cloud targets instead of refusing them", async () => {
    saveEnv("VERCEL_TOKEN");
    process.env.VERCEL_TOKEN = TOKEN;
    const calls: Call[] = [];
    const root = makeBuildRoot();
    const outcome = await deployBuild(root, "task_e2e", createVercelDeployTarget({
      fetchImpl: fakeFetch([{ body: { id: "d2", readyState: "READY", url: "e2e.vercel.app" } }], calls), sleep: noSleep,
    }));
    assert.equal(outcome.result.ok, true);
    assert.equal(outcome.result.url, "https://e2e.vercel.app");
    assert.deepEqual(outcome.result.missingEnv, []);
    assert.equal(calls.length, 1, "the provider was actually called");
  });

  it("honest not-enabled report when the token env is absent (nothing attempted)", async () => {
    saveEnv("VERCEL_TOKEN", "NETLIFY_AUTH_TOKEN");
    const build = makeBuildRoot();
    const calls: Call[] = [];
    const fetchImpl = fakeFetch([], calls);
    const vercel = await createVercelDeployTarget({ fetchImpl }).deploy({ buildDir: path.join(build, "dist"), taskId: "task_off" });
    assert.equal(vercel.ok, false);
    assert.equal(vercel.url, null);
    assert.deepEqual(vercel.missingEnv, ["VERCEL_TOKEN"]);
    assert.match(vercel.message, /VERCEL_TOKEN/);
    const netlify = await createNetlifyDeployTarget({ fetchImpl }).deploy({ buildDir: path.join(build, "dist"), taskId: "task_off" });
    assert.equal(netlify.ok, false);
    assert.deepEqual(netlify.missingEnv, ["NETLIFY_AUTH_TOKEN"]);
    assert.match(netlify.message, /NETLIFY_AUTH_TOKEN/);
    assert.ok(createVercelDeployTarget().describe().includes("غير مفعّل"), "describe() stays honest when disabled");
    assert.ok(createNetlifyDeployTarget().describe().includes("غير مفعّل"));
    assert.deepEqual(calls, [], "no provider call happens while disabled");
  });

  it("the agent path inherits the same-origin refusal through the target", async () => {
    saveEnv("VERCEL_TOKEN");
    const calls: Call[] = [];
    const build = makeBuildRoot({ "index.html": "<script>fetch('/api/tasks')</script>" });
    const result = await createVercelDeployTarget({ token: TOKEN, fetchImpl: fakeFetch([], calls), sleep: noSleep })
      .deploy({ buildDir: path.join(build, "dist"), taskId: "task_api" });
    assert.equal(result.ok, false);
    assert.equal(result.url, null);
    assert.match(result.message, /static hosting would break it/);
    assert.deepEqual(calls, [], "the swarm's static-only guard blocks the agent deploy path too");
  });

  it("token redaction is inherited on provider failures", async () => {
    saveEnv("VERCEL_TOKEN");
    const build = makeBuildRoot();
    const result = await createVercelDeployTarget({ token: TOKEN, sleep: noSleep,
      fetchImpl: fakeFetch([{ status: 403, body: { error: { message: `bad token ${TOKEN}` } } }], []) })
      .deploy({ buildDir: path.join(build, "dist"), taskId: "task_red" });
    assert.equal(result.ok, false);
    assert.ok(!result.message.includes(TOKEN), "the provider token never leaks into result messages");
    assert.match(result.message, /\[redacted\]/);
  });
});
