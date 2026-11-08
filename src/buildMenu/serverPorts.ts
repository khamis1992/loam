import { createHash } from 'node:crypto';
import type { BuildJobContext, BuildKind, BuildOperation, DriverPorts, PreviewLease } from '../../packages/shared/src/buildMenu.js';
import { materialize, readPreview } from './materialize.js';
import { ProcessLeaseRegistry } from './processLease.js';
import { BuildMenuError } from './grants.js';
import { writeJobEvidence } from './evidence.js';
import { attachPreviewNonce } from './previewNonce.js';
import { registerDryRun } from './automations/register.js';
import { createAutomationsPorts } from './automations/ports.js';
import { chromePreviewSummary } from './chrome/browser.js';
import { createChromePorts } from './chrome/ports.js';
import { createDesktopPorts } from './desktop/ports.js';
import { createGamesPorts } from './games/ports.js';
import { createMobilePorts } from './mobile/ports.js';
import { createNotebooksPorts } from './notebooks/ports.js';
import { createSafariPorts } from './safari/ports.js';
import { createWebsitesPorts } from './websites/ports.js';
import { createWidgetPorts } from './widget/ports.js';

const leases = new ProcessLeaseRegistry();
const ports: Record<BuildKind, DriverPorts> = {
  website: createWebsitesPorts({ leases }),
  desktop: createDesktopPorts({ leases }),
  widget: createWidgetPorts({ leases }),
  automation: createAutomationsPorts({ leases }),
  notebook: createNotebooksPorts({ leases }),
  mobile: createMobilePorts({ leases }),
  'chrome-extension': createChromePorts({ leases }),
  'safari-extension': createSafariPorts({ leases }),
  game: createGamesPorts({ leases }),
};

export function portsFor(kind: BuildKind): DriverPorts {
  switch (kind) {
    case 'website':
    case 'desktop':
    case 'widget':
    case 'automation':
    case 'notebook':
    case 'mobile':
    case 'chrome-extension':
    case 'safari-extension':
    case 'game':
      return ports[kind];
    default: {
      const unknown: never = kind;
      void unknown;
      throw new BuildMenuError(typeof kind === 'string' ? 'unsupported_operation' : 'invalid_request', 400);
    }
  }
}

function refuseUnknownOperation(operation: BuildOperation): void {
  if (!operation || typeof operation !== 'object') throw new BuildMenuError('invalid_request', 400);
  switch (operation.action) {
    case 'generate':
    case 'preview':
    case 'package':
    case 'kernel-execute':
      return;
    default: {
      const unknown: never = operation;
      void unknown;
      throw new BuildMenuError('unsupported_operation', 400);
    }
  }
}

export interface BuildRunResult {
  summary: string;
  previewHtml?: string;
  previewUrl?: string;
  previewNonce?: string;
  artifactId?: string;
}

export async function runBuildJob(ctx: BuildJobContext): Promise<BuildRunResult> {
  portsFor(ctx.manifest.selection.kind);
  refuseUnknownOperation(ctx.operation);
  try {
    if (ctx.signal.aborted) throw new BuildMenuError('cancelled', 409);
    const result = await perform(ctx);
    if (ctx.signal.aborted) throw new BuildMenuError('cancelled', 409);
    writeJobEvidence(ctx.workspace, ctx.jobId, evidenceRecord(ctx, 'completed', result.summary, result.artifactId));
    return result;
  } catch (error) {
    const cancelled = ctx.signal.aborted;
    const summary = cancelled ? 'cancelled' : error instanceof Error ? error.message : 'tool_failed';
    try { writeJobEvidence(ctx.workspace, ctx.jobId, evidenceRecord(ctx, cancelled ? 'cancelled' : 'failed', summary)); } catch { /* keep the job error */ }
    throw error;
  }
}

function evidenceRecord(ctx: BuildJobContext, phase: string, summary: string, artifactId?: string): Record<string, string | number> {
  const record: Record<string, string | number> = {
    jobId: ctx.jobId,
    projectId: ctx.manifest.projectId,
    revision: ctx.manifest.revision,
    kind: ctx.manifest.selection.kind,
    action: ctx.operation.action,
    phase,
    summary,
  };
  if (artifactId) record.artifactId = artifactId;
  return record;
}

async function perform(ctx: BuildJobContext): Promise<BuildRunResult> {
  refuseUnknownOperation(ctx.operation);
  const driver = portsFor(ctx.manifest.selection.kind);
  switch (ctx.operation.action) {
    case 'generate': {
      const prepared = materialize({ selection: ctx.manifest.selection, workspace: ctx.workspace, title: ctx.manifest.title });
      return { summary: prepared.summary, previewHtml: readPreview(ctx.workspace, prepared.relativePreview) };
    }
    case 'preview': {
      if (ctx.manifest.selection.kind === 'automation') {
        registerDryRun(ctx.workspace, (row) => ({
          id: `local_${createHash('sha256').update(`${row.cron}\0${row.timezone}`).digest('hex').slice(0, 12)}`,
          enabled: false,
        }));
      }
      const lease: PreviewLease = await driver.preview(ctx);
      if (lease.kind === 'http' && ctx.manifest.selection.kind === 'chrome-extension') {
        return attachPreviewNonce({ summary: chromePreviewSummary(ctx.workspace, lease.url), previewUrl: lease.url }, lease.messageNonce);
      }
      if (lease.kind === 'http') return attachPreviewNonce({ summary: lease.url, previewUrl: lease.url }, lease.messageNonce);
      if (ctx.manifest.selection.kind === 'automation') {
        return { summary: lease.kind, previewHtml: readPreview(ctx.workspace, 'app/preview.html') };
      }
      return { summary: lease.kind };
    }
    case 'package': {
      const artifact = await driver.export(ctx, ctx.operation.format);
      return { summary: artifact.artifactId, artifactId: artifact.artifactId };
    }
    case 'kernel-execute':
      await driver.executeCell(ctx, ctx.operation.cellId);
      return { summary: ctx.operation.cellId };
    default: {
      const unknown: never = ctx.operation;
      void unknown;
      throw new BuildMenuError('unsupported_operation', 400);
    }
  }
}

export async function stopBuildJob(ctx: BuildJobContext): Promise<void> {
  const driver = portsFor(ctx.manifest.selection.kind);
  refuseUnknownOperation(ctx.operation);
  await driver.stop(ctx);
}
