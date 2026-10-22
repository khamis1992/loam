/**
 * MF10 tests: shared board domain (atomic claim, status transitions, comments)
 * and the effective agent-run tool list (board tools must be exposed via the
 * always-on merge, mirroring the MF1 lesson from runTools.test.ts).
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

import type { ToolRegistry } from "../../tools/registry.js";

let tmpDir = "";
let closeDb: () => void;
let board: typeof import("../board.js");
let ALWAYS_ON_TOOLS: readonly string[];
let mergeAlwaysOnTools: (input: { resolvedAllow: readonly string[]; registeredTools: readonly string[]; disabledTools?: string[] }) => string[];

describe("shared ticket board", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-board-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    board = await import("../board.js");
    const runToolsMod = await import("../runTools.js");
    ALWAYS_ON_TOOLS = runToolsMod.ALWAYS_ON_TOOLS;
    mergeAlwaysOnTools = runToolsMod.mergeAlwaysOnTools;
  });

  after(() => {
    closeDb();
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates tickets with defaults on the default board", () => {
    const ticket = board.createTicket({ title: "wire the parser", body: "make it fast", createdBy: "agent_a" });
    assert.equal(ticket.status, "todo");
    assert.equal(ticket.priority, "normal");
    assert.equal(ticket.assigneeAgentId, null);
    assert.equal(ticket.createdBy, "agent_a");
    assert.ok(board.listTickets().some((t) => t.id === ticket.id));
  });

  it("rejects empty titles and invalid priorities", () => {
    assert.throws(() => board.createTicket({ title: "   " }), /title is required/);
    assert.throws(
      () => board.createTicket({ title: "x", priority: "critical" as never }),
      /invalid priority: critical/,
    );
  });

  it("claiming is atomic: exactly one winner among concurrent claims", async () => {
    const ticket = board.createTicket({ title: "racy ticket" });
    const results = await Promise.all(
      ["agent_1", "agent_2", "agent_3"].map((agentId) => board.claimTicket(ticket.id, agentId)),
    );
    const winners = results.filter(Boolean);
    assert.equal(winners.length, 1, "atomic claim must have exactly one winner");
    const winner = winners[0]!;
    assert.ok(["agent_1", "agent_2", "agent_3"].includes(winner.assigneeAgentId!));
    // A second sequential claim on the already-assigned ticket loses.
    const loser = board.claimTicket(ticket.id, "agent_4");
    assert.equal(loser, undefined);
    // Released tickets become claimable again.
    board.releaseTicket(ticket.id);
    const reclaimed = board.claimTicket(ticket.id, "agent_4");
    assert.equal(reclaimed?.assigneeAgentId, "agent_4");
  });

  it("done tickets cannot be claimed", () => {
    const ticket = board.createTicket({ title: "finished work" });
    board.setTicketStatus(ticket.id, "done");
    assert.equal(board.claimTicket(ticket.id, "agent_9"), undefined);
  });

  it("status transitions: valid statuses move, invalid ones are rejected", () => {
    const ticket = board.createTicket({ title: "transition probe" });
    for (const status of ["doing", "review", "done", "todo"] as const) {
      const updated = board.setTicketStatus(ticket.id, status);
      assert.equal(updated!.status, status);
    }
    assert.throws(() => board.setTicketStatus(ticket.id, "archived" as never), /invalid ticket status/);
    assert.throws(() => board.createTicket({ title: "x", priority: "whatever" as never }), /invalid priority/);
    // Setting the same status again is a no-op that keeps the ticket intact.
    const again = board.setTicketStatus(ticket.id, "todo");
    assert.equal(again!.status, "todo");
  });

  it("comments append in order and stamp the ticket", () => {
    const ticket = board.createTicket({ title: "commented ticket" });
    const c1 = board.addTicketComment(ticket.id, "user", "first note");
    const c2 = board.addTicketComment(ticket.id, "agent_a", "progress at 50%");
    assert.ok(c1 && c2);
    const comments = board.listTicketComments(ticket.id);
    assert.deepStrictEqual(comments.map((c) => c.text), ["first note", "progress at 50%"]);
    assert.ok(comments[1]!.createdAt >= comments[0]!.createdAt);
    assert.ok(board.getTicket(ticket.id)!.updatedAt >= comments[1]!.createdAt);
    assert.throws(() => board.addTicketComment(ticket.id, "user", "   "), /comment text is required/);
  });

  it("board tools are registered and exposed to agent runs", async () => {
    const toolsMod = await import("../../tools/boardTools.js");
    const registryMod = await import("../../tools/registry.js");
    const registry = new registryMod.ToolRegistry();
    registry.registerAll(toolsMod.createBoardTools());
    const names = ["ticket_create", "ticket_list", "ticket_claim", "ticket_update"];
    for (const name of names) {
      assert.ok(ALWAYS_ON_TOOLS.includes(name), `${name} must be in ALWAYS_ON_TOOLS`);
      assert.ok(registry.names().includes(name), `${name} registered in the tool registry`);
    }
    const runAllow = mergeAlwaysOnTools({
      resolvedAllow: [],
      registeredTools: registry.names(),
    });
    const allowSet = new Set(runAllow);
    for (const name of names) assert.ok(allowSet.has(name), `${name} must reach the run allowlist`);
  });

  it("ticket tools create, claim and update through the tool shape", async () => {
    const toolsMod = await import("../../tools/boardTools.js");
    const boardTools = toolsMod.createBoardTools();
    const createTool = boardTools[0]!;
    const listTool = boardTools[1]!;
    const claimTool = boardTools[2]!;
    const updateTool = boardTools[3]!;
    assert.deepStrictEqual(
      [createTool.name, listTool.name, claimTool.name, updateTool.name],
      ["ticket_create", "ticket_list", "ticket_claim", "ticket_update"],
    );

    const ctx = { cfg: {}, workspace: ".", emit: () => {} } as unknown as {
      cfg: never;
      workspace: string;
      emit: () => void;
      taskId?: string;
    };

    const createResult = await createTool.run({ title: "tool created", body: "via tools" }, ctx as never);
    assert.ok(createResult.ok);
    const toolTicket = board.listTickets().find((t) => t.title === "tool created")!;
    assert.ok(toolTicket);
    assert.ok((await listTool.run({}, ctx as never)).ok);

    const claimResult = await claimTool.run({ id: toolTicket.id }, ctx as never);
    assert.ok(claimResult.ok);
    assert.equal(board.getTicket(toolTicket.id)!.assigneeAgentId, "user");

    const updateResult = await updateTool.run({ id: toolTicket.id, status: "doing", comment: "started" }, ctx as never);
    assert.ok(updateResult.ok);
    const after = board.getTicket(toolTicket.id)!;
    assert.equal(after.status, "doing");
    assert.ok(board.listTicketComments(toolTicket.id).some((c) => c.text === "started"));
  });
});
