import type { DriverPorts } from '../../../packages/shared/src/buildMenu.js';
import { createKindPorts, type KindDeps } from '../kindRuntime.js';
import { widgetProfile } from './profile.js';

export function createWidgetPorts(deps: KindDeps): DriverPorts {
  return createKindPorts(widgetProfile, deps);
}
