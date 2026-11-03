import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStuck, type TurnRecord } from "../ledger/stuckPatterns.js";
import { applyLedger, EMPTY_LEDGER, runLedgerTurn, type LedgerEntry } from "../ledger/progressLedger.js";
import { createLedgerController } from "../ledger/controller.js";
import { ORCHESTRATION_DEFAULTS } from "../config.js";
import type { OrchestrationEvent } from "../events.js";
import { scriptedPort } from "./helpers.js";

const turn = (a: string, o: string, text = ""): TurnRecord => ({ actions: a ? [a] : [], observations: o ? [o] : [], text });

test("detectStuck finds each pattern at its threshold and not before", () => {
  const same = turn('read_file:{"p":"a"}', "ok:1");
  assert.equal(detectStuck([same, same, same]), undefined);
  assert.equal(detectStuck([same, same, same, same])?.pattern, "repeat_action_observation");
  const err = turn('shell:{"c":"npm test"}', "err:EADDRINUSE");
  assert.equal(detectStuck([err, err])?.pattern, undefined);
  assert.equal(detectStuck([err, err, err])?.pattern, "repeat_action_error");
  const talk = turn("", "", "I will now fix it.");
  assert.equal(detectStuck([talk, talk, talk])?.pattern, "monologue");
  const a = turn("x:{}", "ok:a");
  const b = turn("y:{}", "ok:b");
  assert.equal(detectStuck([a, b, a, b, a])?.pattern, undefined);
  assert.equal(detectStuck([a, b, a, b, a, b])?.pattern, "alternating");
  const ctx: TurnRecord = { ...a, contextOverflow: true };
  assert.equal(detectStuck([ctx, ctx])?.pattern, "context_loop");
  assert.equal(detectStuck([a, b, turn("z:{}", "ok:c")]), undefined);
});

const entry = (progressing: boolean, inLoop = false, satisfied = false, next = "s1"): LedgerEntry => ({
  satisfied: { value: satisfied, reason: satisfied ? "all done" : "not yet" },
  inLoop: { value: inLoop, reason: inLoop ? "same call" : "no" },
  progressing: { value: progressing, reason: progressing ? "new file" : "nothing new" },
  nextStepId: next,
  instruction: "run the tests",
});

test("applyLedger: +1 on stall, -1 on progress, reset after limit, escalate after resets", () => {
  const lim = { maxStallCount: 2, maxResets: 1 };
  let st = EMPTY_LEDGER;
  let r = applyLedger(st, entry(false), lim);
  assert.equal(r.state.stallCount, 1);
  r = applyLedger(r.state, entry(true), lim);
  assert.equal(r.state.stallCount, 0);
  st = r.state;
  for (let i = 0; i < 2; i++) st = applyLedger(st, entry(false, true), lim).state;
  r = applyLedger(st, entry(false), lim);
  assert.equal(r.decision, "replan");
  assert.equal(r.state.resetCount, 1);
  assert.equal(r.state.stallCount, 0);
  st = r.state;
  for (let i = 0; i < 2; i++) st = applyLedger(st, entry(false), lim).state;
  assert.equal(applyLedger(st, entry(false), lim).decision, "escalate");
  assert.equal(applyLedger(EMPTY_LEDGER, entry(true, false, true), lim).decision, "finish");
  assert.equal(applyLedger(EMPTY_LEDGER, entry(true, false, false, "replan"), lim).decision, "replan");
});

const ctx = { goal: "Fix the failing test", planSteps: [{ id: "s1", title: "find cause", status: "doing" }], recentDigest: "shell npm test -> EADDRINUSE" };

