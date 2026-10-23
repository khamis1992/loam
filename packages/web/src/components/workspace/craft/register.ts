import { registerEditor } from '../registry';

/**
 * The `craft` workspace editor (cr-03): one registration covers every file type
 * the Loam Craft apps own, so the Workspace panel can open each of them in its
 * matching app. The built-in doc/sheet/slides editors stay registered as the
 * fallback CraftPanel uses when a dist is missing or the bridge never becomes ready.
 *
 * The list is the union of the app format families documented in `.cr-ref/CRAFT_PLAN.md`:
 * docs (docx/docm/dotx/doc/odt/rtf), sheets (xlsx/xlsm/xls/csv/ods), slides (pptx/ppt/odp),
 * photo (psd/png/jpg/jpeg/webp/tif/tiff/heic/avif/bmp/gif) and design (idml/indd/pdf).
 */
registerEditor({
  kind: 'craft',
  label: 'Loam Craft',
  extensions: [
    // Loam Docs
    '.docx', 'docx', '.docm', 'docm', '.dotx', 'dotx', '.doc', 'doc', '.odt', 'odt', '.rtf', 'rtf',
    // Loam Sheets
    '.xlsx', 'xlsx', '.xlsm', 'xlsm', '.xls', 'xls', '.csv', 'csv', '.ods', 'ods',
    // Loam Slides
    '.pptx', 'pptx', '.ppt', 'ppt', '.odp', 'odp',
    // Loam Photo
    '.psd', 'psd', '.png', 'png', '.jpg', 'jpg', '.jpeg', 'jpeg', '.webp', 'webp',
    '.tif', 'tif', '.tiff', 'tiff', '.heic', 'heic', '.avif', 'avif', '.bmp', 'bmp', '.gif', 'gif',
    // Loam Design
    '.idml', 'idml', '.indd', 'indd', '.pdf', 'pdf',
  ],
  load: () => import('./Editor'),
});
