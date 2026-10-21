'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Folder, AlertCircle } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { isCorruptedPlaceholder } from '@/utils/placeholders';

/** HTTP /api/projects returns raw db rows; accept both shapes defensively. */
interface Project {
  uid?: string;
  id?: string;
  name: string;
  description?: string;
  instruction?: string;
}

function projectKey(p: Project): string {
  return p.uid ?? p.id ?? p.name;
}

function projectDescription(p: Project): string {
  return p.description ?? p.instruction ?? '';
}

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/projects`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { projects?: Project[] };
        if (mounted) setProjects(data.projects ?? []);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
        // eslint-disable-next-line no-console
        console.error('failed to load projects', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

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
        <h1 className="text-title-lg text-text-primary">{t('Projects')}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-function-error">
            <AlertCircle className="size-6" />
            <p className="text-sm">{t('Failed to load projects')}</p>
            <p className="max-w-[320px] text-center text-xs">{error}</p>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
            <p className="text-sm">{t('No projects yet.')}</p>
            <p className="max-w-[320px] text-center text-xs">{t('Create a project via the backend to see it here.')}</p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => {
              const shownName = isCorruptedPlaceholder(p.name ?? '') ? t('Untitled project') : p.name;
              const description = projectDescription(p);
              const shownDescription = isCorruptedPlaceholder(description) ? '' : description;
              return (
                <li key={projectKey(p)} className="rounded-card border border-border-main bg-bg-menu p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Folder className="size-4 text-text-tertiary" />
                    <p className="truncate text-sm font-medium text-text-primary">{shownName}</p>
                  </div>
                  {shownDescription && <p className="line-clamp-2 text-xs text-text-tertiary">{shownDescription}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
