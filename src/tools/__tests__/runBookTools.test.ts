/**
 * Threat-model, coverage and budget policy tools.
 *
 * The tools are thin wrappers: they resolve the task from the context, keep the
 * model shared per task, and emit the event the canvas/UI listens for.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { AgentEvent } from "../../agent/events.js";
import type { ToolContext } from "../registry.js";
import { createThreatModelTools } from "../threatModelTools.js";
import { createCoverageTools } from "../coverageTools.js";
import { createBudgetTools } from "../budgetTools.js";
import { isBudgetPaused } from "../../agent/budgetPause.js";
import { sessionRuntime } from "../../server/sessionRuntime.js";

const threat = createThreatModelTools();
const coverage = createCoverageTools();
const budget = createBudgetTools();
const tool = (list: typeof threat, name: string) => {
  const found = list.find((t) => t.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
};

let events: AgentEvent[] = [];
let ctx: ToolContext;
let closeDb: () => void;

describe("run book tools", () => {
  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-runbook-tools-"));
    process.env.MANUS_LOCAL_DATA_DIR = dir;
    const sqlite = await import("../../server/sqliteStore.js");
    closeDb = sqlite.closeDb;
    ctx = {
      cfg: {},
      workspace: dir,
      taskId: "task-tools",
      emit: (event: AgentEvent) => { events.push(event); },
    } as unknown as ToolContext;
  });

  after(() => { closeDb(); });

  it("saves and amends the shared threat model", async () => {
    events = [];
    const saved = await tool(threat, "threat_model_save").run({
      summary: "orders API",
      actors: [{ name: "customer", capability: "authenticated" }],
      assets: [{ name: "order records", where: "/api/orders", criticality: "high" }],
    }, ctx);
    assert.equal(saved.ok, true);
    assert.match(saved.content, /order records \(high\)/);
    assert.equal(events[0]!.type, "assistant_message");

    const amended = await tool(threat, "threat_model_amend").run({ notes: ["price comes from the client"] }, ctx);
    assert.equal(amended.ok, true);
    assert.match(amended.content, /price comes from the client/);

    const read = await tool(threat, "threat_model_get").run({}, ctx);
    assert.match(read.content, /customer/);
  });

  it("records and reports coverage, refreshing duplicates", async () => {
    const first = await tool(coverage, "coverage_record").run({ target: "/api/orders", check: "idor" }, ctx);
    assert.equal(first.ok, true);
    const id = /cov_[a-f0-9]+/.exec(first.content)?.[0];
    assert.ok(id);

    await tool(coverage, "coverage_record").run({ target: "/api/health", check: "auth bypass" }, ctx);
    await tool(coverage, "coverage_update").run({ id, status: "partial", notes: ["needs a second tenant"] }, ctx);

    const report = await tool(coverage, "coverage_report").run({}, ctx);
    assert.match(report.content, /Open proof gaps/);
    assert.match(report.content, /needs a second tenant/);
    assert.match(report.content, /\/api\/health — auth bypass/);

    const list = await tool(coverage, "coverage_list").run({ status: "partial" }, ctx);
    assert.match(list.content, /\/api\/orders/);
  });

  it("rejects a coverage entry without a target or check", async () => {
    const bad = await tool(coverage, "coverage_record").run({ target: "/x" }, ctx);
    assert.equal(bad.ok, false);
    assert.match(bad.content, /check is required/);
  });

  it("pauses, reports and resumes the task budget", async () => {
    events = [];
    const paused = await tool(budget, "budget_pause").run({ reason: "before the expensive phase" }, ctx);
    assert.equal(paused.ok, true);
    assert.equal(isBudgetPaused("task-tools"), true);
    assert.equal(events[0]!.type, "budget_paused");

    const status = await tool(budget, "budget_status").run({}, ctx);
    assert.equal(status.ok, true);
    assert.match(status.content, /"paused": true/);

    const resumed = await tool(budget, "budget_resume").run({ steps: 5, minutes: 1 }, ctx);
    assert.equal(resumed.ok, true);
    assert.equal(isBudgetPaused("task-tools"), false);
    assert.equal(sessionRuntime.getBudget("task-tools").stepLimit !== undefined, true);
    assert.equal(events.at(-1)!.type, "budget_resumed");
  });

  it("will not resume a task that was never paused", async () => {
    const result = await tool(budget, "budget_resume").run({ task_id: "never-paused" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.content, /not paused/);
  });
});
