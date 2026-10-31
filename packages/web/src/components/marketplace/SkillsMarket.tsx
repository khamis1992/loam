'use client';

/**
 * Unified marketplace › Skills tab. Reads the exact catalog the legacy
 * `ui/skills.js` page reads — GET /api/skills/catalog — and installs through
 * the same POST /api/skills/install endpoint, so both surfaces stay one
 * engine. Installed state is resolved from GET /api/skills (the installed
 * names), which is what makes the install button honest instead of guessed.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, PackageCheck, Search } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { bi } from './labels';

/** A catalog hit: GET /api/skills/catalog → { total, shown, skills: [{ id, files, description? }] }. */
export interface CatalogSkill {
  id: string;
  files?: number;
  description?: string;
}

/** GET /api/skills → { skills: [{ name, description }] } — installed skills only. */
async function fetchInstalledNames(): Promise<Set<string>> {
  const res = await fetch(`${getApiBase()}/api/skills`, { headers: await getApiHeaders() });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = (await res.json()) as { skills?: { name?: string }[] };
  return new Set((data.skills ?? []).map((s) => (s.name ?? '').trim()).filter(Boolean));
}

export const skillShortName = (id: string) => id.split('/').pop() ?? id;

export function SkillsMarket() {
  const [query, setQuery] = useState('');
  const [skills, setSkills] = useState<CatalogSkill[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<string | null>(null);
  const [justInstalled, setJustInstalled] = useState<string | null>(null);

  // Installed state is best-effort: the grid stays usable when it fails.
  useEffect(() => {
    let cancelled = false;
    void fetchInstalledNames()
      .then((names) => { if (!cancelled) setInstalled(names); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q, limit: '60', describe: '10' });
      const res = await fetch(`${getApiBase()}/api/skills/catalog?${params.toString()}`, { headers: await getApiHeaders() });
      const data = (await res.json()) as { total?: number; skills?: CatalogSkill[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `status ${res.status}`);
      setSkills(data.skills ?? []);
      setTotal(typeof data.total === 'number' ? data.total : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced catalog search; an empty query loads on mount.
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(query.trim()); }, query ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [query, load]);

  const install = async (skill: CatalogSkill) => {
    const name = skillShortName(skill.id);
    if (pending || installed.has(name)) return;
    setPending(skill.id);
    setJustInstalled(null);
    try {
      const res = await fetch(`${getApiBase()}/api/skills/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await getApiHeaders()) },
        body: JSON.stringify({ id: skill.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `status ${res.status}`);
      setInstalled((prev) => new Set(prev).add(name));
      setJustInstalled(skill.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  return (
    <section aria-label={bi('Skills', 'المهارات')} className="mt-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px] text-text-tertiary">
          {t('Install ready-made skills from the catalog with one click.')}
        </p>
        {total !== null && (
          <span className="text-[12.5px] text-text-tertiary">{t('{count} in catalog', { count: total })}</span>
        )}
      </div>

      <label className="mt-3 flex w-full max-w-[360px] items-center gap-2 rounded-[10px] border border-border-main px-3 py-2">
        <Search className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('Search skills')}
          aria-label={t('Search skills')}
          className="w-full bg-transparent text-[13.5px] text-text-primary outline-none placeholder:text-text-tertiary"
        />
      </label>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-text-secondary" data-testid="skills-loading">
          <Loader2 className="size-5 animate-spin" /> {t('Loading')}
        </div>
      ) : error ? (
        <div className="mt-6 flex items-center gap-2 rounded-[14px] border border-border-main bg-bg-menu p-5 text-sm text-func-error" data-testid="skills-error">
          <AlertCircle className="size-4 shrink-0" /> {error}
        </div>
      ) : !skills || skills.length === 0 ? (
        <div className="mt-6 rounded-[20px] border border-dashed border-dark px-6 py-16 text-center">
          <h3 className="text-base text-text-primary">{t('No skills found')}</h3>
          <p className="mt-2 text-sm text-text-tertiary">{t('Try a broader word like pdf or web.')}</p>
        </div>
      ) : (
        <ul
          data-testid="skills-grid"
          className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-[14px]"
        >
          {skills.map((skill) => {
            const name = skillShortName(skill.id);
            const isInstalled = installed.has(name);
            const isPending = pending === skill.id;
            return (
              <li
                key={skill.id}
                className="flex flex-col gap-2 rounded-[14px] border border-border-main bg-bg-menu p-4"
                data-testid="skill-card"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium text-text-primary">{name}</p>
                    <p className="truncate text-[12px] text-text-tertiary">{skill.id}</p>
                  </div>
                  <span className="shrink-0 rounded-[7px] border border-border-main bg-fill-tsp px-2 py-0.5 text-[11.5px] text-text-tertiary">
                    {skill.files ?? 0} {t('files')}
                  </span>
                </div>
                <p className="line-clamp-3 min-h-[3em] text-[13px] text-text-secondary">
                  {skill.description || t('No description available.')}
                </p>
                <div className="mt-auto flex items-center gap-2 pt-1">
                  {isInstalled ? (
                    <span className="inline-flex items-center gap-1.5 rounded-[9px] bg-function-success-tsp px-3 py-1.5 text-[13px] font-medium text-function-success">
                      <PackageCheck className="size-3.5" /> {t('Installed')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => void install(skill)}
                      data-testid="skill-install"
                      className="inline-flex items-center gap-1.5 rounded-[9px] bg-text-primary px-3 py-1.5 text-[13px] font-medium text-text-onblack disabled:opacity-60"
                    >
                      {isPending && <Loader2 className="size-3.5 animate-spin" />}
                      {isPending ? t('Installing…') : t('Install')}
                    </button>
                  )}
                  {justInstalled === skill.id && (
                    <span className="text-[12px] text-function-success">{t('Skill installed.')}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
