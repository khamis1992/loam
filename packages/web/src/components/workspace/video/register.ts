import { registerEditor } from '../registry';

registerEditor({
  kind: 'video',
  label: 'Video',
  extensions: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi'],
  load: () => import('./Editor'),
});