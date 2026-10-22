import crypto from "node:crypto";
import { database, transaction } from "./sqliteStore.js";
import { getAgent, updateAgent } from "./agents.js";

export type InstructionSource = "user" | "agent";
export type InstructionStatus = "proposed" | "approved" | "rejected";

export interface InstructionVersion {
  id: string;
  agentId: string;
  version: number;
  instructions: string;
  source: InstructionSource;
  status: InstructionStatus;
  diff: string;
  createdAt: string;
  decidedAt?: string;
}

export interface InstructionProposal {
  id: string;
  agentId: string;
  version: number;
  instructions: string;
  diff: string;
  createdAt: string;
  reason: string;
}

function newId(): string {
  return `ins_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function ensureTable(): void {
  const db = database();
  db.exec(`CREATE TABLE IF NOT EXISTS instruction_versions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    instructions TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('user','agent')),
    status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected')),
    reason TEXT NOT NULL DEFAULT '',
    diff TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_instruction_agent ON instruction_versions(agent_id, version);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_instruction_agent_status ON instruction_versions(agent_id, status);`);
}

ensureTable();

interface InstructionRow {
  id: string;
  agent_id: string;
  version: number;
  instructions: string;
  source: string;
  status: string;
  reason: string;
  diff: string;
  created_at: string;
  decided_at?: unknown;
}

function rowToVersion(row: Record<string, unknown>): InstructionVersion {
  const decidedAt = row.decided_at;
  const source = row.source === "user" ? "user" : "agent";
  const status = row.status === "proposed" ? "proposed" : row.status === "rejected" ? "rejected" : "approved";
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    version: Number(row.version),
    instructions: String(row.instructions),
    source,
    status,
    diff: String(row.diff),
    createdAt: String(row.created_at),
    ...(decidedAt && typeof decidedAt === "string" ? { decidedAt } : {}),
  };
}

const COLUMNS = "id, agent_id, version, instructions, source, status, reason, diff, created_at, decided_at";

function insertRow(input: {
  id: string;
  agentId: string;
  version: number;
  instructions: string;
  source: InstructionSource;
  status: InstructionStatus;
  reason: string;
  diff: string;
  createdAt: string;
}): void {
  database()
    .prepare(
      `INSERT INTO instruction_versions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.agentId,
      input.version,
      input.instructions,
      input.source,
      input.status,
      input.reason,
      input.diff,
      input.createdAt,
      input.status === "approved" ? input.createdAt : null,
    );
}

function nextVersion(agentId: string): number {
  const row = database()
    .prepare("SELECT MAX(version) AS max FROM instruction_versions WHERE agent_id = ?")
    .get(agentId) as { max?: unknown } | undefined;
  const max = row?.max;
  return typeof max === "number" && Number.isFinite(max) ? max + 1 : 1;
}

// Original line-based unified diff: split on newlines, group changed ops into
// hunks merged when their unchanged gap is small, and emit standard headers
// with up to CONTEXT_LINES unchanged lines of surrounding context.
const CONTEXT_LINES = 3;
const MERGE_GAP = CONTEXT_LINES * 2;

type DiffOp = { kind: "same" | "del" | "add"; line: string };

function diffOps(a: string[], b: string[]): DiffOp[] {
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const rowNext = lcs[i + 1]!;
    const row = lcs[i]!;
    for (let j = n - 1; j >= 0; j--) {
      const match = rowNext[j + 1]! + 1;
      row[j] = a[i]! === b[j]! ? match : Math.max(rowNext[j]!, row[j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i]! === b[j]!) {
      ops.push({ kind: "same", line: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "del", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j]! });
      j++;
    }
  }
  while (i < m) {
    ops.push({ kind: "del", line: a[i]! });
    i++;
  }
  while (j < n) {
    ops.push({ kind: "add", line: b[j]! });
    j++;
  }
  return ops;
}

interface DiffHunk {
  from: number;
  to: number;
  aStart: number;
  aLines: number;
  bStart: number;
  bLines: number;
}

function buildHunks(ops: DiffOp[]): DiffHunk[] {
  const changed = ops.map((op, idx) => (op.kind === "same" ? -1 : idx)).filter((idx) => idx >= 0);
  if (changed.length === 0) return [];
  const groups: Array<[number, number]> = [];
  let start = changed[0] as number;
  let end = start;
  for (let k = 1; k < changed.length; k++) {
    const idx = changed[k] as number;
    if (idx - end <= MERGE_GAP) {
      end = idx;
    } else {
      groups.push([start, end]);
      start = idx;
      end = start;
    }
  }
  groups.push([start, end]);

  return groups.map(([firstChanged, lastChanged]) => {
    const from = Math.max(0, firstChanged - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, lastChanged + CONTEXT_LINES);
    let aBefore = 0;
    let bBefore = 0;
    let aLines = 0;
    let bLines = 0;
    for (let k = 0; k < to; k++) {
      const op = ops[k] as DiffOp;
      if (k < from) {
        if (op.kind !== "add") aBefore++;
        if (op.kind !== "del") bBefore++;
        continue;
      }
      if (op.kind !== "add") aLines++;
      if (op.kind !== "del") bLines++;
    }
    return { from, to, aStart: aBefore + 1, aLines, bStart: bBefore + 1, bLines };
  });
}

