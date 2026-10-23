/**
 * design_autofix — agent tool wrapper around the deterministic design repair
 * pass (src/design/autofix.ts).
 *
 * After a generated web UI is written, run this before the build loop. It adds
 * missing imports, adds missing package.json dependencies from a curated
 * allowlist, wraps components that need a provider, and replaces raw Tailwind
 * colours and arbitrary pixel values with the Loam UI Kit semantic tokens. The
 * pass is deterministic and offline; it never calls a model and never adds a
 * dependency version outside the allowlist.
 *
 * Writes are confined to the task workspace and `dryRun` reports the repair
 * plan without touching disk.
 */

import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";
import { resolveScaffoldDir } from "./backendScaffold.js";
import { autofixProject, DESIGN_AUTOFIX_TOOL_NAME, type DesignFileMap } from "../design/autofix.js";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".git", ".loam"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".jsx", ".js", ".json"]);

function collectFiles(dir: string): DesignFileMap {
  const out: DesignFileMap = {};
  const walk = (abs: string, rel: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      out[childRel] = fs.readFileSync(childAbs, "utf8");
    }
  };
  walk(dir, "");
  return out;
}

function writeFiles(dir: string, files: DesignFileMap): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

export interface DesignAutofixSummary {
  ok: boolean;
  projectDir: string;
  dryRun: boolean;
  changed: string[];
  counts: Record<string, number>;
  fixes: Array<{ kind: string; file: string; detail: string }>;
  message: string;
}

/** Apply the deterministic repair pass to a directory on disk. */
export function runDesignAutofix(dir: string, dryRun: boolean): DesignAutofixSummary {
  const files = collectFiles(dir);
  const { files: fixed, report } = autofixProject(files);
  if (!dryRun && report.changed.length > 0) writeFiles(dir, fixed);
  return {
    ok: report.ok,
    projectDir: dir,
    dryRun,
    changed: report.changed,
    counts: report.counts,
    fixes: report.fixes,
    message:
      report.fixes.length === 0
        ? "design_autofix: no repairs needed."
        : `design_autofix: ${report.fixes.length} repair(s) across ${report.changed.length} file(s)${dryRun ? " (dry run, nothing written)" : ""}.`,
  };
}

export function createDesignAutofixTools(): Tool[] {
  return [
    {
      name: DESIGN_AUTOFIX_TOOL_NAME,
      description:
        "Deterministic repair pass for generated web UI code, run before the build loop. Scans the project (TypeScript/TSX/JS/JSX plus package.json) and applies four offline fixes: (1) adds missing React, shadcn/ui and lucide-react imports for components used in JSX; (2) adds missing package.json dependencies from a curated allowlist (react, react-dom, lucide-react, recharts, next-themes, sonner, clsx, tailwind-merge, class-variance-authority, Radix tooltip/slot/dialog/dropdown-menu, @tanstack/react-query) using fixed compatible versions; (3) wraps the root component in a required provider such as TooltipProvider when tooltip components are used without one; (4) replaces raw Tailwind colours (bg-white, text-black, bg-gray-*, arbitrary #hex) and arbitrary pixel spacing/font sizes with the Loam UI Kit semantic tokens and the Tailwind spacing/type scale. Use dryRun=true to preview the repair plan without writing. Never adds a dependency version outside the allowlist and never performs network I/O.",
      parameters: {
        type: "object",
        properties: {
          projectDir: {
            type: "string",
            description: "Relative subdirectory of the workspace containing the web app (default: workspace root).",
          },
          dryRun: {
            type: "boolean",
            description: "When true, report the repair plan without writing any file (default: false).",
          },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const projectDir = str(args, "projectDir", ".").trim() || ".";
        const dryRun = args.dryRun === true || str(args, "dryRun") === "true";
        let dir: string;
        try {
          dir = resolveScaffoldDir(ctx.workspace, projectDir);
        } catch (err) {
          return { ok: false, content: `design_autofix refused: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          return { ok: false, content: `design_autofix: project directory not found: ${dir}` };
        }
        try {
          const files = collectFiles(dir);
          const { files: fixed, report } = autofixProject(files);
          if (!dryRun && report.changed.length > 0) writeFiles(dir, fixed);
          const summary: DesignAutofixSummary = {
            ok: report.ok,
            projectDir,
            dryRun,
            changed: report.changed,
            counts: report.counts,
            fixes: report.fixes,
            message:
              report.fixes.length === 0
                ? "design_autofix: no repairs needed."
                : `design_autofix: ${report.fixes.length} repair(s) across ${report.changed.length} file(s)${dryRun ? " (dry run, nothing written)" : ""}.`,
          };
          return { ok: true, content: JSON.stringify(summary) };
        } catch (err) {
          return { ok: false, content: `design_autofix failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  ];
}
