import type { BuildDriver, DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { bindDriver } from '../bindDriver.js';
import { automationProfile } from './profile.js';

export function createAutomationsDriver(ports: DriverPorts): BuildDriver {
  return bindDriver(automationProfile, ports);
}
