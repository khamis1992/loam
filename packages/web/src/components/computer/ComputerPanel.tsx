'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Folder,
  FolderOpen,
  Fullscreen,
  Globe,
  Maximize2,
  Minimize2,
  Monitor,
  Palette,
  RotateCcw,
  Terminal,
  FileText,
  Eye,
  X,
} from 'lucide-react';
import type { ToolUsedEvent } from '@shared/socket';
import { t } from '@/i18n/t';
import { desktopEvents } from '@/services/desktopApis';
import { getApiBase } from '@/services/rpc';
import { LiveView } from '@/components/computer/LiveView';
import type { TimelineStep } from '@/components/chat/StepTimeline';
import { getToolFamily, getStudioMode, type ToolFamily, type StudioMode } from '@/components/chat/toolIcons';

// int-f3: studio iframes load real backend UI pages served from the same origin used for /api/* calls.
const OFFICE_PREVIEW_PATH = '/office-preview.html';
const CREATIVE_RENDER_PATH = '/creative-render.html';

type TabId = ToolFamily;

interface ComputerPanelProps {
  event: ToolUsedEvent;
  sessionId: string;
  onClose: () => void;
  /** Workspace tab content provided by the task view; tab is hidden when absent. */
  workspaceSlot?: ReactNode;
  /** When true the panel focuses the Workspace tab (auto-open from file events). */
  focusWorkspace?: boolean;
  /** Real Loam task id when known; lets the Live tab resolve browser frames. */
  taskId?: string;
  /** Timeline steps for the in-panel scrubber (H2); the footer is hidden when absent. */
  steps?: TimelineStep[];
  /** Selecting a scrubber step moves the whole task view to that step. */
  onSelectStep?: (step: TimelineStep) => void;
  /** True while the task is still running (drives the «مباشر» follow state). */
  live?: boolean;
}

interface TerminalDetail {
  command?: string;
  output?: string[];
  shellId?: string;
}

interface EditorDetail {
  path?: string;
  content?: string;
  oldContent?: string;
  action?: string;
}

interface BrowserState {
  pages?: Array<{ id: string; url: string }>;
  actions?: Array<{ op: string; url: string; ok: boolean; message?: string }>;
  running?: boolean;
}

interface PreviewState {
  url?: string | null;
  running?: boolean;
}

const TABS: { id: TabId; label: string; icon: typeof Terminal }[] = [
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'editor', label: 'Editor', icon: FileText },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'live', label: 'Live', icon: Monitor },
  { id: 'files', label: 'Files', icon: Folder },
];

const STUDIO_TAB = { id: 'studio' as const, label: 'Open in studio', icon: Palette };

// Remember inferred studio mode per session so the tab stays visible after the first studio tool.
const studioModeBySession = new Map<string, StudioMode>();

// Last tool event seen per tab family, per session, so each tab shows its own latest activity
// instead of whatever event happened to arrive last.
const DEFAULT_WIDTH = 520;
const MIN_WIDTH = 360;
const MAX_WIDTH = 1000;
const WIDTH_KEY = 'loam.computerPanel.width';
const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));

const eventsBySession =new Map<string, Partial<Record<TabId, ToolUsedEvent>>>();

