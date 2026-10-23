/**
 * N9 acceptance tests — Ask-User-More (`ask_user`).
 *
 * The acceptance criteria are exercised with the real modules and no network or
 * model calls:
 *   - the auto-trigger fires an ask-user node BEFORE any tool call for a vague
 *     prompt or a prompt with missing context, and the answer is attached to the
 *     prompt the run continues with;
 *   - while a request is pending, mutating tools are refused before they run and
 *     reads still pass;
 *   - an answer carrying an uploaded file is returned to the model as context;
 *   - a dismissal lets the run continue with its assumptions stated;
 *   - the HTTP route lists, fetches, answers and dismisses pending requests.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { after, before, describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

type ToolsApi = typeof import("../askUserTools.js");
type StoreApi = typeof import("../askUserStore.js");
type GateApi = typeof import("../askUserGate.js");
type RegistryApi = typeof import("../registry.js");
type RoutesApi = typeof import("../../server/routes/askUser.js");
type ToolContextApi = import("../registry.js").ToolContext;

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ask-user-ws-"));

let tools: ToolsApi;
let store: StoreApi;
let gate: GateApi;
let registryApi: RegistryApi;
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

/** A registry with a mutating tool, a read tool and the ask-user tool, gated. */
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
  for (const tool of tools.createAskUserTools()) gated.register(tool);
  tools.applyAskUserGate(gated, { taskId, workspaceRoot: WS });
  return { gated, calls };
}