export function makeUnifiedDiff(oldText: string, newText: string): string {
  if ((oldText || "") === (newText || "")) return "";
  const ops = diffOps((oldText || "").split("\n"), (newText || "").split("\n"));
  const hunks = buildHunks(ops);
  if (hunks.length === 0) return "";
  const lines: string[] = [`--- a/old`, `+++ b/new`];
  for (const hunk of hunks) {
    const aRange = hunk.aLines === 1 ? `${hunk.aStart}` : `${hunk.aStart},${hunk.aLines}`;
    const bRange = hunk.bLines === 1 ? `${hunk.bStart}` : `${hunk.bStart},${hunk.bLines}`;
    lines.push(`@@ -${aRange} +${bRange} @@`);
    for (let k = hunk.from; k <= hunk.to; k++) {
      const op = ops[k] as DiffOp;
      const prefix = op.kind === "same" ? " " : op.kind === "del" ? "-" : "+";
      lines.push(`${prefix}${op.line}`);
    }
  }
  return lines.join("\n");
}

function requireAgent(agentId: string): void {
  if (!getAgent(agentId)) throw new Error(`agent not found: ${agentId}`);
}

export function proposeInstructions(agentId: string, newText: string, reason = ""): InstructionProposal {
  requireAgent(agentId);
  const agent = getAgent(agentId);
  const oldText = agent?.instructions ?? "";
  const now = new Date().toISOString();
  const id = newId();
  const version = nextVersion(agentId);
  const diff = makeUnifiedDiff(oldText, newText);
  insertRow({
    id,
    agentId,
    version,
    instructions: newText,
    source: "agent",
    status: "proposed",
    reason,
    diff,
    createdAt: now,
  });
  return { id, agentId, version, instructions: newText, diff, createdAt: now, reason };
}

export function approveProposal(id: string): InstructionVersion | undefined {
  return transaction(() => {
    const db = database();
    const row = db
      .prepare(`SELECT ${COLUMNS} FROM instruction_versions WHERE id = ? AND status = 'proposed'`)
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const applied = updateAgent(String(row.agent_id), { instructions: String(row.instructions) });
    if (!applied) return undefined;
    db.prepare("UPDATE instruction_versions SET status = 'approved', decided_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    const updated = db.prepare(`SELECT ${COLUMNS} FROM instruction_versions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return updated ? rowToVersion(updated) : undefined;
  });
}

export function rejectProposal(id: string): InstructionVersion | undefined {
  return transaction(() => {
    const db = database();
    const result = db
      .prepare("UPDATE instruction_versions SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'proposed'")
      .run(new Date().toISOString(), id);
    if (Number(result.changes) === 0) return undefined;
    const row = db.prepare(`SELECT ${COLUMNS} FROM instruction_versions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToVersion(row) : undefined;
  });
}

export function listProposals(agentId: string, status: "proposed"): InstructionVersion[];
export function listProposals(agentId: string, status?: "proposed"): InstructionVersion[] {
  const db = database();
  if (status === "proposed") {
    const rows = db
      .prepare(`SELECT ${COLUMNS} FROM instruction_versions WHERE agent_id = ? AND status = 'proposed' ORDER BY created_at DESC`)
      .all(agentId) as Record<string, unknown>[];
    return rows.map(rowToVersion);
  }
  return listVersions(agentId);
}

export function listVersions(agentId: string): InstructionVersion[] {
  const rows = database()
    .prepare(`SELECT ${COLUMNS} FROM instruction_versions WHERE agent_id = ? ORDER BY created_at DESC, version DESC`)
    .all(agentId) as Record<string, unknown>[];
  return rows.map(rowToVersion);
}

export function recordUserEdit(agentId: string, oldText: string, newText: string): InstructionVersion {
  requireAgent(agentId);
  const now = new Date().toISOString();
  const id = newId();
  const version = nextVersion(agentId);
  const diff = makeUnifiedDiff(oldText, newText);
  insertRow({
    id,
    agentId,
    version,
    instructions: newText,
    source: "user",
    status: "approved",
    reason: "",
    diff,
    createdAt: now,
  });
  const row = database().prepare(`SELECT ${COLUMNS} FROM instruction_versions WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error("recordUserEdit failed to persist version");
  return rowToVersion(row);
}
