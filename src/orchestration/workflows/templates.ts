/**
 * C7 starter workflow templates, seeded as `source: "template"` rows the first
 * time the workflow store is used. The 12 existing prompt templates stay as
 * they are; these are graph definitions for the workflow engine.
 */
import type { WorkflowDef } from "../workflows/types.js";
import { listWorkflows, saveWorkflow } from "../workflows/store.js";

const nutrioOfferReview: WorkflowDef = {
  id: "nutrio-offer-review",
  version: 1,
  title: "Nutrio offer review",
  description: "Three drafts in parallel, a vote picks the best, a human approves, then it is published.",
  inputs: { type: "object", required: ["market"], properties: { market: { type: "string", maxLength: 200 } } },
  start: "brief",
  nodes: [
    { id: "brief", kind: "transform", title: "Brief", transform: { set: { brief: "Offer for {{inputs.market}}" } } },
    { id: "draft_a", kind: "agent", title: "Draft A", outputKey: "a", agent: { prompt: "{{state.brief}} — draft a concrete offer (variant A)." } },
    { id: "draft_b", kind: "agent", title: "Draft B", outputKey: "b", agent: { prompt: "{{state.brief}} — draft a concrete offer (variant B)." } },
    { id: "draft_c", kind: "agent", title: "Draft C", outputKey: "c", agent: { prompt: "{{state.brief}} — draft a concrete offer (variant C)." } },
    { id: "pick", kind: "vote", title: "Pick best", outputKey: "best", waitFor: ["draft_a", "draft_b", "draft_c"], vote: { from: ["draft_a", "draft_b", "draft_c"], goal: "{{state.brief}}" } },
    { id: "approve", kind: "human", title: "Approve", outputKey: "decision", human: { title: "Approve offer", question: "Ship {{state.best.text}}?", options: ["yes", "no"], ttlMs: 86_400_000 } },
    { id: "gate", kind: "condition", condition: { op: "eq", path: "state.decision", value: "yes" } },
    { id: "publish", kind: "tool", title: "Publish", outputKey: "published", tool: { name: "file_write", args: { path: "offer.md", content: "{{state.best.text}}" } } },
    { id: "revise", kind: "agent", title: "Revise", outputKey: "revised", agent: { prompt: "Revise this rejected offer: {{state.best.text}}" } },
  ],
  edges: [
    { from: "brief", to: "draft_a" },
    { from: "brief", to: "draft_b" },
    { from: "brief", to: "draft_c" },
    { from: "draft_a", to: "pick" },
    { from: "draft_b", to: "pick" },
    { from: "draft_c", to: "pick" },
    { from: "pick", to: "approve" },
    { from: "approve", to: "gate" },
    { from: "gate", to: "publish", when: "true" },
    { from: "gate", to: "revise", when: "false" },
  ],
};

const researchThenWrite: WorkflowDef = {
  id: "research-then-write",
  version: 1,
  title: "Research then write",
  description: "A research agent gathers sources, a writing agent drafts from them, a human approves.",
  inputs: { type: "object", required: ["topic"], properties: { topic: { type: "string", maxLength: 500 } } },
  start: "research",
  nodes: [
    { id: "research", kind: "agent", title: "Research", outputKey: "notes", agent: { prompt: "Research {{inputs.topic}} and leave structured notes with sources.", mode: "research" } },
    { id: "write", kind: "agent", title: "Write", outputKey: "draft", agent: { prompt: "Write the final document about {{inputs.topic}} from these notes:\n{{state.notes}}", mode: "write" } },
    { id: "approve", kind: "human", title: "Approve", outputKey: "decision", human: { title: "Approve draft", question: "Publish this draft?", options: ["yes", "no"] } },
    { id: "gate", kind: "condition", condition: { op: "eq", path: "state.decision", value: "yes" } },
    { id: "save", kind: "tool", title: "Save", outputKey: "saved", tool: { name: "file_write", args: { path: "draft.md", content: "{{state.draft}}" } } },
    { id: "redo", kind: "agent", title: "Redo", outputKey: "redo", agent: { prompt: "The reviewer rejected this draft; rewrite it:\n{{state.draft}}" } },
  ],
  edges: [
    { from: "research", to: "write" },
    { from: "write", to: "approve" },
    { from: "approve", to: "gate" },
    { from: "gate", to: "save", when: "true" },
    { from: "gate", to: "redo", when: "false" },
  ],
};

const fixWithCandidates: WorkflowDef = {
  id: "fix-with-candidates",
  version: 1,
  title: "Fix with candidates",
  description: "Three build agents attempt the fix in parallel, a vote picks one, a human approves landing it.",
  inputs: { type: "object", required: ["bug"], properties: { bug: { type: "string", maxLength: 2000 } } },
  start: "attempt_a",
  nodes: [
    { id: "attempt_a", kind: "agent", title: "Attempt A", outputKey: "a", agent: { prompt: "Fix this bug and verify with the tests:\n{{inputs.bug}}", mode: "build" } },
    { id: "attempt_b", kind: "agent", title: "Attempt B", outputKey: "b", agent: { prompt: "Fix this bug differently and verify:\n{{inputs.bug}}", mode: "build" } },
    { id: "attempt_c", kind: "agent", title: "Attempt C", outputKey: "c", agent: { prompt: "Fix this bug with the smallest change and verify:\n{{inputs.bug}}", mode: "build" } },
    { id: "pick", kind: "vote", title: "Pick fix", outputKey: "best", waitFor: ["attempt_a", "attempt_b", "attempt_c"], vote: { from: ["attempt_a", "attempt_b", "attempt_c"], goal: "best fix for: {{inputs.bug}}" } },
    { id: "approve", kind: "human", title: "Approve fix", outputKey: "decision", human: { title: "Approve fix", question: "Land the selected fix?", options: ["yes", "no"] } },
    { id: "gate", kind: "condition", condition: { op: "eq", path: "state.decision", value: "yes" } },
    { id: "land", kind: "tool", title: "Land", outputKey: "landed", tool: { name: "file_write", args: { path: "selected-fix.md", content: "{{state.best.text}}" } } },
  ],
  edges: [
    { from: "attempt_a", to: "pick" },
    { from: "attempt_b", to: "pick" },
    { from: "attempt_c", to: "pick" },
    { from: "pick", to: "approve" },
    { from: "approve", to: "gate" },
    { from: "gate", to: "land", when: "true" },
  ],
};

export const WORKFLOW_TEMPLATES: WorkflowDef[] = [nutrioOfferReview, researchThenWrite, fixWithCandidates];

/** Seeds the templates once; existing rows (user edits) are never overwritten. */
export function seedWorkflowTemplates(): void {
  try {
    const existing = new Set(listWorkflows().map((w) => w.id));
    for (const t of WORKFLOW_TEMPLATES) {
      if (!existing.has(t.id)) saveWorkflow(t, "template");
    }
  } catch {
    /* seeding is best effort; the store still works empty */
  }
}
