// src/appbuilder/__tests__/rows.test.ts — W3-a: row functions for app_runs,
// app_questions, app_plan_drafts, app_assignments round-trip on a temp sqlite
// via the store's own init pattern (same conventions as g4.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-rows-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;

const { ensureAppBuilderSchema, newAppRowId, insertRun, getRun, listRuns, updateRun, finishRun,
  insertQuestion, getQuestionCard, listQuestionCards, answerQuestion,
  insertPlanDraft, getPlanDraft, listPlanDrafts, latestPlanDraft, decidePlanDraft,
  insertAssignment, getAssignment, listAssignments, updateAssignment } = await import("../store.js");
const { createAppProject } = await import("../projects.js");
const { database } = await import("../../server/sqliteStore.js");
import type { QuestionsCard, QuestionSpec, PlanDocument, PlanDraft, AppTaskAssignment } from "../types.js";

ensureAppBuilderSchema();
const project = createAppProject({ title: "rows-roundtrip", baseWorkspace: tmp });
const pid = project.id;

function questionCard(overrides: Partial<import("../types.js").QuestionsCard> = {}): import("../types.js").QuestionsCard {
  const spec: import("../types.js").QuestionSpec = {
    id: "q1",
    prompt: "Who is the app for?",
    kind: "single",
    options: [
      { id: "o1", label: "Just me" },
      { id: "o2", label: "My team" },
    ],
    defaultOptionIds: ["o1"],
    allowOther: false,
  };
  return {
    id: newAppRowId("qc_"),
    projectId: pid,
    runId: "run_x",
    title: "Quick check",
    questions: [spec],
    status: "pending",
    answers: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
    ...overrides,
  };
}

function planDoc(title: string): import("../types.js").PlanDocument {
  return {
    title,
    overview: "One sentence overview.",
    scenario: "web_app",
    templateId: "web-app",
    features: [],
    keyDecisions: [{ date: "2026-10-29", decision: "No accounts", rationale: "default: user did not say", source: "default" }],
    constraints: ["Works offline"],
    requirements: ["Shows a list"],
    userStories: ["As a user I add items"],
    tasks: [
      { id: "T1", title: "Build the list", role: "engineer", deps: [], status: "pending", acceptance: ["List renders"] },
    ],
  };
}

