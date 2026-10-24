/**
 * Hand-written, fail-closed JSON-schema interpreter. Exactly 16 keywords are
 * supported; an unsupported keyword in a schema is itself an error.
 */

export type SchemaObject = { [k: string]: unknown };

export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "$comment", "additionalProperties", "const", "description", "enum", "items", "minimum", "minItems",
  "minLength", "oneOf", "pattern", "properties", "required", "type", "uniqueItems", "visibleContent",
]);

const VISIBLE = /[^\s\p{Cc}\p{Cf}]/u;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const t = typeOf(v);
  if (want === "number") return t === "number" || t === "integer";
  return t === want;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface SchemaLimits { maxErrors: number }

export function validateSchema(value: unknown, schema: SchemaObject, limits: SchemaLimits = { maxErrors: 100 }): string[] {
  const errors: string[] = [];
  const push = (m: string): void => {
    if (errors.length < limits.maxErrors) errors.push(m);
  };
  walk(value, schema, "$", push, () => errors.length >= limits.maxErrors);
  return errors;
}

function walk(v: unknown, s: SchemaObject, at: string, push: (m: string) => void, full: () => boolean): void {
  if (full()) return;
  for (const k of Object.keys(s)) {
    if (!SUPPORTED_KEYWORDS.has(k)) {
      push(`${at}: unsupported schema keyword "${k}"`);
      return;
    }
  }
  if ("type" in s) {
    const want = s["type"];
    const ok = Array.isArray(want) ? want.some((w) => typeMatches(String(w), v)) : typeMatches(String(want), v);
    if (!ok) {
      push(`${at}: expected ${JSON.stringify(want)}, got ${typeOf(v)}`);
      return;
    }
  }
  if ("const" in s && !deepEqual(v, s["const"])) push(`${at}: must equal ${JSON.stringify(s["const"])}`);
  if (Array.isArray(s["enum"]) && !(s["enum"] as unknown[]).some((e) => deepEqual(e, v))) {
    push(`${at}: not one of ${JSON.stringify(s["enum"])}`);
  }
  if (typeof v === "string") {
    if (typeof s["minLength"] === "number" && v.length < s["minLength"]) push(`${at}: shorter than ${s["minLength"]}`);
    if (typeof s["pattern"] === "string" && !new RegExp(s["pattern"], "u").test(v)) push(`${at}: does not match ${s["pattern"]}`);
    if (s["visibleContent"] === true && !VISIBLE.test(v)) push(`${at}: has no visible content`);
  }
  if (typeof v === "number" && typeof s["minimum"] === "number" && v < s["minimum"]) push(`${at}: below minimum ${s["minimum"]}`);
  if (Array.isArray(v)) {
    if (typeof s["minItems"] === "number" && v.length < s["minItems"]) push(`${at}: fewer than ${s["minItems"]} items`);
    if (s["uniqueItems"] === true) {
      const seen = new Set<string>();
      for (const it of v) {
        const key = JSON.stringify(it);
        if (seen.has(key)) {
          push(`${at}: duplicate items`);
          break;
        }
        seen.add(key);
      }
    }
    if (s["items"] && typeof s["items"] === "object") {
      for (let i = 0; i < v.length && !full(); i++) walk(v[i], s["items"] as SchemaObject, `${at}[${i}]`, push, full);
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    const props = (s["properties"] ?? {}) as Record<string, SchemaObject>;
    if (Array.isArray(s["required"])) {
      for (const r of s["required"] as string[]) if (!(r in obj)) push(`${at}: missing required "${r}"`);
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) walk(obj[k], sub, `${at}.${k}`, push, full);
    }
    if (s["additionalProperties"] === false) {
      for (const k of Object.keys(obj)) if (!(k in props)) push(`${at}: unexpected property "${k}"`);
    } else if (s["additionalProperties"] && typeof s["additionalProperties"] === "object") {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) walk(obj[k], s["additionalProperties"] as SchemaObject, `${at}.${k}`, push, full);
      }
    }
  }
  if (Array.isArray(s["oneOf"])) {
    let matches = 0;
    for (const sub of s["oneOf"] as SchemaObject[]) {
      const errs: string[] = [];
      walk(v, sub, at, (m) => errs.push(m), () => errs.length >= 5);
      if (errs.length === 0) matches++;
    }
    if (matches !== 1) push(`${at}: must match exactly one alternative (matched ${matches})`);
  }
}

/** Convenience builders used by the findings/ledger/agent schemas. */
export const text = (): SchemaObject => ({ type: "string", minLength: 1, visibleContent: true });
export const strArr = (min = 0): SchemaObject => ({ type: "array", items: text(), minItems: min });
