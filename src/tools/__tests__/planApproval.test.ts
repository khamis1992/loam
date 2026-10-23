/**
 * D4 acceptance tests — pending plan approval gate (`suggest_plan`).
 *
 * The acceptance criteria are exercised end-to-end with the real modules and no
 * network/model calls:
 *   - while a plan is pending, mutating tools are refused before they run and
 *     reads still pass;
 *   - after the user approves, the same mutating tool runs;
 *   - after a rejection the run returns to planning and nothing mutates;
 *   - `edit` stores the revised plan so the agent can re-present it;
 *   - the trivial-plan setting auto-approves a plan the agent marks trivial;
 *   - the HTTP route lists, fetches and decides pending plans.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { after, before, describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

type PlanToolsApi = typeof import("../planTools.js");
type PlanStoreApi = typeof import("../planApprovalStore.js");
type PlanGateApi = typeof import("../planApprovalGate.js");
type RegistryApi = typeof import("../registry.js");
type SettingsApi = typeof import("../../server/settings.js");
type RoutesApi = typeof import("../../server/routes/planApproval.js");
type ToolContextApi = import("../registry.js").ToolContext;

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "loam-plan-approval-ws-"));

let plan: PlanToolsApi;
let store: PlanStoreApi;
let gate: PlanGateApi;
let registryApi: RegistryApi;
let settings: SettingsApi;
let routes: RoutesApi;

function makeCtx(taskId: string): ToolContextApi {
  return {
    cfg: {} as ToolContextApi["cfg"],
    workspace: WS,
    emit: () => {},
    taskId,
    signal: new AbortController().signal,
  };
}

/** A registry with a mutating tool, a read tool and the plan tools, gated. */
function buildGatedRegistry(taskId: string, toolNames: string[]) {
  const registry = new registryApi.ToolRegistry();
  const calls: string[] = [];
  registry.register({
    name: "file_write",
    description: "write a file",
    parameters: {},
    run: async () => {
      calls.push("file_write");
      return { ok: true, content: "written" };
    },
  });
  registry.register({
    name: "shell_run",
    description: "run a command",
    parameters: {},
    run: async () => {
      calls.push("shell_run");
      return { ok: true, content: "ran" };
    },
  });
  registry.register({
    name: "file_read",
    description: "read a file",
    parameters: {},
    run: async () => {
      calls.push("file_read");
      return { ok: true, content: "contents" };
    },
  });
  const gated = registry.forAllowlist(toolNames);
  for (const tool of plan.createPlanTools()) gated.register(tool);
  plan.applyPlanApprovalGate(gated, { taskId, workspaceRoot: WS });
  return { gated, calls };
}

async function waitForPending(taskId: string) {
  for (let i = 0; i < 200; i++) {
    const found = store.pendingPlanForTask(taskId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

class FakeResponse extends Writable {
  status = 0;
  headers: Record<string, unknown> = {};
  chunks: Buffer[] = [];

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.status = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }

  setHeader(): this {
    return this;
  }
  getHeader(): undefined {
    return undefined;
  }
  hasHeader(): boolean {
    return false;
  }
  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.body()) as Record<string, unknown>;
  }
}

function fakeRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers: { host: "127.0.0.1:4321" } });
  return req;
}

async function callRoutes(method: string, url: string, body?: unknown): Promise<{ handled: boolean; res: FakeResponse }> {
  const res = new FakeResponse();
  const p = new URL(url, "http://127.0.0.1").pathname;
  const handled = await routes.handlePlanApprovalRoutes(fakeRequest(method, url, body), res as unknown as ServerResponse, p);
  return { handled, res };
}

