import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { capBytes, classifyCliExit, classifyGraphifyText } from "../budget.js";
import { CODEGRAPH_DEFAULTS, GRAPHIFY_MCP_ALLOWLIST, resolveCodeGraphConfig } from "../config.js";
import { buildChildEnv, FORBIDDEN_ENV_PATTERN } from "../env.js";
import { collapseExcludes, prescan } from "../excludes.js";
import { projectIdFor } from "../paths.js";
import { readBuiltAtCommit, readGraphMeta } from "../staleness.js";
import { CODEGRAPH_TOOL_NAMES, createCodeGraphTools } from "../tools.js";
import { CodeGraphService } from "../service.js";
import { findStartupHooks, installPlan, installRuntime, pinFileContent, sha256File } from "../runtime.js";

test("child env is an allowlist: no API keys, LLM backends off, query log off", () => {
  const env = buildChildEnv({
    source: { PATH: "/x", HOME: "/h", OPENAI_API_KEY: "sk-1", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", OPENCODE_API_KEY: "o", AWS_SECRET_ACCESS_KEY: "s", GRAPHIFY_OUT: "/evil", GITHUB_TOKEN: "t" },
    pathPrepend: ["/venv/bin"], platform: "linux",
  });
  for (const k of Object.keys(env)) assert.ok(!FORBIDDEN_ENV_PATTERN.test(k), `leaked ${k}`);
  assert.equal(env.GRAPHIFY_BACKEND, "none");
  assert.equal(env.GRAPHIFY_QUERY_LOG_DISABLE, "1");
  assert.equal(env.PATH, "/venv/bin:/usr/bin:/bin");
});

test("windows child env uses Path with System32 and keeps SystemRoot", () => {
  const env = buildChildEnv({ source: { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\k", OPENAI_API_KEY: "x" }, pathPrepend: ["C:\\v\\Scripts"], gitDir: "C:\\Program Files\\Git\\cmd", platform: "win32" });
  assert.equal(env.Path, "C:\\v\\Scripts;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Windows");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("config clamps out-of-range values and keeps defaults", () => {
  const c = resolveCodeGraphConfig({ maxWorkers: 99, maxResultBytes: 1, queryTimeoutMs: Number.NaN });
  assert.equal(c.maxWorkers, 16);
  assert.equal(c.maxResultBytes, 4096);
  assert.equal(c.queryTimeoutMs, CODEGRAPH_DEFAULTS.queryTimeoutMs);
  assert.equal(c.enabled, false);
});

test("allowlist excludes the gh-backed PR tools", () => {
  assert.deepEqual([...GRAPHIFY_MCP_ALLOWLIST].sort(), ["get_community", "get_neighbors", "get_node", "god_nodes", "graph_stats", "query_graph", "shortest_path"]);
});

test("capBytes is UTF-8 safe on Arabic text and appends a notice", () => {
  const s = "خريطة الكود ".repeat(2000);
  const r = capBytes(s, 4096, "narrow it");
  assert.ok(r.truncated);
  assert.ok(r.bytes <= 4096);
  assert.ok(!r.text.includes("\uFFFD"));
  assert.match(r.text, /output cut at 4096 bytes/);
});

test("outcome classification matches graphify's literal prefixes and exit codes", () => {
  assert.equal(classifyGraphifyText("Ambiguous: 'run' matches 3 nodes", false), "ambiguous");
  assert.equal(classifyGraphifyText("No node matching 'zz' found.", false), "not-found");
  assert.equal(classifyGraphifyText("No path found between 'a' and 'b'.", false), "not-found");
  assert.equal(classifyGraphifyText("Error executing get_node: boom", false), "error");
  assert.equal(classifyGraphifyText("x\n[!] TRUNCATED: showing 35 of 1659", false), "truncated");
  assert.equal(classifyGraphifyText("Node: X", false), "answer");
  assert.equal(classifyCliExit(0), "answer");
  assert.equal(classifyCliExit(3), "ambiguous");
  assert.equal(classifyCliExit(4), "not-found");
  assert.equal(classifyCliExit(1), "error");
});

test("prescan excludes oversized code files and collapses dense directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-pre-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "gen"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "huge.cjs"), "x".repeat(60_000));
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, "gen", `g${i}.js`), "y".repeat(60_000));
  fs.mkdirSync(path.join(root, "node_modules", "p"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "p", "z.js"), "z".repeat(60_000));
  const r = prescan(root, { maxCodeFileBytes: 50_000, excludes: [] });
  assert.equal(r.codeFiles, 1);
  assert.equal(r.oversized.length, 11);
  assert.deepEqual(r.excludeArgs, ["--exclude", "gen/**", "--exclude", "src/huge.cjs"]);
  assert.deepEqual(collapseExcludes(["a[1].ts"]), ["--exclude", "a\\[1\\].ts"]);
});

test("built_at_commit is read from the last 4 KiB; meta from the first 512 bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-g-"));
  const f = path.join(dir, "graph.json");
  const body = { directed: false, multigraph: false, graph: { schema_version: 1, graphify_version: "0.9.95" }, nodes: Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, label: `N${i}` })), links: [], hyperedges: [], built_at_commit: "5227df4300338547d8f5f942d38b67c6d77622a1" };
  fs.writeFileSync(f, JSON.stringify(body));
  assert.equal(readBuiltAtCommit(f), "5227df4300338547d8f5f942d38b67c6d77622a1");
  assert.deepEqual(readGraphMeta(f), { schemaVersion: 1, graphifyVersion: "0.9.95" });
  assert.equal(readBuiltAtCommit(path.join(dir, "missing.json")), null);
});

