/**
 * C11: the seven Loam-internal tools of a worker. They are bound per worker by closure
 * (ToolContext, src/tools/registry.ts, has no worker or run id) and are never put in
 * the global registry (src/setup/runtime.ts is not edited).
 *
 * Mid-turn delivery: every result gets a "NEW SINCE YOUR LAST READ" block with the
 * worker's undelivered direct messages and new peer gists, then marks them delivered.
 * This is the same mechanism as Agensh's notice shim on infrastructure tool calls
 * (arXiv App. B.2): no model is interrupted, delivery rides the next tool result.
 */
import type { Tool, ToolResult } from "../../tools/registry.js";
import type { CoordinationDb } from "./board.js";
import type { MergeOutcome } from "./workspace.js";
import { BOARD_NOTE_TYPES, BOARD_TOOL_NAMES, MAX_CONTENT_CHARS } from "./types.js";
import { normalizeWorkLabel } from "./admission.js";

export interface BoardToolBinding {
  db: CoordinationDb;
  runId: string;
  workerId: string;
  /** TTL applied to this worker's CLAIMs (the run's claimTtlSeconds). */
  claimTtlSeconds?: number;
  /** Engine merge of worker/<id>/<label> into main (serialized per run). */
  requestMerge(label: string): Promise<MergeOutcome & { selection?: string }>;
  /** Engine branch switch after an admitted CLAIM; returns a one-line note for the worker. */
  onClaim(label: string): Promise<string>;
  /** Counts gists written in the current turn (forced-write rule). */
  onGist?(type: string): void;
}

export const DELIVERY_HEADER = "=== NEW SINCE YOUR LAST READ ===";

export function deliveryBlock(db: CoordinationDb, workerId: string): string {
  const dms = db.drainDirect(workerId);
  const gists = db.drainNewGists(workerId);
  if (!dms.length && !gists.length) return "";
  const out = [DELIVERY_HEADER];
  for (const m of dms) out.push(`[DM from ${m.from}] ${m.body}`);
  for (const g of gists) out.push(`[${g.label} ${g.thread_id}/${g.type}${g.work_label ? ` ${g.work_label}` : ""}] ${g.content}`);
  return out.join("\n");
}

function withDelivery(b: BoardToolBinding, r: ToolResult): ToolResult {
  const block = deliveryBlock(b.db, b.workerId);
  return block ? { ...r, content: `${r.content}\n\n${block}` } : r;
}

const s = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

