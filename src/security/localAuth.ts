import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Per-install token that protects the loopback HTTP server.
 *  It is stored in the Electron user-data directory, never in the renderer,
 *  and injected by the main process via an HTTP header. */
export const LOCAL_AUTH_TOKEN_FILE = ".loam-local-auth-token";

export function tokenFilePath(userDataDir: string): string {
  return path.join(userDataDir, LOCAL_AUTH_TOKEN_FILE);
}

/** Read an existing token or create a new 256-bit install token. */
export function getOrCreateLocalToken(userDataDir: string): string {
  const p = tokenFilePath(userDataDir);
  try {
    if (fs.existsSync(p)) {
      const token = fs.readFileSync(p, "utf8").trim();
      if (token.length > 0) return token;
    }
  } catch {
    /* ignore */
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(p, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

/** Read the current token without creating one. */
export function readLocalToken(userDataDir: string): string | undefined {
  const p = tokenFilePath(userDataDir);
  try {
    const token = fs.readFileSync(p, "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Constant-time token comparison. */
export function validateLocalToken(userDataDir: string, token: string | undefined): boolean {
  if (!token) return false;
  const expected = readLocalToken(userDataDir);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