test("project ids are stable and case-insensitive on Windows", () => {
  assert.equal(projectIdFor("C:\\Users\\khamis\\Desktop\\manus-local", "win32"), projectIdFor("c:\\users\\KHAMIS\\desktop\\Manus-Local", "win32"));
  assert.match(projectIdFor("/tmp/x", "linux"), /^[0-9a-f]{16}$/);
});

test("tool surface: 9 codegraph_* tools with required args declared", () => {
  const svc = new CodeGraphService({ home: fs.mkdtempSync(path.join(os.tmpdir(), "cg-h-")) });
  const tools = createCodeGraphTools(svc);
  assert.deepEqual(tools.map((t) => t.name), [...CODEGRAPH_TOOL_NAMES]);
  const req = Object.fromEntries(tools.map((t) => [t.name, (t.parameters as { required?: string[] }).required ?? []]));
  assert.deepEqual(req.codegraph_query, ["question"]);
  assert.deepEqual(req.codegraph_path, ["from", "to"]);
  for (const t of tools) assert.ok(!/sparkle/i.test(t.description));
});

test("disabled feature answers with a not-indexed fallback instead of throwing", async () => {
  const svc = new CodeGraphService({ home: fs.mkdtempSync(path.join(os.tmpdir(), "cg-h-")) });
  const r = await svc.query(os.tmpdir(), { kind: "stats" });
  assert.equal(r.outcome, "not-indexed");
  assert.equal(r.ok, false);
  assert.throws(() => svc.indexer.requestIndex(os.tmpdir(), "user"), /disabled/);
});

test("start-up hook tripwire finds .pth / sitecustomize in both venv layouts", () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), "cg-venv-"));
  fs.mkdirSync(path.join(v, "Lib", "site-packages"), { recursive: true });
  fs.mkdirSync(path.join(v, "lib", "python3.12", "site-packages"), { recursive: true });
  assert.deepEqual(findStartupHooks(v), []);
  fs.writeFileSync(path.join(v, "Lib", "site-packages", "evil.pth"), "import os");
  fs.writeFileSync(path.join(v, "lib", "python3.12", "site-packages", "sitecustomize.py"), "");
  assert.equal(findStartupHooks(v).length, 2);
});

test("install plan is hash-locked, binary-only and isolated from user uv config", () => {
  const steps = installPlan({ home: "C:\\H", uvExe: "C:\\L\\uv.exe", lockFile: "C:\\L\\req.txt", pinFile: "C:\\H\\pin.txt", platform: "win32" });
  assert.deepEqual(steps.map((s) => s.label), ["python", "venv", "packages"]);
  const pkg = steps[2]!;
  for (const flag of ["--require-hashes", "--no-deps", "--only-binary", ":all:"]) assert.ok(pkg.args.includes(flag), flag);
  assert.equal(pkg.env.UV_NO_CONFIG, "1");
  assert.equal(pkg.env.UV_PYTHON_PREFERENCE, "only-managed");
  assert.match(pinFileContent(), /^graphifyy==0\.9\.95 \\\n    --hash=sha256:e067c925/);
});

