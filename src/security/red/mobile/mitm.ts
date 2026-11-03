/**
 * Mobile MITM module (Supremacy M1.2): loopback proxy for recording and
 * replaying mobile app API traffic. Uses mitmproxy as an external bridge.
 */
import type { PentestFinding } from "../../../tools/pentest.js";
import type { Evidence } from "../../orchestrator.js";
import { nextEvidenceId } from "../../orchestrator.js";
import type { RedCapability, RedCapabilityContext, RedHypothesis, RedValidation } from "../orchestrator/redOrchestrator.js";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface MitmRecording {
  requests: Array<{ request: RecordedRequest; response: RecordedResponse }>;
}

/** Parse mitmproxy flow dump (simplified JSON shape). */
export function parseMitmFlows(raw: string): MitmRecording {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return { requests: [] }; }
  const flows = Array.isArray(doc) ? doc : (doc as { flows?: unknown[] }).flows ?? [];
  const requests: MitmRecording["requests"] = [];
  for (const flow of flows) {
    const f = flow as Record<string, unknown>;
    const req = f.request as Record<string, unknown> | undefined;
    const res = f.response as Record<string, unknown> | undefined;
    if (!req || typeof req.url !== "string" || typeof req.method !== "string") continue;
    requests.push({
      request: { method: req.method, url: req.url, headers: (req.headers as Record<string, string>) ?? {}, ...(typeof req.body === "string" ? { body: req.body } : {}) },
      response: { status: res?.status as number ?? 0, headers: (res?.headers as Record<string, string>) ?? {}, body: (res?.body as string) ?? "" },
    });
  }
  return { requests };
}

/** Detect credential-in-URL from recorded flows. */
export function detectCredentialInUrl(recording: MitmRecording): PentestFinding[] {
  const out: PentestFinding[] = [];
  for (const { request } of recording.requests) {
    const url = new URL(request.url);
    for (const [key, value] of url.searchParams) {
      if (/token|password|secret|key|auth/i.test(key) && value.length > 4) {
        out.push({
          id: `mitm-cred-${key}-${url.hostname}`,
          check: "red_mobile_credential_in_url",
          verdict: "finding",
          severity: "medium",
          title: `Credential in URL parameter: ${key}`,
          target: url.origin,
          detail: `${key}=${value.slice(0, 8)}... sent in query string`,
          remediation: "Send credentials in headers or body, never in URL parameters.",
        });
      }
    }
  }
  return out;
}

export function mitmCapability(opts: { port?: number } = {}): RedCapability {
  return {
    id: "red.mobile.mitm",
    applicable: (target) => /^https?:/i.test(target) || target.startsWith("device:"),
    hunt: async (target): Promise<RedHypothesis[]> => [
      { id: `HYP-MITM-${target.length}`, capability: "red.mobile.mitm", target, claim: "Mobile API traffic security issues", rationale: "MITM proxy recording" },
    ],
    validate: async (hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation> => {
      const envelope = await ctx.bridge("red-mitmproxy", "record", { port: String(opts.port ?? 8080), out: "mitm-flows.json" });
      if (!envelope.ok) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `mitmproxy unavailable: ${envelope.error?.message ?? "no output"}`, evidence: [] };
      }
      const raw = typeof envelope.data === "string" ? envelope.data : `${envelope.text ?? ""}`;
      const recording = parseMitmFlows(raw);
      const findings = detectCredentialInUrl(recording);
      if (!findings.length) {
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: "No credential-in-URL issues in recorded flows", evidence: [] };
      }
      const evidence: Evidence[] = findings.map((f) => ({
        id: nextEvidenceId(), kind: "poc", at: new Date().toISOString(),
        poc: `MITM recording (${recording.requests.length} requests)`,
        observed: f.detail,
      }));
      const top = findings[0]!;
      return { hypothesisId: hyp.id, status: "confirmed", claim: hyp.claim, detail: `${findings.length} mobile traffic finding(s)`, evidence, finding: { check: top.check, verdict: "finding", severity: top.severity, title: top.title, target: top.target, detail: top.detail, ...(top.remediation ? { remediation: top.remediation } : {}) } };
    },
  };
}