export function createBoardTools(b: BoardToolBinding): Tool[] {
  const tools: Tool[] = [
    {
      name: "board_write",
      description: `Publish a short typed note on the shared board. Types: ${BOARD_NOTE_TYPES.join(", ")}. Write a CLAIM with a work_label before starting a sub-task; a PATCH_SUMMARY must be "files=... | idea=... | evidence=<passing command>".`,
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...BOARD_NOTE_TYPES] },
          content: { type: "string", description: `at most ${MAX_CONTENT_CHARS} characters (300 for PATCH_SUMMARY)` },
          work_label: { type: "string", description: "short slug of your sub-task" },
          detail: { type: "string", description: "optional long form, read with board_unfold" },
        },
        required: ["type", "content"],
      },
      async run(args) {
        const type = s(args.type).toUpperCase();
        const label = normalizeWorkLabel(s(args.work_label));
        if ((type === "CLAIM" || type === "PATCH_SUMMARY") && !label) return withDelivery(b, { ok: false, content: `${type} needs a work_label (a short slug).` });
        const r = b.db.boardWrite({ thread_id: b.workerId, type, content: s(args.content), work_label: label || undefined, detail: s(args.detail) || undefined, ...(type === "CLAIM" && b.claimTtlSeconds ? { ttl_seconds: b.claimTtlSeconds } : {}) });
        if (r.status === "rejected") return withDelivery(b, { ok: false, content: `rejected (${r.reason}). A PATCH_SUMMARY needs evidence= naming a command that passed.` });
        b.onGist?.(type);
        const lines = [`admitted as ${r.label}`];
        if (r.overlap) lines.push(`notice: peer ${r.overlap.holder} already holds an overlapping claim ${r.overlap.label}${r.overlap.work_label ? ` (${r.overlap.work_label})` : ""}; pick a different angle or message them.`);
        if (type === "CLAIM") lines.push(await b.onClaim(label));
        return withDelivery(b, { ok: true, content: lines.join("\n") });
      },
    },
    {
      name: "board_read",
      description: "Read the live shared board: open claims, patch summaries and shared lessons.",
      parameters: { type: "object", properties: {} },
      async run() {
        const r = b.db.boardRead();
        b.db.markBoardSeen(b.workerId);
        return withDelivery(b, { ok: true, content: r.rendered });
      },
    },
    {
      name: "board_grep",
      description: "Search the full board history (expired claims included). words: a&b|c means (a and b) or c.",
      parameters: { type: "object", properties: { words: { type: "string" }, types: { type: "string" }, limit: { type: "number", maximum: 500 } } },
      async run(args) {
        const hits = b.db.boardGrep(s(args.words), s(args.types), typeof args.limit === "number" ? args.limit : 100);
        const text = hits.length ? hits.map((e) => `[${e.label} ${e.thread_id}/${e.type}${e.work_label ? ` ${e.work_label}` : ""}] ${e.content}${e.has_detail ? " (+detail)" : ""}`).join("\n") : "(no match)";
        return withDelivery(b, { ok: true, content: text });
      },
    },
    {
      name: "board_unfold",
      description: "Return the long-form detail behind board labels such as G12.",
      parameters: { type: "object", properties: { labels: { type: "array", items: { type: "string" } } }, required: ["labels"] },
      async run(args) {
        const labels = Array.isArray(args.labels) ? args.labels.map(s) : [];
        const d = b.db.boardUnfold(labels);
        return withDelivery(b, { ok: true, content: d.map((x) => `${x.label}: ${x.detail ?? "(no detail)"}`).join("\n\n") || "(no labels)" });
      },
    },
    {
      name: "swarm_message",
      description: "Message the team channel (omit `to`) or one peer (to = worker id such as w2). Direct messages reach the peer during its current turn.",
      parameters: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["body"] },
      async run(args) {
        const to = s(args.to).trim() || null;
        if (to === b.workerId) return withDelivery(b, { ok: false, content: "you cannot message yourself" });
        const m = b.db.sendMessage({ from: b.workerId, to, body: s(args.body) });
        return withDelivery(b, { ok: true, content: `sent #${m.id} to ${to ?? "team channel"}` });
      },
    },
    {
      name: "swarm_inbox",
      description: "Read your undelivered direct messages and new team-channel messages.",
      parameters: { type: "object", properties: {} },
      async run() {
        const ch = b.db.drainChannel(b.workerId);
        const text = ch.length ? ch.map((m) => `[channel ${m.from}] ${m.body}`).join("\n") : "(no new channel messages)";
        return withDelivery(b, { ok: true, content: text });
      },
    },
    {
      name: "merge_request",
      description: "Ask the engine to merge your branch worker/<you>/<work_label> into main. Commit first. Returns merged (with the changed-file count), noop, or conflict (with the files).",
      parameters: { type: "object", properties: { work_label: { type: "string" } }, required: ["work_label"] },
      async run(args) {
        const label = normalizeWorkLabel(s(args.work_label));
        if (!label) return withDelivery(b, { ok: false, content: "work_label required" });
        const m = await b.requestMerge(label);
        const text =
          m.status === "merged" ? `merged ${m.branch} into main: ${m.changedFiles.length} changed files (commit ${m.commit?.slice(0, 10) ?? "?"})`
          : m.status === "noop" ? `nothing to merge: ${m.detail}`
          : m.status === "conflict" ? `conflict: ${m.conflicts.join(", ")}. Merge main into your branch, resolve, re-verify, commit, retry.`
          : `merge not done: ${m.detail}`;
        return withDelivery(b, { ok: m.status === "merged" || m.status === "noop", content: m.selection ? `${text}\n${m.selection}` : text });
      },
    },
  ];
  if (tools.map((t) => t.name).join() !== BOARD_TOOL_NAMES.join()) throw new Error("board tool list out of sync");
  return tools;
}
