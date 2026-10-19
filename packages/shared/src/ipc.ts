/**
 * Desktop IPC contract per BUILD_SPEC §6.9 and §8.3.
 * Provides channel constants, namespace labels, and zod schemas for every
 * method in the MVP subset. The main process validates payloads against these
 * schemas and rejects unknown namespaces/methods.
 */

import { z } from 'zod';

export const IPC_INVOKE = 'desktop-ipc-api';
export const IPC_EVENT_PREFIX = 'desktop-ipc-event';
export const IPC_SYNC_INFO = 'desktop-sync-info';

export type ApiNamespace =
  | 'auth'
  | 'window'
  | 'system'
  | 'updater'
  | 'theme'
  | 'desktopOperator'
  | 'terminal'
  | 'desktopActivityIndicator'
  | 'keepAwake'
  | 'shortcut'
  | 'env'
  | 'diagnosticLogs'
  | 'appearance';

export type EventNamespace = ApiNamespace | 'menu' | 'navigation' | 'myComputer';

/** All namespaces the preload exposes to the renderer. */
export const IPC_NAMESPACES: ApiNamespace[] = [
  'auth',
  'window',
  'system',
  'updater',
  'theme',
  'appearance',
  'desktopOperator',
  'terminal',
  'keepAwake',
  'shortcut',
  'env',
  'diagnosticLogs',
  'desktopActivityIndicator',
];

export const IPC_EVENT_NAMESPACES: EventNamespace[] = [
  'auth',
  'window',
  'system',
  'updater',
  'theme',
  'desktopOperator',
  'terminal',
  'desktopActivityIndicator',
  'keepAwake',
  'shortcut',
  'menu',
  'navigation',
  'myComputer',
];

export const ipcApiSchema = {
  auth: {
    setToken: z.tuple([z.string()]),
    removeToken: z.tuple([]),
    notifyLoginSuccess: z.tuple([]),
  },
  window: {
    minimize: z.tuple([]),
    maximize: z.tuple([]),
    close: z.tuple([]),
    isMaximized: z.tuple([]),
    toggleFullscreen: z.tuple([]),
    isFullscreen: z.tuple([]),
    openTaskInNewWindow: z.tuple([z.object({ sessionId: z.string() })]),
  },
  system: {
    openExternal: z.tuple([z.string().url()]),
    showFolderDialog: z.tuple([
      z.object({ defaultPath: z.string().optional() }).optional(),
    ]),
    notifyNetworkOnline: z.tuple([]),
    notifyNetworkOffline: z.tuple([]),
    getSystemLocale: z.tuple([]),
    getHomeDirectory: z.tuple([]),
  },
  updater: {
    getStatus: z.tuple([]),
    checkForUpdates: z.tuple([]),
    restartNow: z.tuple([]),
    getVersion: z.tuple([]),
    getPolicyContext: z.tuple([]),
  },
  theme: {
    broadcastConfig: z.tuple([
      z.object({ theme: z.enum(['light', 'dark', 'system']) }),
    ]),
  },
  appearance: {
    broadcastConfig: z.tuple([
      z.object({ density: z.enum(['standard', 'compact']).optional(), fontScale: z.number().optional() }).passthrough(),
    ]),
  },
  desktopOperator: {
    listWorkspaceDirectory: z.tuple([z.object({ path: z.string() })]),
    searchWorkspaceFiles: z.tuple([
      z.object({ root: z.string(), query: z.string() }),
    ]),
    watchWorkspaceFiles: z.tuple([z.object({ path: z.string() })]),
    unwatchWorkspaceFiles: z.tuple([z.object({ path: z.string() })]),
    respondFolderAccess: z.tuple([
      z.object({
        requestId: z.string(),
        decision: z.enum(['deny', 'once', 'always']),
      }),
    ]),
  },
  terminal: {
    create: z.tuple([z.object({ cwd: z.string() })]),
    write: z.tuple([z.string(), z.string()]),
    resize: z.tuple([z.string(), z.number(), z.number()]),
    close: z.tuple([z.string()]),
  },
  desktopActivityIndicator: {
    getState: z.tuple([]),
    rendererReady: z.tuple([]),
    setEnabled: z.tuple([z.boolean()]),
    setExpanded: z.tuple([z.boolean()]),
    updateSnapshot: z.tuple([z.record(z.unknown())]),
    notifyTask: z.tuple([z.record(z.unknown())]),
    openMainWindow: z.tuple([]),
  },
  keepAwake: {
    getState: z.tuple([]),
    setEnabled: z.tuple([z.boolean()]),
  },
  shortcut: {
    getConfig: z.tuple([]),
    getCapabilities: z.tuple([]),
    setEnabled: z.tuple([z.boolean()]),
  },
  env: {
    setOverrideAndRelaunch: z.tuple([
      z.record(z.string()).optional(),
    ]),
  },
  diagnosticLogs: {
    collect: z.tuple([]),
  },
} as const;