export function ComputerPanel({ event, sessionId, onClose, workspaceSlot, focusWorkspace, taskId, steps, onSelectStep, live }: ComputerPanelProps) {
  const derivedTab = useMemo(() => getToolFamily(event.tool), [event.tool]);
  const [userTab, setUserTab] = useState<TabId | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const expanded = width > DEFAULT_WIDTH;
  // M2: true full-screen view — fixed overlay over the whole window; Esc exits.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      if (saved) setWidth(clampWidth(saved));
    } catch {}
  }, []);
  const commitWidth = (w: number) => {
    const next = clampWidth(w);
    setWidth(next);
    try {
      localStorage.setItem(WIDTH_KEY, String(next));
    } catch {}
  };
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = width;
    const rtl = getComputedStyle(target).direction === 'rtl';
    const move = (ev: PointerEvent) => {
      const delta = rtl ? ev.clientX - startX : startX - ev.clientX;
      setWidth(clampWidth(startW + delta));
    };
    const up = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      const delta = rtl ? ev.clientX - startX : startX - ev.clientX;
      commitWidth(startW + delta);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  useEffect(() => {
    setUserTab(null);
  }, [event]);
  const seen = useMemo(() => {
    const store = eventsBySession.get(sessionId) ?? {};
    store[derivedTab] = event;
    eventsBySession.set(sessionId, store);
    return store;
  }, [sessionId, derivedTab, event]);
  const studioMode = useMemo(() => {
    const fromTool = getStudioMode(event.tool);
    if (fromTool) {
      studioModeBySession.set(sessionId, fromTool);
      return fromTool;
    }
    return studioModeBySession.get(sessionId) ?? null;
  }, [event.tool, sessionId]);
  // Only offer tabs that have (or can have) something to show for this task.
  const visibleTabs = useMemo(() => {
    const tabs: { id: TabId; label: string; icon: typeof Terminal }[] = TABS.filter(
      (tab) => tab.id === 'live' || tab.id === 'files' || tab.id === derivedTab || seen[tab.id] !== undefined,
    );
    if (workspaceSlot) tabs.push({ id: 'workspace' as const, label: 'Workspace', icon: FolderOpen });
    if (studioMode) tabs.push(STUDIO_TAB);
    return tabs;
  }, [studioMode, workspaceSlot, derivedTab, seen]);
  const activeTab = useMemo<TabId>(() => {
    const pick = userTab ?? (workspaceSlot && focusWorkspace ? 'workspace' : derivedTab);
    return visibleTabs.some((tab) => tab.id === pick) ? pick : 'files';
  }, [userTab, workspaceSlot, focusWorkspace, derivedTab, visibleTabs]);
  const tabEvent = seen[activeTab] ?? (activeTab === derivedTab ? event : undefined);
  const isDriving = !isFinalStatus(event.status) && activeTab === 'browser';
  // H2 scrubber: position of the event being viewed within the timeline.
  const stepIndex = steps ? Math.max(0, steps.findIndex((s) => s.actionId === event.actionId)) : 0;

  return (
    <div
      data-testid={fullscreen ? 'computer-panel-fullscreen' : 'computer-panel'}
      style={fullscreen ? undefined : { width }}
      className={[
        'relative flex h-full shrink-0 flex-col bg-bg-menu',
        fullscreen ? 'fixed inset-0 z-40 max-w-none' : 'max-w-[85vw] border-s',
        isDriving ? 'border-s-4 border-s-[var(--icon-blue)]' : fullscreen ? '' : 'border-border-main',
      ].join(' ')}
    >
      {!fullscreen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('Resize')}
          onPointerDown={onDragStart}
          onDoubleClick={() => commitWidth(DEFAULT_WIDTH)}
          className="absolute inset-y-0 -start-1 z-10 w-2 cursor-col-resize touch-none hover:bg-[var(--icon-blue)]/30"
        />
      )}
      <div className="flex h-[40px] shrink-0 items-center justify-between border-b border-border-main px-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">{t("Loam's computer")}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t(fullscreen ? 'Exit full screen' : 'Full screen')}
            aria-pressed={fullscreen}
            data-testid="computer-fullscreen-toggle"
            onClick={() => setFullscreen((v) => !v)}
            className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
          >
            {fullscreen ? <Minimize2 className="size-4" /> : <Fullscreen className="size-4" />}
          </button>
          <button
            type="button"
            aria-label={t('Expand')}
            aria-pressed={expanded}
            onClick={() => commitWidth(expanded ? DEFAULT_WIDTH : MAX_WIDTH)}
            className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
          >
            <Maximize2 className="size-4" />
          </button>
          <button aria-label={t('Close')} onClick={onClose} className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover">
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div role="tablist" className="flex h-[40px] shrink-0 items-stretch border-b border-border-main px-1">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          const label = t(tab.label);
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-label={label}
              title={label}
              onClick={() => setUserTab(tab.id)}
              className={[
                'flex min-w-0 items-center justify-center gap-1.5 border-b-2 px-2.5 text-xs font-medium transition-colors',
                isActive ? 'flex-[2_1_0%] border-[var(--icon-blue)] text-text-primary' : 'flex-1 border-transparent text-text-tertiary hover:bg-fill-hover hover:text-text-secondary',
              ].join(' ')}
            >
              <Icon className="size-3.5 shrink-0" />
              {isActive && <span className="truncate">{label}</span>}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-hidden">
        <TabContent
          event={tabEvent}
          sessionId={sessionId}
          tab={activeTab}
          studioMode={studioMode}
          workspaceSlot={workspaceSlot}
          taskId={taskId}
          fallbackEvent={event}
        />
      </div>

      {steps && steps.length >= 2 && onSelectStep && (
        <div
          data-testid="computer-scrubber"
          className="flex h-[44px] shrink-0 items-center gap-2 border-t border-border-main px-3"
        >
          <button
            type="button"
            aria-label={t('Previous step')}
            disabled={stepIndex <= 0}
            onClick={() => onSelectStep(steps[Math.max(0, stepIndex - 1)]!)}
            className="rounded-control p-1 text-text-secondary hover:bg-fill-hover disabled:opacity-40"
          >
            <ChevronRight className="size-4 rtl:-scale-x-100" />
          </button>
          {/* Time flows in one direction regardless of locale — keep the
              scrubber physically LTR so RTL users get the same mental model. */}
          <input
            type="range"
            dir="ltr"
            min={0}
            max={steps.length - 1}
            value={stepIndex}
            aria-label={t('Timeline scrubber')}
            data-testid="computer-scrubber-range"
            onChange={(e) => onSelectStep(steps[Number(e.target.value)]!)}
            className="h-1 flex-1 cursor-pointer accent-[var(--status-active)]"
          />
          <button
            type="button"
            aria-label={t('Next step')}
            disabled={stepIndex >= steps.length - 1}
            onClick={() => onSelectStep(steps[Math.min(steps.length - 1, stepIndex + 1)]!)}
            className="rounded-control p-1 text-text-secondary hover:bg-fill-hover disabled:opacity-40"
          >
            <ChevronLeft className="size-4 rtl:-scale-x-100" />
          </button>
          {stepIndex < steps.length - 1 && (
            <button
              type="button"
              data-testid="computer-jump-live"
              onClick={() => onSelectStep(steps[steps.length - 1]!)}
              className="flex items-center gap-1 rounded-control border border-[var(--status-active)] px-2 py-0.5 text-xs text-status-active transition-colors duration-fast"
            >
              <span className="status-active-dot" aria-hidden />
              {t('Live')}
            </button>
          )}
          <span className="text-xs text-text-tertiary" data-testid="computer-scrubber-position">
            {stepIndex + 1}/{steps.length}
          </span>
        </div>
      )}
    </div>
  );
}

