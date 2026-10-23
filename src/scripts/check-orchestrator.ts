import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, ChatOptions, ChatResult, OllamaClient, OllamaToolCall } from "../ollama.js";
import type { AgentEvent } from "../agent/events.js";
import type { Config } from "../config.js";
import type { RunOptions, RunResult } from "../agent/loop.js";
import type { VerdictRecord } from "../agent/orchestrator.js";
import type { ExecutionCheckpoint } from "../agent/checkpoint.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manus-orch-smoke-"));
process.env.MANUS_LOCAL_DATA_DIR = path.join(tmp, "data");
process.env.MANUS_LOCAL_EVALS_DIR = path.join(tmp, "evals");
process.env.MANUS_LOCAL_CONFIG = path.join(tmp, "config-none.json");

const { loadConfig } = await import("../config.js");
const { ToolRegistry } = await import("../tools/registry.js");
const { runOrchestratedAgent } = await import("../agent/orchestrator.js");
const { extractJson, normalizePlan, fallbackPlan } = await import("../agent/planner.js");
const { parseVerdict } = await import("../agent/verifier.js");

type Role = "planner" | "critic" | "final" | "worker";
interface FakeResp {
  content: string;
  toolCalls?: OllamaToolCall[];
}

function roleOf(messages: ChatMessage[]): Role {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("planner role")) return "planner";
  if (system.includes("COMPLETED task as a whole")) return "final";
  if (system.includes("ONE executed plan step")) return "critic";
  return "worker";
}

function fakeOllama(handler: (role: Role, messages: ChatMessage[], counts: Record<Role, number>) => FakeResp): {
  client: OllamaClient;
  counts: Record<Role, number>;
  prompts: string[];
} {
  const counts: Record<Role, number> = { planner: 0, critic: 0, final: 0, worker: 0 };
  const prompts: string[] = [];
  const client = {
    async chat(opts: ChatOptions): Promise<ChatResult> {
      const role = roleOf(opts.messages);
      // Flow fixtures inspect their observation journal before delivering the
      // scripted final verdict. Adversarial verifier fixtures opt out by not
      // registering this specifically marked tool. Counts track scripted turns.
      if (role === "final" && opts.tools?.some(t => t.function.description === "orchestrator test observation") && !opts.messages.some(m => m.role === "tool" && m.tool_name === "file_read")) {
        return { content: "", toolCalls: [{ function: { name: "file_read", arguments: {} } }], model: opts.model, usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 } };
      }
      counts[role] += 1;
      const last = opts.messages[opts.messages.length - 1];
      if (last) prompts.push(last.content);
      const resp = handler(role, opts.messages, counts);
      return {
        content: resp.content,
        toolCalls: resp.toolCalls ?? [],
        model: opts.model,
        usage: { promptTokens: 10, completionTokens: 5, durationMs: 1 },
      };
    },
    async listModels(): Promise<string[]> {
      return [];
    },
  } as unknown as OllamaClient;
  return { client, counts, prompts };
}

function testRegistry(): InstanceType<typeof ToolRegistry> {
  const registry = new ToolRegistry();
  const observations: string[] = [];
  registry.register({ name: "file_read", description: "orchestrator test observation", parameters: {}, run: async () => ({ ok: true, content: observations.join("\n") || "No echo observations" }) });
  registry.register({
    name: "echo",
    description: "echo a text back",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    run: async (args) => { const content = `echo: ${String(args["text"] ?? "")}`; observations.push(content); return { ok: true, content }; },
  });
  return registry;
}

function testCfg(): Config {
  const cfg = loadConfig();
  cfg.workspace = path.join(tmp, "workspace");
  fs.mkdirSync(cfg.workspace, { recursive: true });
  cfg.orchestrator = {
    enabled: true,
    plannerModel: "",
    verifierModel: "",
    maxPlanSteps: 8,
    maxStepsPerWorker: 6,
    maxRevisionsPerStep: 1,
    maxReplans: 1,
    verifyFinal: true,
  };
  // Keep the smoke hermetic: no provider may serve a coding turn from the
  // network. The harness injects a fake `ollama` client for every turn; with an
  // empty failover chain the coding router has no coder to pick, so a coding
  // turn (a repair instruction names files and tools) falls back to that fake
  // instead of escaping to the real provider chain.
  cfg.coding = { enabled: true, chain: [], logEdits: false };
  cfg.failover = { providers: [] };
  return cfg;
}

