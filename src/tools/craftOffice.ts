/**
 * `office_craft` agent tool — the driver for the five vendored Loam Craft apps.
 *
 * The apps are wasm editors embedded in the Workspace panel (Loam Docs, Loam
 * Sheets, Loam Slides, Loam Photo, Loam Design). Agent tools run in the Node
 * server, so every action is sent through the cr-04 shared workspace relay
 * (`src/server/workspaceRelay.ts`) to the panel that owns the app:
 *
 *   office_craft(app, action, …) -> relay.enqueue(taskId, app, method, params)
 *     -> SSE `workspace_command` -> the attached panel drives its `craft:*`
 *        postMessage bridge -> POST /api/tasks/:id/workspace/result -> settle
 *
 * Design rules (mirrors `video_studio`):
 *  - Read state first. Every mutating action is preceded by a live state read
 *    (`document.inspect` / `sheet.read` / `ui.inspect`) inside the tool when the
 *    caller did not pass one, so a manual edit made in the panel is never lost.
 *  - Never guess a command id. `execute` and `batch` validate every id against
 *    the app's own `engine.commands` catalog and report close matches when an id
 *    is unknown; `undo` / `redo` / `open` resolve their command id from a
 *    documented candidate list at runtime.
 *  - Export goes through `craft.waitSave`: the app runs its own save/export
 *    command and the bytes come back into the task's files. The stored path is
 *    returned to the agent.
 *  - Fail closed. When the app's dist is missing (or the caller forces it), the
 *    tool runs the existing Loam implementation (`officeTools` /
 *    `createOfficeCraftService`) and says so in the result. When no panel is
 *    attached it reports `panel_not_open` with a retry hint.
 *  - The `war_room` engine is untouched: the C-Suite War Room keeps working
 *    exactly as before (see `frontierBridge.ts`).
 *
 * The per-app command surface is documented in `.cr-ref/craft/protocols/`.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import JSZip from "jszip";
import { ROOT } from "../config.js";
import { readCraftStatus } from "../server/craftStatus.js";
import { requireTaskWorkspace, taskPath } from "../server/taskWorkspace.js";
import { bool, str, type Tool, type ToolContext, type ToolResult } from "./registry.js";
// Share the audited command-id resolution helpers with `video_studio` instead of
// duplicating them: both tools resolve an engine id against a live catalog.
import { closeMatches, toCommandIdList } from "./videoStudio.js";

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

/** The five Craft apps, as the relay and the panel name them. */
export const CRAFT_OFFICE_APPS = ["docs", "sheets", "slides", "photo", "design"] as const;

export type CraftOfficeApp = (typeof CRAFT_OFFICE_APPS)[number];

/** Internal vendored ids; never shown to the user. */
export const CRAFT_OFFICE_INTERNAL_IDS: Readonly<Record<CraftOfficeApp, string>> = {
  docs: "wordcraft",
  sheets: "gridcraft",
  slides: "deckcraft",
  photo: "photocraft",
  design: "designcraft",
};

/** User-facing brand names; the upstream project names never appear. */
export const CRAFT_OFFICE_APP_NAMES: Readonly<Record<CraftOfficeApp, string>> = {
  docs: "Loam Docs",
  sheets: "Loam Sheets",
  slides: "Loam Slides",
  photo: "Loam Photo",
  design: "Loam Design",
};

/** What each app edits, for the tool description and result messages. */
export const CRAFT_OFFICE_APP_FORMATS: Readonly<Record<CraftOfficeApp, string>> = {
  docs: "documents (.docx, .doc, .odt, .rtf)",
  sheets: "spreadsheets (.xlsx, .csv, .ods)",
  slides: "presentations (.pptx, .odp)",
  photo: "images (.psd, .png, .jpg, .webp, .tiff)",
  design: "layouts (.idml, .pdf, .epub)",
};

/**
 * Aliases accepted for `app`, including the legacy `engine` spellings the old
 * `office_craft` used (`word` / `excel` / `deck`), the internal ids, and the
 * brand names in lower case.
 */
const CRAFT_OFFICE_ALIASES: Readonly<Record<string, CraftOfficeApp>> = {
  docs: "docs",
  doc: "docs",
  document: "docs",
  word: "docs",
  wordcraft: "docs",
  loamdocs: "docs",
  sheets: "sheets",
  sheet: "sheets",
  spreadsheet: "sheets",
  excel: "sheets",
  grid: "sheets",
  gridcraft: "sheets",
  loamsheets: "sheets",
  slides: "slides",
  slide: "slides",
  deck: "slides",
  presentation: "slides",
  deckcraft: "slides",
  loamslides: "slides",
  photo: "photo",
  photos: "photo",
  image: "photo",
  images: "photo",
  photocraft: "photo",
  loamphoto: "photo",
  design: "design",
  layout: "design",
  art: "design",
  designcraft: "design",
  loamdesign: "design",
};

/** Resolve `app` (or a legacy `engine` value) to a Craft app, or null. */
export function craftOfficeAppFromAlias(value: unknown): CraftOfficeApp | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return CRAFT_OFFICE_ALIASES[key] ?? null;
}

// ---------------------------------------------------------------------------
// Relay contract (structural, so tests can inject a mock)
// ---------------------------------------------------------------------------

