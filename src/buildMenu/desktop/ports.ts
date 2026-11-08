import type { DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { createKindPorts, type KindDeps } from '../kindRuntime.js';
import { desktopProfile } from './profile.js';

export function createDesktopPorts(deps: KindDeps): DriverPorts {
  return createKindPorts(desktopProfile, deps);
}
