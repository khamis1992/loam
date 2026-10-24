/**
 * Installed red-engine registry (RED_TEAM_BUILD_SPEC §5.8 / O-3).
 *
 * `src/scripts/red-install-engines.ts` downloads official release artifacts,
 * verifies their SHA256 and writes ~/.loam/tools/engines.json; this module is
 * the read side used by the capability layer to pass exact engine paths into the
 * bridge invocations (nuclei/ffuf are discovered by probe paths on the
 * manifests; sqlmap runs via the local `py` launcher, ysoserial via the local
 * JRE — both external processes, licence discipline §5.9).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface EngineRegistry {
  installedAt: string;
  versions: Record<string, string>;
  paths: { nuclei?: string; ffuf?: string; sqlmapScript?: string; ysoserialJar?: string };
  sha256: Record<string, string>;
}

export function enginesRoot(): string {
  return path.join(os.homedir(), ".loam", "tools");
}

export function enginesRegistryPath(): string {
  return path.join(enginesRoot(), "engines.json");
}

/** The installed-engine registry, or null when nothing is installed yet. */
export function loadEngines(): EngineRegistry | null {
  try {
    const raw = JSON.parse(fs.readFileSync(enginesRegistryPath(), "utf8")) as EngineRegistry;
    if (!raw || typeof raw !== "object" || !raw.paths) return null;
    return raw;
  } catch {
    return null;
  }
}

/** True when the recorded engine path exists on disk. */
export function engineAvailable(key: keyof EngineRegistry["paths"]): boolean {
  const registry = loadEngines();
  const p = registry?.paths[key];
  return !!p && fs.existsSync(p);
}
