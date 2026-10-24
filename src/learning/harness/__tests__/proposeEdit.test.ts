import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentRecord } from "../../../server/agents.js";
import type { Lesson } from "../types.js";

let tmpDir = "";
let closeDb: () => void;
let createAgent: (input: { name: string; instructions?: string }) => AgentRecord;
let getAgent: typeof import("../../../server/agents.js").getAgent;
let listProposals: typeof import("../../../server/instructionHistory.js").listProposals;
let listVersions: typeof import("../../../server/instructionHistory.js").listVersions;
let approveProposal: typeof import("../../../server/instructionHistory.js").approveProposal;
let addLesson: typeof import("../experienceStore.js").addLesson;
let markUsed: typeof import("../experienceStore.js").markUsed;
let proposePromotions: typeof import("../proposeEdit.js").proposePromotions;
let PROMOTE_MIN_USES: number;

describe("proposePromotions (H6)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-propose-edit-"));
    process.env.LOAM_DATA_DIR = tmpDir;
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;

    const sqlite = await import("../../../server/sqliteStore.js");
    closeDb = sqlite.closeDb;
    const agents = await import("../../../server/agents.js");
    createAgent = agents.createAgent;
    getAgent = agents.getAgent;
    const hist = await import("../../../server/instructionHistory.js");
    listProposals = hist.listProposals;
    listVersions = hist.listVersions;
    approveProposal = hist.approveProposal;
    const store = await import("../experienceStore.js");
    addLesson = store.addLesson;
    markUsed = store.markUsed;
    const mod = await import("../proposeEdit.js");
    proposePromotions = mod.proposePromotions;
    PROMOTE_MIN_USES = mod.PROMOTE_MIN_USES;
  });

  after(() => {
    try {
      closeDb();
    } catch {
      /* ignore */
    }
    delete process.env.LOAM_DATA_DIR;
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("exports PROMOTE_MIN_USES = 3", () => {
    assert.equal(PROMOTE_MIN_USES, 3);
  });

  it("returns null when no lessons meet promotion criteria", () => {
    const agent = createAgent({ name: "agent-empty", instructions: "Base instructions" });
    const proposalId = proposePromotions(agent.id, agent.instructions);
    assert.strictEqual(proposalId, null);
    assert.strictEqual(listProposals(agent.id, "proposed").length, 0);
  });

  it("high lesson with uses=3 creates exactly one 'proposed' proposal and does not change approved instructions", async () => {
    const initialInstructions = "You are a helpful coding assistant.";
    const agent = createAgent({ name: "agent-promotable", instructions: initialInstructions });

    const les = await addLesson({
      agentId: agent.id,
      domain: "coding",
      source: "correction",
      sourceRef: "cor_01",
      d: {
        cue: "writing unit tests.",
        lesson: "always use node:test with explicit assertions.",
        evidence: "user corrected test framework choice.",
        confidence: "high",
      },
    });
    assert.ok(les, "lesson was stored");

    // Increment uses to 3 (PROMOTE_MIN_USES)
    markUsed([les.id]);
    markUsed([les.id]);
    markUsed([les.id]);

    // Check before: agent has initial instructions, no proposals
    assert.strictEqual(getAgent(agent.id)?.instructions, initialInstructions);
    assert.strictEqual(listProposals(agent.id, "proposed").length, 0);

    // Call proposePromotions
    const proposalId = proposePromotions(agent.id, initialInstructions);
    assert.ok(proposalId, "proposal id returned");
    assert.strictEqual(typeof proposalId, "string");

    // Verify agent instructions are UNCHANGED
    const agentAfter = getAgent(agent.id);
    assert.strictEqual(agentAfter?.instructions, initialInstructions, "instructions must NOT change automatically");

    // Verify exactly one proposal created with status 'proposed'
    const proposals = listProposals(agent.id, "proposed");
    assert.strictEqual(proposals.length, 1);
    const proposal = proposals[0];
    assert.strictEqual(proposal?.id, proposalId);
    assert.strictEqual(proposal?.agentId, agent.id);
    assert.ok(proposal?.instructions.includes("## Learned rules"));
    assert.ok(proposal?.instructions.includes("- When writing unit tests: always use node:test with explicit assertions."));

    // Check instruction_versions row status is 'proposed'
    const versions = listVersions(agent.id);
    const versionRow = versions.find((v) => v.id === proposalId);
    assert.ok(versionRow, "version row exists");
    assert.strictEqual(versionRow.status, "proposed");

    // When approveProposal is called by human, instructions update
    const approved = approveProposal(proposalId);
    assert.ok(approved, "proposal approved");
    assert.strictEqual(approved.status, "approved");

    const agentApproved = getAgent(agent.id);
    assert.strictEqual(agentApproved?.instructions, proposal.instructions.trim());
    assert.ok(agentApproved?.instructions.includes("always use node:test with explicit assertions."));
  });

  it("does not propose lesson with uses < 3", async () => {
    const initialInstructions = "You are a concise helper.";
    const agent = createAgent({ name: "agent-low-uses", instructions: initialInstructions });

    const les = await addLesson({
      agentId: agent.id,
      domain: "chat",
      source: "correction",
      sourceRef: "cor_02",
      d: {
        cue: "user asks for summary",
        lesson: "keep summary under 3 bullet points.",
        evidence: "user asked for shorter summary.",
        confidence: "high",
      },
    });
    assert.ok(les);

    // Only 2 uses (< 3)
    markUsed([les.id]);
    markUsed([les.id]);

    const proposalId = proposePromotions(agent.id, initialInstructions);
    assert.strictEqual(proposalId, null);
    assert.strictEqual(listProposals(agent.id, "proposed").length, 0);
  });

  it("does not propose lesson with medium or low confidence even if uses >= 3", async () => {
    const initialInstructions = "You are an assistant.";
    const agent = createAgent({ name: "agent-med-conf", instructions: initialInstructions });

    const lesMed = await addLesson({
      agentId: agent.id,
      domain: "chat",
      source: "correction",
      sourceRef: "cor_03",
      d: {
        cue: "formatting markdown tables",
        lesson: "always align right for numbers.",
        evidence: "user prefers right alignment.",
        confidence: "medium",
      },
    });
    assert.ok(lesMed);
    markUsed([lesMed.id]);
    markUsed([lesMed.id]);
    markUsed([lesMed.id]);

    const proposalId = proposePromotions(agent.id, initialInstructions);
    assert.strictEqual(proposalId, null);
    assert.strictEqual(listProposals(agent.id, "proposed").length, 0);
  });

  it("does not propose lesson if currentInstructions already contains the lesson", async () => {
    const initialInstructions = "You are an assistant.\n\n## Learned rules\n- When user says hello: say hello back.";
    const agent = createAgent({ name: "agent-already-included", instructions: initialInstructions });

    const les = await addLesson({
      agentId: agent.id,
      domain: "chat",
      source: "correction",
      sourceRef: "cor_04",
      d: {
        cue: "user says hello",
        lesson: "say hello back.",
        evidence: "observed greeting feedback.",
        confidence: "high",
      },
    });
    assert.ok(les);
    markUsed([les.id]);
    markUsed([les.id]);
    markUsed([les.id]);

    const proposalId = proposePromotions(agent.id, initialInstructions);
    assert.strictEqual(proposalId, null);
    assert.strictEqual(listProposals(agent.id, "proposed").length, 0);
  });

  it("does not promote lessons belonging to another agent", async () => {
    const agentA = createAgent({ name: "agent-a", instructions: "Agent A instructions" });
    const agentB = createAgent({ name: "agent-b", instructions: "Agent B instructions" });

    const lesA = await addLesson({
      agentId: agentA.id,
      domain: "writing",
      source: "correction",
      sourceRef: "cor_05",
      d: {
        cue: "writing essays",
        lesson: "include a conclusion section.",
        evidence: "user feedback on essay structure.",
        confidence: "high",
      },
    });
    assert.ok(lesA);
    markUsed([lesA.id]);
    markUsed([lesA.id]);
    markUsed([lesA.id]);

    // Check agentB cannot promote agentA's lesson
    const proposalB = proposePromotions(agentB.id, agentB.instructions);
    assert.strictEqual(proposalB, null);
    assert.strictEqual(listProposals(agentB.id, "proposed").length, 0);

    // AgentA CAN promote it
    const proposalA = proposePromotions(agentA.id, agentA.instructions);
    assert.ok(proposalA);
    assert.strictEqual(listProposals(agentA.id, "proposed").length, 1);
  });
});
