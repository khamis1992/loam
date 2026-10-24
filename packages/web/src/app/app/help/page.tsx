'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, AlertCircle, BookOpen, FileText } from 'lucide-react';
import { t, getLocale, isRtl } from '@/i18n/t';
import { getApiBase, getLoamBase, getLoamAuthHeaders } from '@/services/rpc';
import { Markdown } from '@/components/chat/Markdown';

/** One guide page, as `GET /api/docs` describes it. */
interface DocEntry {
  subject: string;
  file: string;
  title: string;
  arabicFile: string | null;
  arabicTitle: string | null;
  sections: string[];
  /** Anchor for each section, at the same index, computed by the docs build. */
  anchors: string[];
}

/** The guide lives on the local Loam server, which is the same origin the desktop
 *  shell talks to. `getApiBase()` alone would miss the port, so prefer the Loam
 *  base and keep the relative API base as the fallback. */
function docsBase(): string {
  const api = getApiBase();
  return api.startsWith('http') ? api : getLoamBase();
}

/** The file to open for the current language, or the English page when the
 *  Arabic twin does not exist. Both editions carry the same sections, so a page
 *  that has no translation reads in English rather than showing an error. */
function pickFile(entry: DocEntry): { file: string; title: string; translated: boolean } {
  if (isRtl(getLocale()) && entry.arabicFile) {
    return { file: entry.arabicFile, title: entry.arabicTitle ?? entry.title, translated: true };
  }
  return { file: entry.file, title: entry.title, translated: !isRtl(getLocale()) };
}

export default function HelpPage() {
  const router = useRouter();
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [entry, setEntry] = useState<DocEntry | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${docsBase()}/api/docs`, { headers: getLoamAuthHeaders() });
        if (!res.ok) {
          let message = `status ${res.status}`;
          try {
            const data = (await res.json()) as { error?: string };
            if (data.error) message = data.error;
          } catch {
            /* the body was not JSON; keep the status */
          }
          throw new Error(message);
        }
        const data = (await res.json()) as { docs?: DocEntry[]; missing?: string[] };
        if (!mounted) return;
        setDocs(data.docs ?? []);
        const missing = data.missing ?? [];
        if (missing.length > 0) {
          // The guide ships with the app, so a missing page is a build problem.
          // Say so rather than showing an empty list.
          setError(t('Some guide pages are missing from this install: {pages}', { pages: missing.join(', ') }));
        }
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const openDoc = useCallback(async (target: DocEntry) => {
    setEntry(target);
    setError(null);
    setContent(null);
    const chosen = pickFile(target);
    try {
      const res = await fetch(`${docsBase()}/api/docs/${encodeURIComponent(chosen.file)}`, {
        headers: getLoamAuthHeaders(),
      });
      if (!res.ok) {
        let message = `status ${res.status}`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) message = data.error;
        } catch {
          /* the body was not JSON; keep the status */
        }
        throw new Error(message);
      }
      setContent(await res.text());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Section outline of the open page, derived from the index rather than re-parsed.
  const outline = useMemo(() => entry?.sections ?? [], [entry]);
  const outlineAnchors = useMemo(() => entry?.anchors ?? [], [entry]);

  const chosen = entry ? pickFile(entry) : null;
  const dir = isRtl(getLocale()) ? 'rtl' : 'ltr';

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <button
          type="button"
          onClick={() => router.push('/app/more')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <ArrowLeft className="size-4" />
        </button>
        <BookOpen className="size-4 text-text-tertiary" />
        <h1 className="text-title-lg text-text-primary">{t('Help center')}</h1>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-y-auto border-e border-border-main p-3">
          {loading ? (
            <div className="flex items-center gap-2 text-text-secondary">
              <Loader2 className="size-4 animate-spin" /> {t('Loading')}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {docs.map((doc) => {
                const picked = pickFile(doc);
                return (
                  <button
                    key={doc.subject}
                    type="button"
                    onClick={() => openDoc(doc)}
                    className={`flex items-center gap-2 rounded-control px-2 py-1 text-start text-sm ${
                      entry?.subject === doc.subject
                        ? 'bg-fill-hover text-text-primary'
                        : 'text-text-secondary hover:bg-fill-hover'
                    }`}
                    aria-current={entry?.subject === doc.subject ? 'page' : undefined}
                  >
                    <FileText className="size-3 shrink-0 text-text-tertiary" aria-hidden />
                    <span className="flex-1 truncate">{picked.title}</span>
                  </button>
                );
              })}
              {!loading && docs.length === 0 && (
                <p className="text-xs text-text-tertiary">{t('No guide is available in this install.')}</p>
              )}
            </div>
          )}
        </aside>
        <main className="flex-1 overflow-y-auto p-4" dir={dir}>
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-card border border-border-main bg-bg-menu p-3 text-function-error">
              <AlertCircle className="size-4 shrink-0" />
              <p className="text-xs">{error}</p>
            </div>
          )}
          {chosen && !chosen.translated && isRtl(getLocale()) && (
            <div className="mb-3 rounded-card border border-border-main bg-bg-menu p-3 text-xs text-text-tertiary">
              {t('This page has no Arabic edition yet, so it is shown in English.')}
            </div>
          )}
          {entry && content !== null ? (
            <article className="rounded-card border border-border-main bg-bg-menu p-4">
              <div className="mb-4 flex flex-col gap-1">
                <h2 className="text-title-md text-text-primary">{chosen?.title}</h2>
                {outline.length > 1 && (
                  <ul className="flex flex-wrap gap-x-3 gap-y-1">
                    {outline.map((section, index) => (
                      <li key={section}>
                        <a
                          href={`#${outlineAnchors[index] ?? ''}`}
                          className="text-xs text-text-tertiary hover:text-text-primary"
                        >
                          {section}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Markdown>{content}</Markdown>
            </article>
          ) : (
            !loading &&
            docs.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-sm text-text-tertiary">{t('Choose a page on the left.')}</p>
              </div>
            )
          )}
        </main>
      </div>
    </div>
  );
}
