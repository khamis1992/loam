import { extractJson } from "../../agent/planner.js";
import type { LegalModelPort, LegalModelRequest } from "./types.js";
import type { JsonSchema } from "./schemas.js";

export interface LegalStructuredRequest extends Omit<LegalModelRequest, "format"> {
  contract: string;
  schema: JsonSchema;
  repairAttempts?: number;
}

export type LegalStructuredResult<T> =
  | { ok: true; value: T; attempts: number; promptTokens: number; completionTokens: number }
  | { ok: false; error: string; issues: string[]; attempts: number };

export function validateLegalJson(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const issues: string[] = [];
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object`];
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) issues.push(`${path}.${key}: required`);
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(record)) if (!allowed.has(key)) issues.push(`${path}.${key}: unexpected property`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in record) issues.push(...validateLegalJson(record[key], child, `${path}.${key}`));
  } else if (type === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${path}: minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${path}: maxItems ${schema.maxItems}`);
    if (schema.items) value.forEach((item, index) => issues.push(...validateLegalJson(item, schema.items!, `${path}[${index}]`)));
  } else if (type === "string") {
    if (typeof value !== "string") return [`${path}: expected string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${path}: minLength ${schema.minLength}`);
  } else if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return [`${path}: expected number`];
  else if (type === "integer" && !Number.isInteger(value)) return [`${path}: expected integer`];
  else if (type === "boolean" && typeof value !== "boolean") return [`${path}: expected boolean`];
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) issues.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`);
  return issues;
}

export async function callLegalStructured<T>(port: LegalModelPort, req: LegalStructuredRequest): Promise<LegalStructuredResult<T>> {
  const messages = [...req.messages, { role: "user" as const, content: `Reply with one JSON value only, no prose. Contract: ${req.contract}. Schema: ${JSON.stringify(req.schema)}` }];
  const attemptsAllowed = Math.max(0, req.repairAttempts ?? 1) + 1;
  let promptTokens = 0;
  let completionTokens = 0;
  for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
    const result = await port({ ...req, messages, format: req.schema });
    promptTokens += result.usage.promptTokens;
    completionTokens += result.usage.completionTokens;
    const parsed = extractJson(result.content) as unknown;
    const issues = parsed === undefined ? ["$: no JSON value"] : validateLegalJson(parsed, req.schema);
    if (parsed !== undefined && issues.length === 0) return { ok: true, value: parsed as T, attempts: attempt, promptTokens, completionTokens };
    if (attempt === attemptsAllowed) return { ok: false, error: parsed === undefined ? "unparseable" : "schema_mismatch", issues, attempts: attempt };
    messages.push({ role: "assistant", content: result.content.slice(0, 4000) }, { role: "user", content: `Fix the JSON to satisfy the schema. Errors: ${issues.join("; ")}` });
  }
  return { ok: false, error: "unreachable", issues: [], attempts: attemptsAllowed };
}
