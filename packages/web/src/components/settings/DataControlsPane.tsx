'use client';

import { useCallback, useEffect, useState } from 'react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Row, Section } from './SettingsDialog';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

/**
 * Settings > Data controls (UNIMPLEMENTED_OPTIONS #6).
 *
 * Three user-controlled data surfaces backed by the Loam server:
 *  - GET  /api/data/export        → download a full JSON copy of user data
 *  - POST /api/data/delete-all    → wipe every user record, guarded by the
 *                                   exact typed confirmation "DELETE"
 *  - POST /api/settings           → persist the training opt-out flag
 *
 * The export is fetched as a blob (so the local auth header still applies) and
 * handed to the browser via an object URL, which keeps the server's
 * content-disposition download semantics.
 */

type Notice = { kind: 'ok' | 'error'; text: string } | null;

export function DataControlsPane() {
  const [settings, setSettings] = useState<{ trainingOptOut?: boolean; codemode?: boolean } | null>(null);
  const [savingTraining, setSavingTraining] = useState(false);
  const [savingCodemode, setSavingCodemode] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/settings`, { headers: await getApiHeaders() });
      if (!res.ok) return;
      const data = (await res.json()) as { trainingOptOut?: boolean; codemode?: boolean };
      setSettings({ trainingOptOut: data.trainingOptOut === true, codemode: data.codemode === true });
    } catch {
      /* leave the stored preference unknown on failure */
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const exportAll = async () => {
    setExporting(true);
    setNotice(null);
    try {
      const res = await fetch(`${getApiBase()}/api/data/export`, { headers: await getApiHeaders() });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'loam-data-export.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice({ kind: 'ok', text: t('Export started') });
    } catch {
      setNotice({ kind: 'error', text: t('Could not export your data') });
    } finally {
      setExporting(false);
    }
  };

  const toggleTraining = async () => {
    const next = !(settings?.trainingOptOut === true);
    setSavingTraining(true);
    setNotice(null);
    try {
      const res = await fetch(`${getApiBase()}/api/settings`, {
        method: 'POST',
        headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ trainingOptOut: next }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setSettings({ trainingOptOut: next });
    } catch {
      setNotice({ kind: 'error', text: t('Could not save your preference') });
    } finally {
      setSavingTraining(false);
    }
  };

  const toggleCodemode = async () => {
    const next = !(settings?.codemode === true);
    setSavingCodemode(true);
    setNotice(null);
    try {
      const res = await fetch(`${getApiBase()}/api/settings`, {
        method: 'POST',
        headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ codemode: next }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setSettings((prev) => ({ trainingOptOut: prev?.trainingOptOut === true, codemode: next }));
      setNotice({ kind: 'ok', text: next ? t('Codemode enabled') : t('Codemode disabled') });
    } catch {
      setNotice({ kind: 'error', text: t('Could not save your preference') });
    } finally {
      setSavingCodemode(false);
    }
  };

  const deleteAll = async () => {
    setDeleting(true);
    setNotice(null);
    try {
      const res = await fetch(`${getApiBase()}/api/data/delete-all`, {
        method: 'POST',
        headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setConfirmOpen(false);
      setConfirmText('');
      setNotice({ kind: 'ok', text: t('Your data was deleted.') });
    } catch {
      setNotice({ kind: 'error', text: t('Could not delete your data') });
    } finally {
      setDeleting(false);
    }
  };

  const closeConfirm = () => {
    setConfirmOpen(false);
    setConfirmText('');
  };

  const trainingOptOut = settings?.trainingOptOut === true;
  const codemodeOn = settings?.codemode === true;

  return (
    <div className="space-y-2">
      <Section title={t('Export your data')}>
        <Row label={t('Export all data')} description={t('Download a full copy of your tasks, projects, agents and memory.')}>
          <Button variant="secondary" size="sm" loading={exporting} onClick={() => void exportAll()}>
            {t('Export all data')}
          </Button>
        </Row>
      </Section>

      <Section title={t('Delete your data')}>
        <Row label={t('Delete all data')} description={t('Permanently remove all tasks, projects, agents and memory from this device.')}>
          <Button variant="danger" size="sm" onClick={() => setConfirmOpen(true)}>
            {t('Delete all data')}
          </Button>
        </Row>
      </Section>

      <Section title={t('Training')}>
        <Row label={t('Help improve Loam')} description={t('Allow Loam to use my conversations to improve its models.')}>
          <button
            type="button"
            role="switch"
            aria-checked={trainingOptOut}
            disabled={savingTraining || settings === null}
            onClick={() => void toggleTraining()}
            className="relative h-5 w-9 rounded-full transition-colors disabled:opacity-50"
            style={{ backgroundColor: trainingOptOut ? 'var(--icon-blue)' : 'var(--fill-tsp-white-dark)' }}
          >
            <span
              className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform"
              style={{ transform: trainingOptOut ? 'translateX(18px)' : 'translateX(2px)' }}
            />
          </button>
        </Row>
      </Section>

      <Section title={t('Tools')}>
        <Row
          label={t('Codemode sandbox')}
          description={t(
            'Allow the agent to run a short JavaScript program in an isolated sandbox that calls this session\u2019s tools and returns a summary. Off by default.',
          )}
        >
          <button
            type="button"
            role="switch"
            aria-checked={codemodeOn}
            disabled={savingCodemode || settings === null}
            onClick={() => void toggleCodemode()}
            className="relative h-5 w-9 rounded-full transition-colors disabled:opacity-50"
            style={{ backgroundColor: codemodeOn ? 'var(--icon-blue)' : 'var(--fill-tsp-white-dark)' }}
          >
            <span
              className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform"
              style={{ transform: codemodeOn ? 'translateX(18px)' : 'translateX(2px)' }}
            />
          </button>
        </Row>
      </Section>

      {notice && (
        <p className={notice.kind === 'ok' ? 'text-sm text-function-success' : 'text-sm text-function-error'}>{notice.text}</p>
      )}

      <Dialog open={confirmOpen} onClose={closeConfirm} title={t('Delete all data?')}>
        <p className="mb-3 text-sm text-text-secondary">
          {t('This permanently deletes all tasks, projects, agents and memory. This cannot be undone.')}
        </p>
        <label htmlFor="delete-all-confirm" className="mb-1 block text-sm font-medium text-text-primary">
          {t('Type DELETE to confirm.')}
        </label>
        <input
          id="delete-all-confirm"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="h-8 w-full rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={closeConfirm}>
            {t('Cancel')}
          </Button>
          <Button variant="danger" size="sm" disabled={confirmText !== 'DELETE' || deleting} onClick={() => void deleteAll()}>
            {t('Delete')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
