import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { rootAsset } from '../config.js';
import type { BuildJobContext, BuildKind, BuildProfile, DriverPorts, ExportKind, PreviewLease } from '../../packages/shared/src/buildMenu.js';
import { writeBytesArtifact, writeSourceArtifact, readProjectBytes } from './artifacts.js';
import { exportDebugApk } from './mobile/apk.js';
import { zipBuffer } from '../preview/zip.js';
import { BuildMenuError } from './grants.js';
import { notePreviewCrashed } from './jobs.js';
import { materialize } from './materialize.js';
import { readMobile } from '../mobile/store.js';
import { simulationDocument } from './mobile/simulation.js';
import { sourceExport } from '../mobile/source.js';
import { leaseEnv, type ProcessLeaseRegistry } from './processLease.js';
import { openIsolatedChrome, writeUnpackedInstructions } from './chrome/browser.js';
import { unsafeExtensionPage, unsafeExtensionScript } from './extensions/source.js';
import { openNativeLease, stopNativeLease, waitForReadyFile, watchNativeExit, type NativeLease } from './nativeStop.js';
import { desktopPreviewLaunch } from './desktop/templateLock.js';
import { requestPortableExeBytes } from './desktop/portableStatus.js';
import { absentRequirements, findChrome, findElectron, nodeSupported } from './toolchain.js';
import { recordPreview, writeProjectText } from './automations/run.js';
import { scheduleCard, schedulePage, upcomingRuns } from './automations/schedule.js';
import { unsafeGamePage } from './games/page.js';
import { readGameBrief } from './games/scene.js';
import { storedBrief } from './planProvenance.js';
import { notebookExportText } from './notebooks/document.js';
import { routineSendRequested } from '../../packages/shared/src/buildMenu.js';
import { approvedExtensionDigest, assertExtensionManifest, extensionPermissionDigest } from './chrome/permissions.js';
import { currentConversion } from './safari/platform.js';
import { readNotebookText, runKernelCell, stopOwnedKernel } from './notebooks/kernel.js';
import { writeNotebookPreview } from './notebooks/view.js';
import { forgetOpenedWidget, rememberOpenedWidget } from './widget/running.js';
import { buildWebsiteBundle, recordBlockedWebsiteBuild, recordWebsiteBuildFailure, unsafeWebsiteDocument, unsafeWebsitePreview } from './websites/bundle.js';
import { currentWebsiteDevStarter, currentWebsiteHostRunner, runWebsiteHost, startApprovedWebsiteDev, websiteHostReady } from './websites/hostCommand.js';
import { assertFrozenWebsiteTemplate } from './websites/templateLock.js';
import { previewReadyMs } from './deadlines.js';

const previewScript = rootAsset('src', 'buildMenu', 'staticPreview.cjs');

export interface KindDeps {
  leases: ProcessLeaseRegistry;
  electronExecutable?: string | null;
  chromeExecutable?: string | null;
}