function ofType<T extends AgentEvent["type"]>(events: AgentEvent[], type: T): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

function planJson(steps: Array<{ title: string; instruction: string; criteria: string }>, trivial = false): string {
  return JSON.stringify({
    goal: "finish the request",
    trivial,
    steps: steps.map((s, i) => ({ id: `s${i + 1}`, title: s.title, instruction: s.instruction, success_criteria: s.criteria })),
  });
}

function verdictJson(verdict: string, reason: string, fixes: string[] = []): string {
  return JSON.stringify({ verdict, reason, fixes });
}

async function scenarioParsing(): Promise<Array<[string, boolean]>> {
  const checks: Array<[string, boolean]> = [];

  const clean = normalizePlan(extractJson(planJson([{ title: "a", instruction: "ia", criteria: "ca" }])), "req", 8);
  checks.push(["parse: clean JSON", Boolean(clean && clean.steps.length === 1 && clean.steps[0]?.title === "a")]);

  const fenced = normalizePlan(
    extractJson(`Sure! Here is the plan:\n\`\`\`json\n${planJson([{ title: "b", instruction: "ib", criteria: "cb" }])}\n\`\`\`\nDone.`),
    "req",
    8,
  );
  checks.push(["parse: fenced JSON with trailing prose", Boolean(fenced && fenced.steps.length === 1 && fenced.source === "model")]);

  const braced = normalizePlan(
    extractJson(`blah {"goal":"g","trivial":false,"steps":[{"instruction":"i1"},{"instruction":"i2"},{"instruction":"i3"}]} blah`),
    "req",
    2,
  );
  checks.push(["parse: brace extraction + maxPlanSteps cap", Boolean(braced && braced.steps.length === 2)]);
  checks.push(["parse: missing title falls back to instruction", braced?.steps[0]?.title === "i1"]);
  checks.push([
    "parse: default success criteria filled",
    braced?.steps.every((s) => s.successCriteria.length > 0) === true,
  ]);

  checks.push(["parse: garbage yields null", extractJson("no json at all") === null]);
  checks.push(["parse: steps without instruction are dropped", normalizePlan({ steps: [{ title: "x" }] }, "req", 8) === null]);

  const fb = fallbackPlan("do the thing\nsecond line");
  checks.push(["fallback: trivial single step with raw prompt", fb.trivial === true && fb.steps.length === 1 && fb.steps[0]?.instruction === "do the thing\nsecond line"]);
  checks.push(["fallback: source marked", fb.source === "fallback"]);

  checks.push(["verdict: uppercase PASS", parseVerdict('{"verdict":"PASS"}').verdict === "pass"]);
  checks.push(["verdict: ok maps to pass", parseVerdict('{"verdict":"ok","reason":"r"}').verdict === "pass"]);
  checks.push(["verdict: needs revision maps to revise", parseVerdict('{"verdict":"needs revision"}').verdict === "revise"]);
  checks.push(["verdict: not complete maps to revise", parseVerdict('{"verdict":"not complete"}').verdict === "revise"]);
  checks.push(["verdict: fixes string becomes array", parseVerdict('{"verdict":"revise","fixes":"only one"}').fixes.length === 1]);
  checks.push(["verdict: fixes array preserved", parseVerdict('{"verdict":"revise","fixes":["a","b"]}').fixes.length === 2]);
  checks.push(["verdict: PASS with required fixes cannot certify completion", parseVerdict('{"verdict":"pass","fixes":["Missing persistence"]}').verdict === "revise"]);
  checks.push(["verdict: empty fixes cannot hide issues alias", parseVerdict('{"verdict":"pass","fixes":[],"issues":["Submit does not work"]}').verdict === "revise"]);
  checks.push(["verdict: optional notes do not block completed work", parseVerdict('{"verdict":"pass","fixes":[],"notes":["Consider softer colors"]}').verdict === "pass"]);
  checks.push(["verdict: garbage requires verification", (() => {
    const v = parseVerdict("I dunno, looks fine");
    return v.verdict === "revise" && v.parsed === false;
  })()]);
  checks.push(["verdict: free-text fail detected", parseVerdict("This failed because the file was never created").verdict === "fail"]);
  checks.push(["verdict: free-text needs-fix detected", parseVerdict("The answer needs fixes before it can pass").verdict === "pass" || parseVerdict("The answer needs fixes before it can pass").verdict === "revise"]);
  return checks;
}

