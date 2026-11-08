'use client';

import { useEffect, useState } from 'react';
import { getLocale, isRtl, t } from '@/i18n/t';
import { legalApi, type LegalStatus } from '@/services/legalApi';

export function LegalOperations({ status }: { status: LegalStatus | null }) {
  const [files, setFiles] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = async () => {
    try { const result = await legalApi.listBackups(); setFiles(result.files); setFileName((current) => current || result.files[0] || ''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { void refresh(); }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null); setPassphrase('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  return (
    <details className="rounded-md border p-3" dir={isRtl(getLocale()) ? 'rtl' : 'ltr'}>
      <summary className="cursor-pointer font-semibold">{t('Backup, recovery and retention')}</summary>
      <div className="mt-3 space-y-3">
        {status?.identity && <p className="text-xs opacity-75">{t('Identity')}: <bdi>{status.identity.id}</bdi> · {status.identity.roles.join(', ')} · {status.identity.authMethod === 'local' ? t('Local desktop attestation') : t('Signed enterprise identity')}</p>}
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void run(async () => { const result = await legalApi.createBackup(passphrase); setNotice(t('Encrypted backup created: {name}', { name: result.fileName })); await refresh(); }); }}>
          <label className="grid min-w-0 flex-1 gap-1">{t('Backup recovery passphrase')}<input required minLength={12} type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className="rounded border px-2 py-1" /></label>
          <button type="submit" disabled={busy || passphrase.length < 12} className="rounded border px-3 py-1 disabled:opacity-50">{t('Create encrypted backup')}</button>
        </form>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void run(async () => { const result = await legalApi.restoreBackup(fileName, passphrase); setNotice(t('Restored to a new isolated directory: {path}', { path: result.directory })); }); }}>
          <label className="grid gap-1">{t('Backup to restore')}<select required value={fileName} onChange={(event) => setFileName(event.target.value)} className="max-w-xs rounded border px-2 py-1" dir="ltr">{files.map((file) => <option key={file} value={file}>{file}</option>)}</select></label>
          <label className="grid min-w-0 flex-1 gap-1">{t('Restore passphrase')}<input required minLength={12} type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className="rounded border px-2 py-1" /></label>
          <button type="submit" disabled={busy || !fileName || passphrase.length < 12} className="rounded border px-3 py-1 disabled:opacity-50">{t('Restore to new directory')}</button>
        </form>
        <p className="text-xs opacity-75">{t('Restore never replaces the live matter database. Verify the restored databases before using them.')}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void run(async () => { const result = await legalApi.createAuditAnchor(); setNotice(t('Signed audit anchor created: {name}', { name: result.fileName })); })} className="rounded border px-3 py-1">{t('Export signed audit anchor')}</button>
          <button type="button" disabled={busy} onClick={() => { if (window.confirm(t('Purge every matter whose retention deadline has passed? This cannot be undone.'))) void run(async () => { const result = await legalApi.purgeExpired(); setNotice(t('Purged {n} expired matters', { n: result.purged.length })); }); }} className="rounded border border-red-700 px-3 py-1">{t('Purge expired matters')}</button>
        </div>
        {notice && <p role="status" className="break-words text-emerald-700 dark:text-emerald-300">{notice}</p>}
        {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
      </div>
    </details>
  );
}
