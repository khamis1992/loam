/**
 * Client API for the composer project-context chips (UNIMPLEMENTED_OPTIONS #17).
 *
 * Thin wrappers over the existing Loam endpoints so the composer context row can
 * offer a project picker bound to GET /api/projects, read the real git branch of
 * the selected project from GET /api/projects/:id/git (instead of the "main"
 * fallback), and create a git worktree under the project folder.
 *
 * Every call degrades gracefully: when the backend is unreachable or a project
 * has no folder, the caller keeps its previous UI state instead of throwing.
 */
import { getApiBase, getApiHeaders } from './rpc';

export interface ProjectOption {
  id: string;
  name: string;
  folder?: string | null;
}

export interface ProjectBranchInfo {
  isGit: boolean;
  branch: string | null;
  reason?: string;
}

export type ProjectWorktreeResult =
  | { ok: true; path: string; branch: string }
  | { ok: false; error: string };

interface RawProject {
  id?: unknown;
  name?: unknown;
  folder?: unknown;
}

/** GET /api/projects — the list backing the composer project picker. */
export async function fetchProjects(): Promise<ProjectOption[]> {
  const res = await fetch(`${getApiBase()}/api/projects`, { headers: await getApiHeaders() });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { projects?: RawProject[] };
  return (data.projects ?? [])
    .filter((p) => typeof p.id === 'string' && typeof p.name === 'string')
    .map((p) => ({
      id: p.id as string,
      name: p.name as string,
      folder: typeof p.folder === 'string' && p.folder ? p.folder : null,
    }));
}

/**
 * GET /api/projects/:id/git — the real branch of the project's folder.
 * Returns null when the project has no folder, is not a git repo, or the
 * backend route is unavailable (the caller then keeps the desktop fallback).
 */
export async function fetchProjectBranch(projectId: string): Promise<ProjectBranchInfo | null> {
  const res = await fetch(
    `${getApiBase()}/api/projects/${encodeURIComponent(projectId)}/git`,
    { headers: await getApiHeaders() },
  );
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as Partial<ProjectBranchInfo>;
  return { isGit: Boolean(data.isGit), branch: data.branch ?? null, reason: data.reason };
}

/** POST /api/projects/:id/worktrees — `git worktree add` under the project folder. */
export async function createProjectWorktree(projectId: string, name?: string): Promise<ProjectWorktreeResult> {
  const res = await fetch(
    `${getApiBase()}/api/projects/${encodeURIComponent(projectId)}/worktrees`,
    {
      method: 'POST',
      headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
      body: JSON.stringify(name ? { name } : {}),
    },
  );
  const data = (await res.json().catch(() => ({}))) as {
    path?: unknown;
    branch?: unknown;
    error?: unknown;
  };
  if (!res.ok) {
    return { ok: false, error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}` };
  }
  if (typeof data.path !== 'string' || typeof data.branch !== 'string') {
    return { ok: false, error: 'malformed worktree response' };
  }
  return { ok: true, path: data.path, branch: data.branch };
}

/** PUT /api/projects/:id/folder — bind or clear the project's working folder. */
export async function setProjectFolder(
  projectId: string,
  path: string,
): Promise<{ project?: unknown; error?: string }> {
  const res = await fetch(
    `${getApiBase()}/api/projects/${encodeURIComponent(projectId)}/folder`,
    {
      method: 'PUT',
      headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as { project?: unknown; error?: unknown };
  if (!res.ok) {
    return { error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}` };
  }
  return { project: data.project };
}
