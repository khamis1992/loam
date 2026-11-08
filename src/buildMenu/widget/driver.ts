import type { BuildDriver, DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { bindDriver } from '../bindDriver.js';
import { widgetProfile } from './profile.js';

export function createWidgetDriver(ports: DriverPorts): BuildDriver {
  return bindDriver(widgetProfile, ports);
}
