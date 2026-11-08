import type { DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { createKindPorts, type KindDeps } from '../kindRuntime.js';
import { chromeProfile } from './profile.js';

export function createChromePorts(deps: KindDeps): DriverPorts {
  return createKindPorts(chromeProfile, deps);
}
