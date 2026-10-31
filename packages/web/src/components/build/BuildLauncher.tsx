'use client';

/**
 * W-U3 — the single "ابنِ" surface. One brief box plus a style chip row, and
 * every chip routes to a real engine endpoint — no fake buttons:
 *  - فريق تنفيذ كامل (swarm)      → POST /api/swarm/runs     { brief }
 *  - فريق ذاتي التنظيم (realswarm) → POST /api/realswarm/runs { goal }
 *  - مخطط ومهام (app builder)      → POST /api/app-projects    { title, description }
 *    via the existing appBuilderApi.createAppProject, then the project opens
 *    in the existing AppBuilderWorkspace panel right here.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Hammer, Loader2, Rocket } from 'lucide-react';
import { t } from '@/i18n/t';
import { createAppProject, type AppProjectDto } from '@/services/appBuilderApi';
import { launchSwarmRun, launchRealSwarmRun, type SwarmRunRef } from '@/services/buildLaunchApi';
import { AppBuilderWorkspace } from '@/components/appbuilder/AppBuilderWorkspace';
import { bi } from '@/components/marketplace/labels';

export type BuildStyle = 'swarm' | 'realswarm' | 'app-builder';

const MIN_BRIEF = 10;

function buildStyles(): Array<{ id: BuildStyle; label: string; hint: string }> {
  return [
    { id: 'swarm', label: bi('Full execution team', 'فريق تنفيذ كامل'), hint: bi('A planned pipeline that delivers the build stage by stage.', 'مسار مخطط يسلّم العمل مرحلة تلو أخرى.') },
    { id: 'realswarm', label: bi('Self-organizing team', 'فريق ذاتي التنظيم'), hint: bi('Equal workers claim tasks from a shared board and verify with evidence.', 'عمال متساوون يسحبون المهام من لوحة مشتركة ويتحققون بالأدلة.') },
    { id: 'app-builder', label: bi('Planner & tasks', 'مخطط ومهام'), hint: bi('An app project with a plan, queue, versions and race runs.', 'مشروع تطبيق بخطة وطابور وإصدارات ومقارنة فروع.') },
  ];
}

export function BuildLauncher() {
  const router = useRouter();
  const [style, setStyle] = useState<BuildStyle>('swarm');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [realswarmRun, setRealswarmRun] = useState<SwarmRunRef | null>(null);
  const [swarmRun, setSwarmRun] = useState<SwarmRunRef | null>(null);
  const [project, setProject] = useState<AppProjectDto | null>(null);

  const trimmed = brief.trim();
  const canLaunch = trimmed.length >= MIN_BRIEF && !busy;

  const launch = async () => {
    if (!canLaunch) return;
    setBusy(true);
    setError(null);
    setSwarmRun(null);
    setRealswarmRun(null);
    try {
      if (style === 'swarm') {
        const run = await launchSwarmRun(trimmed);
        setSwarmRun(run);
        // Team runs render in the Agent Studio list (TeamRunsList).
        router.push('/app/agents');
      } else if (style === 'realswarm') {
        const run = await launchRealSwarmRun(trimmed);
        setRealswarmRun(run);
      } else {
        const title = trimmed.split(/\r?\n/)[0]!.slice(0, 80);
        const { project: created } = await createAppProject(title, trimmed);
        setProject(created);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <section aria-label={t('Build an App')} className="mx-auto w-full max-w-[720px]">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-control bg-[#0081f2]/10">
            <Hammer className="size-5 text-[#0081f2]" />
          </span>
          <div>
            <h1 className="text-[28px] font-medium leading-tight text-text-primary">{t('Build an App')}</h1>
            <p className="text-[13.5px] text-text-tertiary">{t('Write one brief, pick a build style, launch.')}</p>
          </div>
        </div>

        <label className="mt-5 block">
          <span className="mb-1.5 block text-[13px] font-medium text-text-secondary">{t('Brief')}</span>
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder={t('Describe the app you want: pages, data, behavior…')}
            rows={5}
            data-testid="build-brief"
            className="w-full resize-y rounded-[14px] border border-border-main bg-bg-menu p-3.5 text-[14px] leading-relaxed text-text-primary outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
          />
          <span className="mt-1 block text-[12px] text-text-tertiary">
            {trimmed.length < MIN_BRIEF
              ? t('At least {count} characters.', { count: MIN_BRIEF })
              : `${trimmed.length}`}
          </span>
        </label>

        <fieldset className="mt-4">
          <legend className="mb-2 text-[13px] font-medium text-text-secondary">{t('Build style')}</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('Build style')}>
            {buildStyles().map((item) => {
              const active = style === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`build-style-${item.id}`}
                  onClick={() => { setStyle(item.id); setError(null); }}
                  className={`rounded-[12px] border px-3.5 py-2 text-start transition-colors ${
                    active
                      ? 'border-[#0081f2] bg-[#0081f2]/10 text-text-primary'
                      : 'border-border-main bg-bg-menu text-text-secondary hover:bg-fill-hover'
                  }`}
                >
                  <span className="block text-[13.5px] font-medium">{item.label}</span>
                  <span className="mt-0.5 block max-w-[240px] text-[11.5px] leading-snug text-text-tertiary">{item.hint}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void launch()}
            disabled={!canLaunch}
            data-testid="build-launch"
            className="inline-flex items-center gap-2 rounded-[12px] bg-[#0081f2] px-5 py-2.5 text-[14px] font-semibold text-white disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
            {t('Launch')}
          </button>
          <span className="text-[12.5px] text-text-tertiary">
            {style === 'swarm' && t('Creates a run on the swarm engine.')}
            {style === 'realswarm' && t('Creates a run on the self-organizing engine.')}
            {style === 'app-builder' && t('Creates an app project and opens its workspace.')}
          </span>
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-[12px] border border-border-main bg-bg-menu p-3 text-sm text-func-error" data-testid="build-error">
            <AlertCircle className="size-4 shrink-0" /> {error}
          </div>
        )}

        {realswarmRun && (
          <div className="mt-4 rounded-[14px] border border-function-success/40 bg-function-success-tsp p-4" data-testid="build-realswarm-result">
            <p className="text-[13.5px] font-medium text-function-success">{t('Run created on the self-organizing team.')}</p>
            <p className="mt-1 break-all font-mono text-[12px] text-text-secondary">{realswarmRun.id}</p>
          </div>
        )}

        {swarmRun && (
          <div className="mt-4 rounded-[14px] border border-function-success/40 bg-function-success-tsp p-4" data-testid="build-swarm-result">
            <p className="text-[13.5px] font-medium text-function-success">{t('Run created. Opening the team runs list…')}</p>
          </div>
        )}

        <p className="mt-6 text-[12px] leading-6 text-text-tertiary">
          {t('Team styles launch the real engines; their boards live with the agent teams. Craft work still has its own studio.')}
        </p>
      </section>

      {project && (
        <div className="fixed inset-y-0 end-0 z-40 w-[min(560px,92vw)] border-s border-border-main bg-bg-panel shadow-xl" data-testid="build-appbuilder-panel">
          <AppBuilderWorkspace projectId={project.id} onClose={() => setProject(null)} />
        </div>
      )}
    </div>
  );
}
