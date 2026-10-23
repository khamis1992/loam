/**
 * O5 unit tests: checkpoint + tool-call lifecycle events in the durable log
 * (BUILD_SPEC §6.5).
 *
 * The point of this layer is that a crash is *observable*. The checkpoint in the
 * `entities` table only says "a run was in flight"; the log says which tool call
 * started and never reached a terminal state. These tests pin that contract:
 *
 *   1. A checkpoint round-trips through the log and is read back equal.
 *   2. A tool call with a `started` row and no terminal row is in flight, and
 *      `requiresReplayConfirmation` then refuses a silent resume.
 *   3. The real agent loop (both the batched read-only path and the per-call
 *      path) brackets every call, so no call can be invisible to recovery.
 *
 * `LOAM_DATA_DIR` is pointed at a throwaway temp dir before the modules load, so
 * the app's real `data/` folder is never touched. The model is replaced by a
 * deterministic fake; no network or real model is contacted.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-checkpointlog-"));
process.env.LOAM_DATA_DIR = tmpDir;
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;

import { after as afterSeq } from "../../protocol/eventLog.js";
import { closeDb, resetDb } from "../../server/sqliteStore.js";
import {
  TERMINAL_TOOL_STATES,
  hasUnfinishedToolCall,
  inFlightToolCalls,
  isTerminalToolState,
  readLatestCheckpoint,
  recordToolCall,
  recordToolResult,
  writeCheckpoint,
} from "../checkpointLog.js";
import { requiresReplayConfirmation, type SavedRun } from "../../server/recovery.js";
import { runAgent } from "../loop.js";
import { loadConfig } from "../../config.js";
import { ToolRegistry, type Tool } from "../../tools/registry.js";
import type { ExecutionCheckpoint } from "../checkpoint.js";
import type { ChatResult, OllamaClient, OllamaToolCall } from "../../ollama.js";

/**
 * A model tool call as the log sees it. `OllamaToolCall` has no `id` today (the
 * providers drop it), but the loop prefers a model-supplied id when one exists,
 * so the tests exercise both spellings.
 */
type ModelToolCall = OllamaToolCall & { id?: string };

/** Restart stand-in: drop the shared SQLite connection so the next call reopens the file. */
function restart(): void {
  closeDb();
  resetDb();
}

function checkpoint(overrides: Partial<ExecutionCheckpoint> = {}): ExecutionCheckpoint {
  return {
    version: 1,
    plan: { goal: "do the thing", trivial: true, steps: [], source: "fallback" },
    nextStep: 1,
    completed: [],
    lastText: "",
    trace: [],
    round: 1,
    usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
    totalSteps: 1,
    model: "test-model",
    inFlight: false,
    complete: false,
    finalRepairUsed: false,
    ...overrides,
  };
}

function savedRun(overrides: Partial<SavedRun> = {}): SavedRun {
  return {
    prompt: "resume me",
    effectivePrompt: "resume me",
    history: [],
    workspace: tmpDir,
    orchestrated: true,
    started: true,
    ...overrides,
  };
}

function toolEventsOf(sessionId: string): Array<{ toolCallId: string; name: string; state: string; brief?: string }> {
  return afterSeq(sessionId, 0, 5000)
    .filter((e) => e.kind === "tool_result")
    .map((e) => e.payload as { toolCallId: string; name: string; state: string; brief?: string });
}

