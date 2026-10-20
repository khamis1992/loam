'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Folder,
  Globe,
  Maximize2,
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

type TabId = 'terminal' | 'editor' | 'browser' | 'preview' | 'files';

interface ComputerPanelProps {
  event: ToolUsedEvent;
  sessionId: string;
  onClose: () => void;
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
  { id: 'files', label: 'Files', icon: Folder },
];

export function ComputerPanel({ event, sessionId, onClose }: ComputerPanelProps) {
  const activeTab = useMemo(() => getToolFamily(event.tool), [event.tool]);
  const isDriving = !isFinalStatus(event.status) && activeTab === 'browser';

  return (
    <div
      className={[
        'flex h-full w-[520px] shrink-0 flex-col border-s bg-bg-menu',
        isDriving ? 'border-s-4 border-s-[var(--icon-blue)]' : 'border-border-main',
      ].join(' ')}
    >
      <div className="flex h-[40px] shrink-0 items-center justify-between border-b border-border-main px-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">{t("Loam's computer")}</span>
        </div>
        <div className="flex items-center gap-1">
          <button aria-label={t('Expand')} className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover">
            <Maximize2 className="size-4" />
          </button>
          <button aria-label={t('Close')} onClick={onClose} className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover">
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex h-[40px] shrink-0 items-center border-b border-border-main">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              className={[
                'flex h-full flex-1 items-center justify-center gap-1.5 border-b-2 px-2 text-xs font-medium',
                isActive
                  ? 'border-[var(--icon-blue)] text-text-primary'
                  : 'border-transparent text-text-tertiary hover:bg-fill-hover hover:text-text-secondary',
              ].join(' ')}
            >
              <Icon className="size-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-hidden">
        <TabContent event={event} sessionId={sessionId} tab={activeTab} />
      </div>
    </div>
  );
}

function TabContent({ event, sessionId, tab }: { event: ToolUsedEvent; sessionId: string; tab: TabId }) {
  switch (tab) {
    case 'terminal':
      return <TerminalContent event={event} />;
    case 'editor':
      return <EditorContent event={event} />;
    case 'browser':
      return <BrowserContent event={event} sessionId={sessionId} />;
    case 'preview':
      return <PreviewContent event={event} sessionId={sessionId} />;
    case 'files':
    default:
      return <FilesContent event={event} sessionId={sessionId} />;
  }
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
        <button className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover">
          <ArrowLeft className="size-3.5" />
        </button>
        <button className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover">
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

function getToolFamily(tool: string): TabId {
  const name = tool.toLowerCase();
  if (name === 'terminal' || name.startsWith('shell_') || name.startsWith('pty_')) return 'terminal';
  if (name === 'text_editor' || name.startsWith('file_')) return 'editor';
  if (name.startsWith('browser_') || name === 'browser' || name === 'web_fetch' || name === 'webpage_extract') return 'browser';
  if (name.startsWith('preview_') || name === 'webdev') return 'preview';
  return 'files';
}

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
    path: String(args?.path ?? event.brief ?? ''),
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
