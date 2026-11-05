import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { taskPath } from "../server/taskWorkspace.js";
import type { Emit } from "../agent/events.js";
import type { PackId, PackProject, PresentResult } from "./types.js";

export interface PackArtifact {
  path: string;
  kind: "report" | "page" | "deck" | "sheet" | "image" | "video" | "file";
  title: string;
  mime: string;
}

export interface PreparedPackPresentation {
  ok: true;
  uri: string;
  artifacts: PackArtifact[];
}

export function packProjectPath(workspace: string, packId: PackId): string {
  return taskPath(workspace, path.join(".loam", "packs", packId, "project.json"));
}

export function readPackProject(workspace: string, packId: PackId): PackProject | null {
  const file = packProjectPath(workspace, packId);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PackProject;
  if (parsed.packId !== packId || !parsed.projectId || !Array.isArray(parsed.items) || !Number.isInteger(parsed.revision)) {
    throw new Error("invalid pack project manifest");
  }
  for (const item of parsed.items) {
    if (!item.id || !["pending", "authored", "invalid", "final"].includes(item.state)) throw new Error("invalid pack item state");
  }
  return parsed;
}

export function writePackProject(workspace: string, project: PackProject): void {
  const file = packProjectPath(workspace, project.packId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(project, null, 2));
  fs.renameSync(temporary, file);
}

export function packResourceUri(packId: PackId, kind: string, projectId: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(kind) || !projectId) throw new Error("invalid pack resource identity");
  return `loam-resource://${packId}/${kind}/${encodeURIComponent(projectId)}`;
}

export function validatePackPresentation(options: {
  workspace: string;
  packId: PackId;
  kind: string;
  artifacts: PackArtifact[];
}): PreparedPackPresentation | Exclude<PresentResult, { ok: true }> {
  const project = readPackProject(options.workspace, options.packId);
  if (!project) return { ok: false, missing: ["project"], errors: ["pack project manifest is missing"], retry: false };
  if (project.items.length === 0) return { ok: false, missing: ["items"], errors: ["pack project has no items to present"], retry: true };
  const pending = project.items.filter((item) => item.state !== "final");
  if (pending.length > 0) {
    return {
      ok: false,
      missing: pending.map((item) => item.id),
      errors: pending.map((item) => `${item.id}: ${item.errors?.join("; ") || item.state}`),
      retry: true,
    };
  }
  if (options.artifacts.length === 0) return { ok: false, missing: ["artifacts"], errors: ["pack project has no output artifacts"], retry: true };
  const missing = options.artifacts.filter((artifact) => {
    try {
      return !fs.statSync(taskPath(options.workspace, artifact.path)).isFile();
    } catch {
      return true;
    }
  });
  if (missing.length > 0) return { ok: false, missing: missing.map((artifact) => artifact.path), errors: ["one or more output files are missing"], retry: false };
  const empty = options.artifacts.find((artifact) => fs.statSync(taskPath(options.workspace, artifact.path)).size === 0);
  if (empty) return { ok: false, missing: [empty.path], errors: ["an output file is empty"], retry: false };
  return { ok: true, uri: packResourceUri(options.packId, options.kind, project.projectId), artifacts: options.artifacts };
}

export function publishPackPresentation(prepared: PreparedPackPresentation, workspace: string, emit?: Emit): PresentResult {
  for (const artifact of prepared.artifacts) {
    const file = taskPath(workspace, artifact.path);
    const size = fs.statSync(file).size;
    const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    emit?.({ type: "artifact_published", path: artifact.path, kind: artifact.kind, title: artifact.title, mime: artifact.mime, sizeBytes: size, sha256 });
  }
  return { ok: true, uri: prepared.uri, artifacts: prepared.artifacts.map((artifact) => artifact.path) };
}

export function presentPackProject(options: {
  workspace: string;
  packId: PackId;
  kind: string;
  artifacts: PackArtifact[];
  emit?: Emit;
}): PresentResult {
  const prepared = validatePackPresentation(options);
  if (!prepared.ok) return prepared;
  return publishPackPresentation(prepared, options.workspace, options.emit);
}
