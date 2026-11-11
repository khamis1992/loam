'use client';

// Importing this module registers every available workspace editor.
// Each editor session owns workspace/<kind>/register.ts; a missing or
// broken register module must never break the workspace shell, so every
// import is guarded. Registrations are notified via subscribeWorkspaceEditors.
void import('./video/register').catch(() => undefined);
void import('./loamVideo/register').catch(() => undefined);
void import('./recorder/register').catch(() => undefined);
void import('./desktop/register').catch(() => undefined);
void import('./doc/register').catch(() => undefined);
void import('./sheet/register').catch(() => undefined);
void import('./slides/register').catch(() => undefined);
void import('./craft/register').catch(() => undefined);
void import('./canvas/register').catch(() => undefined);
// Registered synchronously: the web editor is the common case for a built
// page, and a lazy registration loses the race against the workspace tests
// (and the first render) often enough to look like the file never opened.
import './web/register';

export * from './types';
export {
  registerEditor,
  getEditorForFile,
  getEditorForKind,
  getEditorForPath,
  listEditors,
  listEditorsForPath,
  getEditorOverride,
  setEditorOverride,
  EDITOR_OVERRIDE_PREFIX,
  extensionOf,
  subscribeWorkspaceEditors,
  workspaceEditorsVersion,
} from './registry';
export { EditorFallbackCard, EditorOverrideMenu, editorLabel } from './gateway';
export type { GatewayFile } from './gateway';
export {
  decideWorkspaceOpen,
  mergeWorkspaceTarget,
  decideUserMessageOpen,
  latestWorkspaceDecision,
  isWorkspaceToolName,
  isVideoStudioTool,
  isRecorderTool,
  isCanvasSignalTool,
  hasVideoEditIntent,
  type WorkspaceOpenTarget,
} from './autoOpen';
export { WorkspacePanel, WorkspaceFilePanel } from './WorkspacePanel';
