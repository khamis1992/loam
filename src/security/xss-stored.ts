import { inScope, type CampaignScope } from "./scope.js";
import type { BrowserOptions } from "./browser.js";

// Stored cross-site scripting probing: an operator-declared case stores a
// harmless canary through an authorized POST (the canary replaces one declared
// JSON field of the fresh body), then a separate isolated viewer context loads
// the declared view. A baseline navigation of that view before the storage
// submission must render cleanly without the fresh marker, which attributes
// any later execution to the stored payload.

export interface StoredXssCase {
  id: string;
  postPath: string;
  bodyRef: string;
  field: string;
  viewPath: string;
}

const ref = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);

export function normalizeStoredXssCases(value: unknown, scope: CampaignScope, options: BrowserOptions): StoredXssCase[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) throw Error("At most five stored XSS cases");
  const cases = value.map((item): StoredXssCase => {
    if (!item || typeof item !== "object") throw Error("Stored XSS case must be an object");
    const raw = item as Record<string, unknown>;
    if (!ref(raw.id) || !ref(raw.bodyRef)) throw Error("Stored XSS case requires id and bodyRef");
    if (!ref(raw.field)) throw Error("Stored XSS case requires a body field name");
    for (const key of ["postPath", "viewPath"] as const) {
      if (typeof raw[key] !== "string" || !raw[key]!.startsWith("/") || raw[key]!.startsWith("//") || /[?#%\\]/.test(raw[key]!) || new URL(raw[key] as string, scope.seeds[0]!).pathname !== raw[key]) throw Error("Stored XSS case requires an exact " + (key === "postPath" ? "POST" : "view") + " path without query or fragment");
      if (!inScope(scope, new URL(raw[key] as string, scope.seeds[0]!).href)) throw Error("Stored XSS " + (key === "postPath" ? "POST" : "view") + " path is outside the approved scope");
    }
    if (!options.postPaths.includes(raw.postPath as string)) throw Error("Stored XSS case path must be allowlisted in postPaths");
    return { id: raw.id as string, postPath: raw.postPath as string, bodyRef: raw.bodyRef as string, field: raw.field as string, viewPath: raw.viewPath as string };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Stored XSS case ids must be unique");
  return cases;
}

// Replaces (or adds) the declared field with the canary payload, returning the
// serialized body that the authorized submission will carry.
export function injectCanaryField(bodyText: string, field: string, payload: string): string {
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  body[field] = payload;
  return JSON.stringify(body);
}
