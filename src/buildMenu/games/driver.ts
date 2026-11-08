import type { BuildDriver, DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { bindDriver } from '../bindDriver.js';
import { gameProfile } from './profile.js';

export function createGamesDriver(ports: DriverPorts): BuildDriver {
  return bindDriver(gameProfile, ports);
}
