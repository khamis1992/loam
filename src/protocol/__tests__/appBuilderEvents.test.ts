/**
 * Protocol tests for the App Builder run-bound events (MISSING §4.15.1).
 *
 * The engine emits snake_case AgentEvents (`app_questions_required` …); the
 * protocol maps them to the app* ChatEvents the App panel renders. These tests
 * exercise the mapper end to end for every name added by W3-c.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentEvent } from "../../agent/events.js";
import { createEventMapperState, mapAgentEvent } from "../events.js";
import type { ChatEvent } from "../types.js";

function mapAll(events: AgentEvent[]): ChatEvent[] {
  const state = createEventMapperState();
  return events.flatMap((event) => mapAgentEvent(event, state, "app_sess"));
}

const card = {
  id: "qc_aaaaaaaaaaaa", projectId: "app_aaaaaaaaaaaa", runId: "run_aaaaaaaaaaaa",
  title: "Quick check",
  questions: [{
    id: "q1", prompt: "Who uses it?", kind: "single" as const,
    options: [{ id: "o1", label: "Me" }, { id: "o2", label: "Team" }],
    defaultOptionIds: ["o1"], allowOther: false,
  }],
  status: "pending" as const, answers: null, createdAt: "2026-10-29T00:00:00.000Z", answeredAt: null,
};

const draft = {
  id: "pd_aaaaaaaaaaaa", projectId: "app_aaaaaaaaaaaa", runId: "run_aaaaaaaaaaaa",
  revision: 1, status: "draft" as const,
  doc: {
    title: "p", overview: "o", scenario: "web_app" as const, templateId: "web-app" as const,
    features: [], keyDecisions: [], constraints: [], requirements: [], userStories: [], tasks: [],
  },
  declineReason: null, createdAt: "2026-10-29T00:00:00.000Z", decidedAt: null,
};

const assignment = {
  id: "as_aaaaaaaaaaaa", projectId: "app_aaaaaaaaaaaa", planDraftId: "pd_aaaaaaaaaaaa",
  planTaskIds: ["T1"], role: "engineer" as const, brief: "b", status: "running" as const,
  report: null, startedAt: null, finishedAt: null,
};

const version = {
  projectId: "app_aaaaaaaaaaaa", number: 1, title: "t", summary: "s", commit: "0".repeat(40),
  parentNumber: null, source: "build" as const, filesChanged: [], verifyReportId: null,
  usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, credits: 0, wallMs: 0, toolCalls: 0 },
  addedPackages: [], createdAt: "2026-10-29T00:00:00.000Z",
};

describe("app builder events in mapAgentEvent", () => {
  it("maps every app_* AgentEvent name to its app* ChatEvent", () => {
    const events: AgentEvent[] = [
      { type: "app_questions_required", projectId: "app_aaaaaaaaaaaa", card },
      { type: "app_questions_resolved", projectId: "app_aaaaaaaaaaaa", cardId: card.id, status: "answered" },
      { type: "app_plan_draft", projectId: "app_aaaaaaaaaaaa", draft },
      { type: "app_plan_decided", projectId: "app_aaaaaaaaaaaa", draftId: draft.id, revision: 1, decision: "approved" },
      { type: "app_assignment", projectId: "app_aaaaaaaaaaaa", assignment },
      { type: "app_verify_report", requestId: "vr_1", projectId: "app_aaaaaaaaaaaa", runId: "run_1", attempt: 1, tier: "standard", pass: true, error: null },
      { type: "app_version", projectId: "app_aaaaaaaaaaaa", phase: "created", version },
    ];
    const out = mapAll(events);
    assert.deepEqual(out.map((e) => e.type), [
      "appQuestionsRequested", "appQuestionsResolved", "appPlanDraft",
      "appPlanDecided", "appAssignment", "appVerifyReport", "appVersion",
    ]);
    // ids/timestamps on every mapped event
    for (const e of out) {
      assert.ok(e.id.length > 0);
      assert.equal(typeof e.timestamp, "number");
    }
  });

  it("carries the payloads through unchanged", () => {
    const [asked, decided, verified, versioned] = mapAll([
      { type: "app_questions_required", projectId: card.projectId, card },
      { type: "app_plan_decided", projectId: "app_aaaaaaaaaaaa", draftId: draft.id, revision: 2, decision: "declined", reason: "أريد تعديلاً" },
      { type: "app_verify_report", requestId: "vr_2", projectId: "app_aaaaaaaaaaaa", runId: "run_2", attempt: 3, tier: "fast", pass: false, error: "verify_limit" },
      { type: "app_version", projectId: "app_aaaaaaaaaaaa", phase: "updated", version },
    ]) as [ChatEvent, ChatEvent, ChatEvent, ChatEvent];
    assert.equal(asked.type, "appQuestionsRequested");
    assert.equal((asked as { card: typeof card }).card.questions[0]!.prompt, "Who uses it?");
    assert.equal(decided.type, "appPlanDecided");
    const d = decided as { decision: string; reason?: string; revision: number };
    assert.equal(d.decision, "declined");
    assert.equal(d.reason, "أريد تعديلاً");
    assert.equal(d.revision, 2);
    const v = verified as { attempt: number; pass: boolean; error: string | null };
    assert.equal(v.attempt, 3);
    assert.equal(v.pass, false);
    assert.equal(v.error, "verify_limit");
    assert.equal((versioned as { phase: string }).phase, "updated");
    assert.equal((versioned as unknown as { version: typeof version }).version.number, 1);
  });
});
