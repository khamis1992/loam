import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntake, parseClarifyAnswer, clarificationText, parseApprovalDecision, verificationFromText, renderPlanSummary, MAX_INTAKE_QUESTIONS, type IntakeGate } from "../intake.js";

const CLEAR = "Build a Node.js notes API with GET/POST /notes, SQLite storage and node:test tests; verify with node --test.";

test("proceed, clarify and stop verdicts", () => {
  assert.equal(parseIntake('```json\n{"verdict":"proceed","summary":"notes API"}\n```', CLEAR).verdict, "proceed");
  const clarify = parseIntake(JSON.stringify({ verdict: "clarify", questions: [{ prompt: "Who are the users?", options: ["staff", "public"] }, "Which language?", "Q3?", "Q4?"] }), CLEAR);
  assert.equal(clarify.verdict, "clarify");
  assert.equal(clarify.questions.length, MAX_INTAKE_QUESTIONS);
  assert.deepEqual(clarify.questions.map(q => q.id), ["q1", "q2", "q3"]);
  assert.deepEqual(clarify.questions[0]!.options, ["staff", "public"]);
  assert.equal(parseIntake('{"verdict":"stop","summary":"needs a paid API"}', CLEAR).verdict, "stop");
});

test("unparseable output degrades to proceed; clarify without questions too", () => {
  assert.equal(parseIntake("sure, let's go", CLEAR).verdict, "proceed");
  assert.equal(parseIntake('{"verdict":"clarify","questions":[]}', CLEAR).verdict, "proceed");
});

test("a vague brief is raised by the deterministic classifier", () => {
  // Note: needsAskUser only fires on pronoun/open-ended phrasing ("improve this"); a bare
  // "build an app" is NOT flagged, so idea-level vagueness relies on the intake model.
  assert.equal(parseIntake('{"verdict":"proceed"}', "build an app").vague, false);
  const a = parseIntake('{"verdict":"proceed"}', "improve this");
  assert.equal(a.vague, true);
  assert.equal(a.verdict, "clarify");
  assert.ok(a.questions.length >= 1);
});

test("answers are validated against the gate questions", () => {
  const assessment = parseIntake(JSON.stringify({ verdict: "clarify", summary: "s", questions: ["Who?", "Where?"], assumptions: ["Arabic UI"] }), CLEAR);
  const gate: IntakeGate = { status: "pending", assessment, askedAt: "2026-10-27T10:00:00Z" };
  assert.ok("error" in parseClarifyAnswer({ answers: {} }, gate));
  assert.ok("error" in parseClarifyAnswer([], gate));
  const ok = parseClarifyAnswer({ answers: { q1: "staff", q9: "ignored" }, note: "keep it simple" }, gate);
  assert.ok(!("error" in ok));
  if ("error" in ok) return;
  assert.deepEqual(ok.answers, { q1: "staff" });
  const text = clarificationText({ ...gate, status: "answered", answers: ok.answers, note: ok.note });
  assert.match(text, /Who\? → staff/);
  assert.match(text, /not answered/);
  assert.match(text, /Arabic UI/);
  const stop = parseClarifyAnswer({ decision: "stop" }, gate);
  assert.ok(!("error" in stop) && stop.decision === "stop");
});

test("approval decisions", () => {
  assert.deepEqual(parseApprovalDecision({ decision: "approve" }), { decision: "approve", feedback: "" });
  assert.ok("error" in parseApprovalDecision({ decision: "revise" }));
  assert.ok("error" in parseApprovalDecision({ decision: "ship" }));
  assert.equal((parseApprovalDecision({ decision: "revise", feedback: "add search" }) as { feedback: string }).feedback, "add search");
});

test("verification command extraction and the plan card", () => {
  assert.equal(verificationFromText("Verification command: `node --test tasks.test.cjs`"), "node --test tasks.test.cjs");
  assert.equal(verificationFromText("run `npm test` at the end"), "npm test");
  assert.equal(verificationFromText("no command"), null);
  const card = renderPlanSummary({ effort: "full", requirements: [{ id: "REQ-1", text: "The api shall list notes." }], requirementCount: 1, decisions: ["[architecture] node:http"], tasks: [{ id: "T1", title: "API", files: ["server.cjs"], dependsOn: [] }], verificationCommand: "node --test", stages: ["requirements", "approval", "task-t1"] });
  assert.match(card, /REQ-1/); assert.match(card, /T1 API/); assert.match(card, /approval → task-t1/);
});
