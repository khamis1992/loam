import type { DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { createKindPorts, type KindDeps } from '../kindRuntime.js';
import { websiteProfile } from './profile.js';

export function createWebsitesPorts(deps: KindDeps): DriverPorts {
  return createKindPorts(websiteProfile, deps);
}
