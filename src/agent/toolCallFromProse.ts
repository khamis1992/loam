import type { OllamaToolCall } from "../ollama.js";

const CALL = /(?:^|[^a-z])call(?:ed)?\s+`?([A-Za-z_][A-Za-z0-9_]*)`?\s+with\s+([^\n]{0,2000})/gi;
const ARG = /`([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]*)"`/g;
const NAMED_KEY = /\b(action|app|title|body|text|format|file|command|path|content|preset|output|mediaPath|target|check|query|url|projectDir|install|build|dir|kind|expectedRevision|atSec|name|params|search|lawKey|label|repo|brief|effort|runId|head|draft)\s+(['"])/gi;

function quotedArgs(clause: string): Record<string, string> {
  const named: Record<string, string> = {};
  for (const arg of clause.matchAll(NAMED_KEY)) {
    const key = arg[1];
    const quote = arg[2];
    const start = (arg.index ?? 0) + arg[0].length;
    const end = quote ? clause.indexOf(quote, start) : -1;
    if (!key || !quote || end < 0 || key in named) continue;
    named[key] = clause.slice(start, end);
    if (Object.keys(named).length >= 8) break;
  }
  if (Object.keys(named).length > 0) return named;
  const args: Record<string, string> = {};
  for (const arg of clause.matchAll(ARG)) {
    const key = arg[1];
    const value = arg[2];
    if (!key || value === undefined || key in args) continue;
    args[key] = value;
    if (Object.keys(args).length >= 8) break;
  }
  return args;
}

/** The current plan step wins over a call quoted from an earlier step. */
export function instructedToolCall(prompt: string, allowed: readonly string[]): OllamaToolCall | null {
  const marker = "\nINSTRUCTION:\n";
  const at = prompt.lastIndexOf(marker);
  if (at >= 0) {
    const rest = prompt.slice(at + marker.length);
    const end = rest.indexOf("\nSUCCESS CRITERIA:");
    const fromStep = toolCallFromProse(end < 0 ? rest : rest.slice(0, end), allowed);
    if (fromStep) return fromStep;
  }
  return toolCallFromProse(prompt, allowed);
}

/** A model that describes one allowed tool call instead of emitting tool_calls. */
export function toolCallFromProse(text: string, allowed: readonly string[]): OllamaToolCall | null {
  CALL.lastIndex = 0;
  for (const match of text.matchAll(CALL)) {
    const name = match[1] ?? "";
    if (!allowed.includes(name)) continue;
    const args = quotedArgs(match[2] ?? "");
    if (Object.keys(args).length === 0) continue;
    return { function: { name, arguments: args } };
  }
  return null;
}
