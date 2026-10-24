import { execFile } from "node:child_process";
import fs from "node:fs";

const PROBE_TIMEOUT_MS = 4000;

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: PROBE_TIMEOUT_MS, shell: false }, (err, stdout) => {
      resolve(err ? "" : String(stdout));
    });
  });
}

/** Expand %VAR% segments from the environment; a missing variable voids the path. */
export function expandEnv(p: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let missing = false;
  const out = p.replace(/%([^%]+)%/g, (_m, name: string) => {
    const v = env[name] ?? env[name.toUpperCase()];
    if (!v) missing = true;
    return v ?? "";
  });
  return missing ? null : out;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** First hit of `where.exe <name>` that exists on disk. */
export async function whereExe(name: string): Promise<string | null> {
  if (!/^[\w.+-]+$/.test(name)) return null;
  const out = await run("where.exe", [name]);
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim();
    if (p && isFile(p)) return p;
  }
  return null;
}

/** Default value of HKLM/HKCU `...\App Paths\<exe>`, or null. */
export async function appPathExe(exe: string): Promise<string | null> {
  if (!/^[\w.+-]+$/.test(exe)) return null;
  for (const hive of ["HKLM", "HKCU"]) {
    const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`;
    const out = await run("reg.exe", ["query", key, "/ve"]);
    const m = /REG_SZ\s+(.+)$/m.exec(out);
    const p = m?.[1]?.trim().replace(/^"|"$/g, "");
    if (p && isFile(p)) return p;
  }
  return null;
}

export function firstExisting(paths: string[]): string | null {
  for (const raw of paths) {
    const p = expandEnv(raw);
    if (p && isFile(p)) return p;
  }
  return null;
}
