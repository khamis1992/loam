// src/appbuilder/__tests__/lead.test.ts — W3-b: the Goal-mode Lead flows of
// MISSING §4.2 — question card create/answer/skip, plan draft revisions with
// the 409 stale check via decidePlanDraft, approve/decline/edit, and the
// assignment lifecycle, plus the injected-executor lead turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QuestionsCard } from "../types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-lead-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;

const lead = await import("../lead.js");
const { createAppProject, getAppProject } = await import("../projects.js");
const { insertRun, latestPlanDraft, getPlanDraft } = await import("../store.js");

function planDoc(title: string, extra: Partial<import("../types.js").PlanDocument> = {}): import("../types.js").PlanDocument {
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
      { id: "T2", title: "Verify the flow", role: "engineer", deps: ["T1"], status: "pending", acceptance: ["Add then reload keeps the item"] },
    ],
    ...extra,
  };
}

function questionJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    title: "Quick check",
    questions: [
      {
        id: "q1",
        prompt: "Who is the app for?",
        kind: "single",
        options: [
          { id: "o1", label: "Just me" },
          { id: "o2", label: "My team" },
        ],
        defaultOptionIds: ["o1"],
        allowOther: false,
      },
    ],
    ...overrides,
  };
}

// ---------- §4.2.1 question validation ----------

test("question validation: accepts a well-formed card and normalises ids", () => {
  const v = lead.validateQuestionSpecs(questionJson());
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.equal(v.questions[0]!.id, "q1");
  assert.deepEqual(v.questions[0]!.defaultOptionIds, ["o1"]);
});

test("question validation: enforces the §4.2.1 rule table", () => {
  const cases: Array<[string, unknown]> = [
    ["prompt must end with ?", { questions: [{ prompt: "Who uses this app", kind: "text" }] }],
    ["prompt length floor", { questions: [{ prompt: "Short?", kind: "text" }] }],
    ["single needs exactly one default", { questions: [{ prompt: "Who is this for?", kind: "single", options: [{ label: "A" }, { label: "B" }] }] }],
    ["option label cap", { questions: [{ prompt: "Who is this for?", kind: "single", defaultOptionIds: ["o1"], options: [{ label: "x".repeat(41) }, { label: "B" }] }] }],
    ["detail cap", { questions: [{ prompt: "Who is this for?", kind: "single", defaultOptionIds: ["o1"], options: [{ label: "A", detail: "d".repeat(241) }, { label: "B" }] }] }],
    ["text question takes no options", { questions: [{ prompt: "Describe the look?", kind: "text", options: [{ label: "A" }, { label: "B" }] }] }],
    ["max 5 questions", { questions: Array.from({ length: 6 }, () => ({ prompt: "Question number here?", kind: "text" })) }],
    ["2 to 5 options", { questions: [{ prompt: "Who is this for?", kind: "single", defaultOptionIds: ["o1"], options: [{ label: "Only one" }] }] }],
    ["defaults must exist", { questions: [{ prompt: "Who is this for?", kind: "single", options: [{ label: "A" }, { label: "B" }], defaultOptionIds: ["o9"] }] }],
  ];
  for (const [what, raw] of cases) {
    const v = lead.validateQuestionSpecs(raw);
    assert.equal(v.ok, false, `${what}: expected rejection`);
    assert.ok(v.problems.length > 0, `${what}: problems reported`);
  }
});

// ---------- card creation + answer + skip ----------

test("questions card: stored pending, project clarifying, emitter sees the V2 fields", () => {
  const project = createAppProject({ title: "card-create", baseWorkspace: tmp });
  const seen: QuestionsCard[] = [];
  const card = lead.createQuestionsCard(
    { project, runId: "run_x", title: "Quick check", questions: lead.validateQuestionSpecs(questionJson()).questions },
    (p, c) => seen.push(c),
  );
  assert.match(card.id, /^qc_[a-z2-7]{12}$/);
  assert.equal(card.status, "pending");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.projectId, project.id);
  assert.equal(getAppProject(project.id)!.status, "clarifying");
});