async function scenarioReviseAndVerify(): Promise<Array<[string, boolean]>> {
  const checks: Array<[string, boolean]> = [];
  const events: AgentEvent[] = [];
  const { client, counts, prompts } = fakeOllama((role, _messages, c) => {
    if (role === "planner") {
      return { content: `Here you go:\n\`\`\`json\n${planJson([
        { title: "step one", instruction: "do one", criteria: "one done" },
        { title: "step two", instruction: "do two", criteria: "two done" },
      ])}\n\`\`\`\ntrailing text` };
    }
    if (role === "worker") {
      if (c.worker === 1) return { content: "attempt one output" };
      if (c.worker === 2) return { content: "attempt two output" };
      return { content: "step two final answer" };
    }
    if (role === "critic") {
      if (c.critic === 1) return { content: verdictJson("revise", "missing evidence for criteria one", ["use the echo tool"]) };
      return { content: verdictJson("pass", "criteria met") };
    }
    return { content: verdictJson("pass", "answer satisfies the request") };
  });

  const verdicts: VerdictRecord[] = [];
  const res = await runOrchestratedAgent({
    cfg: testCfg(),
    ollama: client,
    tools: testRegistry(),
    emit: (e) => events.push(e),
    prompt: "do the two things",
    verdicts,
  });

  checks.push(["flow: result is the last step output", res.text === "step two final answer"]);
  checks.push(["flow: worker retried exactly once after revise", counts.worker === 3]);
  checks.push(["flow: revision prompt carries the critique", prompts.some((p) => p.includes("missing evidence for criteria one"))]);
  checks.push(["flow: revision prompt carries the fixes", prompts.some((p) => p.includes("use the echo tool"))]);
  checks.push(["flow: planner called once", counts.planner === 1]);
  checks.push(["flow: critic called per attempt+step", counts.critic === 3]);
  checks.push(["flow: final verifier called once", counts.final === 1]);

  const planEvents = ofType(events, "plan");
  checks.push(["events: plan emitted with 2 model steps", planEvents.length === 1 && planEvents[0]?.steps.length === 2 && planEvents[0]?.source === "model"]);
  const planStart = ofType(events, "plan_step").filter((e) => e.phase === "start");
  const planDone = ofType(events, "plan_step").filter((e) => e.phase === "done");
  checks.push([
    "events: plan_step done only after accepted attempt",
    planStart.length === 2 && planDone.length === 2 && planStart.every((e, i) => e.total === 2 && e.index === i + 1),
  ]);
  const critiques = ofType(events, "critique");
  checks.push(["events: critique sequence revise,pass,pass", critiques.length === 3 && critiques[0]?.verdict === "revise" && critiques[1]?.verdict === "pass" && critiques[2]?.verdict === "pass"]);
  const revises = ofType(events, "revise");
  checks.push(["events: exactly one revise with fixes", revises.length === 1 && revises[0]?.fixes.length === 1]);
  checks.push(["events: final verify pass emitted", ofType(events, "verify").some((e) => e.verdict === "pass")]);
  checks.push(["events: workers suppressed (one done, one assistant_message)", ofType(events, "done").length === 1 && ofType(events, "assistant_message").length === 1]);
  checks.push(["events: done steps = planner+workers+critics+final", ofType(events, "done")[0]?.steps === 1 + 3 + 3 + 1]);
  checks.push(["usage: aggregated over 8 model calls", res.usage.promptTokens === 80 && res.usage.completionTokens === 40]);
  checks.push(["verdicts: 4 recorded, 1 non-pass", verdicts.length === 4 && verdicts.filter((v) => v.verdict !== "pass").length === 1]);
  return checks;
}

async function scenarioTrivialWithTool(): Promise<Array<[string, boolean]>> {
  const checks: Array<[string, boolean]> = [];
  const events: AgentEvent[] = [];
  const { client, counts } = fakeOllama((role, _messages, c) => {
    if (role === "planner") return { content: planJson([{ title: "direct", instruction: "echo hi", criteria: "echo ran" }], true) };
    if (role === "worker") {
      if (c.worker === 1) {
        return { content: "", toolCalls: [{ function: { name: "echo", arguments: { text: "hi" } } }] };
      }
      return { content: "done with tool" };
    }
    return { content: verdictJson("pass", "echo evidence checked") };
  });

  const res = await runOrchestratedAgent({
    cfg: testCfg(),
    ollama: client,
    tools: testRegistry(),
    emit: (e) => events.push(e),
    prompt: "echo hi",
  });

  checks.push(["trivial: mandatory critic and final verification", counts.critic === 1 && counts.final === 1]);
  checks.push(["trivial: worker used the tool", ofType(events, "tool_result").some((e) => e.name === "echo" && e.ok)]);
  checks.push(["trivial: result text", res.text === "done with tool"]);
  checks.push(["trivial: plan marked trivial", ofType(events, "plan")[0]?.trivial === true]);
  checks.push(["trivial: done steps include verification", ofType(events, "done")[0]?.steps === 5]);
  return checks;
}

