import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { authorizationActive, targetInScope, type AuthorizationRecord } from "../red/gate.js";
import { assertExternalLicense } from "./licenses.js";
import { engineManifest, type EngineManifest } from "./registry.js";

export interface EngineExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }
export type EngineExec = (exe: string, argv: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number; maxBytes: number }) => Promise<EngineExecResult>;

export interface EngineWorkerInput {
  engineId: string;
  commandId: string;
  authz: AuthorizationRecord;
  scopeTarget: string;
  target: string;
  program?: string;
  workspace: string;
  licenseReviewed: boolean;
  exec?: EngineExec;
}

const defaultExec: EngineExec = function (exe, argv, options) {
  return new Promise((resolve) => {
    const child = spawn(exe, argv, { cwd: options.cwd, shell: false, windowsHide: true, env: options.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < options.maxBytes) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 20_000) stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, timedOut, error: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
};

function resolveExecutable(manifest: EngineManifest): { path: string; sha256: string } {
  if (!manifest.executableEnv || !manifest.sha256Env) throw new Error(`${manifest.id} is an external service and has no process adapter`);
  const exe = process.env[manifest.executableEnv];
  const sha256 = process.env[manifest.sha256Env];
  if (!exe || !sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error(`${manifest.id} executable and SHA256 pin are required`);
  const stat = fs.lstatSync(exe);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${manifest.id} executable must be a regular file without symlinks`);
  const actual = createHash("sha256").update(fs.readFileSync(exe)).digest("hex");
  if (actual.toLowerCase() !== sha256.toLowerCase()) throw new Error(`${manifest.id} executable SHA256 mismatch`);
  return { path: exe, sha256 };
}

function workspacePath(workspace: string, candidate: string): string {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("engine input escapes workspace");
  return resolved;
}

export async function runEngineWorker(input: EngineWorkerInput): Promise<{ status: "covered" | "partial" | "error" | "unavailable"; engineId: string; commandId: string; evidenceSha256: string; idempotencyKey: string; detail: string }> {
  const manifest = engineManifest(input.engineId);
  const detailBase = `${manifest.id}:${input.commandId}`;
  try {
    if (!manifest.commands.includes(input.commandId)) throw new Error(`command ${input.commandId} is not registered for ${manifest.id}`);
    assertExternalLicense(manifest.licenseClass, input.licenseReviewed);
    if (!authorizationActive(input.authz) || !targetInScope(input.authz.scope, input.scopeTarget)) throw new Error("engine target is outside active authorization");
    const engine = resolveExecutable(manifest);
    const target = input.engineId === "jazzer" ? input.target : workspacePath(input.workspace, input.target);
    let argv: string[] = [];
    if (input.commandId === "decompile") argv = ["-d", target];
    else if (input.commandId === "fuzz" && input.engineId === "aflplusplus") argv = ["-i", target, "-o", workspacePath(input.workspace, "afl-output"), "--", workspacePath(input.workspace, input.program ?? "")];
    else if (input.commandId === "fuzz" && input.engineId === "jazzer") argv = ["--cp", workspacePath(input.workspace, input.program ?? ""), "-t", target];
    if (!argv.length || argv.some((value) => !value) || (manifest.id !== "jadx" && !input.program)) throw new Error("engine command requires a target and program");
    const exec = input.exec ?? defaultExec;
    const result = await exec(engine.path, argv, { cwd: path.resolve(input.workspace), env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", JAVA_HOME: process.env.JAVA_HOME ?? "" }, timeoutMs: 60_000, maxBytes: 1_000_000 });
    const evidenceSha256 = createHash("sha256").update(`${result.stdout}\n${result.stderr}`).digest("hex");
    const idempotencyKey = createHash("sha256").update(`${manifest.id}\n${input.commandId}\n${target}\n${input.program ?? ""}\n${engine.sha256}`).digest("hex");
    if (result.error) return { status: "unavailable", engineId: manifest.id, commandId: input.commandId, evidenceSha256, idempotencyKey, detail: result.error.slice(0, 300) };
    if (result.timedOut) return { status: "partial", engineId: manifest.id, commandId: input.commandId, evidenceSha256, idempotencyKey, detail: "engine timed out" };
    if (result.code !== 0) return { status: "error", engineId: manifest.id, commandId: input.commandId, evidenceSha256, idempotencyKey, detail: result.stderr.slice(0, 300) || `exit ${result.code}` };
    return { status: "covered", engineId: manifest.id, commandId: input.commandId, evidenceSha256, idempotencyKey, detail: `${detailBase} completed with pinned executable` };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    return { status: "unavailable", engineId: manifest.id, commandId: input.commandId, evidenceSha256: createHash("sha256").update(message).digest("hex"), idempotencyKey: createHash("sha256").update(`${manifest.id}\n${input.target}`).digest("hex"), detail: message };
  }
}
