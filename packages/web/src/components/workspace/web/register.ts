import { registerEditor } from '../registry';

/**
 * The web / code workspace editor.
 *
 * A built page is the common deliverable of the Build mode, and it is not an
 * Office document or a Craft asset, so no editor claimed it before: the file
 * list showed it but the panel had nothing to open. One registration covers
 * every text format a web build produces — HTML renders as a live preview, the
 * rest as source — so the Workspace panel opens the artifact the agent just
 * wrote instead of stopping at the file name.
 */
registerEditor({
  kind: 'web',
  label: 'Web / Code',
  extensions: [
    // Markup and style
    '.html', 'html', '.htm', 'htm', '.css', 'css', '.scss', 'scss', '.sass', 'sass',
    '.less', 'less', '.svg', 'svg', '.xml', 'xml',
    // Scripts
    '.js', 'js', '.mjs', 'mjs', '.cjs', 'cjs', '.jsx', 'jsx',
    '.ts', 'ts', '.mts', 'mts', '.tsx', 'tsx',
    '.json', 'json', '.json5', 'json5', '.map', 'map',
    // Content and data
    '.md', 'md', '.markdown', 'markdown', '.txt', 'txt', '.csv', 'csv',
    '.yml', 'yml', '.yaml', 'yaml', '.toml', 'toml',
    // Server-side
    '.php', 'php', '.py', 'py', '.rb', 'rb', '.go', 'go', '.rs', 'rs',
    '.java', 'java', '.sh', 'sh', '.sql', 'sql',
  ],
  // The module exports the component by name, so adapt it to the
  // `{ default }` shape the lazy registry expects.
  load: async () => ({ default: (await import('./Editor')).Editor }),
});