async function waitForPending(taskId: string) {
  for (let i = 0; i < 200; i++) {
    const found = store.pendingAskForTask(taskId);
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
  const handled = await routes.handleAskUserRoutes(fakeRequest(method, url, body), res as unknown as ServerResponse, p);
  return { handled, res };
}

describe("ask user more (N9)", () => {
  before(async () => {
    tools = await import("../askUserTools.js");
    store = await import("../askUserStore.js");
    gate = await import("../askUserGate.js");
    registryApi = await import("../registry.js");
    routes = await import("../../server/routes/askUser.js");
  });

  // Fail-safe: decide anything still pending so no waiter parks the suite.
  after(() => {
    for (const record of store.listAskUsers(true)) store.dismissAskUser(record.id);
  });

  describe("auto-trigger classifier", () => {
    it("fires for a short, open-ended request with no concrete target", () => {
      const trigger = gate.needsAskUser("refactor and optimize the codebase");
      assert.ok(trigger, "a vague request must raise a clarification");
      assert.equal(trigger.reason, "vague");
      assert.ok(trigger.questions.length >= 1);
      assert.match(trigger.explanation, /short and open-ended/);
    });

    it("treats an unresolved pronoun as missing context", () => {
      const trigger = gate.needsAskUser("fix it");
      assert.ok(trigger, "an unresolved reference must raise a clarification");
      assert.equal(trigger.reason, "missing_context");
      assert.match(trigger.explanation, /refers to "it"/);
    });

    it("fires for a request that refers to something never identified", () => {
      const trigger = gate.needsAskUser("make the same change as before");
      assert.ok(trigger, "an unresolved reference must raise a clarification");
      assert.equal(trigger.reason, "missing_context");
      assert.ok(trigger.questions.some((q) => q.allowFile));
    });

    it("stays quiet for a concrete request", () => {
      assert.equal(gate.needsAskUser("Add a snapshot test to src/parser.test.ts"), undefined);
      assert.equal(gate.needsAskUser("Fix the crash in packages/web/src/components/chat/EventList.tsx"), undefined);
    });

    it("stays quiet when the conversation already supplies the context", () => {
      const history = [{ role: "user", content: "Please review the parser module in src/parser.ts and its snapshot fixtures." }];
      assert.equal(gate.needsAskUser("make the same change as before", history), undefined);
    });

    it("does not fire for an empty prompt", () => {
      assert.equal(gate.needsAskUser("   "), undefined);
    });
  });

  describe("gate", () => {
    it("blocks mutating tools while a request is pending and allows reads", async () => {
      const taskId = "task_ask_pending";
      const { gated, calls } = buildGatedRegistry(taskId, ["file_write", "shell_run", "file_read", "ask_user"]);
      const ctx = makeCtx(taskId);

      const asking = gated.exec("ask_user", { title: "Need a target", questions: [{ prompt: "Which file?" }] }, ctx);
      const pending = await waitForPending(taskId);
      assert.ok(pending, "expected a pending ask-user request");

      const blockedWrite = await gated.exec("file_write", { path: "a.ts", content: "x" }, ctx);
      assert.equal(blockedWrite.ok, false);
      assert.match(blockedWrite.content, /clarification request is still unanswered/);
      const blockedShell = await gated.exec("shell_run", { command: "echo hi" }, ctx);
      assert.equal(blockedShell.ok, false);
      assert.deepEqual(calls, [], "no mutating tool may run while the card waits");

      const read = await gated.exec("file_read", { path: "a.ts" }, ctx);
      assert.equal(read.ok, true);
      assert.deepEqual(calls, ["file_read"], "reads stay available while the card waits");

      store.answerAskUser(pending!.id, { text: "a.ts", answers: {}, files: [] });
      const resolved = await asking;
      assert.equal(resolved.ok, true);
      assert.match(resolved.content, /The user answered your clarification request/);
      assert.match(resolved.content, /a\.ts/);
    });

    it("allows the mutating tool once the request is answered", async () => {
      const taskId = "task_ask_answered";
      const { gated, calls } = buildGatedRegistry(taskId, ["file_write", "ask_user"]);
      const ctx = makeCtx(taskId);

      const asking = gated.exec("ask_user", { title: "Need a target", questions: [{ prompt: "Which file?" }] }, ctx);
      const pending = await waitForPending(taskId);
      assert.ok(pending);
      store.answerAskUser(pending!.id, { text: "a.ts", answers: {}, files: [] });
      assert.equal((await asking).ok, true);

      const allowed = await gated.exec("file_write", { path: "a.ts", content: "x" }, ctx);
      assert.equal(allowed.ok, true);
      assert.deepEqual(calls, ["file_write"]);
    });

    it("does not gate tools when nothing is pending", async () => {
      const taskId = "task_ask_inactive";
      const { gated, calls } = buildGatedRegistry(taskId, ["file_write"]);
      const result = await gated.exec("file_write", { path: "a.ts", content: "x" }, makeCtx(taskId));
      assert.equal(result.ok, true);
      assert.deepEqual(calls, ["file_write"]);
    });
  });

  describe("answer payload", () => {
    it("returns per-question answers and an uploaded file to the model", async () => {
      const taskId = "task_ask_files";
      const { gated } = buildGatedRegistry(taskId, ["ask_user"]);
      const ctx = makeCtx(taskId);

      const asking = gated.exec(
        "ask_user",
        {
          title: "Before I build this",
          reason: "The target is not pinned down.",
          questions: [
            { prompt: "What is the goal?", options: ["Fix a bug", "Add a feature"] },
            { prompt: "Which spec should I follow?", allowFile: true },
          ],
        },
        ctx,
      );
      const pending = await waitForPending(taskId);
      assert.ok(pending);

      const spec = path.join(WS, "uploads", pending!.id, "spec.pdf");
      fs.mkdirSync(path.dirname(spec), { recursive: true });
      fs.writeFileSync(spec, "spec bytes");
      store.answerAskUser(pending!.id, {
        text: "See the attached spec.",
        answers: { q1: "Add a feature", q2: "The attached file" },
        files: [{ path: `uploads/${pending!.id}/spec.pdf`, name: "spec.pdf", bytes: 10, contentType: "application/pdf" }],
      });

      const resolved = await asking;
      assert.equal(resolved.ok, true);
      assert.match(resolved.content, /Add a feature/);
      assert.match(resolved.content, /Which spec should I follow\? → The attached file/);
      assert.match(resolved.content, /Attached files:/);
      assert.match(resolved.content, /spec\.pdf/);
      assert.match(resolved.content, new RegExp(`uploads/${pending!.id}/spec\\.pdf`));
    });

    it("continues with stated assumptions when the user dismisses the card", async () => {
      const taskId = "task_ask_dismissed";
      const { gated } = buildGatedRegistry(taskId, ["ask_user"]);
      const asking = gated.exec("ask_user", { title: "Need a target", questions: [{ prompt: "Which file?" }] }, makeCtx(taskId));
      const pending = await waitForPending(taskId);
      assert.ok(pending);

      store.dismissAskUser(pending!.id);
      const resolved = await asking;
      assert.equal(resolved.ok, false);
      assert.match(resolved.content, /dismissed the card without answering/);
      assert.match(resolved.content, /say what you assumed/);
    });

    it("rejects an empty request payload", () => {
      assert.match((gate.parseAskUserArgs({}) as { error: string }).error, /title/);
      assert.match((gate.parseAskUserArgs({ title: "x" }) as { error: string }).error, /questions/);
      assert.match((gate.parseAskUserArgs({ title: "x", questions: [] }) as { error: string }).error, /at least one question/);
      const parsed = gate.parseAskUserArgs({ title: " x ", questions: [{ prompt: " p ", options: [" a ", ""], allowFile: true }] });
      assert.ok(!("error" in parsed));
      assert.equal(parsed.title, "x");
      assert.deepEqual(parsed.questions[0]!.options, ["a"]);
      assert.equal(parsed.questions[0]!.allowFile, true);
      assert.equal(parsed.questions[0]!.id, "q1");
    });
  });

  describe("HTTP route", () => {
    it("lists pending requests and 404s for an unknown id", async () => {
      const taskId = "task_route_list";
      const { gated } = buildGatedRegistry(taskId, ["ask_user"]);
      const asking = gated.exec("ask_user", { title: "Need a target", questions: [{ prompt: "Which file?" }] }, makeCtx(taskId));
      const pending = await waitForPending(taskId);
      assert.ok(pending);

      const listed = await callRoutes("GET", "/api/ask-user");
      assert.equal(listed.handled, true);
      assert.equal(listed.res.status, 200);
      const requests = listed.res.json().requests as Array<{ id: string; taskId: string; status: string }>;
      assert.ok(requests.some((r) => r.id === pending!.id && r.taskId === taskId && r.status === "pending"));

      const one = await callRoutes("GET", `/api/ask-user/${pending!.id}`);
      assert.equal(one.res.status, 200);
      assert.equal((one.res.json().request as { id: string }).id, pending!.id);

      const missing = await callRoutes("GET", "/api/ask-user/ask_does_not_exist");
      assert.equal(missing.res.status, 404);

      store.dismissAskUser(pending!.id);
      await asking;
    });

    it("answers a request from the route and resumes the waiting tool", async () => {
      const taskId = "task_route_answer";
      const { gated } = buildGatedRegistry(taskId, ["ask_user"]);
      const asking = gated.exec("ask_user", { title: "Need a target", questions: [{ prompt: "Which file?" }] }, makeCtx(taskId));
      const pending = await waitForPending(taskId);
      assert.ok(pending);

      const answered = await callRoutes("POST", `/api/ask-user/${pending!.id}/answer`, {
        text: "Use a.ts",
        answers: { q1: "a.ts" },
        files: [{ path: `uploads/${pending!.id}/spec.pdf`, name: "spec.pdf", bytes: 3, contentType: "application/pdf" }],
      });
      assert.equal(answered.res.status, 200);
      const request = answered.res.json().request as { status: string; answer: { text: string; files: unknown[] } };
      assert.equal(request.status, "answered");
      assert.equal(request.answer.text, "Use a.ts");
      assert.equal(request.answer.files.length, 1);

      const resolved = await asking;
      assert.equal(resolved.ok, true);
      assert.match(resolved.content, /Use a\.ts/);
    });

    it("rejects an empty answer with 400 and a decided request with 409", async () => {
      const taskId = "task_route_conflict";
      const { gated } = buildGatedRegistry(taskId, ["ask_user"]);
      const asking = gated.exec("ask_user", { title: "Need a target", questions: [{ prompt: "Which file?" }] }, makeCtx(taskId));
      const pending = await waitForPending(taskId);
      assert.ok(pending);

      const empty = await callRoutes("POST", `/api/ask-user/${pending!.id}/answer`, {});
      assert.equal(empty.res.status, 400);
      assert.match(String(empty.res.json().error), /text, at least one answer, or a file/);

      store.dismissAskUser(pending!.id);
      await asking;

      const again = await callRoutes("POST", `/api/ask-user/${pending!.id}/dismiss`, {});
      assert.equal(again.res.status, 409);
    });

    it("drops an answer file path that escapes the workspace", async () => {
      const taskId = "task_route_traversal";
      const { gated } = buildGatedRegistry(taskId, ["ask_user"]);
      const asking = gated.exec("ask_user", { title: "Need a target", questions: [{ prompt: "Which file?" }] }, makeCtx(taskId));
      const pending = await waitForPending(taskId);
      assert.ok(pending);

      const answered = await callRoutes("POST", `/api/ask-user/${pending!.id}/answer`, {
        answers: { q1: "x" },
        files: [{ path: "../../../etc/passwd", name: "passwd" }],
      });
      assert.equal(answered.res.status, 200);
      const request = answered.res.json().request as { answer: { files: unknown[] } };
      assert.deepEqual(request.answer.files, []);

      await asking;
    });

    it("falls through for verbs and paths it does not own instead of hanging", async () => {
      const taskId = "task_route_fallthrough";
      const { gated } = buildGatedRegistry(taskId, ["ask_user"]);
      const asking = gated.exec("ask_user", { title: "Need a target", questions: [{ prompt: "Which file?" }] }, makeCtx(taskId));
      const pending = await waitForPending(taskId);
      assert.ok(pending);

      // Claiming these would leave the request with no response at all, so the
      // module must decline and let the server answer with its normal 404.
      for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]) {
        const unsupported = await callRoutes(method, `/api/ask-user/${pending!.id}`);
        assert.equal(unsupported.handled, false, `${method} must not be claimed by the route`);
        assert.equal(unsupported.res.status, 0, `${method} must not write a response`);
      }
      for (const url of [
        "/api/ask-user/",
        `/api/ask-user/${pending!.id}/extra`,
        "/api/ask-user-other/ask_1",
        "/api/other/ask_user",
      ]) {
        const unowned = await callRoutes("GET", url);
        assert.equal(unowned.handled, false, `${url} must not be claimed by the route`);
        assert.equal(unowned.res.status, 0, `${url} must not write a response`);
      }

      assert.equal(store.getAskUser(pending!.id)?.status, "pending");
      store.dismissAskUser(pending!.id);
      await asking;
    });
  });

  describe("cancellation", () => {
    it("clears the pending request when the run is cancelled", async () => {
      const taskId = "task_ask_cancelled";
      const { gated } = buildGatedRegistry(taskId, ["file_write", "ask_user"]);
      const controller = new AbortController();
      const ctx = { ...makeCtx(taskId), signal: controller.signal };

      // The wait polls on an unref'd timer, so hold the loop open across the abort.
      const keepAlive = setInterval(() => {}, 25);
      try {
        const asking = gated.exec("ask_user", { title: "Will be cancelled", questions: [{ prompt: "Which file?" }] }, ctx);
        assert.ok(await waitForPending(taskId));
        controller.abort();

        const result = await asking;
        assert.equal(result.ok, false);
        assert.match(result.content, /not answered/);
        assert.equal(store.pendingAskForTask(taskId), undefined);
        assert.equal((await gated.exec("file_write", { path: "a.ts", content: "x" }, ctx)).ok, true);
      } finally {
        clearInterval(keepAlive);
      }
    });
  });
});
