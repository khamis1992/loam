import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Tool, ToolContext, ToolResult } from "../tools/registry.js";
import { str } from "../tools/registry.js";
import { readPackProject, writePackProject } from "./present.js";
import type { PackProject } from "./types.js";
import { taskPath } from "../server/taskWorkspace.js";

interface Binding {
  id: string;
  sourcePath: string;
  mirrorPath: string;
  mode: "copy" | "edit";
  baselineSha256: string;
  currentSha256: string;
  selfWatchKey: string;
  backups: string[];
}

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;

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

function digest(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function selectedFiles(ctx: ToolContext): string[] {
  const value = ctx.studioOptions?.localFiles;
  return Array.isArray(value) ? value.filter((file): file is string => typeof file === "string" && path.isAbsolute(file)).map((file) => path.resolve(file)) : [];
}

function assertSelectedSource(ctx: ToolContext, input: string): string {
  const source = path.resolve(input);
  const selected = selectedFiles(ctx).find((file) => file.toLowerCase() === source.toLowerCase());
  if (!selected) throw new Error("local file is not in the explicit user selection");
  const real = fs.realpathSync(selected);
  if (real.toLowerCase() !== selected.toLowerCase()) throw new Error("links are not allowed in local file bindings");
  if (!fs.statSync(selected).isFile()) throw new Error("local binding requires a regular file");
  return selected;
}

function bindings(project: PackProject): Binding[] {
  const value = project.data?.bindings;
  return Array.isArray(value) ? value as Binding[] : [];
}

function save(ctx: ToolContext, project: PackProject, nextBindings: Binding[]): void {
  project.data = { ...project.data, bindings: nextBindings };
  writePackProject(ctx.workspace, { ...project, revision: project.revision + 1 });
}

function bindingFor(project: PackProject, id: string): Binding {
  const binding = bindings(project).find((candidate) => candidate.id === id);
  if (!binding) throw new Error(`local binding not found: ${id}`);
  return binding;
}

function mirrorFor(id: string, source: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `uploads/${safeId}-${path.basename(source)}`;
}

function atomicWrite(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function backup(ctx: ToolContext, binding: Binding): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const relative = `.loam/backups/${stamp}/${binding.id}-${path.basename(binding.sourcePath)}`;
  const absolute = taskPath(ctx.workspace, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.copyFileSync(binding.sourcePath, absolute);
  binding.backups.push(relative);
  return relative;
}

function writeMirror(ctx: ToolContext, binding: Binding, bytes: Buffer): void {
  atomicWrite(taskPath(ctx.workspace, binding.mirrorPath), bytes);
}

function contentBytes(args: Record<string, unknown>): Buffer {
  if (typeof args.contentBase64 === "string") {
    const bytes = Buffer.from(args.contentBase64, "base64");
    if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/g, "") !== args.contentBase64.replace(/=+$/g, "")) throw new Error("contentBase64 is invalid or empty");
    return bytes;
  }
  if (typeof args.text === "string" && args.text.length > 0) return Buffer.from(args.text, "utf8");
  throw new Error("provide non-empty text or contentBase64");
}

