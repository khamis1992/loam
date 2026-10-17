import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../config.js";
import { log } from "../log.js";

export type PendingKind = "skill_create" | "skill_patch" | "skill_delete" | "skill_install" | "memory_store";

export interface PendingItem {
  id: string;
  at: string;
  kind: PendingKind;
  summary: string;
  payload: Record<string, unknown>;
}

/** Staging gate: when write-approval is on, mutating tools call stage() instead of applying. */
export interface WriteGate {
  stage(kind: PendingKind, summary: string, payload: Record<string, unknown>): PendingItem;
}

const FILE = path.join(DATA_DIR, "pending.json");
let items: PendingItem[] = [];

function save(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items }, null, 1), "utf8");
    fs.renameSync(tmp, FILE);
  } catch (err) {
    log.warn(`pending: save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function loadPending(): void {
  try {
    if (!fs.existsSync(FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8")) as { items?: PendingItem[] };
    items = parsed.items ?? [];
  } catch {
    items = [];
  }
}

export function listPending(): PendingItem[] {
  return [...items].sort((a, b) => b.at.localeCompare(a.at));
}

export function getPending(id: string): PendingItem | undefined {
  return items.find((i) => i.id === id);
}

export function addPending(kind: PendingKind, summary: string, payload: Record<string, unknown>): PendingItem {
  const item: PendingItem = {
    id: `pend_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
    at: new Date().toISOString(),
    kind,
    summary,
    payload,
  };
  items.push(item);
  if (items.length > 500) items = items.slice(-400);
  save();
  return item;
}

export function removePending(id: string): boolean {
  const before = items.length;
  items = items.filter((i) => i.id !== id);
  if (items.length !== before) save();
  return items.length < before;
}

export const writeGate: WriteGate = {
  stage: (kind, summary, payload) => addPending(kind, summary, payload),
};