export function createKindPorts(profile: BuildProfile, deps: KindDeps): DriverPorts {
  const httpJobs = new Map<string, string>();
  const nativeJobs = new Map<string, NativeLease>();
  const devStops = new Map<string, () => Promise<void>>();
  return {
    async missing(_ctx, required) {
      return absentRequirements(required);
    },
    async scaffold(ctx) {
      materialize({ selection: ctx.manifest.selection, workspace: ctx.workspace, title: ctx.manifest.title });
    },
    async preview(ctx) {
      switch (profile.kind) {
        case 'automation':
          return dryRun(ctx);
        case 'desktop':
        case 'widget':
          return openWindow(ctx, deps, nativeJobs);
        case 'website':
        case 'game':
        case 'notebook':
        case 'mobile':
        case 'safari-extension':
          return serveFile(ctx, profile.kind, deps.leases, httpJobs, devStops);
        case 'chrome-extension':
          return previewChrome(ctx, deps, httpJobs, nativeJobs, devStops);
        default: {
          const unknown: never = profile.kind;
          throw new BuildMenuError(`missing_requirement:${unknown}`, 400);
        }
      }
    },
    async export(ctx, format) {
      if (!profile.exports.includes(format)) throw new BuildMenuError('unsupported_format', 400);
      return exportFormat(ctx, profile.kind, format);
    },
    async executeCell(ctx, cellId) {
      if (profile.kind !== 'notebook' || ctx.operation.action !== 'kernel-execute' || ctx.operation.cellId !== cellId) {
        throw new BuildMenuError('unsupported_operation', 400);
      }
      await runKernelCell({
        workspace: ctx.workspace,
        cellId,
        projectId: ctx.manifest.projectId,
        jobId: ctx.jobId,
        signal: ctx.signal,
      });
    },
    async stop(ctx) {
      const devStop = devStops.get(ctx.jobId);
      if (devStop) {
        devStops.delete(ctx.jobId);
        await devStop();
      }
      const httpId = httpJobs.get(ctx.jobId);
      if (httpId?.startsWith('host_')) {
        httpJobs.delete(ctx.jobId);
        return;
      }
      if (httpId) {
        httpJobs.delete(ctx.jobId);
        await deps.leases.stop(httpId, ctx.jobId).catch((error: unknown) => {
          if (!(error instanceof BuildMenuError) || error.status !== 404) throw error;
        });
      }
      if (profile.kind === 'notebook') stopOwnedKernel(ctx.manifest.projectId, ctx.workspace);
      const native = nativeJobs.get(ctx.jobId);
      if (!native) return;
      nativeJobs.delete(ctx.jobId);
      await stopNativeLease(native, native.spawnNonce);
    },
  };
}

function dryRun(ctx: BuildJobContext): PreviewLease {
  const reportPath = path.join(ctx.workspace, 'app', 'report.txt');
  const specPath = path.join(ctx.workspace, 'app', 'automation.json');
  assertExclusiveDestination(reportPath);
  assertExclusiveDestination(specPath);
  const report = fs.readFileSync(reportPath, 'utf8');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as { send?: boolean; cron?: string; timezone?: string; until?: string; paused?: boolean; enabled?: boolean };
  if (spec.send !== false || !report.includes('dry-run')) throw new BuildMenuError('tool_failed', 500);
  if (spec.cron === '0 9 * * 1' && spec.timezone === 'Asia/Qatar') {
    const card = scheduleCard(upcomingRuns(spec.cron, new Date(), 3, spec.until), spec.until, spec.paused === true, spec.enabled === true);
    writeProjectText(ctx.workspace, 'schedule.txt', card);
    writeProjectText(ctx.workspace, 'preview.html', schedulePage(card, routineSendRequested(readGameBrief(ctx.workspace)), storedBrief(ctx.workspace)));
  }
  recordPreview(ctx.workspace);
  return { kind: 'none' };
}

async function previewChrome(ctx: BuildJobContext, deps: KindDeps, httpJobs: Map<string, string>, nativeJobs: Map<string, NativeLease>, devStops: Map<string, () => Promise<void>>): Promise<PreviewLease> {
  const lease = await serveFile(ctx, 'chrome-extension', deps.leases, httpJobs, devStops);
  writeUnpackedInstructions(ctx.workspace, ctx.jobId, false);
  if (deps.chromeExecutable === null) return lease;
  const executable = deps.chromeExecutable ?? findChrome();
  if (!executable) return lease;
  try {
    const child = await openIsolatedChrome({ executable, workspace: ctx.workspace, jobId: ctx.jobId, signal: ctx.signal });
    const native = openNativeLease(`chrome_${ctx.jobId}`, child, true);
    nativeJobs.set(ctx.jobId, native);
    let opened = true;
    watchNativeExit(native, () => {
      if (!opened) return;
      notePreviewCrashed(ctx.jobId);
      const httpId = httpJobs.get(ctx.jobId);
      if (!httpId) return;
      httpJobs.delete(ctx.jobId);
      void deps.leases.stop(httpId, ctx.jobId).catch(() => undefined);
    });
  } catch (error) {
    await deps.leases.stop(lease.leaseId, ctx.jobId).catch(() => undefined);
    httpJobs.delete(ctx.jobId);
    throw error instanceof BuildMenuError ? error : new BuildMenuError('tool_failed', 500);
  }
  return lease;
}

