'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useAppDispatch, useAppSelector, setLocale, setSettingsTab } from '@/store';
import { t, setLocale as setDocumentLocale } from '@/i18n/t';
import { Row, Section } from './SettingsDialog';
import { UpdaterSettings } from '@/components/update/UpdaterSettings';
import { getApiBase, getApiHeaders } from '@/services/rpc';

const NOTIFICATIONS_KEY = 'agent-studio:browser-notifications';
const SOUND_KEY = 'agent-studio:sound-alert';
const UPDATES_KEY = 'agent-studio:product-updates';

// ---------------------------------------------------------------------------
// W-U4 first-run setup: three honest status checks backed by real endpoints.
//  - codegraph: GET /api/codegraph/status, the endpoint the legacy Services
//    page uses for its green/red dot (ui/app.js refreshCodegraphPanel); `ok`
//    is that documented dot semantics. The install action POSTs to
//    /api/codegraph/runtime/install — the same real endpoint the legacy
//    services page install button uses — and polls the status while the
//    server-side installer runs.
//  - sandbox: the codemode flag from GET /api/settings, the same state the
//    sandbox row in Data controls shows; the action opens that pane.
//  - STT: probes the local STT server (scripts/stt_server.py) on its
//    documented health path. The Loam server does not proxy /health
//    (voice.ts only proxies POST /api/voice/transcribe), so the browser
//    checks it directly with a no-cors request: resolve = reachable,
//    reject = not running. The setup action shows the real `npm run stt`
//    command to copy — the STT server is a user-run Python process, so there
//    is no in-app start button to fake.
// ---------------------------------------------------------------------------

const CODEGRAPH_STATUS_URL = '/api/codegraph/status';
const CODEGRAPH_INSTALL_URL = '/api/codegraph/runtime/install';
const SETTINGS_URL = '/api/settings';
const STT_HEALTH_URL = 'http://127.0.0.1:3947/health';
const STT_SETUP_COMMAND = 'npm run stt';
const STT_PROBE_TIMEOUT_MS = 2500;
const INSTALL_POLL_INTERVAL_MS = 2000;
const INSTALL_POLL_MAX_ATTEMPTS = 150;

type SetupStatus = 'checking' | 'ok' | 'down';

interface CodeGraphStatus {
  ok?: boolean;
  runtime?: { state?: string };
  install?: { running?: boolean; step?: string | null };
}

function SetupDot({ status, label }: { status: SetupStatus; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={clsx(
        'inline-block size-2 shrink-0 rounded-full',
        status === 'ok' ? 'bg-function-success' : status === 'down' ? 'bg-function-error' : 'bg-fill-hover',
      )}
    />
  );
}

/** Compact row status word: checking → spinner word, then the real state. */
function setupStatusText(status: SetupStatus, okLabel: string, downLabel: string): string {
  return status === 'checking' ? t('Checking…') : status === 'ok' ? okLabel : downLabel;
}

