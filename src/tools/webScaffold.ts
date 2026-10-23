/**
 * web_scaffold: offline Vite + React + Tailwind starter scaffold.
 *
 * Copies the bundled Loam UI Kit starter (templates/web-app) into a task
 * workspace and, when asked, installs dependencies and builds the app using
 * the local npm cache only (`npm install --offline`). The generated project is
 * Vite + TypeScript + Tailwind v4 with ~25 shadcn-style components, oklch
 * design tokens and RTL/Arabic support.
 *
 * Safety rules baked in:
 *  - Writes are confined to the task workspace; projectDir may not escape it
 *    and existing files are never overwritten unless `overwrite` is requested.
 *  - Install/build run offline from the npm cache; no registry access.
 *  - Commands run with a hard timeout and their output is truncated, so a
 *    runaway build can never hang an agent run.
 *  - The bundled template contains no secrets and no network calls.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, str } from "./registry.js";
import { resolveScaffoldDir } from "./backendScaffold.js";
import { WEB_APP_TEMPLATE_FILES, type WebAppTemplateFile } from "./templates/webapp/webAppTemplate.js";

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
/** Keep the tail of a command's output; enough to diagnose a build failure. */
const MAX_OUTPUT_CHARS = 20_000;

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (command: string, args: string[], options: CommandOptions) => Promise<CommandResult>;

/** Spawn a command, capturing a bounded tail of stdout/stderr and enforcing a timeout. */
export function defaultCommandRunner(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    // Build one command line instead of passing `args` with shell:true: on
    // Windows npm is a .cmd shim that needs a shell, and Node's DEP0190 warns
    // whenever an args array is combined with shell:true. Our tokens are
    // fixed (no user input), but quote defensively anyway.
    const commandLine = [command, ...args]
      .map((token) => (/[\s"']/.test(token) ? `"${token.replaceAll('"', '\\"')}"` : token))
      .join(" ");
    const child = spawn(commandLine, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: true,
    });
    let stdout = "";
    let stderr = "";
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      const next = target === "stdout" ? stdout + text : stderr + text;
      const trimmed = next.length > MAX_OUTPUT_CHARS ? next.slice(-MAX_OUTPUT_CHARS) : next;
      if (target === "stdout") stdout = trimmed;
      else stderr = trimmed;
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    const timer = setTimeout(() => {
      child.kill();
    }, options.timeoutMs);
    const settle = (code: number | null) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    };
    child.once("error", () => settle(null));
    child.once("close", (code) => settle(code));
  });
}

export interface ScaffoldOutcome {
  created: string[];
  skipped: string[];
}

/**
 * Copy the bundled starter into `dir`. Existing files are skipped unless
 * `overwrite` is set, so a scaffold never destroys local work.
 */
export function scaffoldWebApp(dir: string, files: readonly WebAppTemplateFile[] = WEB_APP_TEMPLATE_FILES, overwrite = false): ScaffoldOutcome {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const abs = path.join(dir, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (fs.existsSync(abs) && !overwrite) {
      skipped.push(file.path);
      continue;
    }
    fs.writeFileSync(abs, file.content, "utf8");
    created.push(file.path);
  }
  return { created, skipped };
}

/** The npm binary name differs on Windows, where npm is a .cmd shim. */
function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runStep(runner: CommandRunner, args: string[], dir: string, timeoutMs: number): Promise<CommandResult> {
  return runner(npmCommand(), args, { cwd: dir, timeoutMs });
}

function summarizeCommand(step: string, result: CommandResult): string {
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
  const tail = output.length > 4000 ? `...\n${output.slice(-4000)}` : output;
  return `${step} exited ${result.code ?? "unknown"}${tail ? `\n${tail}` : ""}`;
}

export function createWebScaffoldTools(deps: { runCommand?: CommandRunner } = {}): Tool[] {
  const runner = deps.runCommand ?? defaultCommandRunner;
  return [
    {
      name: "web_scaffold",
      description:
        "Scaffold a production-ready Vite + React + TypeScript web app into the task workspace and build it. Writes the bundled Loam UI Kit starter: Tailwind v4 with oklch design tokens, ~25 shadcn-style components (button, card, dialog, dropdown-menu, select, tabs, tooltip, table, form controls and more), a light/dark theme provider and full RTL/Arabic support via dir + logical properties and an Arabic font token. The starter builds offline from the npm cache (npm install --offline) so no registry access is needed. Existing files are never overwritten unless overwrite=true; projectDir is confined to the workspace. Use this as the first step for any UI task, then edit the generated src/ files. install=false and build=false copy files only.",
      parameters: {
        type: "object",
        properties: {
          projectDir: {
            type: "string",
            description: "Relative subdirectory of the workspace to scaffold into (default: workspace root).",
          },
          install: {
            type: "boolean",
            description: "Install dependencies offline from the npm cache (default true).",
          },
          build: {
            type: "boolean",
            description: "Run `npm run build` after install and report the result (default true).",
          },
          overwrite: {
            type: "boolean",
            description: "Replace existing files with the starter versions (default false; existing files are skipped).",
          },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const projectDir = str(args, "projectDir", ".");
        const install = bool(args, "install", true);
        const build = bool(args, "build", true);
        const overwrite = bool(args, "overwrite", false);

        let dir: string;
        try {
          dir = resolveScaffoldDir(ctx.workspace, projectDir);
        } catch (err) {
          return { ok: false, content: `web_scaffold refused: ${err instanceof Error ? err.message : String(err)}` };
        }

        let outcome: ScaffoldOutcome;
        try {
          outcome = scaffoldWebApp(dir, WEB_APP_TEMPLATE_FILES, overwrite);
        } catch (err) {
          return { ok: false, content: `web_scaffold failed: ${err instanceof Error ? err.message : String(err)}` };
        }

        const parts = [
          `web_scaffold: wrote ${outcome.created.length} file(s) to ${projectDir === "." ? "the workspace root" : projectDir}`,
        ];
        if (outcome.skipped.length > 0) parts.push(`skipped existing: ${outcome.skipped.length} file(s)`);

        if (install) {
          const installed = await runStep(runner, ["install", "--offline", "--no-audit", "--no-fund"], dir, INSTALL_TIMEOUT_MS);
          parts.push(summarizeCommand("npm install --offline", installed));
          if (installed.code !== 0) {
            return { ok: false, content: parts.join("\n\n") };
          }
        }

        if (build) {
          const built = await runStep(runner, ["run", "build"], dir, BUILD_TIMEOUT_MS);
          parts.push(summarizeCommand("npm run build", built));
          if (built.code !== 0) {
            return { ok: false, content: parts.join("\n\n") };
          }
        }

        return { ok: true, content: parts.join("\n\n") };
      },
    },
  ];
}

export const WEB_SCAFFOLD_TOOL_NAMES = ["web_scaffold"];