function TabContent({
  event,
  sessionId,
  tab,
  studioMode,
  workspaceSlot,
  taskId,
  fallbackEvent,
}: {
  event?: ToolUsedEvent;
  fallbackEvent: ToolUsedEvent;
  sessionId: string;
  tab: TabId;
  studioMode: StudioMode | null;
  workspaceSlot?: ReactNode;
  taskId?: string;
}) {
  switch (tab) {
    case 'live':
      return <LiveView sessionId={sessionId} taskId={taskId} />;
    case 'workspace':
      if (!workspaceSlot) return <FilesContent event={event ?? fallbackEvent} sessionId={sessionId} />;
      return <>{workspaceSlot}</>;
    case 'studio':
      if (!studioMode) return <FilesContent event={event ?? fallbackEvent} sessionId={sessionId} />;
      return <StudioContent sessionId={sessionId} mode={studioMode} />;
    case 'files':
      return <FilesContent event={event ?? fallbackEvent} sessionId={sessionId} />;
    default:
      break;
  }
  if (!event) return <EmptyTab tab={tab} />;
  switch (tab) {
    case 'terminal':
      return <TerminalContent event={event} />;
    case 'editor':
      return <EditorContent event={event} />;
    case 'browser':
      return <BrowserContent event={event} sessionId={sessionId} />;
    case 'preview':
      return <PreviewContent event={event} sessionId={sessionId} />;
    default:
      return <FilesContent event={event} sessionId={sessionId} />;
  }
}

