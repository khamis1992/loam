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
  iabSetVisible,
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
 *
 * Because the native view ignores CSS stacking/visibility/overflow, this pane
 * explicitly drives its visibility (iabSetVisible). The view is painted ONLY
 * while ALL of these hold — the main process ANDs the first with its window
 * focus/minimize factor (electron/inAppBrowser.cjs):
 *   - the preview surface is mounted AND intersecting the viewport (this
 *     covers route switches, the pane scrolling off, and the settings dialog
 *     being closed while still mounted);
 *   - the document is not hidden (visibilitychange);
 *   - the host window has focus;
 *   - no top-layer dialog opened over the pane (confirm dialogs, ...).
 * Any lost condition hides the native view; every regained one re-anchoring
 * the bounds first, then re-showing.
 */

type Pending = 'idle' | 'busy';

export function InAppBrowserPane() {
  // Decided in an effect so SSR (Next static export) and the first hydration
  // pass render the same non-branch markup.
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<InAppBrowserState>({ attached: false, visible: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false });
  const [urlInput, setUrlInput] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Pending>('idle');
  const [agentSettings, setAgentSettings] = useState<AgentBrowserSettings | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // Renderer-side visibility factors (see the component doc block). Kept in
  // refs because they change without a re-render and always combine into one
  // iabSetVisible boolean.
  const previewIntersectingRef = useRef(false);
  const documentVisibleRef = useRef(true);
  const windowFocusedRef = useRef(true);
  const modalOverPaneRef = useRef(false);

  useEffect(() => {
    setSupported(isInAppBrowserSupported());
  }, []);

  /** Re-assert visibility after any factor changed. Hiding is unconditional
   *  and immediate; showing only when every factor is satisfied again. */
  const applyVisibility = useCallback(() => {
    const onScreen = previewIntersectingRef.current && documentVisibleRef.current && windowFocusedRef.current && !modalOverPaneRef.current;
    void iabSetVisible(onScreen);
  }, []);

  /** Measure the preview rect in CSS pixels and push it as the native view's
   *  window-relative bounds (nothing to anchor while the rect is collapsed). */
  const pushBounds = useCallback(() => {
    const el = previewRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return;
    const dpr = window.devicePixelRatio || 1;
    // DPI handling (chosen approach): WebContentsView.setBounds() positions
    // the view in DIPs relative to the window content area, and getBoundingClientRect()
    // reports CSS pixels from the renderer — two coordinate spaces Electron
    // keeps aligned (devicePixelRatio = displayScale * zoomFactor, and the
    // shell's zoom factor is always 1), so the CSS-pixel rect passes through
    // 1:1. Blindly multiplying by devicePixelRatio would misplace the view on
    // every scaled display (125/150% Windows, retina). What a
    // devicePixelRatio !== 1 DOES change is the physical-pixel grid the view
    // is rasterized on: fractional DIP rects can snap the view's edges one
    // physical pixel away from the host element. So when devicePixelRatio is
    // not 1 we snap the rect onto that grid (round in physical pixels, back
    // to DIPs) — rounding is sub-pixel-safe: it never moves an edge more than
    // half a physical pixel, and on the common integer scales it is exact.
    const snap = (v: number) => (dpr === 1 ? Math.round(v) : Math.round(v * dpr) / dpr);
    void iabSetBounds({
      x: snap(rect.left),
      y: snap(rect.top),
      width: snap(rect.width),
      height: snap(rect.height),
    });
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

  // Show the native view only while the pane is actually on screen. Covers
  // route changes away from this pane, the pane scrolling off inside the
  // dialog, and the settings dialog being closed while still mounted — native
  // views ignore the CSS visibility that would otherwise hide the preview.
  useEffect(() => {
    if (!supported) return;
    const el = previewRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          previewIntersectingRef.current = entry.isIntersecting && entry.intersectionRatio > 0;
        }
        // Coming back on screen: re-anchor bounds before showing so the view
        // does not repaint at a stale rect from before it was hidden.
        if (previewIntersectingRef.current) pushBounds();
        applyVisibility();
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [supported, pushBounds, applyVisibility]);

  // The document being hidden (window minimized/covered, tab suspended in the
  // shell) and host-window focus also gate the view, mirroring the main
  // process window factor: hide aggressively on any loss, restore only when
  // everything (intersection included) is back.
  useEffect(() => {
    if (!supported) return;
    const onVisibilityChange = () => {
      documentVisibleRef.current = document.visibilityState === 'visible';
      if (documentVisibleRef.current) applyVisibility();
      else void iabSetVisible(false);
    };
    const onWindowBlur = () => {
      windowFocusedRef.current = false;
      void iabSetVisible(false);
    };
    const onWindowFocus = () => {
      windowFocusedRef.current = true;
      applyVisibility();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, [supported, applyVisibility]);

  // A modal opening over the pane (destructive-action confirm, command
  // palette, ...) is DOM-stacked above the preview, which the native view
  // cannot see: it must hide while any open top-layer dialog that does NOT
  // contain the preview is present (the settings dialog itself contains it
  // and is fine). Restored from intersection state when none is left.
  useEffect(() => {
    if (!supported) return;
    const dialogQuery = '[role="dialog"], [aria-modal="true"], dialog[open]';
    const hasBlockingDialog = () => {
      const preview = previewRef.current;
      const dialogs = document.querySelectorAll(dialogQuery);
      for (const node of Array.from(dialogs)) {
        if (!preview || !node.contains(preview)) return true;
      }
      return false;
    };
    const reconcile = () => {
      const blocked = hasBlockingDialog();
      if (blocked === modalOverPaneRef.current) return;
      modalOverPaneRef.current = blocked;
      if (blocked) void iabSetVisible(false);
      else applyVisibility();
    };
    // Dialogs can appear/remove as nodes or flip their open/aria attributes
    // in place; watch both so the view hides behind every modal variant.
    const mo = new MutationObserver(reconcile);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'role', 'aria-modal'] });
    reconcile();
    return () => mo.disconnect();
  }, [supported, applyVisibility]);

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
    const ro = new ResizeObserver(pushBounds);
    // The existing preview observer only fires when the preview itself
    // resizes; a resize of the SURROUNDING layout (e.g. the sidebar
    // collapsing/expanding) can move or reshape the pane without changing the
    // preview's own box first. Observe the layout containers too so any of
    // them resizing triggers a re-measure of the real rect.
    if (el.parentElement) ro.observe(el.parentElement);
    ro.observe(document.documentElement);
    // window 'resize' also fires when the OS display scale changes
    // (devicePixelRatio flips), re-measuring bounds after a DPI change.
    window.addEventListener('resize', pushBounds);
    document.addEventListener('scroll', pushBounds, true);
    pushBounds();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', pushBounds);
      document.removeEventListener('scroll', pushBounds, true);
      // Leaving this pane releases the native surface so nothing stays
      // overlaid over the app (tab switching unmounts this component): hide
      // first (cheap, survives re-attach with its page kept), then detach.
      void iabSetVisible(false);
      void iabDetach();
    };
  }, [supported, pushBounds]);

  const attach = useCallback(async () => {
    if (!supported) return;
    try {
      // attach() starts the native view hidden in the main process; bounds
      // are measured first, then the on-screen decision re-asserted so the
      // view only paints once it is anchored (and only if it should).
      await iabAttach();
      pushBounds();
      const cur = await iabGetState();
      // Pasting one agent-configured homepage into the surface when the user
      // attaches with nothing loaded keeps the pane never-empty.
      if (!cur.url) void iabHome();
      setState(cur);
      applyVisibility();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, [supported, pushBounds, applyVisibility]);

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
