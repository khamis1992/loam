import type { CoreBlocks, CoreEdit, CoreEditResult } from "./types.js";
import type { RecallRepo } from "./repo.js";
import { newId } from "./vectors.js";

export function readCore(repo: RecallRepo, scope: string, limits: { user: number; environment: number }): CoreBlocks {
  return {
    user: repo.coreGet(scope, "user"),
    environment: repo.coreGet(scope, "environment"),
    limits,
  };
}

export function editCore(repo: RecallRepo, op: CoreEdit, limits: { user: number; environment: number }, now = Date.now()): CoreEditResult {
  const limit = op.block === "user" ? limits.user : limits.environment;
  const current = repo.coreGet(op.scope, op.block);
  let next = [...current];
  if (op.op === "add") {
    next = [...current, op.text];
  } else if (op.op === "replace") {
    const index = current.findIndex((entry) => entry.includes(op.match));
    if (index < 0) return { ok: false, reason: "no_match", current };
    next[index] = op.text;
  } else {
    const index = current.findIndex((entry) => entry.includes(op.match));
    if (index < 0) return { ok: false, reason: "no_match", current };
    next.splice(index, 1);
  }
  if (next.join("\n").length > limit) return { ok: false, reason: "overflow", current };
  repo.coreSet(op.scope, op.block, next, { id: newId("core_"), op: op.op, before: current, after: next, at: now });
  return { ok: true };
}

export function rollbackCore(repo: RecallRepo, historyId: string, now = Date.now()): void {
  const row = repo.coreHistory(historyId);
  if (!row) throw new Error("core history not found");
  repo.coreSet(row.scope, row.block, row.before, { id: newId("core_"), op: "rollback", before: repo.coreGet(row.scope, row.block), after: row.before, at: now });
}