export type IpcApiSchema = typeof ipcApiSchema;

/** Helper to validate a payload for a known namespace/method. */
export function validateIpcPayload(
  ns: keyof IpcApiSchema,
  method: string,
  args: unknown[],
): unknown[] {
  const nsGroup = (ipcApiSchema as any)[ns];
  if (!nsGroup) throw new Error(`Unknown IPC namespace ${String(ns)}`);
  const schema = nsGroup[method] as z.ZodTypeAny | undefined;
  if (!schema) throw new Error(`Unknown IPC method ${String(ns)}.${method}`);
  return schema.parse(args) as unknown[];
}

export const ipcEventSchemas = {
  auth: {
    onLoginSuccess: z.object({}).passthrough(),
    onLoginError: z.object({ error: z.string() }).passthrough(),
  },
  window: {
    onZoomChanged: z.object({ zoom: z.number() }).passthrough(),
    onFullscreenChanged: z.object({ fullscreen: z.boolean() }).passthrough(),
  },
  system: {
    onAppActivated: z.object({}).passthrough(),
    onLocalFileChanged: z.object({ path: z.string() }).passthrough(),
  },
  theme: {
    onConfigUpdated: z.object({ theme: z.string() }).passthrough(),
  },
  updater: {
    onStatusChanged: z.object({ state: z.string() }).passthrough(),
    onPolicyTestChanged: z.object({}).passthrough(),
  },
  desktopOperator: {
    onWorkspaceFilesChanged: z.object({ path: z.string() }).passthrough(),
  },
  terminal: {
    onEvent: z.object({
      id: z.string(),
      kind: z.enum(['data', 'exit']),
      data: z.string().optional(),
      code: z.number().optional(),
    }),
  },
  desktopActivityIndicator: {
    onStateChanged: z.object({}).passthrough(),
    onStopTaskRequested: z.object({ sessionId: z.string() }).passthrough(),
    onMarkTaskReadRequested: z.object({ sessionId: z.string() }).passthrough(),
  },
  keepAwake: {
    onStateChanged: z.object({ enabled: z.boolean() }).passthrough(),
  },
  shortcut: {
    onConfigChanged: z.object({}).passthrough(),
    onTriggered: z.object({ id: z.string() }).passthrough(),
    onWindowCommand: z.object({ command: z.string() }).passthrough(),
  },
  menu: {
    onSettingsRequested: z.object({}).passthrough(),
    onCheckForUpdates: z.object({}).passthrough(),
    onNewTask: z.object({}).passthrough(),
    onNewProject: z.object({}).passthrough(),
  },
  navigation: {
    onAppDeepLink: z.object({ url: z.string() }).passthrough(),
    onNavigateToSession: z.object({ sessionId: z.string() }).passthrough(),
  },
  myComputer: {
    onLifecycleChanged: z.object({}).passthrough(),
  },
};

export type IpcEventSchemas = typeof ipcEventSchemas;
