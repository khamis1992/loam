import { registerEditor } from '../registry';

registerEditor({
  kind: 'sheet',
  label: 'Spreadsheet',
  extensions: ['xlsx', 'xls', 'csv'],
  load: () => import('./Editor'),
});