import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-g4-"));
process.env.MANUS_LOCAL_DATA_DIR = tmp;

const { ensureAppBuilderSchema } = await import("../store.js");
const { createAppProject, getAppProject } = await import("../projects.js");
const { enqueuePrompt, queueState, updateQueueItem, removeQueueItem, setQueuePaused, takeNextQueued, markQueueItemSent, markQueueItemFailed, MAX_QUEUE_ITEMS, MAX_CONTENT_CHARS } = await import("../promptQueue.js");
const { raceEstimate, scoreBranch, RACE_WEIGHTS } = await import("../race.js");
const { recordAppUsage, appUsage, displayCredits, versionUsageSummary } = await import("../metering.js");
const { checkBaseUrl, defaultProvider, setDefaultProvider, projectAiConfig, setProjectAi, aiEnvFor, AI_VAULT_SCOPE, DEFAULT_KEY_NAME } = await import("../localCloud.js");
const { setSecret } = await import("../../server/secretsVault.js");

ensureAppBuilderSchema();
const project = createAppProject({ title: "queue-race-meter", baseWorkspace: tmp });
const pid = project.id;

// ---------- §4.11 prompt queue ----------

test("queue: enqueue, order, edit, move, remove", () => {
  const a = enqueuePrompt(pid, "first", "quick");
  const b = enqueuePrompt(pid, "second", "goal");
  assert.ok(!("error" in a!) && !("error" in b!));
  let state = queueState(pid);
  assert.equal(state.paused, false);
  assert.deepEqual(state.items.map((i) => i.content), ["first", "second"]);
  assert.deepEqual(state.items.map((i) => i.position), [0, 1]);
  state = updateQueueItem(pid, b!.id, { content: "second (edited)" }) as typeof state;
  assert.equal(state.items[1]!.content, "second (edited)");
  // move b above a by claiming position 0; dense re-pack keeps 0..n
  state = updateQueueItem(pid, b!.id, { position: 0 }) as typeof state;
  assert.deepEqual(state.items.map((i) => i.content), ["second (edited)", "first"]);
  state = removeQueueItem(pid, a!.id) as typeof state;
  assert.deepEqual(state.items.map((i) => i.content), ["second (edited)"]);
  assert.deepEqual(state.items.map((i) => i.position), [0]);
});

test("queue: caps, validation, pause, take/mark lifecycle", () => {
  assert.equal("error" in (enqueuePrompt(pid, "", "quick"))!, true);
  assert.equal((enqueuePrompt(pid, "x".repeat(MAX_CONTENT_CHARS + 1), "quick") as { error: string }).error, "content_too_long");
  assert.equal((enqueuePrompt(pid, "ok", "quick", ["/abs"]) as never as { error?: string }).error, undefined);
  let state = setQueuePaused(pid, true);
  assert.equal(state.paused, true);
  assert.equal((enqueuePrompt(pid, "while paused", "quick") as { error: string }).error, "queue_paused");
  state = setQueuePaused(pid, false);
  // fill to the cap
  for (let i = 0; i < MAX_QUEUE_ITEMS - state.items.length; i++) enqueuePrompt(pid, `item ${i}`, "quick");
  assert.equal((enqueuePrompt(pid, "overflow", "quick") as { error: string }).error, "queue_full");
  const next = takeNextQueued(pid);
  assert.ok(next);
  assert.equal(next!.content, "second (edited)"); // lowest position first
  assert.equal(queueState(pid).items.find((i) => i.id === next!.id)!.status, "sending");
  markQueueItemSent(next!.id);
  const failed = takeNextQueued(pid)!;
  markQueueItemFailed(pid, failed.id, "boom");
  assert.equal(queueState(pid).paused, true, "a failed start pauses the queue");
  assert.equal((enqueuePrompt(pid, "paused now", "quick") as { error: string }).error, "queue_paused");
  setQueuePaused(pid, false);
  assert.equal(takeNextQueued("app_notaproject"), null);
});

// ---------- §4.13 race ----------

test("race estimate: no history → default basis with the documented math", () => {
  const e = raceEstimate(pid, 3);
  assert.equal(e.branches, 3);
  assert.equal(e.basis, "default");
  assert.equal(e.perRunCredits, 10);
  assert.equal(e.extraCredits, Math.ceil(2 * 10 + 3));
  assert.equal(e.maxTotalCredits, Math.ceil(3 * 1.5 * 10));
  assert.equal(e.sampleRuns, 0);
});

