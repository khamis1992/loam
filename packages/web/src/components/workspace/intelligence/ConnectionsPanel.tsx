'use client';

import { useEffect, useState } from 'react';
import { Cable, ChevronDown, ChevronUp, Database, Globe } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { WorkspaceFile } from '../types';
import {
  createOfficeConnector,
  deleteOfficeConnector,
  listOfficeConnectors,
  syncOfficeConnectorToSheet,
  testOfficeConnector,
  type ConnectorRows,
  type ConnectorType,
  type OfficeConnector,
} from './officeConnectorsApi';

const TYPE_LABEL: Record<ConnectorType, string> = {
  'rest-json': 'REST / JSON',
  sqlite: 'SQLite',
  webdav: 'WebDAV',
};

interface TestState {
  rows: ConnectorRows | null;
  error: string | null;
}

/**
 * "الاتصالات ومصادر البيانات": register data connectors, test them, and sync
 * their rows into a target .xlsx sheet of the current task. Field names mirror
 * the server contract in src/server/routes/officeConnectors.ts exactly.
 */
export default function ConnectionsPanel({ file, onSynced }: { file: WorkspaceFile; onSynced?: () => void }) {
  const [open, setOpen] = useState(false);
  const [connectors, setConnectors] = useState<OfficeConnector[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [syncedPath, setSyncedPath] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [type, setType] = useState<ConnectorType>('rest-json');
  const [url, setUrl] = useState('');
  const [dataPath, setDataPath] = useState('');
  const [bearerSecretName, setBearerSecretName] = useState('');
  const [databasePath, setDatabasePath] = useState('');
  const [query, setQuery] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [passwordSecretName, setPasswordSecretName] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [davFormat, setDavFormat] = useState<'csv' | 'json'>('csv');
  const [targetPath, setTargetPath] = useState('data/connectors.xlsx');

  useEffect(() => {
    if (!open) return;
    void listOfficeConnectors().then(setConnectors).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [open]);

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key); setError(null);
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); }
  };

  const config = type === 'rest-json'
    ? {
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(dataPath.trim() ? { dataPath: dataPath.trim() } : {}),
        ...(bearerSecretName.trim() ? { bearerSecretName: bearerSecretName.trim() } : {}),
      }
    : type === 'webdav'
      ? {
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(username.trim() ? { username: username.trim() } : {}),
          ...(passwordSecretName.trim() ? { passwordSecretName: passwordSecretName.trim() } : {}),
          ...(remotePath.trim() ? { remotePath: remotePath.trim() } : {}),
          format: davFormat,
        }
      : {
          ...(databasePath.trim() ? { databasePath: databasePath.trim() } : {}),
          ...(query.trim() ? { query: query.trim() } : {}),
        };

  const create = () => run('create', async () => {
    const connector = await createOfficeConnector({ name: name.trim(), type, config });
    setConnectors((items) => [connector, ...items]);
    setName(''); setUrl(''); setDataPath(''); setBearerSecretName(''); setDatabasePath(''); setQuery('');
    setBaseUrl(''); setUsername(''); setPasswordSecretName(''); setRemotePath('');
  });

  const test = (connector: OfficeConnector) => run(`test:${connector.id}`, async () => {
    try {
      const rows = await testOfficeConnector(connector.id, file.taskId);
      setTests((current) => ({ ...current, [connector.id]: { rows, error: null } }));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setTests((current) => ({ ...current, [connector.id]: { rows: null, error: message } }));
      throw reason;
    }
  });

  const sync = (connector: OfficeConnector) => run(`sync:${connector.id}`, async () => {
    if (!targetPath.trim().toLowerCase().endsWith('.xlsx')) throw new Error('أدخل مسار ورقة هدف صحيحًا ينتهي بـ .xlsx');
    const artifact = await syncOfficeConnectorToSheet(connector.id, file.taskId, targetPath.trim());
    setSyncedPath(artifact.path);
    onSynced?.();
  });

  const remove = (connector: OfficeConnector) => run(`delete:${connector.id}`, async () => {
    if (!window.confirm(`حذف الاتصال "${connector.name}"؟`)) return;
    await deleteOfficeConnector(connector.id);
    setConnectors((items) => items.filter((item) => item.id !== connector.id));
  });

  return (
    <section className="border-t border-border-main bg-bg-menu text-text-primary" aria-label="الاتصالات ومصادر البيانات">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-sm hover:bg-fill-hover" aria-expanded={open}>
        <Cable className="size-4 text-brand" aria-hidden />
        <span className="font-medium">الاتصالات ومصادر البيانات</span>
        <span className="flex-1" />
        {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
      </button>
      {open ? <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto border-t border-border-light px-3 py-3">
        {error ? <p role="alert" className="text-sm text-func-error">{error}</p> : null}

        <div className="flex flex-col gap-2 rounded-card border border-border-light bg-bg-main p-3">
          <p className="text-sm font-medium">اتصال جديد</p>
          <div className="flex flex-wrap gap-2">
            <input aria-label="اسم الاتصال" value={name} onChange={(event) => setName(event.target.value)} placeholder="اسم الاتصال" className="min-w-36 flex-1 rounded-control border border-border-main bg-bg-menu px-2 py-1.5 text-sm" />
            <select aria-label="نوع الاتصال" value={type} onChange={(event) => setType(event.target.value as ConnectorType)} className="min-h-9 min-w-36 flex-1 rounded-control border border-border-main bg-bg-menu px-2 text-sm">
              <option value="rest-json">{TYPE_LABEL['rest-json']}</option>
              <option value="sqlite">{TYPE_LABEL.sqlite}</option>
              <option value="webdav">{TYPE_LABEL.webdav}</option>
            </select>
          </div>
          {type === 'rest-json' ? <div className="flex flex-col gap-2">
            <input aria-label="رابط الخدمة" dir="ltr" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/api/data" className="rounded-control border border-border-main bg-bg-menu px-2 py-1.5 text-sm" />
            <input aria-label="مسار البيانات" dir="ltr" value={dataPath} onChange={(event) => setDataPath(event.target.value)} placeholder="dataPath مثل results.items (اختياري)" className="rounded-control border border-border-main bg-bg-menu px-2 py-1.5 text-sm" />
            <input aria-label="اسم سر Bearer" dir="ltr" value={bearerSecretName} onChange={(event) => setBearerSecretName(event.target.value)} placeholder="bearerSecretName (اختياري)" className="rounded-control border border-border-main bg-bg-menu px-2 py-1.5 text-sm" />
          </div> : type === 'webdav' ? <div className="flex flex-col gap-2">
            <input aria-label="عنوان خادم WebDAV" dir="ltr" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://cloud.example.com/remote.php/dav/files/user" className="rounded-control border border-border-main bg-bg-menu px-2 py-1.5 text-sm" />
            <input aria-label="مسار الملف البعيد" dir="ltr" value={remotePath} onChange={(event) => setRemotePath(event.target.value)} placeholder="/reports/sales.csv" className="rounded-control border border-border-main bg-bg-menu px-2 py-1.5 text-sm" />
            <div className="flex flex-wrap gap-2">
              <input aria-label="اسم المستخدم" dir="ltr" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="username (اختياري)" className="min-w-32 flex-1 rounded-control border border-border-main bg-bg-menu px-2 py-1.5 text-sm" />
              <input aria-label="اسم سر كلمة المرور" dir="ltr" value={passwordSecretName} onChange={(event) => setPasswordSecretName(event.target.value)} placeholder="passwordSecretName (من الخزنة)" className="min-w-32 flex-1 rounded-control border border-border-main bg-bg-menu px-2 py-1.5 text-sm" />
              <select aria-label="صيغة الملف" value={davFormat} onChange={(event) => setDavFormat(event.target.value === 'json' ? 'json' : 'csv')} className="min-h-9 min-w-24 rounded-control border border-border-main bg-bg-menu px-2 text-sm">
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </div>
          </div> : <div className="flex flex-col gap-2">
            <input aria-label="مسار قاعدة البيانات" dir="ltr" value={databasePath} onChange={(event) => setDatabasePath(event.target.value)} placeholder="databasePath مثل data/crm.sqlite" className="rounded-control border border-border-main bg-bg-menu px-2 py-1.5 text-sm" />
            <textarea aria-label="استعلام القراءة" dir="ltr" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SELECT ... (استعلام قراءة واحد فقط)" className="min-h-16 rounded-control border border-border-main bg-bg-menu px-2 py-1.5 font-mono text-sm" />
          </div>}
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="مسار ورقة المزامنة" dir="ltr" value={targetPath} onChange={(event) => setTargetPath(event.target.value)} placeholder="مسار ملف .xlsx للمزامنة" className="min-w-44 flex-1 rounded-control border border-border-main bg-bg-menu px-2 py-1.5 font-mono text-sm" />
            <Button variant="primary" size="sm" loading={busy === 'create'} disabled={!name.trim()} onClick={create}>إضافة اتصال</Button>
          </div>
          <p className="text-xs text-text-secondary">تُزرَع نتائج «مزامنة الآن» في ورقة Data داخل ملف الهدف بصيغة .xlsx.</p>
        </div>

        {connectors.length ? <ul className="flex flex-col gap-2">
          {connectors.map((connector) => <li key={connector.id} className="flex flex-col gap-2 rounded-card border border-border-light bg-bg-main p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {connector.type === 'sqlite' ? <Database className="size-4 text-text-secondary" aria-hidden /> : <Globe className="size-4 text-text-secondary" aria-hidden />}
              <span className="font-medium">{connector.name}</span>
              <span className="rounded-full bg-fill-tsp px-2 py-0.5 text-xs text-text-secondary">{TYPE_LABEL[connector.type]}</span>
              {connector.type === 'rest-json' && connector.config.url ? <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-tertiary" dir="ltr">{connector.config.url}</span> : null}
              {connector.type === 'sqlite' && connector.config.databasePath ? <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-tertiary" dir="ltr">{connector.config.databasePath}</span> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" loading={busy === `test:${connector.id}`} onClick={() => void test(connector)}>اختبار</Button>
              <Button variant="secondary" size="sm" loading={busy === `sync:${connector.id}`} onClick={() => void sync(connector)}>مزامنة الآن</Button>
              <Button variant="ghost" size="sm" loading={busy === `delete:${connector.id}`} onClick={() => void remove(connector)}>حذف</Button>
            </div>
            {tests[connector.id]?.rows ? <p className="text-xs text-func-success" role="status">
              نجح الاختبار: {tests[connector.id]!.rows!.rowCount} صفًا × {tests[connector.id]!.rows!.columns.length} عمودًا{tests[connector.id]!.rows!.truncated ? ' (مقتطع إلى 1000 صف)' : ''}
            </p> : null}
            {tests[connector.id]?.error ? <p className="text-xs text-func-error" role="alert">فشل الاختبار: {tests[connector.id]!.error}</p> : null}
          </li>)}
        </ul> : <p className="text-xs text-text-secondary">لا توجد اتصالات مسجلة بعد.</p>}

        {syncedPath ? <p className="text-xs text-func-success" role="status">تمت المزامنة إلى: <span dir="ltr" className="font-mono">{syncedPath}</span></p> : null}
      </div> : null}
    </section>
  );
}
