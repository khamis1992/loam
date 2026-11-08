import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from '../../tools/registry.js';
import { str } from '../../tools/registry.js';
import { readPackProject, writePackProject, presentPackProject } from '../present.js';
import { VerifyLoop, formatVerifyReportForModel } from '../../appbuilder/verifyLoop.js';
import type { AppProject } from '../../appbuilder/types.js';
import { ROOT as APP_ROOT } from '../../config.js';
import { versionService, zeroUsage } from '../../appbuilder/versions.js';
import { updateAppProject } from '../../appbuilder/projects.js';
import { attachDesktopProject, createDesktopProject, desktopMetadataPath, readDesktopVerification, writeDesktopVerification } from './project.js';
import { launchDesktopRuntime, stopDesktopRuntime } from './runtime.js';
import { desktopTemplateForPrompt, desktopTemplateTitle, isDesktopTemplateId } from './catalog.js';
import { clearDesktopPackage, packageDesktopProject, readDesktopPackage, revealDesktopProject, type DesktopPackage } from './packager.js';

interface VerifyResult { ok: boolean; output: string }

async function snapshotDesktopProject(project: AppProject): Promise<unknown> {
  const version = await versionService.snapshot(project, {
    title: `${project.title} verified`,
    summary: 'Electron build, TypeScript checks and the scenario acceptance test passed.',
    source: 'build',
    usage: zeroUsage(),
  });
  if (version) updateAppProject(project.id, { activeVersion: version.number, status: 'idle' });
  return version;
}

export interface DesktopPackOptions {
  verify?: (project: AppProject) => Promise<VerifyResult>;
  snapshot?: (project: AppProject) => Promise<unknown>;
  package?: (project: AppProject, destinationWorkspace: string) => Promise<DesktopPackage>;
  reveal?: typeof revealDesktopProject;
  launch?: typeof launchDesktopRuntime;
  stop?: typeof stopDesktopRuntime;
}

function json(value: unknown): ToolResult {
  return { ok: true, content: JSON.stringify(value) };
}

function runSmoke(project: AppProject): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, ['run', 'smoke'], {
      cwd: path.join(project.workspaceDir, project.appDir),
      env: { ...process.env, LOAM_ROOT: APP_ROOT, LOAM_ACCEPTANCE_DEBUG_PORT: '19222' },
      windowsHide: true, shell: process.platform === 'win32',
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const timer = setTimeout(() => {
      output += '\nDesktop smoke test timed out.';
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
    }, 120_000);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: error.message });
    });
  });
}

async function verify(project: AppProject): Promise<VerifyResult> {
  const loop = new VerifyLoop({
    ensureDevServer: async () => '',
    reviewVisual: async () => ({ pass: true, problems: [], parsed: true }),
    runContract: async () => ({ pass: true, reason: '' }),
  });
  const report = await loop.run({ project, runId: `desktop-${project.id}`, tier: 'fast' });
  if (!report.pass) return { ok: false, output: formatVerifyReportForModel(report) };
  const typecheck = await new Promise<VerifyResult>((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'typecheck', '--silent'], { cwd: path.join(project.workspaceDir, project.appDir), windowsHide: true, shell: process.platform === 'win32' });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('close', (code) => resolve({ ok: code === 0, output }));
    child.once('error', (error) => resolve({ ok: false, output: error.message }));
  });
  if (!typecheck.ok) return typecheck;
  return runSmoke(project);
}

