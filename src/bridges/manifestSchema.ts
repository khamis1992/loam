import type { ArgvToken, BridgeCommand, BridgeEffect, BridgeManifest, BridgeParam, ParamType } from "./types.js";

const ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const PLACEHOLDER_RE = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
const EFFECTS: BridgeEffect[] = ["read", "write_workspace", "exec_script", "external"];
const PARAM_TYPES: ParamType[] = ["string", "path", "number", "enum"];

export type ParseResult = { ok: true; manifest: BridgeManifest } | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strList(v: unknown, what: string, max = 40): string[] {
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 400)) {
    throw new Error(`${what} must be a list of non-empty strings`);
  }
  return v as string[];
}

function placeholdersOf(s: string): string[] {
  return [...s.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!);
}

function parseParam(name: string, raw: unknown): BridgeParam {
  if (!isObj(raw)) throw new Error(`param ${name} must be an object`);
  const type = raw.type;
  if (typeof type !== "string" || !PARAM_TYPES.includes(type as ParamType)) throw new Error(`param ${name}: bad type`);
  const out: BridgeParam = { type: type as ParamType };
  if (typeof raw.description === "string") out.description = raw.description.slice(0, 300);
  if (raw.required === true) out.required = true;
  if (type === "enum") out.values = strList(raw.values, `param ${name}.values`, 100);
  if (type === "path") {
    const access = raw.access ?? "read";
    if (access !== "read" && access !== "write") throw new Error(`param ${name}: access must be read or write`);
    out.access = access;
  }
  return out;
}

function parseArgv(raw: unknown, params: Record<string, BridgeParam>, cmd: string): ArgvToken[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 60) throw new Error(`${cmd}: argv must be a non-empty list`);
  const known = (n: string): void => {
    if (!(n in params)) throw new Error(`${cmd}: argv references unknown param ${n}`);
  };
  return raw.map((t): ArgvToken => {
    if (typeof t === "string") {
      if (t.length > 400) throw new Error(`${cmd}: argv token too long`);
      placeholdersOf(t).forEach(known);
      return t;
    }
    if (isObj(t) && typeof t.when === "string") {
      known(t.when);
      const args = strList(t.args, `${cmd}: argv group`, 20);
      args.forEach((a) => placeholdersOf(a).forEach(known));
      return { when: t.when, args };
    }
    throw new Error(`${cmd}: argv token must be a string or {when,args}`);
  });
}

function parseCommand(raw: unknown): BridgeCommand {
  if (!isObj(raw)) throw new Error("command must be an object");
  const id = raw.id;
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`bad command id: ${String(id)}`);
  if (typeof raw.description !== "string" || !raw.description.trim()) throw new Error(`${id}: description required`);
  if (typeof raw.effect !== "string" || !EFFECTS.includes(raw.effect as BridgeEffect)) throw new Error(`${id}: bad effect`);
  const paramsRaw = raw.params ?? {};
  if (!isObj(paramsRaw)) throw new Error(`${id}: params must be an object`);
  const params: Record<string, BridgeParam> = {};
  for (const [k, v] of Object.entries(paramsRaw)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(k)) throw new Error(`${id}: bad param name ${k}`);
    params[k] = parseParam(k, v);
  }
  const effect = raw.effect as BridgeEffect;
  // A command that writes must say which file it writes, or confinement could not apply.
  if (effect === "write_workspace" && !Object.values(params).some((p) => p.type === "path" && p.access === "write")) {
    throw new Error(`${id}: write_workspace needs a path param with access "write"`);
  }
  const output = raw.output ?? "text";
  if (output !== "json" && output !== "text") throw new Error(`${id}: output must be json or text`);
  const cmd: BridgeCommand = {
    id,
    description: raw.description.trim().slice(0, 400),
    effect,
    argv: parseArgv(raw.argv, params, id),
    params,
    output,
  };
  if (raw.timeoutSeconds !== undefined) {
    if (typeof raw.timeoutSeconds !== "number" || raw.timeoutSeconds < 1 || raw.timeoutSeconds > 900) {
      throw new Error(`${id}: timeoutSeconds must be 1..900`);
    }
    cmd.timeoutSeconds = raw.timeoutSeconds;
  }
  return cmd;
}

/** Validate an untrusted manifest. Fails closed with the first problem found. */
export function parseManifest(raw: unknown): ParseResult {
  try {
    if (!isObj(raw)) throw new Error("manifest must be an object");
    if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) throw new Error("bad manifest id");
    if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("name required");
    if (typeof raw.description !== "string") throw new Error("description required");
    if (!isObj(raw.probe)) throw new Error("probe required");
    const probe: BridgeManifest["probe"] = { names: strList(raw.probe.names, "probe.names", 10) };
    if (raw.probe.paths !== undefined) probe.paths = strList(raw.probe.paths, "probe.paths", 20);
    if (raw.probe.appPaths !== undefined) probe.appPaths = strList(raw.probe.appPaths, "probe.appPaths", 10);
    if (!Array.isArray(raw.commands) || raw.commands.length === 0 || raw.commands.length > 40) {
      throw new Error("commands must be a non-empty list");
    }
    const commands = raw.commands.map(parseCommand);
    if (new Set(commands.map((c) => c.id)).size !== commands.length) throw new Error("duplicate command id");
    const manifest: BridgeManifest = {
      id: raw.id,
      name: raw.name.trim(),
      description: raw.description.trim().slice(0, 400),
      probe,
      commands,
    };
    if (raw.versionArgs !== undefined) manifest.versionArgs = strList(raw.versionArgs, "versionArgs", 6);
    return { ok: true, manifest };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
