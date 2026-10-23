/**
 * Model-edit audit log (C17).
 *
 * Records which model produced each workspace edit, so the routing decision is
 * observable after the fact: "model X handled the edit to path P at step N".
 * Records are appended to `data/model-edits.jsonl` and kept in a bounded
 * in-process ring for the current session. No file contents, arguments or
 * credentials are stored — only tool name, target path, model id and outcome.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { log } from "../log.js";

/** Tools that write to the workspace (registered file tools + code_session). */
export const EDIT_MODEL_TOOLS = new Set([
  "file_edit",
  "file_write",
  "file_move",
  "file_delete",
  "file_multi_edit",
  "code_session",
]);

export function isEditTool(name: string): boolean {
  return EDIT_MODEL_TOOLS.has(name);
}

export interface EditModelRecord {
  at: string;
  taskId?: string;
  step: number;
  model: string;
  tool: string;
  path?: string;
  ok: boolean;
}

export interface RecordEditModelInput {
  taskId?: string;
  step: number;
  model: string;
  tool: string;
  path?: string;
  ok: boolean;
  /** Test/override hook: where to append. Defaults to data/model-edits.jsonl. */
  file?: string;
}

const MAX_MEMORY = 500;
const memory: EditModelRecord[] = [];

function defaultFile(): string {
  return path.join(DATA_DIR, "model-edits.jsonl");
}

/** Append one edit record to the audit log and the in-process ring. */
export function recordEditModel(input: RecordEditModelInput): EditModelRecord | null {
  if (!isEditTool(input.tool)) return null;
  const record: EditModelRecord = {
    at: new Date().toISOString(),
    step: input.step,
    model: input.model,
    tool: input.tool,
    ok: input.ok,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.path ? { path: input.path } : {}),
  };
  memory.push(record);
  if (memory.length > MAX_MEMORY) memory.shift();
  const file = input.file ?? defaultFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    log.warn(`[model-audit] failed to persist edit record: ${String(err)}`);
  }
  log.info("model_edit", { model: record.model, tool: record.tool, path: record.path ?? "", ok: record.ok });
  return record;
}

/** Most recent records, newest last. */
export function recentEditModels(limit = MAX_MEMORY): EditModelRecord[] {
  return memory.slice(-Math.max(0, limit));
}

/** How many edits each model handled. */
export function editModelCounts(records: EditModelRecord[] = memory): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) out[r.model] = (out[r.model] ?? 0) + 1;
  return out;
}

/** Clear the in-process ring (tests / a fresh run). The JSONL file is kept. */
export function resetEditModelMemory(): void {
  memory.length = 0;
}

/** Read records back from a JSONL audit file. */
export function readEditModelLog(file: string = defaultFile()): EditModelRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: EditModelRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as EditModelRecord);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}
