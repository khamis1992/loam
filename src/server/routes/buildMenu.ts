import type http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { rootAsset } from '../../config.js';
import { createAppProject, getAppProject } from '../../appbuilder/projects.js';
import { ensureAppBuilderSchema } from '../../appbuilder/store.js';
import { createDesktopProject } from '../../packs/desktop/project.js';
import type { BuildManifest, BuildOperation, BuildSelection } from '../../../packages/shared/src/buildMenu.js';
import { engineFor, profileFor } from '../../buildMenu/catalog.js';
import { redactEvidence } from '../../buildMenu/evidence.js';
import { runBuildJob, stopBuildJob, type BuildRunResult } from '../../buildMenu/serverPorts.js';
import { readManifest, saveManifest, selectionSchema } from '../../buildMenu/manifest.js';
import { BuildMenuError, issueGrant } from '../../buildMenu/grants.js';
import { readCellSource } from '../../buildMenu/notebooks/kernel.js';
import { appendJobLog, cancelJob, readJob, readJobLog, recordCancellation, startJob } from '../../buildMenu/jobs.js';
import { artifactHeaders, isArtifactId, resolveArtifact } from '../../buildMenu/artifacts.js';
import { activateOpenedRoutine, disableOpenedRoutine, pauseOpenedRoutine, resumeOpenedRoutine } from '../../buildMenu/automations/open.js';
import { jobBudget } from '../../buildMenu/deadlines.js';
import { recordApprovedExtension } from '../../buildMenu/chrome/permissions.js';
import { writeGameBrief } from '../../buildMenu/games/scene.js';
import { chromeManualLoad } from '../../buildMenu/chrome/manualLoad.js';
import { portableStatus } from '../../buildMenu/desktop/portableStatus.js';
import { notebookImagePin } from '../../buildMenu/notebooks/view.js';
import { safariLabel } from '../../buildMenu/safari/label.js';
import { writeStoredBrief } from '../../buildMenu/planProvenance.js';

const operationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['generate', 'preview']) }).strict(),
  z.object({ action: z.literal('package'), format: z.enum(['source-zip', 'web-zip', 'portable-exe', 'ipynb', 'apk-debug', 'mv3-zip', 'xcode-source']) }).strict(),
  z.object({ action: z.literal('kernel-execute'), cellId: z.string().min(1).max(80) }).strict(),
]);

const projectBody = z.object({
  title: z.string().trim().min(1).max(80),
  brief: z.string().trim().min(10).max(4000),
  selection: selectionSchema,
}).strict();