function assignment(overrides: Partial<import("../types.js").AppTaskAssignment> = {}): import("../types.js").AppTaskAssignment {
  return {
    id: newAppRowId("as_"),
    projectId: pid,
    planDraftId: null,
    planTaskIds: ["T1"],
    role: "engineer",
    brief: "x".repeat(80),
    status: "queued",
    report: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

// ---------- app_runs ----------

test("runs: insert running, update status, finish stamps finished_at once", () => {
  const run = insertRun({ projectId: pid, flavor: "quick", prompt: "build a todo list" });
  assert.match(run.id, /^run_[a-z2-7]{12}$/);
  assert.equal(run.status, "running");
  assert.ok(run.startedAt);
  assert.equal(run.finishedAt, null);
  assert.deepEqual(getRun(run.id)!.prompt, "build a todo list");

  const moved = updateRun(run.id, { status: "verifying" })!;
  assert.equal(moved.status, "verifying");
  assert.equal(moved.finishedAt, null);

  const done = finishRun(run.id, "done")!;
  assert.equal(done.status, "done");
  assert.ok(done.finishedAt, "finishRun stamps finished_at");
  const again = finishRun(run.id, "stopped")!;
  assert.equal(again.status, "stopped");
  assert.equal(again.finishedAt, done.finishedAt, "finished_at is stamped once");

  assert.equal(listRuns(pid).length, 1);
  assert.equal(getRun("run_nope"), undefined);
  assert.equal(updateRun("run_nope", { status: "done" }), undefined);
  assert.equal(finishRun("run_nope", "done"), undefined);
});

test("runs: race_id round-trips (§4.13 race wiring column)", () => {
  // race_id has a real FK to app_races: give it a race row to point at.
  const raceId = "race_" + "a1b2c3d4e5f6";
  database().prepare("INSERT INTO app_races (id, project_id, prompt, status, created_at) VALUES (?, ?, 'race me', 'running', ?)")
    .run(raceId, pid, new Date().toISOString());
  const r = insertRun({ projectId: pid, flavor: "quick", prompt: "race me", raceId });
  assert.equal(getRun(r.id)!.raceId, raceId);
  assert.equal(updateRun(r.id, { raceId: null })!.raceId, null);
});

// ---------- app_questions ----------

test("questions: insert pending card, answer resolves it, double answer refused", () => {
  const card = questionCard();
  insertQuestion(card);
  const loaded = getQuestionCard(card.id)!;
  assert.equal(loaded.status, "pending");
  assert.equal(loaded.questions[0]!.prompt, "Who is the app for?");
  assert.equal(loaded.answers, null);

  const answers = [{ questionId: "q1", optionIds: ["o2"], usedDefault: false }];
  const answered = answerQuestion(card.id, { answers }) as import("../types.js").QuestionsCard;
  assert.equal(answered.status, "answered");
  assert.deepEqual(answered.answers, answers);
  assert.ok(answered.answeredAt);
  assert.deepEqual(getQuestionCard(card.id)!.answers![0]!.optionIds, ["o2"]);

  const again = answerQuestion(card.id, { answers }) as { error: string };
  assert.equal(again.error, "already_resolved");
  assert.equal(answerQuestion("qc_nope", { answers }), undefined);
});

test("questions: skip path marks the card skipped without answers", () => {
  const card = questionCard();
  insertQuestion(card);
  const skipped = answerQuestion(card.id, { skip: true }) as import("../types.js").QuestionsCard;
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.answers, null);
  assert.ok(skipped.answeredAt);
  assert.equal(listQuestionCards(pid).length, 2);
});

// ---------- app_plan_drafts ----------

test("plans: revisions start at 1, increment, and supersede the previous draft", () => {
  const p = createAppProject({ title: "plans-a", baseWorkspace: tmp });
  const d1 = insertPlanDraft({ projectId: p.id, runId: "run_1", doc: planDoc("v1") });
  assert.equal(d1.revision, 1);
  assert.equal(d1.status, "draft");
  const d2 = insertPlanDraft({ projectId: p.id, runId: "run_1", doc: planDoc("v2") });
  assert.equal(d2.revision, 2);
  assert.equal(getPlanDraft(d1.id)!.status, "superseded", "new draft supersedes the previous one");
  assert.equal(latestPlanDraft(p.id)!.id, d2.id);
  assert.deepEqual(listPlanDrafts(p.id).map((d) => d.revision), [2, 1], "newest revision first");
  // doc JSON round-trips
  assert.equal(latestPlanDraft(p.id)!.doc.tasks[0]!.id, "T1");
});

test("plans: stale revision refused with the 409 contract, approve/decline decide once", () => {
  const p = createAppProject({ title: "plans-b", baseWorkspace: tmp });
  const d1 = insertPlanDraft({ projectId: p.id, runId: "run_1", doc: planDoc("old") });
  const d2 = insertPlanDraft({ projectId: p.id, runId: "run_1", doc: planDoc("new") });
  const stale = decidePlanDraft(d1.id, { kind: "approve" }) as { error: string; latest: number };
  assert.equal(stale.error, "stale_revision");
  assert.equal(stale.latest, d2.revision);

  const approved = decidePlanDraft(d2.id, { kind: "approve" }) as PlanDraft;
  assert.equal(approved.status, "approved");
  assert.ok(approved.decidedAt);
  const redecided = decidePlanDraft(d2.id, { kind: "decline", reason: "x" }) as { error: string };
  assert.equal(redecided.error, "already_decided");

  const d3 = insertPlanDraft({ projectId: p.id, runId: "run_1", doc: planDoc("v3") });
  const declined = decidePlanDraft(d3.id, { kind: "decline", reason: "y".repeat(2_000) }) as PlanDraft;
  assert.equal(declined.status, "declined");
  assert.equal(declined.declineReason!.length, 1_000, "decline reason capped at 1,000 chars (§4.2.2 rule 4)");
  assert.equal(decidePlanDraft("pd_nope", { kind: "approve" }), undefined);
});

// ---------- app_assignments ----------

test("assignments: insert queued, run stamps started_at, finish stamps finished_at + report", () => {
  const a = assignment();
  insertAssignment(a);
  assert.equal(getAssignment(a.id)!.status, "queued");
  assert.deepEqual(getAssignment(a.id)!.planTaskIds, ["T1"]);

  const running = updateAssignment(a.id, { status: "running" })!;
  assert.equal(running.status, "running");
  assert.ok(running.startedAt, "running stamps started_at");

  const finished = updateAssignment(a.id, { status: "done", report: "built; verified with app_verify" })!;
  assert.equal(finished.status, "done");
  assert.equal(finished.report, "built; verified with app_verify");
  assert.ok(finished.finishedAt, "terminal state stamps finished_at");

  assert.equal(listAssignments(pid).length, 1);
  assert.equal(updateAssignment("as_nope", { status: "running" }), undefined);
  assert.equal(getAssignment("as_nope"), undefined);
});