function FirstRunSetup() {
  const dispatch = useAppDispatch();
  const [codegraph, setCodegraph] = useState<SetupStatus>('checking');
  const [installing, setInstalling] = useState(false);
  const [sandbox, setSandbox] = useState<SetupStatus>('checking');
  const [stt, setStt] = useState<SetupStatus>('checking');
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const applyCodegraph = useCallback((data: CodeGraphStatus | null) => {
    if (!mountedRef.current) return;
    setCodegraph(data && (data.ok === true || data.runtime?.state === 'ready') ? 'ok' : 'down');
  }, []);

  const checkCodegraph = useCallback(async (): Promise<CodeGraphStatus | null> => {
    try {
      const res = await fetch(`${getApiBase()}${CODEGRAPH_STATUS_URL}`, { headers: await getApiHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as CodeGraphStatus;
      applyCodegraph(data);
      return data;
    } catch {
      applyCodegraph(null);
      return null;
    }
  }, [applyCodegraph]);

  const checkSandbox = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}${SETTINGS_URL}`, { headers: await getApiHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { codemode?: boolean };
      if (mountedRef.current) setSandbox(data.codemode === true ? 'ok' : 'down');
    } catch {
      if (mountedRef.current) setSandbox('down');
    }
  }, []);

  const checkStt = useCallback(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STT_PROBE_TIMEOUT_MS);
    try {
      await fetch(STT_HEALTH_URL, { mode: 'no-cors', signal: controller.signal });
      if (mountedRef.current) setStt('ok');
    } catch {
      if (mountedRef.current) setStt('down');
    } finally {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    void checkCodegraph();
    void checkSandbox();
    void checkStt();
  }, [checkCodegraph, checkSandbox, checkStt]);

  const installCodegraph = useCallback(async () => {
    if (installing) return;
    setInstalling(true);
    try {
      await fetch(`${getApiBase()}${CODEGRAPH_INSTALL_URL}`, {
        method: 'POST',
        headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
        body: '{}',
      });
      // Follow the server-side installer until it reports finished, then the
      // last poll reflects the true state (ready / still not installed).
      for (let attempt = 0; attempt < INSTALL_POLL_MAX_ATTEMPTS; attempt++) {
        const data = await checkCodegraph();
        if (!data?.install?.running) break;
        await new Promise((resolve) => setTimeout(resolve, INSTALL_POLL_INTERVAL_MS));
      }
    } catch {
      applyCodegraph(null);
    } finally {
      if (mountedRef.current) setInstalling(false);
    }
  }, [applyCodegraph, checkCodegraph, installing]);

  const openSandbox = useCallback(() => {
    dispatch(setSettingsTab('Data controls'));
  }, [dispatch]);

  const copyStt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(STT_SETUP_COMMAND);
      if (mountedRef.current) {
        setCopied(true);
        setTimeout(() => { if (mountedRef.current) setCopied(false); }, 1500);
      }
    } catch {
      /* clipboard unavailable — the command stays visible inline */
    }
  }, []);

  return (
    <Section title={t('Recommended setup')}>
      <Row label={t('Code graph')}>
        <div className="flex items-center gap-2">
          <SetupDot status={codegraph} label={codegraph === 'ok' ? t('Ready') : t('Not installed')} />
          <span className="text-xs text-text-tertiary">
            {installing ? t('Installing…') : setupStatusText(codegraph, t('Ready'), t('Not installed'))}
          </span>
          {codegraph !== 'ok' && !installing ? (
            <button
              type="button"
              onClick={() => void installCodegraph()}
              className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary hover:bg-fill-hover"
            >
              {t('Install')}
            </button>
          ) : null}
        </div>
      </Row>
      <Row label={t('Execution sandbox')}>
        <div className="flex items-center gap-2">
          <SetupDot status={sandbox} label={sandbox === 'ok' ? t('Ready') : t('Off')} />
          <span className="text-xs text-text-tertiary">{setupStatusText(sandbox, t('Ready'), t('Off'))}</span>
          <button
            type="button"
            onClick={openSandbox}
            className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary hover:bg-fill-hover"
          >
            {t('Open sandbox settings')}
          </button>
        </div>
      </Row>
      <Row label={t('Speech recognition')}>
        <div className="flex items-center gap-2">
          <SetupDot status={stt} label={stt === 'ok' ? t('Ready') : t('Not running')} />
          <span className="text-xs text-text-tertiary">{setupStatusText(stt, t('Ready'), t('Not running'))}</span>
          <code className="rounded-control bg-fill-tsp px-2 py-0.5 text-xs text-text-secondary">{STT_SETUP_COMMAND}</code>
          <button
            type="button"
            onClick={() => void copyStt()}
            className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary hover:bg-fill-hover"
          >
            {copied ? t('Copied') : t('Copy setup command')}
          </button>
        </div>
      </Row>
    </Section>
  );
}

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
      <FirstRunSetup />

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