test("questions card: answer stores usedDefault and builds the lead message", () => {
  const project = createAppProject({ title: "card-answer", baseWorkspace: tmp });
  const card = lead.createQuestionsCard({ project, runId: "run_x", title: "t", questions: lead.validateQuestionSpecs(questionJson()).questions }, () => {});
  const r = lead.resolveQuestionsCard(project, card.id, { answers: [{ questionId: "q1", optionIds: ["o1"] }] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.card.status, "answered");
  assert.equal(r.card.answers![0]!.usedDefault, true, "submitting the default marks usedDefault");
  assert.match(r.leadMessage, /\[default\]/);

  const changed = lead.createQuestionsCard({ project, runId: "run_x", title: "t", questions: lead.validateQuestionSpecs(questionJson()).questions }, () => {});
  const r2 = lead.resolveQuestionsCard(project, changed.id, { answers: [{ questionId: "q1", optionIds: ["o2"], usedDefault: false }] });
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.card.answers![0]!.usedDefault, false);
});

test("questions card: skip marks the card skipped; a resolved card refuses a second decision", () => {
  const project = createAppProject({ title: "card-skip", baseWorkspace: tmp });
  const card = lead.createQuestionsCard({ project, runId: "run_x", title: "t", questions: lead.validateQuestionSpecs(questionJson()).questions }, () => {});
  const skipped = lead.resolveQuestionsCard(project, card.id, { skip: true });
  assert.equal(skipped.ok, true);
  if (skipped.ok) {
    assert.equal(skipped.card.status, "skipped");
    assert.match(skipped.leadMessage, /skipped/);
  }
  const again = lead.resolveQuestionsCard(project, card.id, { skip: true });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.error, "already_resolved");
  assert.equal(lead.resolveQuestionsCard(project, "qc_nope", { skip: true }).ok, false);
});

// ---------- §4.2.2 plan validation ----------

test("plan validation: deps must exist and cycles are rejected (Kahn)", () => {
  const cyclic = planDoc("cyclic", {
    tasks: [
      { id: "T1", title: "a", role: "engineer", deps: ["T2"], status: "pending", acceptance: ["x works"] },
      { id: "T2", title: "b", role: "engineer", deps: ["T1"], status: "pending", acceptance: ["y works"] },
    ],
  });
  const v = lead.validatePlanDocument(cyclic);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes("cycle")));

  const unknownDep = planDoc("unknown-dep", {
    tasks: [{ id: "T1", title: "a", role: "engineer", deps: ["T9"], status: "pending", acceptance: ["x works"] }],
  });
  assert.equal(lead.validatePlanDocument(unknownDep).ok, false);

  assert.equal(lead.validatePlanDocument(planDoc("ok")).ok, true);

  const tooMany = planDoc("too-many", { tasks: Array.from({ length: 21 }, (_, i) => ({ id: `T${i + 1}`, title: `t${i + 1}`, role: "engineer" as const, deps: [], status: "pending" as const, acceptance: ["works"] })) });
  const vMany = lead.validatePlanDocument(tooMany);
  assert.equal(vMany.ok, false);
  assert.ok(vMany.problems.some((p) => p.includes("1 to 20")));

  const badSource = planDoc("bad-source", { keyDecisions: [{ date: "2026-10-29", decision: "d", rationale: "r", source: "wild-guess" as never }] });
  assert.equal(lead.validatePlanDocument(badSource).ok, false);
});

// ---------- §4.2.2 draft lifecycle: revisions, decline, stale 409, approve, edit ----------

