/** Bounded JSON parsing shared by the findings and ledger validators. */

export interface JsonLimits {
  maxBytes: number;
  maxDepth: number;
  maxTopLevel: number;
  maxCollection: number;
  maxFields: number;
  maxValues: number;
  maxErrors: number;
}

export const FINDINGS_LIMITS: JsonLimits = {
  maxBytes: 5 * 1024 * 1024, maxDepth: 64, maxTopLevel: 1000, maxCollection: 1000, maxFields: 1000, maxValues: 500_000, maxErrors: 100,
};
export const LEDGER_LIMITS: JsonLimits = { ...FINDINGS_LIMITS, maxTopLevel: 10_000 };

export type ParseOutcome = { ok: true; value: unknown } | { ok: false; errors: string[] };

/** Parses and traverses once, enforcing every size/shape limit. `x_*` fields count toward limits. */
export function parseBounded(bytes: Buffer, lim: JsonLimits): ParseOutcome {
  if (bytes.length > lim.maxBytes) return { ok: false, errors: [`input exceeds ${lim.maxBytes} bytes`] };
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    return { ok: false, errors: [`invalid JSON: ${(e as Error).message}`] };
  }
  const errors: string[] = [];
  let seen = 0;
  const push = (m: string): void => {
    if (errors.length < lim.maxErrors) errors.push(m);
  };
  const visit = (v: unknown, depth: number, at: string, top: boolean): void => {
    if (errors.length >= lim.maxErrors) return;
    if (++seen > lim.maxValues) {
      push(`more than ${lim.maxValues} values`);
      return;
    }
    if (depth > lim.maxDepth) {
      push(`${at}: nesting deeper than ${lim.maxDepth}`);
      return;
    }
    if (Array.isArray(v)) {
      const cap = top ? lim.maxTopLevel : lim.maxCollection;
      if (v.length > cap) push(`${at}: more than ${cap} entries`);
      for (let i = 0; i < Math.min(v.length, cap); i++) visit(v[i], depth + 1, `${at}[${i}]`, false);
    } else if (v && typeof v === "object") {
      const keys = Object.keys(v);
      if (keys.length > lim.maxFields) push(`${at}: more than ${lim.maxFields} fields`);
      for (const k of keys.slice(0, lim.maxFields)) visit((v as Record<string, unknown>)[k], depth + 1, `${at}.${k}`, false);
    }
  };
  visit(value, 1, "$", true);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
