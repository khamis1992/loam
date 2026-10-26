/**
 * C6: a small, dependency-free JSON-Schema subset validator. Loam has no zod
 * (OBSERVED: no zod in package.json), and the Core must not add a schema
 * dependency, so every boundary contract is written in this subset:
 *   type (object|array|string|number|integer|boolean|null, or a list of them),
 *   properties, required, additionalProperties (boolean), enum, const,
 *   items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum.
 */
export type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface JsonSchema {
  type?: JsonType | JsonType[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: ReadonlyArray<string | number | boolean | null>;
  const?: string | number | boolean | null;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

export interface SchemaIssue {
  path: string;
  message: string;
}

function typeOf(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  return "object";
}

function typeMatches(actual: JsonType, wanted: JsonType): boolean {
  return actual === wanted || (wanted === "number" && actual === "integer");
}

export function validate(schema: JsonSchema, value: unknown, path = "$", out: SchemaIssue[] = []): SchemaIssue[] {
  if (out.length >= 20) return out;
  const actual = typeOf(value);
  if (schema.type) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wanted.some((w) => typeMatches(actual, w))) {
      out.push({ path, message: `expected ${wanted.join("|")}, got ${actual}` });
      return out;
    }
  }
  if (schema.const !== undefined && value !== schema.const) out.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  if (schema.enum && !schema.enum.includes(value as string | number | boolean | null)) {
    out.push({ path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` });
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push({ path, message: `shorter than ${schema.minLength}` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push({ path, message: `longer than ${schema.maxLength}` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) out.push({ path, message: `does not match ${schema.pattern}` });
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push({ path, message: `below ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) out.push({ path, message: `above ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push({ path, message: `fewer than ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push({ path, message: `more than ${schema.maxItems} items` });
    if (schema.items) value.forEach((item, i) => validate(schema.items as JsonSchema, item, `${path}[${i}]`, out));
  }
  if (actual === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) out.push({ path: `${path}.${key}`, message: "is required" });
    }
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub) validate(sub, v, `${path}.${key}`, out);
      else if (schema.additionalProperties === false) out.push({ path: `${path}.${key}`, message: "is not allowed" });
    }
  }
  return out;
}

/**
 * Pulls the first JSON value out of model text: a ```json fence first, then
 * the first balanced {...} or [...] span. Returns undefined when none parses.
 */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates: string[] = [];
  if (fence?.[1]) candidates.push(fence[1].trim());
  for (const open of ["{", "["] as const) {
    const close = open === "{" ? "}" : "]";
    const start = text.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        candidates.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c) as unknown;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

export function describeIssues(issues: SchemaIssue[]): string {
  return issues.map((i) => `${i.path} ${i.message}`).join("; ");
}
