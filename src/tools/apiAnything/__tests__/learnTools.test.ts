import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Loam's data dir env is MANUS_LOCAL_DATA_DIR; the audit file derives from it at import time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-aa-learn-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, "api-anything", "sites"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "api-anything", "sites", "fixture.json"),
  JSON.stringify({ name: "fixture", baseUrl: "https://fixture.example", operations: [{ name: "search", readOnly: true }] }),
);

const { createApiAnythingLearnTools } = await import("../learnTools.js");
const { createApiAnythingPolicy } = await import("../policy.js");
const { opIndex } = await import("../opIndex.js");
opIndex.refresh();

type Cfg = import("../types.js").ApiAnythingConfig;
const base: Cfg = {
  enabled: true, allowWrites: false, allowWriteLearning: false, browser: "edge", sites: "all", learnDomains: ["fixture.example"],
  peopleOps: [], peopleOpsTasks: [], peopleLimitPerTask: 2,
  rateLimit: { calls: 30, windowMs: 600_000 }, outputBudgetChars: 15_000,
  timeouts: { listMs: 15_000, callMs: 180_000, loginMs: 900_000, learnMs: 300_000 },
};
const policy = createApiAnythingPolicy(base);
const tools = createApiAnythingLearnTools(base, policy);
const byName = new Map(tools.map((t) => [t.name, t]));
const ctx = (taskId?: string) => ({ cfg: {}, workspace: tmp, emit: () => {}, ...(taskId ? { taskId } : {}) }) as never;
const refused = async (name: string, args: Record<string, unknown>, taskId?: string): Promise<string> => {
  const r = await byName.get(name)!.run(args, ctx(taskId));
  assert.equal(r.ok, false, `${name} should refuse`);
  return (JSON.parse(r.content) as { reason?: string }).reason ?? "";
};

test("nine integration-only tools register", () => {
  assert.equal(tools.length, 9);
  for (const t of tools) assert.equal((t as { integration?: boolean }).integration, true, `${t.name} must be integration-scoped`);
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["api_add", "api_capture", "api_export", "api_heal", "api_inspect", "api_logout", "api_ops", "api_sites", "api_verify"].sort(),
  );
});

test("every learn tool refuses outside a task", async () => {
  for (const t of tools) {
    const r = await t.run(t.name === "api_ops" || t.name === "api_logout" ? { site: "fixture" } : {}, ctx());
    assert.equal(r.ok, false, `${t.name} must require a task`);
    assert.match(JSON.parse(r.content).class, /refused/);
  }
});

test("api_capture URL gates refuse before any child starts", async () => {
  assert.match(await refused("api_capture", { url: "http://fixture.example/" }, "task_a"), /https/);
  assert.match(await refused("api_capture", { url: "https://192.168.1.5/" }, "task_a"), /private/);
  assert.match(await refused("api_capture", { url: "https://elsewhere.example/" }, "task_a"), /learn list/);
  assert.match(await refused("api_capture", { url: "https://fixture.example/x", write: true }, "task_a"), /turned off/);
  assert.match(await refused("api_capture", { url: "https://fixture.example/", examples: "kittens" }, "task_a"), /object of param/);
});

test("site gates and argument shape", async () => {
  assert.match(await refused("api_ops", { site: "bad site!" }, "task_a"), /not enabled/);
  assert.match(await refused("api_logout", { site: "" }, "task_a"), /site is required/);
  assert.match(await refused("api_add", { site: "fixture", op: "bad op!", trigger: "https://fixture.example/{q}" }, "task_a"), /short names/);
  assert.match(await refused("api_add", { site: "fixture", op: "search" }, "task_a"), /trigger or from/);
  assert.match(await refused("api_add", { site: "fixture", op: "search", trigger: "https://10.0.0.1/{q}" }, "task_a"), /not allowed|private/);
});

test("api_export stays inside the workspace and writes .json only", async () => {
  assert.match(await refused("api_export", { site: "fixture", out: "../escape.json" }, "task_a"), /inside the task workspace/);
  assert.match(await refused("api_export", { site: "fixture", out: "spec.txt" }, "task_a"), /\.json/);
});

test("site allowlist narrows the learn tools too", async () => {
  const narrow = createApiAnythingLearnTools({ ...base, sites: ["fixture"] }, createApiAnythingPolicy({ ...base, sites: ["fixture"] }));
  const ops = narrow.find((t) => t.name === "api_ops")!;
  const r = await ops.run({ site: "people" }, ctx("task_a"));
  assert.equal(JSON.parse(r.content).reason, "site people is not enabled in Loam");
});
