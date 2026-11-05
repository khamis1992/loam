import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Tool, ToolContext, ToolResult } from "../../tools/registry.js";
import { bool, str, strs } from "../../tools/registry.js";
import { readPackProject, writePackProject, presentPackProject } from "../present.js";
import type { PackProject } from "../types.js";
import { taskPath } from "../../server/taskWorkspace.js";
import { scaffoldWebApp } from "../../tools/webScaffold.js";
import { createApproval, waitForDecision } from "../../server/approvals.js";
import { createDeployTools } from "../../tools/deploy.js";

interface SiteData {
  title?: string;
  projectDir?: string;
  entryPath?: string;
  checkpoints?: Array<{ path: string; files: number; sha256: string }>;
}

export interface SitePackOptions {
  deploy?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  approvalTimeoutMs?: number;
}

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], handler: Handler): Tool {
  return {
    name,
    description,
    parameters: { type: "object", additionalProperties: false, properties, required },
    async run(args, ctx) {
      try {
        return await handler(args, ctx);
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function json(value: unknown): ToolResult {
  return { ok: true, content: JSON.stringify(value) };
}

function project(ctx: ToolContext): PackProject {
  const value = readPackProject(ctx.workspace, "loam-build");
  if (!value) throw new Error("site project is missing; call site_attach or site_init");
  return value;
}

function dataOf(value: PackProject): SiteData {
  return (value.data ?? {}) as SiteData;
}

function save(ctx: ToolContext, value: PackProject, data: SiteData): void {
  value.data = { ...value.data, ...data } as unknown as Record<string, unknown>;
  writePackProject(ctx.workspace, { ...value, revision: value.revision + 1 });
}

function projectDir(value: PackProject): string {
  return dataOf(value).projectDir ?? ".";
}

function findEntry(ctx: ToolContext, value: PackProject): string | null {
  const base = projectDir(value);
  for (const candidate of ["dist/index.html", "build/index.html", "out/index.html", "www/index.html", "index.html"]) {
    const relative = path.join(base, candidate);
    try {
      if (fs.statSync(taskPath(ctx.workspace, relative)).isFile()) return relative.replace(/\\/g, "/");
    } catch {
      // Try the next conventional build output.
    }
  }
  return null;
}

function filesForCheckpoint(root: string): Array<{ path: string; sha256: string }> {
  const result: Array<{ path: string; sha256: string }> = [];
  const walk = (directory: string, relative: string): void => {
    if (result.length >= 500) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", ".git", ".loam", "dist", "build", "out"].includes(entry.name)) continue;
      const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("links are not allowed in site checkpoints");
      if (entry.isDirectory()) walk(absolute, nextRelative);
      else if (entry.isFile()) {
        result.push({ path: nextRelative.replace(/\\/g, "/"), sha256: createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") });
        if (result.length >= 500) break;
      }
    }
  };
  if (fs.existsSync(root)) walk(root, "");
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export function createSitePackTools(options: SitePackOptions = {}): Tool[] {
  const init = async (args: Record<string, unknown>, ctx: ToolContext, attach: boolean): Promise<ToolResult> => {
    const existing = readPackProject(ctx.workspace, "loam-build");
    if (existing) return json({ attached: true, project: existing });
    const title = str(args, "title", "Loam Website");
    const dir = str(args, "projectDir", ".");
    const root = taskPath(ctx.workspace, dir);
    if (!attach && bool(args, "scaffold", true)) scaffoldWebApp(root, undefined, false);
    const value: PackProject = {
      projectId: ctx.taskId ?? "local-site",
      packId: "loam-build",
      revision: 0,
      items: [{ id: "site-1", state: "pending" }],
      data: { title, projectDir: dir },
    };
    writePackProject(ctx.workspace, value);
    return json({ project: value, attached: attach });
  };

  return [
    tool("site_init", "Initialize one website project over the existing offline scaffold. Existing projects are attached, never duplicated.", {
      title: { type: "string" },
      projectDir: { type: "string" },
      scaffold: { type: "boolean" },
    }, [], async (args, ctx) => init(args, ctx, false)),

    tool("site_attach", "Attach the current website project without scaffolding or replacing any files.", {
      title: { type: "string" },
      projectDir: { type: "string" },
    }, [], async (args, ctx) => init(args, ctx, true)),

    tool("site_checkpoint", "Record a real checkpoint of source-file hashes and verify the built HTML entry. Never creates a Git commit or tag.", {}, [], async (_args, ctx) => {
      const value = project(ctx);
      const entry = findEntry(ctx, value);
      if (!entry) return { ok: false, content: JSON.stringify({ error: "build_output_missing", expected: "dist/index.html or index.html" }) };
      const html = fs.readFileSync(taskPath(ctx.workspace, entry), "utf8");
      if (!/<title>[^<]+<\/title>/i.test(html) || !/<body[\s\S]*\S[\s\S]*<\/body>/i.test(html)) return { ok: false, content: JSON.stringify({ error: "site_verification_failed", entry }) };
      if (/<script[^>]+src\s*=|<(?:img|iframe|video|audio|source)[^>]+src\s*=\s*["']https?:|<link[^>]+href\s*=\s*["']https?:|url\(\s*['"]?https?:|via\.placeholder\.com|placehold\.co/i.test(html)) {
        return { ok: false, content: JSON.stringify({ error: "external_or_placeholder_asset", entry }) };
      }
      const root = taskPath(ctx.workspace, projectDir(value));
      const files = filesForCheckpoint(root);
      const combined = createHash("sha256").update(JSON.stringify(files)).digest("hex");
      const checkpointPath = `.loam/packs/loam-build/checkpoints/${Date.now()}-${combined.slice(0, 12)}.json`;
      const absolute = taskPath(ctx.workspace, checkpointPath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, JSON.stringify({ entry, files, sha256: combined, gitCommitCreated: false }, null, 2));
      const checkpoints = [...(dataOf(value).checkpoints ?? []), { path: checkpointPath, files: files.length, sha256: combined }];
      value.items = [{ id: "site-1", state: "final", path: entry }];
      save(ctx, value, { entryPath: entry, checkpoints });
      return json({ checkpoint: checkpointPath, entry, files: files.length, sha256: combined, gitCommitCreated: false });
    }),

    tool("site_secrets_request", "Host-only route to the existing App Builder secret form. Secret values never enter chat, the manifest or tool logs.", {
      names: { type: "array", items: { type: "string" } },
    }, ["names"], async (args, _ctx) => json({
      hostForm: "app-builder-settings",
      route: "/app/build",
      secretNames: strs(args, "names").filter((name) => /^[A-Za-z0-9_.-]{1,48}$/.test(name)),
      valuesAccepted: false,
      message: "Enter secrets in the password field of the App Builder host settings. Do not paste them into chat.",
    })),

    tool("site_publish_request", "Host-only deployment gate. Waits for explicit user approval before calling deploy_app, then publishes the verified page.", {
      target: { type: "string", enum: ["local", "vercel", "netlify"] },
    }, [], async (args, ctx) => {
      const value = project(ctx);
      if (value.items.some((item) => item.state !== "final")) return { ok: false, content: JSON.stringify({ error: "site_not_final", missing: value.items.filter((item) => item.state !== "final").map((item) => item.id) }) };
      if (!ctx.taskId) throw new Error("site publish requires a task id");
      const target = str(args, "target", "local");
      const approval = createApproval({ taskId: ctx.taskId, tool: "site_publish_request", summary: `Publish ${dataOf(value).title ?? "website"} to ${target}`, argsPreview: JSON.stringify({ target, projectId: value.projectId }) });
      ctx.emit({ type: "approval_required", approvalId: approval.id, tool: "site_publish_request", summary: approval.summary });
      const decision = await waitForDecision(approval.id, ctx.signal, options.approvalTimeoutMs);
      if (decision !== "approved") return { ok: false, content: JSON.stringify({ error: "publish_not_approved", decision }) };
      const deploy = options.deploy ?? createDeployTools({ workspace: ctx.workspace }).find((candidate) => candidate.name === "deploy_app")!.run;
      const outcome = await deploy({ taskId: ctx.taskId, target }, ctx);
      if (!outcome.ok) return outcome;
      const entry = dataOf(value).entryPath ?? findEntry(ctx, value);
      if (!entry) throw new Error("verified site entry is missing");
      const presented = presentPackProject({ workspace: ctx.workspace, packId: "loam-build", kind: "page", artifacts: [{ path: entry, kind: "page", title: dataOf(value).title ?? "Website", mime: "text/html" }], emit: ctx.emit });
      if (!presented.ok) return { ok: false, content: JSON.stringify(presented) };
      return json({ approvalId: approval.id, deployment: JSON.parse(outcome.content), presentation: presented });
    }),
  ];
}
