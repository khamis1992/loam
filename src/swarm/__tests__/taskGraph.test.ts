import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaskGraph, normalizeOwnedPath, ownershipOverlaps, isOwnedBy, computeWaves, taskNodeId, taskInstruction, type PlannedTask } from "../taskGraph.js";

const answer = (tasks: unknown[]) => `Architecture notes...\nTASKS_JSON\n\`\`\`json\n${JSON.stringify({ tasks })}\n\`\`\``;
const T = (id: string, files: string[], tests: string[], dependsOn: string[] = [], extra: Record<string, unknown> = {}) => ({ id, title: `task ${id}`, files, tests, dependsOn, requirements: ["REQ-1"], ...extra });

test("a valid graph yields waves in dependency order", () => {
  const r = parseTaskGraph(answer([T("T1", ["server.cjs"], ["test/server.test.cjs"]), T("T2", ["public/index.html"], ["test/ui.test.cjs"], [], { tdd: false, tddReason: "markup" }), T("T3", ["src/store.js"], ["test/store.test.js"], ["T1"])]), { knownRequirements: ["REQ-1", "REQ-2"] });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.deepEqual(r.graph.waves, [["T1", "T2"], ["T3"]]);
  assert.ok(r.warnings.some(w => w.includes("REQ-2")));
});

test("concurrent tasks may not own the same file", () => {
  const r = parseTaskGraph(answer([T("T1", ["server.cjs"], ["test/a.test.cjs"]), T("T2", ["server.cjs"], ["test/b.test.cjs"])]));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors.join(" "), /both own server\.cjs/);
});

test("ordered tasks may share a file", () => {
  const r = parseTaskGraph(answer([T("T1", ["server.cjs"], ["test/a.test.cjs"]), T("T2", ["server.cjs"], ["test/b.test.cjs"], ["T1"])]));
  assert.ok(r.ok);
});

test("cycles, unknown deps, missing tests and bare tdd:false are rejected", () => {
  const cyc = parseTaskGraph(answer([T("T1", ["a.js"], ["test/a.test.js"], ["T2"]), T("T2", ["b.js"], ["test/b.test.js"], ["T1"])]));
  assert.equal(cyc.ok, false);
  const unk = parseTaskGraph(answer([T("T1", ["a.js"], ["test/a.test.js"], ["T9"]), T("T2", ["b.js"], ["test/b.test.js"])]));
  assert.ok(!unk.ok && unk.errors.some(e => e.includes("unknown task T9")));
  const noTest = parseTaskGraph(answer([T("T1", ["a.js"], []), T("T2", ["b.js"], ["test/b.test.js"])]));
  assert.ok(!noTest.ok && noTest.errors.some(e => e.includes("TDD task")));
  const noReason = parseTaskGraph(answer([T("T1", ["a.js"], [], [], { tdd: false }), T("T2", ["b.js"], ["test/b.test.js"])]));
  assert.ok(!noReason.ok && noReason.errors.some(e => e.includes("tddReason")));
});

test("a single task or a missing marker is not a graph", () => {
  assert.equal(parseTaskGraph(answer([T("T1", ["a.js"], ["test/a.test.js"])])).ok, false);
  assert.equal(parseTaskGraph("no plan here").ok, false);
});

test("path normalization rejects escapes, globs and engine folders", () => {
  assert.equal(normalizeOwnedPath("./src/a.js"), "src/a.js");
  assert.equal(normalizeOwnedPath("src\\b.js"), "src/b.js");
  for (const bad of ["/etc/passwd", "../x.js", "src/*.js", ".loam/x", ".git/config", "C:/x.js", 5]) assert.equal(normalizeOwnedPath(bad), null, String(bad));
});

test("ownership helpers", () => {
  assert.ok(ownershipOverlaps("public/", "public/index.html"), "a directory is owned only with a trailing slash");
  assert.ok(!ownershipOverlaps("public", "public/index.html"));
  assert.ok(!ownershipOverlaps("public/a.html", "public/b.html"));
  const task: Pick<PlannedTask, "files" | "tests"> = { files: ["public/"], tests: ["test/ui.test.cjs"] };
  assert.ok(isOwnedBy(task, "public/app.js"));
  assert.ok(isOwnedBy(task, "test/ui.test.cjs"));
  assert.ok(!isOwnedBy(task, "server.cjs"));
});

test("computeWaves returns null for a cycle and ids map to node ids", () => {
  const t = (id: string, dependsOn: string[]): PlannedTask => ({ id, title: id, files: [`${id}.js`], tests: [], dependsOn, requirements: [], tdd: false, tddReason: "x" });
  assert.equal(computeWaves([t("T1", ["T2"]), t("T2", ["T1"])]), null);
  assert.equal(taskNodeId("T3"), "task-t3");
  assert.match(taskInstruction({ ...t("T1", []), tdd: true, tests: ["test/a.test.js"] }), /test-first/);
});
