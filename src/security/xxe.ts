import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { inScope, type CampaignScope, type RequestEvidence } from "./scope.js";
import { coverageKey } from "./findings.js";
import type { PentestFinding } from "../tools/pentest.js";

// XML external entity verification with independent proof controls. The engine
// runs a local loopback entity server serving a fresh inert marker; the probe
// is an operator-templated XML document whose DOCTYPE declares an external
// SYSTEM entity pointing at that server. A vulnerable parser either resolves
// the entity into application output (the marker appears in the response —
// the reflection witness) or fetches it without reflection (the callback
// witness, i.e. blind XXE). A benign entity-free baseline must be accepted and
// produce no marker and no callback before any verdict. Only the engine's own
// loopback server is ever contacted; no file:// or remote entities are used.

export interface XxeCase {
  id: string;
  path: string;
  field: string;
  benignXmlRef: string;
  templateRef: string;
}
export interface XxeProof {
  id: string; at: string; kind: "xxe"; caseId: string; target: string;
  outcome: "observed" | "not_observed" | "inconclusive";
  summary: string; requestIds: string[];
  observations: Record<string, string | number | boolean>;
}

const ref = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);
const PLACEHOLDER = "@LOAM_ENTITY_REF@";

export function normalizeXxeCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign", postPaths: string[]): XxeCase[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length) return [];
  if (profile !== "campaign") throw Error("XXE cases require campaign mode");
  if (!scope.seeds.length) throw Error("XXE cases require a scoped target");
  if (value.length > 5) throw Error("At most five XXE cases");
  const cases = value.map((item): XxeCase => {
    if (!item || typeof item !== "object") throw Error("XXE case must be an object");
    const raw = item as Record<string, unknown>;
    if (!ref(raw.id) || !ref(raw.benignXmlRef) || !ref(raw.templateRef)) throw Error("XXE case requires id, benignXmlRef and templateRef");
    if (typeof raw.field !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(raw.field)) throw Error("XXE case requires a safe JSON field name");
    if (typeof raw.path !== "string" || !raw.path.startsWith("/") || raw.path.startsWith("//") || /[?#%\\]/.test(raw.path) || new URL(raw.path, scope.seeds[0]!).pathname !== raw.path) throw Error("XXE case requires an exact path without query or fragment");
    if (!inScope(scope, new URL(raw.path, scope.seeds[0]!).href)) throw Error("XXE case path is outside the approved scope");
    if (!postPaths.includes(raw.path)) throw Error("XXE POST path must be allowlisted in postPaths");
    return { id: raw.id as string, path: raw.path, field: raw.field, benignXmlRef: raw.benignXmlRef as string, templateRef: raw.templateRef as string };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("XXE case ids must be unique");
  return cases;
}

// The benign XML and the probe template are operator-supplied, fresh per run
// and never recorded. The template must carry the entity-reference
// placeholder the engine substitutes.
export function normalizeXxeValues(value: unknown, cases: XxeCase[]): Record<string, string> {
  if (!cases.length) return {};
  if (value === undefined || !value || typeof value !== "object" || Array.isArray(value)) throw Error("XXE cases require fresh input: " + cases[0]!.benignXmlRef);
  const values = value as Record<string, unknown>, result: Record<string, string> = {};
  for (const c of cases) {
    for (const key of ["benignXmlRef", "templateRef"] as const) {
      const v = values[c[key]];
      if (v === undefined) throw Error("Supply fresh business input: " + c[key]);
      if (typeof v !== "string" || !v.trim() || v.length > 8192) throw Error("XXE " + key.replace("Ref", " value") + " must be a nonempty string up to 8192 bytes: " + c[key]);
      result[c[key]] = v;
    }
    if (!result[c.templateRef]!.includes(PLACEHOLDER)) throw Error("XXE probe template must contain the entity placeholder " + PLACEHOLDER + ": " + c.templateRef);
  }
  return result;
}

export type XxeEngineInput = {
  scope: CampaignScope; secrets: Record<string, string>;
  auth: Record<string, string>; signal: AbortSignal; evidence: RequestEvidence[];
  reserve: () => Promise<{ id: string; at: number }>; redact: (value: string) => string;
  result: { proofs: XxeProof[]; incomplete: boolean };
  publish: (proof: XxeProof, findings: PentestFinding[], covered: string[]) => void;
};

export async function runXxeCases(input: XxeEngineInput, cases: XxeCase[]): Promise<void> {
  const { scope, secrets, auth, signal, evidence, reserve, redact, result } = input;
  const hash = (data: string) => createHash("sha256").update(data).digest("hex");
  const scrub = (v: string) => Object.values(secrets).reduce((acc, s) => s ? acc.split(s).join("[REDACTED]") : acc, redact(v));
  // Loopback entity server: serves the inert marker text; only the target
  // application's XML parser can reach it.
  const hits: string[] = [];
  const marker = "loam" + randomUUID().replace(/-/g, "").slice(0, 20);
  const listener = http.createServer((req, res) => {
    try { hits.push(new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/^\//, "")); } catch { /* malformed entity path */ }
    res.writeHead(200, { "content-type": "text/plain" }).end(marker);
  });
  listener.on("connection", socket => socket.on("error", () => socket.destroy()));
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", () => resolve()); });
  const port = (listener.address() as import("node:net").AddressInfo).port;
  const send = async (c: XxeCase, xml: string): Promise<{ status: number; body: string | null }> => {
    const base = new URL(c.path, scope.seeds[0]!).href;
    signal.throwIfAborted();
    if (!inScope(scope, base)) throw Error("XXE path left the approved scope");
    const ticket = await reserve();
    const started = Date.now(), bodyText = JSON.stringify({ [c.field]: xml });
    const item: RequestEvidence = { id: ticket.id, at: new Date(ticket.at).toISOString(), url: base, method: "POST", authenticated: !!Object.keys(auth).length, status: 0, durationMs: 0, bodyHash: "", bytes: 0, contentType: "", engine: "http", requestBytes: Buffer.byteLength(bodyText), postPolicy: c.path };
    evidence.push(item);
    try {
      const res = await fetch(base, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: bodyText, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      const chunks: Uint8Array[] = []; let bytes = 0, truncated = false;
      const reader = res.body?.getReader();
      if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; const chunk = part.value.subarray(0, 32768 - bytes); chunks.push(chunk); bytes += chunk.length; if (chunk.length < part.value.length) { truncated = true; break; } } } finally { await reader.cancel().catch(() => {}); }
      const body = Buffer.concat(chunks).toString("utf8");
      item.status = res.status; item.bytes = bytes; item.bodyHash = hash(body);
      item.contentType = redact(res.headers.get("content-type")?.split(";")[0] ?? "");
      if (truncated) { item.bodyTruncated = true; item.error = "Response body exceeded 32768 bytes"; }
      return { status: res.status, body: truncated ? null : body };
    } catch (error) {
      item.error = redact("XXE probe request failed: " + (error instanceof Error ? error.message : String(error)));
      return { status: 0, body: null };
    } finally { item.durationMs = Date.now() - started; }
  };
  try {
    for (const c of cases) {
      signal.throwIfAborted();
      const target = new URL(c.path, scope.seeds[0]!).href, offset = evidence.length;
      const proof: XxeProof = { id: randomUUID(), at: new Date().toISOString(), kind: "xxe", caseId: c.id, target, outcome: "inconclusive", summary: "XXE verification did not complete", requestIds: [], observations: { field: c.field, entityPort: port } };
      const finish = (findings: PentestFinding[], covered: string[]) => {
        proof.requestIds = evidence.slice(offset).map(e => e.id);
        if (proof.outcome === "inconclusive") result.incomplete = true;
        result.proofs.push(proof);
        input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
      };
      try {
        const benignXml = secrets[c.benignXmlRef]!, template = secrets[c.templateRef]!;
        const token = randomUUID().replace(/-/g, "").slice(0, 24);
        const hitsBeforeCase = hits.length;
        const entityUrl = `http://127.0.0.1:${port}/${token}`;
        const doctype = `<!DOCTYPE loam [<!ENTITY loam SYSTEM "${entityUrl}">]>`;
        const withDoctype = template.startsWith("<?")
          ? template.replace(/^(<\?[^?]*\?>)/, `$1${doctype}`)
          : doctype + template;
        const probeXml = withDoctype.split(PLACEHOLDER).join("&loam;");
        // Negative baseline: entity-free XML must be accepted with no marker
        // and no entity-server callback.
        const baseline = await send(c, benignXml);
        proof.observations.baselineStatus = baseline.status;
        if (!(baseline.status >= 200 && baseline.status < 300) || baseline.body === null) { proof.summary = "Baseline request was not a complete successful response (HTTP " + baseline.status + "); review the case path, field and benign XML"; finish([], []); continue; }
        if (baseline.body.includes(marker) || hits.length > hitsBeforeCase) { proof.summary = "Negative control failed: the baseline response already carried the marker or the entity server was contacted before the probe"; finish([], []); continue; }
        proof.observations.baselineClean = true;
        const probe = await send(c, probeXml);
        proof.observations.probeStatus = probe.status;
        // The parser may resolve asynchronously; poll briefly for the callback.
        let callback = hits.includes(token);
        for (let waited = 0; !callback && waited < 1500; waited += 150) {
          await new Promise(resolve => setTimeout(resolve, 150));
          callback = hits.includes(token);
        }
        const reflected = probe.body !== null && probe.body.includes(marker);
        proof.observations.entityCallback = callback; proof.observations.entityReflected = reflected;
        const check = "xxe_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
        if (reflected || callback) {
          proof.outcome = "observed";
          proof.summary = reflected
            ? "The external entity was resolved into the application response"
            : "The XML parser fetched the external entity (blind XXE)";
          const finding: PentestFinding = {
            id: check, check, verdict: "finding", severity: "high", target,
            title: "XML external entity processing confirmed: " + c.id,
            detail: "The entity-free baseline was accepted cleanly (negative control). A probe document declaring an external SYSTEM entity pointing at the engine's loopback server was then " + (reflected ? "resolved into the application response — the entity content appeared verbatim (HTTP " + probe.status + ")" : "fetched by the application's XML parser without reflection (blind XXE)") + ". Only the engine's own inert marker was ever served; no file or remote entity was used. Impact depends on what the parser can reach and where resolved content flows.",
            remediation: "Disable external entity resolution and DTD processing in the XML parser configuration, validate input against a schema that rejects DOCTYPE declarations, and re-run this case after repair.",
          };
          finish([finding], [coverageKey(target, check)]);
          continue;
        }
        proof.outcome = "not_observed";
        proof.summary = "Neither witness fired: the entity was not resolved and the parser did not fetch it (disabled, sanitized or rejected)";
        finish([], [coverageKey(target, check)]);
      } catch (error) {
        signal.throwIfAborted();
        proof.summary = "XXE case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
        finish([], []);
      }
    }
  } finally {
    listener.closeAllConnections?.();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
}
