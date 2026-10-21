import { registerEditor } from '../registry';
import type { WorkspaceEditorDef } from '../types';

registerEditor({
  kind: 'sheet',
  label: 'Spreadsheet',
  extensions: ['xlsx', 'xls', 'csv'],
  load: () => import('./Editor'),
});

const def: WorkspaceEditorDef = {
  kind: 'sheet',
  label: 'Spreadsheet',
  extensions: ['.xlsx', 'xls', 'csv'],
  load: () => import('./Editor'),
};

registerEditor(def);
export {};