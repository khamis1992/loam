import type { BuildDriver, DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { bindDriver } from '../bindDriver.js';
import { notebookProfile } from './profile.js';

export function createNotebooksDriver(ports: DriverPorts): BuildDriver {
  return bindDriver(notebookProfile, ports);
}