function tool(name: string, description: string, properties: Record<string, unknown>, handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>, required: string[] = []): Tool {
  return {
    name,
    description,
    parameters: { type: 'object', additionalProperties: false, properties, required },
    async run(args, ctx) {
      try {
        return await handler(args, ctx);
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export function createDesktopPackTools(options: DesktopPackOptions = {}): Tool[] {
  const verifyProject = options.verify ?? verify;
  const snapshotProject = options.snapshot ?? snapshotDesktopProject;
  const packageProject = options.package ?? packageDesktopProject;
  const revealProject = options.reveal ?? revealDesktopProject;
  const launch = options.launch ?? launchDesktopRuntime;
  const stop = options.stop ?? stopDesktopRuntime;
  const stage = (project: AppProject, ctx: ToolContext, verification: ReturnType<typeof writeDesktopVerification>): string => {
    const file = desktopMetadataPath(project, ctx.workspace);
    const packaged = readDesktopPackage(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ projectId: project.id, kind: project.kind, title: project.title, entry: verification.entry, template: project.features[0], nativePackage: Boolean(packaged), package: packaged, verifiedAt: verification.verifiedAt }, null, 2));
    const relative = `uploads/${path.basename(file)}`;
    const previous = readPackProject(ctx.workspace, 'loam-desktop');
    const items = [{ id: 'desktop-1', state: 'final' as const, path: relative }];
    if (packaged) items.push({ id: 'installer-1', state: 'final' as const, path: `uploads/${packaged.fileName}` });
    writePackProject(ctx.workspace, {
      projectId: ctx.taskId ?? project.taskId,
      packId: 'loam-desktop',
      revision: (previous?.revision ?? 0) + 1,
      items,
      data: { title: project.title, kind: project.kind, nativePackage: Boolean(packaged) },
    });
    return relative;
  };
  return [
    tool('desktop_init', 'Create one Electron App Builder project from the five safe local desktop templates.', {
      title: { type: 'string' },
      template: { type: 'string', enum: ['file-organizer', 'habit-tracker', 'markdown-editor', 'password-manager', 'photo-sorter'] },
      prompt: { type: 'string' },
    }, async (args, ctx) => {
      const requested = str(args, 'template') || desktopTemplateForPrompt(str(args, 'prompt')) || 'file-organizer';
      if (!isDesktopTemplateId(requested)) throw new Error('desktop_template_invalid');
      const title = str(args, 'title', desktopTemplateTitle(requested));
      return json({ project: createDesktopProject({ title, baseWorkspace: ctx.workspace, template: requested }) });
    }, ['title']),

    tool('desktop_attach', 'Attach an existing Electron App Builder project without duplicating or replacing it.', {
      projectId: { type: 'string' },
    }, async (args) => json({ project: attachDesktopProject(str(args, 'projectId')) }), ['projectId']),

    tool('desktop_verify', 'Run the App Builder checks, Vite build, TypeScript check and an actual Electron search-and-tag smoke test.', {}, async (args, ctx) => {
      const project = attachDesktopProject(str(args, 'projectId'));
      const result = await verifyProject(project);
      if (!result.ok) return { ok: false, content: result.output };
      await snapshotProject(project);
      clearDesktopPackage(project);
      const verification = writeDesktopVerification(project);
      const artifact = stage(project, ctx, verification);
      return json({ verified: true, verification, artifact, output: result.output });
    }, ['projectId']),

    tool('desktop_package', 'Build an unsigned Windows NSIS installer from the verified Electron project, only after an explicit user request.', {}, async (args, ctx) => {
      const project = attachDesktopProject(str(args, 'projectId'));
      readDesktopVerification(project);
      const packaged = await packageProject(project, ctx.workspace);
      const artifact = stage(project, ctx, readDesktopVerification(project));
      return json({ nativePackage: true, package: packaged, artifact });
    }, ['projectId']),

    tool('desktop_reveal', 'Open Explorer and select the verified installer without running it.', {}, async (args) => {
      const project = attachDesktopProject(str(args, 'projectId'));
      await revealProject(project);
      return json({ revealed: true });
    }, ['projectId']),

    tool('desktop_present', 'Publish a verified Electron project as an app resource after its real build and smoke test.', {}, async (args, ctx) => {
      const project = attachDesktopProject(str(args, 'projectId'));
      const verification = readDesktopVerification(project);
      stage(project, ctx, verification);
      const manifest = readPackProject(ctx.workspace, 'loam-desktop');
      const artifacts = (manifest?.items ?? []).filter((item) => item.path).map((item) => ({ path: item.path!, kind: 'file' as const, title: item.id === 'installer-1' ? `${project.title} installer` : project.title, mime: item.id === 'installer-1' ? 'application/vnd.microsoft.portable-executable' : 'application/json' }));
      const presented = presentPackProject({ workspace: ctx.workspace, packId: 'loam-desktop', kind: 'app', artifacts, emit: ctx.emit });
      if (!presented.ok) return { ok: false, content: JSON.stringify(presented) };
      return json({ ...presented, nativePackage: Boolean(readDesktopPackage(project)) });
    }, ['projectId']),

    tool('desktop_launch', 'Launch a verified Electron app with an isolated profile and tracked PID, never an arbitrary command.', {}, async (args) => {
      const project = attachDesktopProject(str(args, 'projectId'));
      readDesktopVerification(project);
      return json({ runtime: await launch(project) });
    }, ['projectId']),

    tool('desktop_stop', 'Stop only the Electron process recorded for this desktop project.', {}, async (args) => {
      const project = attachDesktopProject(str(args, 'projectId'));
      await stop(project);
      return json({ stopped: true });
    }, ['projectId']),
  ];
}
