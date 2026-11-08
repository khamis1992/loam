import type { BuildAction, BuildKind } from '../../packages/shared/src/buildMenu.js';
import { KERNEL_TIMEOUT_MS } from './notebooks/messages.js';

export const WEB_READY_MS = 30_000;
export const DESKTOP_READY_MS = 60_000;
export const PACKAGE_TIMEOUT_MS = 15 * 60 * 1000;
export { KERNEL_TIMEOUT_MS };

export function previewReadyMs(kind: BuildKind): number {
  switch (kind) {
    case 'desktop':
    case 'widget':
      return DESKTOP_READY_MS;
    case 'website':
    case 'game':
    case 'notebook':
    case 'mobile':
    case 'chrome-extension':
    case 'safari-extension':
    case 'automation':
      return WEB_READY_MS;
    default: {
      const unknown: never = kind;
      return unknown;
    }
  }
}

export function jobBudget(kind: BuildKind, action: BuildAction): number {
  switch (action) {
    case 'package':
      return PACKAGE_TIMEOUT_MS;
    case 'kernel-execute':
      return KERNEL_TIMEOUT_MS;
    case 'preview':
      return previewReadyMs(kind);
    case 'generate':
      return WEB_READY_MS;
    default: {
      const unknown: never = action;
      return unknown;
    }
  }
}
