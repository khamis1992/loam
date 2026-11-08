import fs from "node:fs";
import path from "node:path";
import { database } from "../server/sqliteStore.js";
import { getAppProject } from "./projects.js";
import { zipDirectory, zipEntryNames } from "../preview/zip.js";

export type PublishStatus = "proposed" | "confirmed" | "dismissed" | "unpublished";

export interface PublishProposal {
  id: string;
  projectId: string;
  version: number;
  status: PublishStatus;
  artifactPath?: string;
  createdAt: string;
  updatedAt: string;
}

function ensureTable(): void {
  database().exec(`CREATE TABLE IF NOT EXISTS app_publish_proposals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    artifact_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
}

function fromRow(row: Record<string, unknown>): PublishProposal {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    version: Number(row.version),
    status: String(row.status) as PublishStatus,
    ...(row.artifact_path ? { artifactPath: String(row.artifact_path) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createPublishProposal(projectId: string, version?: number): PublishProposal {
  ensureTable();
  const project = getAppProject(projectId);
  if (!project) throw new Error("app project not found");
  const now = new Date().toISOString();
  const id = `pub_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const proposal: PublishProposal = {
    id,
    projectId,
    version: version ?? project.activeVersion ?? 1,
    status: "proposed",
    createdAt: now,
    updatedAt: now,
  };
  database().prepare("INSERT INTO app_publish_proposals (id, project_id, version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, projectId, proposal.version, proposal.status, now, now);
  return proposal;
}

export function getPublishProposal(id: string): PublishProposal | undefined {
  ensureTable();
  const row = database().prepare("SELECT * FROM app_publish_proposals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? fromRow(row) : undefined;
}

export function listPublishProposals(projectId: string): PublishProposal[] {
  ensureTable();
  return (database().prepare("SELECT * FROM app_publish_proposals WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Array<Record<string, unknown>>).map(fromRow);
}

function updateProposal(id: string, status: PublishStatus, artifactPath?: string): PublishProposal {
  const updatedAt = new Date().toISOString();
  database().prepare("UPDATE app_publish_proposals SET status = ?, artifact_path = ?, updated_at = ? WHERE id = ?")
    .run(status, artifactPath ?? null, updatedAt, id);
  return getPublishProposal(id)!;
}

export function confirmPublishProposal(id: string): PublishProposal {
  const proposal = getPublishProposal(id);
  if (!proposal || proposal.status !== "proposed") throw new Error("publish proposal is not pending");
  const project = getAppProject(proposal.projectId);
  if (!project) throw new Error("app project not found");
  const appRoot = path.join(project.workspaceDir, project.appDir);
  const bytes = zipDirectory(appRoot, {
    filter: (rel) => {
      const parts = rel.split("/");
      return !parts.some((part) => part === "node_modules" || part === ".git" || part === "data" || part === "credentials.json" || part.startsWith(".env"));
    },
  });
  const names = zipEntryNames(bytes);
  if (names.length === 0) throw new Error("app has no publishable files");
  const artifactDir = path.join(project.workspaceDir, ".loam", "publish");
  fs.mkdirSync(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, `${proposal.id}.zip`);
  fs.writeFileSync(artifactPath, bytes);
  if (fs.statSync(artifactPath).size !== bytes.length) throw new Error("publish artifact verification failed");
  return updateProposal(id, "confirmed", artifactPath);
}

export function dismissPublishProposal(id: string): PublishProposal {
  const proposal = getPublishProposal(id);
  if (!proposal || proposal.status !== "proposed") throw new Error("publish proposal is not pending");
  return updateProposal(id, "dismissed");
}

export function updatePublishedApp(id: string): PublishProposal {
  const current = getPublishProposal(id);
  if (!current || current.status !== "confirmed") throw new Error("published app not found");
  const next = createPublishProposal(current.projectId);
  return confirmPublishProposal(next.id);
}

export function unpublishApp(id: string): PublishProposal {
  const proposal = getPublishProposal(id);
  if (!proposal || proposal.status !== "confirmed") throw new Error("published app not found");
  if (proposal.artifactPath) fs.rmSync(proposal.artifactPath, { force: true });
  return updateProposal(id, "unpublished");
}

export function publishArtifact(id: string): string {
  const proposal = getPublishProposal(id);
  if (!proposal || proposal.status !== "confirmed" || !proposal.artifactPath) throw new Error("published artifact not found");
  const project = getAppProject(proposal.projectId);
  if (!project) throw new Error("app project not found");
  const allowed = path.resolve(project.workspaceDir, ".loam", "publish");
  const resolved = path.resolve(proposal.artifactPath);
  if (resolved !== allowed && !resolved.startsWith(allowed + path.sep)) throw new Error("publish artifact path is invalid");
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error("published artifact not found");
  return resolved;
}
