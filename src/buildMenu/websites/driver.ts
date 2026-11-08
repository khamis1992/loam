import type { BuildDriver, DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { bindDriver } from '../bindDriver.js';
import { websiteProfile } from './profile.js';

export function createWebsitesDriver(ports: DriverPorts): BuildDriver {
  return bindDriver(websiteProfile, ports);
}
