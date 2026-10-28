'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector, setLocale } from '@/store';
import { t, setLocale as setDocumentLocale } from '@/i18n/t';
import { Row, Section } from './SettingsDialog';
import { UpdaterSettings } from '@/components/update/UpdaterSettings';
import { getApiBase, getApiHeaders } from '@/services/rpc';

const NOTIFICATIONS_KEY = 'agent-studio:browser-notifications';
const SOUND_KEY = 'agent-studio:sound-alert';
const UPDATES_KEY = 'agent-studio:product-updates';

function readStoredBool(key: string): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(key) === 'true';
}

function writeStoredBool(key: string, value: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {}
}

export function GeneralPane() {
  const locale = useAppSelector((s) => s.ui.locale);
  const dispatch = useAppDispatch();

  const handleLocale = (value: 'en' | 'ar') => {
    dispatch(setLocale(value));
    setDocumentLocale(value);
  };

  return (
    <div className="space-y-2">
      <Section title={t('Language')}>
        <Row label={t('Language')} description={t('Choose the language used in the interface.')}>
          <select
            value={locale}
            onChange={(e) => handleLocale(e.target.value as 'en' | 'ar')}
            className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary"
          >
            <option value="en">{t('English')}</option>
            <option value="ar">{t('Arabic')}</option>
          </select>
        </Row>
      </Section>

      <IdentitySection />

      <Section title={t('Chat preferences')}>
        <Row label={t('Default action while a task is running')} description={t('How new messages are delivered.')}>
          <select className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary" defaultValue="send-without-interrupting">
            <option value="send-without-interrupting">{t('Send without interrupting')}</option>
            <option value="queued">{t('Queued')}</option>
            <option value="interrupting">{t('Interrupting')}</option>
          </select>
        </Row>
      </Section>

      <Section title={t('Communication preferences')}>
        <Row label={t('Browser notifications')}>
          <PersistedSwitch storageKey={NOTIFICATIONS_KEY} requestNotification />
        </Row>
        <Row label={t('Sound alert')}>
          <PersistedSwitch storageKey={SOUND_KEY} />
        </Row>
        <Row label={t('Receive product updates')}>
          <PersistedSwitch storageKey={UPDATES_KEY} />
        </Row>
      </Section>

      <UpdaterSettings />
    </div>
  );
}

function PersistedSwitch({ storageKey, requestNotification }: { storageKey: string; requestNotification?: boolean }) {
  const [on, setOn] = useState(() => readStoredBool(storageKey));

  useEffect(() => {
    setOn(readStoredBool(storageKey));
  }, [storageKey]);

  const toggle = useCallback(async () => {
    const next = !on;
    if (requestNotification && next && typeof window !== 'undefined' && 'Notification' in window) {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setOn(false);
        writeStoredBool(storageKey, false);
        return;
      }
    }
    setOn(next);
    writeStoredBool(storageKey, next);
  }, [on, requestNotification, storageKey]);

  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={toggle}
      className="relative h-5 w-9 rounded-full transition-colors"
      style={{ backgroundColor: on ? 'var(--icon-blue)' : 'var(--fill-tsp-white-dark)' }}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform"
        style={{ transform: on ? 'translateX(18px)' : 'translateX(2px)' }}
      />
    </button>
  );
}

const IDENTITY_ROLES = ['admin', 'partner', 'senior', 'associate', 'paralegal', 'reviewer', 'client'] as const;

/** د2: الهوية في المستندات — the acting name/role for office intelligence,
 *  track changes and audits. Stored through POST /api/settings. */
function IdentitySection() {
  const [name, setName] = useState('');
  const [role, setRole] = useState<(typeof IDENTITY_ROLES)[number]>('admin');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const response = await fetch(`${getApiBase()}/api/settings`, { headers: await getApiHeaders() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { officeIdentity?: { name?: string; role?: string } };
      setName(body.officeIdentity?.name ?? '');
      setRole((IDENTITY_ROLES as readonly string[]).includes(body.officeIdentity?.role ?? '') ? (body.officeIdentity!.role as (typeof IDENTITY_ROLES)[number]) : 'admin');
      setState('ready');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setState('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    setState('saving');
    setError(null);
    try {
      const response = await fetch(`${getApiBase()}/api/settings`, {
        method: 'POST',
        headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ officeIdentity: name.trim() ? { name: name.trim(), role } : null }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setState('saved');
      setTimeout(() => setState('ready'), 1500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setState('error');
    }
  }, [name, role]);

  return (
    <Section title={t('Document identity')}>
      <Row label={t('Document identity')} description={t('The name signed on tracked changes and office intelligence runs.')}>
        <div className="flex items-center gap-2">
          <input
            aria-label={t('Document identity name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="مثال: خالد الجابر"
            className="h-row-sm w-40 rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary"
          />
          <select
            aria-label={t('Document identity role')}
            value={role}
            onChange={(event) => setRole(event.target.value as (typeof IDENTITY_ROLES)[number])}
            className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary"
          >
            {IDENTITY_ROLES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <button type="button" onClick={() => void save()} disabled={state === 'saving' || state === 'loading'} className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary disabled:opacity-50">
            {state === 'saving' ? '…' : state === 'saved' ? t('Saved') : t('Save')}
          </button>
        </div>
      </Row>
      {error ? <p role="alert" className="text-sm text-func-error">{error}</p> : null}
    </Section>
  );
}