function EmptyTab({ tab }: { tab: TabId }) {
  const meta = TABS.find((x) => x.id === tab);
  const Icon = meta?.icon ?? Folder;
  const message = tab === 'terminal' ? t('No output') : tab === 'editor' ? t('No file content') : tab === 'preview' ? t('No preview running') : t('No browser state available');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-text-tertiary">
      <Icon className="size-8 opacity-60" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

function StudioContent({ sessionId, mode }: { sessionId: string; mode: StudioMode }) {
  const apiBase = useMemo(() => getApiBase(), []);
  const src = useMemo(() => {
    const path = mode === 'media' ? CREATIVE_RENDER_PATH : OFFICE_PREVIEW_PATH;
    return `${apiBase}${path}?taskId=${encodeURIComponent(sessionId)}`;
  }, [apiBase, mode, sessionId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-row-sm shrink-0 items-center gap-2 border-b border-border-main px-3 text-xs text-text-secondary">
        <Palette className="size-3.5" />
        <span className="truncate">{src}</span>
        <a href={src} target="_blank" rel="noreferrer" className="ms-auto rounded-control p-1 text-text-tertiary hover:bg-fill-hover">
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      <iframe src={src} title={t('Studio')} className="flex-1 border-0" sandbox="allow-scripts allow-same-origin" />
    </div>
  );
}

function TerminalContent({ event }: { event: ToolUsedEvent }) {
  const [streamed, setStreamed] = useState('');
  const detail = useMemo(() => extractTerminalDetail(event), [event]);

  useEffect(() => {
    setStreamed('');
    const unsub = desktopEvents.terminal.onEvent((ev) => {
      if (ev.kind === 'output') setStreamed((prev) => (prev ? `${prev}\n${ev.data ?? ''}` : (ev.data ?? '')));
    });
    return unsub;
  }, [event]);

  const command = detail?.command;
  const output = detail?.output?.join('\n') ?? '';
  const full = [command ? `$ ${command}` : '', output, streamed].filter(Boolean).join('\n');

  return (
    <div className="flex h-full flex-col bg-[#1a1a1a] p-3">
      <pre className="flex-1 overflow-auto whitespace-pre-wrap font-mono text-xs text-[#d4d4d4]">{full || t('No output')}</pre>
    </div>
  );
}

function EditorContent({ event }: { event: ToolUsedEvent }) {
  const detail = useMemo(() => extractEditorDetail(event), [event]);
  const extension = useMemo(() => {
    const p = detail?.path ?? '';
    const dot = p.lastIndexOf('.');
    return dot > 0 ? p.slice(dot + 1).toLowerCase() : '';
  }, [detail?.path]);

  if (!detail?.path && !detail?.content) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-sm text-text-tertiary">{t('No file content')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-row-sm items-center gap-2 border-b border-border-main bg-fill-tsp px-3 text-xs text-text-tertiary">
        <FileText className="size-3.5" />
        <span className="font-mono">{detail.path || t('Untitled')}</span>
        {extension && <span className="rounded px-1 py-0.5 bg-[var(--fill-tsp-gray-main)] text-text-quaternary">{extension}</span>}
      </div>
      <div className="flex-1 overflow-auto bg-[var(--background-code-bg)] p-3">
        {detail.oldContent && detail.content ? (
          <SimpleDiff oldText={detail.oldContent} newText={detail.content} />
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-xs text-text-secondary">{detail.content ?? ''}</pre>
        )}
      </div>
    </div>
  );
}

function SimpleDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  return (
    <div className="flex flex-col gap-0.5 font-mono text-xs">
      {oldLines.map((line, i) => (
        <div key={`old-${i}`} className="rounded px-1.5 py-0.5 bg-function-error-tsp text-function-error">
          - {line}
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`new-${i}`} className="rounded px-1.5 py-0.5 bg-function-success-tsp text-function-success">
          + {line}
        </div>
      ))}
    </div>
  );
}

