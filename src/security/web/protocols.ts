import { authorizationActive, type AuthorizationRecord } from "../red/gate.js";
import { redTransport } from "../red/transport.js";
import type { AuthorizationAccount } from "../mobile/apiAuthorization.js";

export interface GraphQLAuthorizationCase {
  url: string;
  query: string;
  privateMarker: string;
  ownerIdentity: string;
}

export async function testGraphQLAuthorization(authz: AuthorizationRecord, testCase: GraphQLAuthorizationCase, owner: AuthorizationAccount, other: AuthorizationAccount): Promise<{ status: "pass" | "finding" | "inconclusive"; detail: string; evidenceIds: string[] }> {
  if (!authorizationActive(authz)) return { status: "inconclusive", detail: "authorization expired", evidenceIds: [] };
  if (testCase.query.length > 20_000 || !testCase.query.trim()) return { status: "inconclusive", detail: "invalid GraphQL operation", evidenceIds: [] };
  const origin = new URL(testCase.url).origin;
  const execute = async (account: AuthorizationAccount) => {
    const transport = redTransport(authz, { ...(account.headers ? { authHeaders: account.headers } : {}), authOrigin: origin });
    const response = await transport.request(testCase.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: testCase.query }) });
    return { response, evidenceIds: transport.evidence.map((entry) => entry.id) };
  };
  let control: Awaited<ReturnType<typeof execute>>;
  try { control = await execute(owner); } catch (error) { return { status: "inconclusive", detail: `owner control failed: ${String(error).slice(0, 200)}`, evidenceIds: [] }; }
  let ownerBody: { data?: unknown; errors?: unknown };
  try { ownerBody = JSON.parse(control.response.body) as { data?: unknown; errors?: unknown }; } catch { return { status: "inconclusive", detail: "owner returned malformed GraphQL JSON", evidenceIds: control.evidenceIds }; }
  if (!control.response.ok || !ownerBody.data || !control.response.body.includes(testCase.ownerIdentity) || !control.response.body.includes(testCase.privateMarker)) return { status: "inconclusive", detail: "owner GraphQL control lacks identity or private data", evidenceIds: control.evidenceIds };
  try {
    const otherResult = await execute(other);
    if (otherResult.response.status === 401 || otherResult.response.status === 403) return { status: "pass", detail: "protected GraphQL field denied after valid owner control", evidenceIds: [...control.evidenceIds, ...otherResult.evidenceIds] };
    let body: { data?: unknown; errors?: unknown };
    try { body = JSON.parse(otherResult.response.body) as { data?: unknown; errors?: unknown }; } catch { return { status: "inconclusive", detail: "comparison returned malformed GraphQL JSON", evidenceIds: [...control.evidenceIds, ...otherResult.evidenceIds] }; }
    if (otherResult.response.ok && body.data && otherResult.response.body.includes(testCase.privateMarker)) return { status: "finding", detail: "other account received the protected GraphQL marker", evidenceIds: [...control.evidenceIds, ...otherResult.evidenceIds] };
    return { status: "inconclusive", detail: "comparison did not expose the marker, but a safe negative control was not established", evidenceIds: [...control.evidenceIds, ...otherResult.evidenceIds] };
  } catch (error) {
    return { status: "inconclusive", detail: `comparison failed: ${String(error).slice(0, 200)}`, evidenceIds: control.evidenceIds };
  }
}

export interface WebSocketHandshake {
  url: string;
  status: number;
  origin?: string;
  expectedOrigin?: string;
  authenticated: boolean;
  requiresAuthentication: boolean;
  reconnectStatus?: number;
}

export function reviewWebSocketHandshake(input: WebSocketHandshake): { status: "pass" | "finding" | "inconclusive" | "review"; detail: string } {
  if (input.url.startsWith("ws://")) return { status: "finding", detail: "WebSocket uses cleartext transport" };
  if (!input.url.startsWith("wss://")) return { status: "inconclusive", detail: "invalid WebSocket scheme" };
  if (input.requiresAuthentication && !input.authenticated && input.status === 101) return { status: "finding", detail: "protected WebSocket accepted an unauthenticated upgrade" };
  if (input.expectedOrigin && input.origin !== input.expectedOrigin && input.status === 101) return { status: "finding", detail: "WebSocket accepted an untrusted Origin" };
  if (input.reconnectStatus === 101 && input.requiresAuthentication && !input.authenticated) return { status: "finding", detail: "WebSocket reconnect bypassed authentication" };
  if (input.status === 401 || input.status === 403) return { status: "pass", detail: "WebSocket upgrade denied" };
  if (input.status !== 101) return { status: "inconclusive", detail: "no successful upgrade evidence" };
  return { status: "review", detail: "upgrade accepted; authorization and per-message controls still require dynamic review" };
}

export interface SpaReview {
  endpoints: string[];
  sourceMaps: string[];
  indicators: Array<{ id: string; title: string; evidence: string; status: "review" }>;
}

export function inspectSpaJavaScript(source: string): SpaReview {
  const limited = source.slice(0, 2_000_000);
  const endpoints = [...new Set([...limited.matchAll(/["'`](\/(?:api|graphql|v\d+)\/[^"'`\s]{1,300})["'`]/g)].map((match) => match[1]!).values())].slice(0, 200);
  const sourceMaps = [...limited.matchAll(/sourceMappingURL=([^\s*]+)/g)].map((match) => match[1]!).slice(0, 20);
  const indicators: SpaReview["indicators"] = [];
  if (/postMessage\s*\([^)]*["']\*["']/.test(limited)) indicators.push({ id: "spa-postmessage-wildcard", title: "postMessage uses a wildcard target origin", evidence: "wildcard target observed", status: "review" });
  if (/__proto__|prototype\[[^\]]+\]\s*=/.test(limited)) indicators.push({ id: "spa-prototype-write", title: "Prototype mutation requires pollution review", evidence: "prototype write observed", status: "review" });
  if (/\beval\s*\(|innerHTML\s*=|document\.write\s*\(/.test(limited)) indicators.push({ id: "spa-dom-sink", title: "DOM code execution sink requires source-to-sink validation", evidence: "dynamic DOM sink observed", status: "review" });
  return { endpoints, sourceMaps, indicators };
}