async function serveFile(ctx: BuildJobContext, kind: BuildKind, leases: ProcessLeaseRegistry, httpJobs: Map<string, string>, devStops: Map<string, () => Promise<void>>): Promise<Extract<PreviewLease, { kind: 'http' }>> {
  if (!nodeSupported()) throw new BuildMenuError('missing_requirement', 400);
  if (kind === 'website' && websiteHostReady()) return serveApprovedWebsite(ctx, httpJobs, devStops);
  if (kind === 'website') assertFrozenWebsiteTemplate(ctx.workspace);
  const relative = previewFile(kind, ctx);
  const marker = healthMarker(ctx);
  const ports = await freePorts(3);
  const started = await leases.start({
    projectId: ctx.manifest.projectId,
    jobId: ctx.jobId,
    executable: process.execPath,
    args: [previewScript, '--file', relative],
    cwd: ctx.workspace,
    ports,
    readyTimeoutMs: previewReadyMs(kind),
    signal: ctx.signal,
    onGaveUp: () => notePreviewCrashed(ctx.jobId),
  });
  httpJobs.set(ctx.jobId, started.leaseId);
  try {
    const response = await fetch(started.url, { signal: AbortSignal.any([AbortSignal.timeout(2_000), ctx.signal]) });
    const body = await response.text();
    if (!response.ok || !body.includes(marker)) throw new BuildMenuError('tool_failed', 500);
  } catch (error) {
    await leases.stop(started.leaseId, ctx.jobId).catch(() => undefined);
    httpJobs.delete(ctx.jobId);
    if (ctx.signal.aborted) throw new BuildMenuError('cancelled', 409);
    throw error instanceof BuildMenuError ? error : new BuildMenuError('tool_failed', 500);
  }
  return { kind: 'http', leaseId: started.leaseId, url: started.url, jobId: ctx.jobId, messageNonce: started.messageNonce };
}

async function serveApprovedWebsite(ctx: BuildJobContext, httpJobs: Map<string, string>, devStops: Map<string, () => Promise<void>>): Promise<Extract<PreviewLease, { kind: 'http' }>> {
  if (ctx.signal.aborted) throw new BuildMenuError('cancelled', 409);
  const install = currentWebsiteHostRunner();
  const listen = currentWebsiteDevStarter();
  if (!install || !listen) throw new BuildMenuError('missing_requirement', 400);
  const ports = await freePorts(3);
  if (ctx.signal.aborted) throw new BuildMenuError('cancelled', 409);
  const started = await startApprovedWebsiteDev({ workspace: ctx.workspace, ports, signal: ctx.signal, installImpl: install, listenImpl: listen });
  const url = `http://127.0.0.1:${started.port}/`;
  devStops.set(ctx.jobId, started.stop);
  httpJobs.set(ctx.jobId, `host_${ctx.jobId}`);
  try {
    const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(2_000), ctx.signal]) });
    const body = await response.text();
    if (!response.ok || !body.includes(healthMarker(ctx))) throw new BuildMenuError('tool_failed', 500);
  } catch (error) {
    devStops.delete(ctx.jobId);
    httpJobs.delete(ctx.jobId);
    await started.stop().catch(() => undefined);
    if (ctx.signal.aborted) throw new BuildMenuError('cancelled', 409);
    throw error instanceof BuildMenuError ? error : new BuildMenuError('tool_failed', 500);
  }
  return { kind: 'http', leaseId: `host_${ctx.jobId}`, url, jobId: ctx.jobId, messageNonce: randomBytes(16).toString('hex') };
}