const grantBody = z.object({
  expectedRevision: z.number().int().positive(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  operation: operationSchema,
}).strict();

const jobBody = grantBody.extend({
  grantId: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(80),
}).strict();

let menuEnabled = false;

export function configureBuildMenu(enabled: boolean): void {
  menuEnabled = enabled;
}

export function buildMenuEnabled(): boolean {
  return menuEnabled;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(text);
}

const MAX_JSON_BYTES = 64 * 1024;

async function readJson(req: http.IncomingMessage, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      req.destroy();
      throw new BuildMenuError('invalid_request', 400);
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function sessionFromRequest(req: http.IncomingMessage): string | null {
  const token = req.headers['x-loam-local-token'];
  if (typeof token !== 'string' || token.length < 8) return null;
  return createHash('sha256').update(token).digest('hex');
}

function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (Array.isArray(origin)) return false;
  if (!origin) return true;
  if (origin === 'app://agent') return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' || parsed.origin !== origin) return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function fail(res: http.ServerResponse, error: unknown): void {
  const status = error instanceof BuildMenuError ? error.status : 400;
  const message = redactEvidence(error instanceof Error ? error.message : String(error));
  sendJson(res, status, { error: message, message });
}

async function waitReady(projectId: string, jobId: string, budgetMs: number) {
  const started = Date.now();
  for (;;) {
    const current = readJob(projectId, jobId);
    if (current.phase !== 'queued' && current.phase !== 'starting') return current;
    if (Date.now() - started >= budgetMs) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function regularFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function fileInside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function digestBytes(bytes: Buffer): { revision: string; lockSha256: string } {
  const revision = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  return { revision, lockSha256: createHash('sha256').update(bytes).digest('hex') };
}

function digestFile(file: string): { revision: string; lockSha256: string } {
  return digestBytes(fs.readFileSync(file));
}

function templatePin(workspace: string, kind: BuildSelection['kind']): { revision: string; lockSha256: string } {
  const candidates = [
    path.join(workspace, 'app', 'package-lock.json'),
    path.join(workspace, 'app', 'package.json'),
  ];
  for (const file of candidates) {
    if (fileInside(workspace, file) && regularFile(file)) return digestFile(file);
  }
  const template = kind === 'desktop' || kind === 'widget'
    ? rootAsset('src', 'templates', 'electron-app', 'package.json')
    : kind === 'website'
      ? rootAsset('templates', 'web-app', 'package.json')
      : null;
  if (template && regularFile(template)) return digestFile(template);
  return digestBytes(Buffer.alloc(0));
}

function approveExtensionGrant(workspace: string): void {
  try {
    recordApprovedExtension(workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid_request';
    if (message === 'host_requires_review' || message === 'permission_requires_review') throw new BuildMenuError(message, 403);
    if (message === 'unsafe_path') throw new BuildMenuError(message, 400);
    throw new BuildMenuError('invalid_request', 400);
  }
}

export async function handleBuildMenuRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
): Promise<boolean> {
  if (p === '/api/build-menu/capabilities' && req.method === 'GET') {
    const safari = safariLabel();
    sendJson(res, 200, {
      enabled: buildMenuEnabled(),
      safariExport: 'source-complete',
      safariTested: safari.safariTested,
      safari,
      portableExe: portableStatus(),
      chrome: chromeManualLoad(),
      notebookImage: notebookImagePin(),
    });
    return true;
  }
  if (!p.startsWith('/api/build-menu/')) return false;
  if (!originAllowed(req)) {
    sendJson(res, 403, { error: 'approval_required', message: 'origin' });
    return true;
  }
  const sessionId = sessionFromRequest(req);
  if (!sessionId) {
    sendJson(res, 403, { error: 'unauthenticated', message: 'session' });
    return true;
  }
  if (!buildMenuEnabled()) {
    sendJson(res, 404, { error: 'missing_requirement', message: 'build menu disabled' });
    return true;
  }
  if (p.includes('/publish')) {
    sendJson(res, 404, { error: 'missing_requirement', message: 'publish is local handoff only' });
    return true;
  }
  if (p.endsWith('/plan')) {
    sendJson(res, 400, { error: 'missing_requirement', message: 'generation needs a model provider' });
    return true;
  }
  try {
    if (p === '/api/build-menu/projects' && req.method === 'POST') {
      const parsed = projectBody.safeParse(await readJson(req));
      if (!parsed.success) throw new BuildMenuError('invalid_request', 400);
      const selection = parsed.data.selection as BuildSelection;
      ensureAppBuilderSchema();
      const baseWorkspace = process.env.LOAM_WORKSPACE ?? process.cwd();
      const project = selection.kind === 'desktop' || selection.kind === 'widget'
        ? createDesktopProject({ title: parsed.data.title, baseWorkspace, template: 'file-organizer' })
        : createAppProject({
          title: parsed.data.title,
          description: parsed.data.brief.slice(0, 400),
          kind: 'web-app',
          baseWorkspace,
        });
      const stored: BuildManifest = {
        schemaVersion: 1,
        projectId: project.id,
        revision: 1,
        selection,
        title: parsed.data.title,
        sourceDir: 'app',
        template: {
          id: engineFor(selection.kind),
          ...templatePin(project.workspaceDir, selection.kind),
        },
        consent: { autostart: false, publish: false },
      };
      if (selection.kind === 'game' || selection.kind === 'automation' || selection.kind === 'chrome-extension' || selection.kind === 'safari-extension') {
        writeGameBrief(project.workspaceDir, parsed.data.brief);
      }
      await saveManifest(project.workspaceDir, stored, 0);
      writeStoredBrief(project.workspaceDir, parsed.data.brief);
      sendJson(res, 200, { projectId: project.id, revision: 1, engine: engineFor(selection.kind) });
      return true;
    }
    const grantMatch = /^\/api\/build-menu\/projects\/(app_[a-z2-7]{12})\/grants$/.exec(p);
    if (grantMatch && req.method === 'POST') {
      const parsed = grantBody.safeParse(await readJson(req));
      if (!parsed.success) throw new BuildMenuError('invalid_request', 400);
      const project = getAppProject(grantMatch[1]!);
      if (!project) throw new BuildMenuError('invalid_request', 404);
      const manifest = readManifest(project.workspaceDir);
      if (!manifest || manifest.revision !== parsed.data.expectedRevision) throw new BuildMenuError('stale_revision', 409);
      if (parsed.data.operation.action === 'package' && (manifest.selection.kind === 'chrome-extension' || manifest.selection.kind === 'safari-extension')) {
        approveExtensionGrant(project.workspaceDir);
      }
      if (parsed.data.operation.action === 'kernel-execute' && manifest.selection.kind !== 'notebook') {
        throw new BuildMenuError('unsupported_operation', 400);
      }
      const sourceHash = parsed.data.operation.action === 'kernel-execute'
        ? createHash('sha256').update(readCellSource(project.workspaceDir, parsed.data.operation.cellId)).digest('hex')
        : undefined;
      const grantId = issueGrant({
        projectId: project.id,
        revision: manifest.revision,
        planSha256: parsed.data.planSha256,
        operation: parsed.data.operation as BuildOperation,
        sessionId,
        sourceHash,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      sendJson(res, 200, { grantId });
      return true;
    }
    const artifactMatch = /^\/api\/build-menu\/projects\/(app_[a-z2-7]{12})\/artifacts\/(.+)$/.exec(p);
    if (artifactMatch && req.method === 'GET') {
      const artifactId = artifactMatch[2] ?? '';
      if (!isArtifactId(artifactId) || (req.url ?? '').includes('?')) throw new BuildMenuError('invalid_request', 400);
      const project = getAppProject(artifactMatch[1]!);
      if (!project) throw new BuildMenuError('not_found', 404);
      const loaded = resolveArtifact(project.workspaceDir, project.id, artifactId);
      res.writeHead(200, artifactHeaders(loaded.artifact.artifactId, loaded.bytes.length, path.basename(loaded.artifact.relativePath)));
      res.end(loaded.bytes);
      return true;
    }
    const jobMatch = /^\/api\/build-menu\/projects\/(app_[a-z2-7]{12})\/jobs$/.exec(p);
    if (jobMatch && req.method === 'POST') {
      const parsed = jobBody.safeParse(await readJson(req));
      if (!parsed.success) throw new BuildMenuError('invalid_request', 400);
      const project = getAppProject(jobMatch[1]!);
      if (!project) throw new BuildMenuError('invalid_request', 404);
      const manifest = readManifest(project.workspaceDir);
      if (!manifest) throw new BuildMenuError('invalid_request', 404);
      const outcome: BuildRunResult = { summary: '' };
      const started = startJob({
        projectId: project.id,
        expectedRevision: parsed.data.expectedRevision,
        operation: parsed.data.operation as BuildOperation,
        planSha256: parsed.data.planSha256,
        grantId: parsed.data.grantId,
        idempotencyKey: parsed.data.idempotencyKey,
      }, sessionId, manifest, project.workspaceDir, {
        async scaffold(ctx) {
          Object.assign(outcome, await runBuildJob(ctx));
          appendJobLog(ctx.jobId, outcome.summary);
        },
        async run(ctx) {
          Object.assign(outcome, await runBuildJob(ctx));
          appendJobLog(ctx.jobId, outcome.summary);
        },
      });
      const finished = await waitReady(project.id, started.jobId, jobBudget(manifest.selection.kind, parsed.data.operation.action) + 1_000);
      sendJson(res, finished.phase === 'failed' ? 400 : 200, {
        ...finished,
        engine: engineFor(manifest.selection.kind),
        summary: redactEvidence(outcome.summary || finished.phase),
        previewHtml: outcome.previewHtml,
        previewUrl: outcome.previewUrl,
        artifactId: outcome.artifactId,
      });
      return true;
    }
    const jobRead = /^\/api\/build-menu\/projects\/(app_[a-z2-7]{12})\/jobs\/(job_[0-9a-f-]{36})$/.exec(p);
    if (jobRead && req.method === 'GET') {
      const project = getAppProject(jobRead[1]!);
      if (!project) throw new BuildMenuError('not_found', 404);
      const current = readJob(project.id, jobRead[2]!);
      sendJson(res, 200, { ...current, log: readJobLog(project.id, jobRead[2]!) });
      return true;
    }
    const cancelMatch = /^\/api\/build-menu\/projects\/(app_[a-z2-7]{12})\/jobs\/(job_[0-9a-f-]{36})\/cancel$/.exec(p);
    if (cancelMatch && req.method === 'POST') {
      const project = getAppProject(cancelMatch[1]!);
      if (!project) throw new BuildMenuError('not_found', 404);
      const manifest = readManifest(project.workspaceDir);
      if (!manifest || manifest.projectId !== project.id) throw new BuildMenuError('not_found', 404);
      const snapshot = cancelJob(project.id, cancelMatch[2]!);
      recordCancellation(project.id, cancelMatch[2]!);
      await stopBuildJob({
        manifest,
        workspace: project.workspaceDir,
        jobId: cancelMatch[2]!,
        operation: { action: 'preview' },
        signal: AbortSignal.abort(),
      });
      sendJson(res, 200, snapshot);
      return true;
    }
    const projectRead = /^\/api\/build-menu\/projects\/(app_[a-z2-7]{12})$/.exec(p);
    if (projectRead && req.method === 'GET') {
      const project = getAppProject(projectRead[1]!);
      if (!project) throw new BuildMenuError('not_found', 404);
      const manifest = readManifest(project.workspaceDir);
      if (!manifest || manifest.projectId !== project.id) throw new BuildMenuError('not_found', 404);
      const profile = profileFor(manifest.selection.kind);
      const body = {
        projectId: manifest.projectId,
        revision: manifest.revision,
        selection: manifest.selection,
        title: redactEvidence(manifest.title),
        engine: engineFor(manifest.selection.kind),
        capabilities: {
          preview: profile.preview,
          exports: profile.exports,
          network: profile.network,
          externalEffects: profile.externalEffects,
          safariTested: false,
        },
      };
      if (JSON.stringify(body).includes(project.workspaceDir)) throw new BuildMenuError('unsafe_path', 400);
      sendJson(res, 200, body);
      return true;
    }
    const routineMatch = /^\/api\/build-menu\/projects\/(app_[a-z2-7]{12})\/routines\/(activate|disable|pause|resume)$/.exec(p);
    if (routineMatch && req.method === 'POST') {
      const project = getAppProject(routineMatch[1]!);
      if (!project) throw new BuildMenuError('not_found', 404);
      const manifest = readManifest(project.workspaceDir);
      if (!manifest || manifest.projectId !== project.id || manifest.selection.kind !== 'automation') {
        throw new BuildMenuError('invalid_request', 400);
      }
      const action = routineMatch[2] as 'activate' | 'disable' | 'pause' | 'resume';
      switch (action) {
        case 'activate':
          activateOpenedRoutine(project.workspaceDir);
          break;
        case 'disable':
          disableOpenedRoutine(project.workspaceDir);
          break;
        case 'pause':
          pauseOpenedRoutine(project.workspaceDir);
          break;
        case 'resume':
          resumeOpenedRoutine(project.workspaceDir);
          break;
        default: {
          const unexpected: never = action;
          throw new BuildMenuError(unexpected, 400);
        }
      }
      sendJson(res, 200, { enabled: action !== 'disable', paused: action === 'pause' });
      return true;
    }
    sendJson(res, 404, { error: 'invalid_request', message: 'not found' });
  } catch (error) {
    fail(res, error);
  }
  return true;
}
