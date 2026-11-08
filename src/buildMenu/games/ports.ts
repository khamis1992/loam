import type { DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { createKindPorts, type KindDeps } from '../kindRuntime.js';
import { gameProfile } from './profile.js';

export function createGamesPorts(deps: KindDeps): DriverPorts {
  return createKindPorts(gameProfile, deps);
}
