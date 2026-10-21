import { registerEditor } from '../registry';

registerEditor({
  kind: 'video',
  label: 'Video',
  extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'],
  load: () => import('./Editor'),
});