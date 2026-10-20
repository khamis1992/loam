import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

import type { AgentRecord } from "../agents.js";

let tmpDir = "";
let closeDb: () => void;
let createAgent: (input: { name: string; instructions?: string }) => AgentRecord;
let updateAgent: typeof import("../agents.js").updateAgent;
let getAgent: typeof import("../agents.js").getAgent;
let proposeInstructions: typeof import("../instructionHistory.js").proposeInstructions;
let approveProposal: typeof import("../instructionHistory.js").approveProposal;
let rejectProposal: typeof import("../instructionHistory.js").rejectProposal;
let listVersions: typeof import("../instructionHistory.js").listVersions;
let listProposals: typeof import("../instructionHistory.js").listProposals;
let recordUserEdit: typeof import("../instructionHistory.js").recordUserEdit;
let makeUnifiedDiff: typeof import("../instructionHistory.js").makeUnifiedDiff;

function fixtureAgent(): AgentRecord {
  return createAgent({ name: "hist-test-agent", instructions: "line1\nline2\nline3" });
}

describe("instructionHistory", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-instr-hist-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    const agents = await import("../agents.js");
    createAgent = agents.createAgent;
    updateAgent = agents.updateAgent;
    getAgent = agents.getAgent;
    const hist = await import("../instructionHistory.js");
    proposeInstructions = hist.proposeInstructions;
    approveProposal = hist.approveProposal;
    rejectProposal = hist.rejectProposal;
    listVersions = hist.listVersions;
    listProposals = hist.listProposals;
    recordUserEdit = hist.recordUserEdit;
    makeUnifiedDiff = hist.makeUnifiedDiff;
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("proposes an agent instruction update as source agent, status proposed", () => {
    const agent = fixtureAgent();
    const p = proposeInstructions(agent.id, "line1\nline2\nline3\nline4", "add one line");
    assert.match(p.id, /^ins_/);
    assert.equal(p.agentId, agent.id);
    assert.equal(p.instructions, "line1\nline2\nline3\nline4");
    assert.equal(p.reason, "add one line");
    assert.equal(p.version, 1);
    assert.ok(p.diff.includes("-line3") || p.diff.includes("+line4"));

    assert.equal(listProposals(agent.id, "proposed").length, 1);
    const v = listVersions(agent.id)[0]!;
    assert.equal(v.id, p.id);
    assert.equal(v.source, "agent");
    assert.equal(v.status, "proposed");
    assert.equal(v.diff, p.diff);
    assert.equal(v.decidedAt, undefined);
  });

  it("propose to unknown agent throws", () => {
    assert.throws(() => proposeInstructions("nope", "x"), /agent not found: nope/);
  });

  it("approve applies the proposal via updateAgent", () => {
    const agent = fixtureAgent();
    const p = proposeInstructions(agent.id, "new instructions text", "better focus");
    const approved = approveProposal(p.id);
    assert.ok(approved);
    assert.equal(approved!.status, "approved");
    assert.equal(approved!.decidedAt, approved!.decidedAt);
    assert.ok(typeof approved!.decidedAt === "string");
    assert.equal(getAgent(agent.id)!.instructions, "new instructions text");
  });

  it("approve returns undefined for unknown or already-decided proposals", () => {
    const agent = fixtureAgent();
    assert.equal(approveProposal("ins_missing"), undefined);
    const p = proposeInstructions(agent.id, "v", "");
    assert.ok(approveProposal(p.id));
    assert.equal(approveProposal(p.id), undefined);
  });

  it("reject marks rejected without touching agent instructions", () => {
    const agent = fixtureAgent();
    const p = proposeInstructions(agent.id, "should not apply");
    const rejected = rejectProposal(p.id);
    assert.ok(rejected);
    assert.equal(rejected!.status, "rejected");
    assert.ok(typeof rejected!.decidedAt === "string");
    assert.equal(getAgent(agent.id)!.instructions, "line1\nline2\nline3");
    assert.equal(rejectProposal(p.id), undefined);
  });

  it("lists versions newest first with incrementing versions, and records user edits", () => {
    const agent = fixtureAgent();
    proposeInstructions(agent.id, "edit a", "");
    const edit = recordUserEdit(agent.id, "edit a", "edit b");
    proposeInstructions(agent.id, "edit c", "");

    const versions = listVersions(agent.id);
    assert.equal(versions.length, 3);
    const vIds = versions.map((v) => v.version);
    assert.deepStrictEqual([...vIds].sort((a, b) => b - a), vIds);
    const byStatus = (s: string) => versions.filter((v) => v.status === s).length;
    assert.equal(byStatus("proposed"), 2);
    assert.equal(byStatus("approved"), 1);

    assert.equal(edit.source, "user");
    assert.equal(edit.status, "approved");
    assert.ok(typeof edit.decidedAt === "string");
    assert.equal(edit.instructions, "edit b");
    assert.equal(edit.id, versions.find((v) => v.id === edit.id)!.id);

    assert.throws(() => recordUserEdit("nope", "a", "b"), /agent not found: nope/);
  });

  it("makeUnifiedDiff emits standard headers and +/- content lines", () => {
    const diff = makeUnifiedDiff("line1\nline2\nline3", "line1\nline2X\nline3");
    assert.ok(diff.startsWith("--- a/old\n+++ b/new"));
    assert.ok(diff.includes("-line2"));
    assert.ok(diff.includes("+line2X"));
    assert.ok(diff.includes(" line1"));
    assert.ok(!diff.includes("-line1"));

    assert.equal(makeUnifiedDiff("same", "same"), "");
  });
});
