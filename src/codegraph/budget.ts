import type { CodeGraphOutcome } from "./types.js";

/** UTF-8-safe byte cap with an explicit notice the model can act on. */
export function capBytes(text: string, maxBytes: number, hint: string): { text: string; truncated: boolean; bytes: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false, bytes: buf.byteLength };
  const notice = `\n[loam: output cut at ${maxBytes} bytes of ${buf.byteLength}. ${hint}]`;
  const room = Math.max(0, maxBytes - Buffer.byteLength(notice, "utf8"));
  let cut = buf.subarray(0, room).toString("utf8");
  // Drop a trailing replacement char produced by slicing inside a multi-byte sequence.
  if (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  const out = cut + notice;
  return { text: out, truncated: true, bytes: Buffer.byteLength(out, "utf8") };
}

/** Classify graphify's text (MCP) by the exact prefixes OBSERVED in graphify/serve.py. */
export function classifyGraphifyText(text: string, isError: boolean): CodeGraphOutcome {
  const t = text.trimStart();
  if (isError || t.startsWith("Error executing") || t.startsWith("Unknown tool:")) return "error";
  if (t.startsWith("Ambiguous: ")) return "ambiguous";
  // "No unique node match" is the Windows 0.9.95 CLI form for a missing symbol (exit 0, U-7 deviation).
  if (t.startsWith("No node matching") || t.startsWith("No unique node match") || t.startsWith("No path found") || /^Community -?\d+ not found\./.test(t)) return "not-found";
  if (t.startsWith("graph.json not found") || t.includes("could not load graph.json")) return "not-indexed";
  if (t.includes("[!] TRUNCATED")) return "truncated";
  return "answer";
}

/** Classify graphify CLI exit codes (OBSERVED `graphify --help`: 0 answer, 3 ambiguous, 4 no match). */
export function classifyCliExit(code: number | null): CodeGraphOutcome {
  if (code === 0) return "answer";
  if (code === 3) return "ambiguous";
  if (code === 4) return "not-found";
  return "error";
}