test("plan lifecycle: decline → revision 2 supersedes → stale approve returns the 409 contract → approve writes context", () => {
  const project = createAppProject({ title: "plan-lifecycle", baseWorkspace: tmp });
  const run = insertRun({ projectId: project.id, flavor: "goal", prompt: "build it" });

  const d1 = lead.createPlanDraft(project, run.id, planDoc("v1"));
  assert.equal(d1.revision, 1);
  assert.equal(d1.status, "draft");
  assert.equal(getAppProject(project.id)!.status, "awaiting_approval");

  const declined = lead.declinePlanDraft(project, "I need offline support");
  assert.equal(declined.ok, true);
  if (declined.ok) {
    assert.equal(declined.draft.status, "declined");
    assert.ok(declined.resumeInstruction!.includes("<<<USER_REASON"));
    assert.ok(declined.resumeInstruction!.includes("I need offline support"));
    assert.ok(declined.resumeInstruction!.includes("USER_REASON>>>"));
  }

  const d2 = lead.createPlanDraft(project, run.id, planDoc("v2"));
  assert.equal(d2.revision, 2);
  assert.equal(getPlanDraft(d1.id)!.status, "declined", "a decided draft keeps its decision; only a draft row is superseded");

  // Approving revision 1 while revision 2 is the latest draft: 409 contract.
  const stale = lead.approvePlanDraft(project, d1.revision);
  assert.equal(stale.ok, false);
  if (!stale.ok && stale.error === "stale_revision") assert.equal(stale.latest, 2);

  const approved = lead.approvePlanDraft(project, d2.revision);
  assert.equal(approved.ok, true);
  const projectMd = fs.readFileSync(path.join(project.workspaceDir, ".loam", "context", "PROJECT.md"), "utf8");
  assert.ok(projectMd.includes("One sentence overview."), "approval renders the context files (§4.2.2 rule 6)");
  assert.equal(getAppProject(project.id)!.status, "building");
  assert.equal(latestPlanDraft(project.id)!.status, "approved");

  const again = lead.approvePlanDraft(project, d2.revision);
  assert.equal(again.ok, false);
});

test("plan edit: changed decisions are marked source user, carried-over ones keep their source", () => {
  const project = createAppProject({ title: "plan-edit", baseWorkspace: tmp });
  const run = insertRun({ projectId: project.id, flavor: "goal", prompt: "build it" });
  lead.createPlanDraft(project, run.id, planDoc("v1"));

  const edited = planDoc("v2-edited", {
    keyDecisions: [
      { date: "2026-10-29", decision: "No accounts", rationale: "default: user did not say", source: "default" },
      { date: "2026-10-29", decision: "Offline first", rationale: "user asked in the edit", source: "user" },
    ],
  });
  const r = lead.editPlanDraft(project, run.id, edited);
  assert.equal(r.ok, true);
  const draft = latestPlanDraft(project.id)!;
  assert.equal(draft.revision, 2);
  assert.equal(draft.status, "draft", "an edit waits for approval again");
  const sources = new Map(draft.doc.keyDecisions.map((d) => [d.decision, d.source]));
  assert.equal(sources.get("No accounts"), "default", "unchanged decision keeps its source");
  assert.equal(sources.get("Offline first"), "user", "new decision is the user's");

  const invalid = lead.editPlanDraft(project, run.id, { title: "x" });
  assert.equal(invalid.ok, false);
});

// ---------- §4.2.4 assignments ----------

