import type { BuildDriver, DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { bindDriver } from '../bindDriver.js';
import { mobileProfile } from './profile.js';

export function createMobileDriver(ports: DriverPorts): BuildDriver {
  return bindDriver(mobileProfile, ports);
}
