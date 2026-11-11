'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, FileCode, Loader2, RefreshCw } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import type { WorkspaceEditorProps } from '../types';

/** Extensions rendered as a live page rather than source. */
const HTML_EXT = /\.(html?|svg)$/i;

function languageOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
    json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml',
    py: 'python', sh: 'bash', bash: 'bash', sql: 'sql',
  };
  return map[ext] ?? 'text';
}

/**
 * Web / code workspace editor.
 *
 * When the agent builds a page (`index.html`, `styles.css`, `app.js`, …) the
 * Workspace panel opens this editor: HTML renders as a live preview in a
 * sandboxed iframe and every other text format renders as source with line
 * numbers. The file is read through `/api/media`, the same endpoint the chat
 * uses for attachments, so the preview is always the file on disk.
 */
export function Editor({ file, live }: WorkspaceEditorProps) {
  const isHtml = HTML_EXT.test(file.path);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const preRef = useRef<HTMLPreElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ taskId: file.taskId, path: file.path });
      const res = await fetch(`${getApiBase()}/api/media?${params.toString()}`, { headers: await getApiHeaders() });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setContent(await res.text());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [file.taskId, file.path]);

  useEffect(() => { void load(); }, [load]);

  const lines = useMemo(() => content.split('\n'), [content]);
  const language = useMemo(() => languageOf(file.path), [file.path]);

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center gap-2 text-text-secondary">
        <Loader2 className="size-5 animate-spin" /> {t('Loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-text-tertiary">
        <FileCode className="size-8" />
        <p>{t('Could not open this file.')}</p>
        <p className="text-xs opacity-70">{error}</p>
        <button
          type="button"
          onClick={() => { setNonce((n) => n + 1); void load(); }}
          className="mt-1 rounded-control px-3 py-1.5 text-sm text-text-secondary hover:bg-fill-hover"
        >
          {t('Retry')}
        </button>
      </div>
    );
  }

  if (isHtml) {
    return (
      <div className="flex h-full w-full flex-col bg-white">
        <div className="flex h-row shrink-0 items-center justify-between gap-2 border-b border-border-main bg-bg-menu px-3">
          <div className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
            <FileCode className="size-4 shrink-0" />
            <span className="truncate">{file.name}</span>
            <span className="rounded-control bg-fill-hover px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-tertiary">
              {t('Preview')}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => { void load(); }}
              title={t('Reload preview')}
              className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
            >
              <RefreshCw className="size-4" />
            </button>
            <a
              href={`${getApiBase()}/api/media?${new URLSearchParams({ taskId: file.taskId, path: file.path }).toString()}`}
              target="_blank"
              rel="noreferrer"
              title={t('Open in a new tab')}
              className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
            >
              <ExternalLink className="size-4" />
            </a>
          </div>
        </div>
        <iframe
          key={nonce}
          title={file.name}
          srcDoc={content}
          sandbox="allow-scripts allow-same-origin"
          className="h-full w-full flex-1 border-0 bg-white"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg-menu">
      <div className="flex h-row shrink-0 items-center justify-between gap-2 border-b border-border-main px-3">
        <div className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
          <FileCode className="size-4 shrink-0" />
          <span className="truncate">{file.name}</span>
          <span className="rounded-control bg-fill-hover px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-tertiary">
            {language}
          </span>
        </div>
        <button
          type="button"
          onClick={() => { void load(); }}
          title={t('Reload file')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <RefreshCw className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <pre ref={preRef} className="flex min-w-full text-[12px] leading-[18px] text-text-primary">
          <span aria-hidden className="sticky left-0 select-none border-e border-border-main bg-bg-menu pe-3 ps-4 text-end text-text-tertiary">
            {lines.map((_, i) => (
              <span key={i} className="block">{i + 1}</span>
            ))}
          </span>
          <code className="flex-1 whitespace-pre px-4 py-3">{content}</code>
        </pre>
      </div>
      {live ? (
        <div className="shrink-0 border-t border-border-main px-3 py-1.5 text-[11px] text-text-tertiary">
          {t('This file is still being written. Reload to see the latest version.')}
        </div>
      ) : null}
    </div>
  );
}
