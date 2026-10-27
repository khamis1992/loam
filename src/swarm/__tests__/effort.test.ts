import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEffort, measureBrief, parseEffortRequest, SOLO_MAX_SCORE, LITE_MAX_SCORE } from "../effort.js";

// The exact brief of src/scripts/check-swarm-compare.ts:12 (the 785 s / 1.2M-token swarm run), byte-identical.
const COMPARE_BRIEF = "Build a small Node.js task-list web app with no external packages: server.cjs serving GET /tasks (JSON array) and GET / (Arabic RTL HTML with <input id=new-task-title>, <button id=add-task>, <ul id=tasks>) on process.env.PORT||3000, only listening when run directly, plus POST /tasks {title} so the UI works (creates the task and refreshes the list; title validated non-empty and at most 200 characters, otherwise 400), plus tasks.test.cjs with node:test covering GET /tasks empty and the store; run node --test tasks.test.cjs as verification. Keep reports under 120 words.";

const LARGE_BRIEF = "Build a multi-tenant clinic platform: patient signup and login with roles (admin, doctor, receptionist), appointment booking with realtime availability, Stripe payments for deposits, a PostgreSQL database with migrations, an admin dashboard, file uploads for lab results, email and SMS notifications, plus an audit log; also a public landing page, a doctor schedule page, a patient profile page and a reports page with CSV export.";

test("the real compare brief routes to solo (and \"keep reports short\" is not an admin domain)", () => {
  const d = classifyEffort(COMPARE_BRIEF);
  assert.equal(d.effort, "solo", d.reasons.join(" | "));
  assert.ok(d.score <= SOLO_MAX_SCORE);
  assert.deepEqual(d.signals.domains, []);
});

test("a short library brief routes to solo", () => {
  assert.equal(classifyEffort("Write a slugify(text) function in slugify.js with node:test tests.").effort, "solo");
});

test("a multi-domain product routes to full", () => {
  const d = classifyEffort(LARGE_BRIEF);
  assert.equal(d.effort, "full", d.reasons.join(" | "));
  assert.ok(d.score > LITE_MAX_SCORE);
  assert.ok(d.signals.domains.includes("auth") && d.signals.domains.includes("payments"));
});

test("a medium brief routes to lite", () => {
  const d = classifyEffort("Build a notes REST API with SQLite storage: create, list, update and delete notes; also tag filtering and full-text search; plus input validation with clear 400 errors and node:test coverage for every route.");
  assert.equal(d.effort, "lite", d.reasons.join(" | "));
});

test("an explicit request always wins", () => {
  const d = classifyEffort(COMPARE_BRIEF, { requested: "full" });
  assert.equal(d.effort, "full");
  assert.equal(d.requested, "full");
  assert.match(d.reasons[0]!, /explicit request/);
});

test("measureBrief is deterministic and context flags are recorded", () => {
  const a = measureBrief(COMPARE_BRIEF, { seeded: true, baseRun: true });
  const b = measureBrief(COMPARE_BRIEF, { seeded: true, baseRun: true });
  assert.deepEqual(a, b);
  assert.equal(a.seeded, true); assert.equal(a.baseRun, true);
  assert.equal(a.explicitVerification, true);
  assert.ok(a.namedFiles >= 2);
});

test("parseEffortRequest validates untrusted input", () => {
  assert.equal(parseEffortRequest(undefined), undefined);
  assert.equal(parseEffortRequest("lite"), "lite");
  assert.throws(() => parseEffortRequest("huge"));
  assert.throws(() => parseEffortRequest(3));
});
