import path from "node:path";
import { resolveWrite } from "../policy/paths.js";
import type { ArgvToken, BridgeCommand, BridgeParam } from "./types.js";

export type ArgvResult = { ok: true; argv: string[] } | { ok: false; error: string };

const MAX_VALUE = 4000;

/** Normalise one caller value against its declared param. Throws on anything unsafe. */
function coerce(name: string, p: BridgeParam, raw: unknown, workspace: string): string {
  if (p.type === "number") {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
    return String(n);
  }
  if (typeof raw !== "string") throw new Error(`${name} must be a string`);
  if (raw.length > MAX_VALUE || raw.includes("\0")) throw new Error(`${name} is too long or contains a NUL`);
  if (p.type === "enum") {
    if (!p.values?.includes(raw)) throw new Error(`${name} must be one of: ${(p.values ?? []).join(", ")}`);
    return raw;
  }
  // A value that starts with "-" would be read by the program as an option of its own.
  if (raw.startsWith("-")) throw new Error(`${name} must not start with "-"`);
  if (p.type === "path") {
    return p.access === "write" ? resolveWrite(workspace, raw) : path.resolve(workspace, raw);
  }
  return raw;
}

function fill(token: string, values: Map<string, string>): string {
  return token.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_m, n: string) => {
    const v = values.get(n);
    if (v === undefined) throw new Error(`param ${n} is required by this command`);
    return v;
  });
}

/**
 * Build the argv array for a command. Never builds a shell string: every token
 * stays its own element, so a value can not add options or chain commands.
 */
export function buildArgv(cmd: BridgeCommand, args: Record<string, unknown>, workspace: string): ArgvResult {
  try {
    for (const k of Object.keys(args)) {
      if (!(k in cmd.params)) throw new Error(`unknown param: ${k}`);
    }
    const values = new Map<string, string>();
    for (const [name, p] of Object.entries(cmd.params)) {
      const raw = args[name];
      if (raw === undefined || raw === null || raw === "") {
        if (p.required) throw new Error(`${name} is required`);
        continue;
      }
      values.set(name, coerce(name, p, raw, workspace));
    }
    const argv: string[] = [];
    for (const t of cmd.argv as ArgvToken[]) {
      if (typeof t === "string") argv.push(fill(t, values));
      else if (values.has(t.when)) for (const a of t.args) argv.push(fill(a, values));
    }
    return { ok: true, argv };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