describe("checkpointLog", () => {
  it("writes a checkpoint and reads the same state back", () => {
    const cp = checkpoint({ nextStep: 3, lastText: "halfway", round: 2 });
    const seq = writeCheckpoint("s_cp_roundtrip", cp, "turn_1");
    assert.ok(seq > 0, "a written checkpoint must report its sequence");

    const read = readLatestCheckpoint("s_cp_roundtrip");
    assert.ok(read, "the checkpoint must be readable back");
    assert.equal(read.seq, seq);
    // `logSeq` is assigned after the write, so the stored payload carries the
    // state as it was, not the stamp it received.
    assert.deepEqual(read.cp, cp);
  });

  it("does not duplicate a checkpoint that is re-saved unchanged", () => {
    const cp = checkpoint({ round: 4, nextStep: 1 });
    const first = writeCheckpoint("s_cp_idem", cp);
    const second = writeCheckpoint("s_cp_idem", cp);
    assert.equal(second, first);
    assert.equal(afterSeq("s_cp_idem").filter((e) => e.kind === "checkpoint").length, 1);
  });

  it("keeps a different inFlight state as a distinct checkpoint", () => {
    // Same counters, different safety flag: recovery must see the newest state,
    // so the two must not collapse onto one idempotency key.
    const idle = writeCheckpoint("s_cp_flag", checkpoint({ nextStep: 2, inFlight: false }));
    const busy = writeCheckpoint("s_cp_flag", checkpoint({ nextStep: 2, inFlight: true }));
    assert.notEqual(busy, idle);
    assert.equal(readLatestCheckpoint("s_cp_flag")!.cp.inFlight, true);
  });

  it("survives a restart", () => {
    writeCheckpoint("s_cp_restart", checkpoint({ lastText: "kept" }));
    recordToolCall("s_cp_restart", "tc_kept", "file_write");
    restart();
    assert.equal(readLatestCheckpoint("s_cp_restart")!.cp.lastText, "kept");
    assert.deepEqual(inFlightToolCalls("s_cp_restart").map((c) => c.toolCallId), ["tc_kept"]);
  });

  it("treats a finished tool call as complete and an unfinished one as in flight", () => {
    recordToolCall("s_tools_ok", "tc_done", "file_write");
    recordToolResult("s_tools_ok", "tc_done", "file_write", "succeeded", "wrote 3 bytes");
    assert.deepEqual(inFlightToolCalls("s_tools_ok"), []);
    assert.equal(hasUnfinishedToolCall("s_tools_ok"), false);

    recordToolCall("s_tools_open", "tc_open", "run_command");
    assert.equal(hasUnfinishedToolCall("s_tools_open"), true);
    const open = inFlightToolCalls("s_tools_open");
    assert.equal(open.length, 1);
    assert.equal(open[0]!.toolCallId, "tc_open");
    assert.equal(open[0]!.name, "run_command");
    assert.equal(open[0]!.state, "started");
    assert.ok(open[0]!.seq > 0, "the in-flight record must point at the row that reported it");
  });

  it("recognises every terminal state and never mistakes a terminal one for in flight", () => {
    for (const state of TERMINAL_TOOL_STATES) assert.equal(isTerminalToolState(state), true);
    assert.equal(isTerminalToolState("started"), false);
    for (const state of ["succeeded", "failed", "canceled"] as const) {
      const session = `s_terminal_${state}`;
      recordToolCall(session, "tc_1", "file_write");
      recordToolResult(session, "tc_1", "file_write", state, "outcome");
      assert.equal(hasUnfinishedToolCall(session), false, `${state} must end the call`);
    }
  });

  it("never stores raw arguments, and redacts a secret tool's brief", () => {
    recordToolCall("s_redact", "tc_secret", "secrets_read");
    recordToolResult("s_redact", "tc_secret", "secrets_read", "succeeded", "api_key=abcd1234efgh", undefined, tmpDir);
    recordToolResult("s_redact", "tc_cmd", "run_command", "succeeded", "api_key=abcd1234efgh", undefined, tmpDir);
    const events = toolEventsOf("s_redact");
    // `find` alone would return the `started` row, which carries no brief.
    const secret = events.find((e) => e.toolCallId === "tc_secret" && e.state === "succeeded")!;
    const command = events.find((e) => e.toolCallId === "tc_cmd" && e.state === "succeeded")!;
    assert.equal(secret.brief, "[redacted]");
    assert.ok(!command.brief!.includes("abcd1234efgh"), "a non-secret brief still goes through the redactor");
    assert.ok(command.brief!.includes("***"));
  });

  it("answers false for a session that never logged anything", () => {
    assert.equal(hasUnfinishedToolCall("s_never_seen"), false);
    assert.deepEqual(inFlightToolCalls("s_never_seen"), []);
    assert.equal(hasUnfinishedToolCall(undefined), false);
    assert.equal(readLatestCheckpoint("s_never_seen"), undefined);
  });

  it("makes requiresReplayConfirmation refuse a resume after a started-without-end tool call", () => {
    const session = "s_replay_gate";
    writeCheckpoint(session, checkpoint({ inFlight: false }));
    const run = savedRun({ checkpoint: { ...checkpoint({ inFlight: false }), logSessionId: session } });

    // No tool call recorded yet: the checkpoint is not in flight, so a resume is safe.
    assert.equal(requiresReplayConfirmation(run), false);

    // A tool that started and never finished may already have had its effect.
    recordToolCall(session, "tc_side_effect", "run_command");
    assert.equal(requiresReplayConfirmation(run), true);

    // Once the call reaches a terminal state the run is resumable again.
    recordToolResult(session, "tc_side_effect", "run_command", "failed", "crashed");
    assert.equal(requiresReplayConfirmation(run), false);
  });

  it("keeps the pre-O5 rules for a run with no checkpoint", () => {
    assert.equal(requiresReplayConfirmation(savedRun({ started: false })), false);
    assert.equal(requiresReplayConfirmation(savedRun({ started: true })), true);
    // An in-flight checkpoint is still unsafe even with no log session attached.
    assert.equal(requiresReplayConfirmation(savedRun({ checkpoint: checkpoint({ inFlight: true }) })), true);
    // A log session that recorded nothing cannot make a resume unsafe.
    assert.equal(requiresReplayConfirmation(savedRun({ checkpoint: { ...checkpoint(), logSessionId: "s_empty_log" } })), false);
  });
});

