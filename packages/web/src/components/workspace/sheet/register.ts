import { registerEditor } from '../registry';
import type { WorkspaceEditorDef } from '../types';

const def: WorkspaceEditorDef = {
  kind: 'sheet',
  label: 'Spreadsheet',
  extensions: ['.xlsx'],
  load: () => import('./Editor'),
};

registerEditor(def);
export {};
