/**
 * End-to-end promptwire check.
 *
 * 1. Builds the real runtime registry for the build mode.
 * 2. Asserts the assembled system prompt carries the master sections in
 *    Appendix B order with no unfilled slots.
 * 3. Runs runAgent with a scripted fake model that calls every promptwire tool
 *    exactly once (finish last) in a temporary git workspace, using a fake
 *    opencode bin for code_session, and asserts every call returned ok:true.
 *
 * Run with: npm run check:promptwire
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { buildSystemPrompt } from "../agent/prompt.js";
import { MASTER_ORDER } from "../agent/masterPrompt.js";
import { MASTER_PROMPT_SECTIONS } from "../agent/masterPromptText.js";
import { buildRuntime } from "../setup/runtime.js";
import { runAgent } from "../agent/loop.js";
import type { AgentEvent } from "../agent/events.js";
import type { OllamaClient, ChatOptions } from "../ollama.js";

const PROMPTWIRE_TOOLS = [
  "think",
  "phase_set",
  "file_multi_edit",
  "vault_ref",
  "docs_lookup",
  "artifact_publish",
  "code_session",
  "code_session_status",
  "code_session_collect",
  "finish",
] as const;

const UNFILLED = /\{\{(?!vault:)[^{}]+\}\}/;

interface FakeState {
  sessionId: string;
}

function makeGitRepo(dir: string): void {
  const run = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { windowsHide: true, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "pw@example.invalid"]);
  run(["config", "user.name", "Promptwire Check"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# promptwire\n");
  run(["add", "README.md"]);
  run(["commit", "-q", "-m", "init"]);
}

function reply(content: string, toolCalls: Array<{ function: { name: string; arguments: object } }>) {
  return { model: "fixture", content, toolCalls, usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-promptwire-"));
  const workspace = path.join(root, "task");
  fs.mkdirSync(workspace);
  makeGitRepo(workspace);
  fs.writeFileSync(path.join(workspace, "notes.txt"), "alpha\n");
  fs.writeFileSync(path.join(workspace, "report.txt"), "promptwire report\n");
  fs.mkdirSync(path.join(workspace, "node_modules", "react"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "node_modules", "react", "package.json"), JSON.stringify({ name: "react", version: "19.0.0" }));
  fs.writeFileSync(path.join(workspace, "node_modules", "react", "README.md"), "# react\n\nA fake local package for docs_lookup.\n");

  const fixture = path.join(root, "fake-opencode.cjs");
  fs.writeFileSync(
    fixture,
    'const fs = require("node:fs");\n' +
      'const { execFileSync } = require("node:child_process");\n' +
      'fs.writeFileSync("session-output.txt", "promptwire session\\n");\n' +
      'execFileSync("git", ["add", "-A"], { stdio: "ignore" });\n' +
      'execFileSync("git", ["commit", "-q", "-m", "promptwire session work"], { stdio: "ignore" });\n',
  );
  process.env.LOAM_OPENCODE_BIN = fixture;
  process.env.LOAM_USER_NAME = "Promptwire User";
  process.env.LOAM_USER_TZ = "Asia/Qatar";

  const cfg = loadConfig();
  cfg.workspace = workspace;
  cfg.memory.enabled = false;
  cfg.policy.networkEnabled = false;
  cfg.agent.maxSteps = 40;
  cfg.model = "glm-5.3-flash:cloud";

  const runtime = await buildRuntime(cfg, { mcp: false });
  try {
    const registry = runtime.registry.forMode("build");
    for (const name of PROMPTWIRE_TOOLS) {
      assert.ok(registry.get(name), `build mode registry is missing ${name}`);
    }

    // --- system prompt -----------------------------------------------------
    const system = buildSystemPrompt(cfg, [], registry.names());
    let previous = -1;
    for (const group of MASTER_ORDER) {
      for (const id of group) {
        const section = MASTER_PROMPT_SECTIONS.find((s) => s.id === id);
        assert.ok(section, `missing master section ${id}`);
        const index = system.indexOf(`## ${section!.title}`);
        assert.ok(index > previous, `master section ${id} (${section!.title}) is out of order`);
        previous = index;
      }
    }
    assert.ok(!UNFILLED.test(system), `unfilled slot remains: ${system.match(UNFILLED)?.[0] ?? ""}`);
    assert.ok(system.includes("Promptwire User"), "user_name slot is not filled");
    assert.ok(system.includes("{{vault:NAME}}"), "literal vault example was not preserved");

    // --- scripted agent run -----------------------------------------------
    const state: FakeState = { sessionId: "" };
    const events: AgentEvent[] = [];
    const sequence: Array<{ name: string; args: () => Record<string, unknown> }> = [
      { name: "think", args: () => ({ note: "promptwire e2e" }) },
      { name: "phase_set", args: () => ({ phase: "build", reason: "promptwire e2e" }) },
      { name: "file_multi_edit", args: () => ({ path: "notes.txt", edits: [{ find: "alpha", replace: "beta" }] }) },
      { name: "vault_ref", args: () => ({}) },
      { name: "docs_lookup", args: () => ({ library: "react" }) },
      { name: "artifact_publish", args: () => ({ path: "report.txt", kind: "report", title: "Promptwire report" }) },
      { name: "code_session", args: () => ({ task: "Add a file", acceptance: "A file is committed", name: "pw-e2e" }) },
      { name: "code_session_status", args: () => ({ id: state.sessionId }) },
      { name: "code_session_collect", args: () => ({ id: state.sessionId }) },
      { name: "finish", args: () => ({ summary: "Exercised every promptwire tool", confidence: "high" }) },
    ];
    let cursor = 0;
    const client = {
      chat: async (o: ChatOptions) => {
        const systemPrompt = String(o.messages[0]?.content ?? "");
        if (systemPrompt.includes("COMPLETED task as a whole")) {
          const hasTool = o.messages.some((m) => m.role === "tool");
          if (!hasTool) return reply("", [{ function: { name: "file_read", arguments: { path: "report.txt" } } }]);
          return reply(
            JSON.stringify({
              verdict: "pass",
              reason: "every promptwire tool returned ok",
              fixes: [],
              finalAnswer: "All promptwire tools exercised successfully.",
            }),
            [],
          );
        }
        if (cursor < sequence.length) {
          const step = sequence[cursor++]!;
          return reply("", [{ function: { name: step.name, arguments: step.args() } }]);
        }
        return reply("All promptwire tools exercised.", []);
      },
    } as unknown as OllamaClient;

    await runAgent({
      cfg,
      ollama: client,
      tools: registry,
      emit: (event: AgentEvent) => {
        events.push(event);
        if (event.type === "tool_result" && event.name === "code_session" && event.ok) {
          try {
            state.sessionId = (JSON.parse(event.summary) as { id?: string }).id ?? "";
          } catch {
            /* summary truncated; status/collect will report the error */
          }
        }
      },
      prompt: "Exercise each promptwire tool once.",
      taskId: "task_pw_e2e",
    });

    const results = new Map<string, boolean>();
    for (const event of events) {
      if (event.type === "tool_result") results.set(event.name, event.ok);
    }
    const rows: Array<{ tool: string; ok: boolean }> = PROMPTWIRE_TOOLS.map((name) => ({ tool: name, ok: results.get(name) ?? false }));
    for (const row of rows) {
      assert.equal(row.ok, true, `${row.tool} did not return ok:true`);
    }
    console.table(rows);
    console.log("PASS promptwire: master prompt assembled in Appendix B order, every promptwire tool returned ok:true");
  } finally {
    await runtime.dispose();
    delete process.env.LOAM_OPENCODE_BIN;
    delete process.env.LOAM_USER_NAME;
    delete process.env.LOAM_USER_TZ;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* git worktrees can leave read-only files behind on Windows */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
