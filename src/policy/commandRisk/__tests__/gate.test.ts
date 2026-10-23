/**
 * Gate tests.
 *
 * Adapted from jcode (MIT) ref/command-risk/src/gate_tests.rs
 * jcode: https://github.com/1jehuang/jcode — Copyright (c) 2025 Jeremy Huang.
 *
 * The central property: a blind retry must not satisfy the gate. That is what
 * separates this from a "run it twice" speed bump an agent defeats reflexively.
 */

import test from "node:test";
import assert from "node:assert";
import { assess, type RiskContext } from "../lib.js";
import { gate, isSubstantive, type GateOutcome, type Justification } from "../gate.js";

function ctx(): RiskContext {
  return {
    scratchDir: undefined,
    workingDir: "/home/u/proj",
    homeDir: "/home/u",
  };
}

function none(): Justification {
  return {};
}

function saying(text: string): Justification {
  return { text };
}

test("safe commands pass straight through", () => {
  assert.deepEqual(gate(assess("ls -la", ctx()), none()), { kind: "Allow" });
});

test("in-project cleanup is not interrupted", () => {
  assert.deepEqual(gate(assess("rm -rf target", ctx()), none()), { kind: "Allow" });
});

test("catastrophic is denied even with a perfect justification", () => {
  const elaborate = saying(
    "The user explicitly asked me to wipe their entire home directory because they are decommissioning this machine today.",
  );
  const outcome = gate(assess("rm -rf ~", ctx()), elaborate);
  assert.equal(outcome.kind, "Deny");
  if (outcome.kind === "Deny") {
    assert.ok(outcome.reason.includes("cannot be confirmed"), outcome.reason);
  }
});

test("first attempt at a risky command is refused with a reflection prompt", () => {
  const outcome = gate(assess("rm -rf $TARGET", ctx()), none());
  assert.equal(outcome.kind, "Reflect");
  if (outcome.kind === "Reflect") {
    // The prompt must point at the user's request, not at generic caution.
    assert.ok(outcome.prompt.includes("user's actual"), outcome.prompt);
    assert.ok(outcome.prompt.includes("justification"), outcome.prompt);
    assert.ok(outcome.prompt.includes("ask the user"), outcome.prompt);
  }
});

test("a blind retry does not satisfy the gate", () => {
  // This is the property that makes it more than a speed bump: repeating the
  // identical call, with no added reasoning, fails exactly as before.
  const assessment = assess("rm -rf $TARGET", ctx());
  const first = gate(assessment, none());
  const second = gate(assessment, none());
  assert.deepEqual(first, second);
  assert.equal(second.kind, "Reflect");
});

test("empty affirmations are rejected", () => {
  // "yes" carries no information about what the user wanted.
  const assessment = assess("rm -rf $TARGET", ctx());
  for (const token of ["yes", "ok", "confirmed", "proceed.", "Go ahead!", "y", ""]) {
    const outcome = gate(assessment, saying(token));
    assert.equal(outcome.kind, "Reflect", `"${token}" must not unlock the gate`);
  }
});

test("a substantive justification allows the command", () => {
  const reason = saying(
    "The user asked in their last message to delete the old other-project checkout since they have re-cloned it elsewhere.",
  );
  assert.deepEqual(gate(assess("rm -rf $TARGET", ctx()), reason), { kind: "Allow" });
});

test("justification substance check is a low but real bar", () => {
  assert.equal(isSubstantive({}), false);
  assert.equal(isSubstantive(saying("   ")), false);
  assert.equal(isSubstantive(saying("sure")), false);
  assert.equal(isSubstantive(saying("too short")), false);
  assert.equal(
    isSubstantive(saying("user asked to remove the stale build output in ~/old-builds")),
    true,
  );
});

test("reflection prompt names the specific path", () => {
  const outcome = gate(assess("rm -rf $TARGET", ctx()), none());
  assert.equal(outcome.kind, "Reflect");
  if (outcome.kind === "Reflect") {
    assert.ok(
      outcome.prompt.includes("$TARGET"),
      "the model needs to see what it was about to destroy",
    );
  }
});

test("low findings still allow", () => {
  const outcome: GateOutcome = gate(assess("rm -rf /home/u/other-project", ctx()), none());
  assert.deepEqual(outcome, { kind: "Allow" });
});
