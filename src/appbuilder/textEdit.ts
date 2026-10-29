// src/appbuilder/textEdit.ts — MISSING §4.8.5: direct text edits from the App
// Viewer, zero tokens. `src` is the data-loam-src locator "src/pages/Index.tsx:42:7".
// Replaces only when exactly one match exists in the 40-line window; JSX-meaning
// characters in `after` never go through this path (they go to the Engineer).
import fs from "node:fs";
import path from "node:path";

export type TextEditResult =
  | { status: "applied"; file: string }
  | { status: "ambiguous" | "not_found" | "bad_input"; file: string | null };

const JSX_TEXT_UNSAFE = /[{}<>]/;

/** The composer prompt the route returns when the direct edit could not apply (§4.8.5). */
export function textEditPrompt(r: { status: string; file: string | null }, before: string, after: string): string {
  return `In ${r.file ?? "the app"}, change the text "${before.slice(0, 120)}" to "${after.slice(0, 120)}". Change nothing else.`;
}

/**
 * Looks for `before` as JSX text in the element that starts on that line,
 * within the next 40 lines. Replaces only when exactly one match exists in that window.
 */
export function applyTextEdit(appDir: string, src: string, before: string, after: string): TextEditResult {
  const m = /^(src\/[\w./-]+\.tsx):(\d+):(\d+)$/.exec(src);
  if (!m || before.trim() === "" || after.length > 2_000 || JSX_TEXT_UNSAFE.test(after)) return { status: "bad_input", file: m?.[1] ?? null };
  const rel = m[1]!;
  const abs = path.resolve(appDir, rel);
  if (!abs.startsWith(path.resolve(appDir, "src") + path.sep) || !fs.existsSync(abs)) return { status: "not_found", file: rel };

  const text = fs.readFileSync(abs, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const startLine = Number(m[2]) - 1;
  const windowText = lines.slice(startLine, startLine + 40).join(eol);
  const needle = before.trim();
  const first = windowText.indexOf(needle);
  if (first < 0) return { status: "not_found", file: rel };
  if (windowText.indexOf(needle, first + needle.length) >= 0) return { status: "ambiguous", file: rel };

  const prefix = lines.slice(0, startLine).join(eol);
  const offset = (startLine > 0 ? prefix.length + eol.length : 0) + first;
  const next = text.slice(0, offset) + after.trim() + text.slice(offset + needle.length);
  fs.writeFileSync(abs, next, "utf8");
  return { status: "applied", file: rel };
}
