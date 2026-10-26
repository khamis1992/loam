import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { log } from "../../log.js";
import { HOME_DIR } from "./constants.js";
import type { HomeStatus } from "./types.js";

const ACL_MARKER = ".loam-acl";
/** Well-known SID of LocalSystem; locale-independent (the account name is localised on some Windows builds). */
const SYSTEM_SID = "*S-1-5-18";

function icaclsPath(): string {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
}

/** Create HOME_DIR and restrict it to the current user + SYSTEM (Windows) or 0700 (POSIX). Idempotent. */
export function ensureHome(): HomeStatus {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(HOME_DIR, 0o700);
      return { home: HOME_DIR, acl: "posix-0700" };
    } catch (err) {
      return { home: HOME_DIR, acl: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
  const marker = path.join(HOME_DIR, ACL_MARKER);
  if (fs.existsSync(marker)) return { home: HOME_DIR, acl: "applied" };
  const user = process.env.USERNAME;
  if (!user) return { home: HOME_DIR, acl: "failed", error: "USERNAME is not set" };
  const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  const r = spawnSync(
    icaclsPath(),
    [HOME_DIR, "/inheritance:r", "/grant:r", `${principal}:(OI)(CI)F`, "/grant:r", `${SYSTEM_SID}:(OI)(CI)F`, "/T", "/C", "/Q"],
    { windowsHide: true, encoding: "utf8", shell: false, timeout: 30_000 },
  );
  if (r.status !== 0) {
    const error = (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim().slice(0, 300);
    log.warn(`api-anything: icacls failed on ${HOME_DIR}: ${error}`);
    return { home: HOME_DIR, acl: "failed", error };
  }
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  return { home: HOME_DIR, acl: "applied" };
}

/** Principals that hold an ACE on HOME_DIR (Windows), for the status panel. Never throws. */
export function aclPrincipals(): string[] {
  if (process.platform !== "win32") return [];
  const r = spawnSync(icaclsPath(), [HOME_DIR], { windowsHide: true, encoding: "utf8", shell: false, timeout: 10_000 });
  if (r.status !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(HOME_DIR, "").trim())
    .filter((line) => line.includes(":("))
    .map((line) => line.slice(0, line.indexOf(":(")));
}
