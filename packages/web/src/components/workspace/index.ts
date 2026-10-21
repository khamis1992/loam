export { WorkspacePanel } from './WorkspacePanel';
export type { WorkspaceFile, WorkspaceEditorProps, WorkspaceEditorDef, WorkspaceKind } from './types';

// Editors register via side-effect imports; the shell session owns this file.
import './video/register';
import './doc/register';
import './sheet/register';
import './slides/register';
