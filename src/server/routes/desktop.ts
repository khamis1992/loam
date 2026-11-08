import http from 'node:http';
import fs from 'node:fs';
import { loadConfig } from '../../config.js';
import { taskPath } from '../taskWorkspace.js';
import { getTask } from '../db.js';
import { createDesktopPackTools, type DesktopPackOptions } from '../../packs/desktop/tools.js';
import { attachDesktopProject, readDesktopVerification } from '../../packs/desktop/project.js';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid desktop request body');
  return parsed as Record<string, unknown>;
}

export async function handleDesktopRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, options: DesktopPackOptions = {}): Promise<boolean> {
  if (!p.startsWith('/api/desktop')) return false;
  const url = new URL(req.url ?? p, 'http://127.0.0.1');
  const taskId = url.searchParams.get('taskId')?.trim();
  const projectId = url.searchParams.get('projectId')?.trim() || taskId;
  if (!projectId) {
    sendJson(res, 400, { error: 'projectId_required' });
    return true;
  }
  try {
    if (req.method === 'GET' && p === '/api/desktop/metadata') {
      const relative = url.searchParams.get('path') ?? '';
      if (!relative.startsWith('uploads/') || !relative.endsWith('.desktop.json')) {
        sendJson(res, 400, { error: 'desktop_metadata_path_invalid' });
        return true;
      }
      const referenceProject = taskId ? undefined : attachDesktopProject(projectId);
      const workspace = referenceProject?.workspaceDir ?? (taskId ? getTask(taskId)?.workspace : undefined);
      if (!workspace) throw new Error('desktop_task_workspace_missing');
      const metadata = JSON.parse(fs.readFileSync(taskPath(workspace, relative), 'utf8')) as { projectId?: string };
      if (referenceProject && metadata.projectId !== referenceProject.id) {
        sendJson(res, 409, { error: 'desktop_metadata_project_mismatch' });
        return true;
      }
      const project = attachDesktopProject(String(metadata.projectId ?? ''));
      let verified = false;
      try {
        readDesktopVerification(project);
        verified = true;
      } catch {
        // The project still needs verification.
      }
      sendJson(res, 200, { project, verified });
      return true;
    }
    const project = attachDesktopProject(projectId);
    if (req.method === 'GET' && p === '/api/desktop') {
      let verified = false;
      try {
        readDesktopVerification(project);
        verified = true;
      } catch {
        // A new project has not passed the required checks yet.
      }
      sendJson(res, 200, { project, verified });
      return true;
    }
    if (req.method !== 'POST' || !['/api/desktop/verify', '/api/desktop/launch', '/api/desktop/stop'].includes(p)) {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const input = await body(req);
    const name = p.slice('/api/desktop/'.length);
    const tool = createDesktopPackTools(options).find((candidate) => candidate.name === `desktop_${name}`);
    if (!tool) {
      sendJson(res, 404, { error: 'desktop_action_not_found' });
      return true;
    }
    const result = await tool.run({ ...input, projectId }, {
      cfg: loadConfig(),
      workspace: project.workspaceDir,
      taskId: project.taskId,
      packId: 'loam-desktop',
      emit: () => undefined,
    });
    const content = result.ok ? JSON.parse(result.content) as unknown : { error: result.content };
    sendJson(res, result.ok ? 200 : 400, content);
    return true;
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
