import type { BuildDriver, DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { bindDriver } from '../bindDriver.js';
import { safariProfile } from './profile.js';

export function createSafariDriver(ports: DriverPorts): BuildDriver {
  return bindDriver(safariProfile, ports);
}
