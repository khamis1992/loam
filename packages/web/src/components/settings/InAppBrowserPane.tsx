'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n/t';
import { Row, Section } from './SettingsDialog';
import { EmptyState } from './EmptyState';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import {
  iabAttach,
  iabBack,
  iabDetach,
  iabForward,
  iabGetState,
  iabHome,
  iabNavigate,
  iabOnStateChanged,
  iabReload,
  iabSetBounds,
  iabStop,
  isInAppBrowserSupported,
  type AgentBrowserSettings,
  type InAppBrowserState,
} from '@/lib/inAppBrowser';

/**
 * Settings > In-App Browser pane (UNIMPLEMENTED_OPTIONS #5).
 *
 * Browsers the Loam desktop shell with a native WebContentsView pushed over
 * the preview surface through the electron "inAppBrowser" IPC namespace. The
 * toolbar is plain DOM; the preview rect is anchored from the host window so
 * the native view stays exactly over it while the dialog scrolls or resizes.
 * The "Agent browser tool" section mirrors the shared browser settings the
 * agent's Playwright browser reads (headless flag + homepage from /api/settings),
 * so this surface and the agent stay in one configuration.
 */

type Pending = 'idle' | 'busy';

export function InAppBrowserPane() {
  // Decided in an effect so SSR (Next static export) and the first hydration
  // pass render the same non-branch markup.
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<InAppBrowserState>({ attached: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false });
  const [urlInput, setUrlInput] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Pending>('idle');
  const [agentSettings, setAgentSettings] = useState<AgentBrowserSettings | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSupported(isInAppBrowserSupported());
  }, []);

  const refreshState = useCallback(async () => {
    setState(await iabGetState());
  }, []);

  // Bind to pushed state changes; also pull once on mount.
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    const read = (s: InAppBrowserState) => {
      if (!alive) return;
      setState(s);
      setUrlInput((prev) => (document.activeElement?.tagName === 'INPUT' && prev.length > 0 ? prev : s.url));
    };
    const off = iabOnStateChanged(read);
    void refreshState();
    return () => {
      alive = false;
      off();
    };
  }, [supported, refreshState]);

  // Mirror the agent browser tool settings (read-only) from the Loam server.
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/settings`, { headers: { ...(await getApiHeaders()) } });
        if (!res.ok) return;
        const data = (await res.json()) as AgentBrowserSettings;
        if (alive) setAgentSettings({ browserHeadless: data.browserHeadless, browserHomepage: data.browserHomepage });
      } catch {
        if (alive) setAgentSettings(null);
      }
    };
    void load();
    const interval = window.setInterval(load, 10_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [supported]);

  // Anchor the native view over the preview surface: recompute the rect on
  // every resize and scroll so the overlay never drifts out of the dialog.
  useEffect(() => {
    if (!supported) return;
    const el = previewRef.current;
    if (!el) return;
    const push = () => {
      const rect = el.getBoundingClientRect();
      if (rect.height > 1 && rect.width > 1) {
        void iabSetBounds({ x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    };
    const ro = new ResizeObserver(push);
    ro.observe(el);
    window.addEventListener('resize', push);
    document.addEventListener('scroll', push, true);
    push();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', push);
      document.removeEventListener('scroll', push, true);
      // Leaving this pane releases the native surface so nothing stays
      // overlaid over the app (tab switching unmounts this component).
      void iabDetach();
    };
  }, [supported]);

  const attach = useCallback(async () => {
    if (!supported) return;
    const el = previewRef.current;
    try {
      await iabAttach();
      if (el) {
        const rect = el.getBoundingClientRect();
        await iabSetBounds({ x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) });
      }
      const cur = await iabGetState();
      // Pasting one agent-configured homepage into the surface when the user
      // attaches with nothing loaded keeps the pane never-empty.
      if (!cur.url) void iabHome();
      setState(cur);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, [supported]);

  useEffect(() => {
    if (supported) void attach();
    return () => undefined;
    // Auto-attach when the pane mounts (settings tab opened).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  const go = useCallback(async () => {
    const target = urlInput.trim();
    if (!target) return;
    const normalized = /^https?:\/\//i.test(target) ? target : `https://${target}`;
    setUrlInput(normalized);
    setPending('busy');
    try {
      const res = await iabNavigate(normalized);
      if (!res.ok) setNotice(res.error ?? t('Could not navigate'));
      else setNotice('');
    } finally {
      setPending('idle');
      await refreshState();
    }
  }, [urlInput, refreshState]);

  const toolbarAction = useCallback(
    async (action: 'back' | 'forward' | 'reload' | 'stop') => {
      if (action === 'back') await iabBack();
      if (action === 'forward') await iabForward();
      if (action === 'reload') await iabReload();
      if (action === 'stop') await iabStop();
      await refreshState();
    },
    [refreshState],
  );

  if (!supported) {
    return (
      <EmptyState
        title={t('Available in the Loam desktop app')}
        description={t('Download and run the Loam desktop build to browse the web inside the app here, driven by the same settings the agent browser tool uses.')}
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex items-center gap-1">
        <button type="button" aria-label={t('Back')} className="rounded-control px-1.5 py-1 text-text-secondary hover:bg-fill-hover disabled:opacity-40" disabled={!state.canGoBack} onClick={() => void toolbarAction('back')}>
          ◀
        </button>
        <button type="button" aria-label={t('Forward')} className="rounded-control px-1.5 py-1 text-text-secondary hover:bg-fill-hover disabled:opacity-40" disabled={!state.canGoForward} onClick={() => void toolbarAction('forward')}>
          ▶
        </button>
        <button type="button" aria-label={state.loading ? t('Stop') : t('Reload')} className="rounded-control px-1.5 py-1 text-text-secondary hover:bg-fill-hover" onClick={() => void toolbarAction(state.loading ? 'stop' : 'reload')}>
          {state.loading ? '✕' : '⟳'}
        </button>
        <button type="button" aria-label={t('Open homepage')} className="rounded-control px-1.5 py-1 text-text-secondary hover:bg-fill-hover" onClick={() => (state.attached ? void iabHome().then(refreshState) : undefined)}>
          ⌂
        </button>
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder={t('Search or enter address')}
            spellCheck={false}
            className="h-8 flex-1 rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
          />
          <button type="submit" className="h-8 rounded-control px-3 text-sm font-medium text-text-primary hover:bg-fill-hover" disabled={pending === 'busy'}>
            {t('Open')}
          </button>
        </form>
      </div>

      <div
        ref={previewRef}
        data-testid="in-app-browser-surface"
        className="relative h-[430px] overflow-hidden rounded-card border border-border-main bg-bg-nav"
        aria-label={t('In-app browser surface')}
      >
        {state.attached && state.url ? (
          <div className="absolute bottom-0 left-0 z-10 max-w-full truncate rounded-tr-none bg-bg-main/85 px-2 py-0.5 text-xs text-text-tertiary">
            {state.title || state.url}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <button type="button" className="rounded-control border border-border-main px-4 py-2 text-sm text-text-secondary hover:bg-fill-hover" onClick={() => void attach()}>
              {t('Open in-app browser')}
            </button>
          </div>
        )}
      </div>
      {notice && <p className="text-xs text-text-secondary">{notice}</p>}

      <Section title={t('Agent browser tool')}>
        <p className="mb-1 text-xs text-text-tertiary">{t('Shared configuration that the agent browser uses for its own browsing tasks (read-only here).')}</p>
        <Row label={t('Headless agent browsing')} description={t('When on, agent pages run invisibly; the view here only shows pages opened in this app.')}>
          <span className="text-sm text-text-secondary">{agentSettings === null ? '—' : (agentSettings.browserHeadless ?? false) ? t('On') : t('Off')}</span>
        </Row>
        <Row label={t('Homepage')} description={t('Page opened when neither the agent nor this surface starts with an address.')}>
          <span className="max-w-[320px] truncate text-sm text-text-secondary">{agentSettings?.browserHomepage?.trim() || t('Default')}</span>
        </Row>
      </Section>
    </div>
  );
}
