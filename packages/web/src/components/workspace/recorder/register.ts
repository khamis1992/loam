import { registerEditor } from '../registry';

registerEditor({
  kind: 'loam-recorder',
  label: 'Loam Recorder',
  extensions: ['loamrec'],
  load: () => import('./Panel'),
});
