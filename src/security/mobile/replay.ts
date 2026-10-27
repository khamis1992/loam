import { createHash } from "node:crypto";
import { authorizationActive, targetInScope, type AuthorizationRecord } from "../red/gate.js";
import type { RedTransport } from "../red/transport.js";

export interface ReplayRequest {
  url: string;
  method?: string;
  expectedStatus?: number;
  expectedMarker?: string;
}

export async function replayMobileRequest(authz: AuthorizationRecord, transport: RedTransport, request: ReplayRequest): Promise<{ status: "pass" | "finding" | "inconclusive"; httpStatus: number; bodySha256: string; detail: string }> {
  if ((request.method ?? "GET") !== "GET") throw new Error("only non-mutating GET replay is allowed");
  if (!authorizationActive(authz) || !targetInScope(authz.scope, request.url)) throw new Error("replay target is outside active authorization");
  const response = await transport.request(request.url, { method: "GET" });
  const bodySha256 = createHash("sha256").update(response.body).digest("hex");
  if (request.expectedStatus !== undefined && response.status !== request.expectedStatus) return { status: "inconclusive", httpStatus: response.status, bodySha256, detail: "replay status differs from baseline" };
  if (request.expectedMarker && !response.body.includes(request.expectedMarker)) return { status: "inconclusive", httpStatus: response.status, bodySha256, detail: "replay marker is missing" };
  return { status: "pass", httpStatus: response.status, bodySha256, detail: "authorized replay reproduced the baseline observation" };
}