test("scoreBranch: full pass sums to 100; a broken build caps at 30", () => {
  const step = (id: import("../types.js").VerifyStepId, ok: boolean) => ({ id, ok, command: "cmd", skipped: false, durationMs: 1, exitCode: ok ? 0 : 1, outputTail: "" });
  const report = (over: Partial<Parameters<typeof scoreBranch>[0]>) =>
    ({ steps: [step("build", true), step("check", true), step("lint", true)], consoleErrors: 0, visualVerdict: "pass", ...over }) as Parameters<typeof scoreBranch>[0];
  const full = scoreBranch(report({}), 10);
  assert.equal(full.total, RACE_WEIGHTS.build + RACE_WEIGHTS.check + RACE_WEIGHTS.lint + RACE_WEIGHTS.visualPass + RACE_WEIGHTS.consoleClean + 10);
  const broken = scoreBranch(report({ steps: [step("build", false), step("check", true), step("lint", true)] }), 10);
  assert.ok(broken.total <= 30, `broken build caps at 30, got ${broken.total}`);
  assert.equal(broken.build, 0);
  assert.equal(scoreBranch(report({ visualVerdict: "unavailable" }), 0).visual, RACE_WEIGHTS.visualUnavailable);
  const clamped = scoreBranch(report({}), 99);
  assert.equal(clamped.requirementCoverage, 10);
});

// ---------- §4.14 metering ----------

test("metering: rows roll up per run/role, cached display at 0.1", () => {
  recordAppUsage({ projectId: pid, runId: "run_1", role: "engineer", step: "implement", kind: "build", tier: "max", promptTokens: 1500, completionTokens: 500, cachedTokens: 500, toolCalls: 6, durationMs: 1000 });
  recordAppUsage({ projectId: pid, runId: "run_1", role: "lead", step: "plan", kind: "build", tier: "max", promptTokens: 1000, completionTokens: 1000, cachedTokens: 0, toolCalls: 2, durationMs: 500 });
  const { rows, totals } = appUsage(pid, "run_1");
  assert.equal(rows.length, 2);
  assert.equal(totals.promptTokens, 2500);
  assert.equal(totals.completionTokens, 1500);
  assert.equal(totals.toolCalls, 8);
  // display: (2500-500) + 500*0.1 + 1500 = 3550 → 4 credits
  assert.equal(displayCredits(2500, 1500, 500), 4);
  const summary = versionUsageSummary(rows);
  assert.equal(summary.credits, 4);
  assert.equal(summary.toolCalls, 8);
  assert.equal(summary.wallMs, 1500);
  assert.equal(appUsage(pid, "run_none").rows.length, 0);
});

// ---------- §4.10.4 localCloud ----------

test("localCloud: base URL validation", () => {
  assert.equal(checkBaseUrl("https://api.x.ai/v1/"), "https://api.x.ai/v1");
  assert.equal((checkBaseUrl("http://example.com/v1") as { error: string }).error, "base_url_must_be_https");
  assert.equal(checkBaseUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
  assert.equal((checkBaseUrl("https://u:p@example.com") as { error: string }).error, "base_url_has_credentials");
  assert.equal((checkBaseUrl("not a url") as { error: string }).error, "base_url_invalid");
});

test("localCloud: default provider, project override, env never without key", () => {
  setDefaultProvider({ baseUrl: "https://api.openai.com/v1", model: "gpt-test", key: "sk-localcloud-test-key-123456" });
  const def = defaultProvider();
  assert.equal(def.baseUrl, "https://api.openai.com/v1");
  assert.equal(def.model, "gpt-test");
  assert.equal(def.hasKey, true);
  const fresh = getAppProject(pid)!;
  let cfg = projectAiConfig(fresh);
  assert.equal(cfg.keySource, "default");
  assert.equal(cfg.effective.model, "gpt-test");
  assert.equal(setSecret(AI_VAULT_SCOPE, `project-${pid}`, "sk-project-key-abcdef"), true);
  cfg = projectAiConfig(getAppProject(pid)!);
  assert.equal(cfg.keySource, "project");
  const env = aiEnvFor(getAppProject(pid)!);
  assert.equal(env.AI_BASE_URL, "https://api.openai.com/v1");
  assert.equal(env.AI_MODEL, "gpt-test");
  assert.equal(typeof env.AI_API_KEY, "string");
  // clearing both keys → no env at all
  setProjectAi(pid, { key: "" });
  setDefaultProvider({ key: "" });
  assert.equal(defaultProvider().hasKey, false);
  assert.deepEqual(aiEnvFor(getAppProject(pid)!), {});
  // model/baseUrl validation errors pass through
  assert.equal((setDefaultProvider({ model: "bad model!" }) as { error: string }).error, "model_invalid");
  assert.equal((setProjectAi(pid, { dailyTokenCap: 5 }) as { error: string }).error, "cap_out_of_range");
  const capped = setProjectAi(pid, { dailyTokenCap: 50_000 }) as { config: { dailyTokenCap: number | null } };
  assert.equal(capped.config.dailyTokenCap, 50_000);
  setDefaultProvider({ key: "sk-localcloud-second-key-654321" });
  assert.equal(aiEnvFor(getAppProject(pid)!).AI_DAILY_TOKEN_CAP, "50000");
  void DEFAULT_KEY_NAME;
});
