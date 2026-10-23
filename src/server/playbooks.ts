/**
 * Playbooks (D9): a versioned, reusable prompt library.
 *
 * A playbook is a named macro (`!name`) plus six authored sections —
 * overview, procedure, specifications, advice, forbidden actions and
 * "needed from user". Every content edit appends an immutable version row, so
 * the history page can diff and restore what the agent was actually told.
 *
 * Storage: SQLite tables `playbooks` / `playbook_versions` inside the app's
 * data directory (same connection as tasks/projects — src/server/sqliteStore.ts).
 *
 * Chat integration: `expandPlaybookMacros` turns `!macro` tokens in a prompt
 * into an appended playbook block, and `renderPlaybookPrompt` is the single
 * place that decides what the model sees.
 */
import crypto from "node:crypto";
import { database, transaction } from "./sqliteStore.js";

/** A macro is `!` + lowercase letters/digits/underscores, starting with a letter. */
export const MACRO_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const NAME_MAX = 120;
export const SECTION_MAX = 20_000;

export interface PlaybookSections {
  overview: string;
  procedure: string;
  specifications: string;
  advice: string;
  forbiddenActions: string;
  neededFromUser: string;
}

export interface Playbook extends PlaybookSections {
  id: string;
  name: string;
  /** Stored without the leading `!`; the composer/chat writes `!macro`. */
  macro: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookVersion extends PlaybookSections {
  id: string;
  playbookId: string;
  version: number;
  createdAt: string;
  createdBy?: string;
}

export interface CreatePlaybookInput extends Partial<PlaybookSections> {
  name: string;
  macro: string;
  createdBy?: string;
}

export type UpdatePlaybookInput = Partial<PlaybookSections> & {
  name?: string;
  macro?: string;
  createdBy?: string;
};

/** The six authored sections, in the order the prompt renders them. */
export const SECTION_KEYS = [
  "overview",
  "procedure",
  "specifications",
  "advice",
  "forbiddenActions",
  "neededFromUser",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

const SECTION_LABELS: Record<SectionKey, string> = {
  overview: "Overview",
  procedure: "Procedure",
  specifications: "Specifications",
  advice: "Advice",
  forbiddenActions: "Forbidden actions",
  neededFromUser: "Needed from user",
};

function newId(): string {
  return `pb_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function newVersionId(): string {
  return `pbv_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function ensureTables(): void {
  const db = database();
  db.exec(`CREATE TABLE IF NOT EXISTS playbooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    macro TEXT NOT NULL UNIQUE,
    overview TEXT NOT NULL DEFAULT '',
    procedure TEXT NOT NULL DEFAULT '',
    specifications TEXT NOT NULL DEFAULT '',
    advice TEXT NOT NULL DEFAULT '',
    forbidden_actions TEXT NOT NULL DEFAULT '',
    needed_from_user TEXT NOT NULL DEFAULT '',
    current_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_playbooks_macro ON playbooks(macro);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_playbooks_name ON playbooks(name);`);

  db.exec(`CREATE TABLE IF NOT EXISTS playbook_versions (
    id TEXT PRIMARY KEY,
    playbook_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    overview TEXT NOT NULL,
    procedure TEXT NOT NULL,
    specifications TEXT NOT NULL,
    advice TEXT NOT NULL,
    forbidden_actions TEXT NOT NULL,
    needed_from_user TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_playbook_versions_playbook ON playbook_versions(playbook_id, version);`);
}

ensureTables();

function rowToPlaybook(row: Record<string, unknown>): Playbook {
  return {
    id: String(row.id),
    name: String(row.name),
    macro: String(row.macro),
    overview: String(row.overview ?? ""),
    procedure: String(row.procedure ?? ""),
    specifications: String(row.specifications ?? ""),
    advice: String(row.advice ?? ""),
    forbiddenActions: String(row.forbidden_actions ?? ""),
    neededFromUser: String(row.needed_from_user ?? ""),
    currentVersion: Number(row.current_version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToVersion(row: Record<string, unknown>): PlaybookVersion {
  return {
    id: String(row.id),
    playbookId: String(row.playbook_id),
    version: Number(row.version),
    overview: String(row.overview),
    procedure: String(row.procedure),
    specifications: String(row.specifications),
    advice: String(row.advice),
    forbiddenActions: String(row.forbidden_actions),
    neededFromUser: String(row.needed_from_user),
    createdAt: String(row.created_at),
    ...(typeof row.created_by === "string" && row.created_by ? { createdBy: row.created_by } : {}),
  };
}

/** `!My_Macro ` / `My_Macro` / `!!my_macro` all normalize to `my_macro`. */
export function normalizeMacro(value: string): string {
  return value.trim().replace(/^!+/, "").trim().toLowerCase();
}

export function isValidMacro(value: string): boolean {
  return MACRO_PATTERN.test(normalizeMacro(value));
}

/** Throws when a macro is empty or malformed; returns the normalized value. */
export function assertValidMacro(value: string): string {
  const macro = normalizeMacro(value);
  if (!macro) throw new Error("macro is required");
  if (!MACRO_PATTERN.test(macro)) {
    throw new Error("macro must be lowercase letters, digits or underscores and start with a letter");
  }
  return macro;
}

function cleanSections(input: Partial<PlaybookSections>): PlaybookSections {
  const out: PlaybookSections = {
    overview: "",
    procedure: "",
    specifications: "",
    advice: "",
    forbiddenActions: "",
    neededFromUser: "",
  };
  for (const key of SECTION_KEYS) {
    const raw = input[key];
    const value = typeof raw === "string" ? raw : "";
    if (value.length > SECTION_MAX) {
      throw new Error(`${key} must be at most ${SECTION_MAX} characters`);
    }
    out[key] = value;
  }
  return out;
}

function assertName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("name is required");
  if (name.length > NAME_MAX) throw new Error(`name must be at most ${NAME_MAX} characters`);
  return name;
}

export function createPlaybook(input: CreatePlaybookInput): Playbook {
  const name = assertName(input.name);
  const macro = assertValidMacro(input.macro);
  const sections = cleanSections(input);
  if (getPlaybookByMacro(macro)) throw new Error(`macro "${macro}" already exists`);

  const id = newId();
  const now = new Date().toISOString();
  return transaction(() => {
    const db = database();
    db.prepare(
      `INSERT INTO playbooks (id, name, macro, overview, procedure, specifications, advice, forbidden_actions, needed_from_user, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, name, macro, sections.overview, sections.procedure, sections.specifications, sections.advice, sections.forbiddenActions, sections.neededFromUser, now, now);

    db.prepare(
      `INSERT INTO playbook_versions (id, playbook_id, version, overview, procedure, specifications, advice, forbidden_actions, needed_from_user, created_at, created_by)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newVersionId(), id, sections.overview, sections.procedure, sections.specifications, sections.advice, sections.forbiddenActions, sections.neededFromUser, now, input.createdBy ?? null);

    return { id, name, macro, ...sections, currentVersion: 1, createdAt: now, updatedAt: now };
  });
}

export function getPlaybook(id: string): Playbook | undefined {
  const row = database().prepare("SELECT * FROM playbooks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToPlaybook(row) : undefined;
}

/** Lookup by macro; the leading `!` is optional and the match is case-insensitive. */
export function getPlaybookByMacro(macro: string): Playbook | undefined {
  const normalized = normalizeMacro(macro);
  if (!normalized) return undefined;
  const row = database().prepare("SELECT * FROM playbooks WHERE macro = ?").get(normalized) as Record<string, unknown> | undefined;
  return row ? rowToPlaybook(row) : undefined;
}

export function listPlaybooks(): Playbook[] {
  const rows = database().prepare("SELECT * FROM playbooks ORDER BY updated_at DESC, name ASC").all() as Record<string, unknown>[];
  return rows.map(rowToPlaybook);
}

/**
 * Update a playbook. A content edit appends a new immutable version; renaming
 * or re-macroing a playbook never creates one (nothing the model reads changed).
 */
export function updatePlaybook(id: string, input: UpdatePlaybookInput): Playbook | undefined {
  const db = database();
  const existing = db.prepare("SELECT * FROM playbooks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!existing) return undefined;

  const before = rowToPlaybook(existing);
  const name = input.name === undefined ? before.name : assertName(input.name);
  const macro = input.macro === undefined ? before.macro : assertValidMacro(input.macro);
  if (macro !== before.macro && getPlaybookByMacro(macro)) {
    throw new Error(`macro "${macro}" already exists`);
  }

  // Start from ONLY the section fields: spreading the whole playbook here would
  // re-apply the old name/macro through `...next` in the return below.
  const next: PlaybookSections = {
    overview: before.overview,
    procedure: before.procedure,
    specifications: before.specifications,
    advice: before.advice,
    forbiddenActions: before.forbiddenActions,
    neededFromUser: before.neededFromUser,
  };
  for (const key of SECTION_KEYS) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") throw new Error(`${key} must be a string`);
    if (raw.length > SECTION_MAX) throw new Error(`${key} must be at most ${SECTION_MAX} characters`);
    next[key] = raw;
  }

  const contentChanged = SECTION_KEYS.some((key) => next[key] !== before[key]);
  const metaChanged = name !== before.name || macro !== before.macro;
  if (!contentChanged && !metaChanged) return before;

  const now = new Date().toISOString();
  const version = contentChanged ? before.currentVersion + 1 : before.currentVersion;

  return transaction(() => {
    db.prepare(
      `UPDATE playbooks SET name = ?, macro = ?, overview = ?, procedure = ?, specifications = ?, advice = ?, forbidden_actions = ?, needed_from_user = ?, current_version = ?, updated_at = ? WHERE id = ?`,
    ).run(name, macro, next.overview, next.procedure, next.specifications, next.advice, next.forbiddenActions, next.neededFromUser, version, now, id);

    if (contentChanged) {
      db.prepare(
        `INSERT INTO playbook_versions (id, playbook_id, version, overview, procedure, specifications, advice, forbidden_actions, needed_from_user, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newVersionId(), id, version, next.overview, next.procedure, next.specifications, next.advice, next.forbiddenActions, next.neededFromUser, now, input.createdBy ?? null);
    }

    return { ...before, name, macro, ...next, currentVersion: version, updatedAt: now };
  });
}

export function deletePlaybook(id: string): boolean {
  return transaction(() => {
    const db = database();
    db.prepare("DELETE FROM playbook_versions WHERE playbook_id = ?").run(id);
    return Number(db.prepare("DELETE FROM playbooks WHERE id = ?").run(id).changes) > 0;
  });
}

/** Newest version first. */
export function listVersions(playbookId: string): PlaybookVersion[] {
  const rows = database()
    .prepare("SELECT * FROM playbook_versions WHERE playbook_id = ? ORDER BY version DESC")
    .all(playbookId) as Record<string, unknown>[];
  return rows.map(rowToVersion);
}

export function getVersion(playbookId: string, version: number): PlaybookVersion | undefined {
  const row = database()
    .prepare("SELECT * FROM playbook_versions WHERE playbook_id = ? AND version = ?")
    .get(playbookId, version) as Record<string, unknown> | undefined;
  return row ? rowToVersion(row) : undefined;
}

/** The version the live playbook currently points at. */
export function getCurrentVersionContent(playbookId: string): PlaybookVersion | undefined {
  const row = database()
    .prepare("SELECT pv.* FROM playbook_versions pv JOIN playbooks p ON p.id = pv.playbook_id WHERE pv.playbook_id = ? AND pv.version = p.current_version")
    .get(playbookId) as Record<string, unknown> | undefined;
  return row ? rowToVersion(row) : undefined;
}

/** Render the block the model receives for one playbook (live or a specific version). */
export function renderPlaybookPrompt(playbook: Playbook, version?: PlaybookVersion): string {
  const content: PlaybookSections = version ?? playbook;
  const lines = [`[Playbook: ${playbook.name} (!${playbook.macro}) v${version?.version ?? playbook.currentVersion}]`];
  for (const key of SECTION_KEYS) {
    const body = content[key].trim();
    if (!body) continue;
    lines.push("", `## ${SECTION_LABELS[key]}`, body);
  }
  return lines.join("\n");
}

export interface MacroExpansion {
  /** The prompt with the resolved playbook blocks appended (unchanged when none matched). */
  text: string;
  /** Playbooks resolved from `!macro` tokens, in first-seen order (deduplicated). */
  attached: Playbook[];
  /** Macros that matched no playbook; their tokens stay in the text untouched. */
  unknown: string[];
}

/** `!macro` at the start of the prompt or after any non-word character. */
const MACRO_TOKEN = /(?:^|[^\w!])(![a-z][a-z0-9_]{0,63})(?![\w])/g;

/**
 * Expand every `!macro` in a chat prompt into its playbook block.
 * Unknown macros are reported and left as written so a typo is visible.
 */
export function expandPlaybookMacros(text: string): MacroExpansion {
  const attached: Playbook[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MACRO_TOKEN)) {
    const macro = match[1]!.slice(1);
    if (seen.has(macro)) continue;
    seen.add(macro);
    const playbook = getPlaybookByMacro(macro);
    if (playbook) attached.push(playbook);
    else unknown.push(macro);
  }
  if (attached.length === 0) return { text, attached, unknown };
  const block = attached.map((p) => renderPlaybookPrompt(p)).join("\n\n");
  return { text: `${text}\n\n${block}`, attached, unknown };
}

/** Turn a free-form name into a valid, still-unused macro. */
export function deriveMacro(name: string, taken: (macro: string) => boolean = (m) => getPlaybookByMacro(m) !== undefined): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+/g, "_")
    .replace(/_+$/, "")
    .slice(0, 56);
  const base = slug || "playbook";
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base.slice(0, 56)}_${i}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base.slice(0, 48)}_${Date.now().toString(36)}`;
}
