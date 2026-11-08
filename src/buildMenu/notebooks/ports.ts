import type { DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { createKindPorts, type KindDeps } from '../kindRuntime.js';
import { notebookProfile } from './profile.js';

export function createNotebooksPorts(deps: KindDeps): DriverPorts {
  return createKindPorts(notebookProfile, deps);
}