test("assignments: create refuses before approval and for unassignable roles; finish sets plan tasks done", () => {
  const project = createAppProject({ title: "assign", baseWorkspace: tmp });
  const run = insertRun({ projectId: project.id, flavor: "goal", prompt: "build it" });
  lead.createPlanDraft(project, run.id, planDoc("assign-v1"));

  const early = lead.createAssignmentForPlan(project, { role: "engineer", planTaskIds: ["T1"], brief: "x".repeat(80) });
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.error, "plan not approved");

  assert.equal(lead.approvePlanDraft(project, 1).ok, true);

  // seo is only assignable when the plan carries the seo-blog feature.
  const seo = lead.createAssignmentForPlan(project, { role: "seo", planTaskIds: ["T1"], brief: "x".repeat(80) });
  assert.equal(seo.ok, false);
  const unknownTask = lead.createAssignmentForPlan(project, { role: "engineer", planTaskIds: ["T9"], brief: "x".repeat(80) });
  assert.equal(unknownTask.ok, false);

  const created = lead.createAssignmentForPlan(project, { role: "engineer", planTaskIds: ["T1", "T2"], brief: "Build the list and verify the whole flow end to end, then report what you checked." });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.match(created.assignment.id, /^as_[a-z2-7]{12}$/);
  assert.equal(created.assignment.status, "queued");
  assert.deepEqual(created.assignment.planTaskIds, ["T1", "T2"]);

  const finished = lead.finishAssignmentForPlan(project, { assignmentId: created.assignment.id, outcome: "done", summary: "List built and verified with app_verify." });
  assert.equal(finished.ok, true);
  if (finished.ok) {
    assert.equal(finished.assignment.status, "done");
    assert.ok(finished.assignment.finishedAt);
    assert.ok(finished.assignment.report!.includes("app_verify"));
  }
  const doc = latestPlanDraft(project.id)!.doc;
  assert.equal(doc.tasks.find((t) => t.id === "T1")!.status, "done", "app_task_finish sets plan tasks done");
  assert.equal(doc.tasks.find((t) => t.id === "T2")!.status, "done");

  const twice = lead.finishAssignmentForPlan(project, { assignmentId: created.assignment.id, outcome: "failed", summary: "x".repeat(20) });
  assert.equal(twice.ok, false);
});

// ---------- injected-executor lead turns ----------

function executorWith(replies: string[]) {
  let i = 0;
  return {
    async call() {
      const text = replies[Math.min(i, replies.length - 1)]!;
      i += 1;
      return { text };
    },
  };
}

test("runLeadClarify: empty questions JSON means no card; invalid then valid re-asks once; twice invalid skips", async () => {
  const project = createAppProject({ title: "clarify", baseWorkspace: tmp });
  const none = await lead.runLeadClarify({ project, runId: "run_c", userPrompt: "Build a pomodoro timer", executor: executorWith(['{"questions":[]}']) });
  assert.equal(none.kind, "no_questions");

  const cards: QuestionsCard[] = [];
  const got = await lead.runLeadClarify({
    project, runId: "run_c", userPrompt: "Build something",
    executor: executorWith(["not json at all", JSON.stringify(questionJson())]),
    emit: (_p, c) => cards.push(c),
  });
  assert.equal(got.kind, "questions_card");
  if (got.kind === "questions_card") assert.equal(cards[0]!.id, got.card.id);

  const skip = await lead.runLeadClarify({ project, runId: "run_c", userPrompt: "Build something", executor: executorWith(["nope", "still nope"]) });
  assert.equal(skip.kind, "skip_questions");
});

test("runLeadPlan: valid plan becomes a draft; runLeadTurn folds the skip note into the plan ask", async () => {
  const project = createAppProject({ title: "lead-plan", baseWorkspace: tmp });
  const run = insertRun({ projectId: project.id, flavor: "goal", prompt: "build it" });
  const planned = await lead.runLeadPlan({ project, runId: run.id, userPrompt: "A small timer", executor: executorWith([JSON.stringify(planDoc("Timer"))]) });
  assert.equal(planned.kind, "plan_draft");
  if (planned.kind === "plan_draft") assert.equal(planned.draft.revision, 1);

  const bad = await lead.runLeadPlan({ project, runId: run.id, userPrompt: "again", executor: executorWith(["garbage", "garbage twice"]) });
  assert.equal(bad.kind, "invalid_plan");

  const turn = await lead.runLeadTurn({
    project, runId: run.id, userPrompt: "another one",
    executor: executorWith(['{"questions":[]}', JSON.stringify(planDoc("Turn plan"))]),
    emit: () => {},
  });
  assert.equal(turn.kind, "plan_draft");
});