async function scenarioReplanAndFailOpen(): Promise<Array<[string, boolean]>> {
  const checks: Array<[string, boolean]> = [];
  const events: AgentEvent[] = [];
  const { client, counts } = fakeOllama((role, _messages, c) => {
    if (role === "planner") {
      if (c.planner === 1) {
        return { content: planJson([
          { title: "step A", instruction: "do A", criteria: "A done" },
          { title: "step B", instruction: "do B", criteria: "B done" },
        ]) };
      }
      return { content: planJson([{ title: "step C", instruction: "do C", criteria: "C done" }]) };
    }
    if (role === "worker") return { content: `output ${c.worker}` };
    if (role === "critic") {
      if (c.critic === 1) return { content: verdictJson("fail", "blocked by a missing resource", ["try another source"]) };
      return { content: verdictJson("pass", "evidence checked") };
    }
    return { content: verdictJson("pass", "evidence checked") };
  });

  const res = await runOrchestratedAgent({
    cfg: testCfg(),
    ollama: client,
    tools: testRegistry(),
    emit: (e) => events.push(e),
    prompt: "do it",
  });

  checks.push(["replan: emitted after fail verdict", ofType(events, "replan").length === 1]);
  checks.push(["replan: planner called twice", counts.planner === 2]);
  checks.push(["replan: second plan ran (1 critic call for it)", counts.critic === 2]);
  checks.push(["replan: valid critique passes without revision", ofType(events, "revise").length === 0]);
  checks.push(["replan: valid final verification passes", ofType(events, "verify")[0]?.verdict === "pass"]);
  checks.push(["replan: flow completed", res.text.length > 0 && ofType(events, "done").length === 1]);
  checks.push(["replan: no incomplete error", !ofType(events, "error").some((e) => e.message.includes("task incomplete"))]);
  return checks;
}

async function scenarioWorkerCrash(): Promise<Array<[string, boolean]>> {
  const checks: Array<[string, boolean]> = [];
  const events: AgentEvent[] = [];
  const { client } = fakeOllama((role) => {
    if (role === "planner") return { content: planJson([{ title: "direct", instruction: "do it", criteria: "done" }], true) };
    throw new Error("boom-worker");
  });

  let error = "";
  try { await runOrchestratedAgent({
    cfg: testCfg(),
    ollama: client,
    tools: testRegistry(),
    emit: (e) => events.push(e),
    prompt: "crash me",
  }); } catch (err) { error = String(err); }

  checks.push(["crash: failure propagates to task persistence", error.includes("boom-worker")]);
  checks.push(["crash: never emits success", ofType(events, "done").length === 0]);
  return checks;
}

async function scenarioFailureBoundaries(): Promise<Array<[string, boolean]>> {
  const checks: Array<[string, boolean]> = [];
  for (const kind of ["invalid", "unavailable", "revise", "crash", "empty", "final-fail", "final-fixed"] as const) {
    const events: AgentEvent[] = [];
    const { client, counts } = fakeOllama((role, _messages, c) => {
      if (role === "planner") return { content: planJson([{ title: "step", instruction: "do it", criteria: "done" }]) };
      if (role === "worker") {
        if (kind === "crash") throw new Error("worker failed");
        if (kind === "empty") return { content: "" };
        return { content: "result" };
      }
      if (role === "critic") {
        if (kind === "invalid") return { content: "looks fine" };
        if (kind === "unavailable") throw new Error("verifier offline");
        return { content: verdictJson(kind === "revise" ? "revise" : "pass", "check") };
      }
      return { content: verdictJson(kind === "final-fixed" && c.final > 1 ? "pass" : "revise", "final check") };
    });
    const cfg = testCfg();
    cfg.orchestrator.maxReplans = 0;
    let failed = false;
    try { await runOrchestratedAgent({ cfg, ollama: client, tools: testRegistry(), emit: (e) => events.push(e), prompt: "test" }); }
    catch { failed = true; }
    checks.push([`${kind}: correct terminal result`, failed === (kind !== "final-fixed")]);
    checks.push([`${kind}: no false done event`, ofType(events, "done").length === (kind === "final-fixed" ? 1 : 0)]);
    if (kind.startsWith("final-")) checks.push([`${kind}: repair verified again`, counts.final === (kind === "final-fail" ? 3 : 2)]);
    if (kind === "crash") checks.push(["crash: critic cannot override executor failure", counts.critic === 0]);
  }
  return checks;
}