function BrowserContent({ event, sessionId }: { event: ToolUsedEvent; sessionId: string }) {
  const apiBase = useMemo(() => getApiBase(), []);
  const [state, setState] = useState<BrowserState | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    fetch(`${apiBase}/api/browser/state?taskId=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setState(data as BrowserState | null))
      .catch(() => setState(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [apiBase, sessionId]);

  const eventUrl = useMemo(() => extractUrl(event), [event]);
  const url = eventUrl ?? state?.pages?.[0]?.url ?? '';
  const screenshotPath = useMemo(() => extractScreenshotPath(event.description ?? '') ?? extractScreenshotPath(JSON.stringify(event.detail ?? {})), [event]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-row-sm shrink-0 items-center gap-1 border-b border-border-main px-2">
        <button onClick={load} disabled={loading} className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover disabled:opacity-50">
          <RotateCcw className="size-3.5" />
        </button>
        <button type="button" disabled aria-label={t('Back')} className="rounded-control p-1 text-text-tertiary opacity-40 rtl:rotate-180">
          <ArrowLeft className="size-3.5" />
        </button>
        <button type="button" disabled aria-label={t('Forward')} className="rounded-control p-1 text-text-tertiary opacity-40 rtl:rotate-180">
          <ArrowRight className="size-3.5" />
        </button>
        <div className="flex flex-1 items-center rounded-control border border-border-main bg-fill-tsp px-2 py-1 text-xs text-text-secondary">
          <Globe className="mr-1.5 size-3 text-text-tertiary" />
          <span className="truncate">{url || t('No URL')}</span>
        </div>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover">
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      <div className="h-1 shrink-0 bg-[var(--icon-blue)]" aria-hidden="true" />
      <div className="flex-1 overflow-auto p-3">
        {screenshotPath ? (
          <img
            src={`${apiBase}/api/media?taskId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(screenshotPath)}`}
            alt={t('Browser screenshot')}
            className="w-full rounded-card border border-border-main"
          />
        ) : (
          <div className="space-y-3">
            {state?.pages && state.pages.length > 0 && (
              <div className="rounded-control border border-border-main bg-fill-tsp p-2 text-xs">
                <div className="mb-1 font-medium text-text-secondary">{t('Open pages')}</div>
                {state.pages.map((p) => (
                  <div key={p.id} className="truncate text-text-tertiary">{p.url}</div>
                ))}
              </div>
            )}
            {state?.actions && state.actions.length > 0 && (
              <div className="rounded-control border border-border-main bg-fill-tsp p-2 text-xs">
                <div className="mb-1 font-medium text-text-secondary">{t('Recent actions')}</div>
                {state.actions.slice(-10).map((a, i) => (
                  <div key={i} className="truncate text-text-tertiary">
                    {a.ok ? '✓' : '✕'} {a.op} — {a.url}
                  </div>
                ))}
              </div>
            )}
            {!state?.pages?.length && !state?.actions?.length && (
              <p className="text-sm text-text-tertiary">{t('No browser state available')}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewContent({ event, sessionId }: { event: ToolUsedEvent; sessionId: string }) {
  const apiBase = useMemo(() => getApiBase(), []);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/api/preview?taskId=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setPreview(data as PreviewState | null))
      .catch(() => setPreview(null));
  }, [apiBase, sessionId]);

  const eventUrl = useMemo(() => extractUrl(event), [event]);
  const url = eventUrl ?? preview?.url ?? '';

  if (!url) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-sm text-text-tertiary">{t('No preview running')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-row-sm shrink-0 items-center gap-2 border-b border-border-main px-3 text-xs text-text-secondary">
        <Eye className="size-3.5" />
        <span className="truncate">{url}</span>
        <a href={url} target="_blank" rel="noreferrer" className="ms-auto rounded-control p-1 text-text-tertiary hover:bg-fill-hover">
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      <iframe src={url} title={t('Preview')} className="flex-1 border-0" sandbox="allow-scripts allow-same-origin" />
    </div>
  );
}

function FilesContent({ event, sessionId }: { event: ToolUsedEvent; sessionId: string }) {
  const apiBase = useMemo(() => getApiBase(), []);
  const file = useMemo(() => extractFilePath(event), [event]);
  const content = useMemo(() => {
    const d = asRecord(event.detail);
    const search = asRecord(d?.search);
    if (search) {
      const queries = Array.isArray(search.queries) ? search.queries.map(String) : [];
      const results = Array.isArray(search.results)
        ? search.results.map((r: unknown) => {
            const rr = asRecord(r) ?? {};
            return {
              title: String(rr.title ?? ''),
              link: String(rr.link ?? rr.url ?? ''),
              snippet: String(rr.snippet ?? ''),
            };
          })
        : [];
      return { type: 'search' as const, queries, results };
    }
    const webpage = asRecord(d?.webpageExtract);
    if (webpage) {
      return { type: 'webpage' as const, url: String(webpage.url ?? ''), markdown: String(webpage.markdown ?? '') };
    }
    return null;
  }, [event.detail]);

  if (content?.type === 'search') {
    return (
      <div className="h-full overflow-auto p-3">
        <div className="mb-2 text-xs text-text-tertiary">{content.queries.join(', ')}</div>
        {content.results.map((r, i) => (
          <div key={i} className="mb-3 rounded-card border border-border-main bg-fill-tsp p-2 text-sm">
            <a href={r.link} target="_blank" rel="noreferrer" className="font-medium text-[var(--text-blue)] hover:underline">{r.title}</a>
            <div className="truncate text-xs text-text-tertiary">{r.link}</div>
            <p className="mt-1 text-xs text-text-secondary">{r.snippet}</p>
          </div>
        ))}
      </div>
    );
  }

  if (content?.type === 'webpage') {
    return (
      <div className="h-full overflow-auto p-3">
        <div className="mb-2 truncate text-xs text-text-tertiary">{content.url}</div>
        <pre className="whitespace-pre-wrap font-mono text-xs text-text-secondary">{content.markdown}</pre>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-sm text-text-tertiary">{t('No file data')}</p>
      </div>
    );
  }

  const isImage = /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(file);
  const mediaUrl = `${apiBase}/api/media?taskId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(file)}`;

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex items-center gap-2 text-sm text-text-secondary">
        <Folder className="size-4" />
        <span className="truncate font-mono text-xs">{file}</span>
        <a href={mediaUrl} target="_blank" rel="noreferrer" download className="ms-auto rounded-control p-1 text-text-tertiary hover:bg-fill-hover">
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      {isImage ? (
        <img src={mediaUrl} alt={file} className="max-h-full w-auto rounded-card border border-border-main" />
      ) : (
        <div className="flex flex-1 items-center justify-center rounded-card border border-border-main bg-fill-tsp p-4">
          <a href={mediaUrl} target="_blank" rel="noreferrer" download className="text-sm text-[var(--text-blue)] hover:underline">
            {t('Download file')}
          </a>
        </div>
      )}
    </div>
  );
}

// getToolFamily / getStudioMode live in components/chat/toolIcons.tsx (M3) so
// the chat tool rows and this panel share one vocabulary.

function isFinalStatus(status: ToolUsedEvent['status']): boolean {
  return ['success', 'error', 'failed', 'cancelled', 'stopped', 'rollback'].includes(status);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function extractTerminalDetail(event: ToolUsedEvent): TerminalDetail {
  const detail = asRecord(event.detail);
  const args = asRecord(event.argumentsDetail);
  const nested = asRecord(detail?.terminal ?? args?.terminal);
  if (nested) return nested as TerminalDetail;
  const command =
    typeof args?.command === 'string'
      ? args.command
      : typeof args?.input === 'string'
        ? args.input
        : event.brief;
  return {
    command,
    output: event.description ? [event.description] : undefined,
    shellId: typeof args?.session === 'string' ? args.session : undefined,
  };
}

function extractEditorDetail(event: ToolUsedEvent): EditorDetail {
  const detail = asRecord(event.detail);
  const args = asRecord(event.argumentsDetail);
  const nested = asRecord(detail?.textEditor ?? args?.textEditor);
  if (nested) {
    return {
      path: String(nested.path ?? ''),
      content: typeof nested.content === 'string' ? nested.content : undefined,
      oldContent: typeof nested.oldContent === 'string' ? nested.oldContent : typeof nested.find === 'string' ? nested.find : undefined,
      action: String(nested.action ?? ''),
    };
  }
  return {
    path: typeof args?.path === 'string' ? args.path : event.brief && event.brief.trim() !== '.' ? event.brief : '',
    content: typeof args?.content === 'string' ? args.content : event.description,
    oldContent: typeof args?.find === 'string' ? args.find : undefined,
    action: String(args?.action ?? ''),
  };
}

function extractFilePath(event: ToolUsedEvent): string | null {
  const detail = asRecord(event.detail);
  const args = asRecord(event.argumentsDetail);
  const d = asRecord(detail?.textEditor) ?? args ?? {};
  if (typeof d.path === 'string' && d.path) return d.path;
  if (typeof d.file === 'string' && d.file) return d.file;
  const text = [event.brief ?? '', event.description ?? '', JSON.stringify(event.detail ?? {})].join(' ');
  const match = text.match(/(?:path[:\s=]+|saved to |workspace\/|\.\/|\/)[^\s,;]+/i);
  return match ? match[0].replace(/^(path[:\s=]+|saved to )/i, '') : null;
}

function extractUrl(event: ToolUsedEvent): string | undefined {
  const detail = asRecord(event.detail);
  const args = asRecord(event.argumentsDetail);
  const d = args ?? detail ?? {};
  if (typeof d.url === 'string' && d.url) return d.url;
  if (typeof d.uri === 'string' && d.uri) return d.uri;
  const text = [event.brief ?? '', event.description ?? ''].join(' ');
  const match = text.match(/https?:\/\/[^\s<>"'{}|\\^`\[\]]+/);
  return match ? match[0] : undefined;
}

function extractScreenshotPath(text: string): string | null {
  const match = text.match(/(?:\.screenshots\/|screenshots\/)[^\s,;"'<>]+/i);
  return match ? match[0] : null;
}
