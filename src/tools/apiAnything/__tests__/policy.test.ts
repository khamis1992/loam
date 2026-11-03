import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Loam's data dir env is MANUS_LOCAL_DATA_DIR (config.ts dataDir()); the policy's
// audit file and usage counters derive from it at import time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-aa-policy-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, "api-anything", "sites"), { recursive: true });
const spec = (name: string, ops: Array<{ name: string; readOnly: boolean }>) =>
  fs.writeFileSync(path.join(tmp, "api-anything", "sites", `${name}.json`), JSON.stringify({ name, baseUrl: `https://${name}.example`, operations: ops }));
spec("fixture", [{ name: "search", readOnly: true }]);
spec("people", [{ name: "getProfile", readOnly: true }]);

const { createApiAnythingPolicy } = await import("../policy.js");
const { opIndex } = await import("../opIndex.js");
const { AUDIT_FILE } = await import("../constants.js");
opIndex.refresh();

type Cfg = import("../types.js").ApiAnythingConfig;
const base: Cfg = {
  enabled: true, allowWrites: false, allowWriteLearning: false, browser: "edge", sites: "all", learnDomains: [],
  peopleOps: ["people.getProfile"], peopleOpsTasks: ["task_people"], peopleLimitPerTask: 2,
  rateLimit: { calls: 3, windowMs: 600_000 }, outputBudgetChars: 15_000,
  timeouts: { listMs: 15_000, callMs: 180_000, loginMs: 900_000, learnMs: 300_000 },
};
const ctx = (taskId: string, depth = 0) => ({ cfg: {}, workspace: tmp, emit: () => {}, taskId, depth }) as never;
const refused = (d: unknown): boolean => !!d && typeof d === "object" && "block" in d && JSON.parse((d as { block: { content: string } }).block.content).class === "refused";

test("site allowlist", () => {
  const p = createApiAnythingPolicy({ ...base, sites: ["fixture"] });
  assert.equal(refused(p.hooks.before!("call_operation", { site: "people", op: "getProfile", args: {} }, ctx("task_a"))), true);
  assert.equal(p.hooks.before!("call_operation", { site: "fixture", op: "search", args: { q: "x" } }, ctx("task_a")), undefined);
});

test("people lookups: off by default, capped, repeat-free, no sub-agents", () => {
  const p = createApiAnythingPolicy(base);
  const look = (id: string, t = "task_people", depth = 0) => p.hooks.before!("call_operation", { site: "people", op: "getProfile", args: { publicId: id } }, ctx(t, depth));
  assert.equal(refused(look("a", "task_other")), true);
  assert.equal(look("a"), undefined);
  assert.equal(look("b"), undefined);
  assert.equal(look("a"), undefined);
  assert.equal(refused(look("c")), true);
  assert.equal(refused(look("a", "task_people", 1)), true);
});

test("rate cap per task and site", () => {
  const p = createApiAnythingPolicy(base);
  const go = () => p.hooks.before!("call_operation", { site: "fixture", op: "search", args: { q: "x" } }, ctx("task_rate"));
  assert.equal(go(), undefined);
  assert.equal(go(), undefined);
  assert.equal(go(), undefined);
  assert.equal(refused(go()), true);
});

test("login is forced to window mode and only one at a time", async () => {
  const p = createApiAnythingPolicy(base);
  assert.deepEqual(p.hooks.before!("login", { site: "fixture", mode: "import" }, ctx("task_l")), { args: { site: "fixture", mode: "window" } });
  assert.equal(refused(p.hooks.before!("login", { site: "fixture" }, ctx("task_l"))), true);
  await p.hooks.after!("login", { site: "fixture", mode: "window" }, { ok: true, content: '{"ok":true,"site":"fixture","cookies":["sid"],"loggedIn":true}' }, ctx("task_l"), 10);
  assert.ok(!refused(p.hooks.before!("login", { site: "fixture" }, ctx("task_l"))));
  assert.equal(refused(p.hooks.before!("login", { url: "https://elsewhere.example/" }, ctx("task_l2"))), true);
});

test("after: next rewritten, budget applied, audit without values", async () => {
  const p = createApiAnythingPolicy(base);
  const drift = JSON.stringify({ ok: false, class: "drift", next: "api-anything heal fixture search (api-anything is a CLI: run it in your shell, as npx -y github:goodnight000/api-anything when the command is not installed; with no shell, ask the user)", ms: 3 });
  const r1 = await p.hooks.after!("call_operation", { site: "fixture", op: "search", args: { q: "secret-term-123" } }, { ok: false, content: drift }, ctx("task_x"), 3);
  assert.equal(JSON.parse(r1.content).next, 'integration_call api_heal {"site":"fixture","op":"search"}');
  const big = JSON.stringify({ ok: true, class: "ok", tier: 1, data: Array.from({ length: 400 }, (_, i) => ({ t: "z".repeat(100), i })), ms: 9 });
  const r2 = await p.hooks.after!("call_operation", { site: "fixture", op: "search", args: { q: "y" } }, { ok: true, content: big }, ctx("task_x"), 9);
  assert.ok(r2.content.length <= 15_000);
  assert.equal(JSON.parse(r2.content).truncated, true);
  const r3 = await p.hooks.after!("call_operation", { site: "fixture", op: "search", args: {} }, { ok: false, content: "mcp api-anything/call_operation failed: Request timed out" }, ctx("task_x"), 180_000);
  assert.equal(JSON.parse(r3.content).class, "error");
  const audit = fs.readFileSync(AUDIT_FILE, "utf8");
  assert.doesNotMatch(audit, /secret-term-123/);
  assert.match(audit, /"argNames":\["q"\]/);
});
