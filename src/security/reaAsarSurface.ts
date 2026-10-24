/** ASAR surface projection + diff — REA_INTO_LOAM_INTEGRATION §10 (OD-4, appendix A7).
 *  Loam-owned projection over a retained `analyze_javascript_application` record:
 *  the stable, reviewable surface of the packaged app (IPC channels, contextBridge
 *  keys, preload entrypoints, hard-coded endpoints) plus the analyzer's summary
 *  counts. Best-effort static (U4): a human reviews allowlist deltas. */
import type { ReaEvidenceRecord } from "./reaEvidence.js";

export interface AsarSurface {
  /** Digest of the analyze Evidence record the surface was extracted from. */
  contentDigest: string;
  /** Artifact digest of the analyzed target (root asar/app). */
  artifactDigest?: string;
  ipcChannels: string[];
  ipcRendererTransmissions: string[];
  contextBridgeKeys: string[];
  preloadEntryPoints: string[];
  hardcodedEndpoints: string[];
  browserWindows: number;
  /** Analyzer summary counts kept verbatim for stable numeric diffing. */
  summary: Record<string, unknown>;
}

export interface AsarSurfaceDelta {
  addedIpcChannels: string[];
  removedIpcChannels: string[];
  addedContextBridgeKeys: string[];
  addedPreloadEntryPoints: string[];
  addedHardcodedEndpoints: string[];
  browserWindowsDelta: number;
}

interface GraphNode {
  kind?: string;
  observations?: Array<{ label?: string; properties?: Record<string, unknown> }>;
}

const nodeLabels = (nodes: GraphNode[], kind: string, pick?: (obs: NonNullable<GraphNode["observations"]>[number]) => string | undefined): string[] => {
  const found = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== kind) continue;
    for (const obs of node.observations ?? []) {
      const value = (pick ? pick(obs) : undefined) ?? obs.label ?? (typeof obs.properties?.["channel"] === "string" ? obs.properties["channel"] : undefined);
      if (typeof value === "string" && value.length > 0) found.add(value);
    }
  }
  return [...found].sort();
};

/** Project the stable surface from a retained analyze record's normalized_result. */
export function extractAsarSurface(record: ReaEvidenceRecord): AsarSurface {
  const normalized = record.normalized_result as { graph?: { nodes?: GraphNode[] }; summary?: Record<string, unknown> } | undefined;
  const nodes = normalized?.graph?.nodes ?? [];
  const summary = (normalized?.summary ?? {}) as Record<string, unknown>;
  const endpointNodes = nodeLabels(nodes, "endpoint", (obs) => (typeof obs.properties?.["url"] === "string" ? obs.properties["url"] : undefined));
  return {
    contentDigest: record.evidence_id ?? "",
    artifactDigest: record.subject?.digest?.sha256,
    ipcChannels: nodeLabels(nodes, "ipc-channel"),
    ipcRendererTransmissions: nodeLabels(nodes, "ipc-channel", (obs) => (obs.properties?.["side"] === "renderer" && typeof obs.properties?.["channel"] === "string" ? obs.properties["channel"] : undefined)),
    contextBridgeKeys: nodeLabels(nodes, "context-bridge-api", (obs) => (typeof obs.properties?.["key"] === "string" ? obs.properties["key"] : undefined)),
    preloadEntryPoints: nodeLabels(nodes, "electron-preload", (obs) => (typeof obs.properties?.["path"] === "string" ? obs.properties["path"] : undefined)),
    hardcodedEndpoints: endpointNodes,
    browserWindows: typeof summary["browser_windows"] === "number" ? summary["browser_windows"] : 0,
    summary,
  };
}

/** Diff current surface against the committed baseline; only *added* surface can fail
 *  the gate (removals are reported for review, never fatal). */
export function diffAsarSurface(baseline: AsarSurface, current: AsarSurface): AsarSurfaceDelta {
  const added = (a: string[], b: string[]) => b.filter((x) => !a.includes(x));
  return {
    addedIpcChannels: added(baseline.ipcChannels, current.ipcChannels),
    removedIpcChannels: added(current.ipcChannels, baseline.ipcChannels),
    addedContextBridgeKeys: added(baseline.contextBridgeKeys, current.contextBridgeKeys),
    addedPreloadEntryPoints: added(baseline.preloadEntryPoints, current.preloadEntryPoints),
    addedHardcodedEndpoints: added(baseline.hardcodedEndpoints, current.hardcodedEndpoints),
    browserWindowsDelta: current.browserWindows - baseline.browserWindows,
  };
}

/** New surface entries not covered by the reviewed allowlist (qa/asar-baseline-allowlist.json). */
export function unexplainedAdditions(delta: AsarSurfaceDelta, allowlist: { ipcChannels?: string[]; contextBridgeKeys?: string[]; preloadEntryPoints?: string[]; hardcodedEndpoints?: string[] }): AsarSurfaceDelta {
  const notAllowed = (added: string[], allowed?: string[]) => added.filter((x) => !(allowed ?? []).includes(x));
  return {
    ...delta,
    addedIpcChannels: notAllowed(delta.addedIpcChannels, allowlist.ipcChannels),
    addedContextBridgeKeys: notAllowed(delta.addedContextBridgeKeys, allowlist.contextBridgeKeys),
    addedPreloadEntryPoints: notAllowed(delta.addedPreloadEntryPoints, allowlist.preloadEntryPoints),
    addedHardcodedEndpoints: notAllowed(delta.addedHardcodedEndpoints, allowlist.hardcodedEndpoints),
  };
}

export function hasSurfaceAdditions(delta: AsarSurfaceDelta): boolean {
  return delta.addedIpcChannels.length > 0 || delta.addedContextBridgeKeys.length > 0 ||
    delta.addedPreloadEntryPoints.length > 0 || delta.addedHardcodedEndpoints.length > 0;
}