/** A read-only tool that returns `content`, for the loop-level tests. */
function readTool(name: string, content: string): Tool {
  return {
    name,
    description: "read-only test tool",
    parameters: { type: "object", properties: {} },
    async run() {
      return { ok: true, content };
    },
  };
}

/** Fake model: the first call returns `calls`, every later call returns a final answer. */
function fakeOllama(calls: ModelToolCall[]): OllamaClient {
  let count = 0;
  return {
    async chat(): Promise<ChatResult> {
      count++;
      if (count === 1) {
        return { content: "", toolCalls: calls, model: "test-model", usage: { promptTokens: 1, completionTokens: 1, durationMs: 0 } };
      }
      return { content: "final answer", toolCalls: [], model: "test-model", usage: { promptTokens: 1, completionTokens: 1, durationMs: 0 } };
    },
    async listModels(): Promise<string[]> {
      return [];
    },
  } as unknown as OllamaClient;
}

function loopConfig(): ReturnType<typeof loadConfig> {
  const cfg = loadConfig();
  cfg.compression = { ...cfg.compression, enabled: false };
  cfg.fallbackModel = cfg.model;
  cfg.workspace = tmpDir;
  // The coding router would build its own real provider client and ignore the
  // fake below; these tests are about the log, not about routing.
  cfg.coding = { enabled: false, chain: [], logEdits: false };
  return cfg;
}

function registryOf(tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  // forAllowlist marks the copy read-only, so the loop skips lifecycle hooks.
  return registry.forAllowlist(registry.names());
}

describe("agent loop tool-call lifecycle in the log", () => {
  it("brackets a per-call tool with started and terminal rows", async () => {
    const session = "s_loop_sequential";
    const tools = registryOf([readTool("file_write", "wrote 3 bytes")]);
    const calls: ModelToolCall[] = [{ id: "tc_loop_1", function: { name: "file_write", arguments: { path: "a.txt" } } }];

    await runAgent({
      cfg: loopConfig(),
      ollama: fakeOllama(calls),
      tools,
      emit: () => {},
      prompt: "write a file",
      suppressFinal: true,
      systemOverride: "test system",
      eventLogSession: session,
    });

    const events = toolEventsOf(session);
    assert.deepEqual(events.map((e) => e.state), ["started", "succeeded"]);
    assert.deepEqual(events.map((e) => e.toolCallId), ["tc_loop_1", "tc_loop_1"]);
    assert.deepEqual(events.map((e) => e.name), ["file_write", "file_write"]);
    assert.equal(hasUnfinishedToolCall(session), false, "a completed call must not look in flight");
  });

  it("brackets every call of a batched read-only turn", async () => {
    const session = "s_loop_parallel";
    const tools = registryOf([readTool("file_read", "read a"), readTool("file_list", "listed")]);
    const calls: ModelToolCall[] = [
      { id: "tc_read", function: { name: "file_read", arguments: { path: "a.txt" } } },
      { id: "tc_list", function: { name: "file_list", arguments: {} } },
    ];

    await runAgent({
      cfg: loopConfig(),
      ollama: fakeOllama(calls),
      tools,
      emit: () => {},
      prompt: "read and list",
      suppressFinal: true,
      systemOverride: "test system",
      eventLogSession: session,
    });

    const events = toolEventsOf(session);
    assert.deepEqual(
      events.map((e) => `${e.toolCallId}:${e.state}`),
      ["tc_read:started", "tc_list:started", "tc_read:succeeded", "tc_list:succeeded"],
    );
    assert.equal(hasUnfinishedToolCall(session), false);
  });

  it("derives a stable id when the model supplies none", async () => {
    const session = "s_loop_no_id";
    const tools = registryOf([readTool("file_write", "ok")]);
    const calls: ModelToolCall[] = [{ function: { name: "file_write", arguments: {} } }];

    await runAgent({
      cfg: loopConfig(),
      ollama: fakeOllama(calls),
      tools,
      emit: () => {},
      prompt: "write without an id",
      suppressFinal: true,
      systemOverride: "test system",
      eventLogSession: session,
    });

    const events = toolEventsOf(session);
    assert.equal(events.length, 2);
    assert.ok(events[0]!.toolCallId.length > 0, "a missing model id must still yield an id");
    assert.equal(events[0]!.toolCallId, events[1]!.toolCallId);
  });

  it("records nothing when the caller supplies no log session", async () => {
    const session = "s_loop_disabled";
    const tools = registryOf([readTool("file_write", "ok")]);
    const calls: ModelToolCall[] = [{ id: "tc_none", function: { name: "file_write", arguments: {} } }];

    await runAgent({
      cfg: loopConfig(),
      ollama: fakeOllama(calls),
      tools,
      emit: () => {},
      prompt: "write a file",
      suppressFinal: true,
      systemOverride: "test system",
    });

    assert.deepEqual(toolEventsOf(session), []);
  });
});
