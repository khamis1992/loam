import type { BuildJobContext, DriverPorts, ExportKind } from '../../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from '../grants.js';
import { createKindPorts, type KindDeps } from '../kindRuntime.js';
import { mobileProfile } from './profile.js';

export function createMobilePorts(deps: KindDeps): DriverPorts {
  const ports = createKindPorts(mobileProfile, deps);
  return {
    ...ports,
    async export(ctx: BuildJobContext, format: ExportKind) {
      if (format === 'apk-debug') throw new BuildMenuError('missing_requirement', 400);
      return ports.export(ctx, format);
    },
  };
}
