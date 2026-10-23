'use client';

// Importing this module registers every available workspace editor.
// Each editor session owns workspace/<kind>/register.ts; a missing or
// broken register module must never break the workspace shell, so every
// import is guarded. Registrations are notified via subscribeWorkspaceEditors.
void import('./video/register').catch(() => undefined);
void import('./loamVideo/register').catch(() => undefined);
void import('./doc/register').catch(() => undefined);
void import('./sheet/register').catch(() => undefined);
void import('./slides/register').catch(() => undefined);
void import('./craft/register').catch(() => undefined);

export * from './types';
export {
  registerEditor,
  getEditorForFile,
  getEditorForKind,
  getEditorForPath,
  listEditors,
  extensionOf,
  subscribeWorkspaceEditors,
  workspaceEditorsVersion,
} from './registry';
export {
  decideWorkspaceOpen,
  decideUserMessageOpen,
  latestWorkspaceDecision,
  isWorkspaceToolName,
  isVideoStudioTool,
  hasVideoEditIntent,
  type WorkspaceOpenTarget,
} from './autoOpen';
export { WorkspacePanel, WorkspaceFilePanel } from './WorkspacePanel';
