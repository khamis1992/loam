/**
 * playbook_create_from_session (D9) — the model call is injected, so these
 * tests never touch a real model or network.
 *
 * Covers: transcript building, JSON parsing (fenced/prose/tolerant), the
 * session lookup rules, macro derivation, and the failure paths.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

import type { Config } from "../../config.js";
import type { Emit } from "../../agent/events.js";
import type { OllamaClient } from "../../ollama.js";
import type { ToolContext } from "../registry.js";

let tmpDir = "";
let closeDb: () => void;
let tools: typeof import("../playbookTools.js");
let db: typeof import("../../server/db.js");
let pb: typeof import("../../server/playbooks.js");

function ctx(workspace: string, taskId?: string): ToolContext {
  return { cfg: {} as Config, workspace, emit: (() => undefined) as Emit, ...(taskId ? { taskId } : {}) };
}

const ollama = {} as OllamaClient;

const DRAFT_JSON = JSON.stringify({
  overview: "Drafted overview.",
  procedure: "1. Do the thing.",
  specifications: "npm run build:server",
  advice: "Watch the flaky test.",
  forbiddenActions: "Do not skip the build.",
  neededFromUser: "A version number.",
});

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-playbook-tools-"));
  process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  closeDb = (await import("../../server/sqliteStore.js")).closeDb;
  db = await import("../../server/db.js");
  pb = await import("../../server/playbooks.js");
  tools = await import("../playbookTools.js");
});

after(() => {
  closeDb();
  delete process.env.MANUS_LOCAL_DATA_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("buildSessionTranscript", () => {
  it("includes the prompt, conversation and the most recent steps", () => {
    const task = db.createTask("Release the build prompt", "Release", null, null);
    db.appendMessage(task.id, "user", "please release");
    db.appendMessage(task.id, "assistant", "done");
    for (let i = 0; i < 80; i += 1) db.appendStep(task.id, { at: new Date().toISOString(), type: "tool_call", data: { i } });

    // createTask/append* each write a fresh row, so re-read before snapshotting.
    const transcript = tools.buildSessionTranscript(db.getTask(task.id)!);
    assert.ok(transcript.includes("## Prompt"));
    // The transcript leads with the task's own prompt, not the message history.
    assert.ok(transcript.includes("Release the build prompt"));
    assert.ok(transcript.includes("## Conversation"));
    assert.ok(transcript.includes("### assistant"));
    assert.ok(transcript.includes("## Steps"));
    assert.ok(transcript.includes("- [tool_call]"));
    // Only the last MAX_STEPS steps are kept.
    assert.ok(!transcript.includes('"i":0'), "old steps are trimmed");
    assert.ok(transcript.includes('"i":79'), "recent steps are kept");
  });

  it("omits the conversation and steps sections when the session is empty", () => {
    const task = db.createTask("Just a prompt", "Empty", null, null);
    const transcript = tools.buildSessionTranscript(task);
    assert.ok(transcript.includes("## Prompt"));
    assert.ok(!transcript.includes("## Conversation"));
    assert.ok(!transcript.includes("## Steps"));
  });
});

describe("parseDraft", () => {
  it("parses a bare JSON object and fills missing sections with empty strings", () => {
    const parsed = tools.parseDraft('{"overview":"o","procedure":"p"}');
    assert.equal(parsed.overview, "o");
    assert.equal(parsed.procedure, "p");
    assert.equal(parsed.specifications, "");
    assert.equal(parsed.forbiddenActions, "");
  });

  it("tolerates ```json fences and surrounding prose", () => {
    const parsed = tools.parseDraft(`Sure! Here you go:\n\`\`\`json\n${DRAFT_JSON}\n\`\`\`\nHope that helps.`);
    assert.equal(parsed.overview, "Drafted overview.");
    assert.equal(parsed.neededFromUser, "A version number.");
  });

  it("coerces non-string values and rejects a non-object reply", () => {
    const parsed = tools.parseDraft('{"overview": 42, "procedure": null}');
    assert.equal(parsed.overview, "42");
    assert.equal(parsed.procedure, "");
    assert.throws(() => tools.parseDraft("no json here"), /JSON object/);
    assert.throws(() => tools.parseDraft('["array"]'), /JSON object/);
    assert.throws(() => tools.parseDraft("{not json}"), /JSON/);
  });
});

describe("playbook_create_from_session tool", () => {
  function draftTool(reply: string | Error) {
    const draft = async (): Promise<string> => {
      if (reply instanceof Error) throw reply;
      return reply;
    };
    return tools.createPlaybookTools({ ollama, draft }).find((t) => t.name === "playbook_create_from_session")!;
  }

  it("rejects a missing name without calling the model", async () => {
    let called = false;
    const tool = tools.createPlaybookTools({
      ollama,
      draft: async () => { called = true; return DRAFT_JSON; },
    }).find((t) => t.name === "playbook_create_from_session")!;
    const res = await tool.run({ name: "   " }, ctx(tmpDir));
    assert.equal(res.ok, false);
    assert.match(res.content, /requires a name/);
    assert.equal(called, false);
  });

  it("drafted a playbook from a finished session and saves it", async () => {
    const task = db.createTask("Ship it", "Ship it", null, null);
    db.appendMessage(task.id, "user", "ship the release");
    db.appendMessage(task.id, "assistant", "released");
    db.appendStep(task.id, { at: new Date().toISOString(), type: "tool_call" });

    let seenPrompt = "";
    const tool = tools.createPlaybookTools({
      ollama,
      draft: async (prompt) => { seenPrompt = prompt; return DRAFT_JSON; },
    }).find((t) => t.name === "playbook_create_from_session")!;

    const res = await tool.run({ name: "Release Checklist", taskId: task.id }, ctx(tmpDir, task.id));
    assert.ok(res.ok, res.content);
    assert.ok(seenPrompt.includes("## Session transcript"), "the model sees the transcript");
    assert.ok(seenPrompt.includes("ship the release"));

    const payload = JSON.parse(res.content) as {
      created: boolean; playbook: { id: string; macro: string; currentVersion: number }; fromSession: string; usage: string;
    };
    assert.equal(payload.created, true);
    assert.equal(payload.fromSession, task.id);
    assert.equal(payload.playbook.macro, "release_checklist", "macro derived from the name");
    assert.equal(payload.playbook.currentVersion, 1);
    assert.ok(payload.usage.includes("!release_checklist"));

    // The playbook is really persisted and attachable.
    const saved = pb.getPlaybookByMacro("release_checklist");
    assert.ok(saved, "the drafted playbook must be stored");
    assert.equal(saved!.overview, "Drafted overview.");
    // The origin session is recorded on the immutable version row.
    assert.equal(pb.listVersions(saved!.id)[0]!.createdBy, `session:${task.id}`);
  });

  it("honours an explicit macro and reports a collision instead of overwriting", async () => {
    pb.createPlaybook({ name: "Taken", macro: "taken_macro" });
    const task = db.createTask("x", "x", null, null);
    db.appendMessage(task.id, "user", "hi");

    const tool = draftTool(DRAFT_JSON);
    const clash = await tool.run({ name: "Other", macro: "taken_macro", taskId: task.id }, ctx(tmpDir));
    assert.equal(clash.ok, false);
    assert.match(clash.content, /already exists/);

    const ok = await tool.run({ name: "Other", macro: "free_macro", taskId: task.id }, ctx(tmpDir));
    assert.ok(ok.ok, ok.content);
    assert.ok(pb.getPlaybookByMacro("free_macro"));
  });

  it("falls back to the latest finished task when no taskId is given", async () => {
    const task = db.createTask("fallback session", "fallback", null, null);
    db.appendMessage(task.id, "user", "fallback prompt");
    db.setTaskStatus(task.id, "done");

    const tool = draftTool(DRAFT_JSON);
    const res = await tool.run({ name: "Fallback" }, ctx(tmpDir));
    assert.ok(res.ok, res.content);
    assert.equal((JSON.parse(res.content) as { fromSession: string }).fromSession, task.id);
  });

  it("fails honestly when there is no session to learn from", async () => {
    const tool = draftTool(DRAFT_JSON);
    const res = await tool.run({ name: "Nope", taskId: "task_missing" }, ctx(tmpDir));
    assert.equal(res.ok, false);
    assert.match(res.content, /no session found/);
  });

  it("refuses an empty transcript instead of calling the model", async () => {
    const task = db.createTask("empty transcript", "empty", null, null);
    let called = false;
    const tool = tools.createPlaybookTools({
      ollama,
      draft: async () => { called = true; return DRAFT_JSON; },
    }).find((t) => t.name === "playbook_create_from_session")!;
    const res = await tool.run({ name: "Empty", taskId: task.id }, ctx(tmpDir));
    assert.equal(res.ok, false);
    assert.match(res.content, /no transcript/);
    assert.equal(called, false);
  });

  it("surfaces a model failure without saving anything", async () => {
    const task = db.createTask("failing session", "failing", null, null);
    db.appendMessage(task.id, "user", "hi");
    const tool = draftTool(new Error("model offline"));
    const res = await tool.run({ name: "Broken", taskId: task.id }, ctx(tmpDir));
    assert.equal(res.ok, false);
    assert.match(res.content, /model offline/);
    assert.equal(pb.getPlaybookByMacro("broken"), undefined);
  });

  it("reports an unparseable draft and an all-empty draft", async () => {
    const task = db.createTask("bad draft session", "bad", null, null);
    db.appendMessage(task.id, "user", "hi");

    const unparseable = await draftTool("I cannot help with that.").run({ name: "Bad", taskId: task.id }, ctx(tmpDir));
    assert.equal(unparseable.ok, false);
    assert.match(unparseable.content, /could not parse/);

    const empty = await draftTool(JSON.stringify({ overview: "", procedure: "", specifications: "", advice: "", forbiddenActions: "", neededFromUser: "" }))
      .run({ name: "Empty Draft", taskId: task.id }, ctx(tmpDir));
    assert.equal(empty.ok, false);
    assert.match(empty.content, /empty playbook/);
  });

  it("is registered as an always-on tool name", async () => {
    const { ALWAYS_ON_TOOLS } = await import("../../server/runTools.js");
    assert.ok(ALWAYS_ON_TOOLS.includes("playbook_create_from_session"));
  });
});
