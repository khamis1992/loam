import { registerEditor } from '../registry';

registerEditor({
  kind: 'electron-window',
  label: 'Desktop app',
  extensions: ['desktop.json'],
  load: () => import('./Editor'),
});
