import type { BuildDriver, DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { bindDriver } from '../bindDriver.js';
import { desktopProfile } from './profile.js';

export function createDesktopDriver(ports: DriverPorts): BuildDriver {
  return bindDriver(desktopProfile, ports);
}
