'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Folder, FolderGit, Pencil, Trash2, X, Plus, AlertCircle } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { isCorruptedPlaceholder } from '@/utils/placeholders';
import { desktopApis, isDesktop } from '@/services/desktopApis';
import { Dialog } from '@/components/ui/Dialog';

/** HTTP /api/projects returns raw db rows; accept both shapes defensively. */
interface Project {
  uid?: string;
  id: string;
  name: string;
  description?: string;
  instruction?: string;
  folder?: string;
  updatedAt?: string;
}

function projectKey(p: Project): string {
  return p.uid ?? p.id ?? p.name;
}

function projectDescription(p: Project): string {
  return p.description ?? p.instruction ?? '';
}

interface Draft {
  id?: string;
  name: string;
  instruction: string;
  folder: string;
}

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/projects`, { headers: await getApiHeaders() });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { projects?: Project[] };
      setProjects(data.projects ?? []);
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // eslint-disable-next-line no-console
      console.error('failed to load projects', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const browseFolder = async () => {
    if (!isDesktop() || !draft) return;
    try {
      const res = await desktopApis.system.showFolderDialog();
      if (res && typeof res === 'object' && 'path' in res && typeof (res as { path?: unknown }).path === 'string') {
        setDraft({ ...draft, folder: (res as { path: string }).path });
      }
    } catch {
      // ignore dialog failures
    }
  };

  const saveDraft = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft || !draft.name.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      const headers = { 'content-type': 'application/json', ...(await getApiHeaders()) };
      const body = { name: draft.name.trim(), instruction: draft.instruction };
      const res = await fetch(
        draft.id ? `${getApiBase()}/api/projects/${encodeURIComponent(draft.id)}` : `${getApiBase()}/api/projects`,
        { method: 'POST', headers, body: JSON.stringify(body) },
      );
      const data = (await res.json().catch(() => ({}))) as { project?: Project; error?: string };
      if (!res.ok || !data.project) throw new Error(data.error ?? `status ${res.status}`);
      const folder = draft.folder.trim();
      if (folder !== (data.project.folder ?? '')) {
        const fr = await fetch(`${getApiBase()}/api/projects/${encodeURIComponent(data.project.id)}/folder`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ path: folder }),
        });
        if (!fr.ok && fr.status !== 400) throw new Error(`folder ${fr.status}`);
      }
      setDraft(null);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const removeProject = async (id: string) => {
    setSaving(true);
    try {
      await fetch(`${getApiBase()}/api/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: await getApiHeaders(),
      });
      setConfirmDelete(null);
      await refresh();
    } finally {
      setSaving(false);
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
        <h1 className="text-title-lg text-text-primary">{t('Projects')}</h1>
        <button
          type="button"
          onClick={() => { setFormError(null); setDraft({ name: '', instruction: '', folder: '' }); }}
          className="ms-auto flex items-center gap-1 rounded-control bg-fill-hover px-3 py-1.5 text-sm font-medium text-text-primary"
        >
          <Plus className="size-4" /> {t('New project')}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-func-error">
            <AlertCircle className="size-6" />
            <p className="text-sm">{t('Failed to load projects')}</p>
            <p className="max-w-[320px] text-center text-xs">{error}</p>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
            <Folder className="size-8" />
            <p className="text-sm">{t('No projects yet.')}</p>
            <button
              type="button"
              onClick={() => { setFormError(null); setDraft({ name: '', instruction: '', folder: '' }); }}
              className="flex items-center gap-1 rounded-control bg-fill-hover px-3 py-1.5 text-sm font-medium text-text-primary"
            >
              <Plus className="size-4" /> {t('Create your first project')}
            </button>
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
                    <Folder className="size-4 shrink-0 text-text-tertiary" />
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{shownName}</p>
                    <button
                      type="button"
                      aria-label={t('Edit')}
                      onClick={() => { setFormError(null); setDraft({ id: p.id, name: p.name, instruction: p.instruction ?? '', folder: p.folder ?? '' }); }}
                      className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover hover:text-text-primary"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    {confirmDelete === p.id ? (
                      <button
                        type="button"
                        onClick={() => void removeProject(p.id)}
                        disabled={saving}
                        className="rounded-control px-1.5 py-1 text-[11px] font-medium text-func-error hover:bg-fill-hover"
                      >
                        {t('Confirm delete')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={t('Delete')}
                        onClick={() => setConfirmDelete(p.id)}
                        className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover hover:text-func-error"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                  {shownDescription && <p className="line-clamp-2 text-xs text-text-tertiary">{shownDescription}</p>}
                  {p.folder && (
                    <p className="mt-1.5 flex items-center gap-1 truncate text-[11px] text-text-tertiary" title={p.folder}>
                      <FolderGit className="size-3 shrink-0" /> {p.folder}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog open={draft !== null} onClose={() => setDraft(null)} title={draft?.id ? t('Edit project') : t('New project')}>
        {draft && (
          <form onSubmit={saveDraft} className="flex flex-col gap-3">
            <input
              type="text"
              autoFocus
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={t('Project name')}
              className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
            />
            <textarea
              value={draft.instruction}
              onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
              placeholder={t('Project instruction (optional)')}
              rows={4}
              className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
            />
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draft.folder}
                onChange={(e) => setDraft({ ...draft, folder: e.target.value })}
                placeholder={t('Project folder (optional)')}
                className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
              />
              <button
                type="button"
                onClick={() => void browseFolder()}
                disabled={!isDesktop()}
                className="flex items-center gap-1 rounded-control border border-border-main px-2.5 py-2 text-xs text-text-secondary hover:bg-fill-hover disabled:opacity-50"
              >
                <Folder className="size-3.5" /> {t('Browse')}
              </button>
            </div>
            {formError && <p className="text-xs text-func-error">{formError}</p>}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="flex items-center gap-1 rounded-control px-3 py-1.5 text-sm text-text-secondary hover:bg-fill-hover"
              >
                <X className="size-4" /> {t('Cancel')}
              </button>
              <button
                type="submit"
                disabled={saving || !draft.name.trim()}
                className="flex items-center gap-1 rounded-control bg-fill-hover px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50"
              >
                {saving && <Loader2 className="size-4 animate-spin" />} {t('Save')}
              </button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
