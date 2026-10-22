import { useState } from 'react';
import { t } from '@/i18n/t';
import { Row, Section } from './SettingsDialog';
import { Button } from '@/components/ui/Button';

export function MyComputerPane() {
  const [folders, setFolders] = useState<{ id: string; path: string }[]>([
    { id: '1', path: '~/Documents/reports' },
    { id: '2', path: '~/code/site' },
  ]);

  const addFolder = () => {
    const next = `~/newfolder-${folders.length + 1}`;
    setFolders([...folders, { id: String(Date.now()), path: next }]);
  };

  const removeFolder = (id: string) => setFolders(folders.filter((f) => f.id !== id));

  return (
    <div className="space-y-2">
      <Section title={t('My Computer')}>
        <p className="mb-3 text-sm text-text-secondary">{t('Add folders for quick access when starting tasks on this computer.')}</p>
        {folders.length === 0 ? (
          <div className="rounded-card border border-dashed border-border-main p-6 text-center text-sm text-text-tertiary">
            {t('No content')}
          </div>
        ) : (
          <ul className="mb-3 divide-y divide-border-main rounded-card border border-border-main bg-bg-menu">
            {folders.map((f) => (
              <li key={f.id} className="flex items-center justify-between px-3 py-2.5">
                <div className="flex items-center gap-2 text-sm text-text-primary">
                  <span aria-hidden>📁</span> {f.path}
                </div>
                <Button variant="ghost" size="sm" onClick={() => removeFolder(f.id)}>{t('Remove folder')}</Button>
              </li>
            ))}
          </ul>
        )}
        <Button variant="secondary" size="sm" onClick={addFolder}>{t('Add folder')}</Button>
      </Section>
    </div>
  );
}
