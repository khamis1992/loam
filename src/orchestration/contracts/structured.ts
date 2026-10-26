/**
 * C6: structured output at every model boundary the Core owns (ledger, plan,
 * selector, judge, workflow agent nodes with an output schema). One call, one
 * validation, and at most `repairAttempts` repair calls that show the model
 * its own output and the exact schema issues. Never silently coerces.
 */
import type { ChatMessage } from "../../ollama.js";
import type { ModelPort } from "../modelPort.js";
import { describeIssues, extractJson, validate, type JsonSchema, type SchemaIssue } from "./schema.js";

export interface StructuredRequest {
  model: string;
  /** Short name used in spans, events and errors, e.g. "progress_ledger". */
  contract: string;
  schema: JsonSchema;
  messages: ChatMessage[];
  repairAttempts: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type StructuredResult<T> =
  | { ok: true; value: T; attempts: number; promptTokens: number; completionTokens: number }
  | { ok: false; error: "unparseable" | "schema_mismatch"; issues: SchemaIssue[]; raw: string; attempts: number; promptTokens: number; completionTokens: number };

export function schemaInstruction(schema: JsonSchema): string {
  return [
    "Reply with one JSON value only, no prose before or after it.",
    "It must satisfy this JSON Schema:",
    JSON.stringify(schema),
  ].join("\n");
}

export async function callStructured<T>(port: ModelPort, req: StructuredRequest): Promise<StructuredResult<T>> {
  const messages: ChatMessage[] = [...req.messages, { role: "user", content: schemaInstruction(req.schema) }];
  let attempts = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let raw = "";
  let issues: SchemaIssue[] = [];
  let error: "unparseable" | "schema_mismatch" = "unparseable";
  for (;;) {
    attempts++;
    const res = await port({ model: req.model, messages, temperature: req.temperature ?? 0, timeoutMs: req.timeoutMs, signal: req.signal });
    promptTokens += res.usage.promptTokens;
    completionTokens += res.usage.completionTokens;
    raw = res.content;
    const parsed = extractJson(raw);
    if (parsed === undefined) {
      error = "unparseable";
      issues = [{ path: "$", message: "no JSON value found" }];
    } else {
      issues = validate(req.schema, parsed);
      if (issues.length === 0) return { ok: true, value: parsed as T, attempts, promptTokens, completionTokens };
      error = "schema_mismatch";
    }
    if (attempts > req.repairAttempts) break;
    messages.push(
      { role: "assistant", content: raw.slice(0, 4000) },
      {
        role: "user",
        content: `Your reply did not satisfy the schema: ${describeIssues(issues)}. Send the corrected JSON value only.`,
      },
    );
  }
  return { ok: false, error, issues, raw, attempts, promptTokens, completionTokens };
}
