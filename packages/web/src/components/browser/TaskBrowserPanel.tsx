'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ExternalLink,
  Globe2,
  Loader2,
  Plus,
  RotateCw,
  Search,
  X,
} from 'lucide-react';
import { t } from '@/i18n/t';
import { desktopApis } from '@/services/desktopApis';
import {
  iabAttach,
  iabBack,
  iabDetach,
  iabForward,
  iabGetState,
  iabNavigate,
  iabOnStateChanged,
  iabReload,
  iabSetBounds,
  iabSetVisible,
  isInAppBrowserSupported,
  type InAppBrowserState,
} from '@/lib/inAppBrowser';

const EMPTY_STATE: InAppBrowserState = {
  attached: false,
  visible: false,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

function navigationTarget(value: string): string {
  const input = value.trim();
  if (/^https?:\/\//i.test(input)) return input;
  if (/^[^\s]+\.[^\s]+$/.test(input)) return `https://${input}`;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

export function TaskBrowserPanel() {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<InAppBrowserState>(EMPTY_STATE);
  const [urlInput, setUrlInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const previewRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const intersectingRef = useRef(false);
  const dialogBlockedRef = useRef(false);
  stateRef.current = state;

  const applyVisibility = useCallback(() => {
    const visible = stateRef.current.attached
      && intersectingRef.current
      && !dialogBlockedRef.current
      && document.visibilityState === 'visible';
    void iabSetVisible(visible);
  }, []);

  const pushBounds = useCallback(() => {
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return;
    void iabSetBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  }, []);

  useEffect(() => {
    const isSupported = isInAppBrowserSupported();
    setSupported(isSupported);
    if (!isSupported) return;
    const off = iabOnStateChanged((next) => {
      setState(next);
      if (document.activeElement?.tagName !== 'INPUT') setUrlInput(next.url);
    });
    void iabGetState().then((current) => {
      setState(current);
      setUrlInput(current.url);
      applyVisibility();
    });
    return () => {
      off();
      void iabSetVisible(false);
      void iabDetach();
    };
  }, [applyVisibility]);

  useEffect(() => {
    if (!supported || !previewRef.current) return;
    const element = previewRef.current;
    const resize = new ResizeObserver(() => {
      pushBounds();
      applyVisibility();
    });
    resize.observe(element);
    resize.observe(document.documentElement);
    const intersection = new IntersectionObserver((entries) => {
      intersectingRef.current = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0);
      if (intersectingRef.current) pushBounds();
      applyVisibility();
    });
    intersection.observe(element);
    const dialogs = new MutationObserver(() => {
      dialogBlockedRef.current = Boolean(document.querySelector('[role="dialog"], [aria-modal="true"], dialog[open]'));
      applyVisibility();
    });
    dialogs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'role', 'aria-modal'] });
    const onVisibility = () => applyVisibility();
    const onResize = () => pushBounds();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);
    return () => {
      resize.disconnect();
      intersection.disconnect();
      dialogs.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
    };
  }, [supported, applyVisibility, pushBounds]);

  const go = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    const input = urlInput.trim();
    if (!input || busy) return;
    const target = navigationTarget(input);
    setBusy(true);
    setNotice('');
    try {
      if (!supported) {
        window.open(target, '_blank', 'noopener,noreferrer');
        return;
      }
      await iabAttach();
      pushBounds();
      const result = await iabNavigate(target);
      if (!result.ok) {
        setNotice(result.error ?? t('Could not navigate'));
        return;
      }
      setState(await iabGetState());
      applyVisibility();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [applyVisibility, busy, pushBounds, supported, urlInput]);

  const newTab = useCallback(() => {
    void iabSetVisible(false);
    void iabDetach();
    setState(EMPTY_STATE);
    setUrlInput('');
    setNotice('');
  }, []);

  const toolbar = async (action: 'back' | 'forward' | 'reload') => {
    if (action === 'back') await iabBack();
    if (action === 'forward') await iabForward();
    if (action === 'reload') await iabReload();
    setState(await iabGetState());
  };

  const blank = !state.attached || !state.url || state.url === 'about:blank';

  return (
    <section aria-label={t('In-app browser surface')} className="hidden min-h-0 flex-1 flex-col bg-bg-menu lg:flex">
      <header className="flex h-row shrink-0 items-center border-b border-border-main px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Globe2 className="size-4 shrink-0 text-text-secondary" />
          <span className="truncate text-[13px] font-medium text-text-primary">{blank ? t('New tab') : state.title || state.url}</span>
          <button type="button" aria-label={t('Close')} onClick={newTab} className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover"><X className="size-3.5" /></button>
        </div>
        <button type="button" aria-label={t('New tab')} onClick={newTab} className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><Plus className="size-4" /></button>
        <button type="button" aria-label={t('More')} className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><ChevronDown className="size-4" /></button>
        <span className="mx-2 h-4 w-px bg-border-main" />
        <button
          type="button"
          aria-label={t('Open externally')}
          disabled={blank}
          onClick={() => { if (state.url) void desktopApis.system.openExternal(state.url); }}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover disabled:opacity-40"
        >
          <ExternalLink className="size-4" />
        </button>
      </header>

      <div className="flex h-row shrink-0 items-center gap-1 border-b border-border-main px-3">
        <button type="button" aria-label={t('Back')} disabled={!state.canGoBack} onClick={() => void toolbar('back')} className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover disabled:opacity-40"><ArrowLeft className="size-4" /></button>
        <button type="button" aria-label={t('Forward')} disabled={!state.canGoForward} onClick={() => void toolbar('forward')} className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover disabled:opacity-40"><ArrowRight className="size-4" /></button>
        <button type="button" aria-label={t('Reload')} disabled={blank} onClick={() => void toolbar('reload')} className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover disabled:opacity-40"><RotateCw className="size-4" /></button>
        <form onSubmit={(event) => void go(event)} className="ms-2 flex min-w-0 flex-1">
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            placeholder={t('Search Google or enter a URL')}
            aria-label={t('Search Google or enter a URL')}
            spellCheck={false}
            className="h-8 min-w-0 flex-1 bg-transparent px-2 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
          {busy && <Loader2 className="size-4 shrink-0 animate-spin self-center text-text-tertiary" />}
        </form>
      </div>

      <div ref={previewRef} className="relative min-h-0 flex-1 overflow-hidden bg-bg-menu" data-testid="task-browser-surface">
        {blank && (
          <div className="flex h-full flex-col items-center justify-center px-6">
            <form onSubmit={(event) => void go(event)} className="flex h-12 w-full max-w-[520px] items-center gap-3 rounded-full border border-border-main bg-bg-menu px-5 shadow-card">
              <Search className="size-4 shrink-0 text-text-tertiary" />
              <input
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                placeholder={t('Search Google or enter a URL')}
                aria-label={t('Search Google or enter a URL')}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
              />
              {busy && <Loader2 className="size-4 shrink-0 animate-spin text-text-tertiary" />}
            </form>
          </div>
        )}
        {notice && <p role="alert" className="absolute inset-x-4 bottom-4 rounded-control bg-function-error-tsp px-3 py-2 text-xs text-function-error">{notice}</p>}
      </div>
    </section>
  );
}
