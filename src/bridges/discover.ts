import { execFile } from "node:child_process";
import { appPathExe, firstExisting, whereExe } from "./windowsProbe.js";
import type { BridgeManifest } from "./types.js";

export interface Discovery {
  exePath: string | null;
  version?: string;
  detail?: string;
}

function versionOf(exe: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: 8000, shell: false }, (err, stdout, stderr) => {
      if (err) return resolve(undefined);
      const first = `${stdout}${stderr}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      resolve(first?.slice(0, 120));
    });
  });
}

/**
 * Find an installed program for a manifest. Order: PATH, known install paths,
 * the App Paths registry key. Nothing is executed beyond `where`, `reg` and the
 * optional version probe.
 */
export async function discover(m: BridgeManifest): Promise<Discovery> {
  let exePath: string | null = null;
  for (const name of m.probe.names) {
    exePath = await whereExe(name);
    if (exePath) break;
  }
  if (!exePath && m.probe.paths) exePath = firstExisting(m.probe.paths);
  if (!exePath && m.probe.appPaths) {
    for (const name of m.probe.appPaths) {
      exePath = await appPathExe(name);
      if (exePath) break;
    }
  }
  if (!exePath) return { exePath: null, detail: "not installed" };
  const version = m.versionArgs ? await versionOf(exePath, m.versionArgs) : undefined;
  return version ? { exePath, version } : { exePath };
}