function previewFile(kind: BuildKind, ctx: BuildJobContext): string {
  switch (kind) {
    case 'website':
      return 'app/preview.html';
    case 'game':
      return 'app/index.html';
    case 'notebook':
      try {
        writeNotebookPreview(ctx.workspace);
      } catch (error) {
        if (error instanceof BuildMenuError) throw error;
        if (error instanceof Error && error.message === 'unsafe_path') throw new BuildMenuError('unsafe_path', 400);
        throw new BuildMenuError('tool_failed', 500);
      }
      return 'app/preview.html';
    case 'chrome-extension':
    case 'safari-extension':
      return 'app/popup.html';
    case 'mobile':
      writeMobileSimulation(ctx.workspace);
      return 'app/simulation.html';
    case 'automation':
    case 'desktop':
    case 'widget':
      throw new BuildMenuError('unsupported_operation', 400);
    default: {
      const unknown: never = kind;
      throw new BuildMenuError(`missing_requirement:${unknown}`, 400);
    }
  }
}

function healthMarker(ctx: BuildJobContext): string {
  switch (ctx.manifest.selection.kind) {
    case 'website':
      switch (ctx.manifest.selection.subtype) {
        case 'store': return 'متجر';
        case 'booking': return 'حجز';
        case 'chatbot': return 'دردشة';
        case 'landing': return 'هبوط';
        default: {
          const unknown: never = ctx.manifest.selection.subtype;
          return unknown;
        }
      }
    case 'game':
      return '<canvas';
    case 'notebook':
      return 'nbformat';
    case 'mobile':
      return readMobile(ctx.workspace)?.screens[0]?.title ?? '';
    case 'chrome-extension':
    case 'safari-extension':
      return ctx.manifest.title;
    case 'automation':
    case 'desktop':
    case 'widget':
      return '';
    default: {
      const unknown: never = ctx.manifest.selection;
      return unknown;
    }
  }
}

