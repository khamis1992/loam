/**
 * Environment snapshot status (D3): a small read-only window onto the cached
 * environment builds, so the UI can show whether a project's snapshot is fresh
 * and what the last build did.
 *
 * - GET /api/env-builds                    every recorded build, newest first
 * - GET /api/env-builds/:projectId         one project's build + staleness
 * - GET /api/env-builds/:projectId/log     the redacted build log, as text
 *
 * Read-only on purpose: builds are triggered by the `env_build_status` agent
 * tool, which already owns the policy checks. Nothing here can start a build or
 * expose a secret value — the persisted log is redacted at write time.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  BLUEPRINT_FILE,
  blueprintHash,
  findBuildForFolder,
  envSnapshotDir,
  listBuildStatuses,
  readBlueprint,
  readBuildStatus,
  renderStatus,
  type EnvBuildRecord,
} from "../../tools/envSnapshot.js";
import { getProject } from "../db.js";

/**
 * Decode one path segment into a project id. Percent-encoded separators and
 * traversal segments are refused outright rather than sanitized, so a hostile
 * id can never even reach the snapshot directory lookup.
 */
function projectIdFromSegment(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error("invalid percent-encoding");
  }
  const trimmed = decoded.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed) || /[\u0000-\u001f]/.test(trimmed)) {
    throw new Error(`invalid project id: ${raw}`);
  }
  return trimmed;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Look up a build for the id a caller asked for. A UI bound to a project asks
 * with the db project id, but the build may have been recorded under the project
 * folder basename (the agent tool's default), so fall back to the folder the
 * project points at. Both spellings must reach the same snapshot.
 */
function buildForId(projectId: string): EnvBuildRecord | undefined {
  const direct = readBuildStatus(projectId);
  if (direct) return direct;
  const folder = getProject(projectId)?.folder;
  if (!folder) return undefined;
  return findBuildForFolder(folder);
}

/** The public shape of a build: no absolute host paths beyond the snapshot dir. */
function publicRecord(record: EnvBuildRecord): Record<string, unknown> {
  return {
    projectId: record.projectId,
    projectFolder: record.projectFolder,
    hash: record.hash,
    status: record.status,
    stepsRun: record.stepsRun,
    steps: record.steps,
    durationMs: record.durationMs,
    createdAt: record.createdAt,
    ...(record.error ? { error: record.error } : {}),
    snapshotDir: envSnapshotDir(record.projectId, record.hash),
  };
}

/**
 * Compare the recorded build against the blueprint on disk. `stale` means the
 * project's `loam.env.yaml` or one of its lockfiles changed, so the next task
 * boot will rebuild instead of reusing the snapshot.
 */
function staleness(record: EnvBuildRecord | undefined): Record<string, unknown> {
  if (!record) return { current: false, stale: false, reason: "no build recorded" };
  const folder = record.projectFolder;
  if (!folder || !fs.existsSync(path.join(folder, BLUEPRINT_FILE))) {
    return { current: false, stale: false, reason: `no ${BLUEPRINT_FILE} in the project folder` };
  }
  try {
    const hash = blueprintHash(folder, readBlueprint(folder));
    return hash === record.hash
      ? { current: true, stale: false, reason: "blueprint and lockfiles unchanged" }
      : { current: false, stale: true, hash, reason: "blueprint or lockfile changed, so the snapshot is stale" };
  } catch (err) {
    return { current: false, stale: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleEnvBuildRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/env-builds")) return false;
  if (req.method !== "GET") return false;

  if (p === "/api/env-builds") {
    const builds = listBuildStatuses()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => ({ ...publicRecord(record), ...staleness(record) }));
    sendJson(res, 200, { builds });
    return true;
  }

  const rest = p.slice("/api/env-builds/".length);
  // A bare segment is a project id; anything with a slash must be the /log path.
  if (!rest.includes("/")) {
    let projectId: string;
    try {
      projectId = projectIdFromSegment(rest);
    } catch {
      sendJson(res, 400, { error: "invalid project id" });
      return true;
    }
    const record = buildForId(projectId);
    if (!record) {
      sendJson(res, 404, { error: `no environment build for ${projectId}` });
      return true;
    }
    sendJson(res, 200, { build: publicRecord(record), ...staleness(record), text: renderStatus(record, envSnapshotDir(record.projectId, record.hash)) });
    return true;
  }

  if (rest.endsWith("/log")) {
    const raw = rest.slice(0, -"/log".length);
    let projectId: string;
    try {
      projectId = projectIdFromSegment(raw);
    } catch {
      sendJson(res, 400, { error: "invalid project id" });
      return true;
    }
    const record = buildForId(projectId);
    if (!record) {
      sendJson(res, 404, { error: `no environment build for ${projectId}` });
      return true;
    }
    // Persisted logs are redacted at write time; never re-read step output here.
    sendText(res, 200, record.log);
    return true;
  }

  return false;
}
