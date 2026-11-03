import { createHash } from "node:crypto";
import { authorizationActive, type AuthorizationRecord } from "../red/gate.js";
import { redTransport } from "../red/transport.js";

export interface AuthorizationAccount {
  id: string;
  headers?: Record<string, string>;
}

export interface MobileAuthorizationCase {
  id: string;
  url: string;
  privateMarker: string;
  ownerIdentity: string;
}

export interface AuthorizationTestResult {
  caseId: string;
  status: "pass" | "finding" | "inconclusive";
  detail: string;
  evidenceIds: string[];
  findingId?: string;
}

export async function testMobileAuthorization(authz: AuthorizationRecord, testCase: MobileAuthorizationCase, owner: AuthorizationAccount, other: AuthorizationAccount): Promise<AuthorizationTestResult> {
  if (!authorizationActive(authz)) return { caseId: testCase.id, status: "inconclusive", detail: "authorization expired", evidenceIds: [] };
  const origin = new URL(testCase.url).origin;
  const ownerTransport = redTransport(authz, { authOrigin: origin, ...(owner.headers ? { authHeaders: owner.headers } : {}) });
  const otherTransport = redTransport(authz, { authOrigin: origin, ...(other.headers ? { authHeaders: other.headers } : {}) });
  const evidenceIds: string[] = [];
  let control;
  try {
    control = await ownerTransport.request(testCase.url);
    evidenceIds.push(...ownerTransport.evidence.map((entry) => entry.id));
  } catch (error) {
    return { caseId: testCase.id, status: "inconclusive", detail: `owner positive control failed: ${String(error).slice(0, 200)}`, evidenceIds };
  }
  if (!control.ok || !control.body.includes(testCase.ownerIdentity) || !control.body.includes(testCase.privateMarker)) {
    return { caseId: testCase.id, status: "inconclusive", detail: "owner control lacks identity or private marker", evidenceIds };
  }
  try {
    const before = otherTransport.evidence.length;
    const response = await otherTransport.request(testCase.url);
    evidenceIds.push(...otherTransport.evidence.slice(before).map((entry) => entry.id));
    if (response.ok && response.body.includes(testCase.privateMarker)) {
      const findingId = createHash("sha256").update(`${testCase.id}\n${testCase.url}\n${other.id}`).digest("hex").slice(0, 24);
      return { caseId: testCase.id, status: "finding", detail: `Account ${other.id} received the protected marker with a valid owner control`, evidenceIds, findingId };
    }
    if (response.status === 401 || response.status === 403) return { caseId: testCase.id, status: "pass", detail: "protected object denied after a valid owner control", evidenceIds };
    return { caseId: testCase.id, status: "inconclusive", detail: `unexpected response ${response.status} without the protected marker`, evidenceIds };
  } catch (error) {
    return { caseId: testCase.id, status: "inconclusive", detail: `comparison request failed: ${String(error).slice(0, 200)}`, evidenceIds };
  }
}
