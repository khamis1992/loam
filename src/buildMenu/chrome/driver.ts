import type { BuildDriver, DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { bindDriver } from '../bindDriver.js';
import { chromeProfile } from './profile.js';

export function createChromeDriver(ports: DriverPorts): BuildDriver {
  return bindDriver(chromeProfile, ports);
}