function writeMobileSimulation(workspace: string): void {
  const project = readMobile(workspace);
  if (!project?.screens[0]) throw new BuildMenuError('tool_failed', 500);
  const html = simulationDocument(project, storedBrief(workspace));
  if (/https?:\/\//i.test(html)) throw new BuildMenuError('unsafe_path', 400);
  const file = path.join(workspace, 'app', 'simulation.html');
  assertExclusiveDestination(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

function assertExclusiveDestination(file: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new BuildMenuError('unsafe_path', 400);
}

function nodeCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

async function openWindow(ctx: BuildJobContext, deps: KindDeps, nativeJobs: Map<string, NativeLease>): Promise<PreviewLease> {
  const executable = deps.electronExecutable === undefined ? findElectron() : deps.electronExecutable;
  if (!executable) throw new BuildMenuError('missing_requirement', 400);
  const launch = desktopPreviewLaunch(ctx.workspace, executable);
  const readyFile = path.join(ctx.workspace, '.loam', 'build-menu', 'window-ready');
  const nonce = randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(readyFile), { recursive: true });
  fs.rmSync(readyFile, { force: true });
  const child = spawn(launch.executable, [launch.script], {
    cwd: launch.cwd,
    env: leaseEnv({ LOAM_PREVIEW_READY: readyFile, LOAM_PREVIEW_NONCE: nonce, ...electronBoot() }),
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  });
  const lease = openNativeLease(`native_${ctx.jobId}`, child, true);
  nativeJobs.set(ctx.jobId, lease);
  let opened = false;
  watchNativeExit(lease, () => {
    if (child.pid) forgetOpenedWidget(child.pid);
    if (!opened) return;
    notePreviewCrashed(ctx.jobId);
  });
  const ready = await waitForReadyFile(readyFile, previewReadyMs(ctx.manifest.selection.kind), ctx.signal, nonce);
  opened = Boolean(ready && child.pid && !ctx.signal.aborted);
  if (!ready || !child.pid || ctx.signal.aborted) {
    if (child.pid) forgetOpenedWidget(child.pid);
    nativeJobs.delete(ctx.jobId);
    await stopNativeLease(lease, lease.spawnNonce);
    throw new BuildMenuError(ctx.signal.aborted ? 'cancelled' : 'tool_failed', ctx.signal.aborted ? 409 : 500);
  }
  if (ctx.manifest.selection.kind === 'widget') rememberOpenedWidget(ctx.workspace, nonce, child.pid);
  return { kind: 'native', leaseId: lease.leaseId, jobId: ctx.jobId };
}

async function exportFormat(ctx: BuildJobContext, kind: BuildKind, format: ExportKind) {
  const revision = ctx.manifest.revision;
  switch (format) {
    case 'source-zip':
      if (kind === 'mobile') return exportMobileSource(ctx);
      if (kind === 'chrome-extension' || kind === 'safari-extension') {
        assertPackedExtension(ctx.workspace);
        const entries = namedEntries(ctx.workspace, extensionPackNames(kind));
        for (const entry of entries) assertExtensionEntry(entry);
        if (kind === 'safari-extension') assertSafariSource(entries);
        return writeBytesArtifact(ctx.workspace, ctx.manifest.projectId, revision, format, zipBuffer(entries), 'zip');
      }
      return writeSourceArtifact(ctx.workspace, ctx.manifest.projectId, revision, format);
    case 'ipynb':
      return writeBytesArtifact(ctx.workspace, ctx.manifest.projectId, revision, format, Buffer.from(notebookExportText(readNotebookText(ctx.workspace))), 'ipynb');
    case 'mv3-zip': {
      assertPackedExtension(ctx.workspace);
      const entries = namedEntries(ctx.workspace, ['manifest.json', 'popup.html', 'popup.js']);
      for (const entry of entries) assertExtensionEntry(entry);
      return writeBytesArtifact(ctx.workspace, ctx.manifest.projectId, revision, format, zipBuffer(entries), 'zip');
    }
    case 'web-zip':
      if (kind === 'game') return writeBytesArtifact(ctx.workspace, ctx.manifest.projectId, revision, format, zipBuffer(gameBundle(ctx.workspace)), 'zip');
      if (kind === 'website') {
        await buildApprovedWebsite(ctx.workspace);
        const entries = namedEntries(ctx.workspace, websiteDistNames(ctx.workspace));
        for (const entry of entries) {
          const text = entry.data.toString('utf8');
          assertLocalText(text);
          if (entry.name === 'index.html' && unsafeWebsiteDocument(text)) throw new BuildMenuError('unsafe_path', 400);
          if (entry.name === 'page.js' && unsafeWebsitePreview(text)) throw new BuildMenuError('unsafe_path', 400);
        }
        return writeBytesArtifact(ctx.workspace, ctx.manifest.projectId, revision, format, zipBuffer(entries), 'zip');
      }
      return writeBytesArtifact(ctx.workspace, ctx.manifest.projectId, revision, format, zipBuffer(namedEntries(ctx.workspace, websiteDistNames(ctx.workspace))), 'zip');
    case 'apk-debug':
      return exportDebugApk(ctx.workspace, ctx.manifest.projectId, revision);
    case 'portable-exe':
      return requestPortableExeBytes(ctx.workspace);
    case 'xcode-source':
      if (process.platform !== 'darwin') throw new BuildMenuError('unsupported_platform', 400);
      throw new BuildMenuError('missing_requirement', 400);
    default: {
      const unknown: never = format;
      throw new BuildMenuError(String(unknown), 400);
    }
  }
}

async function exportMobileSource(ctx: BuildJobContext) {
  const before = readMobile(ctx.workspace);
  if (!before) throw new BuildMenuError('tool_failed', 500);
  const bytes = await sourceExport(ctx.workspace, ctx.manifest.projectId);
  const after = readMobile(ctx.workspace);
  if (!after || after.revision !== before.revision) throw new BuildMenuError('stale_revision', 409);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const artifact = writeBytesArtifact(ctx.workspace, ctx.manifest.projectId, ctx.manifest.revision, 'source-zip', bytes, 'zip');
  const note = { mobileRevision: after.revision, manifestRevision: ctx.manifest.revision, sourceSha256, apkIncluded: false };
  const notePath = path.join(ctx.workspace, '.loam', 'build-menu', 'artifacts', `${artifact.artifactId}.source.json`);
  assertExclusiveDestination(notePath);
  fs.writeFileSync(notePath, `${JSON.stringify(note)}\n`);
  return artifact;
}

function gameBundle(workspace: string): { name: string; data: Buffer }[] {
  const names = ['index.html', 'tuning.json', 'LICENSE', 'assets/manifest.json'];
  const entries = names.map((name) => {
    const data = readProjectBytes(workspace, name);
    const text = data.toString('utf8');
    assertLocalText(text);
    if (name === 'index.html' && unsafeGamePage(text)) throw new BuildMenuError('unsafe_path', 400);
    return { name, data };
  });
  assertGameAssets(workspace, entries);
  return entries;
}

function assertGameAssets(workspace: string, entries: readonly { name: string; data: Buffer }[]): void {
  const manifest = entries.find((entry) => entry.name === 'assets/manifest.json');
  if (!manifest) throw new BuildMenuError('unsafe_path', 400);
  let parsed: { assets?: unknown };
  try {
    parsed = JSON.parse(manifest.data.toString('utf8')) as { assets?: unknown };
  } catch {
    throw new BuildMenuError('unsafe_path', 400);
  }
  if (!Array.isArray(parsed.assets) || parsed.assets.length === 0) throw new BuildMenuError('unsafe_path', 400);
  const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
  for (const asset of parsed.assets) {
    if (!asset || typeof asset !== 'object') throw new BuildMenuError('unsafe_path', 400);
    const record = asset as { path?: unknown; source?: unknown; license?: unknown; evidenceSha256?: unknown };
    if (record.source !== 'local-geometry' || record.license !== 'local') throw new BuildMenuError('unsafe_path', 400);
    if (typeof record.path !== 'string' || !/^[A-Za-z0-9./_-]{1,80}$/.test(record.path) || record.path.includes('..')) throw new BuildMenuError('unsafe_path', 400);
    if (typeof record.evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.evidenceSha256)) throw new BuildMenuError('unsafe_path', 400);
    const data = byName.get(record.path) ?? readProjectBytes(workspace, record.path);
    assertLocalText(data.toString('utf8'));
    if (createHash('sha256').update(data).digest('hex') !== record.evidenceSha256) throw new BuildMenuError('unsafe_path', 400);
  }
}

async function buildApprovedWebsite(workspace: string): Promise<void> {
  if (!websiteHostReady()) return;
  const runner = currentWebsiteHostRunner();
  if (!runner) throw new BuildMenuError('missing_requirement', 400);
  try {
    await runWebsiteHost({ workspace, script: 'typecheck', spawnImpl: runner });
    await runWebsiteHost({ workspace, script: 'build', spawnImpl: runner });
    const index = path.join(workspace, 'app', 'dist', 'index.html');
    if (!fs.existsSync(index)) throw new BuildMenuError('tool_failed', 500);
    const stat = fs.lstatSync(index);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new BuildMenuError('unsafe_path', 400);
  } catch (error) {
    if (error instanceof BuildMenuError && (error.message === 'unsafe_path' || error.message === 'invalid_request' || error.message === 'missing_requirement')) throw error;
    recordWebsiteBuildFailure(workspace);
    throw error instanceof BuildMenuError ? error : new BuildMenuError('tool_failed', 500);
  }
}

function websiteDistNames(workspace: string): string[] {
  const index = path.join(workspace, 'app', 'dist', 'index.html');
  if (!fs.existsSync(index)) {
    if (websiteHostReady()) throw new BuildMenuError('tool_failed', 500);
    try {
      buildWebsiteBundle(workspace);
    } catch (error) {
      if (error instanceof BuildMenuError && (error.message === 'unsafe_path' || error.message === 'invalid_request')) throw error;
      recordBlockedWebsiteBuild(workspace);
      throw new BuildMenuError('missing_requirement', 400);
    }
  }
  const stat = fs.lstatSync(index);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new BuildMenuError('unsafe_path', 400);
  const names = ['dist/index.html'];
  const script = path.join(workspace, 'app', 'dist', 'page.js');
  if (fs.existsSync(script) && fs.lstatSync(script).isFile()) names.push('dist/page.js');
  return names;
}

function assertPackedExtension(workspace: string): void {
  const file = path.join(workspace, 'app', 'manifest.json');
  assertExclusiveDestination(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    throw new BuildMenuError('invalid_request', 400);
  }
  try {
    assertExtensionManifest(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'permission_requires_review';
    const status = message === 'host_requires_review' || message === 'permission_requires_review' ? 403 : 400;
    throw new BuildMenuError(message, status);
  }
  if (approvedExtensionDigest(workspace) !== extensionPermissionDigest(parsed)) {
    throw new BuildMenuError('stale_revision', 409);
  }
}

function assertSafariSource(entries: readonly { name: string; data: Buffer }[]): void {
  const file = entries.find((entry) => entry.name === 'conversion.json');
  if (!file) throw new BuildMenuError('unsafe_path', 400);
  let parsed: { conversion?: unknown; safariTested?: unknown };
  try {
    parsed = JSON.parse(file.data.toString('utf8')) as { conversion?: unknown; safariTested?: unknown };
  } catch {
    throw new BuildMenuError('unsafe_path', 400);
  }
  if (parsed.safariTested !== false) throw new BuildMenuError('invalid_request', 400);
  if (parsed.conversion !== currentConversion()) throw new BuildMenuError('unsupported_platform', 400);
}

function extensionPackNames(kind: 'chrome-extension' | 'safari-extension'): string[] {
  const names = ['manifest.json', 'popup.html', 'popup.js'];
  if (kind === 'safari-extension') names.push('conversion.json', 'README-mac.md');
  return names;
}

function assertExtensionEntry(entry: { name: string; data: Buffer }): void {
  const text = entry.data.toString('utf8');
  assertLocalText(text);
  if (entry.name === 'popup.html' && unsafeExtensionPage(text)) throw new BuildMenuError('unsafe_path', 400);
  if (entry.name === 'popup.js' && unsafeExtensionScript(text)) throw new BuildMenuError('unsafe_path', 400);
}

function assertLocalText(text: string): void {
  if (/https?:\/\//i.test(text) || /javascript:/i.test(text)) throw new BuildMenuError('unsafe_path', 400);
}

function namedEntries(workspace: string, names: readonly string[]) {
  return names.map((name) => {
    const data = readProjectBytes(workspace, name);
    return { name: path.basename(name), data };
  });
}

function freePorts(count: number): Promise<number[]> {
  const servers: net.Server[] = [];
  const ports: number[] = [];
  const next = (remaining: number): Promise<number[]> => {
    if (remaining === 0) {
      return Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))).then(() => ports);
    }
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new BuildMenuError('port_exhausted', 503));
          return;
        }
        ports.push(address.port);
        servers.push(server);
        resolve(next(remaining - 1));
      });
    });
  };
  return next(count);
}

function electronBoot(): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH'] as const) {
    const value = process.env[key];
    if (value) extra[key] = value;
  }
  return extra;
}
