'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, AlertCircle, BookOpen } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Markdown } from '@/components/chat/Markdown';

interface WikiPageSummary {
  title: string;
  slug: string;
  parent?: string;
  purpose?: string;
}

interface WikiProjectSummary {
  project: string;
  generatedAt: string | null;
  pages: WikiPageSummary[];
}

export default function WikiPage() {
  const router = useRouter();
  const [wikis, setWikis] = useState<WikiProjectSummary[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [page, setPage] = useState<{ title: string; content: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const headers = await getApiHeaders();
        const res = await fetch(`${getApiBase()}/api/wiki`, { headers });
        const data = (await res.json()) as { wikis?: WikiProjectSummary[] };
        if (!mounted) return;
        const list = data.wikis ?? [];
        setWikis(list);
        if (list.length > 0) setProject(list[0]!.project);
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!project) return;
    let mounted = true;
    (async () => {
      try {
        const headers = await getApiHeaders();
        const res = await fetch(`${getApiBase()}/api/wiki/${encodeURIComponent(project)}`, { headers });
        const data = (await res.json()) as { pages?: WikiPageSummary[] };
        if (!mounted) return;
        setPages(data.pages ?? []);
        setPage(null);
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { mounted = false; };
  }, [project]);

  const openPage = async (slug: string) => {
    if (!project) return;
    setError(null);
    try {
      const headers = await getApiHeaders();
      const res = await fetch(`${getApiBase()}/api/wiki/${encodeURIComponent(project)}/${encodeURIComponent(slug)}`, { headers });
      const data = (await res.json()) as { page?: { title: string; content: string }; error?: string };
      if (!res.ok || !data.page) throw new Error(data.error ?? `status ${res.status}`);
      setPage(data.page);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <button
          type="button"
          onClick={() => router.push('/app')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <ArrowLeft className="size-4" />
        </button>
        <BookOpen className="size-4 text-text-tertiary" />
        <h1 className="text-title-lg text-text-primary">{t('Repo wiki')}</h1>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-y-auto border-e border-border-main p-3">
          {loading ? (
            <div className="flex items-center gap-2 text-text-secondary">
              <Loader2 className="size-4 animate-spin" /> {t('Loading')}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {wikis.map((w) => (
                <div key={w.project}>
                  <button
                    type="button"
                    onClick={() => setProject(w.project)}
                    className={`w-full rounded-control px-2 py-1 text-start text-sm ${project === w.project ? 'bg-fill-hover text-text-primary' : 'text-text-secondary hover:bg-fill-hover'}`}
                  >
                    {w.project}
                  </button>
                  {project === w.project && (
                    <ul className="mt-1 flex flex-col gap-0.5 ps-3">
                      {w.pages.map((p) => (
                        <li key={p.slug}>
                          <button
                            type="button"
                            onClick={() => openPage(p.slug)}
                            className="w-full truncate rounded-control px-2 py-1 text-start text-xs text-text-tertiary hover:bg-fill-hover hover:text-text-primary"
                          >
                            {p.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              {!loading && wikis.length === 0 && (
                <p className="text-xs text-text-tertiary">{t('No wiki has been generated yet.')}</p>
              )}
            </div>
          )}
        </aside>
        <main className="flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-card border border-border-main bg-bg-menu p-3 text-function-error">
              <AlertCircle className="size-4 shrink-0" />
              <p className="text-xs">{error}</p>
            </div>
          )}
          {page ? (
            <article className="rounded-card border border-border-main bg-bg-menu p-4">
              <Markdown>{page.content}</Markdown>
            </article>
          ) : (
            <div className="flex flex-col gap-1">
              {pages.length === 0 ? (
                <p className="text-sm text-text-tertiary">{t('Select a project to see its pages.')}</p>
              ) : (
                pages.map((p) => (
                  <button
                    key={p.slug}
                    type="button"
                    onClick={() => openPage(p.slug)}
                    className="rounded-control border border-border-main px-3 py-2 text-start text-sm text-text-primary hover:bg-fill-hover"
                  >
                    {p.title}
                    {p.purpose ? <span className="ms-2 text-xs text-text-tertiary">{p.purpose}</span> : null}
                  </button>
                ))
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
