import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { inScope, type CampaignScope, type RequestEvidence } from "./scope.js";
import { coverageKey } from "./findings.js";
import type { PentestFinding } from "../tools/pentest.js";

// Server-side request forgery verification with an out-of-band witness. The
// engine runs a local loopback listener; each case submits a benign baseline
// first (the listener must stay silent — the negative control), then a probe
// URL pointing at that listener with a fresh random token. Only the target
// application's own server-side fetch can hit the listener, so a callback
// carrying the token proves the application fetched an attacker-influenced
// URL. No third-party hosts are ever contacted.

export interface SsrfCase {
  id: string;
  kind: "get" | "post";
  path: string;
  field: string;
  benignRef: string;
}
export interface SsrfProof {
  id: string; at: string; kind: "ssrf"; caseId: string; target: string;
  outcome: "observed" | "not_observed" | "inconclusive";
  summary: string; requestIds: string[];
  observations: Record<string, string | number | boolean>;
}

const ref = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);

export function normalizeSsrfCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign", postPaths: string[]): SsrfCase[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length) return [];
  if (profile !== "campaign") throw Error("SSRF cases require campaign mode");
  if (!scope.seeds.length) throw Error("SSRF cases require a scoped target");
  if (value.length > 5) throw Error("At most five SSRF cases");
  const cases = value.map((item): SsrfCase => {
    if (!item || typeof item !== "object") throw Error("SSRF case must be an object");
    const raw = item as Record<string, unknown>;
    if (!ref(raw.id) || !ref(raw.benignRef)) throw Error("SSRF case requires id and benignRef");
    if (raw.kind !== "get" && raw.kind !== "post") throw Error("SSRF case kind must be get or post");
    if (typeof raw.field !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(raw.field) || /^(?:action|cmd|command|delete|logout|method)$/i.test(raw.field)) throw Error("SSRF case requires a safe field or parameter name");
    if (typeof raw.path !== "string" || !raw.path.startsWith("/") || raw.path.startsWith("//") || /[?#%\\]/.test(raw.path) || new URL(raw.path, scope.seeds[0]!).pathname !== raw.path) throw Error("SSRF case requires an exact path without query or fragment");
    if (!inScope(scope, new URL(raw.path, scope.seeds[0]!).href)) throw Error("SSRF case path is outside the approved scope");
    if (raw.kind === "post" && !postPaths.includes(raw.path)) throw Error("SSRF POST path must be allowlisted in postPaths");
    return { id: raw.id as string, kind: raw.kind, path: raw.path, field: raw.field, benignRef: raw.benignRef as string };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("SSRF case ids must be unique");
  return cases;
}

// The benign baseline value is operator-supplied, fresh per run and never
// recorded; it must not be a URL the application would fetch.
export function normalizeSsrfValues(value: unknown, cases: SsrfCase[]): Record<string, string> {
  if (!cases.length) return {};
  if (value === undefined || !value || typeof value !== "object" || Array.isArray(value)) throw Error("SSRF cases require fresh input: " + cases[0]!.benignRef);
  const values = value as Record<string, unknown>, result: Record<string, string> = {};
  for (const c of cases) {
    const benign = values[c.benignRef];
    if (benign === undefined) throw Error("Supply fresh business input: " + c.benignRef);
    if (typeof benign !== "string" || !benign.trim() || benign.length > 512) throw Error("SSRF baseline must be a nonempty string up to 512 bytes: " + c.benignRef);
    result[c.benignRef] = benign;
  }
  return result;
}

export type SsrfEngineInput = {
  scope: CampaignScope; secrets: Record<string, string>;
  auth: Record<string, string>; signal: AbortSignal; evidence: RequestEvidence[];
  reserve: () => Promise<{ id: string; at: number }>; redact: (value: string) => string;
  result: { proofs: SsrfProof[]; incomplete: boolean };
  publish: (proof: SsrfProof, findings: PentestFinding[], covered: string[]) => void;
};

export async function runSsrfCases(input: SsrfEngineInput, cases: SsrfCase[]): Promise<void> {
  const { scope, secrets, auth, signal, evidence, reserve, redact, result } = input;
  const hash = (data: string) => createHash("sha256").update(data).digest("hex");
  const scrub = (v: string) => Object.values(secrets).reduce((acc, s) => s ? acc.split(s).join("[REDACTED]") : acc, redact(v));
  // Loopback callback listener: only the target application under test can
  // reach it, and hit tokens are recorded without echoing any payload.
  const hits: string[] = [];
  const listener = http.createServer((req, res) => {
    try { hits.push(new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/^\//, "")); } catch { /* malformed callback path */ }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  listener.on("connection", socket => socket.on("error", () => socket.destroy()));
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", () => resolve()); });
  const port = (listener.address() as import("node:net").AddressInfo).port;
  const send = async (c: SsrfCase, value: string): Promise<number> => {
    const base = new URL(c.path, scope.seeds[0]!).href;
    signal.throwIfAborted();
    if (!inScope(scope, base)) throw Error("SSRF path left the approved scope");
    const ticket = await reserve();
    const started = Date.now();
    let requestUrl = base, bodyText: string | undefined;
    const headers: Record<string, string> = { ...auth };
    if (c.kind === "get") requestUrl = base + "?" + encodeURIComponent(c.field) + "=" + encodeURIComponent(value);
    else { headers["content-type"] = "application/json"; bodyText = JSON.stringify({ [c.field]: value }); }
    const item: RequestEvidence = { id: ticket.id, at: new Date(ticket.at).toISOString(), url: base, method: c.kind === "get" ? "GET" : "POST", authenticated: !!Object.keys(auth).length, status: 0, durationMs: 0, bodyHash: "", bytes: 0, contentType: "", engine: "http" };
    if (c.kind === "post") { item.requestBytes = Buffer.byteLength(bodyText!); item.postPolicy = c.path; }
    evidence.push(item);
    try {
      const res = await fetch(requestUrl, { method: c.kind === "get" ? "GET" : "POST", headers, body: bodyText, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      const chunks: Uint8Array[] = []; let bytes = 0;
      const reader = res.body?.getReader();
      if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; const chunk = part.value.subarray(0, 32768 - bytes); chunks.push(chunk); bytes += chunk.length; if (chunk.length < part.value.length) break; } } finally { await reader.cancel().catch(() => {}); }
      item.status = res.status; item.bytes = bytes; item.bodyHash = hash(Buffer.concat(chunks).toString("utf8"));
      item.contentType = redact(res.headers.get("content-type")?.split(";")[0] ?? "");
      return res.status;
    } catch (error) {
      item.error = redact("SSRF probe request failed: " + (error instanceof Error ? error.message : String(error)));
      return 0;
    } finally { item.durationMs = Date.now() - started; }
  };
  try {
    for (const c of cases) {
      signal.throwIfAborted();
      const target = new URL(c.path, scope.seeds[0]!).href, offset = evidence.length;
      const proof: SsrfProof = { id: randomUUID(), at: new Date().toISOString(), kind: "ssrf", caseId: c.id, target, outcome: "inconclusive", summary: "SSRF verification did not complete", requestIds: [], observations: { method: c.kind === "get" ? "GET" : "POST", field: c.field, callbackPort: port } };
      const finish = (findings: PentestFinding[], covered: string[]) => {
        proof.requestIds = evidence.slice(offset).map(e => e.id);
        if (proof.outcome === "inconclusive") result.incomplete = true;
        result.proofs.push(proof);
        input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
      };
      try {
        const benign = secrets[c.benignRef]!;
        const token = randomUUID().replace(/-/g, "").slice(0, 24);
        const hitsBefore = hits.length;
        // Negative baseline: a benign non-URL value must complete at the
        // transport level and must not produce any listener callback.
        const baselineStatus = await send(c, benign);
        proof.observations.baselineStatus = baselineStatus;
        if (baselineStatus === 0) { proof.summary = "Baseline request did not complete at the transport level; review the case path, field and baseline value"; finish([], []); continue; }
        if (baselineStatus >= 500) { proof.summary = "Baseline request failed with a server error (HTTP " + baselineStatus + "); the endpoint is unavailable for this case"; finish([], []); continue; }
        if (hits.length > hitsBefore) { proof.summary = "Negative control failed: the listener received a callback before any URL probe; the case cannot attribute callbacks to the probe"; finish([], []); continue; }
        proof.observations.baselineClean = true;
        const probeUrl = `http://127.0.0.1:${port}/${token}`;
        const probeStatus = await send(c, probeUrl);
        proof.observations.probeStatus = probeStatus;
        // The application's fetch may be asynchronous; poll for the token.
        let received = hits.includes(token);
        for (let waited = 0; !received && waited < 3000; waited += 150) {
          await new Promise(resolve => setTimeout(resolve, 150));
          received = hits.includes(token);
        }
        proof.observations.callbackReceived = received;
        const check = "ssrf_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
        if (received) {
          proof.outcome = "observed";
          proof.summary = "The application performed a server-side request to the probe URL";
          const finding: PentestFinding = {
            id: check, check, verdict: "finding", severity: "high", target,
            title: "Server-side request forgery confirmed by callback: " + c.id,
            detail: "After a benign baseline that produced no callback, submitting a loopback URL carrying a fresh random token through the declared " + (c.kind === "get" ? "parameter" : "JSON field") + " caused the application itself to fetch that URL (probe HTTP " + probeStatus + "; the callback reached the engine's local listener). Only the application under test can reach that listener, and the token is unique to this probe. No third-party host was contacted. Impact depends on which internal services the application can reach.",
            remediation: "Validate the destination against an explicit allowlist of origins and hosts, reject loopback and link-local addresses, and do not fetch user-supplied URLs directly. Re-run this case after repair.",
          };
          finish([finding], [coverageKey(target, check)]);
          continue;
        }
        proof.outcome = "not_observed";
        proof.summary = probeStatus >= 200 && probeStatus < 300
          ? "The probe completed without any callback to the listener (blocked, validated or not fetched)"
          : "The probe was rejected (HTTP " + probeStatus + ") without any callback";
        finish([], [coverageKey(target, check)]);
      } catch (error) {
        signal.throwIfAborted();
        proof.summary = "SSRF case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
        finish([], []);
      }
    }
  } finally {
    listener.closeAllConnections?.();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
}
