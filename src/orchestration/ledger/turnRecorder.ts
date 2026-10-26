/**
 * C1: turns the worker's AgentEvent stream into TurnRecords. Hooked into the
 * `emit` wrapper of runWorker (agent/orchestrator.ts). A Loam "step"
 * event (events.ts) starts each model turn, so a record closes when the
 * next step starts or the worker ends.
 */
import { createHash } from "node:crypto";
import type { TurnRecord } from "./stuckPatterns.js";

/** The AgentEvent members the recorder reads (shapes OBSERVED in events.ts). */
export type RecordableEvent =
  | { type: "step"; index: number }
  | { type: "assistant_message"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; ok: boolean; summary: string; content?: string }
  | { type: "compaction"; emergency?: boolean; blocked?: boolean; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/** Stable JSON: object keys sorted so {a,b} and {b,a} give one signature. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export function createTurnRecorder(onTurn: (t: TurnRecord) => void) {
  let cur: TurnRecord | undefined;
  const close = () => {
    if (cur && (cur.actions.length || cur.text || cur.contextOverflow)) onTurn(cur);
    cur = undefined;
  };
  const open = (): TurnRecord => (cur ??= { actions: [], observations: [], text: "" });
  return {
    push(e: RecordableEvent): void {
      if (e.type === "step") {
        close();
        open();
        return;
      }
      if (e.type === "tool_call") open().actions.push(`${String(e.name)}:${stableJson(e.args)}`.slice(0, 2000));
      else if (e.type === "tool_result") {
        const body = typeof e.content === "string" ? e.content : String(e.summary ?? "");
        open().observations.push(e.ok ? `ok:${createHash("sha256").update(body.slice(0, 2000)).digest("hex").slice(0, 16)}` : `err:${body.slice(0, 200)}`);
      } else if (e.type === "assistant_message") open().text = String(e.text ?? "").trim().slice(0, 2000);
      // events.ts: an emergency or blocked compaction means the context could not be brought under budget.
      else if (e.type === "compaction" && (e.emergency === true || e.blocked === true)) open().contextOverflow = true;
    },
    end: close,
  };
}

/** Compact digest of the last turns for the ledger prompt (newest last, <= maxChars). */
export function digestTurns(turns: readonly TurnRecord[], maxChars: number): string {
  const lines = turns.map((t, i) => {
    const acts = t.actions.map((a, j) => `${a.slice(0, 160)} -> ${(t.observations[j] ?? "?").slice(0, 120)}`).join("; ");
    return `${i + 1}. ${acts || "(no tool)"}${t.text ? ` | said: ${t.text.slice(0, 200)}` : ""}`;
  });
  let out = lines.join("\n");
  while (out.length > maxChars && lines.length > 1) {
    lines.shift();
    out = `[earlier turns dropped]\n${lines.join("\n")}`;
  }
  return out.slice(-maxChars);
}
