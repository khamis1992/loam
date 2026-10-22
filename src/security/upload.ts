import { createHash, randomUUID } from "node:crypto";
import { inScope, type CampaignScope, type RequestEvidence } from "./scope.js";
import { coverageKey } from "./findings.js";
import type { PentestFinding } from "../tools/pentest.js";

// File upload verification with independent proof controls. Each case targets
// one operator-declared multipart POST endpoint: a benign declared-valid file
// must be accepted (positive control) before a probe file of a type the
// operator declares as disallowed is uploaded. The verdict witness is
// retrieval: the declared view must serve the probe content verbatim for the
// finding to fire. No executable content is ever generated — the probe is
// inert marker text under the operator-declared disallowed name.

export interface UploadCase {
  id: string;
  path: string;
  field: string;
  viewPath: string;
  viewParam: string;
  benignNameRef: string;
  benignContentRef: string;
  probeNameRef: string;
  probeContentRef: string;
  markerRef: string;
}
export interface UploadProof {
  id: string; at: string; kind: "upload"; caseId: string; target: string;
  outcome: "observed" | "not_observed" | "inconclusive";
  summary: string; requestIds: string[];
  observations: Record<string, string | number | boolean>;
}

const ref = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);

export function normalizeUploadCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign", postPaths: string[]): UploadCase[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length) return [];
  if (profile !== "campaign") throw Error("Upload cases require campaign mode");
  if (!scope.seeds.length) throw Error("Upload cases require a scoped target");
  if (value.length > 5) throw Error("At most five upload cases");
  const cases = value.map((item): UploadCase => {
    if (!item || typeof item !== "object") throw Error("Upload case must be an object");
    const raw = item as Record<string, unknown>;
    for (const key of ["id", "benignNameRef", "benignContentRef", "probeNameRef", "probeContentRef", "markerRef"] as const) if (!ref(raw[key])) throw Error("Upload case requires " + key);
    if (typeof raw.field !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(raw.field)) throw Error("Upload case requires a safe multipart field name");
    if (raw.viewParam !== undefined && (typeof raw.viewParam !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(raw.viewParam))) throw Error("Upload case view parameter must be a safe name");
    for (const key of ["path", "viewPath"] as const) {
      if (typeof raw[key] !== "string" || !raw[key]!.startsWith("/") || raw[key]!.startsWith("//") || /[?#%\\]/.test(raw[key]!) || new URL(raw[key] as string, scope.seeds[0]!).pathname !== raw[key]) throw Error("Upload case requires an exact " + (key === "path" ? "POST" : "view") + " path without query or fragment");
      if (!inScope(scope, new URL(raw[key] as string, scope.seeds[0]!).href)) throw Error("Upload case " + (key === "path" ? "POST" : "view") + " path is outside the approved scope");
    }
    if (!postPaths.includes(raw.path as string)) throw Error("Upload case path must be allowlisted in postPaths");
    return { id: raw.id as string, path: raw.path as string, field: raw.field as string, viewPath: raw.viewPath as string, viewParam: (raw.viewParam as string | undefined) ?? "name", benignNameRef: raw.benignNameRef as string, benignContentRef: raw.benignContentRef as string, probeNameRef: raw.probeNameRef as string, probeContentRef: raw.probeContentRef as string, markerRef: raw.markerRef as string };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Upload case ids must be unique");
  return cases;
}

// Filenames, contents and the marker are operator-supplied plain strings,
// fresh per run and never recorded beyond hashed evidence.
export function normalizeUploadValues(value: unknown, cases: UploadCase[]): Record<string, string> {
  if (!cases.length) return {};
  if (value === undefined || !value || typeof value !== "object" || Array.isArray(value)) throw Error("Upload cases require fresh input: " + cases[0]!.benignNameRef);
  const values = value as Record<string, unknown>, result: Record<string, string> = {};
  for (const c of cases) {
    const specs = [["benignNameRef", 255], ["benignContentRef", 8192], ["probeNameRef", 255], ["probeContentRef", 8192], ["markerRef", 512]] as const;
    for (const [key, max] of specs) {
      const ref = c[key];
      const v = values[ref];
      if (v === undefined) throw Error("Supply fresh business input: " + ref);
      if (typeof v !== "string" || !v.trim() || v.length > max) throw Error("Upload " + key.replace("Ref", " value") + " must be a nonempty string up to " + max + " bytes: " + ref);
      result[ref] = v;
    }
    if (!result[c.probeContentRef]!.includes(result[c.markerRef]!)) throw Error("Upload probe content must contain the declared marker: " + c.markerRef);
  }
  return result;
}

export type UploadEngineInput = {
  scope: CampaignScope; secrets: Record<string, string>;
  auth: Record<string, string>; signal: AbortSignal; evidence: RequestEvidence[];
  reserve: () => Promise<{ id: string; at: number }>; redact: (value: string) => string;
  result: { proofs: UploadProof[]; incomplete: boolean };
  publish: (proof: UploadProof, findings: PentestFinding[], covered: string[]) => void;
};

export async function runUploadCases(input: UploadEngineInput, cases: UploadCase[]): Promise<void> {
  const { scope, secrets, auth, signal, evidence, reserve, redact, result } = input;
  const hash = (data: string) => createHash("sha256").update(data).digest("hex");
  const scrub = (v: string) => Object.values(secrets).reduce((acc, s) => s ? acc.split(s).join("[REDACTED]") : acc, redact(v));
  const upload = async (c: UploadCase, fileName: string, content: string): Promise<number> => {
    const base = new URL(c.path, scope.seeds[0]!).href;
    signal.throwIfAborted();
    if (!inScope(scope, base)) throw Error("Upload path left the approved scope");
    const ticket = await reserve();
    const started = Date.now();
    const form = new FormData();
    form.append(c.field, new Blob([content]), fileName);
    const item: RequestEvidence = { id: ticket.id, at: new Date(ticket.at).toISOString(), url: base, method: "POST", authenticated: !!Object.keys(auth).length, status: 0, durationMs: 0, bodyHash: "", bytes: 0, contentType: "", engine: "http", requestBytes: Buffer.byteLength(content), postPolicy: c.path };
    evidence.push(item);
    try {
      const res = await fetch(base, { method: "POST", headers: { ...auth }, body: form, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      const chunks: Uint8Array[] = []; let bytes = 0;
      const reader = res.body?.getReader();
      if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; const chunk = part.value.subarray(0, 32768 - bytes); chunks.push(chunk); bytes += chunk.length; if (chunk.length < part.value.length) break; } } finally { await reader.cancel().catch(() => {}); }
      const body = Buffer.concat(chunks).toString("utf8");
      item.status = res.status; item.bytes = bytes; item.bodyHash = hash(body);
      item.contentType = redact(res.headers.get("content-type")?.split(";")[0] ?? "");
      return res.status;
    } catch (error) {
      item.error = redact("Upload request failed: " + (error instanceof Error ? error.message : String(error)));
      return 0;
    } finally { item.durationMs = Date.now() - started; }
  };
  const retrieve = async (c: UploadCase, fileName: string): Promise<{ status: number; body: string | null }> => {
    const base = new URL(c.viewPath, scope.seeds[0]!).href;
    signal.throwIfAborted();
    if (!inScope(scope, base)) throw Error("Upload view path left the approved scope");
    const ticket = await reserve();
    const started = Date.now(), url = base + "?" + encodeURIComponent(c.viewParam) + "=" + encodeURIComponent(fileName);
    const item: RequestEvidence = { id: ticket.id, at: new Date(ticket.at).toISOString(), url: base, method: "GET", authenticated: !!Object.keys(auth).length, status: 0, durationMs: 0, bodyHash: "", bytes: 0, contentType: "", engine: "http" };
    evidence.push(item);
    try {
      const res = await fetch(url, { method: "GET", headers: { ...auth }, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      const chunks: Uint8Array[] = []; let bytes = 0, truncated = false;
      const reader = res.body?.getReader();
      if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; const chunk = part.value.subarray(0, 32768 - bytes); chunks.push(chunk); bytes += chunk.length; if (chunk.length < part.value.length) { truncated = true; break; } } } finally { await reader.cancel().catch(() => {}); }
      const body = Buffer.concat(chunks).toString("utf8");
      item.status = res.status; item.bytes = bytes; item.bodyHash = hash(body);
      item.contentType = redact(res.headers.get("content-type")?.split(";")[0] ?? "");
      if (truncated) { item.bodyTruncated = true; item.error = "Response body exceeded 32768 bytes"; }
      return { status: res.status, body: truncated ? null : body };
    } catch (error) {
      item.error = redact("Upload retrieval request failed: " + (error instanceof Error ? error.message : String(error)));
      return { status: 0, body: null };
    } finally { item.durationMs = Date.now() - started; }
  };
  for (const c of cases) {
    signal.throwIfAborted();
    const target = new URL(c.path, scope.seeds[0]!).href, offset = evidence.length;
    const proof: UploadProof = { id: randomUUID(), at: new Date().toISOString(), kind: "upload", caseId: c.id, target, outcome: "inconclusive", summary: "Upload verification did not complete", requestIds: [], observations: { field: c.field, viewParam: c.viewParam } };
    const finish = (findings: PentestFinding[], covered: string[]) => {
      proof.requestIds = evidence.slice(offset).map(e => e.id);
      if (proof.outcome === "inconclusive") result.incomplete = true;
      result.proofs.push(proof);
      input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
    };
    try {
      const benignName = secrets[c.benignNameRef]!, benignContent = secrets[c.benignContentRef]!, probeName = secrets[c.probeNameRef]!, probeContent = secrets[c.probeContentRef]!, marker = secrets[c.markerRef]!;
      // Positive control: the declared-valid benign file must be accepted.
      const benignStatus = await upload(c, benignName, benignContent);
      proof.observations.benignStatus = benignStatus;
      if (!(benignStatus >= 200 && benignStatus < 300)) { proof.summary = "Positive control failed: the benign declared-valid file was not accepted (HTTP " + benignStatus + ")"; finish([], []); continue; }
      // Probe: the operator-declared disallowed file type.
      const probeStatus = await upload(c, probeName, probeContent);
      proof.observations.probeStatus = probeStatus;
      if (!(probeStatus >= 200 && probeStatus < 300)) {
        proof.outcome = "not_observed";
        proof.summary = "The disallowed-type probe was rejected (HTTP " + probeStatus + ") while the benign file was accepted";
        const check = "upload_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
        finish([], [coverageKey(target, check)]);
        continue;
      }
      // Retrieval witness: the view must serve the probe content verbatim.
      const view = await retrieve(c, probeName);
      proof.observations.viewStatus = view.status;
      const served = view.status >= 200 && view.status < 300 && view.body !== null && view.body.includes(marker);
      proof.observations.markerServed = served;
      const check = "upload_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
      if (served) {
        proof.outcome = "observed";
        proof.summary = "The disallowed-type file was accepted and its content is served verbatim from the declared view";
        const finding: PentestFinding = {
          id: check, check, verdict: "finding", severity: "high", target,
          title: "Disallowed file type accepted, stored and served verbatim: " + c.id,
          detail: "The benign declared-valid file was accepted (positive control). A probe file the operator declared disallowed was also accepted (HTTP " + probeStatus + ") and the declared view served its content verbatim (HTTP " + view.status + ", marker matched). The probe is inert marker text; nothing executable was uploaded. Impact depends on the serving content type and downstream processing of such files.",
          remediation: "Validate the file type by content signature and a strict extension allowlist, store uploads outside the served root or serve them with safe content types and no execution, and re-run this case after repair.",
        };
        finish([finding], [coverageKey(target, check)]);
        continue;
      }
      proof.outcome = "not_observed";
      proof.summary = "The disallowed-type file was accepted but its content was not served from the declared view (normalized, quarantined or unreachable)";
      finish([], [coverageKey(target, check)]);
    } catch (error) {
      signal.throwIfAborted();
      proof.summary = "Upload case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
      finish([], []);
    }
  }
}
