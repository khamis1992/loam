import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppProject } from '../../appbuilder/types.js';
import type { Tool, ToolContext } from '../../tools/registry.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-desktop-pack-'));
process.env.MANUS_LOCAL_DATA_DIR = tmp;

const { createAppProject } = await import('../../appbuilder/projects.js');
const { resolvePackId } = await import('../intent.js');
const { getPackManifest } = await import('../registry.js');
const { createDesktopPackTools } = await import('../desktop/tools.js');
const { desktopMetadataPath, readDesktopVerification } = await import('../desktop/project.js');

function ctxFor(project: AppProject): ToolContext {
  return { cfg: {} as ToolContext['cfg'], workspace: project.workspaceDir, taskId: project.taskId, packId: 'loam-desktop', emit: () => undefined };
}

function buildOutput(project: AppProject): void {
  const dist = path.join(project.workspaceDir, project.appDir, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Loam</title>');
}

test('desktop tools create, verify, present, launch and stop one App Builder Electron project', async () => {
  let verifyCalls = 0;
  let launchCalls = 0;
  let stopCalls = 0;
  const tools = createDesktopPackTools({
    verify: async () => ({ ok: true, output: 'electron smoke passed' }),
    snapshot: async () => ({ number: 1 }),
    launch: async (project) => {
      launchCalls += 1;
      return { pid: 4321, projectId: project.id, workspaceDir: project.workspaceDir, logPath: 'runtime.log', debugPort: 20001 };
    },
    stop: async () => { stopCalls += 1; },
  });
  const tool = (name: string): Tool => {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`missing ${name}`);
    return found;
  };

  const parentCtx: ToolContext = { cfg: {} as ToolContext['cfg'], workspace: tmp, taskId: 'parent', packId: 'loam-desktop', emit: () => undefined };
  const initialized = await tool('desktop_init').run({ title: 'Local file organizer' }, parentCtx);
  assert.equal(initialized.ok, true, initialized.content);
  const project = (JSON.parse(initialized.content) as { project: AppProject }).project;
  assert.equal(project.kind, 'electron-app');
  assert.equal(project.templateId, 'electron-app');
  assert.ok(fs.existsSync(path.join(project.workspaceDir, 'app', 'electron', 'main.cjs')));
  assert.ok(fs.existsSync(path.join(project.workspaceDir, 'app', 'fixtures', 'downloads', 'notes.txt')));
  assert.ok(fs.existsSync(path.join(project.workspaceDir, 'DESIGN.md')));

  const attached = await tool('desktop_attach').run({ projectId: project.id }, ctxFor(project));
  assert.equal(attached.ok, true, attached.content);
  assert.equal((JSON.parse(attached.content) as { project: AppProject }).project.id, project.id);

  const earlyPresent = await tool('desktop_present').run({ projectId: project.id }, parentCtx);
  assert.equal(earlyPresent.ok, false);
  assert.match(earlyPresent.content, /desktop_verification_required/);
  const earlyLaunch = await tool('desktop_launch').run({ projectId: project.id }, ctxFor(project));
  assert.equal(earlyLaunch.ok, false);
  assert.equal(launchCalls, 0);

  buildOutput(project);
  const verified = await tool('desktop_verify').run({ projectId: project.id }, parentCtx);
  verifyCalls += 1;
  assert.equal(verified.ok, true, verified.content);
  assert.equal(readDesktopVerification(project).nativePackage, false);

  const presented = await tool('desktop_present').run({ projectId: project.id }, parentCtx);
  assert.equal(presented.ok, true, presented.content);
  const presentation = JSON.parse(presented.content) as { uri: string; nativePackage: boolean };
  assert.equal(presentation.uri, 'loam-resource://loam-desktop/app/parent');
  assert.equal(presentation.nativePackage, false);
  const metadata = JSON.parse(fs.readFileSync(desktopMetadataPath(project, tmp), 'utf8')) as { projectId: string };
  assert.equal(metadata.projectId, project.id);

  const launched = await tool('desktop_launch').run({ projectId: project.id }, ctxFor(project));
  assert.equal(launched.ok, true, launched.content);
  assert.equal(launchCalls, 1);
  const stopped = await tool('desktop_stop').run({ projectId: project.id }, ctxFor(project));
  assert.equal(stopped.ok, true, stopped.content);
  assert.equal(stopCalls, 1);
  assert.equal(verifyCalls, 1);
});

test('desktop verification failures are returned and cannot publish output', async () => {
  const tools = createDesktopPackTools({ verify: async () => ({ ok: false, output: 'smoke failed' }) });
  const init = tools.find((candidate) => candidate.name === 'desktop_init')!;
  const created = await init.run({ title: 'Failing desktop app' }, { cfg: {} as ToolContext['cfg'], workspace: tmp, emit: () => undefined });
  const project = (JSON.parse(created.content) as { project: AppProject }).project;
  const verify = await tools.find((candidate) => candidate.name === 'desktop_verify')!.run({ projectId: project.id }, ctxFor(project));
  assert.equal(verify.ok, false);
  assert.equal(verify.content, 'smoke failed');
  const present = await tools.find((candidate) => candidate.name === 'desktop_present')!.run({ projectId: project.id }, ctxFor(project));
  assert.equal(present.ok, false);
});

test('desktop pack refuses web projects and never exposes webdev tools', async () => {
  const { loadTemplate } = await import('../../appbuilder/templates.js');
  assert.ok(loadTemplate('web-app').files.some((file) => file.path === 'package.json'));
  assert.ok(loadTemplate('electron-app').files.some((file) => file.path === 'package.json'));
  const web = createAppProject({ title: 'Web project', baseWorkspace: tmp });
  const tools = createDesktopPackTools();
  const attached = await tools.find((candidate) => candidate.name === 'desktop_attach')!.run({ projectId: web.id }, ctxFor(web));
  assert.equal(attached.ok, false);
  assert.match(attached.content, /desktop_project_kind_mismatch/);
  assert.equal(resolvePackId({ studioGoal: 'desktop-app' }), 'loam-desktop');
  assert.equal(resolvePackId({ outputType: 'desktop' }), 'loam-desktop');
  const manifest = getPackManifest('loam-desktop');
  for (const forbidden of ['webdev', 'web_scaffold', 'preview_serve', 'deploy_app']) {
    assert.equal(manifest.modelTools.includes(forbidden), false);
  }
});
