import type { DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { createKindPorts, type KindDeps } from '../kindRuntime.js';
import { mobileProfile } from './profile.js';

export function createMobilePorts(deps: KindDeps): DriverPorts {
  return createKindPorts(mobileProfile, deps);
}
