import type { DesktopApi } from './types.js';
import { initFileOrganizer } from './apps/fileOrganizer.js';
import { initHabitTracker } from './apps/habitTracker.js';
import { initMarkdownEditor } from './apps/markdownEditor.js';
import { initPasswordManager } from './apps/passwordManager.js';
import { initPhotoSorter } from './apps/photoSorter.js';

const desktop = (window as unknown as { desktop: DesktopApi }).desktop;
const metadata = await desktop.getMetadata();
if (metadata.scenario === 'file-organizer') initFileOrganizer(desktop);
else if (metadata.scenario === 'habit-tracker') initHabitTracker(desktop);
else if (metadata.scenario === 'markdown-editor') initMarkdownEditor(desktop);
else if (metadata.scenario === 'password-manager') initPasswordManager(desktop);
else if (metadata.scenario === 'photo-sorter') initPhotoSorter(desktop);
else throw new Error('Unknown desktop scenario');
