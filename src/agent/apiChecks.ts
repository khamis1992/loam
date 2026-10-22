import type { BackendSandbox } from "./backendSandbox.js";

export interface ApiRequest { method: string; path: string; body?: string; expectedJson?: unknown }
export interface ApiCheck { requests: ApiRequest[]; statuses: number[] }
export interface ApiObservation { group: number; method: string; path: string; status?: number; error?: string; responseJson?: unknown }

export function canonicalApiJson(value: unknown): string {
  let nodes = 0;
  const encode = (v: unknown, depth: number): string => {
    if (++nodes > 2000 || depth > 16) throw new Error("API JSON exceeds structural budget");
    if (v === null || typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(x => encode(x, depth + 1)).join(",")}]`;
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${encode((v as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
    throw new Error("API expectations must contain only JSON values");
  };
  const result = encode(value, 0);
  if (result.length > 16000) throw new Error("API JSON exceeds 16000 characters");
  return result;
}

/** Declarative local requests only; no executable code, headers or external URLs. */
export function validateApiChecks(value: unknown): asserts value is ApiCheck[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length || value.length > 8) throw new Error("apiChecks requires 1–8 request groups");
  let total = 0;
  for (const group of value) {
    if (!group || Object.keys(group).some(k => !["requests", "statuses"].includes(k)) || !Array.isArray(group.requests) || !group.requests.length || group.requests.length > 4 || !Array.isArray(group.statuses) || group.statuses.length !== group.requests.length || group.statuses.some((s: unknown) => !Number.isInteger(s) || Number(s) < 200 || Number(s) > 499)) throw new Error("Invalid API group: 1–4 requests and matching expected status multiset (200–499) required");
    total += group.requests.length;
    if (total > 16) throw new Error("At most 16 direct API requests per scenario");
    for (const r of group.requests) {
      if (!r || Object.keys(r).some(k => !["method", "path", "body", "expectedJson"].includes(k)) || !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(r.method) || typeof r.path !== "string" || r.path.length > 1000 || !r.path.startsWith("/") || r.path.startsWith("//") || /[\\#\x00-\x20]/.test(r.path) || (r.body !== undefined && (typeof r.body !== "string" || r.body.length > 16000 || ["GET", "HEAD"].includes(r.method)))) throw new Error("Invalid bounded same-origin API request");
      if (Object.hasOwn(r, "expectedJson")) canonicalApiJson(r.expectedJson);
    }
  }
}

export async function runApiChecks(backend: Pick<BackendSandbox, "request">, checks: ApiCheck[], observed: ApiObservation[], signal?: AbortSignal): Promise<void> {
  validateApiChecks(checks);
  for (const [groupIndex, group] of checks.entries()) {
    signal?.throwIfAborted();
    // Drain all requests before returning a failure or closing the sandbox.
    const results = await Promise.allSettled(group.requests.map(r => backend.request(r.path, r.method, { "content-type": "application/json" }, Buffer.from(r.body ?? "").toString("base64"), signal)));
    const statuses: number[] = [];
    results.forEach((result, i) => {
      const request = group.requests[i]!;
      if (result.status === "fulfilled") {
        statuses.push(result.value.status);
        const observation: ApiObservation = { group: groupIndex, method: request.method, path: request.path, status: result.value.status };
        observed.push(observation);
        if (Object.hasOwn(request, "expectedJson")) {
          try {
            const raw = Buffer.from(result.value.body, "base64").toString("utf8");
            if (raw.length > 16000) throw new Error("API JSON response exceeds 16000 characters");
            const actual: unknown = JSON.parse(raw);
            const normalized = canonicalApiJson(actual);
            observation.responseJson = actual;
            if (normalized !== canonicalApiJson(request.expectedJson)) throw new Error(`API JSON mismatch for request ${i}: expected ${canonicalApiJson(request.expectedJson).slice(0, 500)}, observed ${normalized.slice(0, 500)}`);
          } catch (error) { observation.error = String(error); }
        }
      } else observed.push({ group: groupIndex, method: request.method, path: request.path, error: String(result.reason) });
    });
    signal?.throwIfAborted();
    if (observed.some(r => r.group === groupIndex && r.error) || JSON.stringify(statuses.sort()) !== JSON.stringify([...group.statuses].sort())) throw new Error(`API group ${groupIndex} mismatch: expected statuses ${JSON.stringify(group.statuses)}, observed ${JSON.stringify(observed.filter(r => r.group === groupIndex)).slice(0, 4000)}`);
  }
}