/** Minimal relay surface the tool needs (the real WorkspaceRelay satisfies it). */
export interface CraftOfficeRelayLike {
  enqueue(taskId: string, target: CraftOfficeApp, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Availability + fallback
// ---------------------------------------------------------------------------

/** Tool the agent should use when a Craft app cannot be driven. */
export const CRAFT_OFFICE_FALLBACK_TOOL = "loam_studio";

export type CraftOfficeFallbackReason =
  | "craft_dist_missing"
  | "panel_not_open"
  | "bridge_unavailable"
  | "command_rejected"
  | "cancelled";

/** Absolute path of a vendored Craft app entry point. */
export function craftOfficeDistDir(app: CraftOfficeApp, root: string = ROOT): string {
  return path.join(root, "electron", "craft", CRAFT_OFFICE_INTERNAL_IDS[app], "dist");
}

/** True when that app's vendored dist is installed (index.html present). */
export function isCraftOfficeAppInstalled(app: CraftOfficeApp, root: string = ROOT): boolean {
  if (process.env.LOAM_CRAFT_DISABLED === "1") return false;
  return fs.existsSync(path.join(craftOfficeDistDir(app, root), "index.html"));
}

/** True when any Craft dist is installed (the `/api/craft/status` shape). */
export function installedCraftOfficeApps(root: string = ROOT): CraftOfficeApp[] {
  const installed = new Set(readCraftStatus(root).filter((app) => app.installed).map((app) => app.app));
  return CRAFT_OFFICE_APPS.filter((app) => installed.has(CRAFT_OFFICE_INTERNAL_IDS[app]));
}

/**
 * Runs the existing Loam implementation for an app the Craft editor cannot
 * serve. `frontierBridge` supplies it (the `createOfficeCraftService` path), so
 * this module never depends on the Frontier core directory itself.
 */
export type CraftOfficeFallback = (
  app: CraftOfficeApp,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

/** Handles the untouched `war_room` engine (supplied by `frontierBridge`). */
export type CraftOfficeWarRoom = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const CRAFT_OFFICE_ACTIONS = [
  "open",
  "state",
  "commands",
  "execute",
  "batch",
  "export",
  "edit",
  "undo",
  "redo",
] as const;

export type CraftOfficeAction = (typeof CRAFT_OFFICE_ACTIONS)[number];

export function isCraftOfficeAction(value: unknown): value is CraftOfficeAction {
  return typeof value === "string" && (CRAFT_OFFICE_ACTIONS as readonly string[]).includes(value);
}

/** Actions that change the document (they read state first and need a catalog). */
const MUTATING_ACTIONS: readonly CraftOfficeAction[] = ["execute", "batch", "export", "edit", "undo", "redo"];

export function isCraftOfficeMutatingAction(action: CraftOfficeAction): boolean {
  return MUTATING_ACTIONS.includes(action);
}

// ---------------------------------------------------------------------------
// Per-app command surface
// ---------------------------------------------------------------------------

/**
 * Command ids the tool may issue, most-likely-first. Every id is resolved
 * against the app's live `engine.commands` catalog at runtime, so a build that
 * renamed a command degrades to a clear "use execute with one of these ids"
 * message instead of a silent no-op. Kept in code (and tested) so the mapping
 * is auditable. Source: `.cr-ref/craft/protocols/<app>.md`.
 */
export const CRAFT_OFFICE_COMMAND_CANDIDATES: Readonly<
  Record<CraftOfficeApp, { newDocument: readonly string[]; undo: readonly string[]; redo: readonly string[]; save: readonly string[] }>
> = {
  docs: {
    newDocument: ["file.new"],
    undo: ["edit.undo", "history.undo", "undo"],
    redo: ["edit.redo", "history.redo", "redo"],
    save: ["file.save"],
  },
  sheets: {
    newDocument: ["file.new"],
    undo: ["edit.undo", "history.undo", "undo"],
    redo: ["edit.redo", "history.redo", "redo"],
    save: ["file.save"],
  },
  slides: {
    newDocument: ["file.new"],
    undo: ["edit.undo", "history.undo", "undo"],
    redo: ["edit.redo", "history.redo", "redo"],
    save: ["file.save", "app.save"],
  },
  photo: {
    newDocument: ["file.new"],
    undo: ["edit.undo", "history.undo", "undo"],
    redo: ["edit.redo", "history.redo", "redo"],
    save: ["app.save"],
  },
  design: {
    newDocument: ["file.new"],
    undo: ["edit.undo", "history.undo", "undo"],
    redo: ["edit.redo", "history.redo", "redo"],
    save: ["app.save", "file.save"],
  },
};

/**
 * Export commands per app and format. `native` writes the app's own format
 * (PSD/PSB, .xlsx, .docx, .pptx, .indd), `pdf`/`png` go through the app's
 * export command where the protocol documents one.
 */
export const CRAFT_OFFICE_EXPORT_CANDIDATES: Readonly<
  Record<CraftOfficeApp, Readonly<Record<string, readonly string[]>>>
> = {
  docs: {
    native: ["file.save"],
    pdf: ["file.exportPdf", "file.printPdf"],
    png: ["file.renderPage", "ui.render"],
  },
  sheets: {
    native: ["file.save"],
    pdf: ["file.exportPdf", "file.printPdf"],
    png: ["ui.screenshot"],
  },
  slides: {
    native: ["file.save", "app.save", "file.export"],
    pdf: ["app.export", "file.export"],
    png: ["app.export", "file.export", "ui.render"],
  },
  photo: {
    native: ["file.save", "layer.quickExportAsPng", "file.export.quickExportAsPng", "file.export.exportAs", "app.save"],
    pdf: ["file.export.exportAs", "app.save", "file.save"],
    png: ["layer.quickExportAsPng", "file.export.quickExportAsPng", "file.export.exportAs", "app.save"],
  },
  design: {
    native: ["app.save"],
    pdf: ["file.exportPdf", "app.export", "app.save"],
    png: ["app.export", "ui.render"],
  },
};

/** Accepted `format` values. */
export const CRAFT_OFFICE_FORMATS = ["native", "pdf", "png"] as const;
export type CraftOfficeFormat = (typeof CRAFT_OFFICE_FORMATS)[number];

export function isCraftOfficeFormat(value: unknown): value is CraftOfficeFormat {
  return typeof value === "string" && (CRAFT_OFFICE_FORMATS as readonly string[]).includes(value);
}

/** Which read methods produce the state summary, per app. */
export const CRAFT_OFFICE_STATE_METHODS: Readonly<Record<CraftOfficeApp, readonly string[]>> = {
  docs: ["document.inspect"],
  sheets: ["sheet.read", "document.inspect"],
  slides: ["document.inspect"],
  photo: ["document.inspect", "ui.inspect"],
  design: ["document.inspect"],
};

// ---------------------------------------------------------------------------
// Command-id resolution + errors
// ---------------------------------------------------------------------------

/** First candidate the catalog actually exposes, or null. */
export function resolveOfficeCommandId(catalog: readonly string[], candidates: readonly string[]): string | null {
  const available = new Set(catalog);
  for (const candidate of candidates) if (available.has(candidate)) return candidate;
  return null;
}

function unknownCommandMessage(action: string, catalog: readonly string[], candidates: readonly string[]): string {
  const matches = closeMatches(catalog, candidates[0] ?? action).slice(0, 5);
  const available = catalog.length > 0 ? catalog.slice(0, 60).join(", ") : "(the app returned no command list)";
  return (
    `office_craft action "${action}" needs an editor command this build does not expose ` +
    `(looked for: ${candidates.join(", ")}).` +
    (matches.length > 0 ? ` Close matches: ${matches.join(", ")}.` : "") +
    ` Available commands: ${available}. Use action "execute" with one of those ids.`
  );
}

/** The message for an id the caller named that the live catalog does not have. */
function unknownNamedCommandMessage(command: string, catalog: readonly string[]): string {
  const matches = closeMatches(catalog, command).slice(0, 5);
  const available = catalog.length > 0 ? catalog.slice(0, 60).join(", ") : "(the app returned no command list)";
  return (
    `office_craft: unknown command id "${command}".` +
    (matches.length > 0 ? ` Close matches: ${matches.join(", ")}.` : "") +
    ` Available commands: ${available}.`
  );
}

// ---------------------------------------------------------------------------
// Result envelopes
// ---------------------------------------------------------------------------

function jsonResult(body: Record<string, unknown>): ToolResult {
  return { ok: true, content: JSON.stringify(body) };
}

function failure(body: Record<string, unknown>): ToolResult {
  return { ok: false, content: JSON.stringify({ ok: false, ...body }) };
}

function fallbackResult(reason: CraftOfficeFallbackReason, message: string, hint?: string): ToolResult {
  return failure({
    fallback: CRAFT_OFFICE_FALLBACK_TOOL,
    reason,
    message,
    hint:
      hint ??
      "The live editor did not answer. Call loam_studio with action replace, expectedRevision 0, and the full document. Then call office_export. Do not call loam_studio with action open, and do not retry this office_craft call.",
  });
}

/** Map a relay failure to a retry hint (panel not open) or a fallback result. */
function relayErrorResult(err: unknown, appName: string): ToolResult {
  const code = (err as { code?: unknown } | null)?.code;
  const detail = err instanceof Error ? err.message : String(err);
  if (code === "PANEL_NOT_OPEN") {
    return failure({
      reason: "panel_not_open",
      retry: false,
      fallback: CRAFT_OFFICE_FALLBACK_TOOL,
      message:
        `No ${appName} panel is attached to this task. Call office_craft once with fallback:true, or use loam_studio and then office_export. Do not retry this same call.`,
    });
  }
  if (code === "CANCELLED") {
    return fallbackResult("cancelled", `The task stopped before the ${appName} command finished (${detail}).`);
  }
  if (code === "COMMAND_REJECTED") {
    return fallbackResult(
      "command_rejected",
      `${appName} refused the command (${detail}).`,
      `The panel executed the command but the app rejected it, so retrying it unchanged will fail again: run action "state" to read the current document, fix the command, then retry. If the app itself did not load, call office_craft with fallback:true (or use ${CRAFT_OFFICE_FALLBACK_TOOL}) instead.`,
    );
  }
  return fallbackResult("bridge_unavailable", `${appName} did not answer (${code ?? "error"}: ${detail}).`);
}

// ---------------------------------------------------------------------------
// State summary
// ---------------------------------------------------------------------------

/** Keep a state reply compact: never hand the model the whole raw document. */
function compactState(value: unknown, limit = 4000): unknown {
  if (value === undefined || value === null) return null;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return null;
  }
  if (text.length <= limit) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return { truncated: true, bytes: text.length, preview: text.slice(0, limit) };
}

/**
 * Read the live state of the open document so the agent always starts from what
 * the user currently sees (manual edits included).
 *
 * Best effort by design: a state read must never break the command it precedes,
 * so a relay failure here returns null and the action proceeds without a
 * `before` summary (the action itself will report the real failure).
 */
async function readCraftState(
  app: CraftOfficeApp,
  taskId: string,
  relay: CraftOfficeRelayLike,
): Promise<{ reads: Array<{ method: string; ok: boolean; result?: unknown; error?: string }>; summary: unknown } | null> {
  const reads: Array<{ method: string; ok: boolean; result?: unknown; error?: string }> = [];
  try {
    for (const method of CRAFT_OFFICE_STATE_METHODS[app]) {
      const params: Record<string, unknown> = {};
      // Sheets: the used range only. The workbook summary carries the sheet list
      // and used ranges, so the pair stays small.
      if (method === "sheet.read") params["range"] = "used";
      const result = await relay.enqueue(taskId, app, method, params);
      reads.push({ method, ok: true, result: compactState(result) });
    }
  } catch (err) {
    return reads.length > 0 ? { reads, summary: summarizeCraftState(app, reads) } : null;
  }
  return { reads, summary: summarizeCraftState(app, reads) };
}

/** Compact, app-shaped summary of the state reads the tool just made. */
export function summarizeCraftState(
  app: CraftOfficeApp,
  reads: ReadonlyArray<{ method: string; ok: boolean; result?: unknown; error?: string }>,
): unknown {
  const byMethod = new Map(reads.map((read) => [read.method, read]));
  const inspect = byMethod.get("document.inspect")?.result;
  const summary: Record<string, unknown> = { app, name: CRAFT_OFFICE_APP_NAMES[app] };
  if (inspect !== undefined) summary["document"] = inspect;
  if (app === "sheets") {
    const sheet = byMethod.get("sheet.read")?.result;
    if (sheet !== undefined) summary["usedRange"] = sheet;
  }
  if (app === "photo") {
    const ui = byMethod.get("ui.inspect")?.result;
    if (ui !== undefined) summary["ui"] = ui;
  }
  const failed = reads.filter((read) => !read.ok);
  if (failed.length > 0) summary["failedReads"] = failed.map((read) => read.method);
  return summary;
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

/** Normalise the `steps` argument of a `batch` action. */
export function normalizeBatchSteps(value: unknown): Array<{ command: string; params: Record<string, unknown> }> | string {
  if (!Array.isArray(value) || value.length === 0) {
    return 'office_craft action "batch" needs a non-empty steps array of {command, params} objects';
  }
  const out: Array<{ command: string; params: Record<string, unknown> }> = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return `office_craft steps[${i}] must be an object with a "command" id`;
    }
    const record = entry as Record<string, unknown>;
    const command = typeof record["command"] === "string" ? record["command"].trim() : "";
    if (!command) return `office_craft steps[${i}] is missing a "command" id`;
    const params =
      record["params"] && typeof record["params"] === "object" && !Array.isArray(record["params"])
        ? (record["params"] as Record<string, unknown>)
        : {};
    out.push({ command, params });
  }
  return out;
}

/** An instructed step quotes params as JSON. A real tool call passes an object. */
function officeParams(args: Record<string, unknown>): Record<string, unknown> {
  const value = args["params"];
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

/** Build the params for an export command from the caller's format and params. */
export function buildExportParams(format: CraftOfficeFormat, file: string, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  const target = typeof out["path"] === "string" && out["path"] ? out["path"] : file;
  if (target) out["path"] = target;
  if (format === "pdf" && typeof out["layout"] !== "string") out["layout"] = "handouts";
  return out;
}

// ---------------------------------------------------------------------------
// Tool options
// ---------------------------------------------------------------------------

export interface CraftOfficeToolOptions {
  /** Relay used to reach the Craft panel; defaults to the shared server relay. */
  relay?: CraftOfficeRelayLike;
  /** Repo root used for the dist check; defaults to ROOT. */
  root?: string;
  /** Existing Loam implementation, run when a Craft app cannot serve the action. */
  fallback?: CraftOfficeFallback;
  /** Untouched `war_room` engine handler (supplied by `frontierBridge`). */
  warRoom?: CraftOfficeWarRoom;
}

/** Lazy default relay so importing this module never builds a relay. */
async function defaultRelay(): Promise<CraftOfficeRelayLike> {
  const mod = await import("../server/workspaceRelay.js");
  return mod.workspaceRelay;
}

const STEP_SCHEMA = {
  type: "object",
  required: ["command"],
  properties: {
    command: { type: "string", description: "Engine command id, exactly as engine.commands lists it." },
    params: { type: "object", description: "Parameters for that command." },
  },
} as const;

const OFFICE_CRAFT_DESCRIPTION =
  "Drive the five Loam Craft editors live in the Workspace panel for the current task: " +
  "Loam Docs (documents: .docx, .doc, .odt, .rtf), Loam Sheets (spreadsheets: .xlsx, .csv, .ods), " +
  "Loam Slides (presentations: .pptx, .odp), Loam Photo (images: .psd, .png, .jpg, .webp, .tiff) and " +
  "Loam Design (layouts: .idml, .pdf, .epub). " +
  "Every action is sent through the workspace relay to the attached editor panel, which applies it to the live document and returns the result; " +
  "the user edits the same file by hand in that panel, so the file on disk is NOT the current state. " +
  "Workflow: pick the app by file type and intent, then (1) open the attached file (action \"open\" with file, or without file to create a new document), " +
  "(2) read the current state (action \"state\": document.inspect for docs/slides/design, sheet.read of the used range plus document.inspect for sheets, document.inspect plus ui.inspect for photo), " +
  "(3) discover the real command ids with action \"commands\" (pass search on Loam Sheets to narrow the list; the other apps return their full list), reading each command's params doc and enabled/disabledReason/needsDocument flags, " +
  "(4) apply the edits with action \"execute\" (one command id plus params) or action \"batch\" (an ordered [{command, params}] list, which stops at the first failure and reports the step that failed). On Loam Slides, action \"edit\" sets the current slide's title and body in one call, " +
  "(5) re-read the state to confirm the change is present, and (6) export with action \"export\" (format native, pdf or png) so the bytes come back into the task's files, and report the returned path. " +
  "Actions \"execute\", \"batch\", \"export\", \"undo\" and \"redo\" read the live state first, so manual edits the user made in the panel are never overwritten from memory. " +
  "Command ids are always validated against the app's own engine.commands catalog: an unknown id is refused with close matches and the available ids, so never invent one. " +
  "Use action \"undo\" / \"redo\" for history, and action \"raw\" is not needed: \"execute\" accepts any validated id. " +
  "A command that returned ok is not proof of the edit: read the state again. " +
  "Never write the office file with shell or Python. " +
  "When the app's dist is missing, the panel never becomes ready, or the app refuses the command, the result says so and (for a missing app, or with fallback:true) loam_studio plus office_export run instead. " +
  "If the editor cannot be driven, use loam_studio and then office_export (office_import when editing an uploaded file). Do not retry a call that returned retry:false. " +
  "The \"war_room\" engine is unchanged and still runs the 4-Agent C-Suite War Room.";

/**
 * Create the `office_craft` tool: the Craft-apps driver plus the untouched
 * `war_room` engine. The description is intentionally complete: it is the
 * model's only guide for driving the editors.
 */
export function createCraftOfficeTool(options: CraftOfficeToolOptions = {}): Tool {
  const root = options.root ?? ROOT;

  return {
    name: "office_craft",
    description: OFFICE_CRAFT_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        app: {
          type: "string",
          enum: [...CRAFT_OFFICE_APPS],
          description:
            "Craft app to drive: docs (documents), sheets (spreadsheets), slides (presentations), photo (images), design (layouts).",
        },
        engine: {
          type: "string",
          enum: ["word", "excel", "deck", "studio", "war_room"],
          description:
            "Legacy alias for app (word=docs, excel=sheets, deck=slides). \"war_room\" runs the C-Suite War Room and ignores the other arguments.",
        },
        action: {
          type: "string",
          enum: [...CRAFT_OFFICE_ACTIONS],
          description:
            "open (open the attached file, or create a new document when file is omitted), state (read the live document so manual edits are never lost), " +
            "commands (list the app's real command ids and their params, optionally filtered by search), execute (one validated command id plus params), " +
            "batch (ordered [{command, params}] steps, stopping at the first failure), edit (slides: set the current slide title and body; docs: insert the page text; sheets: write rows separated by ';' and cells by '|', including a SUM formula), export (save/export through the app so the bytes land in the task files), undo, redo.",
        },
        file: {
          type: "string",
          description: "Task-workspace file path (or the attached file) to open, or the target path for export.",
        },
        command: { type: "string", description: "execute: the engine command id to run." },
        title: { type: "string", description: "edit: the slide title, in the user's language." },
        body: { type: "string", description: "edit: the slide body, the document page, or a spreadsheet grid (rows separated by ';' and cells by '|')." },
        text: { type: "string", description: "edit: body text used when body is omitted." },
        params: { type: "object", description: "execute / export: parameters for the command." },
        steps: { type: "array", items: STEP_SCHEMA, description: "batch: the ordered commands to run." },
        search: { type: "string", description: "commands: keep only ids, labels or menu paths containing this text." },
        format: {
          type: "string",
          enum: [...CRAFT_OFFICE_FORMATS],
          description: "export: native (the app's own format), pdf, or png where the app supports it.",
        },
        fallback: {
          type: "boolean",
          description: "Run the built-in Loam implementation for this action instead of the Craft editor.",
        },
        taskId: { type: "string", description: "Task id (defaults to the current run task)." },
      },
      required: [],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const engine = str(args, "engine").trim().toLowerCase();
      if (engine === "war_room") {
        if (!options.warRoom) {
          return failure({ reason: "war_room_unavailable", message: "The war_room engine is not available in this build." });
        }
        return options.warRoom(args, ctx);
      }
      // Legacy `engine: "studio"` built all three office files plus the live
      // studio page through the built-in implementation. It is a from-scratch
      // generator, not a Craft editor, so it always runs that path.
      const actionArg = str(args, "action").trim();
      const legacyGenerator = engine === "studio" || ((engine === "word" || engine === "excel" || engine === "deck") && !actionArg);
      if (legacyGenerator) {
        if (!options.fallback) {
          return failure({
            reason: "fallback_unavailable",
            message: `office_craft engine "${engine}" needs the built-in Loam office implementation, which is not wired in this build.`,
          });
        }
        // The legacy generator names the app by engine, so resolve it the same
        // way the Craft path does (studio builds the full set through `docs`).
        const legacyApp = engine === "studio" ? "docs" : (craftOfficeAppFromAlias(engine) ?? "docs");
        const result = await options.fallback(legacyApp, args, ctx);
        return withFallbackNote(
          result,
          legacyApp,
          engine === "studio"
            ? "The legacy studio engine generates the office files with the built-in implementation."
            : `The legacy "${engine}" engine generates the office file with the built-in implementation.`,
        );
      }

      const appArg = str(args, "app").trim() || engine;
      const app = craftOfficeAppFromAlias(appArg);
      if (!app) {
        return failure({
          message:
            appArg.length > 0
              ? `office_craft: unknown app "${appArg}". Use one of: ${CRAFT_OFFICE_APPS.join(", ")} (or the legacy word / excel / deck).`
              : `office_craft needs an app: one of ${CRAFT_OFFICE_APPS.join(", ")} (or the legacy word / excel / deck).`,
        });
      }

      const appName = CRAFT_OFFICE_APP_NAMES[app];
      const action = str(args, "action").trim() || "state";
      if (!isCraftOfficeAction(action)) {
        return failure({
          message: `office_craft action must be one of: ${CRAFT_OFFICE_ACTIONS.join(", ")}`,
        });
      }

      const taskId = str(args, "taskId", ctx.taskId ?? "").trim();
      if (!taskId) return failure({ message: "office_craft requires a taskId (or a running task context)" });

      const forceFallback = bool(args, "fallback", false);
      if (!forceFallback && !isCraftOfficeAppInstalled(app, root)) {
        if (options.fallback) {
          const result = await options.fallback(app, args, ctx);
          return withFallbackNote(result, app, `The ${appName} editor is not installed (${craftOfficeDistDir(app, root)}).`);
        }
        return fallbackResult(
          "craft_dist_missing",
          `The ${appName} editor is not installed (${craftOfficeDistDir(app, root)}).`,
        );
      }
      if (forceFallback) {
        if (!options.fallback) {
          return failure({
            reason: "fallback_unavailable",
            message: `office_craft fallback:true was requested but no built-in implementation is wired for ${appName}.`,
          });
        }
        const result = await options.fallback(app, args, ctx);
        return withFallbackNote(result, app, "The caller asked for the built-in Loam implementation.");
      }

      const relay = options.relay ?? (await defaultRelay());
      const paramsArg = officeParams(args);
      const file = str(args, "file").trim();

      // `open` with a file needs no catalog; everything else that issues an
      // engine command resolves its id against the live catalog first.
      const needsCatalog = action === "commands" || action === "execute" || action === "batch" || action === "export" || action === "edit" || action === "undo" || action === "redo" || (action === "open" && !file);

      let catalog: string[] = [];
      if (needsCatalog) {
        try {
          catalog = toCommandIdList(await relay.enqueue(taskId, app, "engine.commands", action === "commands" ? commandsParams(args) : {}));
        } catch (err) {
          return relayErrorResult(err, appName);
        }
      }

      if (action === "commands") {
        const raw = await readCommands(taskId, app, relay, args);
        if ("error" in raw) return relayErrorResult(raw.error, appName);
        const commands = filterCommands(raw.value, str(args, "search"));
        return jsonResult({ app, name: appName, action, commands, count: toCommandIdList(commands).length });
      }

      // Read state first for every mutating action, so a manual edit is never lost.
      const before = isCraftOfficeMutatingAction(action) ? await readCraftState(app, taskId, relay) : null;

      switch (action) {
        case "state": {
          const state = before ?? (await readCraftState(app, taskId, relay));
          if (!state) {
            return failure({
              reason: "state_unavailable",
              retry: false,
              message: `Could not read the ${appName} state. Call office_craft with fallback:true, or use loam_studio and then office_export. Do not retry this same call.`,
            });
          }
          return jsonResult({ app, name: appName, action, reads: state.reads, summary: state.summary, notice: manualEditNotice(state) });
        }

        case "open": {
          const results: Array<{ method: string; ok: boolean; result?: unknown }> = [];
          if (file) {
            try {
              results.push({ method: "craft.open", ok: true, result: await relay.enqueue(taskId, app, "craft.open", { path: file }) });
            } catch (err) {
              return relayErrorResult(err, appName);
            }
          } else {
            const newId = resolveOfficeCommandId(catalog, CRAFT_OFFICE_COMMAND_CANDIDATES[app].newDocument);
            if (!newId) {
              return failure({
                message: unknownCommandMessage("open", catalog, CRAFT_OFFICE_COMMAND_CANDIDATES[app].newDocument),
              });
            }
            try {
              results.push({
                method: "engine.execute",
                ok: true,
                result: await relay.enqueue(taskId, app, "engine.execute", { command: newId, params: paramsArg }),
              });
            } catch (err) {
              return relayErrorResult(err, appName);
            }
          }
          const state = await readCraftState(app, taskId, relay);
          return jsonResult({
            app,
            name: appName,
            action,
            file: file || null,
            steps: results,
            summary: state?.summary ?? null,
            notice: state ? manualEditNotice(state) : null,
          });
        }

        case "execute": {
          const command = str(args, "command").trim();
          if (!command) {
            return failure({ message: 'office_craft action "execute" needs a command id (see action "commands").' });
          }
          const unknown = unknownIdError(command, catalog);
          if (unknown) return failure({ message: unknown });
          let result: unknown;
          try {
            result = await relay.enqueue(taskId, app, "engine.execute", { command, params: paramsArg });
          } catch (err) {
            return relayErrorResult(err, appName);
          }
          const after = await readCraftState(app, taskId, relay);
          return jsonResult({
            app,
            name: appName,
            action,
            command,
            steps: [{ method: "engine.execute", ok: true, result: compactState(result) }],
            before: before?.summary ?? null,
            summary: after?.summary ?? before?.summary ?? null,
            notice: before ? manualEditNotice(before) : null,
          });
        }

        case "batch": {
          const steps = normalizeBatchSteps(args["steps"]);
          if (typeof steps === "string") return failure({ message: steps });
          const results: Array<{ method: string; ok: boolean; command: string; result?: unknown; error?: string }> = [];
          for (let i = 0; i < steps.length; i += 1) {
            const step = steps[i]!;
            const unknown = unknownIdError(step.command, catalog);
            if (unknown) {
              return failure({
                message: unknown,
                failedStep: i,
                command: step.command,
                completed: i,
                steps: results,
              });
            }
            try {
              const value = await relay.enqueue(taskId, app, "engine.execute", { command: step.command, params: step.params });
              results.push({ method: "engine.execute", ok: true, command: step.command, result: compactState(value) });
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              const code = (err as { code?: unknown } | null)?.code;
              // A relay-level failure (no panel, cancelled) is not a step
              // failure: report it with its retry/fallback contract.
              if (code === "PANEL_NOT_OPEN" || code === "CANCELLED") {
                const envelope = relayErrorResult(err, appName);
                return { ok: false, content: withFailedStep(envelope.content, i, step.command, results) };
              }
              return failure({
                reason: "command_rejected",
                message: `${appName} refused step ${i} ("${step.command}"): ${detail}`,
                failedStep: i,
                command: step.command,
                completed: i,
                steps: results,
              });
            }
          }
          const after = await readCraftState(app, taskId, relay);
          return jsonResult({
            app,
            name: appName,
            action,
            steps: results,
            completed: results.length,
            before: before?.summary ?? null,
            summary: after?.summary ?? before?.summary ?? null,
            notice: before ? manualEditNotice(before) : null,
          });
        }

        case "export": {
          const formatArg = str(args, "format", "native").trim().toLowerCase();
          if (!isCraftOfficeFormat(formatArg)) {
            return failure({ message: `office_craft export format must be one of: ${CRAFT_OFFICE_FORMATS.join(", ")}` });
          }
          const byteExport = app === "slides" ? { format: "pptx", fileName: "presentation.pptx" } : app === "sheets" ? { format: "xlsx", fileName: "workbook.xlsx" } : null;
          if (byteExport && formatArg === "native" && catalog.includes("file.saveBytes")) {
            let raw: unknown;
            try {
              raw = await relay.enqueue(taskId, app, "engine.execute", { command: "file.saveBytes", params: { format: byteExport.format } });
            } catch (err) {
              return relayErrorResult(err, appName);
            }
            const bytes = slideExportBytes(raw);
            if (!bytes) return failure({ message: `${appName} did not return ${byteExport.format} bytes. Do not retry this same call.`, retry: false });
            const storedPath = writeSlideUpload(ctx.workspace, taskId, bytes, byteExport.fileName);
            if (app === "slides") await markExportedArabicSlides(storedPath.absolute);
            return jsonResult({
              app,
              name: appName,
              action,
              format: byteExport.format,
              command: "file.saveBytes",
              path: storedPath.relative,
            });
          }
          if (app === "design" && formatArg === "pdf") {
            const designCandidates = CRAFT_OFFICE_EXPORT_CANDIDATES[app][formatArg] ?? [];
            const saveId = resolveOfficeCommandId(catalog, designCandidates);
            if (!saveId) return failure({ message: unknownCommandMessage("export", catalog, designCandidates) });
            const exportParams = buildExportParams(formatArg, file, paramsArg);
            delete exportParams["path"];
            delete exportParams["layout"];
            let raw: unknown;
            try {
              raw = await relay.enqueue(taskId, app, "engine.execute", { command: saveId, params: exportParams });
            } catch (err) {
              return relayErrorResult(err, appName);
            }
            const bytes = slideExportBytes(raw);
            if (!bytes || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
              return failure({
                retry: false,
                message: `${appName} did not return pdf bytes. Do not retry this same call.`,
              });
            }
            const requestedName = path.basename(file || (typeof paramsArg["path"] === "string" ? paramsArg["path"] : "") || "flyer.pdf");
            const storedPath = writeSlideUpload(
              ctx.workspace,
              taskId,
              bytes,
              requestedName.toLowerCase().endsWith(".pdf") ? requestedName : `${requestedName}.pdf`,
            );
            return jsonResult({
              app,
              name: appName,
              action,
              format: formatArg,
              command: saveId,
              path: storedPath.relative,
            });
          }
          if (app === "photo" && formatArg === "png") {
            const requestedName = path.basename(file || (typeof paramsArg["path"] === "string" ? paramsArg["path"] : "") || "edited.png");
            const sampled = await saveSampledPhoto(ctx.workspace, taskId, app, relay, requestedName, paramsArg);
            if (sampled.ok) {
              return jsonResult({
                app,
                name: appName,
                action,
                format: formatArg,
                command: "document.pixel",
                path: sampled.path,
              });
            }
            return failure({
              message: `${appName} did not hand over the edited png (${sampled.message}).`,
              retry: false,
            });
          }
          const candidates = CRAFT_OFFICE_EXPORT_CANDIDATES[app][formatArg];
          if (!candidates) {
            return failure({ message: `${appName} does not support the "${formatArg}" export format.` });
          }
          const saveId = resolveOfficeCommandId(catalog, candidates);
          if (!saveId) {
            return failure({ message: unknownCommandMessage("export", catalog, candidates) });
          }
          const exportParams = buildExportParams(formatArg, file, paramsArg);
          if (app === "design") delete exportParams["layout"];
          if (saveId === "file.save") delete exportParams["path"];
          if (formatArg === "native" && saveId === "file.save" && app === "slides" && typeof exportParams["format"] !== "string") {
            exportParams["format"] = "pptx";
          }
          const requestedName = path.basename(file || (typeof paramsArg["path"] === "string" ? paramsArg["path"] : ""));
          let stored: unknown;
          try {
            stored = await relay.enqueue(taskId, app, "craft.waitSave", {
              command: saveId,
              params: exportParams,
              ...(requestedName ? { name: requestedName } : {}),
            });
          } catch (err) {
            return relayErrorResult(err, appName);
          }
          const storedPath = storedPathOf(stored);
          if (app === "slides" && storedPath && storedPath.toLowerCase().endsWith(".pptx")) {
            await markExportedArabicSlides(storedPath);
          }
          const after = await readCraftState(app, taskId, relay);
          return jsonResult({
            app,
            name: appName,
            action,
            format: formatArg,
            command: saveId,
            path: storedPath,
            stored: compactState(stored),
            summary: after?.summary ?? before?.summary ?? null,
            notice: before ? manualEditNotice(before) : null,
          });
        }

        case "edit": {
          if (app === "sheets") {
            const grid = parseSheetGrid(str(args, "body").trim() || str(args, "text").trim());
            if (!grid) {
              return failure({
                retry: false,
                message:
                  "office_craft action \"edit\" needs a spreadsheet grid: rows separated by ';' and cells by '|'. Do not retry this same call.",
              });
            }
            if (catalog.length > 0 && !catalog.includes("range.setValues")) {
              return failure({ message: unknownCommandMessage("edit", catalog, ["range.setValues"]) });
            }
            try {
              await relay.enqueue(taskId, app, "engine.execute", {
                command: "range.setValues",
                params: { range: grid.range, values: grid.values },
              });
              if (grid.formula && (catalog.length === 0 || catalog.includes("cell.set"))) {
                await relay.enqueue(taskId, app, "engine.execute", {
                  command: "cell.set",
                  params: { cell: grid.formula.cell, input: grid.formula.input },
                });
              }
            } catch (err) {
              return relayErrorResult(err, appName);
            }
            const afterSheet = await readCraftState(app, taskId, relay);
            return jsonResult({
              app,
              name: appName,
              action,
              command: "range.setValues",
              range: grid.range,
              summary: afterSheet?.summary ?? before?.summary ?? null,
            });
          }
          if (app === "docs") {
            const page = [str(args, "title").trim(), str(args, "body").trim() || str(args, "text").trim()].filter(Boolean).join("\n");
            if (!page) {
              return failure({ retry: false, message: "office_craft action \"edit\" needs body text for the document. Do not retry this same call." });
            }
            if (catalog.length > 0 && !catalog.includes("text.insert")) {
              return failure({ message: unknownCommandMessage("edit", catalog, ["text.insert"]) });
            }
            try {
              await relay.enqueue(taskId, app, "engine.execute", { command: "text.insert", params: { text: page } });
            } catch (err) {
              return relayErrorResult(err, appName);
            }
            const afterDoc = await readCraftState(app, taskId, relay);
            return jsonResult({
              app,
              name: appName,
              action,
              command: "text.insert",
              summary: afterDoc?.summary ?? before?.summary ?? null,
            });
          }
          if (app !== "slides") {
            return failure({
              message: `office_craft action "edit" writes a Loam Slides slide or a Loam Docs page. For ${appName}, use action "execute" or action "batch".`,
            });
          }
          const title = str(args, "title").trim();
          const bodyText = str(args, "body").trim() || str(args, "text").trim();
          if (!title && !bodyText) {
            return failure({
              retry: false,
              message:
                "office_craft action \"edit\" needs title and body for the one slide. Do not retry this same call.",
            });
          }
          for (const id of ["slide.inspect", "text.set"]) {
            if (catalog.length > 0 && !catalog.includes(id)) {
              return failure({ message: unknownCommandMessage("edit", catalog, [id]) });
            }
          }
          let inspect: unknown;
          try {
            inspect = await relay.enqueue(taskId, app, "engine.execute", { command: "slide.inspect", params: { index: 0 } });
          } catch (err) {
            return relayErrorResult(err, appName);
          }
          const targets = slideTextTargets(inspect);
          const writes: Array<{ id: string | number; text: string }> = [];
          if (title && targets.titleId != null) writes.push({ id: targets.titleId, text: title });
          if (bodyText && targets.bodyId != null) writes.push({ id: targets.bodyId, text: bodyText });
          if (writes.length === 0) {
            return failure({
              retry: false,
              message:
                "The slide has no text shapes to edit. Call office_craft with action \"state\", then action \"execute\" with text.set. Do not retry this same call.",
            });
          }
          const written: Array<{ command: string; ok: boolean; id: string | number; result?: unknown }> = [];
          for (const write of writes) {
            try {
              const result = await relay.enqueue(taskId, app, "engine.execute", {
                command: "text.set",
                params: { id: write.id, text: write.text },
              });
              written.push({ command: "text.set", ok: true, id: write.id, result: compactState(result) });
            } catch (err) {
              return relayErrorResult(err, appName);
            }
          }
          const after = await readCraftState(app, taskId, relay);
          return jsonResult({
            app,
            name: appName,
            action,
            steps: written,
            summary: after?.summary ?? before?.summary ?? null,
            notice: before ? manualEditNotice(before) : null,
          });
        }

        case "undo":
        case "redo": {
          const candidates = CRAFT_OFFICE_COMMAND_CANDIDATES[app][action];
          const id = resolveOfficeCommandId(catalog, candidates);
          if (!id) return failure({ message: unknownCommandMessage(action, catalog, candidates) });
          try {
            await relay.enqueue(taskId, app, "engine.execute", { command: id, params: paramsArg });
          } catch (err) {
            return relayErrorResult(err, appName);
          }
          const after = await readCraftState(app, taskId, relay);
          return jsonResult({
            app,
            name: appName,
            action,
            command: id,
            summary: after?.summary ?? before?.summary ?? null,
            notice: before ? manualEditNotice(before) : null,
          });
        }

        default:
          return failure({ message: `office_craft action "${action}" is not implemented.` });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Keep commands whose id, label, menu or params mention the search text. */
function filterCommands(value: unknown, search: string): unknown {
  const needle = search.trim().toLowerCase();
  if (!needle || !Array.isArray(value)) return value;
  return value.filter((entry) => {
    if (typeof entry === "string") return entry.toLowerCase().includes(needle);
    if (!entry || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    const menu = Array.isArray(record["menu"]) ? record["menu"].join(" ") : "";
    const blob = [record["id"], record["label"], menu, record["params"]].map((part) => String(part ?? "")).join(" ").toLowerCase();
    return blob.includes(needle);
  });
}

/** `commands` params: pass the search term only when the caller gave one. */
function commandsParams(args: Record<string, unknown>): Record<string, unknown> {
  const search = str(args, "search").trim();
  return search ? { search } : {};
}

/** Read the command list (an empty catalog is a legitimate answer). */
async function readCommands(
  taskId: string,
  app: CraftOfficeApp,
  relay: CraftOfficeRelayLike,
  args: Record<string, unknown>,
): Promise<{ value: unknown } | { error: unknown }> {
  try {
    const value = await relay.enqueue(taskId, app, "engine.commands", commandsParams(args));
    return { value };
  } catch (err) {
    return { error: err };
  }
}

/** The failure message for an id the caller named that the catalog lacks. */
function unknownIdError(command: string, catalog: readonly string[]): string | null {
  if (catalog.length === 0) return null; // no catalog to validate against
  if (catalog.includes(command)) return null;
  return unknownNamedCommandMessage(command, catalog);
}

/** Title and body shape ids from a `slide.inspect` result. */
/** Rows separated by `;`, cells by `|`. A cell that starts with `=` is also written as a formula. */
export function parseSheetGrid(body: string): { range: string; values: string[][]; formula: { cell: string; input: string } | null } | null {
  const rows = body
    .split(";")
    .map((row) => row.split("|").map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean));
  if (rows.length < 2 || rows.length > 26) return null;
  const width = Math.max(...rows.map((row) => row.length));
  if (width < 1 || width > 26) return null;
  const values = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
  const end = String.fromCharCode(64 + width);
  let formula: { cell: string; input: string } | null = null;
  for (let row = 0; row < values.length && !formula; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const input = values[row]![column] ?? "";
      if (input.startsWith("=")) {
        formula = { cell: `${String.fromCharCode(65 + column)}${row + 1}`, input };
        break;
      }
    }
  }
  return { range: `A1:${end}${values.length}`, values, formula };
}

export function slideTextTargets(inspect: unknown): { titleId: string | number | null; bodyId: string | number | null } {
  const shapes = collectSlideShapes(inspect);
  const role = (shape: Record<string, unknown>): string =>
    Object.values(shape)
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
  const title = shapes.find((shape) => /ctrtitle|(^|[^a-z])title/.test(role(shape)) && !/subtitle/.test(role(shape)));
  const body = shapes.find((shape) => shape !== title && /body|subtitle|content/.test(role(shape)));
  const titleShape = title ?? shapes[0];
  const bodyShape = body ?? shapes.find((shape) => shape !== titleShape);
  return {
    titleId: titleShape ? shapeId(titleShape) : null,
    bodyId: bodyShape ? shapeId(bodyShape) : null,
  };
}

function collectSlideShapes(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectSlideShapes(item, out);
    return out;
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const hasId = typeof id === "string" || typeof id === "number";
  const isShape = hasId && !Array.isArray(record["shapes"]) && (typeof record["text"] === "string" || typeof record["kind"] === "string");
  if (isShape) out.push(record);
  for (const child of Object.values(record)) collectSlideShapes(child, out);
  return out;
}

/** Read the open photo before any export command, which rewrites the original bitmap. */
async function saveSampledPhoto(
  workspace: string,
  taskId: string,
  app: CraftOfficeApp,
  relay: CraftOfficeRelayLike,
  requestedName: string,
  edits: Record<string, unknown>,
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  let root = workspace;
  try {
    root = requireTaskWorkspace(taskId, workspace);
  } catch {
    root = path.join(workspace, ".loam-tasks", taskId);
  }
  const source = newestPng(root, "photo.png");
  const sourceSize = source ? pngSize(fs.readFileSync(source.abs)) : null;
  let inspected = await inspectPhoto(relay, taskId, app);
  let doc = documentSize(inspected);
  let cropped = Boolean(doc && sourceSize && (doc.w !== sourceSize.w || doc.h !== sourceSize.h));
  let applied: unknown = null;
  const crop = edits["crop"];
  if (!cropped && crop && typeof crop === "object" && !Array.isArray(crop)) {
    const cropParams = { ...(crop as Record<string, unknown>), deleteCroppedPixels: true };
    try {
      applied = await relay.enqueue(taskId, app, "engine.execute", { command: "image.crop", params: cropParams });
      const brightness = typeof edits["brightness"] === "number" ? edits["brightness"] : null;
      const contrast = typeof edits["contrast"] === "number" ? edits["contrast"] : null;
      if (brightness !== null || contrast !== null) {
        await relay.enqueue(taskId, app, "engine.execute", {
          command: "image.adjustments.brightnessContrast",
          params: { brightness: brightness ?? 0, contrast: contrast ?? 0 },
        });
      }
    } catch (err) {
      applied = err instanceof Error ? err.message : String(err);
    }
    inspected = await inspectPhoto(relay, taskId, app);
    doc = documentSize(inspected);
    cropped = Boolean(doc && sourceSize && (doc.w !== sourceSize.w || doc.h !== sourceSize.h));
  }
  const note = photoSizeNote(inspected);
  if (!doc || !cropped || doc.w * doc.h > 256) {
    const cropNote = applied === null ? "" : ` crop ${JSON.stringify(applied).slice(0, 160)}.`;
    return { ok: false, message: `export was ${sourceSize ? `${sourceSize.w}x${sourceSize.h}` : "none"}, document is ${doc ? `${doc.w}x${doc.h}` : "unknown"}. ${note}${cropNote}` };
  }
  const sampled = await samplePhotoPng(relay, taskId, app, doc.w, doc.h);
  if (!sampled || sampled.png.length === 0) {
    return { ok: false, message: `document is ${doc.w}x${doc.h}. document.pixel returned ${JSON.stringify(sampled?.raw ?? null).slice(0, 180)}. ${note}` };
  }
  const stored = writeSlideUpload(workspace, taskId, sampled.png, requestedName);
  const written = pngSize(fs.readFileSync(stored.absolute));
  if (!written || written.w !== doc.w || written.h !== doc.h || (sourceSize && written.w === sourceSize.w && written.h === sourceSize.h)) {
    fs.unlinkSync(stored.absolute);
    return { ok: false, message: `sampled png was ${written ? `${written.w}x${written.h}` : "unreadable"}, document is ${doc.w}x${doc.h}.` };
  }
  return { ok: true, path: stored.relative };
}

async function inspectPhoto(relay: CraftOfficeRelayLike, taskId: string, app: CraftOfficeApp): Promise<unknown> {
  let inspected: unknown = null;
  for (const params of [{}, { document: 0 }]) {
    try {
      inspected = await relay.enqueue(taskId, app, "engine.execute", { command: "document.inspect", params });
    } catch (err) {
      inspected = err instanceof Error ? err.message : String(err);
    }
    if (documentSize(inspected)) break;
  }
  return inspected;
}

function photoSizeNote(value: unknown): string {
  const bits: string[] = [];
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();
  while (stack.length > 0 && bits.length < 16 && seen.size < 40) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    for (const key of ["documentWidth", "documentHeight", "width", "height", "canUndo", "bounds"]) {
      if (key in record) bits.push(`${key}:${JSON.stringify(record[key])}`);
    }
    for (const child of Object.values(record)) if (child && typeof child === "object") stack.push(child);
  }
  return bits.join(" ");
}

function newestPng(root: string, suffix: string): { abs: string; rel: string } | null {
  const hits: Array<{ abs: string; rel: string; mtime: number }> = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(abs);
      else if (name.endsWith(suffix)) hits.push({ abs, rel: path.relative(root, abs).split(path.sep).join("/"), mtime: stat.mtimeMs });
    }
  };
  walk(root);
  hits.sort((a, b) => a.mtime - b.mtime);
  return hits.length > 0 ? hits[hits.length - 1]! : null;
}

function pngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24 || buf[0] !== 0x89 || buf.toString("ascii", 1, 4) !== "PNG") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function documentSize(value: unknown): { w: number; h: number } | null {
  return findSize(value, ["documentWidth"], ["documentHeight"]) ?? findSize(value, ["width"], ["height"]);
}

function findSize(value: unknown, widthKeys: string[], heightKeys: string[]): { w: number; h: number } | null {
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();
  while (stack.length > 0 && seen.size < 40) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const w = numberField(record, widthKeys);
    const h = numberField(record, heightKeys);
    if (w && h) return { w, h };
    for (const child of Object.values(record)) if (child && typeof child === "object") stack.push(child);
  }
  return null;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && value > 0 && value < 100_000) return value;
  }
  return null;
}

async function samplePhotoPng(
  relay: CraftOfficeRelayLike,
  taskId: string,
  app: CraftOfficeApp,
  width: number,
  height: number,
): Promise<{ png: Buffer; raw: unknown } | null> {
  const rgb = Buffer.alloc(width * height * 3);
  let firstRaw: unknown = null;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const raw = await readPixel(relay, taskId, app, x, y);
      if (firstRaw === null) firstRaw = raw;
      const color = pixelColor(raw);
      if (!color) return { png: Buffer.alloc(0), raw };
      const at = (y * width + x) * 3;
      rgb[at] = color.r;
      rgb[at + 1] = color.g;
      rgb[at + 2] = color.b;
    }
  }
  return { png: encodeRgbPng(width, height, rgb), raw: firstRaw };
}

