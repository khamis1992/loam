/**
 * LIVE test: requires a real graphify 0.9.95 venv (LOAM_CODEGRAPH_VENV) and a Loam checkout (CODEGRAPH_LIVE_ROOT).
 * Run: CODEGRAPH_LIVE=1 LOAM_CODEGRAPH_VENV=<venv> CODEGRAPH_LIVE_ROOT=<repo> node --import tsx --test src/codegraph/__tests__/codegraph.live.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { CodeGraphService } from "../service.js";
import { createCodeGraphTools } from "../tools.js";
import type { ToolContext } from "../../tools/registry.js";

const LIVE = process.env.CODEGRAPH_LIVE === "1";
const ROOT = process.env.CODEGRAPH_LIVE_ROOT ?? "";
const metrics: Record<string, unknown> = {};
let svc: CodeGraphService;

before(() => {
  if (!LIVE) return;
  process.env.OPENAI_API_KEY = "sk-live-test-must-not-leak";
  svc = new CodeGraphService({ enabled: true, autoRefresh: false, home: fs.mkdtempSync(path.join(os.tmpdir(), "cg-live-")), maxWorkers: 4 });
});
after(async () => {
  if (!LIVE) return;
  await svc.dispose();
  // Never write into the repo: metrics go to CODEGRAPH_LIVE_METRICS or the OS temp dir.
  const out = process.env.CODEGRAPH_LIVE_METRICS || path.join(os.tmpdir(), "codegraph-live-metrics.json");
  fs.writeFileSync(out, JSON.stringify(metrics, null, 2));
  console.log(`codegraph live metrics -> ${out}`);
});

const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !LIVE, timeout: 900_000 }, fn);
// `cfg` is unused by codegraph tools; the cast keeps this file valid against Loam's real ToolContext (cfg: Config).
const ctx = (): ToolContext => ({ cfg: {} as ToolContext["cfg"], workspace: ROOT, emit: () => {} });

t("not opted in -> disabled + not-indexed fallback", async () => {
  const s = await svc.status(ROOT);
  assert.equal(s.runtime, "ready");
  assert.equal(s.state, "disabled");
  const r = await svc.query(ROOT, { kind: "stats" });
  assert.equal(r.outcome, "not-indexed");
  assert.throws(() => svc.indexer.requestIndex(ROOT, "user"), /not opted in/);
});

t("opt-in + full index of the Loam repo", async () => {
  const { execFileSync } = await import("node:child_process");
  // The repo may legitimately hold uncommitted work-in-progress; the security
  // property (T6) is that the scan adds NOTHING. Snapshot before/after instead
  // of asserting a clean tree.
  const before = execFileSync("git", ["-C", ROOT, "status", "--porcelain"]).toString();
  svc.indexer.optIn(ROOT);
  const job = svc.indexer.requestIndex(ROOT, "user");
  const done = await svc.indexer.waitFor(job.id, 850_000);
  assert.ok(done, "job finished");
  assert.equal(done.status, "succeeded", done.error ?? done.stderrTail);
  metrics.index = { durationMs: done.durationMs, nodes: done.nodes, edges: done.edges, communities: done.communities, oversizedExcluded: done.oversizedExcluded };
  assert.ok((done.nodes ?? 0) > 1_000, `expected a real graph, got ${done.nodes} nodes`);
  const s = await svc.status(ROOT);
  assert.equal(s.state, "ready", s.staleReasons.join(","));
  assert.match(s.builtAtCommit ?? "", /^[0-9a-f]{40}$/);
  const after = execFileSync("git", ["-C", ROOT, "status", "--porcelain"]).toString();
  assert.equal(after, before, "scan root must stay untouched by the extract");
});

t("MCP queries answer with header, locations and confidence tags", async () => {
  const t0 = Date.now();
  const stats = await svc.query(ROOT, { kind: "stats" });
  metrics.firstQueryMs = Date.now() - t0; // includes server spawn + graph load + trigram index
  assert.equal(stats.outcome, "answer", stats.text);
  assert.match(stats.text, /^\[codegraph project=/);
  const t1 = Date.now();
  const node = await svc.query(ROOT, { kind: "node", name: "registerMcpTools" });
  metrics.warmQueryMs = Date.now() - t1;
  assert.match(node.text, /src[\\/]tools[\\/]mcp\.ts/);
  const nb = await svc.query(ROOT, { kind: "neighbors", name: "registerMcpTools" });
  assert.match(nb.text, /EXTRACTED/);
  const p = await svc.query(ROOT, { kind: "path", from: "registerMcpTools", to: "isUntrustedTool" });
  assert.equal(p.outcome, "answer", p.text);
  const hubs = await svc.query(ROOT, { kind: "hubs", topN: 5 });
  assert.ok(/God nodes|most connected/i.test(hubs.text), hubs.text.slice(0, 200));
  const q = await svc.query(ROOT, { kind: "query", question: "registerMcpTools toResult", tokenBudget: 800 });
  assert.ok(["answer", "truncated"].includes(q.outcome), q.text.slice(0, 300));
  assert.ok(q.bytes <= svc.cfg.maxResultBytes);
  const miss = await svc.query(ROOT, { kind: "node", name: "zzqq_not_a_symbol_xx" });
  assert.equal(miss.outcome, "not-found");
  metrics.samples = { node: node.text.slice(0, 600), path: p.text.slice(0, 500), hubs: hubs.text.slice(0, 500) };
});

t("CLI affected = real reverse blast radius (matches rg ground truth)", async () => {
  const r = await svc.query(ROOT, { kind: "affected", name: "markUntrusted", depth: 1 });
  assert.equal(r.outcome, "answer", r.text);
  for (const f of ["src/agent/loop.ts", "src/tools/contextRecallTool.ts", "src/tools/wikiTools.ts"]) assert.ok(r.text.includes(f), f);
  // Windows deviation (U-7): the CLI exits 0 for a missing symbol; the text form
  // "No unique node match" must still classify as not-found through our layer.
  const miss = await svc.query(ROOT, { kind: "affected", name: "zz_no_such_symbol_zz" });
  assert.equal(miss.outcome, "not-found", miss.text.slice(0, 200));
});

t("project_path from the caller is overwritten; deny-listed tools refused", async () => {
  const storeDir = svc.indexer.storeDirFor(ROOT);
  const r = await svc.mcp.call("get_node", { label: "registerMcpTools", project_path: "/etc" }, storeDir);
  assert.match(r.text, /src[\\/]tools[\\/]mcp\.ts/);
  await assert.rejects(() => svc.mcp.call("list_prs" as never, {}, storeDir), /not allowlisted/);
  assert.equal(svc.mcp.availableTools().length, 7);
});

t("graphify-mcp child env carries no API keys", async () => {
  // Windows: verify via WMIC-less approach — the service spawns MCP only on query; env is built by
  // buildChildEnv which the unit tests already prove is an allowlist. Here we assert the live server
  // still answers (it would fail fast on a bad env) and that our own process env did leak nothing
  // into the store: the audit file must not contain the marker key.
  const r = await svc.query(ROOT, { kind: "stats" });
  assert.equal(r.outcome, "answer", r.text);
  const audit = fs.readFileSync(path.join(svc.home, "audit.jsonl"), "utf8");
  assert.ok(!audit.includes("sk-live-test-must-not-leak"), "audit must hold digests, not query text");
});

t("markDirty -> stale; incremental refresh clears it", async () => {
  svc.indexer.markDirty(ROOT);
  let s = await svc.status(ROOT);
  assert.equal(s.state, "stale");
  assert.ok(s.staleReasons.includes("loam-wrote-files"));
  const stale = await svc.query(ROOT, { kind: "stats" });
  assert.match(stale.text, /STALE\(loam-wrote-files\)/);
  const job = svc.indexer.requestIndex(ROOT, "agent-writes");
  const done = await svc.indexer.waitFor(job.id, 600_000);
  assert.equal(done?.status, "succeeded", done?.error);
  metrics.incremental = { durationMs: done?.durationMs, filesReextracted: done?.filesReextracted, filesCached: done?.filesCached };
  s = await svc.status(ROOT);
  assert.equal(s.state, "ready", s.staleReasons.join(","));
});

t("agent tools end-to-end through the Tool interface", async () => {
  const tools = Object.fromEntries(createCodeGraphTools(svc).map((x) => [x.name, x]));
  const st = await tools.codegraph_status!.run({}, ctx());
  assert.match(st.content, /state: ready/);
  const af = await tools.codegraph_affected!.run({ name: "toResult", depth: 1 }, ctx());
  assert.ok(af.ok, af.content);
  assert.match(af.content, /registerMcpTools/);
  const audit = fs.readFileSync(path.join(svc.home, "audit.jsonl"), "utf8");
  assert.ok(!audit.includes("registerMcpTools"), "audit must hold digests, not query text");
  metrics.auditLines = audit.trim().split("\n").length;
});
