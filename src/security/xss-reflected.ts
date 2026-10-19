import { randomUUID } from "node:crypto";

// Reflected XSS probing: an operator-declared case navigates an isolated
// browser to a scoped path with a harmless canary in one declared query
// parameter. The canary carries a per-run random marker; its image-error
// handler only sets one DOM attribute — no data access, no network request.
// A baseline navigation without the canary must render the same page clean,
// which is what attributes any later execution to the injected parameter.

export interface XssReflectedCase {
  id: string;
  path: string;
  param: string;
}

export interface XssCanary {
  marker: string;
  payload: string;
}

export function newXssCanary(): XssCanary {
  const marker = "loam" + randomUUID().replace(/-/g, "").slice(0, 20);
  const payload = `"><img src=x onerror="document.documentElement.setAttribute('${marker}','${marker}')">`;
  return { marker, payload };
}

export function xssTargetUrl(base: string, param: string, payload: string): string {
  return base + (base.includes("?") ? "&" : "?") + encodeURIComponent(param) + "=" + encodeURIComponent(payload);
}
