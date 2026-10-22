import { registerEditor } from '../registry';

registerEditor({
  kind: 'loam-video',
  label: 'Loam Video',
  extensions: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi'],
  load: () => import('./Editor'),
});
