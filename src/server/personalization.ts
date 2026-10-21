/**
 * User personalization (custom instructions): "about me" + "how to respond".
 * Persisted locally in the app SQLite store and injected into every agent
 * system prompt (see src/agent/prompt.ts). Single-user local app: one record.
 */
import { database } from "./sqliteStore.js";

export interface Personalization {
  aboutMe: string;
  howToRespond: string;
  updatedAt: string;
}

const MAX_LEN = 8000;
const ROW_ID = "user";

function ensureTable(): void {
  database().exec(`CREATE TABLE IF NOT EXISTS personalization (
    id TEXT PRIMARY KEY,
    about_me TEXT NOT NULL DEFAULT '',
    how_to_respond TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );`);
}

function rowToPersonalization(row: Record<string, unknown>): Personalization {
  return {
    aboutMe: String(row.about_me ?? ""),
    howToRespond: String(row.how_to_respond ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export function getPersonalization(): Personalization {
  ensureTable();
  const row = database().prepare("SELECT about_me, how_to_respond, updated_at FROM personalization WHERE id = ?").get(ROW_ID) as
    | Record<string, unknown>
    | undefined;
  return row
    ? rowToPersonalization(row)
    : { aboutMe: "", howToRespond: "", updatedAt: "" };
}

export function savePersonalization(patch: { aboutMe?: unknown; howToRespond?: unknown }): Personalization {
  ensureTable();
  const current = getPersonalization();
  const aboutMe =
    typeof patch.aboutMe === "string" ? patch.aboutMe.trim().slice(0, MAX_LEN) : current.aboutMe;
  const howToRespond =
    typeof patch.howToRespond === "string" ? patch.howToRespond.trim().slice(0, MAX_LEN) : current.howToRespond;
  const updatedAt = new Date().toISOString();
  database()
    .prepare(
      "INSERT INTO personalization (id, about_me, how_to_respond, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET about_me = excluded.about_me, how_to_respond = excluded.how_to_respond, updated_at = excluded.updated_at",
    )
    .run(ROW_ID, aboutMe, howToRespond, updatedAt);
  return { aboutMe, howToRespond, updatedAt };
}

/**
 * Prompt block appended to the agent system prompt; empty string when the
 * user has no custom instructions. Fail-safe: a store problem must never
 * break task execution.
 */
export function personalizationBlock(): string {
  try {
    const p = getPersonalization();
    const lines: string[] = [];
    if (p.aboutMe) lines.push(`About the user: ${p.aboutMe}`);
    if (p.howToRespond) lines.push(`How to respond: ${p.howToRespond}`);
    if (lines.length === 0) return "";
    return `Custom instructions from the user (apply to every task):\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}