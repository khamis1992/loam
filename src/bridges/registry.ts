import type { Config } from "../config.js";
import { BUILTIN_MANIFESTS } from "./builtin.js";
import { discover } from "./discover.js";
import { parseManifest } from "./manifestSchema.js";
import type { BridgeInfo, BridgeManifest } from "./types.js";

let cached: BridgeManifest[] | null = null;
let loadErrors: string[] = [];

/** Validate and cache the built-in manifests. A bad manifest is dropped, never half-loaded. */
export function loadManifests(): BridgeManifest[] {
  if (cached) return cached;
  const out: BridgeManifest[] = [];
  loadErrors = [];
  for (const raw of BUILTIN_MANIFESTS) {
    const r = parseManifest(raw);
    if (r.ok) out.push(r.manifest);
    else loadErrors.push(r.error);
  }
  cached = out;
  return out;
}

export function manifestLoadErrors(): string[] {
  loadManifests();
  return loadErrors;
}

export function getManifest(id: string): BridgeManifest | undefined {
  return loadManifests().find((m) => m.id === id);
}

export function isBridgeEnabled(cfg: Pick<Config, "bridges">, id: string): boolean {
  return cfg.bridges?.enabled[id] === true;
}

/** Session-scoped toggle: there is no config persist helper, so this lasts until restart. */
export function setBridgeEnabled(cfg: Pick<Config, "bridges">, id: string, on: boolean): void {
  if (!cfg.bridges) (cfg as { bridges?: { enabled: Record<string, boolean> } }).bridges = { enabled: {} };
  const flags = cfg.bridges!.enabled;
  if (on) flags[id] = true;
  else delete flags[id];
}

export async function bridgeInfo(cfg: Pick<Config, "bridges">, m: BridgeManifest): Promise<BridgeInfo> {
  const enabled = isBridgeEnabled(cfg, m.id);
  const commands = m.commands.map((c) => ({ id: c.id, description: c.description, effect: c.effect }));
  const base = { id: m.id, name: m.name, description: m.description, enabled, commands };
  try {
    const d = await discover(m);
    if (!d.exePath) return { ...base, status: "missing", detail: d.detail };
    const found = { ...base, exePath: d.exePath, version: d.version };
    return enabled ? { ...found, status: "ready" } : { ...found, status: "disabled" };
  } catch (err) {
    return { ...base, status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function listBridges(cfg: Pick<Config, "bridges">): Promise<BridgeInfo[]> {
  return Promise.all(loadManifests().map((m) => bridgeInfo(cfg, m)));
}
