import { inScope, type CampaignScope } from "./scope.js";
import type { BrowserOptions } from "./browser.js";

// Cross-site request forgery probing: an operator-declared state-changing POST
// (already allowlisted in postPaths) is first executed same-origin with the
// victim session as the positive control, then submitted from a synthetic
// foreign-origin page served by the local harness. The cross-origin request is
// a simple no-cors fetch, so the browser's own cookie policy (SameSite) and the
// server's defenses (session, tokens) decide whether it carries the victim
// session; only an actual cross-origin application of the declared effect is
// reported as CSRF.

export interface CsrfCase {
  id: string;
  path: string;
  bodyRef: string;
  statePath: string;
  statePointer: string;
  stateDelta: number;
}

const ref = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);

export function normalizeCsrfCases(value: unknown, scope: CampaignScope, options: BrowserOptions): CsrfCase[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) throw Error("At most five CSRF cases");
  const cases = value.map((item): CsrfCase => {
    if (!item || typeof item !== "object") throw Error("CSRF case must be an object");
    const raw = item as Record<string, unknown>;
    if (!ref(raw.id) || !ref(raw.bodyRef)) throw Error("CSRF case requires id and bodyRef");
    if (typeof raw.path !== "string" || !raw.path.startsWith("/") || raw.path.startsWith("//") || /[?#%\\]/.test(raw.path) || new URL(raw.path, scope.seeds[0]!).pathname !== raw.path) throw Error("CSRF case requires an exact POST path without query or fragment");
    if (!inScope(scope, new URL(raw.path, scope.seeds[0]!).href)) throw Error("CSRF POST path is outside the approved scope");
    if (!options.postPaths.includes(raw.path)) throw Error("CSRF case path must be allowlisted in postPaths");
    if (typeof raw.statePath !== "string" || !raw.statePath.startsWith("/") || raw.statePath.startsWith("//") || /[?#%\\]/.test(raw.statePath) || new URL(raw.statePath, scope.seeds[0]!).pathname !== raw.statePath) throw Error("CSRF case requires an exact state path without query or fragment");
    if (!inScope(scope, new URL(raw.statePath, scope.seeds[0]!).href)) throw Error("CSRF state path is outside the approved scope");
    const pointer = raw.statePointer === undefined ? "" : raw.statePointer;
    if (typeof pointer !== "string" || pointer.length > 300 || (pointer !== "" && !pointer.startsWith("/")) || /~(?:[^01]|$)/.test(pointer)) throw Error("CSRF state pointer must be a JSON Pointer");
    const delta = raw.stateDelta === undefined ? 1 : raw.stateDelta;
    if (typeof delta !== "number" || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1e12) throw Error("CSRF state delta must be a nonzero integer up to 1000000000000");
    return { id: raw.id, path: raw.path, bodyRef: raw.bodyRef, statePath: raw.statePath, statePointer: pointer, stateDelta: delta };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("CSRF case ids must be unique");
  return cases;
}

export function csrfHarnessHtml(target: string, body: string): string {
  // The harness page never loads application script or data; it only issues one
  // simple cross-origin request and records locally whether it was sent.
  return `<!doctype html><html><body><h1>Loam cross-origin CSRF probe</h1><script>
(async()=>{try{await fetch(${JSON.stringify(target)},{method:'POST',mode:'no-cors',credentials:'include',headers:{'content-type':'text/plain'},body:${JSON.stringify(body)}});document.documentElement.setAttribute('data-loam-csrf','sent');}catch(e){document.documentElement.setAttribute('data-loam-csrf','failed');}})();
</script></body></html>`;
}
