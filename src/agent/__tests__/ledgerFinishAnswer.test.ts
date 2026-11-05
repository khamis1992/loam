import test from "node:test";
import assert from "node:assert/strict";
import { answerAfterLedgerFinish } from "../orchestrator.js";

test("ledger finish keeps the worker answer when one exists", () => {
  assert.equal(answerAfterLedgerFinish("  العرض جاهز  ", "ignored"), "العرض جاهز");
});

test("ledger finish uses the ledger reason when the worker was aborted with no text", () => {
  const reason = "One Arabic slide was exported to deliverables/qatar-one-slide.pptx";
  assert.equal(answerAfterLedgerFinish("", reason), reason);
  assert.equal(answerAfterLedgerFinish("   ", `  ${reason}  `), reason);
});

test("ledger finish does not invent an answer when both sides are empty", () => {
  assert.equal(answerAfterLedgerFinish("  ", " "), "");
});
