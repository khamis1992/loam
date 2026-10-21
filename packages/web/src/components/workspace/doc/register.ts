import { registerEditor } from '../registry';

registerEditor({
  kind: 'doc',
  label: 'Document',
  extensions: ['.docx'],
  load: () => import('./Editor'),
});
