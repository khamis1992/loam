/**
 * V5 design_autofix tests.
 *
 * The deterministic repair pass must make a freshly generated web UI build
 * without a model and without network I/O:
 *  - missing imports (local components, shadcn/ui, lucide-react, react builtins)
 *  - missing package.json dependencies from the curated allowlist
 *  - missing providers wrapping the root component
 *  - raw Tailwind colours and arbitrary pixel values replaced by Loam UI Kit
 *    semantic tokens
 *
 * The acceptance test copies the seeded fixture, proves it does NOT type-check
 * before the pass, runs the pass, then proves it DOES type-check afterwards.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  autofixProject,
  DESIGN_AUTOFIX_TOOL_NAME,
  type DesignFileMap,
} from "../autofix.js";
import { createDesignAutofixTools, runDesignAutofix } from "../../tools/designAutofix.js";
import { ALWAYS_ON_TOOLS, mergeAlwaysOnTools } from "../../server/runTools.js";
import type { ToolContext } from "../../tools/registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "../../../design-fixtures/web-app-seeded");

const require = createRequire(import.meta.url);
const TSC = path.join(path.dirname(require.resolve("typescript")), "..", "bin", "tsc");

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function readJson(fileMap: DesignFileMap, rel: string): Record<string, unknown> {
  const raw = fileMap[rel];
  assert.ok(raw !== undefined, `expected ${rel} to exist`);
  return JSON.parse(raw) as Record<string, unknown>;
}

function runTsc(cwd: string): { ok: boolean; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [TSC, "--noEmit", "-p", "tsconfig.json"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: stdout };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
    return { ok: false, output: `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}` };
  }
}

const BUTTON_MODULE = `export function Button({ children }: { children?: unknown }) {\n  return <button>{children}</button>;\n}\n`;

const TOOLTIP_MODULE = [
  'import type { ReactNode } from "react";',
  "export function Tooltip({ children }: { children?: ReactNode }) { return <span>{children}</span>; }",
  "export function TooltipTrigger({ children }: { children?: ReactNode }) { return <span>{children}</span>; }",
  "export function TooltipContent({ children }: { children?: ReactNode }) { return <span>{children}</span>; }",
  "export function TooltipProvider({ children }: { children?: ReactNode }) { return <span>{children}</span>; }",
  "",
].join("\n");

describe("autofixProject: imports", () => {
  it("adds missing imports for a local component and a lucide icon", () => {
    const { files, report } = autofixProject({
      "src/components/ui/button.tsx": BUTTON_MODULE,
      "src/App.tsx": "export default function App() {\n  return (\n    <main>\n      <Button>Save</Button>\n      <Search />\n    </main>\n  );\n}\n",
      "package.json": JSON.stringify({ name: "x", dependencies: { react: "^18.3.1" } }),
    });

    const app = files["src/App.tsx"]!;
    assert.match(app, /import \{ Button \} from "@\/components\/ui\/button";/);
    assert.match(app, /import \{ Search \} from "lucide-react";/);
    assert.equal(report.counts.missing_import, 2);

    const pkg = readJson(files, "package.json");
    const deps = pkg["dependencies"] as Record<string, string>;
    assert.equal(deps["lucide-react"], "^0.469.0");
    assert.equal(report.counts.missing_dependency, 1);
  });

  it("resolves sibling exports that share one module", () => {
    const { files, report } = autofixProject({
      "src/components/ui/tooltip.tsx": TOOLTIP_MODULE,
      "src/App.tsx":
        "export default function App() {\n  return (\n    <main>\n      <Tooltip>\n        <TooltipTrigger>H</TooltipTrigger>\n        <TooltipContent>T</TooltipContent>\n      </Tooltip>\n    </main>\n  );\n}\n",
    });

    const app = files["src/App.tsx"]!;
    assert.equal(report.counts.missing_import, 3);
    const line = app.split("\n").find((l) => l.includes('from "@/components/ui/tooltip"'));
    assert.ok(line, "expected a single import line for the tooltip module");
    for (const name of ["Tooltip", "TooltipTrigger", "TooltipContent"]) {
      assert.ok(line!.includes(name), `expected ${name} in the merged import`);
    }
  });

  it("does not re-add imports that already exist", () => {
    const { report } = autofixProject({
      "src/components/ui/button.tsx": BUTTON_MODULE,
      "src/App.tsx":
        'import { Button } from "@/components/ui/button";\nexport default function App() {\n  return <Button />;\n}\n',
    });
    assert.equal(report.counts.missing_import, 0);
    assert.equal(report.changed.length, 0);
  });
});

describe("autofixProject: providers", () => {
  it("wraps the root in the required provider and merges the import", () => {
    const { files, report } = autofixProject({
      "src/components/ui/tooltip.tsx": TOOLTIP_MODULE,
      "src/App.tsx":
        "export default function App() {\n  return (\n    <main>\n      <Tooltip>\n        <TooltipTrigger>H</TooltipTrigger>\n        <TooltipContent>T</TooltipContent>\n      </Tooltip>\n    </main>\n  );\n}\n",
    });

    const app = files["src/App.tsx"]!;
    assert.equal(report.counts.missing_provider, 1);
    assert.match(app, /<TooltipProvider>/);
    assert.match(app, /<\/TooltipProvider>/);
    assert.equal(app.match(/from "@\/components\/ui\/tooltip"/g)?.length, 1, "single merged import");
  });

  it("leaves an already-wrapped tree alone", () => {
    const { report } = autofixProject({
      "src/components/ui/tooltip.tsx": TOOLTIP_MODULE,
      "src/App.tsx":
        'import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";\nexport default function App() {\n  return (\n    <TooltipProvider>\n      <Tooltip>\n        <TooltipTrigger>H</TooltipTrigger>\n        <TooltipContent>T</TooltipContent>\n      </Tooltip>\n    </TooltipProvider>\n  );\n}\n',
    });
    assert.equal(report.counts.missing_provider, 0);
  });
});

describe("autofixProject: tokens", () => {
  it("replaces raw colours and arbitrary pixel values with tokens", () => {
    const { files, report } = autofixProject({
      "src/App.tsx":
        'export default function App() {\n  return <main className="bg-white text-black p-[13px] text-[16px] bg-[#ffffff]">x</main>;\n}\n',
    });

    const app = files["src/App.tsx"]!;
    assert.match(app, /bg-background/);
    assert.match(app, /text-foreground/);
    assert.match(app, /p-3/);
    assert.match(app, /text-base/);
    assert.ok(!app.includes("bg-white"));
    assert.ok(!app.includes("text-black"));
    assert.ok(!app.includes("p-[13px]"));
    assert.ok(report.counts.token_replacement >= 4);
  });
});

describe("autofixProject: safety and determinism", () => {
  it("skips node_modules and build output", () => {
    const { files } = autofixProject({
      "node_modules/pkg/index.ts": "export default function N() { return <Ghost />; }\n",
      "dist/bundle.ts": "export default function D() { return <Ghost />; }\n",
      "src/App.tsx": "export default function App() { return <main />; }\n",
    });
    assert.equal(files["node_modules/pkg/index.ts"], undefined);
    assert.equal(files["dist/bundle.ts"], undefined);
  });

  it("does not treat ambient declaration modules as importable components", () => {
    const { files } = autofixProject({
      "src/env.d.ts": "declare module 'lucide-react' { export const Ghost: unknown; }\n",
      "src/App.tsx": "export default function App() { return <main><Ghost /></main>; }\n",
    });
    assert.ok(!files["src/App.tsx"]!.includes("env.d"));
  });

  it("is idempotent: the second pass changes nothing", () => {
    const input: DesignFileMap = {
      "src/components/ui/button.tsx": BUTTON_MODULE,
      "src/App.tsx": "export default function App() {\n  return <main className=\"bg-white\"><Button /></main>;\n}\n",
      "package.json": JSON.stringify({ name: "x", dependencies: { react: "^18.3.1" } }),
    };
    const first = autofixProject(input);
    assert.ok(first.report.changed.length > 0);
    const second = autofixProject(first.files);
    assert.equal(second.report.changed.length, 0);
    assert.equal(second.report.fixes.length, 0);
    assert.deepEqual(second.files, first.files);
  });
});

describe("design_autofix tool", () => {
  const ctx = (workspace: string): ToolContext =>
    ({ cfg: {}, workspace, emit: () => undefined }) as unknown as ToolContext;

  function tool() {
    return createDesignAutofixTools().find((t) => t.name === DESIGN_AUTOFIX_TOOL_NAME)!;
  }

  it("is registered as an always-on design tool", () => {
    assert.ok(ALWAYS_ON_TOOLS.includes(DESIGN_AUTOFIX_TOOL_NAME));
    const merged = mergeAlwaysOnTools({
      resolvedAllow: [],
      registeredTools: [DESIGN_AUTOFIX_TOOL_NAME],
    });
    assert.ok(merged.includes(DESIGN_AUTOFIX_TOOL_NAME));
  });

  it("dryRun reports the plan without writing files", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-autofix-dry-"));
    try {
      copyDir(FIXTURE, path.join(workspace, "web"));
      const result = await tool().run({ projectDir: "web", dryRun: true }, ctx(workspace));
      assert.equal(result.ok, true);
      const summary = JSON.parse(result.content) as { dryRun: boolean; changed: string[]; fixes: unknown[] };
      assert.equal(summary.dryRun, true);
      assert.ok(summary.changed.length > 0);
      assert.ok(summary.fixes.length > 0);
      const app = fs.readFileSync(path.join(workspace, "web", "src", "App.tsx"), "utf8");
      assert.ok(app.includes("bg-white"), "dry run must not modify the file");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("writes repairs and returns a summary", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-autofix-run-"));
    try {
      copyDir(FIXTURE, path.join(workspace, "web"));
      const summary = runDesignAutofix(path.join(workspace, "web"), false);
      assert.equal(summary.ok, true);
      assert.ok(summary.changed.includes("src/App.tsx"));
      const app = fs.readFileSync(path.join(workspace, "web", "src", "App.tsx"), "utf8");
      assert.match(app, /bg-background/);
      assert.match(app, /<TooltipProvider>/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("refuses an absolute projectDir outside the workspace", async () => {
    const result = await tool().run({ projectDir: "C:/elsewhere" }, ctx("C:/tmp/ws"));
    assert.equal(result.ok, false);
    assert.match(result.content, /refused/);
  });
});

describe("acceptance: seeded fixture builds after the fix", () => {
  it("type-checks after design_autofix repairs the seeded errors", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-autofix-fixture-"));
    try {
      const project = path.join(workspace, "web-app-seeded");
      copyDir(FIXTURE, project);

      const before = runTsc(project);
      assert.equal(before.ok, false, "fixture must be broken before the fix");

      const summary = runDesignAutofix(project, false);
      assert.equal(summary.ok, true);
      const counts = summary.counts as Record<string, number | undefined>;
      assert.ok((counts["missing_import"] ?? 0) > 0);
      assert.ok((counts["missing_dependency"] ?? 0) > 0);
      assert.ok((counts["missing_provider"] ?? 0) > 0);
      assert.ok((counts["token_replacement"] ?? 0) > 0);

      const after = runTsc(project);
      assert.equal(after.ok, true, `fixture must build after the fix:\n${after.output}`);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