test("mutation observer fires for writers only and never throws", async () => {
  const { setWorkspaceMutationObserver, notifyToolExecuted } = await import("../mutations.js");
  const seen: string[] = [];
  setWorkspaceMutationObserver((ws, t) => seen.push(`${ws}|${t}`));
  notifyToolExecuted("file_read", true, "/w");
  notifyToolExecuted("file_write", false, "/w");
  notifyToolExecuted("file_write", true, "/w");
  notifyToolExecuted("shell_run", false, "/w");
  assert.deepEqual(seen, ["/w|file_write", "/w|shell_run"]);
  setWorkspaceMutationObserver(() => { throw new Error("boom"); });
  assert.doesNotThrow(() => notifyToolExecuted("git_commit", true, "/w"));
  setWorkspaceMutationObserver(null);
});

test("routes: status is side-effect free; project routes refuse when disabled", async () => {
  const { handleCodeGraphRoute } = await import("../../server/routes/codegraph.js");
  const sent: Array<{ status: number; body: any }> = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-routes-"));
  process.env.LOAM_CODEGRAPH_HOME = home;
  const deps = {
    svc: () => null, cfg: () => undefined,
    sendJson: (_r: unknown, status: number, body: unknown) => { sent.push({ status, body }); },
    readBody: async () => ({}), resolveWorkspace: () => home,
    uvExe: "x", uvSha256: "x", lockFile: "x", lockSha256: "x",
  };
  const req = (method: string, headers: Record<string, string> = {}) => ({ method, headers }) as any;
  assert.equal(await handleCodeGraphRoute(req("GET"), {} as any, "/api/codegraph/status", new URL("http://l/api/codegraph/status"), deps), true);
  assert.equal(sent[0]!.body.enabled, false);
  assert.equal(sent[0]!.body.ok, true);
  assert.equal(sent[0]!.body.runtime.state, "not-installed");
  assert.equal(fs.readdirSync(home).length, 0, "GET must not create files");
  await handleCodeGraphRoute(req("POST"), {} as any, "/api/codegraph/project/optin", new URL("http://l/x"), deps);
  assert.equal(sent[1]!.status, 409);
  await handleCodeGraphRoute(req("POST", { origin: "https://evil.example", host: "127.0.0.1:3939" }), {} as any, "/api/codegraph/runtime/install", new URL("http://l/x"), deps);
  assert.equal(sent[2]!.status, 403, "cross-origin install must be refused");
  await handleCodeGraphRoute(req("POST", { "sec-fetch-site": "cross-site" }), {} as any, "/api/codegraph/project/optin", new URL("http://l/x"), deps);
  assert.equal(sent[3]!.status, 403);
  assert.equal(await handleCodeGraphRoute(req("GET"), {} as any, "/api/other", new URL("http://l/api/other"), deps), false);
  delete process.env.LOAM_CODEGRAPH_HOME;
});

test("«أبداً» is remembered; opting in later clears it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-decline-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-proj-"));
  const svc = new CodeGraphService({ enabled: true, home }, { gitDir: null });
  // The test drives the indexer directly; runtime is not installed, so state is runtime-missing, but `declined` is still reported.
  svc.indexer.optOut(root, { decline: true });
  assert.equal((await svc.status(root)).declined, true);
  svc.indexer.optOut(root);
  assert.equal((await svc.status(root)).declined, true, "plain opt-out keeps an earlier decline");
  svc.indexer.optIn(root);
  const s = await svc.status(root);
  assert.equal(s.declined, false);
  assert.equal(s.optedIn, true);
  await svc.dispose();
});

test("install fails closed: unpinned, missing or mismatched uv / lock hashes never run uv", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-inst-"));
  const uv = path.join(home, "uv"); const lock = path.join(home, "lock.txt");
  fs.writeFileSync(uv, "not really uv"); fs.writeFileSync(lock, "x==1");
  const good = { uv: sha256File(uv), lock: sha256File(lock) };
  const base = { home, uvExe: uv, lockFile: lock };
  assert.equal((await installRuntime({ ...base, uvSha256: "", lockSha256: good.lock })).failedStep, "verify-uv");
  assert.equal((await installRuntime({ ...base, uvSha256: good.uv, lockSha256: "" })).failedStep, "verify-lock");
  assert.equal((await installRuntime({ ...base, uvSha256: "0".repeat(64), lockSha256: good.lock })).failedStep, "verify-uv");
  assert.equal((await installRuntime({ ...base, uvExe: path.join(home, "missing"), uvSha256: good.uv, lockSha256: good.lock })).failedStep, "verify-uv");
  assert.equal((await installRuntime({ ...base, uvSha256: good.uv, lockSha256: "f".repeat(64) })).failedStep, "verify-lock");
  assert.ok(!fs.existsSync(path.join(home, "runtime")), "nothing written before verification passes");
});