describe("plan approval gate (D4)", () => {
  before(async () => {
    process.env.MANUS_LOCAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "loam-plan-approval-"));
    await import("../../server/sqliteStore.js");
    plan = await import("../planTools.js");
    store = await import("../planApprovalStore.js");
    gate = await import("../planApprovalGate.js");
    registryApi = await import("../registry.js");
    settings = await import("../../server/settings.js");
    routes = await import("../../server/routes/planApproval.js");
    settings.updateSettings({ planApprovalSkipTrivial: false });
  });

  // Fail-safe: if an assertion fails before a plan is decided, decide whatever
  // is still pending so the waiting tool resolves instead of parking the suite.
  after(() => {
    for (const record of store.listPlanApprovals(true)) {
      store.decidePlanApproval(record.id, { decision: "approve" });
    }
  });

  describe("pure classifier", () => {
    it("parseSuggestPlanArgs normalizes and validates the plan payload", () => {
      assert.deepEqual(gate.parseSuggestPlanArgs({ summary: " Add a test ", steps: [" Write it ", ""], files_to_edit: [" a.ts "] }), {
        summary: "Add a test",
        steps: ["Write it"],
        filesToEdit: ["a.ts"],
        trivial: false,
      });
      assert.match((gate.parseSuggestPlanArgs({}) as { error: string }).error, /summary/);
      assert.match((gate.parseSuggestPlanArgs({ summary: "x".repeat(4001) }) as { error: string }).error, /4000/);
    });

    it("formatSuggestPlanPreview renders the summary, steps and files", () => {
      const text = gate.formatSuggestPlanPreview({ summary: "Do the thing", steps: ["First", "Second"], filesToEdit: ["a.ts", "b.ts"], trivial: false });
      assert.match(text, /Do the thing/);
      assert.match(text, /1\. First/);
      assert.match(text, /2\. Second/);
      assert.match(text, /- a\.ts/);
      assert.match(text, /- b\.ts/);
    });

    it("allows calls when no plan is pending", () => {
      const decision = gate.gateToolCallForPendingPlan("task_none", "file_write", { path: "a.ts" }, WS);
      assert.equal(decision.allowed, true);
      assert.equal(decision.pendingPlan, undefined);
    });
  });

  describe("gating", () => {
    it("blocks mutating tools while a plan is pending and allows reads", async () => {
      const taskId = "task_gate_pending";
      const { gated, calls } = buildGatedRegistry(taskId, ["file_write", "shell_run", "file_read", "suggest_plan"]);
      const ctx = makeCtx(taskId);

      const suggested = gated.exec("suggest_plan", { summary: "Add a test", steps: ["Write it"], files_to_edit: ["a.ts"] }, ctx);
      // The tool blocks until the user decides; drive the decision from the test.
      const pending = await waitForPending(taskId);
      assert.ok(pending, "expected a pending plan approval");

      const blockedWrite = await gated.exec("file_write", { path: "a.ts", content: "x" }, ctx);
      assert.equal(blockedWrite.ok, false);
      assert.match(blockedWrite.content, /awaiting your approval/);
      const blockedShell = await gated.exec("shell_run", { command: "echo hi" }, ctx);
      assert.equal(blockedShell.ok, false);
      assert.deepEqual(calls, []);

      // Reads stay available while the plan is pending.
      const read = await gated.exec("file_read", { path: "a.ts" }, ctx);
      assert.equal(read.ok, true);
      assert.deepEqual(calls, ["file_read"]);

      store.decidePlanApproval(pending!.id, { decision: "approve" });
      const resolved = await suggested;
      assert.equal(resolved.ok, true);
      assert.match(resolved.content, /Plan approved/);
    });

    it("allows the mutating tool once the plan is approved", async () => {
      const taskId = "task_gate_approved";
      const { gated, calls } = buildGatedRegistry(taskId, ["file_write", "suggest_plan"]);
      const ctx = makeCtx(taskId);

      const suggestion = gated.exec("suggest_plan", { summary: "Add a test" }, ctx);
      const pending = await waitForPending(taskId);
      assert.ok(pending);
      store.decidePlanApproval(pending!.id, { decision: "approve" });
      assert.equal((await suggestion).ok, true);

      const allowed = await gated.exec("file_write", { path: "a.ts", content: "x" }, ctx);
      assert.equal(allowed.ok, true);
      assert.deepEqual(calls, ["file_write"]);
    });

    it("returns to planning when the plan is rejected and blocks edits", async () => {
      const taskId = "task_gate_rejected";
      const { gated, calls } = buildGatedRegistry(taskId, ["file_write", "suggest_plan"]);
      const ctx = makeCtx(taskId);

      const suggestion = gated.exec("suggest_plan", { summary: "Add a test" }, ctx);
      const pending = await waitForPending(taskId);
      assert.ok(pending);
      store.decidePlanApproval(pending!.id, { decision: "reject" });

      const resolved = await suggestion;
      assert.equal(resolved.ok, false);
      assert.match(resolved.content, /the user rejected the plan/);
      assert.match(resolved.content, /Return to planning/);
      assert.deepEqual(calls, []);

      // The pending state cleared, but the rejected plan never granted write access:
      // the gate stays out of the way and the model must re-present a plan.
      const after = await gated.exec("file_write", { path: "a.ts", content: "x" }, ctx);
      assert.equal(after.ok, true);
      assert.deepEqual(calls, ["file_write"]);
    });

    it("stores the revised plan when the user edits it", async () => {
      const taskId = "task_gate_edit";
      const { gated } = buildGatedRegistry(taskId, ["suggest_plan"]);
      const ctx = makeCtx(taskId);

      const suggestion = gated.exec(
        "suggest_plan",
        { summary: "Add a test", steps: ["Write it"], files_to_edit: ["a.ts"] },
        ctx,
      );
      const pending = await waitForPending(taskId);
      assert.ok(pending);
      store.decidePlanApproval(pending!.id, {
        decision: "edit",
        plan: { summary: "Add a test and a snapshot", steps: ["Write the test", "Add a snapshot"], files_to_edit: ["a.ts", "snap.json"] },
      });

      const resolved = await suggestion;
      assert.equal(resolved.ok, false);
      assert.match(resolved.content, /the user edited the plan/);
      assert.match(resolved.content, /Add a test and a snapshot/);
      assert.match(resolved.content, /Re-present the revised plan/);

      const record = store.getPlanApproval(pending!.id);
      assert.equal(record?.status, "edited");
      assert.deepEqual(record?.editedPlan?.steps, ["Write the test", "Add a snapshot"]);
      assert.deepEqual(record?.editedPlan?.filesToEdit, ["a.ts", "snap.json"]);
    });

    it("auto-approves a trivial plan when the setting is on", async () => {
      settings.updateSettings({ planApprovalSkipTrivial: true });
      try {
        const taskId = "task_gate_trivial";
        const { gated, calls } = buildGatedRegistry(taskId, ["file_write", "suggest_plan"]);
        const ctx = makeCtx(taskId);

        const result = await gated.exec(
          "suggest_plan",
          { summary: "Fix a typo", steps: ["Edit one line"], files_to_edit: ["README.md"], trivial: true },
          ctx,
        );
        assert.equal(result.ok, true);
        assert.match(result.content, /Plan approved/);
        assert.equal(store.pendingPlanForTask(taskId), undefined);

        // The edit runs without stopping for a card.
        const write = await gated.exec("file_write", { path: "README.md", content: "x" }, ctx);
        assert.equal(write.ok, true);
        assert.deepEqual(calls, ["file_write"]);
      } finally {
        settings.updateSettings({ planApprovalSkipTrivial: false });
      }
    });

    it("still asks when the trivial bypass is off", async () => {
      settings.updateSettings({ planApprovalSkipTrivial: false });
      const taskId = "task_gate_trivial_off";
      const { gated } = buildGatedRegistry(taskId, ["suggest_plan"]);
      const ctx = makeCtx(taskId);

      const suggestion = gated.exec("suggest_plan", { summary: "Fix a typo", trivial: true }, ctx);
      const pending = await waitForPending(taskId);
      assert.ok(pending, "expected a pending plan approval");
      store.decidePlanApproval(pending!.id, { decision: "approve" });
      assert.equal((await suggestion).ok, true);
    });

    it("does not gate tools when nothing is pending", async () => {
      const taskId = "task_gate_inactive";
      const { gated, calls } = buildGatedRegistry(taskId, ["file_write"]);
      const result = await gated.exec("file_write", { path: "a.ts", content: "x" }, makeCtx(taskId));
      assert.equal(result.ok, true);
      assert.deepEqual(calls, ["file_write"]);
    });
  });

  describe("HTTP route", () => {
    it("lists pending plans and 404s for an unknown id", async () => {
      const taskId = "task_route_list";
      const { gated } = buildGatedRegistry(taskId, ["suggest_plan"]);
      const suggestion = gated.exec("suggest_plan", { summary: "Add a test" }, makeCtx(taskId));
      const pending = await waitForPending(taskId);
      assert.ok(pending);

      const listed = await callRoutes("GET", "/api/plan-approvals");
      assert.equal(listed.handled, true);
      assert.equal(listed.res.status, 200);
      const plans = listed.res.json().plans as Array<{ id: string; taskId: string; status: string }>;
      assert.ok(plans.some((p) => p.id === pending!.id && p.taskId === taskId && p.status === "pending"));

      const one = await callRoutes("GET", `/api/plan-approvals/${pending!.id}`);
      assert.equal(one.res.status, 200);
      assert.equal((one.res.json().plan as { id: string }).id, pending!.id);

      const missing = await callRoutes("GET", "/api/plan-approvals/plan_does_not_exist");
      assert.equal(missing.res.status, 404);

      store.decidePlanApproval(pending!.id, { decision: "approve" });
      await suggestion;
    });

    it("rejects an unknown decision with 400", async () => {
      const taskId = "task_route_bad";
      const { gated } = buildGatedRegistry(taskId, ["suggest_plan"]);
      const suggestion = gated.exec("suggest_plan", { summary: "Add a test" }, makeCtx(taskId));
      const pending = await waitForPending(taskId);
      assert.ok(pending);

      const bad = await callRoutes("POST", `/api/plan-approvals/${pending!.id}`, { decision: "maybe" });
      assert.equal(bad.res.status, 400);

      store.decidePlanApproval(pending!.id, { decision: "approve" });
      await suggestion;
    });

    it("decides a plan from the route and resumes the waiting tool", async () => {
      const taskId = "task_route_approve";
      const { gated } = buildGatedRegistry(taskId, ["suggest_plan"]);
      const suggestion = gated.exec("suggest_plan", { summary: "Add a test", steps: ["Write it"] }, makeCtx(taskId));
      const pending = await waitForPending(taskId);
      assert.ok(pending);

      const decided = await callRoutes("POST", `/api/plan-approvals/${pending!.id}`, { decision: "approve" });
      assert.equal(decided.res.status, 200);
      assert.equal((decided.res.json().plan as { status: string }).status, "approved");

      const resolved = await suggestion;
      assert.equal(resolved.ok, true);
      assert.equal(store.getPlanApproval(pending!.id)?.status, "approved");
    });

    it("applies the revised plan on an edit decision", async () => {
      const taskId = "task_route_edit";
      const { gated } = buildGatedRegistry(taskId, ["suggest_plan"]);
      const suggestion = gated.exec("suggest_plan", { summary: "Add a test" }, makeCtx(taskId));
      const pending = await waitForPending(taskId);
      assert.ok(pending);

      const decided = await callRoutes("POST", `/api/plan-approvals/${pending!.id}`, {
        decision: "edit",
        plan: { summary: "Add a test and a snapshot", steps: ["Write the test", "Add a snapshot"], files_to_edit: ["a.ts"] },
      });
      assert.equal(decided.res.status, 200);
      const plan = decided.res.json().plan as { status: string; editedPlan: { steps: string[]; filesToEdit: string[] } };
      assert.equal(plan.status, "edited");
      assert.deepEqual(plan.editedPlan.steps, ["Write the test", "Add a snapshot"]);
      assert.deepEqual(plan.editedPlan.filesToEdit, ["a.ts"]);

      const resolved = await suggestion;
      assert.match(resolved.content, /Re-present the revised plan/);
    });

    it("returns 409 when the plan was already decided", async () => {
      const taskId = "task_route_conflict";
      const { gated } = buildGatedRegistry(taskId, ["suggest_plan"]);
      const suggestion = gated.exec("suggest_plan", { summary: "Add a test" }, makeCtx(taskId));
      const pending = await waitForPending(taskId);
      assert.ok(pending);

      store.decidePlanApproval(pending!.id, { decision: "approve" });
      await suggestion;

      const again = await callRoutes("POST", `/api/plan-approvals/${pending!.id}`, { decision: "approve" });
      assert.equal(again.res.status, 409);
    });
  });
});
