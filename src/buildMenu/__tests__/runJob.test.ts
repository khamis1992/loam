import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildJobContext, BuildManifest } from '../../../packages/shared/src/buildMenu.js';
import { DEFAULTS } from '../../config.js';
import { listSchedules } from '../../server/db.js';
import { resetDb } from '../../server/sqliteStore.js';
import { resolveArtifact } from '../artifacts.js';
import { BuildMenuError, issueGrant, resetGrants } from '../grants.js';
import { materialize } from '../materialize.js';
import { noteReady, readJob, readJobLog, resetJobs, startJob } from '../jobs.js';
import { ProcessLeaseRegistry } from '../processLease.js';
import { runBuildJob, stopBuildJob } from '../serverPorts.js';
import { createWebsitesPorts } from '../websites/ports.js';

function collectExe(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...collectExe(absolute));
    else if (item.name.toLowerCase().endsWith('.exe')) found.push(absolute);
  }
  return found;
}

function context(workspace: string, selection: BuildManifest['selection'], action: BuildJobContext['operation']): BuildJobContext {
  return {
    workspace,
    jobId: `job_${selection.kind}_${action.action}`,
    operation: action,
    signal: new AbortController().signal,
    manifest: {
      schemaVersion: 1,
      projectId: 'app_abcdefghijkl',
      revision: 1,
      selection,
      title: 'متجر تجريبي',
      sourceDir: 'app',
      template: { id: 'fixture', revision: '1', lockSha256: 'a'.repeat(64) },
      consent: { autostart: false, publish: false },
    },
  };
}

test('the build menu stays off unless the config flag is enabled', () => {
  assert.equal(DEFAULTS.buildMenu?.enabled, false);
});