test("runLedgerTurn refreshes the fact sheet only on a reset", async () => {
  const stalled = JSON.stringify(entry(false, true));
  const port = scriptedPort([stalled, JSON.stringify({ facts: ["port 3000 is taken"], guesses: [] })]);
  const st = { ...EMPTY_LEDGER, stallCount: 3 };
  const out = await runLedgerTurn({ port, model: "gpt-oss:120b:cloud", ctx, state: st, limits: { maxStallCount: 3, maxResets: 2 }, maxChars: 6000, repairAttempts: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.decision, "replan");
  assert.deepEqual(out.ok && out.state.facts, ["port 3000 is taken"]);
  assert.equal(port.calls.length, 2);
  assert.equal(out.ok && out.tokens, 240);
});

test("runLedgerTurn maps an unknown nextStepId to replan and never throws on garbage", async () => {
  const port = scriptedPort([JSON.stringify(entry(true, false, false, "nope"))]);
  const out = await runLedgerTurn({ port, model: "m:cloud", ctx, state: EMPTY_LEDGER, limits: { maxStallCount: 3, maxResets: 2 }, maxChars: 6000, repairAttempts: 0 });
  assert.equal(out.ok && out.decision, "replan");
  const bad = await runLedgerTurn({ port: scriptedPort(["???"]), model: "m:cloud", ctx, state: EMPTY_LEDGER, limits: { maxStallCount: 3, maxResets: 2 }, maxChars: 6000, repairAttempts: 0 });
  assert.equal(bad.ok, false);
});

test("controller: calls the model only every N turns or on a stuck pattern", async () => {
  const events: OrchestrationEvent[] = [];
  const port = scriptedPort([JSON.stringify(entry(true)), JSON.stringify(entry(true))]);
  const c = createLedgerController({ cfg: ORCHESTRATION_DEFAULTS, repairAttempts: 1, port, model: "m:cloud", emit: (e) => events.push(e), context: () => ctx });
  await c.observe(turn("a:{}", "ok:1"));
  await c.observe(turn("b:{}", "ok:2"));
  assert.equal(port.calls.length, 0);
  const third = await c.observe(turn("c:{}", "ok:3"));
  assert.equal(port.calls.length, 1);
  assert.equal(third.decision, "continue");
  assert.equal(third.instruction, "run the tests");
  const err = turn('shell:{"c":"x"}', "err:boom");
  await c.observe(err);
  await c.observe(err);
  await c.observe(err);
  assert.equal(port.calls.length, 2, "stuck pattern forced an early ledger call");
  assert.ok(events.some((e) => e.type === "stall_detected"));
  assert.ok(events.some((e) => e.type === "ledger"));
});

test("controller without a cloud model degrades to syntactic checks and still escalates", async () => {
  const events: OrchestrationEvent[] = [];
  const cfg = { ...ORCHESTRATION_DEFAULTS, ledger: { ...ORCHESTRATION_DEFAULTS.ledger, maxStallCount: 1, maxResets: 1 } };
  const c = createLedgerController({ cfg, repairAttempts: 1, port: scriptedPort([]), model: undefined, emit: (e) => events.push(e), context: () => ctx });
  const err = turn('shell:{"c":"x"}', "err:boom");
  const decisions: string[] = [];
  for (let i = 0; i < 8; i++) decisions.push((await c.observe(err)).decision);
  assert.ok(decisions.includes("replan"));
  assert.equal(decisions.at(-1), "escalate");
  assert.equal(events.filter((e) => e.type === "core_degraded").length, 1);
});

import { createTurnRecorder, digestTurns, stableJson } from "../ledger/turnRecorder.js";

test("turn recorder builds one record per model step with stable signatures", () => {
  const out: TurnRecord[] = [];
  const r = createTurnRecorder((t) => out.push(t));
  r.push({ type: "step", index: 1 });
  r.push({ type: "tool_call", name: "read_file", args: { b: 1, a: 2 } });
  r.push({ type: "tool_result", name: "read_file", ok: true, summary: "s", content: "body" });
  r.push({ type: "step", index: 2 });
  r.push({ type: "tool_call", name: "read_file", args: { a: 2, b: 1 } });
  r.push({ type: "tool_result", name: "read_file", ok: true, summary: "s", content: "body" });
  r.push({ type: "step", index: 3 });
  r.push({ type: "assistant_message", text: "done" });
  r.end();
  assert.equal(out.length, 3);
  assert.equal(out[0]?.actions[0], out[1]?.actions[0]);
  assert.equal(out[0]?.observations[0], out[1]?.observations[0]);
  assert.equal(out[2]?.text, "done");
  assert.equal(stableJson({ z: [1, { y: 2, x: 1 }] }), '{"z":[1,{"x":1,"y":2}]}');
  assert.ok(digestTurns(out, 60).length <= 60);
});

test("emergency or blocked compactions mark context overflow", () => {
  const out: TurnRecord[] = [];
  const r = createTurnRecorder((t) => out.push(t));
  r.push({ type: "step", index: 1 });
  r.push({ type: "compaction", step: 3, emergency: true });
  r.push({ type: "step", index: 2 });
  r.push({ type: "compaction", step: 1, blocked: true });
  r.end();
  assert.equal(detectStuck(out)?.pattern, "context_loop");
});