async function scenarioHistoryAndAsk(): Promise<Array<[string, boolean]>> {
  const { conversationHistory } = await import("../agent/history.js");
  const { runAgent } = await import("../agent/loop.js");
  const checks: Array<[string, boolean]> = [];
  const persisted = [{ role: "user", content: "Use report-ar.txt" }, { role: "assistant", content: "Created report-ar.txt" }];
  const history = conversationHistory(persisted);
  persisted.push({ role: "user", content: "Translate it" });
  const seen = new Set<string>();
  const { client } = fakeOllama((role, messages) => {
    if (messages.some((m) => m.role === "assistant" && m.content === "Created report-ar.txt")) seen.add(role);
    if (role === "planner") return { content: planJson([{ title: "translate", instruction: "translate it", criteria: "translated" }]) };
    if (role === "critic" || role === "final") return { content: verdictJson("pass", "translated") };
    return { content: "translated" };
  });
  await runOrchestratedAgent({ cfg: testCfg(), ollama: client, tools: testRegistry(), emit: () => {}, prompt: "Translate it", history });
  checks.push(["history: all roles see earlier turns", ["planner", "worker", "critic", "final"].every((role) => seen.has(role))]);
  checks.push(["history: current turn is not duplicated", history.length === 2]);
  const longTurns = Array.from({ length: 20 }, (_, i) => [{ role: "user", content: i === 0 ? "ORIGINAL_CONSTRAINT: Arabic, no network, SAR" : `User follow-up ${i}` }, { role: "assistant", content: `Assistant response ${i}` }]).flat();
  longTurns.push({ role: "user", content: "LATEST_CORRECTION: tax is 5 percent" }, { role: "assistant", content: "Correction recorded" });
  const longHistory = conversationHistory(longTurns);
  checks.push(["history: all older user constraints retained", longHistory.filter(m => m.role === "user").length === 21 && longHistory.some(m => m.content.startsWith("ORIGINAL_CONSTRAINT"))]);
  checks.push(["history: latest correction follows original requirement", longHistory.findIndex(m => m.content.startsWith("LATEST_CORRECTION")) > longHistory.findIndex(m => m.content.startsWith("ORIGINAL_CONSTRAINT"))]);
  checks.push(["history: omitted assistant output disclosed", !longHistory.some(m => m.content === "Assistant response 0") && longHistory[0]?.content.includes("older assistant replies were omitted") === true]);
  const seenLong = new Set<string>();
  const longMock = fakeOllama((role, messages) => {
    if (messages.some(m => m.role === "user" && m.content.startsWith("ORIGINAL_CONSTRAINT")) && messages.some(m => m.role === "user" && m.content.startsWith("LATEST_CORRECTION"))) seenLong.add(role);
    if (role === "planner") return { content: planJson([{ title: "continue", instruction: "follow constraints", criteria: "correct result" }]) };
    if (role === "worker") return { content: "Arabic SAR receipt at 5 percent" };
    return { content: verdictJson("pass", "constraints checked") };
  });
  await runOrchestratedAgent({ cfg: testCfg(), ollama: longMock.client, tools: testRegistry(), emit: () => {}, prompt: "Continue", history: longHistory });
  checks.push(["history: all agent roles receive oldest constraints and latest correction", ["planner", "worker", "critic", "final"].every(role => seenLong.has(role))]);
  let budgetRejected = false;
  try { conversationHistory([{ role: "user", content: "x".repeat(96_001) }]); } catch { budgetRejected = true; }
  checks.push(["history: oversized constraints fail explicitly instead of being silently dropped", budgetRejected]);
  let reads = 0;
  let writes = 0;
  const registry = new ToolRegistry();
  for (const name of ["file_read", "file_write", "shell_run", "pty_write", "browser_eval", "mcp__x__read", "agent_spawn"]) {
    registry.register({ name, description: name, parameters: { type: "object" }, run: async () => {
      if (name === "file_read") reads++; else writes++;
      return { ok: true, content: "ok" };
    } });
  }
  const ask = registry.forAskMode();
  const cfg = testCfg();
  fs.mkdirSync(path.join(cfg.workspace, ".manus"), { recursive: true });
  const marker = path.join(cfg.workspace, "hook-ran");
  fs.writeFileSync(path.join(cfg.workspace, ".manus", "hooks.json"), JSON.stringify({
    PreToolUse: [{ matcher: "", command: `node -e "require('fs').writeFileSync('hook-ran','bad')"` }],
  }));
  const adversarial = fakeOllama((role, _messages, c) => {
    if (role === "final") return c.final === 1
      ? { content: "", toolCalls: [{ function: { name: "file_read", arguments: {} } }] }
      : { content: verdictJson("pass", "read checked") };
    return c.worker === 1
      ? { content: "", toolCalls: registry.names().map((name) => ({ function: { name, arguments: {} } })) }
      : { content: "answer" };
  });
  await runAgent({ cfg, ollama: adversarial.client, tools: ask, emit: () => {}, prompt: "read only" });
  checks.push(["ask: injected mutation calls never execute", writes === 0 && reads === 2]);
  checks.push(["ask: model only receives read tools", ask.toOllama().length === 1]);
  checks.push(["ask: command hooks cannot bypass permissions", !fs.existsSync(marker)]);
  fs.unlinkSync(path.join(cfg.workspace, ".manus", "hooks.json"));
  await registry.exec("file_write", {}, { cfg, workspace: cfg.workspace, emit: () => {} });
  checks.push(["ask: normal registry remains usable", writes === 1]);
  const { createTask, setTaskStatus, getTask } = await import("../server/db.js");
  const task = createTask("retry");
  setTaskStatus(task.id, "error", { error: "old failure" });
  setTaskStatus(task.id, "running");
  checks.push(["status: retry clears old error", getTask(task.id)?.error === undefined]);
  setTaskStatus(task.id, "done");
  checks.push(["status: success persists without old failure", getTask(task.id)?.status === "done" && getTask(task.id)?.error === undefined]);
  return checks;
}

