/**
 * WiFi audit (RED_TEAM_BUILD_SPEC §6.11) — FLOCK4H/Freeway (MIT) via the
 * red-freeway bridge, on owned lab equipment only. A BSSID allow-list is
 * enforced like the authorization gate: any BSSID not on the list is denied
 * and audited. Deauth/handshake capture is destructive-adjacent and requires
 * the caller's approval at the bridge/gate level. Deferred by default
 * (spec O-7): requires a monitor-mode adapter.
 */
import type { BridgeEnvelope } from "../../../bridges/types.js";
import type { RedCapabilityContext } from "../orchestrator/redOrchestrator.js";

export interface WifiScope {
  authzId: string | null;
  /** Owned AP BSSIDs; everything else is out of scope. */
  allowBssids: string[];
}

export interface WifiNetwork {
  bssid: string;
  ssid: string;
  clients: string[];
}

export type WifiDecision = { allow: true } | { allow: false; reason: string };

/** BSSID allow-list check (the RF equivalent of the §0.4 gate). */
export function bssidAllowed(scope: WifiScope, bssid: string): WifiDecision {
  if (!scope.allowBssids.some((allowed) => allowed.toLowerCase() === bssid.toLowerCase())) {
    return { allow: false, reason: `BSSID ${bssid} is not on the lab allow-list` };
  }
  return { allow: true };
}

/**
 * Parse freeway scan output. Our contract with the bridge: JSON array of
 * { bssid, ssid, clients: [...] } (freeway's own formats vary by version, so
 * the capability normalizes through this parser).
 */
export function parseFreewayScan(raw: string): WifiNetwork[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(doc) ? doc : (doc as { networks?: unknown[] }).networks ?? [];
  const out: WifiNetwork[] = [];
  for (const n of list) {
    const o = n as Record<string, unknown>;
    const bssid = typeof o.bssid === "string" ? o.bssid : "";
    if (!bssid) continue;
    out.push({
      bssid,
      ssid: typeof o.ssid === "string" ? o.ssid : "",
      clients: Array.isArray(o.clients) ? o.clients.filter((c): c is string => typeof c === "string") : [],
    });
  }
  return out;
}

/** Scan owned lab APs via the freeway bridge. */
export async function scanWifi(ctx: RedCapabilityContext, scope: WifiScope, interface_ = "wlan0"): Promise<WifiNetwork[]> {
  const envelope: BridgeEnvelope = await ctx.bridge("red-freeway", "scan", { interface: interface_ });
  if (!envelope.ok) throw new Error(`freeway scan failed: ${envelope.error?.message ?? "no output"}`);
  const raw = typeof envelope.data === "string" ? envelope.data : `${envelope.text ?? ""}`;
  const networks = parseFreewayScan(raw);
  // Only allow-listed (owned) BSSIDs are reported; the rest are somebody
  // else's equipment and must not even be listed in findings.
  return networks.filter((n) => bssidAllowed(scope, n.bssid).allow);
}

/** Capture a handshake from an allow-listed owned BSSID (destructive-adjacent). */
export async function captureHandshake(
  ctx: RedCapabilityContext,
  scope: WifiScope,
  bssid: string,
  interface_ = "wlan0",
): Promise<{ ok: boolean; detail: string }> {
  const decision = bssidAllowed(scope, bssid);
  if (!decision.allow) {
    ctx.audit.append({ authzId: scope.authzId, capability: "red.wifi", action: "capture", target: bssid, params: {}, outcome: "denied", reason: decision.reason });
    return { ok: false, detail: decision.reason };
  }
  const envelope = await ctx.bridge("red-freeway", "capture", { bssid, interface: interface_ });
  const detail = envelope.ok ? "handshake capture attempted" : `freeway capture failed: ${envelope.error?.message ?? "no output"}`;
  ctx.audit.append({ authzId: scope.authzId, capability: "red.wifi", action: "capture", target: bssid, params: {}, outcome: envelope.ok ? "completed" : "failed", reason: detail });
  return { ok: envelope.ok, detail };
}
