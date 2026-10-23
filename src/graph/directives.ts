/**
 * Neo N11: the canvas's editing directives.
 *
 * An edit made on the canvas is not an instruction to the agent: it is a *fact*
 * about the run the agent has not seen yet. The graph records the edit (a new
 * version, re-pointed edges, a branch, a merged group) and this module records
 * what the next step must therefore know, so the two never drift apart.
 *
 * A directive is **applied once**. The loop reads everything that is pending at
 * the start of a step, files it into the N5 artefact store (so it is part of the
 * same bounded, ranked context the run already selects from) and clears it. That
 * keeps an edited node in the prompt without pinning it there forever, which is
 * what the selector's own store bound is for.
 *
 * Storage is the existing `entities` table, one row per run, so a directive
 * survives a server restart exactly like the graph it belongs to.
 */
import { getEntity, putEntity, removeEntity } from "../server/sqliteStore.js";

/** Entity family for the per-run directive log. */
export const RUN_DIRECTIVE_ENTITY = "run_directive";

/** How a directive enters the next prompt. */
export type CanvasDirectiveMode = "follow-up" | "quote";

/** Why a directive was filed, so the prompt can word it correctly. */
export type CanvasDirectiveReason = "edited" | "cut" | "reconnect" | "duplicate" | "group" | "mode";

/** One canvas edit the agent has not yet been told about. */
export interface CanvasDirective {
  /** Stable id within the run. */
  id: string;
  /** The run the edit belongs to (also the owning task id). */
  run_id: string;
  /** Which node the user acted on. */
  nodeId: string;
  /** The node's human title, kept so a directive reads well without a graph read. */
  title: string;
  /** The corrected/produced text the model must see. */
  text: string;
  /** How the text enters the prompt. */
  mode: CanvasDirectiveMode;
  /** What happened to the node. */
  reason: CanvasDirectiveReason;
  /** Free-form detail the prompt can quote (what was cut, what was merged). */
  detail?: string;
  /** The node's version after the edit, so a stale directive can be told apart. */
  version?: number;
  /** Creation order within the run; the loop reads directives in this order. */
  seq: number;
  created: number;
}

/** The persisted per-run log. */
interface DirectiveRow {
  id: string;
  run_id: string;
  /** Next directive sequence number. */
  seq: number;
  items: CanvasDirective[];
}

/** A directive to append; the log owns its id, sequence and timestamp. */
export type NewDirective = Omit<CanvasDirective, "id" | "seq" | "created">;

/** Read one run's pending directives, oldest first. */
export function readDirectives(runId: string): CanvasDirective[] {
  return load(runId).items.map((item) => ({ ...item }));
}

/**
 * Read and clear one run's pending directives.
 *
 * This is the loop's once-per-step pull: a directive that has been handed to the
 * model is not handed to it again, so the run's own artefact store (bounded, and
 * ranked by relevance) decides how long it stays in the prompt.
 */
export function consumeDirectives(runId: string): CanvasDirective[] {
  const row = load(runId);
  if (row.items.length === 0) return [];
  const taken = row.items.map((item) => ({ ...item }));
  row.items = [];
  save(row);
  return taken;
}

/** Append one directive. Returns the stored row. */
export function addDirective(runId: string, directive: NewDirective): CanvasDirective {
  const row = load(runId);
  const stored: CanvasDirective = { ...directive, id: `directive:${runId}:${row.seq}`, seq: row.seq, created: Date.now() };
  row.seq += 1;
  row.items.push(stored);
  save(row);
  return { ...stored };
}

/** Forget every directive of a run (task deleted, graph cleared). */
export function clearDirectives(runId: string): void {
  removeEntity(RUN_DIRECTIVE_ENTITY, runId);
}

/** True when a run has directives the agent has not consumed yet. */
export function hasDirectives(runId: string): boolean {
  return readDirectives(runId).length > 0;
}

/* ------------------------------- storage -------------------------------- */

function load(runId: string): DirectiveRow {
  const raw = getEntity<unknown>(RUN_DIRECTIVE_ENTITY, runId);
  if (typeof raw !== "object" || raw === null) return { id: runId, run_id: runId, seq: 0, items: [] };
  const row = raw as Record<string, unknown>;
  const items = Array.isArray(row.items) ? row.items.filter(isDirective).map((item) => item as CanvasDirective) : [];
  return {
    id: runId,
    run_id: runId,
    seq: typeof row.seq === "number" && Number.isFinite(row.seq) ? row.seq : items.length,
    items,
  };
}

function save(row: DirectiveRow): void {
  putEntity(RUN_DIRECTIVE_ENTITY, { ...row, id: row.run_id });
}

/**
 * True when a payload is a usable directive.
 *
 * A row written by an older build (or a hand-edited database) is dropped rather
 * than trusted: a directive whose `mode` or `text` is missing would otherwise be
 * rendered into a prompt as `undefined`.
 */
function isDirective(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.text !== "string" || !raw.text.trim()) return false;
  if (raw.mode !== "follow-up" && raw.mode !== "quote") return false;
  return typeof raw.run_id === "string" && typeof raw.nodeId === "string";
}