test('a website job serves the page, writes a source zip, and releases the port', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-run-'));
  const generated = context(root, { kind: 'website', subtype: 'store' }, { action: 'generate' });
  const preview = context(root, { kind: 'website', subtype: 'store' }, { action: 'preview' });
  const packed = context(root, { kind: 'website', subtype: 'store' }, { action: 'package', format: 'source-zip' });
  try {
    const files = await runBuildJob(generated);
    assert.match(files.previewHtml ?? '', /متجر/);
    const recorded = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'evidence', generated.jobId, 'result.json'), 'utf8')) as { phase: string; action: string };
    assert.equal(recorded.phase, 'completed');
    assert.equal(recorded.action, 'generate');
    const live = await runBuildJob(preview);
    assert.match(live.previewUrl ?? '', /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.match(await (await fetch(live.previewUrl!)).text(), /متجر/);
    const artifact = await runBuildJob(packed);
    assert.ok(artifact.artifactId);
    const loaded = resolveArtifact(root, 'app_abcdefghijkl', artifact.artifactId!);
    const digest = createHash('sha256').update(loaded.bytes).digest('hex');
    assert.equal(digest, loaded.artifact.sha256);
    await stopBuildJob(preview);
    await assert.rejects(fetch(live.previewUrl!, { signal: AbortSignal.timeout(1_000) }));
  } finally {
    await stopBuildJob(preview).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an aborted build records cancelled evidence and does not scaffold', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-run-cancel-'));
  const controller = new AbortController();
  controller.abort();
  const ctx = { ...context(root, { kind: 'website', subtype: 'landing' }, { action: 'generate' }), signal: controller.signal };
  try {
    await assert.rejects(
      runBuildJob(ctx),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'cancelled',
    );
    const recorded = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'evidence', ctx.jobId, 'result.json'), 'utf8')) as { phase: string; summary: string };
    assert.equal(recorded.phase, 'cancelled');
    assert.equal(recorded.summary, 'cancelled');
    assert.equal(fs.existsSync(path.join(root, 'app')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an automation preview stays in the project and does not create a host schedule', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-run-auto-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-run-auto-data-'));
  const previous = process.env.LOAM_DATA_DIR;
  process.env.LOAM_DATA_DIR = data;
  resetDb();
  const generated = context(root, { kind: 'automation' }, { action: 'generate' });
  const preview = context(root, { kind: 'automation' }, { action: 'preview' });
  try {
    assert.equal(listSchedules().length, 0);
    await runBuildJob(generated);
    await runBuildJob(preview);
    await runBuildJob(preview);
    assert.equal(listSchedules().length, 0);
    const spec = JSON.parse(fs.readFileSync(path.join(root, 'app', 'automation.json'), 'utf8')) as { scheduleId?: string; enabled?: boolean; send?: boolean };
    assert.match(spec.scheduleId ?? '', /^local_[a-f0-9]{12}$/);
    assert.equal(spec.enabled, false);
    assert.equal(spec.send, false);
  } finally {
    resetDb();
    if (previous === undefined) delete process.env.LOAM_DATA_DIR;
    else process.env.LOAM_DATA_DIR = previous;
    resetDb();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('desktop, safari, and notebook jobs refuse outputs the machine cannot build', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-run-'));
  const desktop = context(root, { kind: 'desktop' }, { action: 'generate' });
  const notebook = context(root, { kind: 'notebook' }, { action: 'generate' });
  const safari = context(root, { kind: 'safari-extension' }, { action: 'generate' });
  try {
    await runBuildJob(desktop);
    const packed = await runBuildJob(context(root, { kind: 'desktop' }, { action: 'package', format: 'source-zip' }));
    const before = resolveArtifact(root, 'app_abcdefghijkl', packed.artifactId!);
    const artifactDir = path.join(root, '.loam', 'build-menu', 'artifacts');
    const namesBefore = fs.readdirSync(artifactDir).sort();
    await assert.rejects(
      runBuildJob(context(root, { kind: 'desktop' }, { action: 'package', format: 'portable-exe' })),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement',
    );
    const after = resolveArtifact(root, 'app_abcdefghijkl', packed.artifactId!);
    assert.equal(after.artifact.sha256, before.artifact.sha256);
    assert.equal(createHash('sha256').update(after.bytes).digest('hex'), before.artifact.sha256);
    assert.deepEqual(fs.readdirSync(artifactDir).sort(), namesBefore);
    assert.equal(collectExe(root).length, 0);
    const refused = JSON.parse(fs.readFileSync(path.join(root, '.loam', 'build-menu', 'evidence', 'job_desktop_package', 'result.json'), 'utf8')) as { phase: string };
    assert.equal(refused.phase, 'failed');
    const widgetRoot = path.join(root, 'widget');
    await runBuildJob(context(widgetRoot, { kind: 'widget' }, { action: 'generate' }));
    const widgetZip = await runBuildJob(context(widgetRoot, { kind: 'widget' }, { action: 'package', format: 'source-zip' }));
    const widgetBefore = resolveArtifact(widgetRoot, 'app_abcdefghijkl', widgetZip.artifactId!);
    await assert.rejects(
      runBuildJob(context(widgetRoot, { kind: 'widget' }, { action: 'package', format: 'portable-exe' })),
      (error: unknown) => error instanceof BuildMenuError && error.message === 'missing_requirement',
    );
    const widgetAfter = resolveArtifact(widgetRoot, 'app_abcdefghijkl', widgetZip.artifactId!);
    assert.equal(widgetAfter.artifact.sha256, widgetBefore.artifact.sha256);
    assert.equal(collectExe(widgetRoot).length, 0);
    await runBuildJob(notebook);
    await assert.rejects(
      runBuildJob(context(root, { kind: 'notebook' }, { action: 'kernel-execute', cellId: 'cell-1' })),
      /missing_requirement/,
    );
    await runBuildJob(safari);
    const expected = process.platform === 'darwin' ? /missing_requirement/ : /unsupported_platform/;
    await assert.rejects(
      runBuildJob(context(root, { kind: 'safari-extension' }, { action: 'package', format: 'xcode-source' })),
      expected,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a website preview that exits twice fails the job and does not package', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-preview-crash-'));
  const registry = new ProcessLeaseRegistry(300);
  const ports = createWebsitesPorts({ leases: registry });
  resetGrants();
  resetJobs();
  const preview = context(root, { kind: 'website', subtype: 'landing' }, { action: 'preview' });
  const grantId = issueGrant({
    projectId: preview.manifest.projectId,
    revision: 1,
    planSha256: 'b'.repeat(64),
    operation: { action: 'preview' },
    sessionId: 'session-a',
    expiresAt: Date.now() + 60_000,
  });
  materialize({ selection: preview.manifest.selection, workspace: root, title: preview.manifest.title });
  let packaged = 0;
  const started = startJob({
    projectId: preview.manifest.projectId,
    expectedRevision: 1,
    operation: { action: 'preview' },
    planSha256: 'b'.repeat(64),
    grantId,
    idempotencyKey: 'site-crash',
  }, 'session-a', preview.manifest, root, {
    scaffold: async () => { packaged += 1; },
    run: async (ctx) => { await ports.preview(ctx); },
  });
  const waitFor = async (ready: () => boolean): Promise<void> => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    await waitFor(() => readJob(preview.manifest.projectId, started.jobId).phase === 'running');
    assert.equal(readJob(preview.manifest.projectId, started.jobId).phase, 'running');
    const first = registry.runningPid(started.jobId);
    assert.ok(first);
    process.kill(first, 'SIGTERM');
    let second: number | null = null;
    await waitFor(() => {
      const pid = registry.runningPid(started.jobId);
      if (pid && pid !== first) second = pid;
      return second !== null || readJob(preview.manifest.projectId, started.jobId).phase === 'failed';
    });
    if (second) process.kill(second, 'SIGTERM');
    await waitFor(() => readJob(preview.manifest.projectId, started.jobId).phase === 'failed');
    const failed = readJob(preview.manifest.projectId, started.jobId);
    assert.equal(failed.phase, 'failed');
    if (failed.phase === 'failed') assert.equal(failed.message, 'preview_exited');
    noteReady(started.jobId, started.revision);
    assert.equal(readJob(preview.manifest.projectId, started.jobId).phase, 'failed');
    assert.deepEqual(readJobLog(preview.manifest.projectId, started.jobId), ['preview exited']);
    assert.equal(packaged, 0);
    assert.equal(registry.liveCount(), 0);
    const evidence = fs.readFileSync(path.join(root, '.loam', 'build-menu', 'evidence', started.jobId, 'result.json'), 'utf8');
    assert.match(evidence, /preview_exited/);
    assert.equal(evidence.includes('artifactId'), false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(registry.runningPid(started.jobId), null);
  } finally {
    const pid = registry.runningPid(started.jobId);
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    resetJobs();
    resetGrants();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
