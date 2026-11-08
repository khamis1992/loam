import type { BuildJobContext, DriverPorts, ExportKind } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { createKindPorts, type KindDeps } from '../kindRuntime.js';
import { assertSafariHandoff } from './platform.js';
import { safariProfile } from './profile.js';

export function createSafariPorts(deps: KindDeps): DriverPorts {
  const ports = createKindPorts(safariProfile, deps);
  return {
    ...ports,
    async export(ctx: BuildJobContext, format: ExportKind) {
      if (format === 'source-zip') guardSafariHandoff(ctx.workspace);
      return ports.export(ctx, format);
    },
  };
}

function guardSafariHandoff(workspace: string): void {
  try {
    assertSafariHandoff(workspace);
  } catch (error) {
    if (error instanceof BuildMenuError) throw error;
    const message = error instanceof Error ? error.message : 'tool_failed';
    if (message === 'invalid_request' || message === 'unsafe_path' || message === 'unsupported_platform') {
      throw new BuildMenuError(message, 400);
    }
    throw new BuildMenuError('tool_failed', 500);
  }
}