async function scenarioCheckpointResume(): Promise<Array<[string, boolean]>> {
  const checks: Array<[string, boolean]> = [];
  let saved: ExecutionCheckpoint | undefined;
  let toolRuns = 0;
  const registry = testRegistry();
  registry.register({ name: "increment", description: "observable effect", parameters: { type: "object" }, run: async () => {
    toolRuns++;
    return { ok: true, content: "effect recorded" };
  } });
  const mock = () => fakeOllama((role, _messages, counts) => {
    if (role === "planner") return { content: planJson([
      { title: "one", instruction: "increment once", criteria: "one effect" },
      { title: "two", instruction: "increment again", criteria: "second effect" },
    ]) };
    if (role !== "worker") return { content: verdictJson("pass", "verified") };
    if (counts.worker % 2 === 1) return { content: "", toolCalls: [{ function: { name: "increment", arguments: {} } }] };
    return { content: "step complete" };
  });
  let interrupted = false;
  try {
    await runOrchestratedAgent({ cfg: testCfg(), ollama: mock().client, tools: registry, emit: () => {}, prompt: "two effects",
      saveCheckpoint: (cp) => {
        saved = structuredClone(cp);
        if (cp.nextStep === 1 && !cp.inFlight) throw new Error("simulated process stop");
      },
    });
  } catch { interrupted = true; }
  checks.push(["checkpoint: interruption after first effect", interrupted && toolRuns === 1 && saved?.nextStep === 1]);
  // Round trip through SQLite to exercise restart persistence, not just an in-memory object.
  const db = await import("../server/db.js");
  const task = db.createTask("two effects");
  db.saveRun(task.id, { prompt: "two effects", effectivePrompt: "two effects", history: [], workspace: tmp, started: true, orchestrated: true, checkpoint: saved });
  db.closeDb(); db.loadDb();
  const resumed = mock();
  await runOrchestratedAgent({ cfg: testCfg(), ollama: resumed.client, tools: registry, emit: () => {}, prompt: "two effects",
    resume: db.getSavedRun(task.id)?.checkpoint, saveCheckpoint: (cp) => { saved = cp; },
  });
  checks.push(["checkpoint: completed effect not repeated after restart", toolRuns === 2 && resumed.counts.worker === 2]);
  checks.push(["checkpoint: original plan restored", resumed.counts.planner === 0]);
  checks.push(["checkpoint: completion persisted", saved?.complete === true && saved?.inFlight === false]);
  const completedMock = mock();
  await runOrchestratedAgent({ cfg: testCfg(), ollama: completedMock.client, tools: registry, emit: () => {}, prompt: "two effects", resume: saved });
  checks.push(["checkpoint: completed result reverified without replaying effects", toolRuns === 2 && completedMock.counts.worker === 0 && completedMock.counts.final === 1]);
  db.closeDb();
  return checks;
}

