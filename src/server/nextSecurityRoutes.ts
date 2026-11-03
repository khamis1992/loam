import type http from "node:http";
import { evaluateAtomicTest } from "../security/atomic.js";
import { evaluateAgenticEvent, type AgenticEvent } from "../security/agentic.js";
import { buildCbom, type CryptoAsset } from "../security/cbom.js";
import { runCrs, type CrsClaim, type CrsRepair } from "../security/crs.js";
import { assessExposure, compareExposureReleases, type ExposureInput } from "../security/exposure.js";
import { CosignVerifier, signProvenance, verifyProvenance, type BuildProvenance } from "../security/provenance.js";
import { compareChannelControls, type ChannelObservation } from "../security/web/channels.js";
import { requirePermission } from "../security/enterprise/policy.js";
import { authenticateEnterpriseRequest, type SecurityEnterpriseRouteDeps } from "./securityEnterpriseRoutes.js";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
};
const text = (body: Record<string, unknown>, key: string): string => typeof body[key] === "string" ? String(body[key]).trim() : "";

export async function handleNextSecurityRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: SecurityEnterpriseRouteDeps): Promise<boolean> {
  const prefix = "/api/security/next";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  res.setHeader("cache-control", "no-store");
  try {
    const identity = await (deps.identity ?? authenticateEnterpriseRequest)(req);
    if (req.method !== "POST") return deps.sendJson(res, 405, { error: "POST required" }), true;
    if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers["sec-fetch-site"] === "cross-site") return deps.sendJson(res, 403, { error: "same-origin requests required" }), true;
    if (!req.headers["content-type"]?.startsWith("application/json")) return deps.sendJson(res, 415, { error: "application/json required" }), true;
    const body = object(await deps.readBody(req, 2_000_000));
    const tenantId = text(body, "tenantId") || identity.tenantIds[0]!;
    const area = url.pathname.slice(prefix.length).split("/").filter(Boolean)[0] ?? "";
    requirePermission(identity, tenantId, area === "provenance" ? "admin:write" : area === "agentic" || area === "crs" ? "engagement:execute" : "finding:review");

    if (area === "atomic") {
      const observation = object(body.observation);
      return deps.sendJson(res, 200, { result: evaluateAtomicTest(body.test as never, { positiveControl: observation.positiveControl === true, negativeControl: observation.negativeControl === true, evidenceIds: Array.isArray(observation.evidenceIds) ? observation.evidenceIds.filter((value): value is string => typeof value === "string") : [] }) }), true;
    }
    if (area === "crs") {
      const claims = Array.isArray(body.claims) ? body.claims as CrsClaim[] : [];
      const controls = object(body.controls);
      const result = await runCrs(claims, {
        validate: async (claim) => {
          const entry = object(controls[claim.id]);
          const positive = object(entry.positive);
          const negative = object(entry.negative);
          const evidence = (value: Record<string, unknown>) => ({ matched: value.matched === true, observation: text(value, "observation"), evidenceIds: Array.isArray(value.evidenceIds) ? value.evidenceIds.filter((item): item is string => typeof item === "string") : [] });
          return { positive: evidence(positive), negative: evidence(negative) };
        },
        criticize: async () => Array.isArray(body.gaps) ? body.gaps.filter((value): value is string => typeof value === "string") : [],
        ...(Array.isArray(body.repairs) ? { repairs: body.repairs as CrsRepair[] } : {}),
      });
      return deps.sendJson(res, 200, result), true;
    }
    if (area === "agentic") return deps.sendJson(res, 200, { findings: evaluateAgenticEvent(body.event as AgenticEvent) }), true;
    if (area === "exposure") {
      const result = assessExposure(body as unknown as ExposureInput);
      const comparison = body.previous && body.current ? compareExposureReleases(body.previous as string[], body.current as string[], body.coverageComplete === true) : undefined;
      return deps.sendJson(res, 200, { result, ...(comparison ? { comparison } : {}) }), true;
    }
    if (area === "cbom") return deps.sendJson(res, 200, { bom: buildCbom(Array.isArray(body.assets) ? body.assets as CryptoAsset[] : []) }), true;
    if (area === "channels") return deps.sendJson(res, 200, { results: compareChannelControls(Array.isArray(body.observations) ? body.observations as ChannelObservation[] : []) }), true;
    if (area === "provenance") {
      const key = Buffer.from(process.env.LOAM_PROVENANCE_KEY ?? "", "base64");
      const action = text(body, "action");
      if (action === "sign") {
        const provenance = signProvenance(body.provenance as never, key);
        return deps.sendJson(res, 201, { provenance }), true;
      }
      const provenance = body.provenance as BuildProvenance;
      const artifacts = Object.fromEntries(Object.entries(object(body.artifacts)).map(([uri, value]) => [uri, Buffer.from(String(value), "base64")]));
      const local = verifyProvenance(provenance, key, artifacts);
      if (!local.valid) return deps.sendJson(res, 200, { local, external: null }), true;
      const externalUrl = process.env.LOAM_COSIGN_VERIFY_URL;
      const external = externalUrl ? await new CosignVerifier({ url: externalUrl }).verify(provenance) : null;
      return deps.sendJson(res, 200, { local, external }), true;
    }
    return deps.sendJson(res, 404, { error: "next security endpoint not found" }), true;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    deps.sendJson(res, /permission denied|tenant|identity|token|authorization/.test(message) ? 403 : 400, { error: message });
    return true;
  }
}
