/** Typst academic publishing engine (blueprint §7.3): locate the CLI among a
 *  FIXED candidate list (never from request values or the environment PATH —
 *  the spawned executable is always one of two machine-local literals), report
 *  status honestly, and compile Typst markup to PDF. The binary is not in git;
 *  install it to <DATA_DIR>/bin/typst.exe or tools/typst/.../typst.exe. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../config.js";

const COMPILE_TIMEOUT_MS = 30_000;
const SOURCE_MAX_BYTES = 2_000_000;

/** Fixed, machine-local literals only — the spawn target is chosen from this
 *  closed list, never derived from request data or environment variables. */
function candidatePaths(): string[] {
  return [
    path.join(DATA_DIR, "bin", "typst.exe"),
    path.join(process.cwd(), "tools", "typst", "typst-x86_64-pc-windows-msvc", "typst.exe"),
  ];
}

function firstExisting(): string | null {
  for (const candidate of candidatePaths()) {
    try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch { /* keep probing */ }
  }
  return null;
}

async function runVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["--version"], { timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => resolve(null));
    child.on("close", (code: number | null) => resolve(code === 0 ? out.trim() : null));
  });
}

export interface TypstStatus { installed: boolean; version: string | null; path: string | null }

export async function typstStatus(): Promise<TypstStatus> {
  const binary = firstExisting();
  if (!binary) return { installed: false, version: null, path: null };
  const version = await runVersion(binary);
  if (!version) return { installed: false, version: null, path: binary };
  return { installed: true, version, path: binary };
}

/** Compile Typst markup to PDF bytes. Runs inside an owned temp directory with
 *  a hard timeout; the source never reaches a shell (args are file paths). */
export async function compileTypst(source: string): Promise<{ pdf: Buffer; warnings: string[] }> {
  if (typeof source !== "string" || source.trim().length === 0) throw new Error("empty source");
  if (Buffer.byteLength(source, "utf8") > SOURCE_MAX_BYTES) throw new Error("source too large (2 MB cap)");
  const probe = await typstStatus();
  if (!probe.installed || !probe.path) throw new Error("typst is not installed on this machine");
  // TS narrowing does not survive into the promise-executor closure — bind the
  // executable to a local string first.
  const bin: string = probe.path;
  const warnings: string[] = [];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typst-compile-"));
  try {
    const input = path.join(dir, "input.typ");
    const output = path.join(dir, "output.pdf");
    fs.writeFileSync(input, source, "utf8");
    await new Promise<void>((resolve, reject) => {
      // Executable comes from the fixed local allow-list (see candidatePaths);
      // arguments are a strict list — no shell, no user input in the command.
      const child = spawn(bin, ["compile", "--root", dir, input, output], { timeout: COMPILE_TIMEOUT_MS, cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code: number | null) => {
        if (code === 0) return resolve();
        reject(new Error(stderr.trim().split("\n").slice(-4).join("\n") || `typst exited ${code}`));
      });
    });
    if (!fs.existsSync(output)) throw new Error("typst produced no PDF");
    const pdf = fs.readFileSync(output);
    if (pdf.subarray(0, 4).toString("ascii") !== "%PDF") throw new Error("output is not a PDF");
    return { pdf, warnings };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
