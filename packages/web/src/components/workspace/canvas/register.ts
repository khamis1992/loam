import { registerEditor } from '../registry';

registerEditor({
  kind: 'canvas',
  label: 'Canvas',
  // The canvas is not tied to a file extension: it renders the whole run graph.
  extensions: [],
  load: () => import('./Editor'),
});
