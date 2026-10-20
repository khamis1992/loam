'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Folder, AlertCircle } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getLoamAuthHeaders } from '@/services/rpc';

interface Project {
  uid: string;
  name: string;
  description?: string;
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
          headers: getLoamAuthHeaders(),
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
            {projects.map((p) => (
              <li key={p.uid} className="rounded-card border border-border-main bg-bg-menu p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Folder className="size-4 text-text-tertiary" />
                  <p className="truncate text-sm font-medium text-text-primary">{p.name}</p>
                </div>
                {p.description && <p className="line-clamp-2 text-xs text-text-tertiary">{p.description}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
