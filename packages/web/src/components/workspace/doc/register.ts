import { registerEditor } from '../registry';

registerEditor({
  kind: 'doc',
  label: 'Document',
  extensions: ['docx', 'doc'],
  load: () => import('./Editor'),
});