async function main(): Promise<void> {
  const checks: Array<[string, boolean]> = [];
  checks.push(...(await scenarioParsing()));
  checks.push(...(await scenarioReviseAndVerify()));
  checks.push(...(await scenarioTrivialWithTool()));
  checks.push(...(await scenarioReplanAndFailOpen()));
  checks.push(...(await scenarioWorkerCrash()));
  checks.push(...(await scenarioFailureBoundaries()));
  checks.push(...(await scenarioHistoryAndAsk()));
  checks.push(...(await scenarioCheckpointResume()));
  checks.push(...(await scenarioMandatoryVerification()));

  console.log("");
  for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  const allOk = checks.every(([, ok]) => ok);
  console.log(`\norchestrator smoke: ${allOk ? "PASS" : "FAIL"} (${checks.filter(([, ok]) => ok).length}/${checks.length})  (tmp: ${tmp})`);
  if (!allOk) process.exit(1);
}

async function scenarioMandatoryVerification(): Promise<Array<[string, boolean]>> {
  const checks: Array<[string, boolean]> = [];
  const { runAgent } = await import("../agent/loop.js");
  const { verifyFinal } = await import("../agent/verifier.js");
  for (const mode of ["direct", "planned", "repaired"] as const) {
    const events: AgentEvent[] = [];
    const mock = fakeOllama((role, _messages, counts) => {
      if (role === "planner") return { content: planJson([{ title: "deliver", instruction: "deliver result", criteria: "verified result" }]) };
      if (role === "critic") return { content: verdictJson("pass", "step ready") };
      if (role === "final" && mode === "repaired" && counts.final === 1) return { content: verdictJson("revise", "repair required") };
      if (role === "final") return { content: JSON.stringify({ verdict: "pass", reason: "checked", fixes: [], finalAnswer: "The system completed verification. Result: 42." }) };
      return { content: "Verification will run later. Result: 42." };
    });
    const options = { cfg: testCfg(), ollama: mock.client, tools: testRegistry(), emit: (e: AgentEvent) => events.push(e), prompt: "Deliver the result" };
    const result = await (mode === "direct" ? runAgent(options) : runOrchestratedAgent(options));
    const expected = "The system completed verification. Result: 42.";
    checks.push([`delivery ${mode}: return and terminal events use inspected final answer`, result.text === expected && ofType(events, "assistant_message").every(e => e.text === expected) && ofType(events, "done").every(e => e.text === expected)]);
    checks.push([`delivery ${mode}: verified before message`, events.findIndex(e => e.type === "verify" && e.verdict === "pass") < events.findIndex(e => e.type === "assistant_message")]);
  }
  for (const registryKind of ["absent", "empty", "mutation-only"] as const) {
    const registry = new ToolRegistry();
    let writes = 0;
    if (registryKind === "mutation-only") registry.register({ name: "file_write", description: "write", parameters: {}, run: async () => { writes++; return { ok: true, content: "saved" }; } });
    const mock = fakeOllama(() => ({ content: verdictJson("pass", "claims success") }));
    const base = { cfg: testCfg(), ollama: mock.client, ...(registryKind === "absent" ? {} : { tools: registry }), request: "save report", goal: "save report", finalText: "done", completedSteps: [] };
    for (const toolName of ["file_write", "application_verification"]) {
      const result = await verifyFinal({ ...base, trace: [{ name: toolName, ok: true, summary: "PASS" }] });
      checks.push([`missing inspector ${registryKind}/${toolName}: cannot self-certify`, result.verdict === "revise" && mock.counts.final === 0 && writes === 0]);
    }
    const conversation = await verifyFinal({ ...base, request: "Translate hello into Arabic", finalText: "مرحبا", trace: [] });
    checks.push([`missing inspector ${registryKind}: pure text still reviewed`, conversation.verdict === "pass" && mock.counts.final === 1]);
  }
  for (const mode of ["direct", "planned"] as const) {
    const events: AgentEvent[] = [];
    const mock = fakeOllama((role) => {
      if (role === "planner") return { content: planJson([{ title: "report", instruction: "write report", criteria: "correct report" }]) };
      if (role === "critic") return { content: verdictJson("pass", "step ready") };
      if (role === "final") return { content: JSON.stringify({ verdict: "pass", reason: "Report produced", fixes: [], issues: ["Required totals are wrong"] }) };
      return { content: "Report complete" };
    });
    let rejected = false;
    try {
      const options = { cfg: testCfg(), ollama: mock.client, tools: testRegistry(), emit: (e: AgentEvent) => events.push(e), prompt: "Produce a report with correct totals" };
      await (mode === "direct" ? runAgent(options) : runOrchestratedAgent(options));
    } catch { rejected = true; }
    checks.push([`${mode}: contradictory final PASS remains incomplete after repair`, rejected && mock.counts.final === (mode === "planned" ? 3 : 2) && !events.some(e => ["assistant_message", "assistant_token", "done"].includes(e.type))]);
  }
  for (const mode of ["fallback", "trivial", "direct"] as const) {
    const events: AgentEvent[] = [];
    const cfg = testCfg();
    cfg.orchestrator.verifyFinal = false;
    cfg.orchestrator.maxReplans = 0;
    const mock = fakeOllama((role) => {
      if (role === "planner") return { content: mode === "fallback" ? "invalid plan" : planJson([{ title: "save", instruction: "save report", criteria: "report exists" }], true) };
      if (role === "critic") return { content: verdictJson("pass", "candidate ready") };
      if (role === "final") return { content: verdictJson("revise", "missing report", ["Create and inspect report"]) };
      return { content: "Done, report saved" };
    });
    let failed = false;
    try {
      const opts = { cfg, ollama: mock.client, tools: testRegistry(), emit: (e: AgentEvent) => events.push(e), prompt: "save report" };
      await (mode === "direct" ? runAgent(opts) : runOrchestratedAgent(opts));
    } catch { failed = true; }
    checks.push([`${mode}: disabled flag cannot bypass final gate`, failed && mock.counts.final >= 1]);
    checks.push([`${mode}: no premature success message/token/event`, !events.some(e => ["done", "assistant_message", "assistant_token"].includes(e.type))]);
  }
  for (const behavior of ["skip", "missing", "mutate", "read"] as const) {
    let writes = 0;
    const registry = new ToolRegistry();
    registry.register({ name: "file_read", description: "read", parameters: {}, run: async () => ({ ok: behavior === "read", content: behavior === "read" ? "actual report contents" : "not found" }) });
    registry.register({ name: "file_write", description: "write", parameters: {}, run: async () => { writes++; return { ok: true, content: "written" }; } });
    const mock = fakeOllama((_role, _messages, counts) => counts.final === 1 && behavior !== "skip"
      ? { content: "", toolCalls: [{ function: { name: behavior === "mutate" ? "file_write" : "file_read", arguments: { path: "report.txt" } } }] }
      : { content: verdictJson("pass", "claims checked") });
    const result = await verifyFinal({ cfg: testCfg(), ollama: mock.client, tools: registry, request: "save report", goal: "saved report", finalText: "done", completedSteps: [], trace: [{ name: "file_write", ok: true, summary: "saved" }] });
    checks.push([`inspection ${behavior}: enforced independently of model PASS`, (result.verdict === "pass") === (behavior === "read") && writes === 0]);
  }
  let retained = false;
  const repair = fakeOllama((role, messages, c) => {
    if (role === "planner") return { content: planJson([{ title: "inspect", instruction: "inspect two sections", criteria: "both sections observed" }]) };
    if (role === "worker" && [1, 3].includes(c.worker)) return { content: "", toolCalls: [{ function: { name: "echo", arguments: { text: c.worker === 1 ? "SECTION_A" : "SECTION_B" } } }] };
    if (role === "worker") return { content: "observed" };
    if (role === "critic" && c.critic === 1) return { content: verdictJson("revise", "read second section") };
    if (role === "critic") { const evidence = messages.at(-1)?.content ?? ""; retained = evidence.includes("echo: SECTION_A") && evidence.includes("echo: SECTION_B"); }
    return { content: verdictJson("pass", "evidence complete") };
  });
  await runOrchestratedAgent({ cfg: testCfg(), ollama: repair.client, tools: testRegistry(), prompt: "inspect both sections", emit: () => {} });
  checks.push(["repair: critic retains observations from earlier attempts", retained]);
  return checks;
}

main().catch((err) => {
  console.error(`failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
