import type { DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { createKindPorts, type KindDeps } from '../kindRuntime.js';
import { automationProfile } from './profile.js';

export function createAutomationsPorts(deps: KindDeps): DriverPorts {
  return createKindPorts(automationProfile, deps);
}