export function createLocalFileTools(): Tool[] {
  return [
    tool("local_bind", "Bind an exact user-selected local file. Copy mode never changes the source; edit mode records a SHA-256 baseline for guarded writes.", {
      path: { type: "string" },
      mode: { type: "string", enum: ["copy", "edit"] },
    }, ["path", "mode"], (args, ctx) => {
      const source = assertSelectedSource(ctx, str(args, "path"));
      const mode = str(args, "mode") === "edit" ? "edit" : "copy";
      const id = createHash("sha256").update(source.toLowerCase()).digest("hex").slice(0, 16);
      let project = readPackProject(ctx.workspace, "loam-localfile");
      if (!project) {
        project = { projectId: ctx.taskId ?? "local-files", packId: "loam-localfile", revision: 0, items: [], data: { bindings: [] } };
        writePackProject(ctx.workspace, project);
      }
      const existing = bindings(project).find((candidate) => candidate.id === id);
      if (existing) return { ok: true, content: JSON.stringify({ attached: true, binding: existing }) };
      const sha256 = digest(source);
      const binding: Binding = {
        id,
        sourcePath: source,
        mirrorPath: mirrorFor(id, source),
        mode,
        baselineSha256: sha256,
        currentSha256: sha256,
        selfWatchKey: randomUUID(),
        backups: [],
      };
      writeMirror(ctx, binding, fs.readFileSync(source));
      project.items.push({ id, state: mode === "copy" ? "final" : "authored", path: binding.mirrorPath });
      save(ctx, project, [...bindings(project), binding]);
      return { ok: true, content: JSON.stringify({ binding, projectId: project.projectId }) };
    }),

    tool("local_write_guarded", "Write an edit-in-place file only when its current SHA-256 matches the baseline. Creates a backup and uses atomic replacement.", {
      id: { type: "string" },
      expectedSha256: { type: "string" },
      text: { type: "string" },
      contentBase64: { type: "string" },
    }, ["id", "expectedSha256"], (args, ctx) => {
      const project = readPackProject(ctx.workspace, "loam-localfile");
      if (!project) throw new Error("local project is missing; call local_bind first");
      const binding = bindingFor(project, str(args, "id"));
      if (binding.mode !== "edit") throw new Error("copy-to-task bindings never modify the source file");
      const actual = digest(binding.sourcePath);
      const expected = str(args, "expectedSha256");
      if (expected !== binding.baselineSha256 || actual !== binding.baselineSha256) {
        return { ok: false, content: JSON.stringify({ error: "baseline_conflict", expected: binding.baselineSha256, actual }) };
      }
      const bytes = contentBytes(args);
      const backupPath = backup(ctx, binding);
      const selfWatchKey = randomUUID();
      binding.selfWatchKey = selfWatchKey;
      atomicWrite(binding.sourcePath, bytes);
      writeMirror(ctx, binding, bytes);
      binding.baselineSha256 = digest(binding.sourcePath);
      binding.currentSha256 = binding.baselineSha256;
      const item = project.items.find((candidate) => candidate.id === binding.id);
      if (item) {
        item.state = "final";
        item.path = binding.mirrorPath;
        delete item.errors;
      }
      save(ctx, project, bindings(project).map((candidate) => candidate.id === binding.id ? binding : candidate));
      return { ok: true, content: JSON.stringify({ id: binding.id, path: binding.mirrorPath, backup: backupPath, sha256: binding.baselineSha256, selfWatchKey }) };
    }),

    tool("local_backup", "List backups for a binding, or restore one explicitly while preserving the current version as a new backup.", {
      id: { type: "string" },
      action: { type: "string", enum: ["list", "restore"] },
      path: { type: "string" },
    }, ["id", "action"], (args, ctx) => {
      const project = readPackProject(ctx.workspace, "loam-localfile");
      if (!project) throw new Error("local project is missing");
      const binding = bindingFor(project, str(args, "id"));
      if (str(args, "action") === "list") return { ok: true, content: JSON.stringify({ backups: binding.backups }) };
      const selected = str(args, "path");
      if (!binding.backups.includes(selected)) throw new Error("backup is not registered for this binding");
      const bytes = fs.readFileSync(taskPath(ctx.workspace, selected));
      const currentBackup = backup(ctx, binding);
      if (binding.mode === "edit") atomicWrite(binding.sourcePath, bytes);
      writeMirror(ctx, binding, bytes);
      binding.baselineSha256 = createHash("sha256").update(bytes).digest("hex");
      binding.currentSha256 = binding.baselineSha256;
      binding.selfWatchKey = randomUUID();
      save(ctx, project, bindings(project).map((candidate) => candidate.id === binding.id ? binding : candidate));
      return { ok: true, content: JSON.stringify({ restored: selected, preservedCurrent: currentBackup, sha256: binding.baselineSha256 }) };
    }),

    tool("local_watch", "Host-only inspection of external edits. Own writes are distinguished by selfWatchKey and never reported as user edits.", {
      id: { type: "string" },
    }, ["id"], (args, ctx) => {
      const project = readPackProject(ctx.workspace, "loam-localfile");
      if (!project) throw new Error("local project is missing");
      const binding = bindingFor(project, str(args, "id"));
      const actual = digest(binding.sourcePath);
      if (actual === binding.currentSha256) return { ok: true, content: JSON.stringify({ changed: false, selfWatchKey: binding.selfWatchKey }) };
      binding.currentSha256 = actual;
      save(ctx, project, bindings(project).map((candidate) => candidate.id === binding.id ? binding : candidate));
      ctx.emit({ type: "task-status", status: `user_edit:${binding.id}` });
      return { ok: true, content: JSON.stringify({ changed: true, event: "user_edit", id: binding.id, actualSha256: actual, baselineSha256: binding.baselineSha256 }) };
    }),
  ];
}
