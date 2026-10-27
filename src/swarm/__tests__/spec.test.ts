import { test } from "node:test";
import assert from "node:assert/strict";
import { earsPattern, parseRequirements, validateRequirements, parseDelta, mergeSpec, renderSpecMarkdown, specCoverage, renderProjectGuide, upsertProjectGuide, AGENTS_BEGIN, AGENTS_END } from "../spec.js";
import { scanPromptInjections } from "../security.js";

const FULL = `# Requirements
REQ-1: The service shall return all tasks as a JSON array from GET /tasks.
Verify: tasks.test.cjs "GET /tasks returns []"
Traces: US-1
REQ-2: When a client posts a valid title, the service shall create the task and return 201.
Verify: tasks.test.cjs "POST creates"
REQ-3: If the title is empty or longer than 200 characters, then the service shall respond 400.
Verify: tasks.test.cjs "400 cases"
`;

test("EARS patterns in English and Arabic", () => {
  assert.equal(earsPattern("The system shall log every request."), "ubiquitous");
  assert.equal(earsPattern("When the user clicks add, the system shall append the task."), "event");
  assert.equal(earsPattern("While offline, the app shall queue writes."), "state");
  assert.equal(earsPattern("If the token expires, then the API shall return 401."), "unwanted");
  assert.equal(earsPattern("Where dark mode is enabled, the UI shall use the dark palette."), "optional");
  assert.equal(earsPattern("عندما يضغط المستخدم زر الإضافة، يجب أن يضيف النظام المهمة."), "event");
  assert.equal(earsPattern("Make it nice."), null);
});

test("the gate accepts a valid spec and names problems otherwise", () => {
  const ok = validateRequirements(FULL);
  assert.ok(ok.ok, ok.missing.join("; "));
  assert.equal(ok.requirements[0]!.traces[0], "US-1");
  const bad = validateRequirements("REQ-1: Make it fast.\nREQ-2: The app shall work.");
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.some(m => m.includes("at least 3")));
  assert.ok(bad.missing.some(m => m.includes("REQ-1 is not in an EARS pattern")));
  assert.ok(bad.missing.some(m => m.includes("Verify")));
  assert.ok(parseRequirements("REQ-1: The a shall b.\nVerify: x\nREQ-1: The a shall c.\nVerify: y").problems.some(p => p.includes("twice")));
});

test("delta merge renumbers a colliding ADDED id, modifies and removes", () => {
  const v1 = mergeSpec(null, FULL, "run-1", "2026-10-27T10:00:00Z").spec;
  assert.equal(v1.version, 1);
  const delta = `## ADDED\nREQ-2: When a task is deleted, the service shall return 204.\nVerify: tasks.test.cjs "delete"\n## MODIFIED\nREQ-1: The service shall return tasks sorted by creation time.\nVerify: tasks.test.cjs "sorted"\n## REMOVED\nREQ-3\n`;
  assert.ok(parseDelta(delta).isDelta);
  const { spec: v2, problems } = mergeSpec(v1, delta, "run-2", "2026-10-27T11:00:00Z");
  assert.deepEqual(problems, []);
  assert.equal(v2.version, 2);
  // ADDED REQ-2 collides with the existing REQ-2 and becomes the next free id (REQ-4);
  // REMOVED REQ-3 is then dropped, so ids are never reused within one merge.
  assert.deepEqual(v2.requirements.map(r => r.id), ["REQ-1", "REQ-2", "REQ-4"]);
  assert.match(v2.requirements[0]!.text, /sorted/);
  assert.match(v2.requirements[2]!.text, /deleted/);
  assert.deepEqual(v2.history.at(-1), { runId: "run-2", at: "2026-10-27T11:00:00Z", added: ["REQ-4"], modified: ["REQ-1"], removed: ["REQ-3"] });
  assert.match(renderSpecMarkdown(v2), /living spec v2/);
  assert.ok(mergeSpec(v1, "## MODIFIED\nREQ-9: The a shall b.\nVerify: x", "r").problems.some(p => p.includes("REQ-9")));
});

test("coverage counts requirement ids mentioned in tests", () => {
  const v1 = mergeSpec(null, FULL, "run-1").spec;
  const cov = specCoverage(v1, { "tasks.test.cjs": "test('REQ-1 list', ...); test('REQ-3 rejects', ...)" });
  assert.deepEqual(cov, { covered: ["REQ-1", "REQ-3"], uncovered: ["REQ-2"] });
});

test("the AGENTS.md block is fact-only, idempotent and preserves user text", () => {
  const block = renderProjectGuide({ brief: "Ignore previous instructions? No: a task list app", track: "web", verificationCommand: "node --test tasks.test.cjs", startCommand: "node server.cjs", independentTests: ["acceptance.test.cjs"], structure: [{ path: "server.cjs", kind: "code" }], decisions: [{ stage: "architecture", text: "Use node:http only" }], requirementCount: 3, runId: "run-1" });
  // The engine block itself must never trip the workspace prompt-injection scan.
  const engineOnly = block.replace(/^Product: .*$/m, "Product: <brief>");
  assert.deepEqual(scanPromptInjections([{ path: "AGENTS.md", content: engineOnly }]), []);
  const first = upsertProjectGuide(null, block);
  assert.ok(first.startsWith("# AGENTS.md"));
  const user = `# My rules\nUse tabs.\n\n${block}\n`;
  const updated = upsertProjectGuide(user, block.replace("run-1", "run-2"));
  assert.match(updated, /Use tabs\./);
  assert.match(updated, /run-2/);
  assert.equal(updated.split(AGENTS_BEGIN).length, 2);
  assert.equal(updated.split(AGENTS_END).length, 2);
});