async function readPixel(relay: CraftOfficeRelayLike, taskId: string, app: CraftOfficeApp, x: number, y: number): Promise<unknown> {
  const params = { x, y };
  try {
    const executed = await relay.enqueue(taskId, app, "engine.execute", { command: "document.pixel", params });
    if (pixelColor(executed)) return executed;
    const direct = await relay.enqueue(taskId, app, "document.pixel", params);
    return pixelColor(direct) ? direct : { execute: executed, direct };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function pixelColor(value: unknown): { r: number; g: number; b: number } | null {
  if (typeof value === "string") return hexColor(value);
  if (Array.isArray(value)) return channelColor(value);
  let current: unknown = value;
  for (let depth = 0; depth < 4 && current && typeof current === "object" && !Array.isArray(current); depth += 1) {
    const record = current as Record<string, unknown>;
    const channels = channelColor([record["r"] ?? record["red"], record["g"] ?? record["green"], record["b"] ?? record["blue"]]);
    if (channels) return channels;
    const nested = record["result"] ?? record["color"] ?? record["pixel"] ?? record["rgb"] ?? record["rgba"] ?? record["hex"] ?? record["value"];
    if (nested !== undefined) {
      const found = pixelColor(nested);
      if (found) return found;
      current = nested;
      continue;
    }
    break;
  }
  return null;
}

function channelColor(value: unknown[]): { r: number; g: number; b: number } | null {
  if (value.length < 3 || !value.slice(0, 3).every((channel) => typeof channel === "number")) return null;
  const nums = value.slice(0, 3) as number[];
  const scale = Math.max(...nums) <= 1 ? 255 : 1;
  return { r: clampByte(nums[0]! * scale), g: clampByte(nums[1]! * scale), b: clampByte(nums[2]! * scale) };
}

function hexColor(value: string): { r: number; g: number; b: number } | null {
  const hex = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!hex) return null;
  const n = Number.parseInt(hex[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function encodeRgbPng(width: number, height: number, rgb: Buffer): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    rgb.copy(raw, row + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(4 + head.length + 4);
  out.writeUInt32BE(data.length, 0);
  head.copy(out, 4);
  out.writeUInt32BE(pngCrc(head), 4 + head.length);
  return out;
}

function pngCrc(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function slideExportBytes(value: unknown): Buffer | null {
  let current = value;
  for (let depth = 0; depth < 2 && current && typeof current === "object" && !Array.isArray(current); depth += 1) {
    const record = current as { ok?: unknown; result?: unknown; data?: unknown; base64?: unknown; bytes?: unknown };
    const encoded =
      typeof record.data === "string" && record.data.length > 0
        ? record.data
        : typeof record.base64 === "string" && record.base64.length > 0
          ? record.base64
          : typeof record.bytes === "string" && record.bytes.length > 0
            ? record.bytes
            : "";
    if (Array.isArray(record.bytes) && record.bytes.length > 4 && record.bytes.every((item) => typeof item === "number")) {
      return Buffer.from(record.bytes as number[]);
    }
    if (encoded) {
      const bytes = Buffer.from(encoded, "base64");
      return bytes.length > 0 ? bytes : null;
    }
    if (record.ok === true && "result" in record) {
      current = record.result;
      continue;
    }
    break;
  }
  return null;
}

function writeSlideUpload(base: string, taskId: string, bytes: Buffer, fileName = "presentation.pptx"): { absolute: string; relative: string } {
  let root: string;
  try {
    root = requireTaskWorkspace(taskId, base);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "task not found") throw error;
    if (!/^task_[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("invalid task id");
    root = path.join(base, ".loam-tasks", taskId);
  }
  const relative = `uploads/${Date.now()}-${fileName}`;
  const absolute = taskPath(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
  return { absolute, relative };
}

function shapeId(shape: Record<string, unknown>): string | number | null {
  const id = shape["id"];
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** The slides editor does not mark Arabic paragraphs rtl. Match the studio export post-pass. */
async function markExportedArabicSlides(file: string): Promise<void> {
  try {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) return;
    const buffer = fs.readFileSync(abs);
    const arabic = /[\u0590-\u08ff]/;
    const zip = await JSZip.loadAsync(buffer);
    let changed = false;
    for (const name of Object.keys(zip.files)) {
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
      const entry = zip.file(name);
      if (!entry) continue;
      let xml = await entry.async("string");
      if (!arabic.test(xml) || xml.includes('rtl="1"')) continue;
      xml = xml.replace(/<a:pPr\b([^>]*?)>/g, '<a:pPr rtl="1"$1>');
      if (!xml.includes('rtl="1"')) xml = xml.replace(/<a:p\b/g, '<a:p rtl="1"');
      xml = xml.replace(/<a:latin typeface="[^"]*"/g, '<a:latin typeface="Segoe UI"');
      if (!xml.includes("<a:cs ")) xml = xml.replace(/<a:latin typeface="Segoe UI"\/>/g, '<a:latin typeface="Segoe UI"/><a:cs typeface="Segoe UI"/>');
      zip.file(name, xml);
      changed = true;
    }
    if (!changed) return;
    fs.writeFileSync(abs, Buffer.from(await zip.generateAsync({ type: "nodebuffer" })));
  } catch {
    // The exported file remains the editor's bytes when the post-pass cannot rewrite it.
  }
}

/** The task-file path a `craft.waitSave` returned. */
function storedPathOf(stored: unknown): string | null {
  if (stored && typeof stored === "object") {
    const value = (stored as { path?: unknown }).path;
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/**
 * A notice describing what the panel holds, so the agent adapts instead of
 * repeating an edit. Null when there is nothing to report.
 */
export function manualEditNotice(
  state: { reads: ReadonlyArray<{ method: string; ok: boolean }>; summary: unknown } | null,
): string | null {
  if (!state) return null;
  const failed = state.reads.filter((read) => !read.ok).map((read) => read.method);
  if (failed.length > 0) {
    return `Some state reads did not answer (${failed.join(", ")}); the summary may be incomplete.`;
  }
  return null;
}

/** Attach a fallback note to a built-in implementation result. */
function withFallbackNote(result: ToolResult, app: CraftOfficeApp, reason: string): ToolResult {
  const note = `${reason} Used the built-in Loam implementation for ${CRAFT_OFFICE_APP_NAMES[app]} instead.`;
  let body: unknown;
  try {
    body = JSON.parse(result.content);
  } catch {
    body = { content: result.content };
  }
  const merged =
    body && typeof body === "object" && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), fallback: CRAFT_OFFICE_FALLBACK_TOOL, fallbackReason: reason, fallbackNote: note }
      : { fallback: CRAFT_OFFICE_FALLBACK_TOOL, fallbackReason: reason, fallbackNote: note, result: body };
  return { ok: result.ok, content: JSON.stringify(merged) };
}

/** Re-wrap a failure envelope with the step that failed inside a batch. */
function withFailedStep(
  content: string,
  step: number,
  command: string,
  completed: ReadonlyArray<{ method: string; ok: boolean; command: string }>,
): string {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content);
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    body = { message: content };
  }
  return JSON.stringify({ ...body, failedStep: step, command, completed: completed.length, steps: completed });
}

export const CRAFT_OFFICE_TOOL_NAMES = ["office_craft"];
